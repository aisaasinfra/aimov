import type { Hono } from 'hono'
import { LOCALES, LOCALE_META, site, type Locale } from '#/config/site'
import { audit, readJson, requireAdmin } from './http'
import type { AppContext, UserRow } from './types'
import { ApiError, nowIso } from './util'
import { dualCheckoutConfigured } from './payments'
import { type FulfillmentMode } from './fulfillment-mode'
import { isDailyVideoProvider, parseVideoProviderId, videoProviderOptions } from './video'
import type { VideoProviderId } from './video/types'

// 后台运营参数：只放非敏感、不改代码就要能调的参数；密钥仍放 wrangler secrets，不进数据库。
// 存在 D1 的 settings 表，读取走 KV 缓存（cacheTtl 60 秒），保存后最多约 60 秒在各地生效。
// 没有存值、存值不合法或字段已删除时用 site.ts 的默认值；保存的值等于默认值时删掉那一行，以后改 site.ts 仍然生效。

export type RuntimeSettings = {
  maintenance: boolean
  checkoutPaused: boolean
  // 只在 Waffo 与 PayPal.cn 都配齐时生效，并且只过滤新订单。默认两条都开。
  allowWaffo: boolean
  allowPaypal: boolean
  signupBonusCredits: number
  signupBonusValidDays: number
  referralRewardCredits: number
  generationDailyCap: number
  // 未写入数据库时是 manual。auto 在 Yir / FAL / OpenGen 中三选一（选哪个走哪个）。全站一个值，没有按模板分轨。
  fulfillmentMode: FulfillmentMode
} & Record<`announcement.${Locale}`, string>

// videoProvider 不在 RuntimeSettings 里：它的默认值是当前 env.VIDEO_PROVIDER，不能写进静态 DEFAULT_SETTINGS。
export type LoadedSettings = RuntimeSettings & { videoProvider: VideoProviderId | null }

export type SettingKey = keyof RuntimeSettings | 'videoProvider'

type FieldBase = { key: SettingKey; label: string; help: string }
export type SettingField =
  | (FieldBase & { kind: 'bool' })
  | (FieldBase & { kind: 'int'; min: number; max: number })
  | (FieldBase & { kind: 'text'; maxLength: number; multiline?: boolean })
  | (FieldBase & { kind: 'enum'; options: readonly { value: string; label: string }[] })

const referralOn = site.referralRewardCredits > 0

const VIDEO_PROVIDER_HELP =
  'fulfillmentMode=auto 时，新工单在 Yir、FAL、OpenGen 中同级可选、三选一（选哪个走哪个）。development / preview 还可以选 mock。nanoapi 适配器仍在，但不在这个日常下拉里（是否并入待确认）。保存后约 60 秒只影响新工单；在途工单继续用创建时写入的 generations.provider，不改道、不二次扣积分。选 Yir 需要 YIR_API_KEY，选 FAL 需要 FAL_KEY，选 OpenGen 只需要 OPENGEN_BASE_URL 和本站 OPENGEN_API_KEY（ogsk_），不要求站上同时有另外两家的密钥。缺所选渠道时，新单在扣积分前拒绝，文案含「未配置」。EMERGENCY_VIDEO_PROVIDER 不再参与选路。'

export function settingFields(env: { APP_ENV?: string } = {}): SettingField[] {
  const fields: SettingField[] = [
    {
      key: 'videoProvider',
      kind: 'enum',
      label: '当前视频生成渠道',
      help: VIDEO_PROVIDER_HELP,
      options: videoProviderOptions(env),
    },
    ...SETTING_FIELDS,
  ]
  if (!dualCheckoutConfigured(env as Env)) return fields
  const pauseAt = fields.findIndex((field) => field.key === 'checkoutPaused')
  fields.splice(pauseAt + 1, 0, ...CHECKOUT_ALLOW_FIELDS)
  return fields
}

const FULFILLMENT_MODE_OPTIONS = [
  { value: 'manual', label: '人工队列（Google Sheet）' },
  { value: 'auto', label: '自动生成（Yir / FAL / OpenGen 三选一）' },
] as const

