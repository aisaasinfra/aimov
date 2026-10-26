// OpenGen 推送适配：aimov 主动 submit / status，和 fal、yir 一样。
// webhook 只是“该去查一下”的信号，真实状态由 jobs.ts 用这一行的 provider 拉取。
// 厂商 Key 留在 OpenGen 主机。这里只读连接信息：OPENGEN_BASE_URL + OPENGEN_API_KEY。
// 同一 aimov generation ID 的契约：请求带 Idempotency-Key（等于 generation id）。
// OpenGen 应复用已有任务并返回 200，或 409 且 body.id 为已有任务；aimov 把 409+id 当作复用，不另扣用户积分。
// OPENGEN_STUB=1 且非 production（development / preview）时走进程内联调 stub，不访问网络。文档与测试把它标成「联调」，不是真实厂商验收。
import { site } from '#/config/site'
import { cleanSecret, isProduction } from '../util'
import type { VideoProvider, VideoStatus, VideoSubmitInput, VideoSubmitResult } from './types'
import { VideoProviderError } from './types'

const JOBS_PATH = '/v1/aimov/jobs'
export const OPENGEN_HEALTH_PATH = '/v1/aimov/health'

export function openGenStubEnabled(env: { APP_ENV?: string; OPENGEN_STUB?: string }) {
  return !isProduction(env) && (env.OPENGEN_STUB ?? '').trim() === '1'
}

// 生产只接受 https（公网或隧道）。development / preview 另接受 http，方便本地 OpenGen。
// 地址里不能带账号或查询串密钥；鉴权只用 OPENGEN_API_KEY。
export function normalizeOpenGenBaseUrl(raw: string | undefined, env: { APP_ENV?: string }): string | null {
  const value = raw?.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.username || url.password || url.search) return null
  const https = url.protocol === 'https:'
  const httpDev = url.protocol === 'http:' && !isProduction(env)
  if ((!https && !httpDev) || !url.hostname) return null
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export type OpenGenConfig =
  | { mode: 'stub' }
  | { mode: 'missing'; message: string }
  | { mode: 'ready'; baseUrl: string; apiKey: string }

const MISSING = 'OpenGen 未配置：需要 OPENGEN_BASE_URL（Worker 可达的公网 HTTPS 或隧道）和 OPENGEN_API_KEY'

export function describeOpenGenConfig(env: Env): OpenGenConfig {
  if (openGenStubEnabled(env)) return { mode: 'stub' }
  const baseUrl = normalizeOpenGenBaseUrl(env.OPENGEN_BASE_URL, env)
  const apiKey = cleanSecret(env.OPENGEN_API_KEY)
  if (!baseUrl || !apiKey) return { mode: 'missing', message: MISSING }
  return { mode: 'ready', baseUrl, apiKey }
}

export function openGenUrl(baseUrl: string, path: string) {
  const url = new URL(baseUrl)
  const prefix = url.pathname.replace(/\/$/, '')
  url.pathname = `${prefix}${path.startsWith('/') ? path : `/${path}`}`
  return url.toString()
}

interface OpenGenJob {
  id?: string
  generation_id?: string
  status?: string
  output_url?: string
  cost_cents?: number
  error?: { code?: string; message?: string; retryable?: boolean } | null
}

export function createOpenGenProvider(env: Env): VideoProvider {
  return {
    id: 'opengen',
    async submit(input) {
      if (openGenStubEnabled(env)) return stubSubmit(input)
      const config = requireReady(env)
      const response = await request(config, JOBS_PATH, {
        method: 'POST',
        headers: { 'Idempotency-Key': input.generationId },
        body: JSON.stringify({
          generation_id: input.generationId,
          duration_seconds: input.durationSeconds,
          image_url: input.imageUrl,
          source_video_url: input.sourceVideoUrl,
          // 非 https 回调（本地）不交给 OpenGen，改靠轮询
          webhook_url: input.webhookUrl.startsWith('https://') ? input.webhookUrl : undefined,
        }),
      })
      const body = await readJob(response, config.apiKey)
      // 409 + id：同一 generation ID 已有任务，复用，不新建厂商任务
      if (response.status === 409 && body?.id) return done(body.id, input.generationId, true)
      if ((response.status === 200 || response.status === 201) && body?.id) return done(body.id, input.generationId, false)
      throw httpError('submit', response, body, config.apiKey)
    },

    async status(requestId, meta): Promise<VideoStatus> {
      if (meta.stub === true || (openGenStubEnabled(env) && String(requestId).startsWith('opengen_stub_'))) return stubStatus(meta)
      const config = requireReady(env)
      const response = await request(config, `${JOBS_PATH}/${encodeURIComponent(requestId)}`)
      const body = await readJob(response, config.apiKey)
      if (!response.ok || !body) throw httpError('status', response, body, config.apiKey)
      return mapStatus(body, config.apiKey)
    },

    costCents(durationSeconds) {
      return Math.round(durationSeconds * site.video.opengen.costCentsPerSecond)
    },
  }
}

