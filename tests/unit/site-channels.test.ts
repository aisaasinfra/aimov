import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '#/server/app'
import { describeAutoRoute } from '#/server/auto-route'
import { ledgerStatements } from '#/server/credits'
import { retryManualSheet } from '#/server/fulfillment'
import { handleVideoJob } from '#/server/jobs'
import { runProbe } from '#/server/probes'
import { parseSettingsPatch, settingFields } from '#/server/settings'
import { clearSheetsTokenCache } from '#/server/sheets'
import type { UserRow } from '#/server/types'
import { sha256Hex } from '#/server/util'
import { getVideoProvider, videoProviderOptions } from '#/server/video'
import { d1Shim, kvShim, migrate } from './d1-sqlite'

// 这些用例证明选路和所有权。fetch 是桩，不是对 Yir / FAL / OpenGen 的真机验收。

const origin = 'http://127.0.0.1:8787'
const token = 'sid-token'
const admin = { id: 'usr_admin', email: 'admin@example.com', role: 'admin' } as UserRow
const YIR_SECRET = 'yir_secret_key_value'
const FAL_SECRET = 'fal_secret_key_value'
const OG_SECRET = 'ogsk_site_secret_value'

const pemOf = (bytes: ArrayBuffer) => {
  const body = btoa(String.fromCharCode(...new Uint8Array(bytes)))
  const lines = body.match(/.{1,64}/g) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}

