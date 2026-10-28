import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '#/server/app'
import { describeAutoRoute } from '#/server/auto-route'
import { resolveCreateComponent } from '#/server/components'
import { REQUIRED_BINDINGS, checkConfig, type ConfigInput } from '#/server/config-health'
import { ledgerStatements } from '#/server/credits'
import { syncManualSheet } from '#/server/fulfillment'
import { forgetLegacyFulfillmentMap } from '#/server/settings'
import { failGeneration, handleVideoJob, runScheduledMaintenance } from '#/server/jobs'
import { jobToken } from '#/server/media'
import { decideOpenGenFallback, RECONCILE_ABSENT_GAP_MS } from '#/server/opengen-fallback'
import { runProbe } from '#/server/probes'
import { SHEET_COLUMNS, duplicateRowIndexes } from '#/server/sheets'
import type { UserRow } from '#/server/types'
import { sha256Hex } from '#/server/util'
import { openGenDeploymentClass, openGenJobBody } from '#/server/video/opengen'
import { d1Shim, kvShim, migrate } from './d1-sqlite'

const origin = 'http://127.0.0.1:8787'
const token = 'sid-token'
const admin = { id: 'usr_admin', email: 'admin@example.com', role: 'admin' } as UserRow

const SECRET = 'a'.repeat(64)
function ready(overrides: { vars?: Record<string, string>; secrets?: ConfigInput['secrets'] } = {}): ConfigInput {
  return {
    vars: {
      APP_ENV: 'production',
      SITE_URL: 'https://moonhop.ai',
      PAYMENT_PROVIDER: 'waffo',
      VIDEO_PROVIDER: 'opengen',
      OPENGEN_BASE_URL: 'https://og.example',
      OPENGEN_STUB: '0',
      EMERGENCY_VIDEO_PROVIDER: '',
      MODERATION_PROVIDER: 'openai',
      ADMIN_EMAILS: 'ops@moonhop.ai',
      EMAIL_FROM: 'noreply@mail.moonhop.ai',
      WAFFO_ENVIRONMENT: 'prod',
      WAFFO_PRODUCTS: '{"starter":"PROD_1","party":"PROD_2"}',
      GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
      TURNSTILE_SITE_KEY: '0x4AAA',
      ...overrides.vars,
    },
    secrets: {
      SESSION_SECRET: SECRET,
      GOOGLE_CLIENT_SECRET: 'g',
      WAFFO_MERCHANT_ID: 'm',
      WAFFO_PRIVATE_KEY: 'k',
      OPENGEN_API_KEY: 'og',
      OPENAI_API_KEY: 'o',
      TURNSTILE_SECRET_KEY: 't',
      GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet',
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sheets@example.iam.gserviceaccount.com',
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'pem',
      ...overrides.secrets,
    },
    bindings: REQUIRED_BINDINGS,
    packageIds: ['starter', 'party'],
    siteDomain: 'moonhop.ai',
  }
}