function done(requestId: string, generationId: string, reused: boolean): VideoSubmitResult {
  return { requestId, meta: { generationId, ...(reused ? { reused: true } : {}) } }
}

function requireReady(env: Env) {
  const config = describeOpenGenConfig(env)
  if (config.mode !== 'ready') {
    throw new VideoProviderError('provider_not_configured', config.mode === 'missing' ? config.message : MISSING, false)
  }
  return config
}

async function request(config: { baseUrl: string; apiKey: string }, path: string, init: RequestInit = {}) {
  try {
    return await fetch(openGenUrl(config.baseUrl, path), {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network'
    throw new VideoProviderError('opengen_unreachable', scrub(`OpenGen 不可达：${reason}`, config.apiKey), true)
  }
}

async function readJob(response: Response, apiKey: string): Promise<OpenGenJob | null> {
  const body = (await response.json().catch(() => null)) as OpenGenJob | null
  if (body?.error?.message) body.error.message = scrub(body.error.message, apiKey)
  return body
}

function mapStatus(body: OpenGenJob, apiKey: string): VideoStatus {
  const status = (body.status ?? '').toLowerCase()
  if (status === 'queued' || status === 'processing' || status === 'running' || status === 'pending' || status === '') {
    return { state: 'pending' }
  }
  if (status === 'succeeded' || status === 'completed' || status === 'success') {
    if (!body.output_url) return { state: 'failed', code: 'opengen_no_video', message: 'OpenGen 结果没有 output_url' }
    const cost = body.cost_cents
    return {
      state: 'completed',
      output: { url: body.output_url },
      ...(typeof cost === 'number' && Number.isFinite(cost) ? { costCents: Math.round(cost) } : {}),
    }
  }
  const code = safeCode(body.error?.code, 'opengen_failed', apiKey)
  const message = scrub(body.error?.message || `OpenGen 任务失败（${body.status ?? 'unknown'}）`, apiKey)
  if (body.error?.retryable) throw new VideoProviderError(code, message, true)
  return { state: 'failed', code, message }
}

function httpError(stage: string, response: Response, body: OpenGenJob | null, apiKey: string) {
  const fallback = `opengen_${stage}_${response.status}`
  const code = response.status === 401 || response.status === 403 ? 'opengen_unauthorized' : safeCode(body?.error?.code, fallback, apiKey)
  const detail = body?.error?.message ?? ''
  const retryable = body?.error?.retryable ?? (response.status === 408 || response.status === 429 || response.status >= 500)
  return new VideoProviderError(code, scrub(`OpenGen ${stage} 失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`, apiKey), retryable && code !== 'opengen_unauthorized')
}

// 上游 code 原样进工单 error_code，再经 publicGeneration 回到用户。只保留短 token，并且不能含连接密钥。
const SAFE_UPSTREAM_CODE = /^[A-Za-z0-9_.:-]{1,80}$/

function safeCode(raw: string | undefined, fallback: string, secret: string | undefined) {
  const code = raw?.trim() ?? ''
  if (!SAFE_UPSTREAM_CODE.test(code)) return fallback
  if (secret && secret.length > 0 && (code.includes(secret) || code.includes(encodeURIComponent(secret)))) return fallback
  return code
}

function scrub(message: string, secret: string | undefined) {
  let out = message
  if (secret && secret.length >= 8) {
    out = out.split(secret).join('***')
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret) out = out.split(encoded).join('***')
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 300)
}

// 联调 stub：同一 generation ID 永远得到同一个 requestId（复用，不产生第二笔任务）。成功时把模板源视频当作成片，和 mock 一样由 jobs 复制进 R2。
function stubSubmit(input: VideoSubmitInput): VideoSubmitResult {
  return {
    requestId: `opengen_stub_${input.generationId}`,
    meta: {
      stub: true,
      integration: '联调',
      generationId: input.generationId,
      sourceKey: input.sourceVideoKey,
      readyAt: Date.now() + 300,
      ...(input.meta.stubOutcome === 'fail' ? { stubOutcome: 'fail' } : {}),
    },
  }
}

function stubStatus(meta: Record<string, unknown>): VideoStatus {
  if (meta.stubOutcome === 'fail') return { state: 'failed', code: 'opengen_stub_failure', message: '联调 stub 模拟失败' }
  if (Date.now() < Number(meta.readyAt ?? 0)) return { state: 'pending' }
  const sourceKey = String(meta.sourceKey ?? '')
  if (!sourceKey) return { state: 'failed', code: 'opengen_stub_missing', message: '联调 stub 缺少源视频' }
  return { state: 'completed', output: { r2Key: sourceKey }, costCents: 0 }
}
