// 可选的 Sentry 兼容错误上报。SENTRY_DSN 为空或格式不对时什么都不发（fail closed），请求照常记 Workers 日志。
// 不引入 @sentry/cloudflare：只 POST 一条 envelope，失败只打日志，不影响响应。不上传 query、cookie、邮箱和 IP。
import { SENTRY_DSN_PATTERN } from './config-health'
import { stripUrl } from './csp'
import { ApiError } from './util'

export type SentryTarget = { envelopeUrl: string; publicKey: string; dsn: string }

const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i

export function parseSentryDsn(raw: string | undefined | null): SentryTarget | null {
  const dsn = raw?.trim() ?? ''
  if (!dsn || !SENTRY_DSN_PATTERN.test(dsn)) return null
  const match = SENTRY_DSN_PATTERN.exec(dsn)
  if (!match) return null
  const [, publicKey, host, projectId] = match
  if (!publicKey || !host || !projectId || !allowedHost(host)) return null
  return { dsn, publicKey, envelopeUrl: `https://${host}/api/${projectId}/envelope/` }
}

function allowedHost(host: string) {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (!name.includes('.') || BLOCKED_HOST.test(name)) return false
  if (name.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return false
  return true
}

export function scrubSentryText(value: string) {
  return value
    .replace(/(https?:\/\/[^\s)"'<>]+?)((?::\d+){1,2})?(?=[\s)"'<>]|$)/g, (_, url: string, position = '') => stripUrl(url) + position)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .slice(0, 500)
}

export function sentryEventId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function buildSentryEnvelope(input: { dsn: string; eventId: string; sentAt: string; message: string; kind: string; method?: string; path?: string }) {
  const message = scrubSentryText(input.message) || 'error'
  const event = {
    event_id: input.eventId,
    timestamp: Date.parse(input.sentAt) / 1000,
    platform: 'javascript',
    level: 'error',
    logger: 'aimov',
    message: { formatted: message },
    tags: { kind: input.kind },
    request: { method: input.method ?? '', url: input.path ?? '' },
  }
  const payload = JSON.stringify(event)
  const header = JSON.stringify({ event_id: input.eventId, sent_at: input.sentAt, dsn: input.dsn })
  const item = JSON.stringify({ type: 'event', content_type: 'application/json', length: new TextEncoder().encode(payload).length })
  return `${header}\n${item}\n${payload}\n`
}

type ReportContext = { kind?: string; method?: string; path?: string }

// 调用方用 waitUntil 挂上即可。DSN 关闭、地址不合法、网络失败都不抛。
export async function reportWorkerError(env: Env, error: unknown, context: ReportContext = {}, fetcher: typeof fetch = fetch) {
  const target = parseSentryDsn(env.SENTRY_DSN)
  if (!target) return
  // ApiError 的 message 可能带配置细节，只上报错误码。其余错误先打码再截断。
  const message = error instanceof ApiError ? error.code : error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'
  const body = buildSentryEnvelope({
    dsn: target.dsn,
    eventId: sentryEventId(),
    sentAt: new Date().toISOString(),
    message,
    kind: context.kind ?? 'worker',
    method: context.method,
    path: context.path?.split(/[?#]/)[0],
  })
  try {
    const response = await fetcher(target.envelopeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=aimov/1.0, sentry_key=${target.publicKey}`,
      },
      body,
    })
    if (!response.ok) console.error('[sentry] envelope rejected', response.status)
  } catch (sendError) {
    console.error('[sentry] send failed', sendError instanceof Error ? sendError.name : 'error')
  }
}
