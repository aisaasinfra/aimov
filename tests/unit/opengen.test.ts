import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from '#/server/app'
import { jobToken } from '#/server/media'
import { createOpenGenProvider, normalizeOpenGenBaseUrl, openGenStubEnabled } from '#/server/video/opengen'
import { VideoProviderError } from '#/server/video/types'

// OpenGen 推送契约。fetch 全部是假的。OPENGEN_STUB 标成联调，不是真实厂商验收。
const env = (vars: Record<string, string> = {}) =>
  ({
    APP_ENV: 'production',
    SITE_URL: 'https://moonhop.ai',
    SESSION_SECRET: 'a'.repeat(64),
    OPENGEN_BASE_URL: 'https://og.example/base/',
    OPENGEN_API_KEY: 'og_secret_key_123',
    OPENGEN_STUB: '0',
    ...vars,
  }) as unknown as Env

const input = (webhookUrl = 'https://moonhop.ai/api/webhooks/opengen?gen=gen_1&token=t') => ({
  generationId: 'gen_1',
  durationSeconds: 6,
  imageUrl: 'https://moonhop.ai/media/uploads/upl_1?exp=1&sig=s',
  sourceVideoUrl: 'https://moonhop.ai/media/templates/neon-6s.mp4',
  sourceVideoKey: 'templates/neon-6s.mp4',
  webhookUrl,
  meta: {} as Record<string, unknown>,
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function stubFetch(reply: () => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return reply()
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('OpenGen 地址', () => {
  it('生产只要不含密钥的 https；开发可以 http；查询串和账号被拒绝', () => {
    expect(normalizeOpenGenBaseUrl('https://og.example/base/', { APP_ENV: 'production' })).toBe('https://og.example/base')
    expect(normalizeOpenGenBaseUrl('https://tunnel.example', { APP_ENV: 'staging' })).toBe('https://tunnel.example')
    expect(normalizeOpenGenBaseUrl('http://127.0.0.1:8787', { APP_ENV: 'development' })).toBe('http://127.0.0.1:8787')
    expect(normalizeOpenGenBaseUrl('http://127.0.0.1:8787', { APP_ENV: 'preview' })).toBe('http://127.0.0.1:8787')
    expect(normalizeOpenGenBaseUrl('http://127.0.0.1:8787', { APP_ENV: 'production' })).toBeNull()
    expect(normalizeOpenGenBaseUrl('https://user:pass@og.example', { APP_ENV: 'production' })).toBeNull()
    expect(normalizeOpenGenBaseUrl('https://og.example?token=secret', { APP_ENV: 'production' })).toBeNull()
    expect(normalizeOpenGenBaseUrl('', { APP_ENV: 'production' })).toBeNull()
  })

  it('联调 stub 只在非 production 且 OPENGEN_STUB=1 时打开', () => {
    expect(openGenStubEnabled({ APP_ENV: 'development', OPENGEN_STUB: '1' })).toBe(true)
    expect(openGenStubEnabled({ APP_ENV: 'preview', OPENGEN_STUB: '1' })).toBe(true)
    expect(openGenStubEnabled({ APP_ENV: 'production', OPENGEN_STUB: '1' })).toBe(false)
    expect(openGenStubEnabled({ APP_ENV: 'staging', OPENGEN_STUB: '1' })).toBe(false)
    expect(openGenStubEnabled({ APP_ENV: 'development', OPENGEN_STUB: '0' })).toBe(false)
  })
})

describe('OpenGen 联调 stub', () => {
  it('不发请求；同一 generation id 得到稳定任务号；成功前是 pending，文案标联调', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'))
    const provider = createOpenGenProvider(env({ APP_ENV: 'development', OPENGEN_STUB: '1', OPENGEN_BASE_URL: '', OPENGEN_API_KEY: '' }))
    const first = await provider.submit(input())
    const again = await provider.submit(input())
    expect(first.requestId).toBe('opengen_stub_gen_1')
    expect(again.requestId).toBe(first.requestId)
    expect(first.meta).toMatchObject({ stub: true, integration: '联调', generationId: 'gen_1', sourceKey: 'templates/neon-6s.mp4' })
    expect(await provider.status(first.requestId, first.meta)).toEqual({ state: 'pending' })
    vi.advanceTimersByTime(400)
    expect(await provider.status(first.requestId, first.meta)).toEqual({
      state: 'completed',
      output: { r2Key: 'templates/neon-6s.mp4' },
      costCents: 0,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('stubOutcome=fail 时失败文案含联调', async () => {
    const provider = createOpenGenProvider(env({ APP_ENV: 'preview', OPENGEN_STUB: '1' }))
    const submitted = await provider.submit({ ...input(), meta: { stubOutcome: 'fail' } })
    expect(await provider.status(submitted.requestId, submitted.meta)).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('联调'),
    })
  })

  it('production 忽略 stub，缺配置时不发请求', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createOpenGenProvider(env({ APP_ENV: 'production', OPENGEN_STUB: '1', OPENGEN_BASE_URL: '', OPENGEN_API_KEY: '' }))
    const error = await provider.submit(input()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(VideoProviderError)
    expect(error).toMatchObject({ code: 'provider_not_configured', retryable: false, message: expect.stringContaining('未配置') })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('OpenGen 推送', () => {
  it('提交带幂等键和 Bearer；只有 https 回调才带 webhook；路径接在 base 前缀后', async () => {
    const calls = stubFetch(() => json(201, { id: 'job_1', status: 'queued' }))
    const provider = createOpenGenProvider(env())
    expect(await provider.submit(input())).toEqual({ requestId: 'job_1', meta: { generationId: 'gen_1' } })
    expect(calls[0]!.url).toBe('https://og.example/base/v1/aimov/jobs')
    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(headers).toMatchObject({ Authorization: 'Bearer og_secret_key_123', 'Idempotency-Key': 'gen_1' })
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      generation_id: 'gen_1',
      duration_seconds: 6,
      image_url: input().imageUrl,
      source_video_url: input().sourceVideoUrl,
      webhook_url: input().webhookUrl,
    })

    await provider.submit(input('http://localhost:3000/api/webhooks/opengen?gen=gen_1&token=t'))
    expect(JSON.parse(String(calls[1]!.init!.body)).webhook_url).toBeUndefined()
  })

  it('409 且带 id 时复用已有任务，不另建', async () => {
    stubFetch(() => json(409, { id: 'job_existing', generation_id: 'gen_1' }))
    const result = await createOpenGenProvider(env()).submit(input())
    expect(result).toEqual({ requestId: 'job_existing', meta: { generationId: 'gen_1', reused: true } })
  })

  it('409 没有 id：失败且不重试', async () => {
    stubFetch(() => json(409, { error: { message: 'conflict' } }))
    const error = await createOpenGenProvider(env()).submit(input()).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ retryable: false, message: expect.stringContaining('HTTP 409') })
  })

  it('状态映射：进行中、成功带成本、失败可重试则抛错', async () => {
    const provider = createOpenGenProvider(env())
    stubFetch(() => json(200, { id: 'job_1', status: 'processing' }))
    expect(await provider.status('job_1', {})).toEqual({ state: 'pending' })

    stubFetch(() => json(200, { id: 'job_1', status: 'succeeded', output_url: 'https://cdn.example/out.mp4', cost_cents: 42.2 }))
    expect(await provider.status('job_1', {})).toEqual({
      state: 'completed',
      output: { url: 'https://cdn.example/out.mp4' },
      costCents: 42,
    })

    stubFetch(() => json(200, { id: 'job_1', status: 'failed', error: { code: 'og_busy', message: 'later', retryable: true } }))
    const retryable = await provider.status('job_1', {}).catch((caught: unknown) => caught)
    expect(retryable).toMatchObject({ code: 'og_busy', retryable: true })

    stubFetch(() => json(200, { id: 'job_1', status: 'failed', error: { code: 'og_bad', message: 'no', retryable: false } }))
    expect(await provider.status('job_1', {})).toMatchObject({ state: 'failed', code: 'og_bad', message: 'no' })
  })

  it('401 不可重试；503 可重试；错误文本抹掉密钥', async () => {
    const provider = createOpenGenProvider(env())
    stubFetch(() => json(401, { error: { message: 'bad key og_secret_key_123' } }))
    const denied = await provider.status('job_1', {}).catch((caught: unknown) => caught)
    expect(denied).toMatchObject({ code: 'opengen_unauthorized', retryable: false })
    expect((denied as VideoProviderError).message).not.toContain('og_secret_key_123')
    expect((denied as VideoProviderError).message).toContain('***')

    stubFetch(() => json(503, { error: { message: 'down' } }))
    expect(await provider.submit(input()).catch((caught: unknown) => caught)).toMatchObject({ retryable: true })
  })

  it('网络错误可重试，且不带出密钥', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect og_secret_key_123 refused')
    })
    const error = await createOpenGenProvider(env()).submit(input()).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'opengen_unreachable', retryable: true })
    expect((error as VideoProviderError).message).not.toContain('og_secret_key_123')
  })

  it('上游 error.code 或 status 回显连接密钥时，失败码和说明都不带出', async () => {
    const provider = createOpenGenProvider(env())
    const secret = 'og_secret_key_123'
    stubFetch(() => json(200, { id: 'job_1', status: 'failed', error: { code: secret, message: 'rejected' } }))
    const failed = await provider.status('job_1', {})
    expect(failed).toMatchObject({ state: 'failed', code: 'opengen_failed', message: 'rejected' })
    expect(JSON.stringify(failed)).not.toContain(secret)

    stubFetch(() => json(200, { id: 'job_1', status: secret }))
    const weird = await provider.status('job_1', {})
    expect(weird).toMatchObject({ state: 'failed', code: 'opengen_failed' })
    expect(JSON.stringify(weird)).not.toContain(secret)
    expect(JSON.stringify(weird)).toContain('***')

    stubFetch(() => json(502, { error: { code: secret, message: `down ${secret}` } }))
    const http = (await provider.submit(input()).catch((caught: unknown) => caught)) as VideoProviderError
    expect(http).toMatchObject({ code: 'opengen_submit_502', retryable: true })
    expect(http.message).not.toContain(secret)
    expect(http.code).not.toContain(secret)
  })

  it('说明超过 300 字时仍先抹掉末尾的连接密钥', async () => {
    const secret = 'og_secret_key_123'
    stubFetch(() => json(200, { id: 'job_1', status: 'failed', error: { code: 'og_bad', message: `${'x'.repeat(290)}${secret}` } }))
    const failed = await createOpenGenProvider(env()).status('job_1', {})
    expect(failed).toMatchObject({ state: 'failed', code: 'og_bad' })
    expect(JSON.stringify(failed)).not.toContain(secret)
    expect(JSON.stringify(failed)).not.toContain('og_secret')
    expect(JSON.stringify(failed)).toContain('***')
  })

  it('成本估算为 0：回传的 cost_cents 才是实际成本，不向用户再记一笔', () => {
    expect(createOpenGenProvider(env()).costCents(18)).toBe(0)
  })
})

describe('OpenGen webhook', () => {
  it('错误 token 返回 401，不排轮询', async () => {
    const sent: unknown[] = []
    const res = await app.request(
      '/api/webhooks/opengen?gen=gen_1&token=bad',
      { method: 'POST' },
      { ...env(), VIDEO_QUEUE: { send: async (message: unknown) => void sent.push(message) } } as unknown as Env,
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid_webhook' })
    expect(sent).toEqual([])
  })

  it('正确 token 只排一次 poll，不改渠道', async () => {
    const base = env()
    const token = await jobToken(base, 'gen_1')
    const sent: unknown[] = []
    const res = await app.request(
      `/api/webhooks/opengen?gen=gen_1&token=${encodeURIComponent(token)}`,
      { method: 'POST' },
      { ...base, VIDEO_QUEUE: { send: async (message: unknown) => void sent.push(message) } } as unknown as Env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
    expect(sent).toEqual([{ kind: 'poll', generationId: 'gen_1' }])
  })
})
