import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findVideoTemplate } from '#/config/site'
import { handleVideoJob } from '#/server/jobs'
import { d1Shim, migrate } from './d1-sqlite'

// 提交窗口单独测：jobs.test.ts 的 mock 只覆盖 yir 轮询，不要混进 submit。
const submit = vi.fn()
vi.mock('#/server/video', () => ({
  getVideoProvider: () => ({ id: 'fal', submit, costCents: () => 0, status: async () => ({ state: 'pending' as const }) }),
}))
vi.mock('#/server/notifications', () => ({ notifyGenerationFinished: async () => {} }))

let sqlite: DatabaseSync
let sent: unknown[]
let failSend: boolean
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  migrate(sqlite)
  sent = []
  failSend = false
  submit.mockReset()
  submit.mockResolvedValue({ requestId: 'req_fal_1', meta: {} })
  const template = findVideoTemplate('new-york') as { sources?: unknown }
  delete template.sources
  env = {
    APP_ENV: 'production',
    SITE_URL: 'https://example.test',
    SESSION_SECRET: 'a'.repeat(64),
    DB: d1Shim(sqlite),
    VIDEO_QUEUE: {
      send: async (message: unknown) => {
        if (failSend) throw new Error('queue down')
        sent.push(message)
      },
    },
  } as unknown as Env
  const now = '2026-10-26T00:00:00.000Z'
  sqlite.prepare('INSERT INTO users (id, email, credits, created_at) VALUES (?, ?, 20, ?)').run('usr_1', 'u@example.com', now)
  sqlite
    .prepare('INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('upl_1', 'usr_1', 'uploads/upl_1.jpg', 'image/jpeg', 12, now)
  sqlite
    .prepare(
      `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider, created_at, updated_at)
       VALUES ('gen_fal', 'usr_1', 'new-york', 'short', 6, 6, 'upl_1', 'queued', 'fal', ?, ?)`,
    )
    .run(now, now)
})

const row = () =>
  sqlite.prepare('SELECT status, provider_request_id, attempts FROM generations WHERE id = ?').get('gen_fal') as {
    status: string
    provider_request_id: string | null
    attempts: number
  }

describe('jobs：服务商接受之后不再 submit', () => {
  it('enqueue 在 200 之后抛错时 submit 只调用一次，且不把行打回 queued', async () => {
    failSend = true
    await expect(handleVideoJob(env, { kind: 'submit', generationId: 'gen_fal' })).rejects.toThrow(/queue down/)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![0]).toMatchObject({ sourceVideoKey: 'templates/neon-shuffle-v1-6s.mp4' })
    expect(row()).toEqual({ status: 'processing', provider_request_id: 'req_fal_1', attempts: 1 })

    failSend = false
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_fal' })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([{ kind: 'poll', generationId: 'gen_fal' }])
    expect(row()).toEqual({ status: 'processing', provider_request_id: 'req_fal_1', attempts: 1 })
  })

  it('世界声明了这一时长的源文件时，提交用那个文件；其它时长仍用共享源', async () => {
    const template = findVideoTemplate('new-york') as { sources?: Record<string, string> }
    template.sources = { short: 'city-ny-6s.mp4' }
    try {
      await handleVideoJob(env, { kind: 'submit', generationId: 'gen_fal' })
      expect(submit.mock.calls[0]![0].sourceVideoKey).toBe('templates/city-ny-6s.mp4')

      sqlite.prepare(`UPDATE generations SET status = 'queued', provider_request_id = NULL, duration_id = 'medium', duration_seconds = 12 WHERE id = 'gen_fal'`).run()
      submit.mockClear()
      await handleVideoJob(env, { kind: 'submit', generationId: 'gen_fal' })
      expect(submit.mock.calls[0]![0].sourceVideoKey).toBe('templates/neon-shuffle-v1-12s.mp4')
    } finally {
      delete template.sources
    }
  })
})