describe('站级渠道同级可选', () => {
  let sqlite: DatabaseSync
  let env: Env
  let sent: unknown[]
  let fetched: string[]

  beforeEach(async () => {
    clearSheetsTokenCache()
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    migrate(sqlite)
    sent = []
    fetched = []
    env = {
      APP_ENV: 'development',
      SITE_URL: origin,
      VIDEO_PROVIDER: 'opengen',
      EMERGENCY_VIDEO_PROVIDER: 'fal',
      OPENGEN_BASE_URL: 'https://og.example',
      OPENGEN_API_KEY: OG_SECRET,
      OPENGEN_STUB: '0',
      YIR_API_KEY: YIR_SECRET,
      FAL_KEY: FAL_SECRET,
      SESSION_SECRET: 's'.repeat(64),
      DB: d1Shim(sqlite),
      KV: kvShim(),
      VIDEO_QUEUE: { send: async (message: unknown) => void sent.push(message) },
      MEDIA: { async put() {}, async delete() {}, async get() { return null } },
    } as unknown as Env
    const now = '2026-10-29T00:00:00.000Z'
    sqlite.prepare(`INSERT INTO users (id, email, credits, role, locale, created_at) VALUES ('usr_1', 'u@example.com', 0, 'user', 'en', ?)`).run(now)
    sqlite.prepare(`INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, created_at) VALUES ('upl_1', 'usr_1', 'uploads/u/upl_1', 'image/jpeg', 8, ?)`).run(now)
    sqlite.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 'usr_1', '2099-01-01T00:00:00.000Z', ?)`).run(await sha256Hex(token), now)
    await env.DB.batch(ledgerStatements(env.DB, { userId: 'usr_1', delta: 40, reason: 'purchase', idempotencyKey: 'purchase:test' }) as unknown as D1PreparedStatement[])
    installFetch()
  })

  afterEach(() => {
    clearSheetsTokenCache()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const credits = () => (sqlite.prepare('SELECT credits FROM users WHERE id = ?').get('usr_1') as { credits: number }).credits
  const rows = () => sqlite.prepare('SELECT id, provider, status, provider_meta, provider_request_id, error_code, refunded FROM generations').all() as Array<Record<string, string | number | null>>

  function storeSetting(key: string, value: unknown) {
    sqlite.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, '2026-10-29') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value))
    ;(env.KV as unknown as { store: Map<string, string> }).store.delete('settings:v1')
  }

  function installFetch(handler?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    fetched = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      fetched.push(String(url))
      if (handler) return handler(String(url), init)
      return routeVendor(String(url))
    })
  }

  async function create() {
    return app.request(
      `${origin}/api/generations`,
      {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', cookie: `sid=${token}` },
        body: JSON.stringify({ uploadId: 'upl_1', durationId: 'short', templateId: 'new-york', locale: 'en' }),
      },
      env,
    )
  }

  it('验收01 人工轨仍扣一次积分；Sheet 失败可重试，不调用自动渠道', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign'])
    env.GOOGLE_SHEETS_SPREADSHEET_ID = 'sheet'
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com'
    env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = pemOf(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    installFetch(async () => {
      throw new Error('sheet down')
    })
    const res = await create()
    expect(res.status).toBe(201)
    expect(rows()[0]).toMatchObject({ provider: 'manual', status: 'queued' })
    expect(String(rows()[0]!.provider_meta)).toContain('sheets_auth_failed: token_unreachable')
    expect(credits()).toBe(34)
    expect(sent).toEqual([])
    expect(vendorHits(fetched)).toEqual([])
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM credit_ledger WHERE reason = 'generation'`).get()).toEqual({ n: 1 })

    const appended: string[] = []
    installFetch(async (url, init) => {
      if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'ya29.test' })
      if (url.includes(':append')) {
        appended.push(String(init?.body ?? ''))
        return Response.json({})
      }
      if (url.includes('sheets.googleapis.com')) return Response.json({ values: [] })
      throw new Error(`vendor call during sheet retry: ${url}`)
    })
    const id = String(rows()[0]!.id)
    await retryManualSheet(env, id)
    expect(appended.join('\n')).toContain(id)
    expect(String(rows()[0]!.provider_meta)).not.toContain('token_unreachable')
    expect(credits()).toBe(34)
    expect(vendorHits(fetched)).toEqual([])
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM credit_ledger WHERE reason = 'generation'`).get()).toEqual({ n: 1 })
  })

  it.each(['yir', 'fal', 'opengen'] as const)('验收02 选 %s 只打这一家，并在轮询里明确失败', async (provider) => {
    storeSetting('fulfillmentMode', 'auto')
    storeSetting('videoProvider', provider)
    const res = await create()
    expect(res.status).toBe(201)
    const row = rows()[0]!
    expect(row.provider).toBe(provider)
    if (provider === 'opengen') expect(fetched.every((url) => hostOf(url) === 'og.example')).toBe(true)
    else expect(fetched).toEqual([])
    expect(sent).toEqual([{ kind: 'submit', generationId: row.id }])

    fetched = []
    await handleVideoJob(env, { kind: 'submit', generationId: String(row.id) })
    await handleVideoJob(env, { kind: 'poll', generationId: String(row.id) })
    const done = rows()[0]!
    expect(done.provider).toBe(provider)
    expect(done.status).toBe('failed')
    expect(done.error_code).toBe(provider === 'yir' ? 'yir_failed' : provider === 'fal' ? 'fal_rejected' : 'og_failed')
    expect(hostsOf(fetched).every((host) => host === expectedHost(provider))).toBe(true)
    expect(hostsOf(fetched).some((host) => host !== expectedHost(provider))).toBe(false)
  })

  it('验收03 日常下拉是三选一；应急变量不挡保存和选路；nanoapi 适配器仍可执行', () => {
    expect(videoProviderOptions({ APP_ENV: 'production' }).map((option) => option.value)).toEqual(['yir', 'fal', 'opengen'])
    expect(videoProviderOptions({ APP_ENV: 'development' }).map((option) => option.value)).toEqual(['yir', 'fal', 'opengen', 'mock'])
    expect(videoProviderOptions({ APP_ENV: 'production' }).some((option) => option.value === 'nanoapi')).toBe(false)
    const help = settingFields({ APP_ENV: 'production' }).find((field) => field.key === 'videoProvider')?.help ?? ''
    expect(help).toContain('三选一')
    expect(help).toContain('同级可选')
    expect(help).not.toContain('应急开关')
    const production = { APP_ENV: 'production' }
    expect(parseSettingsPatch({ videoProvider: 'yir' }, production)).toEqual({ videoProvider: 'yir' })
    expect(parseSettingsPatch({ videoProvider: 'fal' }, production)).toEqual({ videoProvider: 'fal' })
    expect(parseSettingsPatch({ videoProvider: 'opengen' }, production)).toEqual({ videoProvider: 'opengen' })

    const routed = describeAutoRoute(
      {
        APP_ENV: 'production',
        VIDEO_PROVIDER: 'opengen',
        EMERGENCY_VIDEO_PROVIDER: 'fal',
        OPENGEN_BASE_URL: 'https://og.example',
        OPENGEN_API_KEY: OG_SECRET,
        OPENGEN_STUB: '0',
        FAL_KEY: FAL_SECRET,
        YIR_API_KEY: YIR_SECRET,
      } as Env,
      { videoProvider: 'yir' },
    )
    expect(routed).toMatchObject({ ok: true, provider: 'yir', fulfillment: 'yir' })
    expect(JSON.stringify(routed)).not.toContain('emergency_switch_conflict')
    expect(getVideoProvider({ NANOAPI_API_KEY: 'nano_key_abcdefgh' } as Env, 'nanoapi').id).toBe('nanoapi')
  })

  it('验收04 切渠道不改在途单，也不对同一单双扣或双提交', async () => {
    storeSetting('fulfillmentMode', 'auto')
    storeSetting('videoProvider', 'yir')
    expect((await create()).status).toBe(201)
    const firstId = String(rows()[0]!.id)
    expect(rows()[0]!.provider).toBe('yir')

    storeSetting('videoProvider', 'opengen')
    env.VIDEO_PROVIDER = 'opengen'
    expect((await create()).status).toBe(201)
    const again = rows()
    expect(again.find((row) => row.id === firstId)).toMatchObject({ provider: 'yir' })
    expect(again.find((row) => row.id !== firstId)).toMatchObject({ provider: 'opengen' })
    expect(credits()).toBe(28)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM credit_ledger WHERE reason = 'generation'`).get()).toEqual({ n: 2 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM credit_ledger WHERE reason = 'generation' AND ref_id = ?`).get(firstId)).toEqual({ n: 1 })

    fetched = []
    await handleVideoJob(env, { kind: 'submit', generationId: firstId })
    expect(hostsOf(fetched)).toEqual(['gateway.yir.ai'])
    expect(rows().find((row) => row.id === firstId)!.provider).toBe('yir')

    const manualNow = '2026-10-29T00:00:01.000Z'
    sqlite.prepare(
      `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider, created_at, updated_at)
       VALUES ('gen_manual', 'usr_1', 'new-york', 'short', 6, 6, 'upl_1', 'queued', 'manual', ?, ?)`,
    ).run(manualNow, manualNow)
    fetched = []
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_manual' })
    expect(fetched).toEqual([])
    expect(sqlite.prepare(`SELECT status, provider FROM generations WHERE id = 'gen_manual'`).get()).toEqual({ status: 'queued', provider: 'manual' })

    let posts = 0
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    installFetch(async (url) => {
      if (url.includes('/videos/generations')) {
        posts += 1
        if (posts === 1) await hold
        return Response.json({ id: 'yir_once' })
      }
      throw new Error(`second provider during dual submit: ${url}`)
    })
    sqlite.prepare(`UPDATE generations SET status = 'queued', provider_request_id = NULL WHERE id = ?`).run(firstId)
    const pending = Promise.all([
      handleVideoJob(env, { kind: 'submit', generationId: firstId }),
      handleVideoJob(env, { kind: 'submit', generationId: firstId }),
    ])
    for (let i = 0; i < 40 && posts === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(posts).toBe(1)
    release()
    await pending
    expect(posts).toBe(1)
    expect(hostsOf(fetched).every((host) => host === 'gateway.yir.ai')).toBe(true)
  })

  it.each([
    ['yir', 'YIR_API_KEY'],
    ['fal', 'FAL_KEY'],
    ['opengen-url', 'OPENGEN_BASE_URL'],
    ['opengen-key', 'OPENGEN_API_KEY'],
  ] as const)('验收05 缺 %s（%s）时在扣积分前拒绝，文案含未配置', async (kind, secretName) => {
    sqlite.prepare(`UPDATE users SET role = 'admin' WHERE id = 'usr_1'`).run()
    storeSetting('fulfillmentMode', 'auto')
    if (kind === 'yir') {
      storeSetting('videoProvider', 'yir')
      env.YIR_API_KEY = ''
    } else if (kind === 'fal') {
      storeSetting('videoProvider', 'fal')
      env.FAL_KEY = ''
    } else if (kind === 'opengen-url') {
      storeSetting('videoProvider', 'opengen')
      env.OPENGEN_BASE_URL = ''
    } else {
      storeSetting('videoProvider', 'opengen')
      env.OPENGEN_API_KEY = ''
    }
    const route = describeAutoRoute(env, { videoProvider: kind.startsWith('opengen') ? 'opengen' : kind })
    expect(route.ok).toBe(false)
    if (!route.ok) {
      expect(route.message).toContain('未配置')
      expect(route.message).toContain(secretName)
    }
    const res = await create()
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; message?: string }
    expect(body.error).toBe('provider_not_configured')
    expect(body.message).toContain('未配置')
    expect(credits()).toBe(40)
    expect(rows()).toEqual([])
    expect(sent).toEqual([])
    expect(vendorHits(fetched)).toEqual([])
  })

  it('验收05 选 OpenGen 时不要求站上有 FAL 或 Yir 密钥', async () => {
    storeSetting('fulfillmentMode', 'auto')
    storeSetting('videoProvider', 'opengen')
    env.FAL_KEY = ''
    env.YIR_API_KEY = ''
    const res = await create()
    expect(res.status).toBe(201)
    expect(rows()[0]).toMatchObject({ provider: 'opengen' })
    expect(sent).toEqual([{ kind: 'submit', generationId: rows()[0]!.id }])
    expect(credits()).toBe(34)
    expect(hostsOf(fetched).every((host) => host === 'og.example')).toBe(true)
    expect(fetched.some((url) => url.includes('fal.ai') || url.includes('gateway.yir.ai'))).toBe(false)
  })

  it('验收06 探测区分已配置成功、已配置失败和未配置，且不回显密钥', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '))
    })
    const cases = [
      { provider: 'yir', secret: YIR_SECRET, env: { VIDEO_PROVIDER: 'yir', YIR_API_KEY: YIR_SECRET, APP_ENV: 'production' } },
      { provider: 'fal', secret: FAL_SECRET, env: { VIDEO_PROVIDER: 'fal', FAL_KEY: FAL_SECRET, APP_ENV: 'production' } },
      {
        provider: 'opengen',
        secret: OG_SECRET,
        env: { VIDEO_PROVIDER: 'opengen', OPENGEN_BASE_URL: 'https://og.example', OPENGEN_API_KEY: OG_SECRET, OPENGEN_STUB: '0', APP_ENV: 'production' },
      },
    ] as const
    for (const item of cases) {
      installFetch(async (url) => {
        if (url.includes(item.secret)) throw new Error(`url leaked ${item.secret}`)
        return routeVendor(url)
      })
      const okResult = await runProbe(item.env as unknown as Env, 'video', admin)
      expect(okResult.provider).toBe(item.provider)
      expect(okResult.message).toContain('已配置成功')
      expect(okResult.message).not.toContain('未配置')
      expect(okResult.message).not.toContain(item.secret)

      installFetch(async () => new Response('no', { status: 401 }))
      const denied = await runProbe(item.env as unknown as Env, 'video', admin)
      expect(denied.provider).toBe(item.provider)
      expect(denied.status).toBe('fail')
      expect(denied.message).toContain('已配置失败')
      expect(denied.message).not.toContain('未配置')
      expect(denied.message).not.toContain(item.secret)

      const missingEnv = { ...item.env, YIR_API_KEY: '', FAL_KEY: '', OPENGEN_API_KEY: '', OPENGEN_BASE_URL: '' }
      const missing = await runProbe(missingEnv as unknown as Env, 'video', admin)
      expect(missing.provider).toBe(item.provider)
      expect(missing.status).toBe('fail')
      expect(missing.message).toContain('未配置')
      expect(missing.message).not.toContain('已配置失败')
      expect(missing.message).not.toContain(item.secret)
    }
    installFetch(async () => {
      throw new Error(`connect failed for Key ${FAL_SECRET}`)
    })
    const thrown = await runProbe({ VIDEO_PROVIDER: 'fal', FAL_KEY: FAL_SECRET, APP_ENV: 'production' } as Env, 'video', admin)
    expect(thrown.message).toContain('已配置失败')
    expect(thrown.message).not.toContain(FAL_SECRET)
    expect(thrown.message).toContain('***')
    expect(logs.join('\n')).not.toContain(YIR_SECRET)
    expect(logs.join('\n')).not.toContain(FAL_SECRET)
    expect(logs.join('\n')).not.toContain(OG_SECRET)
  })

  it('验收07 文档把三选一写成现行规则，并保留人工轨与 nanoapi 待确认', () => {
    const files = ['docs/opengen.md', 'docs/env.md', 'CHANGELOG.md', 'README.md', 'README.zh-CN.md', 'ROADMAP.md']
    const text = files.map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(text).not.toContain('不是目标态')
    expect(text).not.toContain('失败关闭')
    expect(text).not.toContain('同级并行')
    expect(text).toContain('三选一')
    expect(text).toContain('待确认')
    expect(text).toContain('不是本站三选一的前置')
    expect(text).toContain('manual')
    expect(text).toContain('同级可选')
  })
})

function vendorHits(urls: string[]) {
  return urls.filter((url) => /gateway\.yir\.ai|fal\.ai|queue\.fal\.run|og\.example/.test(url))
}

function hostOf(url: string) {
  return new URL(url).host
}

function hostsOf(urls: string[]) {
  return urls.map(hostOf)
}

function expectedHost(provider: 'yir' | 'fal' | 'opengen') {
  if (provider === 'yir') return 'gateway.yir.ai'
  if (provider === 'fal') return 'queue.fal.run'
  return 'og.example'
}

function routeVendor(url: string): Response {
  if (url.includes('/v1/aimov/health')) return Response.json({ ok: true })
  if (url.includes('/v1/aimov/jobs/')) return Response.json({ id: 'og_1', status: 'failed', error: { code: 'og_failed', message: 'nope', retryable: false } })
  if (url.includes('/v1/aimov/jobs')) return Response.json({ id: 'og_1', status: 'queued' })
  if (url.includes('/videos/generations')) return Response.json({ id: 'yir_1' })
  if (url.includes('/jobs/') && url.includes('status')) return Response.json({ status: 'failed', error: { code: 'yir_failed', message: 'nope', retryable: false } })
  if (url.includes('gateway.yir.ai/v1/balance')) return Response.json({ available_amount: 20, currency: 'USD' })
  if (url.includes('/status')) return Response.json({ status: 'COMPLETED', error: 'rejected', error_type: 'fal_rejected' })
  if (url.includes('queue.fal.run/')) {
    return Response.json({
      request_id: 'fal_1',
      status_url: 'https://queue.fal.run/fal-ai/wan/requests/fal_1/status',
      response_url: 'https://queue.fal.run/fal-ai/wan/requests/fal_1',
    })
  }
  if (url.includes('api.fal.ai/')) return Response.json({ credits: { current_balance: 42.5, currency: 'USD' } })
  throw new Error(`unexpected fetch ${url}`)
}
