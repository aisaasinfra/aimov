import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { site } from '#/config/site'
import { resolveFulfillmentMode } from '#/server/fulfillment-mode'
import { DEFAULT_SETTINGS, assertCheckoutOpen, assertOpen, dailyCapGuard, generationsToday, getSettings, mergeSettings, parseSettingsPatch, settingFields, settingMatchesDefault, storedVideoProvider } from '#/server/settings'
import type { UserRow } from '#/server/types'
import { resolveEffectiveVideoProvider } from '#/server/video'
import { ApiError } from '#/server/util'
import { type Stmt, d1Shim, kvShim, migrate } from './d1-sqlite'

const invalid = (input: unknown) => {
  try {
    parseSettingsPatch(input)
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 400, code: 'invalid_setting' })
    return (error as ApiError).message
  }
  throw new Error('expected invalid_setting')
}

describe('后台提交的运营参数', () => {
  it('未知字段、类型不对、越界或超长都整体拒绝，并说明是哪一项', () => {
    expect(invalid({ signupBonusCredits: 10, FAL_KEY: 'x' })).toContain('FAL_KEY')
    expect(invalid({ signupBonusCredits: 1001 })).toContain('0–1000')
    expect(invalid({ signupBonusCredits: 1.5 })).toContain('注册赠送积分')
    expect(invalid({ signupBonusCredits: '10' })).toContain('注册赠送积分')
    expect(invalid({ generationDailyCap: -1 })).toContain('全站每日生成上限')
    expect(invalid({ maintenance: 'true' })).toContain('开或关')
    expect(invalid({ 'announcement.en': 'x'.repeat(201) })).toContain('200')
    expect(invalid({})).toBe('没有要保存的参数')
    expect(invalid([])).toBe('没有要保存的参数')
    expect(invalid(null)).toBe('没有要保存的参数')
  })

  it('公告压成一行纯文本；首尾和连续空白不算进长度', () => {
    expect(parseSettingsPatch({ 'announcement.zh-TW': '  新功能\n上线   了 ', maintenance: true })).toEqual({ 'announcement.zh-TW': '新功能 上线 了', maintenance: true })
    expect(parseSettingsPatch({ 'announcement.en': ` ${'x'.repeat(200)}\n\n` })).toEqual({ 'announcement.en': 'x'.repeat(200) })
  })

  it('视频渠道是枚举；production 和 staging 拒绝 mock', () => {
    expect(invalid({ videoProvider: 'kling' })).toContain('当前视频生成渠道')
    expect(parseSettingsPatch({ videoProvider: 'mock' })).toEqual({ videoProvider: 'mock' })
    expect(parseSettingsPatch({ videoProvider: 'opengen' }, { APP_ENV: 'production' })).toEqual({ videoProvider: 'opengen' })
    const rejected = (appEnv: string) => {
      try {
        parseSettingsPatch({ videoProvider: 'mock' }, { APP_ENV: appEnv })
      } catch (error) {
        expect(error).toMatchObject({ status: 400, code: 'invalid_setting' })
        return (error as ApiError).message
      }
      throw new Error('expected invalid_setting')
    }
    expect(rejected('production')).toContain('opengen')
    expect(rejected('production')).toContain('yir')
    expect(rejected('production')).toContain('fal')
    expect(rejected('staging')).toContain('opengen')
    expect(rejected('production')).not.toContain('mock')
    expect(parseSettingsPatch({ videoProvider: 'yir' }, { APP_ENV: 'production' })).toEqual({ videoProvider: 'yir' })
    expect(parseSettingsPatch({ videoProvider: 'fal' }, { APP_ENV: 'production' })).toEqual({ videoProvider: 'fal' })
    expect(invalid({ videoProvider: 'nanoapi' })).toContain('当前视频生成渠道')
    expect(invalid({ videoProvider: 'manual' })).toContain('当前视频生成渠道')
  })

  it('履行方式默认 manual；没有按模板分轨', () => {
    expect(DEFAULT_SETTINGS.fulfillmentMode).toBe('manual')
    expect(DEFAULT_SETTINGS).not.toHaveProperty('fulfillmentModeByTemplate')
    expect(parseSettingsPatch({ fulfillmentMode: 'auto' })).toEqual({ fulfillmentMode: 'auto' })
    expect(invalid({ fulfillmentMode: 'sheet' })).toContain('生成履行方式')
    expect(invalid({ fulfillmentModeByTemplate: '{"paris":"auto"}' })).toContain('未知参数')
    expect(mergeSettings({ fulfillmentMode: 'auto', fulfillmentModeByTemplate: '{"paris":"manual"}' })).toMatchObject({ fulfillmentMode: 'auto' })
    expect(mergeSettings({ fulfillmentMode: 'auto', fulfillmentModeByTemplate: '{"paris":"manual"}' })).not.toHaveProperty('fulfillmentModeByTemplate')
    expect(mergeSettings({}).fulfillmentMode).toBe('manual')
    expect(resolveFulfillmentMode(mergeSettings({}))).toBe('manual')
    expect(resolveFulfillmentMode(mergeSettings({ fulfillmentMode: 'auto' }))).toBe('auto')
    expect(settingFields().some((field) => field.key === 'fulfillmentMode' && field.kind === 'enum')).toBe(true)
    expect(settingFields().map((field) => field.key as string)).not.toContain('fulfillmentModeByTemplate')
    const base = { VIDEO_PROVIDER: 'fal' } as unknown as Env
    expect(settingMatchesDefault('fulfillmentMode', 'manual', base)).toBe(true)
    expect(settingMatchesDefault('fulfillmentMode', 'auto', base)).toBe(false)
  })

  it('邀请奖励的上限跟随 site.ts：site.ts 关闭邀请时只能是 0', () => {
    if (site.referralRewardCredits > 0) expect(parseSettingsPatch({ referralRewardCredits: 1000 })).toEqual({ referralRewardCredits: 1000 })
    else expect(invalid({ referralRewardCredits: 1 })).toContain('邀请奖励积分')
  })

  it('暂停收款可保存；通道开关只在两条都配齐时出现，但存值始终能合并', () => {
    expect(parseSettingsPatch({ checkoutPaused: true })).toEqual({ checkoutPaused: true })
    expect(invalid({ allowPaypal: false })).toContain('allowPaypal')
    const both = {
      APP_ENV: 'production',
      PAYMENT_PROVIDER: 'waffo',
      WAFFO_MERCHANT_ID: 'm',
      WAFFO_PRIVATE_KEY: 'k',
      PAYPAL_CLIENT_ID: 'id',
      PAYPAL_CLIENT_SECRET: 'secret',
    }
    const keys = settingFields(both).map((field) => field.key)
    expect(keys.indexOf('allowWaffo')).toBe(keys.indexOf('checkoutPaused') + 1)
    expect(keys).toContain('allowPaypal')
    expect(settingFields({ APP_ENV: 'production' }).some((field) => field.key === 'allowPaypal')).toBe(false)
    expect(parseSettingsPatch({ allowPaypal: false, allowWaffo: true }, both)).toEqual({ allowPaypal: false, allowWaffo: true })
    expect(mergeSettings({ allowPaypal: false, checkoutPaused: true })).toMatchObject({ allowPaypal: false, checkoutPaused: true, allowWaffo: true })
  })
})