describe('OpenGen 回退真值表', () => {
  const stay = { action: 'stay' as const }

  it('任务 id、已接受、或查到任务都留在 OpenGen', () => {
    expect(decideOpenGenFallback({ taskIdRecorded: true, submit: 'unknown', lookups: [{ kind: 'absent', atMs: 0 }] })).toEqual(stay)
    expect(decideOpenGenFallback({ taskIdRecorded: false, submit: 'accepted', lookups: [] })).toEqual(stay)
    expect(
      decideOpenGenFallback({ taskIdRecorded: false, submit: 'unknown', lookups: [{ kind: 'found', atMs: 1, taskId: 'job_1' }] }),
    ).toEqual({ action: 'stay', taskId: 'job_1' })
  })

  it('请求还没发出且健康检查连不上才改人工；一次 404 或查询失败都冻结', () => {
    expect(
      decideOpenGenFallback({ taskIdRecorded: false, submit: 'not_sent', preflight: 'unreachable', lookups: [] }),
    ).toEqual({ action: 'manual', reason: 'unreachable_before_submit' })
    expect(decideOpenGenFallback({ taskIdRecorded: false, submit: 'not_sent', preflight: 'unhealthy', lookups: [] })).toEqual({
      action: 'freeze',
      reason: 'submit_unknown',
    })
    expect(decideOpenGenFallback({ taskIdRecorded: false, submit: 'unknown', lookups: [{ kind: 'absent', atMs: 1 }] })).toEqual({
      action: 'freeze',
      reason: 'absent_unconfirmed',
    })
    expect(
      decideOpenGenFallback({
        taskIdRecorded: false,
        submit: 'unknown',
        lookups: [
          { kind: 'absent', atMs: 0 },
          { kind: 'absent', atMs: RECONCILE_ABSENT_GAP_MS },
          { kind: 'unclear', atMs: 5 },
        ],
      }),
    ).toEqual({ action: 'freeze', reason: 'lookup_unclear' })
  })

  it('确认没有任务才改同一行人工：提交前被拒加一次 404，或两次 404 间隔够长', () => {
    expect(
      decideOpenGenFallback({ taskIdRecorded: false, submit: 'rejected_before_store', lookups: [{ kind: 'absent', atMs: 5 }] }),
    ).toEqual({ action: 'manual', reason: 'confirmed_absent' })
    expect(
      decideOpenGenFallback({
        taskIdRecorded: false,
        submit: 'unknown',
        lookups: [
          { kind: 'absent', atMs: 0 },
          { kind: 'absent', atMs: RECONCILE_ABSENT_GAP_MS - 1 },
        ],
      }),
    ).toEqual({ action: 'freeze', reason: 'absent_unconfirmed' })
    expect(
      decideOpenGenFallback({
        taskIdRecorded: false,
        submit: 'unknown',
        lookups: [
          { kind: 'absent', atMs: 1_000 },
          { kind: 'absent', atMs: 1_000 + RECONCILE_ABSENT_GAP_MS },
        ],
      }),
    ).toEqual({ action: 'manual', reason: 'confirmed_absent' })
    expect(decideOpenGenFallback({ taskIdRecorded: false, submit: 'unknown', lookups: [] })).toEqual({
      action: 'freeze',
      reason: 'submit_unknown',
    })
  })
})

describe('冻结的 jobs 正文和部署分类', () => {
  it('正文只有一图加源视频，不带组件 id 或跨站字段', () => {
    const body = openGenJobBody({
      generationId: 'gen_1',
      durationSeconds: 6,
      imageUrl: 'https://moonhop.ai/media/uploads/upl_1',
      sourceVideoUrl: 'https://moonhop.ai/media/templates/neon-6s.mp4',
      webhookUrl: 'https://moonhop.ai/api/webhooks/opengen?gen=gen_1&token=t',
    })
    expect(body).toEqual({
      generation_id: 'gen_1',
      duration_seconds: 6,
      image_url: 'https://moonhop.ai/media/uploads/upl_1',
      source_video_url: 'https://moonhop.ai/media/templates/neon-6s.mp4',
      webhook_url: 'https://moonhop.ai/api/webhooks/opengen?gen=gen_1&token=t',
    })
    expect(body).not.toHaveProperty('component_id')
    expect(body).not.toHaveProperty('capability')
    expect(body).not.toHaveProperty('play')
    expect(body).not.toHaveProperty('site_id')
    expect(openGenJobBody({ ...{
      generationId: 'gen_1',
      durationSeconds: 6,
      imageUrl: 'https://moonhop.ai/i',
      sourceVideoUrl: 'https://moonhop.ai/v',
      webhookUrl: 'http://127.0.0.1/hook',
    } }).webhook_url).toBeUndefined()
  })

  it('本机和隧道不是公网', () => {
    expect(openGenDeploymentClass('http://127.0.0.1:8787')).toBe('local')
    expect(openGenDeploymentClass('https://demo.trycloudflare.com')).toBe('tunnel')
    expect(openGenDeploymentClass('https://og.example')).toBe('public')
  })
})

