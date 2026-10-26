import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ledgerStatements } from '#/server/credits'
import { failGeneration, handleVideoJob } from '#/server/jobs'
import { resolveEffectiveVideoProvider } from '#/server/video'
import { d1Shim, migrate } from './d1-sqlite'

vi.mock('#/server/notifications', () => ({ notifyGenerationFinished: async () => {} }))

// 创建时锁定渠道：jobs 只读 generations.provider。这里用真实 getVideoProvider，不用 jobs.test 的 mock。
let sqlite: DatabaseSync
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  migrate(sqlite)
  const now = new Date().toISOString()
  sqlite.prepare('INSERT INTO users (id, email, credits, created_at) VALUES (?, ?, 0, ?)').run('usr_1', 'u@example.com', now)
  sqlite
    .prepare(`INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, created_at) VALUES ('upl_1', 'usr_1', 'uploads/usr_1/upl_1', 'image/jpeg', 8, ?)`)
    .run(now)
  sqlite
    .prepare(
      `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider, created_at, updated_at)
       VALUES ('gen_old', 'usr_1', 't', 'short', 6, 6, 'upl_1', 'queued', 'mock', ?, ?)`,
    )
    .run(now, now)
  env = {
    DB: d1Shim(sqlite),
    APP_ENV: 'development',
    VIDEO_PROVIDER: 'opengen',
    OPENGEN_STUB: '1',
    SITE_URL: 'http://localhost:3000',
    SESSION_SECRET: 's'.repeat(40),
    VIDEO_QUEUE: { send: async () => {} },
  } as unknown as Env
  vi.stubGlobal('fetch', async () => {
    throw new Error('channel lock must not call the network')
  })
})

const row = (id: string) =>
  sqlite.prepare('SELECT status, provider, provider_request_id, provider_meta FROM generations WHERE id = ?').get(id) as {
    status: string
    provider: string
    provider_request_id: string | null
    provider_meta: string | null
  }

describe('创建时锁定渠道', () => {
  it('切到 opengen 之后，已排队的 mock 工单仍用 mock，且不访问网络', async () => {
    expect(resolveEffectiveVideoProvider(env, { videoProvider: 'opengen' })).toBe('opengen')
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_old' })
    const old = row('gen_old')
    expect(old.status).toBe('processing')
    expect(old.provider).toBe('mock')
    expect(old.provider_request_id).toBe('mock_gen_old')
  })

  it('新工单写入解析后的 opengen，联调 stub 不发请求；旧工单不变', async () => {
    const providerId = resolveEffectiveVideoProvider(env, { videoProvider: null })
    expect(providerId).toBe('opengen')
    const now = new Date().toISOString()
    sqlite
      .prepare(
        `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider, created_at, updated_at)
         VALUES ('gen_new', 'usr_1', 't', 'short', 6, 6, 'upl_1', 'queued', ?, ?, ?)`,
      )
      .run(providerId, now, now)
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_old' })
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_new' })
    expect(row('gen_old')).toMatchObject({ provider: 'mock', provider_request_id: 'mock_gen_old' })
    const created = row('gen_new')
    expect(created.provider).toBe('opengen')
    expect(created.provider_request_id).toBe('opengen_stub_gen_new')
    expect(created.provider_meta).toContain('联调')
  })

  it('production 执行拒绝 mock：工单放回 queued', async () => {
    env.APP_ENV = 'production'
    env.VIDEO_PROVIDER = 'fal'
    await expect(handleVideoJob(env, { kind: 'submit', generationId: 'gen_old' })).rejects.toMatchObject({ code: 'video_not_configured' })
    expect(row('gen_old')).toMatchObject({ status: 'queued', provider: 'mock', provider_request_id: null })
  })
})

describe('失败退点', () => {
  it('同一工单重复失败至多退一次，键是 generation_refund:<id>', async () => {
    const now = new Date().toISOString()
    sqlite
      .prepare(
        `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider, created_at, updated_at)
         VALUES ('gen_refund', 'usr_1', 't', 'short', 6, 6, 'upl_1', 'processing', 'mock', ?, ?)`,
      )
      .run(now, now)
    const db = env.DB
    await db.batch(
      ledgerStatements(db, { userId: 'usr_1', delta: 6, reason: 'purchase', idempotencyKey: 'credit:gen_refund' }),
    )
    await db.batch(
      ledgerStatements(db, { userId: 'usr_1', delta: -6, reason: 'generation', refId: 'gen_refund', idempotencyKey: 'generation:gen_refund' }),
    )
    const credits = () => (sqlite.prepare('SELECT credits FROM users WHERE id = ?').get('usr_1') as { credits: number }).credits
    expect(credits()).toBe(0)
    expect(await failGeneration(env, 'gen_refund', 'timeout', 'Generation timed out')).toBe(true)
    expect(credits()).toBe(6)
    expect(await failGeneration(env, 'gen_refund', 'timeout', 'late duplicate')).toBe(false)
    expect(credits()).toBe(6)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM credit_ledger WHERE idempotency_key = 'generation_refund:gen_refund'`).get()).toEqual({ n: 1 })
    expect(sqlite.prepare(`SELECT status, refunded FROM generations WHERE id = 'gen_refund'`).get()).toEqual({ status: 'failed', refunded: 1 })
  })
})