export const SETTING_FIELDS: readonly SettingField[] = [
  {
    key: 'fulfillmentMode',
    kind: 'enum',
    label: '生成履行方式',
    help: '全站一个开关，只影响新任务。manual：扣积分后进入人工队列，写 Google 表格镜像，不调用 Yir / FAL / OpenGen，不进 VIDEO_QUEUE。auto：在当前视频生成渠道里三选一，选哪个走哪个。不能自动的组件会在扣积分前拒绝，不会改成人工。没存过时默认 manual。不改变收款。',
    options: FULFILLMENT_MODE_OPTIONS,
  },
  {
    key: 'maintenance',
    kind: 'bool',
    label: '维护模式',
    help: '暂停新的生成和下单（返回 503），前台每页顶部显示维护提示。登录、查看、下载和支付回调照常；管理员不受限制，便于验证',
  },
  {
    key: 'checkoutPaused',
    kind: 'bool',
    label: '暂停收款',
    help: '只暂停新的下单：非管理员返回 503 checkout_paused。生成、登录、下载和已有订单的支付回调照常。管理员仍可下单验证。价格页上所有人都能看到暂停说明',
  },
  ...LOCALES.map(
    (locale): SettingField => ({
      key: `announcement.${locale}`,
      kind: 'text',
      maxLength: 200,
      label: `全站公告（${LOCALE_META[locale].name}）`,
      help: '显示在这个语言每个页面的顶部，纯文本，留空不显示',
    }),
  ),
  { key: 'signupBonusCredits', kind: 'int', min: 0, max: 1000, label: '注册赠送积分', help: '新用户注册时发放，0 = 不送。只影响之后注册的用户' },
  { key: 'signupBonusValidDays', kind: 'int', min: 0, max: 3650, label: '赠送积分有效期（天）', help: '0 = 永不过期' },
  {
    key: 'referralRewardCredits',
    kind: 'int',
    min: 0,
    max: referralOn ? 1000 : 0,
    label: '邀请奖励积分',
    help: referralOn
      ? '好友首单付款后给邀请人发的积分，0 = 暂停邀请（隐藏邀请卡片，链接不再绑定）'
      : 'site.ts 里 referralRewardCredits 为 0，邀请功能已关闭；在 site.ts 开启后才能在这里调整（隐私政策按 site.ts 生成）',
  },
  {
    key: 'generationDailyCap',
    kind: 'int',
    min: 0,
    max: 1_000_000,
    label: '全站每日生成上限',
    help: '每个 UTC 自然日最多创建多少个生成任务（失败退款的也算），0 = 不限。用来封顶服务商费用，超出返回 429',
  },
]

// 通道开关始终可存。后台只在 Waffo 和 PayPal.cn 都配齐时展示，避免单通道部署被误关。
export const CHECKOUT_ALLOW_FIELDS: readonly SettingField[] = [
  {
    key: 'allowWaffo',
    kind: 'bool',
    label: '新订单允许 Waffo',
    help: '关掉后新订单不能再选 Waffo。退款、查单和 webhook 仍按订单自己的支付商走。两条都关掉时新订单会失败',
  },
  {
    key: 'allowPaypal',
    kind: 'bool',
    label: '新订单允许 PayPal.cn',
    help: '关掉后新订单不能再选 PayPal。订阅本来就不走 PayPal。已有 PayPal 订单的退款和 webhook 不受影响',
  },
]

export const DEFAULT_SETTINGS: RuntimeSettings = {
  maintenance: false,
  checkoutPaused: false,
  allowWaffo: true,
  allowPaypal: true,
  ...(Object.fromEntries(LOCALES.map((locale) => [`announcement.${locale}`, ''])) as Record<`announcement.${Locale}`, string>),
  signupBonusCredits: site.signupBonusCredits,
  signupBonusValidDays: site.signupBonusValidDays,
  referralRewardCredits: site.referralRewardCredits,
  generationDailyCap: 0,
  fulfillmentMode: 'manual',
}

const CACHE_KEY = 'settings:v1'
const fieldOf = (key: string, env: { APP_ENV?: string }) => settingFields(env).find((f) => f.key === key)

function isValid(field: SettingField, value: unknown) {
  if (field.kind === 'bool') return typeof value === 'boolean'
  if (field.kind === 'int') return Number.isInteger(value) && (value as number) >= field.min && (value as number) <= field.max
  if (field.kind === 'enum') return typeof value === 'string' && field.options.some((option) => option.value === value)
  if (typeof value !== 'string' || value.length > field.maxLength) return false
  return true
}