describe('新工单选路', () => {
  it('日常 auto 忽略 fal；应急开关和 OpenGen 同时存在则失败关闭', () => {
    expect(
      describeAutoRoute({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal', EMERGENCY_VIDEO_PROVIDER: '' } as Env).ok,
    ).toBe(false)
    expect(
      describeAutoRoute({
        APP_ENV: 'production',
        VIDEO_PROVIDER: 'fal',
        EMERGENCY_VIDEO_PROVIDER: '',
        OPENGEN_BASE_URL: 'https://og.example',
        OPENGEN_API_KEY: 'ogsk_site',
      } as Env),
    ).toMatchObject({ ok: true, provider: 'opengen', fulfillment: 'opengen' })
    expect(
      describeAutoRoute({
        APP_ENV: 'development',
        VIDEO_PROVIDER: 'mock',
        EMERGENCY_VIDEO_PROVIDER: 'fal',
        OPENGEN_API_KEY: 'ogsk_site',
      } as Env),
    ).toMatchObject({ ok: false, code: 'emergency_switch_conflict' })
    expect(
      describeAutoRoute({
        APP_ENV: 'production',
        VIDEO_PROVIDER: 'opengen',
        EMERGENCY_VIDEO_PROVIDER: 'fal',
        OPENGEN_BASE_URL: '',
        OPENGEN_API_KEY: '',
        OPENGEN_STUB: '0',
      } as Env),
    ).toMatchObject({ ok: true, provider: 'fal', fulfillment: 'emergency' })
    expect(describeAutoRoute({ APP_ENV: 'development', VIDEO_PROVIDER: 'mock', EMERGENCY_VIDEO_PROVIDER: '' } as Env)).toMatchObject({
      ok: true,
      provider: 'mock',
    })
    expect(describeAutoRoute({ APP_ENV: 'production', VIDEO_PROVIDER: 'mock', EMERGENCY_VIDEO_PROVIDER: 'nope' } as Env)).toMatchObject({
      ok: false,
      code: 'emergency_switch_invalid',
    })
  })

  it('组件检查先拒绝禁止字段和不兼容版本；auto 下不能自动的组件在形状错误之前拒绝', () => {
    expect(resolveCreateComponent({ capability: 'x' }, 'manual')).toMatchObject({ ok: false, status: 400, code: 'forbidden_field' })
    expect(resolveCreateComponent({ site_id: 'other' }, 'auto')).toMatchObject({ ok: false, code: 'forbidden_field' })
    expect(resolveCreateComponent({ componentId: 'image-source-video', componentVersion: 0 }, 'manual')).toMatchObject({
      ok: false,
      status: 400,
      code: 'incompatible_component',
    })
    expect(resolveCreateComponent({ componentId: 'audio-two-images', componentVersion: 1 }, 'auto')).toMatchObject({
      ok: false,
      status: 409,
      code: 'component_not_auto_eligible',
    })
    expect(resolveCreateComponent({ componentId: 'audio-two-images', componentVersion: 1 }, 'manual')).toMatchObject({
      ok: false,
      status: 400,
      code: 'invalid_component_input',
    })
    expect(resolveCreateComponent({}, 'auto')).toMatchObject({ ok: true, component: { id: 'image-source-video', version: 1, autoEligible: true } })
  })
})

describe('创建生成：扣费前拒绝，不可达才落同一行人工', () => {
  let sqlite: DatabaseSync
  let env: Env
  let sent: unknown[]
  let fetched: string[]

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    migrate(sqlite)
    sent = []
    fetched = []
    env = {
      APP_ENV: 'development',
      SITE_URL: origin,
      VIDEO_PROVIDER: 'opengen',
      EMERGENCY_VIDEO_PROVIDER: '',
      OPENGEN_BASE_URL: 'https://og.example',
      OPENGEN_API_KEY: 'ogsk_site_key',
      OPENGEN_STUB: '0',
      SESSION_SECRET: 's'.repeat(64),
      DB: d1Shim(sqlite),
      KV: kvShim(),
      VIDEO_QUEUE: { send: async (message: unknown) => void sent.push(message) },
      MEDIA: { async put() {}, async delete() {}, async get() { return null } },
    } as unknown as Env
    const now = '2026-10-27T00:00:00.000Z'
    sqlite.prepare(`INSERT INTO users (id, email, credits, role, locale, created_at) VALUES ('usr_1', 'u@example.com', 0, 'user', 'en', ?)`).run(now)
    sqlite.prepare(`INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, created_at) VALUES ('upl_1', 'usr_1', 'uploads/u/upl_1', 'image/jpeg', 8, ?)`).run(now)
    sqlite.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 'usr_1', '2099-01-01T00:00:00.000Z', ?)`).run(await sha256Hex(token), now)
    await env.DB.batch(ledgerStatements(env.DB, { userId: 'usr_1', delta: 40, reason: 'purchase', idempotencyKey: 'purchase:test' }) as unknown as D1PreparedStatement[])
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(String(url))
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const credits = () => (sqlite.prepare('SELECT credits FROM users WHERE id = ?').get('usr_1') as { credits: number }).credits
  const rows = () => sqlite.prepare('SELECT id, provider, status, provider_meta, component_id, component_version, refunded FROM generations').all() as Array<Record<string, unknown>>

  function storeSetting(key: string, value: unknown) {
    sqlite.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, '2026-10-27') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value))
    ;(env.KV as unknown as { store: Map<string, string> }).store.delete('settings:v1')
  }

  async function create(extra: Record<string, unknown> = {}, templateId = 'new-york') {
    return app.request(
      `${origin}/api/generations`,
      {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', cookie: `sid=${token}` },
        body: JSON.stringify({ uploadId: 'upl_1', durationId: 'short', templateId, locale: 'en', ...extra }),
      },
      env,
    )
  }

  it('auto 且组件不能自动：409，不扣积分，不建行，不调用 OpenGen', async () => {
    storeSetting('fulfillmentMode', 'auto')
    const res = await create({ componentId: 'audio-two-images', componentVersion: 1 })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'component_not_auto_eligible' })
    expect(credits()).toBe(40)
    expect(rows()).toEqual([])
    expect(sent).toEqual([])
    expect(fetched).toEqual([])
  })

  it('禁止字段、不兼容版本、这个接口不接受的形状都在扣费前 400', async () => {
    storeSetting('fulfillmentMode', 'auto')
    expect((await create({ play: 'dance' })).status).toBe(400)
    expect((await create({ componentId: 'image-source-video', componentVersion: 0 })).status).toBe(400)
    storeSetting('fulfillmentMode', 'manual')
    const shape = await create({ componentId: 'audio-two-images', componentVersion: '1' })
    expect(shape.status).toBe(400)
    expect(await shape.json()).toMatchObject({ error: 'invalid_component_input' })
    expect(credits()).toBe(40)
    expect(rows()).toEqual([])
  })

  it('没传组件时记下默认的一图加源视频；库存的按模板 JSON 不改通道', async () => {
    storeSetting('fulfillmentMode', 'auto')
    storeSetting('fulfillmentModeByTemplate', { paris: 'manual' })
    env.VIDEO_PROVIDER = 'mock'
    const res = await create({}, 'paris')
    expect(res.status).toBe(201)
    const body = (await res.json()) as { generation: { componentId: string; componentVersion: number } }
    expect(body.generation).toMatchObject({ componentId: 'image-source-video', componentVersion: 1 })
    expect(rows()[0]).toMatchObject({ provider: 'mock', component_id: 'image-source-video', component_version: 1 })
    expect(credits()).toBe(34)
    expect(fetched).toEqual([])
  })

  it('飞行中的工单保持创建时的 provider；之后拨回 manual 只影响新单', async () => {
    storeSetting('fulfillmentMode', 'auto')
    env.VIDEO_PROVIDER = 'mock'
    expect((await create()).status).toBe(201)
    const first = rows()[0]!
    storeSetting('fulfillmentMode', 'manual')
    expect((await create({}, 'paris')).status).toBe(201)
    const again = rows()
    expect(again.find((row) => row.id === first.id)).toMatchObject({ provider: 'mock' })
    expect(again.find((row) => row.id !== first.id)).toMatchObject({ provider: 'manual' })
    expect(credits()).toBe(28)
  })

  it('OpenGen 未配置、不健康、或与应急开关冲突时不扣积分', async () => {
    storeSetting('fulfillmentMode', 'auto')
    env.OPENGEN_BASE_URL = ''
    env.OPENGEN_API_KEY = ''
    const missing = await create()
    expect(missing.status).toBe(503)
    expect(await missing.json()).toEqual({ error: 'provider_not_configured' })

    env.OPENGEN_BASE_URL = 'https://og.example'
    env.OPENGEN_API_KEY = 'ogsk_site_key'
    vi.stubGlobal('fetch', async () => new Response('no', { status: 401 }))
    const unhealthy = await create()
    expect(unhealthy.status).toBe(503)
    expect(await unhealthy.json()).toEqual({ error: 'opengen_unhealthy' })

    env.EMERGENCY_VIDEO_PROVIDER = 'fal'
    const conflict = await create()
    expect(conflict.status).toBe(503)
    expect(await conflict.json()).toEqual({ error: 'emergency_switch_conflict' })
    expect(credits()).toBe(40)
    expect(rows()).toEqual([])
    expect(sent).toEqual([])
  })

  it('提交前连不上：同一 generation 改人工，只扣一次，不入队，不改走 fal', async () => {
    storeSetting('fulfillmentMode', 'auto')
    env.VIDEO_PROVIDER = 'fal'
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(String(url))
      throw new Error('connect refused')
    })
    const res = await create()
    expect(res.status).toBe(201)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ provider: 'manual', status: 'queued', component_id: 'image-source-video' })
    expect(String(rows()[0]!.provider_meta)).toContain('unreachable_before_submit')
    expect(rows()[0]!.provider).toBe('manual')
    expect(credits()).toBe(34)
    expect(sent).toEqual([])
    expect(fetched.some((url) => url.includes('/v1/aimov/jobs'))).toBe(false)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM credit_ledger WHERE reason = 'generation'`).get()).toEqual({ n: 1 })
  })

  it('日常 fal 环境在 OpenGen 健康时仍入 OpenGen 队列', async () => {
    storeSetting('fulfillmentMode', 'auto')
    env.VIDEO_PROVIDER = 'fal'
    env.FAL_KEY = 'fal_should_not_be_used'
    const res = await create()
    expect(res.status).toBe(201)
    expect(rows()[0]).toMatchObject({ provider: 'opengen' })
    expect(sent).toEqual([{ kind: 'submit', generationId: rows()[0]!.id }])
    expect(fetched.every((url) => url.includes('og.example'))).toBe(true)
    expect(JSON.stringify(fetched)).not.toContain('fal.ai')
  })

  it('新的人工单通知履约负责人，用户的排队邮件另算', async () => {
    env.ADMIN_EMAILS = 'ops@example.com'
    const res = await create()
    expect(res.status).toBe(201)
    const mails = sqlite.prepare(`SELECT template, to_email FROM email_outbox ORDER BY template`).all()
    expect(mails).toEqual([
      { template: 'generation_accepted', to_email: 'u@example.com' },
      { template: 'manual_order_operator', to_email: 'ops@example.com' },
    ])
  })

  it('打开后台设置时删掉库存的按模板 JSON', async () => {
    sqlite.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('fulfillmentModeByTemplate', ?, '2026-10-27')`).run(JSON.stringify({ paris: 'auto' }))
    await (env.KV as unknown as { put: (k: string, v: string) => Promise<void> }).put('settings:v1', '{}')
    expect(await forgetLegacyFulfillmentMap(env)).toBe(true)
    expect(sqlite.prepare(`SELECT key FROM settings WHERE key = 'fulfillmentModeByTemplate'`).get()).toBeUndefined()
    expect((env.KV as unknown as { store: Map<string, string> }).store.has('settings:v1')).toBe(false)
  })
})

describe('Worker：对账、终态和超时', () => {
  let sqlite: DatabaseSync
  let env: Env
  let sent: unknown[]
  let calls: Array<{ url: string; method: string; body?: string }>

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    migrate(sqlite)
    sent = []
    calls = []
    env = {
      APP_ENV: 'development',
      SITE_URL: 'https://example.test',
      VIDEO_PROVIDER: 'opengen',
      EMERGENCY_VIDEO_PROVIDER: '',
      OPENGEN_BASE_URL: 'https://og.example',
      OPENGEN_API_KEY: 'ogsk_site_key',
      OPENGEN_STUB: '0',
      SESSION_SECRET: 's'.repeat(64),
      DB: d1Shim(sqlite),
      VIDEO_QUEUE: { send: async (message: unknown) => void sent.push(message) },
      MEDIA: { async put() {}, async delete() {}, async get() { return null } },
    } as unknown as Env
    const now = new Date().toISOString()
    sqlite.prepare(`INSERT INTO users (id, email, credits, role, locale, created_at) VALUES ('usr_1', 'u@example.com', 0, 'user', 'en', ?)`).run(now)
    sqlite.prepare(`INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, created_at) VALUES ('upl_1', 'usr_1', 'uploads/u/upl_1', 'image/jpeg', 8, ?)`).run(now)
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? init.body : undefined
      calls.push({ url: String(url), method, body })
      if (method === 'POST' && String(url).includes('/v1/aimov/jobs') && !String(url).includes('/v1/aimov/jobs/')) {
        return new Response(JSON.stringify({ id: 'gen_submit', status: 'queued' }), { status: 201 })
      }
      return new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404 })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function insert(id: string, patch: { status?: string; provider?: string; requestId?: string | null; meta?: Record<string, unknown>; createdAt?: string; updatedAt?: string; refunded?: number } = {}) {
    const now = new Date().toISOString()
    sqlite
      .prepare(
        `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider,
         provider_request_id, provider_meta, component_id, component_version, refunded, created_at, updated_at)
         VALUES (?, 'usr_1', 'new-york', 'short', 6, 6, 'upl_1', ?, ?, ?, ?, 'image-source-video', 1, ?, ?, ?)`,
      )
      .run(
        id,
        patch.status ?? 'queued',
        patch.provider ?? 'opengen',
        patch.requestId ?? null,
        patch.meta ? JSON.stringify(patch.meta) : null,
        patch.refunded ?? 0,
        patch.createdAt ?? now,
        patch.updatedAt ?? now,
      )
  }

  const row = (id: string) => sqlite.prepare('SELECT status, provider, provider_request_id, provider_meta, refunded FROM generations WHERE id = ?').get(id) as {
    status: string
    provider: string
    provider_request_id: string | null
    provider_meta: string | null
    refunded: number
  }

  it('提交正文不含组件 id；任务号写下后不再改人工', async () => {
    insert('gen_submit')
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_submit' })
    const posted = calls.find((call) => call.method === 'POST')
    const body = JSON.parse(posted?.body ?? '{}') as Record<string, unknown>
    expect(body).not.toHaveProperty('component_id')
    expect(body.generation_id).toBe('gen_submit')
    expect(row('gen_submit')).toMatchObject({ status: 'processing', provider: 'opengen', provider_request_id: 'gen_submit' })
    calls.length = 0
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404 }))
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_submit' })
    expect(row('gen_submit').provider).toBe('opengen')
    expect(row('gen_submit').provider_request_id).toBe('gen_submit')
    expect(row('gen_submit').status).not.toBe('queued')
  })

  it('提交结果不明：一次 404 冻结；间隔够了的第二次 404 才改同一行人工', async () => {
    insert('gen_unknown')
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
      if ((init?.method ?? 'GET') === 'POST') throw new Error('socket hang up')
      return new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404 })
    })
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_unknown' })
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    expect(row('gen_unknown').provider).toBe('opengen')
    expect(row('gen_unknown').provider_request_id).toBeNull()
    expect(row('gen_unknown').provider_meta).toContain('absent_unconfirmed')

    const meta = JSON.parse(row('gen_unknown').provider_meta!) as { absentAtMs: number[] }
    meta.absentAtMs = [Date.now() - RECONCILE_ABSENT_GAP_MS - 1000]
    sqlite.prepare(`UPDATE generations SET provider_meta = ? WHERE id = 'gen_unknown'`).run(JSON.stringify(meta))
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_unknown' })
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    expect(row('gen_unknown')).toMatchObject({ provider: 'manual', status: 'queued', provider_request_id: null })
    expect(row('gen_unknown').provider_meta).toContain('confirmed_absent')
  })

  it('查询失败不是确认没有任务；提交前被拒再加一次 404 才改人工', async () => {
    insert('gen_unclear', { status: 'processing', meta: { submitStarted: true, pendingReview: true, submitEvidence: 'unknown', fulfillment: 'opengen' } })
    vi.stubGlobal('fetch', async () => {
      throw new Error('timeout')
    })
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_unclear' })
    expect(row('gen_unclear').provider).toBe('opengen')
    expect(row('gen_unclear').provider_meta).toContain('lookup_unclear')

    insert('gen_rejected', { status: 'processing', meta: { submitStarted: true, pendingReview: true, submitEvidence: 'rejected_before_store', fulfillment: 'opengen' } })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404 }))
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_rejected' })
    expect(row('gen_rejected')).toMatchObject({ provider: 'manual', status: 'queued' })
    expect(row('gen_rejected').provider_meta).toContain('confirmed_absent')
  })

  it('维护对冻结中的 OpenGen 只排轮询；45 分钟只扫非人工单，迟到轮询不改终态也不再退', async () => {
    const stale = new Date(Date.now() - 10 * 60_000).toISOString()
    const aged = new Date(Date.now() - 50 * 60_000).toISOString()
    insert('gen_frozen', {
      status: 'processing',
      meta: { submitStarted: true, pendingReview: true, submitEvidence: 'unknown' },
      createdAt: stale,
      updatedAt: stale,
    })
    insert('gen_manual', { provider: 'manual', status: 'queued', createdAt: aged, updatedAt: aged })
    await runScheduledMaintenance(env)
    expect(sent).toEqual([{ kind: 'poll', generationId: 'gen_frozen' }])
    expect(row('gen_manual')).toMatchObject({ status: 'queued', provider: 'manual', refunded: 0 })
    expect(row('gen_frozen').provider).toBe('opengen')

    sent.length = 0
    insert('gen_old', { status: 'processing', meta: { pendingReview: true, submitStarted: true }, createdAt: aged, updatedAt: stale })
    await runScheduledMaintenance(env)
    expect(row('gen_old')).toMatchObject({ status: 'failed', provider: 'opengen', refunded: 1 })
    expect(row('gen_manual').status).toBe('queued')
    const credits = () => (sqlite.prepare('SELECT credits FROM users WHERE id = ?').get('usr_1') as { credits: number }).credits
    expect(credits()).toBe(6)
    vi.stubGlobal('fetch', async () => {
      throw new Error('late result must not be fetched')
    })
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_old' })
    expect(row('gen_old')).toMatchObject({ status: 'failed', refunded: 1, provider: 'opengen' })
    expect(credits()).toBe(6)
    expect(await failGeneration(env, 'gen_old', 'timeout', 'again')).toBe(false)
    expect(credits()).toBe(6)
  })
})

describe('Webhook 只是去轮询的信号', () => {
  let sqlite: DatabaseSync
  let env: Env
  let sent: unknown[]

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    migrate(sqlite)
    sent = []
    env = {
      APP_ENV: 'development',
      SITE_URL: origin,
      SESSION_SECRET: 's'.repeat(64),
      DB: d1Shim(sqlite),
      VIDEO_QUEUE: { send: async (message: unknown) => void sent.push(message) },
    } as unknown as Env
    const now = new Date().toISOString()
    sqlite.prepare(`INSERT INTO users (id, email, credits, created_at) VALUES ('usr_1', 'u@example.com', 0, ?)`).run(now)
  })

  function insert(id: string, status: string, refunded = 0) {
    const now = new Date().toISOString()
    sqlite
      .prepare(
        `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider, output_r2_key, refunded, created_at, updated_at)
         VALUES (?, 'usr_1', 'new-york', 'short', 6, 6, 'upl_1', ?, 'opengen', ?, ?, ?, ?)`,
      )
      .run(id, status, status === 'succeeded' ? 'outputs/usr_1/x.mp4' : null, refunded, now, now)
  }

  async function hook(id: string) {
    const job = await jobToken(env, id)
    return app.request(
      `${origin}/api/webhooks/opengen?gen=${id}&token=${encodeURIComponent(job)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'succeeded', output_url: 'https://evil.example/out.mp4' }) },
      env,
    )
  }

  it('处理中的回调不标成功；已成功的回调不再入队', async () => {
    insert('gen_live', 'processing')
    const live = await hook('gen_live')
    expect(live.status).toBe(200)
    expect(await live.json()).toEqual({ received: true })
    expect(sent).toEqual([{ kind: 'poll', generationId: 'gen_live' }])
    expect(sqlite.prepare(`SELECT status, output_r2_key FROM generations WHERE id = 'gen_live'`).get()).toEqual({ status: 'processing', output_r2_key: null })

    insert('gen_done', 'succeeded')
    const done = await hook('gen_done')
    expect(await done.json()).toEqual({ received: true, ignored: 'terminal' })
    expect(sent).toEqual([{ kind: 'poll', generationId: 'gen_live' }])
    expect(sqlite.prepare(`SELECT status, output_r2_key FROM generations WHERE id = 'gen_done'`).get()).toEqual({
      status: 'succeeded',
      output_r2_key: 'outputs/usr_1/x.mp4',
    })
  })
})