describe('暂停收款', () => {
  const user = { role: 'user' } as UserRow
  const admin = { role: 'admin' } as UserRow

  it('非管理员 503 checkout_paused；管理员仍可下单；生成检查不看这个开关', () => {
    const paused = { ...DEFAULT_SETTINGS, checkoutPaused: true }
    expect(() => assertCheckoutOpen(paused, user)).toThrow(expect.objectContaining({ status: 503, code: 'checkout_paused' }))
    expect(() => assertCheckoutOpen(paused, admin)).not.toThrow()
    expect(() => assertOpen(paused, user)).not.toThrow()
    expect(() => assertCheckoutOpen({ ...DEFAULT_SETTINGS, maintenance: true }, user)).toThrow(expect.objectContaining({ status: 503, code: 'maintenance' }))
    expect(() => assertCheckoutOpen(DEFAULT_SETTINGS, user)).not.toThrow()
  })
})

describe('存值合并', () => {
  it('没有存值时取 site.ts 默认；非法、越界和已删除字段的存值丢弃', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.signupBonusCredits).toBe(site.signupBonusCredits)
    const merged = mergeSettings({ signupBonusCredits: 5000, signupBonusValidDays: 7, maintenance: 1, removedField: true, 'announcement.en': 'Hi' })
    expect(merged.signupBonusCredits).toBe(site.signupBonusCredits)
    expect(merged.signupBonusValidDays).toBe(7)
    expect(merged.maintenance).toBe(false)
    expect(merged['announcement.en']).toBe('Hi')
    expect(merged).not.toHaveProperty('removedField')
    expect(DEFAULT_SETTINGS).not.toHaveProperty('videoProvider')
    expect(mergeSettings({ videoProvider: 'opengen' })).not.toHaveProperty('videoProvider')
  })

  it('日常渠道默认跟随环境里的 fal；其它字段仍对照 site.ts', () => {
    const base = { VIDEO_PROVIDER: 'fal', APP_ENV: 'production' } as unknown as Env
    expect(settingMatchesDefault('videoProvider', 'fal', base)).toBe(true)
    expect(settingMatchesDefault('videoProvider', 'opengen', base)).toBe(false)
    expect(settingMatchesDefault('signupBonusCredits', site.signupBonusCredits, base)).toBe(true)
    expect(settingMatchesDefault('signupBonusCredits', site.signupBonusCredits + 1, base)).toBe(false)
  })
})