// 存值等于这条渠道的环境变量默认时删覆盖行。其它字段仍对照静态 DEFAULT_SETTINGS。
// 后台显示的日常渠道。已保存的 yir / fal / opengen（非生产还有 mock）优先；否则用环境变量里的同名日常值。
// 环境变量不是日常渠道时，下拉先显示 OpenGen，但那不是已保存的覆盖，新单仍按 describeAutoRoute 拒绝，直到运营者保存一项。
export function displayedVideoProvider(env: { APP_ENV?: string; VIDEO_PROVIDER?: string }, stored: string | null): string {
  if (stored && isDailyVideoProvider(stored, env)) return stored
  const fromEnv = env.VIDEO_PROVIDER ?? ''
  if (isDailyVideoProvider(fromEnv, env)) return fromEnv
  return 'opengen'
}

export function settingMatchesDefault(key: string, value: unknown, env: Env) {
  if (key === 'videoProvider') {
    const fromEnv = env.VIDEO_PROVIDER ?? ''
    return isDailyVideoProvider(fromEnv, env) && value === fromEnv
  }
  return key in DEFAULT_SETTINGS && value === DEFAULT_SETTINGS[key as keyof RuntimeSettings]
}

// 合法的日常覆盖是 yir / fal / opengen，以及非 production 的 mock。nanoapi 不作为日常覆盖（适配器仍留给在途工单）。
export function storedVideoProvider(stored: Record<string, unknown>, env: { APP_ENV?: string }): VideoProviderId | null {
  const value = stored.videoProvider
  if (typeof value !== 'string' || !value || value === 'nanoapi') return null
  try {
    const parsed = parseVideoProviderId(value, env)
    return isDailyVideoProvider(parsed, env) ? parsed : null
  } catch {
    return null
  }
}

// 存值合并到默认值上：未知字段、类型或范围不对的值（例如 site.ts 收紧了范围）丢弃，用默认值
export function mergeSettings(stored: Record<string, unknown>): RuntimeSettings {
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const [key, value] of Object.entries(stored)) {
    // 渠道覆盖不进静态默认值，由 storedVideoProvider / resolveEffectiveVideoProvider 单独读
    const field = [...SETTING_FIELDS, ...CHECKOUT_ALLOW_FIELDS].find((item) => item.key === key)
    if (field && isValid(field, value)) merged[key] = value
  }
  return merged as RuntimeSettings
}

// 后台提交的修改：未知字段或值不合法时整体拒绝（400 invalid_setting，message 说明是哪一项）
export function parseSettingsPatch(input: unknown, env: { APP_ENV?: string } = {}): Partial<RuntimeSettings & { videoProvider: VideoProviderId }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'invalid_setting', '没有要保存的参数')
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) throw new ApiError(400, 'invalid_setting', '没有要保存的参数')
  const patch: Record<string, unknown> = {}
  for (const [key, raw] of entries) {
    const field = fieldOf(key, env)
    if (!field) throw new ApiError(400, 'invalid_setting', `未知参数：${key}`)
    // 公告只存一行纯文本
    const value = field.kind === 'text' && typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : raw
    if (!isValid(field, value)) {
      const rule =
        field.kind === 'int'
          ? `${field.min}–${field.max} 的整数`
          : field.kind === 'text'
            ? `不超过 ${field.maxLength} 个字符`
            : field.kind === 'enum'
              ? `以下之一：${field.options.map((option) => option.value).join('、')}`
              : '开或关'
      throw new ApiError(400, 'invalid_setting', `${field.label}：应为${rule}`)
    }
    patch[key] = value
  }
  return patch as Partial<RuntimeSettings & { videoProvider: VideoProviderId }>
}

async function loadStored(db: D1Database) {
  const rows = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
  const stored: Record<string, unknown> = {}
  for (const row of rows.results) {
    try {
      stored[row.key] = JSON.parse(row.value)
    } catch {
      console.warn(`[settings] ignoring malformed value for ${row.key}`)
    }
  }
  return stored
}

export async function getSettings(env: Env): Promise<LoadedSettings> {
  let stored = await env.KV.get<Record<string, unknown>>(CACHE_KEY, { type: 'json', cacheTtl: 60 })
  if (!stored) {
    stored = await loadStored(env.DB)
    await env.KV.put(CACHE_KEY, JSON.stringify(stored))
  }
  return { ...mergeSettings(stored), videoProvider: storedVideoProvider(stored, env) }
}

// 维护模式下拒绝新的生成和下单；管理员放行，便于维护期间验证
export function assertOpen(settings: RuntimeSettings, user: UserRow) {
  if (settings.maintenance && user.role !== 'admin') throw new ApiError(503, 'maintenance')
}