describe('Sheet 不是领取锁', () => {
  it('表头 generation_id 不是数据；重复行号从大到小', () => {
    const header = [...SHEET_COLUMNS]
    expect(duplicateRowIndexes([header, ['', '', '', '', 'succeeded', '', 'gen_1'], ['', '', '', '', 'queued', '', 'gen_1']], 'gen_1', 1)).toEqual([2])
    expect(duplicateRowIndexes([header], 'generation_id', 1)).toEqual([])
  })

  it('表里写成 succeeded 也不会改 D1 的人工单', async () => {
    const sqlite = new DatabaseSync(':memory:')
    migrate(sqlite)
    const now = new Date().toISOString()
    sqlite.prepare(`INSERT INTO users (id, email, credits, created_at) VALUES ('usr_1', 'u@example.com', 0, ?)`).run(now)
    sqlite
      .prepare(
        `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider, created_at, updated_at)
         VALUES ('gen_sheet', 'usr_1', 'new-york', 'short', 6, 6, 'upl_1', 'queued', 'manual', ?, ?)`,
      )
      .run(now, now)
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign'])
    const pemBody = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))))
    const pem = `-----BEGIN PRIVATE KEY-----\n${pemBody.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`
    const env = {
      SITE_URL: 'https://example.test',
      SESSION_SECRET: 's'.repeat(64),
      DB: d1Shim(sqlite),
      GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet',
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'svc@example.iam.gserviceaccount.com',
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: pem,
    } as unknown as Env
    const values = [
      [...SHEET_COLUMNS],
      [now, 'u@example.com', 'new-york', 'https://example.test/a', 'succeeded', 'https://evil.example/v.mp4', 'gen_sheet'],
      [now, 'u@example.com', 'new-york', 'https://example.test/a', 'succeeded', 'https://evil.example/v.mp4', 'gen_sheet'],
    ]
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'ya29.test' })
      if (target.includes(':batchUpdate') || (init?.method ?? 'GET') === 'PUT') return Response.json({})
      if (target.includes('fields=sheets.properties')) return Response.json({ sheets: [{ properties: { sheetId: 0 } }] })
      return Response.json({ range: 'Sheet1!A1:G3', values })
    })
    expect(await syncManualSheet(env, 'gen_sheet')).toBe(true)
    expect(sqlite.prepare('SELECT status, provider, provider_request_id FROM generations WHERE id = ?').get('gen_sheet')).toEqual({
      status: 'queued',
      provider: 'manual',
      provider_request_id: null,
    })
    vi.unstubAllGlobals()
  })
})