describe('读取与每日上限（SQLite）', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let kv: ReturnType<typeof kvShim>
  let seq = 0

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    migrate(sqlite)
    // 只测计数，不建用户
    sqlite.exec('PRAGMA foreign_keys = OFF')
    db = d1Shim(sqlite) as unknown as D1Database
    kv = kvShim()
  })

  const env = () => ({ DB: db, KV: kv }) as unknown as Env
  const store = (key: string, raw: string) => sqlite.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, '2026-01-01')`).run(key, raw)
  const generation = (createdAt: string) => {
    const id = `gen_${++seq}`
    return db
      .prepare(
        `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, provider, created_at, updated_at)
         VALUES (?, 'u', 't', 'd', 5, 1, 'up', 'mock', ?, ?)`,
      )
      .bind(id, createdAt, createdAt)
  }
  const run = (statements: D1PreparedStatement[]) => db.batch(statements as unknown as Stmt[] as unknown as D1PreparedStatement[])

  it('KV 未命中时读 D1 并写回缓存；缓存期内改 D1 不生效，清缓存后生效；坏 JSON 的行忽略', async () => {
    store('signupBonusCredits', '3')
    store('signupBonusValidDays', '{oops')
    expect((await getSettings(env())).signupBonusCredits).toBe(3)
    expect(JSON.parse(kv.store.get('settings:v1')!)).toEqual({ signupBonusCredits: 3 })

    sqlite.prepare(`UPDATE settings SET value = '9' WHERE key = 'signupBonusCredits'`).run()
    expect((await getSettings(env())).signupBonusCredits).toBe(3)
    kv.store.clear()
    const fresh = await getSettings(env())
    expect(fresh.signupBonusCredits).toBe(9)
    expect(fresh.signupBonusValidDays).toBe(site.signupBonusValidDays)
  })

  it('每日上限按 UTC 自然日计数；超出时整个 batch 回滚，昨天的不算', async () => {
    const now = '2026-10-21T23:59:00.000Z'
    await run([generation('2026-10-20T23:59:59.999Z')])
    await run([generation('2026-10-21T00:00:00.000Z')])
    expect(await generationsToday(db, now)).toBe(1)

    await run([generation(now), ...dailyCapGuard(db, 2, now)])
    expect(await generationsToday(db, now)).toBe(2)
    await expect(run([generation(now), ...dailyCapGuard(db, 2, now)])).rejects.toThrow(/CHECK constraint/)
    expect(await generationsToday(db, now)).toBe(2)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM credit_guard').get()).toEqual({ n: 0 })

    expect(dailyCapGuard(db, 0, now)).toEqual([])
    await run([generation(now)])
    expect(await generationsToday(db, now)).toBe(3)
  })

  it('日常覆盖保留 yir、fal、opengen；nanoapi 丢掉。production 里的 mock 也丢掉', async () => {
    store('videoProvider', JSON.stringify('yir'))
    const loaded = await getSettings({ ...env(), APP_ENV: 'development', VIDEO_PROVIDER: 'fal' })
    expect(loaded.videoProvider).toBe('yir')
    expect(storedVideoProvider({ videoProvider: 'yir' }, { APP_ENV: 'development' })).toBe('yir')
    expect(storedVideoProvider({ videoProvider: 'fal' }, { APP_ENV: 'production' })).toBe('fal')
    expect(storedVideoProvider({ videoProvider: 'nanoapi' }, { APP_ENV: 'development' })).toBeNull()

    sqlite.prepare(`UPDATE settings SET value = ? WHERE key = 'videoProvider'`).run(JSON.stringify('opengen'))
    kv.store.clear()
    const opengen = await getSettings({ ...env(), APP_ENV: 'development', VIDEO_PROVIDER: 'mock' })
    expect(opengen.videoProvider).toBe('opengen')

    sqlite.prepare(`UPDATE settings SET value = ? WHERE key = 'videoProvider'`).run(JSON.stringify('mock'))
    kv.store.clear()
    const dropped = await getSettings({ ...env(), APP_ENV: 'production', VIDEO_PROVIDER: 'fal' })
    expect(dropped.videoProvider).toBeNull()
    expect(storedVideoProvider({ videoProvider: 'mock' }, { APP_ENV: 'production' })).toBeNull()
    expect(resolveEffectiveVideoProvider({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal' } as unknown as Env, dropped)).toBe('fal')
  })
})
