// 产品反馈：登录用户提交、查看和删除自己仍为 open 的条目。和联系表单、举报下架不是同一张表。
// open 条数是软上限：COUNT 和 INSERT 不在一个事务里，并发时可能短暂超过。真正的滥用处理是封禁账号。
import { Hono } from 'hono'
import { audit, pageParams, readJson, requireAdmin, requireUser } from './http'
import type { AppContext } from './types'
import { ApiError, createId, nowIso } from './util'

export const FEEDBACK_STATUSES = ['open', 'planned', 'shipped', 'closed'] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]
export const TITLE_MAX = 80
export const BODY_MAX = 2000
export const NOTE_MAX = 500
export const OPEN_LIMIT = 10

export type FeedbackDraft = { title: string; body: string }

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(value)
}

export function parseFeedbackDraft(input: { title?: unknown; body?: unknown }): { ok: true; value: FeedbackDraft } | { ok: false; reason: 'title' | 'body' } {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (!title || title.length > TITLE_MAX) return { ok: false, reason: 'title' }
  if (!body || body.length > BODY_MAX) return { ok: false, reason: 'body' }
  return { ok: true, value: { title, body } }
}

export function parseFeedbackUpdate(input: { status?: unknown; adminNote?: unknown }) {
  if (!isFeedbackStatus(input.status)) throw new ApiError(400, 'invalid_status')
  if (input.adminNote != null && typeof input.adminNote !== 'string') throw new ApiError(400, 'invalid_note')
  const note = typeof input.adminNote === 'string' ? input.adminNote.trim() : ''
  if (note.length > NOTE_MAX) throw new ApiError(400, 'invalid_note')
  return { status: input.status, adminNote: note || null }
}

type FeedbackSqlRow = {
  id: string
  title: string
  body: string
  status: string
  admin_note: string | null
  created_at: string
  updated_at: string
}

export function publicFeedback(row: FeedbackSqlRow) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    adminNote: row.admin_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createFeedback(db: D1Database, userId: string, input: { title?: unknown; body?: unknown }, now = nowIso()) {
  const parsed = parseFeedbackDraft(input)
  if (!parsed.ok) throw new ApiError(400, parsed.reason === 'title' ? 'invalid_title' : 'invalid_feedback')
  const open = await db.prepare(`SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND status = 'open'`).bind(userId).first<{ n: number }>()
  if (Number(open?.n ?? 0) >= OPEN_LIMIT) throw new ApiError(409, 'feedback_limit')
  const id = createId('fb')
  await db
    .prepare('INSERT INTO feedback (id, user_id, title, body, status, admin_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
    .bind(id, userId, parsed.value.title, parsed.value.body, 'open', now, now)
    .run()
  return { id }
}

export async function listMyFeedback(db: D1Database, userId: string) {
  const rows = await db
    .prepare('SELECT id, title, body, status, admin_note, created_at, updated_at FROM feedback WHERE user_id = ? ORDER BY created_at DESC, id DESC')
    .bind(userId)
    .all<FeedbackSqlRow>()
  return rows.results.map(publicFeedback)
}

export async function deleteOpenFeedback(db: D1Database, userId: string, id: string) {
  const result = await db.prepare(`DELETE FROM feedback WHERE id = ? AND user_id = ? AND status = 'open'`).bind(id, userId).run()
  return result.meta.changes > 0
}

export async function setFeedbackStatus(db: D1Database, id: string, update: { status: FeedbackStatus; adminNote: string | null }, now = nowIso()) {
  const result = await db
    .prepare('UPDATE feedback SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?')
    .bind(update.status, update.adminNote, now, id)
    .run()
  return result.meta.changes > 0
}

export function registerFeedbackRoutes(app: Hono<AppContext>) {
  app.get('/api/feedback', async (c) => {
    const user = requireUser(c)
    return c.json({ feedback: await listMyFeedback(c.env.DB, user.id) })
  })

  app.post('/api/feedback', async (c) => {
    const user = requireUser(c)
    const body = await readJson<{ title: string; body: string }>(c)
    const created = await createFeedback(c.env.DB, user.id, body)
    return c.json(created, 201)
  })

  app.delete('/api/feedback/:id', async (c) => {
    const user = requireUser(c)
    const removed = await deleteOpenFeedback(c.env.DB, user.id, c.req.param('id'))
    if (!removed) throw new ApiError(404, 'not_found')
    return c.json({ ok: true })
  })
}

export function registerFeedbackAdminRoutes(routes: Hono<AppContext>) {
  routes.get('/feedback', async (c) => {
    const { limit, offset } = pageParams(c)
    const status = c.req.query('status')
    const filter = isFeedbackStatus(status) ? status : null
    const rows = await c.env.DB.prepare(
      `SELECT f.id, f.user_id, f.title, f.body, f.status, f.admin_note, f.created_at, f.updated_at, u.email, u.name
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id
       WHERE (?1 IS NULL OR f.status = ?1)
       ORDER BY f.created_at DESC, f.id DESC LIMIT ?2 OFFSET ?3`,
    )
      .bind(filter, limit, offset)
      .all()
    return c.json({ feedback: rows.results })
  })

  routes.post('/feedback/:id', async (c) => {
    const admin = requireAdmin(c)
    const update = parseFeedbackUpdate(await readJson<{ status: string; adminNote?: string }>(c))
    const id = c.req.param('id')
    if (!(await setFeedbackStatus(c.env.DB, id, update))) throw new ApiError(404, 'not_found')
    await audit(c.env, admin, 'feedback.status', 'feedback', id, update)
    return c.json({ ok: true, ...update })
  })
}