describe('配置检查能区分未配置、不健康和未收口', () => {
  it('应急开关冲突是错误；厂商密钥在开关关闭时只提醒；隧道不是④', () => {
    const conflict = checkConfig(ready({ vars: { EMERGENCY_VIDEO_PROVIDER: 'fal' } }))
    expect(conflict.map((issue) => `${issue.level}:${issue.key}`)).toContain('error:EMERGENCY_VIDEO_PROVIDER')
    expect(conflict.find((issue) => issue.key === 'EMERGENCY_VIDEO_PROVIDER')?.message).toContain('不是未配置')

    const vendor = checkConfig(ready({ secrets: { FAL_KEY: 'fal_secret_value' } }))
    expect(vendor).toEqual([expect.objectContaining({ level: 'warn', key: 'FAL_KEY' })])
    expect(JSON.stringify(vendor)).not.toContain('fal_secret_value')

    const tunnel = checkConfig(ready({ vars: { OPENGEN_BASE_URL: 'https://demo.trycloudflare.com' } }))
    expect(tunnel.map((issue) => issue.key)).toContain('OPENGEN_BASE_URL')
    expect(tunnel.find((issue) => issue.key === 'OPENGEN_BASE_URL')?.message).toContain('不是④')
    expect(checkConfig(ready()).some((issue) => issue.message.includes('④已就绪'))).toBe(false)
  })

  it('探测：没配是未配置；401 是不健康；本机响应不是④', async () => {
    const missing = await runProbe({ APP_ENV: 'production', VIDEO_PROVIDER: 'opengen', EMERGENCY_VIDEO_PROVIDER: '' } as Env, 'video', admin)
    expect(missing.provider).toBe('opengen')
    expect(missing.message).toContain('未配置')

    vi.stubGlobal('fetch', async () => new Response('no', { status: 401 }))
    const denied = await runProbe(
      { APP_ENV: 'production', VIDEO_PROVIDER: 'fal', OPENGEN_BASE_URL: 'https://og.example', OPENGEN_API_KEY: 'ogsk_site_key', OPENGEN_STUB: '0' } as Env,
      'video',
      admin,
    )
    expect(denied.message).toContain('不健康')
    expect(denied.message).not.toContain('未配置')
    expect(denied.message).not.toContain('ogsk_site_key')

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const local = await runProbe(
      { APP_ENV: 'development', VIDEO_PROVIDER: 'opengen', OPENGEN_BASE_URL: 'http://127.0.0.1:8787', OPENGEN_API_KEY: 'ogsk_site_key', OPENGEN_STUB: '0' } as Env,
      'video',
      admin,
    )
    expect(local.status).toBe('warn')
    expect(local.message).toContain('不是④')
    expect(local.message).not.toContain('④已就绪')
    vi.unstubAllGlobals()
  })
})
