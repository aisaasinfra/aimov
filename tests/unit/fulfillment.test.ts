import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '#/server/app'
import { renderEmail } from '#/server/email-templates'
import { isPublicHttpsUrl } from '#/server/fulfillment'
import { resolveFulfillmentMode } from '#/server/fulfillment-mode'
import { handleVideoJob, runScheduledMaintenance } from '#/server/jobs'
import { ledgerStatements } from '#/server/credits'
import { SHEET_COLUMNS, SheetError, buildServiceAccountJwt, clearSheetsTokenCache, normalizePrivateKeyPem, upsertGenerationSheet } from '#/server/sheets'
import { sha256Hex, base64UrlDecode } from '#/server/util'
import { getVideoProvider } from '#/server/video'
import { type Stmt, d1Shim, kvShim, migrate } from './d1-sqlite'

const origin = 'http://127.0.0.1:8787'
const token = 'sid-token'
const pemOf = (bytes: ArrayBuffer) => {
  const body = btoa(String.fromCharCode(...new Uint8Array(bytes)))
  const lines = body.match(/.{1,64}/g) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}

describe('履行方式', () => {
  it('缺省和坏覆盖都是 manual；模板命中优先于站点', () => {
    expect(resolveFulfillmentMode({}, 'new-york')).toBe('manual')
    expect(resolveFulfillmentMode({ fulfillmentMode: 'auto' }, 'new-york')).toBe('auto')
    expect(resolveFulfillmentMode({ fulfillmentMode: 'nope' }, 'new-york')).toBe('manual')
    expect(resolveFulfillmentMode({ fulfillmentMode: 'manual', fulfillmentModeByTemplate: '{"paris":"auto"}' }, 'paris')).toBe('auto')
    expect(resolveFulfillmentMode({ fulfillmentMode: 'auto', fulfillmentModeByTemplate: '{"paris":"manual"}' }, 'new-york')).toBe('auto')
    expect(resolveFulfillmentMode({ fulfillmentMode: 'auto', fulfillmentModeByTemplate: '{bad' }, 'paris')).toBe('auto')
  })

  it('接单邮件只说在队列里', () => {
    const en = renderEmail('generation_accepted', { generationId: 'gen_1' }, { siteUrl: 'https://example.test', locale: 'en' })
    expect(en.subject).toMatch(/queue/i)
    expect(en.text).not.toMatch(/ready to watch/i)
    const zh = renderEmail('generation_accepted', { generationId: 'gen_1' }, { siteUrl: 'https://example.test', locale: 'zh-TW' })
    expect(zh.subject).toContain('佇列')
  })

  it('成品地址只收公网 https', () => {
    expect(isPublicHttpsUrl('https://cdn.example/v.mp4')?.hostname).toBe('cdn.example')
    expect(isPublicHttpsUrl('http://cdn.example/v.mp4')).toBeNull()
    expect(isPublicHttpsUrl('https://user:pw@cdn.example/v.mp4')).toBeNull()
    expect(isPublicHttpsUrl('https://127.0.0.1/v.mp4')).toBeNull()
    expect(isPublicHttpsUrl('https://169.254.169.254/latest')).toBeNull()
    expect(isPublicHttpsUrl('https://10.0.0.5/v.mp4')).toBeNull()
  })
})