// 暂停收款只拒绝新的下单。生成继续走 assertOpen。管理员仍可下单验证。
export function assertCheckoutOpen(settings: RuntimeSettings, user: UserRow) {
  assertOpen(settings, user)
  if (settings.checkoutPaused && user.role !== 'admin') throw new ApiError(503, 'checkout_paused')
}

export const referralActive = (settings: RuntimeSettings) => settings.referralRewardCredits > 0

// 全站每日生成上限（UTC 自然日）。预检查只为尽早拒绝；并发提交由 batch 里的断言兜底，超出时整个 batch 回滚
export const utcDayStart = (now: string) => `${now.slice(0, 10)}T00:00:00.000Z`

export async function generationsToday(db: D1Database, now: string) {
  return (await db.prepare('SELECT COUNT(*) AS n FROM generations WHERE created_at >= ?').bind(utcDayStart(now)).first<number>('n')) ?? 0
}

export function dailyCapGuard(db: D1Database, cap: number, now: string) {
  if (cap <= 0) return []
  return [
    db.prepare('INSERT INTO credit_guard (ok) SELECT COUNT(*) <= ? FROM generations WHERE created_at >= ?').bind(cap, utcDayStart(now)),
    db.prepare('DELETE FROM credit_guard'),
  ]
}

// 前台公告条与维护提示（/api/me 下发）
export function publicNotice(settings: RuntimeSettings) {
  return {
    maintenance: settings.maintenance,
    checkoutPaused: settings.checkoutPaused,
    announcement: Object.fromEntries(LOCALES.map((locale) => [locale, settings[`announcement.${locale}`]])) as Record<Locale, string>,
  }
}

async function adminView(db: D1Database, env: Env) {
  const [stored, meta] = await Promise.all([
    loadStored(db),
    db
      .prepare(
        `SELECT s.key, s.updated_at AS updatedAt, u.email AS updatedBy FROM settings s LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.key`,
      )
      .all<{ key: string; updatedAt: string; updatedBy: string | null }>(),
  ])
  const override = storedVideoProvider(stored, env)
  return {
    fields: settingFields(env),
    values: { ...mergeSettings(stored), videoProvider: displayedVideoProvider(env, override) },
    // 没存覆盖时，默认显示环境变量里的 yir / fal / opengen（非生产还有 mock）。
    defaults: { ...DEFAULT_SETTINGS, videoProvider: displayedVideoProvider(env, null) },
    overrides: meta.results,
  }
}

export async function forgetLegacyFulfillmentMap(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT key FROM settings WHERE key = 'fulfillmentModeByTemplate'`).first()
  if (!row) return false
  await env.DB.prepare(`DELETE FROM settings WHERE key = 'fulfillmentModeByTemplate'`).run()
  await env.KV.delete(CACHE_KEY)
  return true
}

export function registerSettingsAdminRoutes(routes: Hono<AppContext>) {
  // 后台读 D1 原值，不走缓存
  routes.get('/settings', async (c) => {
    await forgetLegacyFulfillmentMap(c.env)
    return c.json(await adminView(c.env.DB, c.env))
  })

  routes.post('/settings', async (c) => {
    const admin = requireAdmin(c)
    const patch = parseSettingsPatch((await readJson<{ values: unknown }>(c)).values, c.env)
    const db = c.env.DB
    const raw = await loadStored(db)
    const before = mergeSettings(raw)
    const beforeVideo = displayedVideoProvider(c.env, storedVideoProvider(raw, c.env))
    const now = nowIso()
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    const statements: D1PreparedStatement[] = []
    for (const [key, value] of Object.entries(patch) as [SettingKey, unknown][]) {
      const previous = key === 'videoProvider' ? beforeVideo : before[key]
      if (previous === value) continue
      changes[key] = { from: previous, to: value }
      statements.push(
        settingMatchesDefault(key, value, c.env)
          ? db.prepare('DELETE FROM settings WHERE key = ?').bind(key)
          : db
              .prepare(
                `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
              )
              .bind(key, JSON.stringify(value), admin.id, now),
      )
    }
    if (statements.length > 0) {
      await db.batch(statements)
      await c.env.KV.put(CACHE_KEY, JSON.stringify(await loadStored(db)))
      await audit(c.env, admin, 'settings.update', 'settings', 'runtime', changes)
    }
    return c.json(await adminView(db, c.env))
  })
}
