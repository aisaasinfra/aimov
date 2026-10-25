import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '#/server/util'
import { addToWaitlist, clampWaitlistSource, csvCell, isValidEmail, joinWaitlist, normalizeEmail, waitlistCsv } from '#/server/waitlist'
import { d1Shim, migrate } from './d1-sqlite'

describe('等待列表校验', () => {
  it('邮箱小写并限制长度，来源不在名单里就记成 waitlist', () => {
    expect(normalizeEmail('  A@Example.COM ')).toBe('a@example.com')
    expect(isValidEmail('a@example.com')).toBe(true)
    expect(isValidEmail('not-an-email')).toBe(false)
    expect(isValidEmail(`${'a'.repeat(250)}@b.co`)).toBe(false)
    expect(clampWaitlistSource('pricing')).toBe('pricing')
    expect(clampWaitlistSource('footer')).toBe('footer')
    expect(clampWaitlistSource('https://evil.example')).toBe('waitlist')
    expect(clampWaitlistSource(1)).toBe('waitlist')
  })

  it('CSV 给公式前缀加撇号，并转义引号', () => {
    expect(csvCell('=cmd')).toBe("'=cmd")
    expect(csvCell('say "hi"\n')).toBe('"say ""hi""\n"')
    const csv = waitlistCsv([{ email: '+a@example.com', locale: 'zh', source: 'waitlist', created_at: '2026-10-25T00:00:00.000Z' }])
    expect(csv.startsWith('\uFEFFemail,locale,source,created_at\n')).toBe(true)
    expect(csv).toContain("'+a@example.com")
  })
})

describe('加入等待列表', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    migrate(sqlite)
    db = d1Shim(sqlite) as unknown as D1Database
  })

  it('邮箱不合法时不调用人机验证，也不写库', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const env = { DB: db, TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' } as Env
    await expect(joinWaitlist(env, { email: 'nope', locale: 'en', source: 'waitlist', turnstileToken: 'tok', remoteIp: '1.1.1.1' }, fetcher)).rejects.toMatchObject({
      code: 'invalid_email',
    })
    expect(fetcher).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM waitlist').get()).toEqual({ n: 0 })
  })

  it('同一邮箱只插入一次，不创建用户', async () => {
    const env = { DB: db } as Env
    const fetcher = vi.fn<typeof fetch>()
    expect(await joinWaitlist(env, { email: 'A@Example.com', locale: 'zh-TW', source: 'nope', turnstileToken: '', remoteIp: undefined }, fetcher)).toBe('added')
    expect(await joinWaitlist(env, { email: 'a@example.com', locale: 'en', source: 'pricing', turnstileToken: '', remoteIp: undefined }, fetcher)).toBe('already')
    expect(fetcher).not.toHaveBeenCalled()
    const row = sqlite.prepare('SELECT email, locale, source FROM waitlist').get() as { email: string; locale: string; source: string }
    expect(row).toEqual({ email: 'a@example.com', locale: 'zh-TW', source: 'waitlist' })
    expect(await joinWaitlist(env, { email: 'hans@example.com', locale: 'zh', source: 'waitlist', turnstileToken: '', remoteIp: undefined }, fetcher)).toBe('added')
    const hans = sqlite.prepare(`SELECT locale FROM waitlist WHERE email = 'hans@example.com'`).get() as { locale: string }
    expect(hans.locale).toBe('en')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 })
  })

  it('冲突时返回 already', async () => {
    expect(await addToWaitlist(db, { id: 'wl_1', email: 'a@example.com', locale: 'en', source: 'footer', createdAt: '2026-10-25T00:00:00.000Z' })).toBe('added')
    expect(await addToWaitlist(db, { id: 'wl_2', email: 'a@example.com', locale: 'zh', source: 'pricing', createdAt: '2026-10-25T01:00:00.000Z' })).toBe('already')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM waitlist').get()).toEqual({ n: 1 })
  })
})

describe('joinWaitlist 错误类型', () => {
  it('ApiError 带 invalid_email', async () => {
    try {
      await joinWaitlist({} as Env, { email: '', locale: 'en', source: 'waitlist', turnstileToken: '', remoteIp: undefined })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(400)
    }
  })
})