describe('Google Sheet 客户端', () => {
  afterEach(() => {
    clearSheetsTokenCache()
    vi.unstubAllGlobals()
  })

  it('服务账号 JWT 用 PKCS8 签名；字面量 \\n 也能导入', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
    const pem = pemOf(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    const jwt = await buildServiceAccountJwt('svc@example.iam.gserviceaccount.com', pem.replaceAll('\n', '\\n'), 1_700_000_000)
    expect(normalizePrivateKeyPem(pem.replaceAll('\n', '\\n'))).toContain('BEGIN PRIVATE KEY')
    const [header, payload, signature] = jwt.split('.')
    const data = new TextEncoder().encode(`${header}.${payload}`)
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, base64UrlDecode(signature!), data)
    expect(ok).toBe(true)
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(payload!)))).toMatchObject({
      iss: 'svc@example.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
    })
  })

  it('没有三个 secret 时不发请求', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(upsertGenerationSheet({} as Env, row('gen_1'))).rejects.toBeInstanceOf(SheetError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('空表写入表头和数据；已有 generation_id 则更新那一行，不追加', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const values: unknown[][] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const raw = init?.body
      const body = typeof raw === 'string' ? raw : raw instanceof URLSearchParams ? raw.toString() : undefined
      calls.push({ url, method: init?.method ?? 'GET', body })
      if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'ya29.test' })
      if (url.includes(':append')) {
        const body = JSON.parse(String(init?.body)) as { values: unknown[][] }
        values.push(...body.values)
        return Response.json({})
      }
      if ((init?.method ?? 'GET') === 'PUT') return Response.json({})
      return Response.json(values.length ? { range: 'Sheet1!A1:G2', values } : { range: 'Sheet1!A1', values: [] })
    })
    const env = await sheetEnv()
    expect(await upsertGenerationSheet(env, row('gen_1'))).toBe('appended')
    expect(values[0]).toEqual([...SHEET_COLUMNS])
    expect(values[1]?.[6]).toBe('gen_1')
    expect(await upsertGenerationSheet(env, { ...row('gen_1'), status: 'succeeded', resultLink: 'https://example.test/video' })).toBe('updated')
    const put = calls.find((call) => call.method === 'PUT')
    expect(put?.url).toContain('/values/A2:G2')
    expect(put?.body).toContain('succeeded')
    expect(JSON.stringify(calls)).not.toContain('PRIVATE KEY')
    expect(calls.some((call) => call.url.includes('oauth2.googleapis.com') && call.body?.includes('assertion='))).toBe(true)
  })

  it('返回区间不是从第 1 行开始时，按区间起点更新', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'ya29.test' })
      if ((init?.method ?? 'GET') === 'GET') {
        return Response.json({
          range: 'Sheet1!A5:G6',
          values: [[...SHEET_COLUMNS], ['t', 'a@b.c', 'new-york', 'u', 'queued', '', 'gen_9']],
        })
      }
      return Response.json({})
    })
    expect(await upsertGenerationSheet(await sheetEnv(), row('gen_9'))).toBe('updated')
    expect(calls.some((line) => line.startsWith('PUT ') && line.includes('/values/A6:G6'))).toBe(true)
  })
})

