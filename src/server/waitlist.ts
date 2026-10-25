// 公开等待列表。先校验邮箱再消耗 Turnstile（token 单次有效）。不创建用户，也不发登录凭证。
import { Hono } from 'hono'
import { isLocale } from '#/config/site'
import { rateLimit, readJson } from './http'
import type { AppContext } from './types'
import { verifyTurnstile } from './turnstile'
import { ApiError, createId, nowIso } from './util'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SOURCES = ['waitlist', 'footer', 'pricing'] as const
export type WaitlistSource = (typeof SOURCES)[number]

export type WaitlistRow = { email: string; locale: string; source: string; created_at: string }

export function normalizeEmail(raw: unknown) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

export function isValidEmail(email: string) {
  return email.length <= 254 && EMAIL_RE.test(email)
}

export function clampWaitlistSource(source: unknown): WaitlistSource {
  return typeof source === 'string' && (SOURCES as readonly string[]).includes(source) ? (source as WaitlistSource) : 'waitlist'
}

export function clampWaitlistLocale(locale: unknown) {
  return typeof locale === 'string' && isLocale(locale) ? locale : 'en'
}

// 电子表格会执行以 = + - @ 开头的单元格。导出前加撇号，含引号或换行的再按 RFC 4180 转义。
export function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function waitlistCsv(rows: readonly WaitlistRow[]) {
  const lines = ['email,locale,source,created_at', ...rows.map((row) => [row.email, row.locale, row.source, row.created_at].map(csvCell).join(','))]
  return `\uFEFF${lines.join('\n')}\n`
}

export async function addToWaitlist(db: D1Database, row: { id: string; email: string; locale: string; source: string; createdAt: string }) {
  const result = await db
    .prepare('INSERT INTO waitlist (id, email, locale, source, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
    .bind(row.id, row.email, row.locale, row.source, row.createdAt)
    .run()
  return result.meta.changes > 0 ? ('added' as const) : ('already' as const)
}

export async function joinWaitlist(
  env: Env,
  input: { email?: unknown; locale?: unknown; source?: unknown; turnstileToken?: unknown; remoteIp?: string },
  fetcher: typeof fetch = fetch,
) {
  const email = normalizeEmail(input.email)
  if (!isValidEmail(email)) throw new ApiError(400, 'invalid_email')
  await verifyTurnstile(env, input.turnstileToken, input.remoteIp, fetcher)
  return addToWaitlist(env.DB, {
    id: createId('wl'),
    email,
    locale: clampWaitlistLocale(input.locale),
    source: clampWaitlistSource(input.source),
    createdAt: nowIso(),
  })
}

export function registerWaitlistRoutes(app: Hono<AppContext>) {
  app.post('/api/waitlist', async (c) => {
    const ip = c.req.header('cf-connecting-ip')
    await rateLimit(c.env.AUTH_LIMITER, `waitlist:${ip ?? 'local'}`)
    const body = await readJson<{ email: string; locale: string; source: string; turnstileToken: string }>(c)
    const status = await joinWaitlist(c.env, { ...body, remoteIp: ip })
    return c.json({ status }, status === 'added' ? 201 : 200)
  })
}

export function registerWaitlistAdminRoutes(routes: Hono<AppContext>) {
  routes.get('/waitlist', async (c) => {
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1)
    const limit = 50
    const offset = (page - 1) * limit
    const rows = await c.env.DB.prepare('SELECT id, email, locale, source, created_at FROM waitlist ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(limit, offset).all()
    return c.json({ signups: rows.results })
  })

  routes.get('/waitlist.csv', async (c) => {
    const rows = await c.env.DB.prepare('SELECT email, locale, source, created_at FROM waitlist ORDER BY created_at DESC').all<WaitlistRow>()
    c.header('Content-Type', 'text/csv; charset=utf-8')
    c.header('Content-Disposition', 'attachment; filename="waitlist.csv"')
    c.header('Cache-Control', 'private, no-store')
    return c.body(waitlistCsv(rows.results))
  })
}
