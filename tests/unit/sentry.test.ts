import { describe, expect, it, vi } from 'vitest'
import { checkConfig } from '#/server/config-health'
import { buildSentryEnvelope, parseSentryDsn, reportWorkerError } from '#/server/sentry'
import { ApiError } from '#/server/util'

const env = (SENTRY_DSN?: string) => ({ SENTRY_DSN }) as Env

describe('parseSentryDsn', () => {
  it('空的、不是 https 的、内网或 IP 主机都关掉上报', () => {
    expect(parseSentryDsn(undefined)).toBeNull()
    expect(parseSentryDsn('  ')).toBeNull()
    expect(parseSentryDsn('http://abc@o1.ingest.sentry.io/1')).toBeNull()
    expect(parseSentryDsn('https://abc@127.0.0.1/1')).toBeNull()
    expect(parseSentryDsn('https://abc@localhost/1')).toBeNull()
    expect(parseSentryDsn('https://abc@logs.internal/1')).toBeNull()
    expect(parseSentryDsn('not a dsn')).toBeNull()
  })

  it('公网 https DSN 解析成 envelope 地址', () => {
    expect(parseSentryDsn('https://abc@o1.ingest.sentry.io/42')).toEqual({
      dsn: 'https://abc@o1.ingest.sentry.io/42',
      publicKey: 'abc',
      envelopeUrl: 'https://o1.ingest.sentry.io/api/42/envelope/',
    })
    expect(parseSentryDsn('https://abc@glitchtip.example.com/7')?.envelopeUrl).toBe('https://glitchtip.example.com/api/7/envelope/')
  })
})

describe('reportWorkerError', () => {
  it('DSN 为空时不发请求', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await reportWorkerError(env(''), new Error('boom'), { kind: 'worker' }, fetcher)
    await reportWorkerError(env('https://abc@127.0.0.1/1'), new Error('boom'), {}, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('去掉邮箱和 query，ApiError 只上报错误码，失败也不抛', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('no', { status: 500 }))
    await reportWorkerError(env('https://abc@o1.ingest.sentry.io/42'), new Error('hi a@b.co https://ex.test/p?email=1:12:3'), { path: '/api/x?q=1', method: 'POST', kind: 'api' }, fetcher)
    const init = fetcher.mock.calls[0]?.[1] as RequestInit
    const body = String(init.body)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://o1.ingest.sentry.io/api/42/envelope/')
    expect((init.headers as Record<string, string>)['X-Sentry-Auth']).toContain('sentry_key=abc')
    expect(body).toContain('[email]')
    expect(body).not.toContain('a@b.co')
    expect(body).not.toContain('email=1')
    expect(body).toContain('"/api/x"')
    expect(body).not.toContain('?q=1')
    expect(body).toContain('"kind":"api"')

    fetcher.mockClear()
    await reportWorkerError(env('https://abc@o1.ingest.sentry.io/42'), new ApiError(503, 'captcha_unavailable', 'secret TURNSTILE_SECRET_KEY'), {}, fetcher)
    expect(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)).toContain('captcha_unavailable')
    expect(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)).not.toContain('TURNSTILE')

    fetcher.mockRejectedValueOnce(new Error('network'))
    await expect(reportWorkerError(env('https://abc@o1.ingest.sentry.io/42'), new Error('x'), {}, fetcher)).resolves.toBeUndefined()
  })

  it('envelope 的 event_id 在头和正文里一致', () => {
    const body = buildSentryEnvelope({ dsn: 'https://abc@o1.ingest.sentry.io/42', eventId: 'ab'.repeat(16), sentAt: '2026-10-25T00:00:00.000Z', message: 'x', kind: 'worker', path: '/pricing' })
    const [header, , payload] = body.trim().split('\n')
    expect(JSON.parse(header!).event_id).toBe('ab'.repeat(16))
    expect(JSON.parse(payload!).event_id).toBe('ab'.repeat(16))
    expect(JSON.parse(payload!).request.url).toBe('/pricing')
  })
})

describe('SENTRY_DSN 配置检查', () => {
  const input = { vars: {}, bindings: [] as string[], packageIds: [] as string[], siteDomain: 'example.com' }

  it('空的或只有名字时不警告；字符串格式不对只警告', () => {
    expect(checkConfig({ ...input, secrets: {} }).some((issue) => issue.key === 'SENTRY_DSN')).toBe(false)
    expect(checkConfig({ ...input, secrets: { SENTRY_DSN: true } }).some((issue) => issue.key === 'SENTRY_DSN')).toBe(false)
    const bad = checkConfig({ ...input, secrets: { SENTRY_DSN: 'http://nope' } }).find((issue) => issue.key === 'SENTRY_DSN')
    expect(bad?.level).toBe('warn')
    expect(checkConfig({ ...input, secrets: { SENTRY_DSN: 'https://abc@o1.ingest.sentry.io/42' } }).some((issue) => issue.key === 'SENTRY_DSN')).toBe(false)
  })
})