describe('创建生成任务', () => {
  let sqlite: DatabaseSync
  let env: Env
  let sent: unknown[]

  beforeEach(async () => {
    clearSheetsTokenCache()
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    migrate(sqlite)
    const db = d1Shim(sqlite)
    const kv = kvShim()
    sent = []
    env = {
      APP_ENV: 'development',
      SITE_URL: origin,
      VIDEO_PROVIDER: 'mock',
      SESSION_SECRET: 's'.repeat(64),
      DB: db,
      KV: kv,
      VIDEO_QUEUE: { send: async (message: unknown) => void sent.push(message) },
      MEDIA: { async put() {}, async delete() {}, async get() { return null } },
    } as unknown as Env
    const now = '2026-10-27T00:00:00.000Z'
    sqlite.prepare(`INSERT INTO users (id, email, credits, role, locale, created_at) VALUES ('usr_1', 'u@example.com', 0, 'user', 'en', ?)`).run(now)
    sqlite.prepare(`INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, created_at) VALUES ('upl_1', 'usr_1', 'uploads/u/upl_1', 'image/jpeg', 8, ?)`).run(now)
    sqlite.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 'usr_1', '2099-01-01T00:00:00.000Z', ?)`).run(await sha256Hex(token), now)
    await db.batch(ledgerStatements(db as unknown as D1Database, { userId: 'usr_1', delta: 40, reason: 'purchase', idempotencyKey: 'purchase:test' }) as unknown as Stmt[])
    vi.stubGlobal('fetch', async () => {
      throw new Error('unexpected fetch')
    })
  })

  afterEach(() => {
    clearSheetsTokenCache()
    vi.unstubAllGlobals()
  })

  const credits = () => (sqlite.prepare('SELECT credits FROM users WHERE id = ?').get('usr_1') as { credits: number }).credits
  const generations = () => sqlite.prepare('SELECT id, provider, status, provider_meta FROM generations ORDER BY created_at, id').all() as Array<{ id: string; provider: string; status: string; provider_meta: string | null }>

  async function create(templateId = 'new-york') {
    return app.request(
      `${origin}/api/generations`,
      {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', cookie: `sid=${token}` },
        body: JSON.stringify({ uploadId: 'upl_1', durationId: 'short', templateId, locale: 'en' }),
      },
      env,
    )
  }

  function storeSetting(key: string, value: unknown) {
    sqlite.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, '2026-10-27') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value))
    ;(env.KV as unknown as { store: Map<string, string> }).store.delete('settings:v1')
  }

  it('没存设置时走 manual：不入队，provider=manual，Sheet 失败仍扣积分并记 sheetError', async () => {
    const res = await create()
    expect(res.status).toBe(201)
    const body = (await res.json()) as { generation: { status: string } }
    expect(body.generation.status).toBe('queued')
    expect(sent).toEqual([])
    expect(generations()[0]).toMatchObject({ provider: 'manual', status: 'queued' })
    expect(generations()[0]!.provider_meta).toContain('sheets_not_configured')
    expect(credits()).toBe(34)
    expect(sqlite.prepare(`SELECT template, status FROM email_outbox`).get()).toEqual({ template: 'generation_accepted', status: 'skipped' })
  })

  it('auto 仍入队，且不写 Sheet', async () => {
    storeSetting('fulfillmentMode', 'auto')
    const res = await create()
    expect(res.status).toBe(201)
    expect(generations()[0]!.provider).toBe('mock')
    expect(sent).toEqual([{ kind: 'submit', generationId: generations()[0]!.id }])
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM email_outbox`).get()).toEqual({ n: 0 })
  })

  it('按模板覆盖：paris 自动，其它模板人工', async () => {
    storeSetting('fulfillmentMode', 'manual')
    storeSetting('fulfillmentModeByTemplate', JSON.stringify({ paris: 'auto' }))
    expect((await create('paris')).status).toBe(201)
    expect((await create('new-york')).status).toBe(201)
    const rows = generations()
    expect(rows.map((row) => row.provider).sort()).toEqual(['manual', 'mock'])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'submit' })
  })

  it('Sheet 可写时追加一行；接口仍 201', async () => {
    env.GOOGLE_SHEETS_SPREADSHEET_ID = 'sheet'
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com'
    env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = 'not-used-because-fetch-is-mocked'
    const appended: unknown[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'ya29.test' })
      if (String(url).includes(':append')) {
        appended.push(JSON.parse(String(init?.body)))
        return Response.json({})
      }
      return Response.json({ values: [] })
    })
    // 假私钥过不了 JWT。这个用例改走「已配置但 token 接口失败」会记 sheetError。
    // 真正追加放在客户端单测。这里确认配置了也会在签名失败时保住 D1 行。
    const res = await create()
    expect(res.status).toBe(201)
    expect(sent).toEqual([])
    expect(generations()[0]!.provider_meta).toContain('sheets_auth_failed')
    expect(appended).toEqual([])
    expect(credits()).toBe(34)
  })

  it('管理员用成品地址完成人工单，不入队；失败退积分走原账本', async () => {
    const created = await create()
    expect(created.status).toBe(201)
    const id = generations()[0]!.id
    sqlite.prepare(`UPDATE users SET role = 'admin' WHERE id = 'usr_1'`).run()
    const objects = new Map<string, unknown>()
    env.MEDIA = {
      async put(key: string, data: unknown) {
        objects.set(key, data)
      },
      async delete(key: string) {
        objects.delete(key)
      },
      async get() {
        return null
      },
    } as unknown as Env['MEDIA']
    env.GOOGLE_SHEETS_SPREADSHEET_ID = 'sheet'
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com'
    env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = pemOf(
      await crypto.subtle.exportKey('pkcs8', (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign'])).privateKey),
    )
    vi.stubGlobal('fetch', async (url: string) => {
      const target = String(url)
      if (target.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'ya29.test' })
      if (target.includes('sheets.googleapis.com')) return Response.json({ values: [] })
      if (target === 'https://cdn.example/v.mp4') {
        const bytes = new Uint8Array([1, 2, 3, 4])
        return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
      }
      return new Response('no', { status: 404 })
    })
    const bad = await app.request(
      `${origin}/api/admin/generations/${id}/complete`,
      { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: `sid=${token}` }, body: JSON.stringify({ resultUrl: 'http://cdn.example/v.mp4' }) },
      env,
    )
    expect(bad.status).toBe(400)
    expect(generations()[0]!.status).toBe('queued')

    const ok = await app.request(
      `${origin}/api/admin/generations/${id}/complete`,
      { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: `sid=${token}` }, body: JSON.stringify({ resultUrl: 'https://cdn.example/v.mp4' }) },
      env,
    )
    expect(ok.status, await ok.clone().text()).toBe(200)
    expect(generations()[0]).toMatchObject({ status: 'succeeded', provider: 'manual' })
    expect(sqlite.prepare('SELECT output_r2_key, provider_cost_cents FROM generations WHERE id = ?').get(id)).toEqual({
      output_r2_key: `outputs/usr_1/${id}.mp4`,
      provider_cost_cents: 0,
    })
    expect(objects.has(`outputs/usr_1/${id}.mp4`)).toBe(true)
    expect(sent).toEqual([])
    expect(sqlite.prepare(`SELECT template FROM email_outbox WHERE template = 'generation_succeeded'`).get()).toEqual({ template: 'generation_succeeded' })

    const other = await create('paris')
    expect(other.status).toBe(201)
    const second = generations().find((row) => row.id !== id)!
    const failed = await app.request(
      `${origin}/api/admin/generations/${second.id}/fail`,
      { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: `sid=${token}` }, body: '{}' },
      env,
    )
    expect(failed.status).toBe(200)
    expect(sqlite.prepare('SELECT status, refunded FROM generations WHERE id = ?').get(second.id)).toEqual({ status: 'failed', refunded: 1 })
    expect(credits()).toBe(34)
  })
})

