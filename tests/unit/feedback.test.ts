import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { exportUserData } from '#/server/account-export'
import { createFeedback, deleteOpenFeedback, listMyFeedback, OPEN_LIMIT, parseFeedbackDraft, parseFeedbackUpdate, setFeedbackStatus } from '#/server/feedback'
import { ApiError } from '#/server/util'
import { d1Shim, migrate } from './d1-sqlite'

describe('反馈文案校验', () => {
  it('标题和正文去空白，超长或空的拒绝', () => {
    expect(parseFeedbackDraft({ title: '  hi ', body: ' there ' })).toEqual({ ok: true, value: { title: 'hi', body: 'there' } })
    expect(parseFeedbackDraft({ title: '', body: 'x' })).toEqual({ ok: false, reason: 'title' })
    expect(parseFeedbackDraft({ title: 'x'.repeat(81), body: 'x' })).toEqual({ ok: false, reason: 'title' })
    expect(parseFeedbackDraft({ title: 'x', body: '' })).toEqual({ ok: false, reason: 'body' })
    expect(parseFeedbackDraft({ title: 'x', body: 'y'.repeat(2001) })).toEqual({ ok: false, reason: 'body' })
  })

  it('状态必须是四种之一，回复超过 500 字拒绝', () => {
    expect(parseFeedbackUpdate({ status: 'shipped', adminNote: '  soon ' })).toEqual({ status: 'shipped', adminNote: 'soon' })
    expect(parseFeedbackUpdate({ status: 'closed' })).toEqual({ status: 'closed', adminNote: null })
    expect(() => parseFeedbackUpdate({ status: 'done' })).toThrow(ApiError)
    expect(() => parseFeedbackUpdate({ status: 'open', adminNote: 'n'.repeat(501) })).toThrow(ApiError)
  })
})

describe('反馈读写', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    migrate(sqlite)
    db = d1Shim(sqlite) as unknown as D1Database
    sqlite.prepare('INSERT INTO users (id, email, credits, created_at) VALUES (?, ?, 0, ?)').run('u1', 'one@example.com', '2026-10-25T00:00:00.000Z')
    sqlite.prepare('INSERT INTO users (id, email, credits, created_at) VALUES (?, ?, 0, ?)').run('u2', 'two@example.com', '2026-10-25T00:00:00.000Z')
  })

  it('只能看到自己的，只能删除仍为 open 的，状态流转写回复', async () => {
    const created = await createFeedback(db, 'u1', { title: 'Dark mode', body: 'The dashboard is bright.' })
    await createFeedback(db, 'u2', { title: 'Other', body: 'Not yours.' })
    const mine = await listMyFeedback(db, 'u1')
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ id: created.id, title: 'Dark mode', status: 'open', adminNote: null })

    expect(await deleteOpenFeedback(db, 'u2', created.id)).toBe(false)
    expect(await setFeedbackStatus(db, created.id, { status: 'planned', adminNote: 'On the list' })).toBe(true)
    expect(await deleteOpenFeedback(db, 'u1', created.id)).toBe(false)
    expect((await listMyFeedback(db, 'u1'))[0]).toMatchObject({ status: 'planned', adminNote: 'On the list' })
    expect(await setFeedbackStatus(db, 'missing', { status: 'closed', adminNote: null })).toBe(false)

    await setFeedbackStatus(db, created.id, { status: 'open', adminNote: null })
    expect(await deleteOpenFeedback(db, 'u1', created.id)).toBe(true)
    expect(await listMyFeedback(db, 'u1')).toEqual([])
  })

  it('每人最多 10 条 open', async () => {
    for (let i = 0; i < OPEN_LIMIT; i++) await createFeedback(db, 'u1', { title: `t${i}`, body: 'body' })
    await expect(createFeedback(db, 'u1', { title: 'more', body: 'body' })).rejects.toMatchObject({ code: 'feedback_limit', status: 409 })
    await expect(createFeedback(db, 'u1', { title: '', body: 'body' })).rejects.toMatchObject({ code: 'invalid_title' })
  })

  it('导出个人数据带上反馈，不含别人的', async () => {
    await createFeedback(db, 'u1', { title: 'Mine', body: 'Please add captions.' })
    await createFeedback(db, 'u2', { title: 'Theirs', body: 'Secret.' })
    const data = await exportUserData({ DB: db } as Env, 'u1')
    expect(data.feedback).toEqual([expect.objectContaining({ title: 'Mine', body: 'Please add captions.', status: 'open' })])
  })
})
