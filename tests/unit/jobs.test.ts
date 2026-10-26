import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleVideoJob } from '#/server/jobs'
import type { VideoStatus } from '#/server/video/types'
import { d1Shim, migrate } from './d1-sqlite'

// 多步任务（yir 两步走）在轮询里进入下一步：jobs.ts 把新的服务商任务写回 generations，只写一次
const status = vi.fn<(requestId: string, meta: Record<string, unknown>) => Promise<VideoStatus>>()
vi.mock('#/server/video', () => ({ getVideoProvider: () => ({ id: 'yir', status, costCents: () => 0 }) }))
vi.mock('#/server/notifications', () => ({ notifyGenerationFinished: async () => {} }))

let sqlite: DatabaseSync
let sent: unknown[]
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  migrate(sqlite)
  sent = []
  env = { DB: d1Shim(sqlite), VIDEO_QUEUE: { send: async (message: unknown) => void sent.push(message) } } as unknown as Env
  const now = new Date().toISOString()
  sqlite.prepare('INSERT INTO users (id, email, credits, created_at) VALUES (?, ?, 0, ?)').run('usr_1', 'u@example.com', now)
  sqlite
    .prepare(
      `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider,
       provider_request_id, provider_meta, created_at, updated_at) VALUES ('gen_1', 'usr_1', 't', 'short', 6, 6, 'upl_1', 'processing', 'yir', 'job_s', ?, ?, ?)`,
    )
    .run(JSON.stringify({ stage: 'scene' }), now, now)
  status.mockReset()
})

const row = () => sqlite.prepare('SELECT status, provider_request_id, provider_meta FROM generations WHERE id = ?').get('gen_1')
const advance = { state: 'pending', next: { requestId: 'job_v', meta: { stage: 'video', sceneCostCents: 1 } } } as const

function memoryMedia(seed: Record<string, Uint8Array> = {}) {
  const objects = new Map(Object.entries(seed).map(([key, value]) => [key, value.slice()]))
  return {
    objects,
    bucket: {
      async get(key: string) {
        const body = objects.get(key)
        if (!body) return null
        const copy = body.slice()
        return { arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) }
      },
      async put(key: string, data: ArrayBuffer | Uint8Array) {
        objects.set(key, data instanceof Uint8Array ? data.slice() : new Uint8Array(data))
      },
      async delete(key: string) {
        objects.delete(key)
      },
    },
  }
}

describe('jobs：多步任务进入下一步', () => {
  it('provider 返回 next：之后轮询新任务，meta 换成下一步的', async () => {
    status.mockResolvedValue(advance)
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_1' })
    expect(status).toHaveBeenCalledWith('job_s', { stage: 'scene' })
    expect(row()).toEqual({ status: 'processing', provider_request_id: 'job_v', provider_meta: '{"stage":"video","sceneCostCents":1}' })
    expect(sent).toEqual([{ kind: 'poll', generationId: 'gen_1' }])
  })

  it('webhook 和定时轮询同时推进：晚到的一路按旧任务 id 抢占失败，不覆盖另一路写入的状态，也不多排一次轮询', async () => {
    status.mockImplementation(async () => {
      // 这一路查询期间，另一路已经推进并写入
      sqlite.prepare('UPDATE generations SET provider_request_id = ?, provider_meta = ? WHERE id = ?').run('job_v', '{"stage":"video"}', 'gen_1')
      return advance
    })
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_1' })
    expect(row()).toEqual({ status: 'processing', provider_request_id: 'job_v', provider_meta: '{"stage":"video"}' })
    expect(sent).toEqual([])
  })

  it('超时已退款后迟到成功：不改失败终态和余额，删掉无主成片，仍记下服务商成本', async () => {
    const media = memoryMedia({ 'templates/source.mp4': new Uint8Array([1, 2, 3, 4]) })
    env.MEDIA = media.bucket as unknown as Env['MEDIA']
    sqlite.prepare(`UPDATE users SET credits = 10 WHERE id = 'usr_1'`).run()
    status.mockImplementation(async () => {
      sqlite.prepare(`UPDATE generations SET status = 'failed', refunded = 1, error_code = 'timeout' WHERE id = 'gen_1'`).run()
      return { state: 'completed', output: { r2Key: 'templates/source.mp4' }, costCents: 42 }
    })
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_1' })
    expect(sqlite.prepare('SELECT status, refunded, provider_cost_cents, output_r2_key FROM generations WHERE id = ?').get('gen_1')).toEqual({
      status: 'failed',
      refunded: 1,
      provider_cost_cents: 42,
      output_r2_key: null,
    })
    expect(sqlite.prepare('SELECT credits FROM users WHERE id = ?').get('usr_1')).toEqual({ credits: 10 })
    expect(media.objects.has('outputs/usr_1/gen_1.mp4')).toBe(false)
  })

  it('轮询开始时已经失败：不再查询服务商，也不改余额和成本', async () => {
    sqlite.prepare(`UPDATE generations SET status = 'failed', refunded = 1 WHERE id = 'gen_1'`).run()
    sqlite.prepare(`UPDATE users SET credits = 4 WHERE id = 'usr_1'`).run()
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_1' })
    expect(status).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT credits FROM users WHERE id = ?').get('usr_1')).toEqual({ credits: 4 })
    expect(sqlite.prepare('SELECT provider_cost_cents, status FROM generations WHERE id = ?').get('gen_1')).toEqual({
      provider_cost_cents: null,
      status: 'failed',
    })
  })
})