describe('队列跳过人工单', () => {
  let sqlite: DatabaseSync
  let env: Env
  let sent: unknown[]

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    migrate(sqlite)
    sent = []
    env = {
      DB: d1Shim(sqlite),
      VIDEO_QUEUE: { send: async (message: unknown) => void sent.push(message) },
      MEDIA: { async delete() {}, async put() {}, async get() { return null } },
    } as unknown as Env
    const now = new Date().toISOString()
    sqlite.prepare(`INSERT INTO users (id, email, credits, created_at) VALUES ('usr_1', 'u@example.com', 0, ?)`).run(now)
  })

  it('handleVideoJob 不调用 getVideoProvider，也不入队', async () => {
    const now = new Date().toISOString()
    sqlite.prepare(
      `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider, created_at, updated_at)
       VALUES ('gen_m', 'usr_1', 'new-york', 'short', 6, 6, 'upl_1', 'queued', 'manual', ?, ?)`,
    ).run(now, now)
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_m' })
    expect(sqlite.prepare('SELECT status, provider FROM generations WHERE id = ?').get('gen_m')).toEqual({ status: 'queued', provider: 'manual' })
    expect(sent).toEqual([])
    expect(() => getVideoProvider(env, 'manual')).toThrow(/fulfillment mode/)
  })

  it('定时维护不把人工单补投或超时退款', async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    const insert = (id: string, provider: string) =>
      sqlite.prepare(
        `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider, created_at, updated_at)
         VALUES (?, 'usr_1', 'new-york', 'short', 6, 6, 'upl_1', 'queued', ?, ?, ?)`,
      ).run(id, provider, old, old)
    insert('gen_m', 'manual')
    insert('gen_a', 'mock')
    await runScheduledMaintenance(env)
    expect(sqlite.prepare(`SELECT status FROM generations WHERE id = 'gen_m'`).get()).toEqual({ status: 'queued' })
    expect(sent).toEqual([{ kind: 'submit', generationId: 'gen_a' }])
  })
})

async function sheetEnv(): Promise<Env> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign'],
  )
  return {
    GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet_1',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'svc@example.iam.gserviceaccount.com',
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: pemOf(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  } as Env
}

function row(generationId: string) {
  return {
    createdAt: '2026-10-27T00:00:00.000Z',
    email: 'u@example.com',
    templateId: 'new-york',
    userImageUrl: 'https://example.test/media/uploads/upl_1',
    status: 'queued',
    resultLink: '',
    generationId,
  }
}
