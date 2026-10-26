import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { site } from '#/config/site'
import { resetPaypalForTests } from '#/server/payments/paypal'
import { runProbe } from '#/server/probes'
import type { UserRow } from '#/server/types'
import { d1Shim, kvShim, migrate } from './d1-sqlite'

const admin = { id: 'usr_admin', email: 'admin@example.com', role: 'admin' } as UserRow
const DODO_KEY = 'dodo_test_key_1234567890'
// 积分包和订阅套餐都要有商品
const ITEMS = [...site.packages, ...site.plans]
const DODO_PRODUCTS = JSON.stringify(Object.fromEntries(ITEMS.map((pack) => [pack.id, `pdt_${pack.id}`])))

type Reply = { status?: number; body?: unknown }
// 按 URL 片段返回假响应，并记下请求过的 URL 和 Authorization 头
function stubFetch(routes: Record<string, Reply | ((url: string) => Reply)>) {
  const calls: Array<{ url: string; auth: string | null }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, auth: new Headers(init?.headers).get('Authorization') })
    const match = Object.entries(routes).find(([fragment]) => url.includes(fragment))
    if (!match) throw new Error(`unexpected fetch ${url}`)
    const reply = typeof match[1] === 'function' ? match[1](url) : match[1]
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  })
  return calls
}

const dodoPrice = (prices: Record<string, number>, currency = 'USD') => (url: string) => {
  const packId = decodeURIComponent(url.split('/products/')[1]!).replace('pdt_', '')
  return { body: { product_id: `pdt_${packId}`, price: { price: prices[packId] ?? ITEMS.find((p) => p.id === packId)!.priceCents, currency } } }
}

// Stripe 的 Price：订阅套餐是 recurring（周期同 site.plans），积分包是 one_time
const STRIPE_KEY = 'sk_test_probe_1234567890'
const STRIPE_PRODUCTS = JSON.stringify(Object.fromEntries(ITEMS.map((pack) => [pack.id, `price_${pack.id}`])))
const stripePrice = (override: Record<string, Record<string, unknown>> = {}) => (url: string) => {
  const packId = decodeURIComponent(url.split('/v1/prices/')[1]!).replace('price_', '')
  const item = ITEMS.find((p) => p.id === packId)!
  const plan = site.plans.find((p) => p.id === packId)
  return {
    body: {
      id: `price_${packId}`,
      active: true,
      unit_amount: item.priceCents,
      currency: item.currency.toLowerCase(),
      type: plan ? 'recurring' : 'one_time',
      recurring: plan ? { interval: plan.interval, interval_count: 1 } : null,
      ...override[packId],
    },
  }
}

const probe = (target: Parameters<typeof runProbe>[1], env: Record<string, unknown>) => runProbe(env as unknown as Env, target, admin)

afterEach(() => {
  resetPaypalForTests()
  vi.unstubAllGlobals()
})

describe('支付探测', () => {
  const dodo = { PAYMENT_PROVIDER: 'dodo', DODO_API_KEY: DODO_KEY, DODO_PRODUCTS }

  it('Dodo：每个套餐的商品和价格一致时 ok，只读 GET 商品接口，走 test 环境', async () => {
    const calls = stubFetch({ '/products/': dodoPrice({}) })
    const result = await probe('payment', dodo)
    expect(result).toMatchObject({ target: 'payment', provider: 'dodo', status: 'ok' })
    expect(calls.map((c) => c.url)).toEqual(ITEMS.map((pack) => `https://test.dodopayments.com/products/pdt_${pack.id}`))
    expect(calls.every((c) => c.auth === `Bearer ${DODO_KEY}`)).toBe(true)
  })

  it('Dodo：售价低于 site.ts 时 fail（付款会因金额不符不入账）；高于或币种不同只提示', async () => {
    const [cheap, pricey] = site.packages
    stubFetch({ '/products/': dodoPrice({ [cheap!.id]: cheap!.priceCents - 1, [pricey!.id]: pricey!.priceCents + 100 }) })
    const result = await probe('payment', dodo)
    expect(result.status).toBe('fail')
    expect(result.message).toContain(`${cheap!.id}：Dodo 售价 ${cheap!.priceCents - 1} 低于`)
    expect(result.message).toContain(`${pricey!.id}：Dodo 售价 ${pricey!.priceCents + 100} 高于`)

    stubFetch({ '/products/': dodoPrice({ [pricey!.id]: pricey!.priceCents + 100 }) })
    expect(await probe('payment', dodo)).toMatchObject({ status: 'warn' })
    stubFetch({ '/products/': dodoPrice({}, 'EUR') })
    expect((await probe('payment', dodo)).message).toContain('币种是 EUR')
  })

  it('Dodo：Key 无效、商品不存在、套餐没配商品 ID 都是 fail，说明里不带 Key', async () => {
    stubFetch({ '/products/': { status: 401 } })
    const unauthorized = await probe('payment', { ...dodo, DODO_ENVIRONMENT: 'live' })
    expect(unauthorized).toMatchObject({ status: 'fail' })
    expect(unauthorized.message).toContain('DODO_ENVIRONMENT=live')

    stubFetch({ '/products/': { status: 404 } })
    const [first, ...rest] = site.packages
    const partial = JSON.stringify(Object.fromEntries(rest.map((pack) => [pack.id, `pdt_${pack.id}`])))
    const result = await probe('payment', { ...dodo, DODO_PRODUCTS: partial })
    expect(result.status).toBe('fail')
    expect(result.message).toContain(`${first!.id}：DODO_PRODUCTS 里没有商品 ID`)
    expect(result.message).toContain(`商品 pdt_${rest[0]!.id} 不存在`)
    expect(await probe('payment', { PAYMENT_PROVIDER: 'dodo', DODO_PRODUCTS })).toMatchObject({ status: 'fail', message: 'DODO_API_KEY 未配置' })
  })

  it('Stripe：每个 Price 的金额、币种、类型和周期一致时 ok，只读 GET Price 接口，带固定 API 版本', async () => {
    const calls = stubFetch({ '/v1/prices/': stripePrice() })
    const result = await probe('payment', { PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_PRODUCTS })
    expect(result).toMatchObject({ target: 'payment', provider: 'stripe', status: 'ok' })
    expect(calls.map((c) => c.url)).toEqual(ITEMS.map((pack) => `https://api.stripe.com/v1/prices/price_${pack.id}`))
    expect(calls.every((c) => c.auth === `Bearer ${STRIPE_KEY}`)).toBe(true)
  })

  it('Stripe：售价偏低、Price 停用、积分包配了订阅价、订阅周期不对都是 fail；高于只提示；401/403 说明里不带 Key', async () => {
    const stripe = { PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_PRODUCTS }
    const [cheap, inactive, wrongType] = site.packages
    const yearly = site.plans.find((p) => p.interval === 'year')!
    stubFetch({
      '/v1/prices/': stripePrice({
        [cheap!.id]: { unit_amount: cheap!.priceCents - 1 },
        [inactive!.id]: { active: false },
        [wrongType!.id]: { type: 'recurring', recurring: { interval: 'month' } },
        [yearly.id]: { recurring: { interval: 'month', interval_count: 1 } },
      }),
    })
    const result = await probe('payment', stripe)
    expect(result.status).toBe('fail')
    expect(result.message).toContain(`${cheap!.id}：Stripe 售价 ${cheap!.priceCents - 1} 低于`)
    expect(result.message).toContain(`${inactive!.id}：Price price_${inactive!.id} 已停用`)
    expect(result.message).toContain(`${wrongType!.id}：积分包要用一次性价格`)
    expect(result.message).toContain(`${yearly.id}：Price 的扣款周期不是每年一次`)

    stubFetch({ '/v1/prices/': stripePrice({ [cheap!.id]: { unit_amount: cheap!.priceCents + 100 } }) })
    expect(await probe('payment', stripe)).toMatchObject({ status: 'warn' })

    for (const status of [401, 403]) {
      stubFetch({ '/v1/prices/': { status, body: { error: { message: `Invalid API Key provided: ${STRIPE_KEY}` } } } })
      const denied = await probe('payment', stripe)
      expect(denied.status).toBe('fail')
      expect(denied.message).not.toContain(STRIPE_KEY)
    }
    expect(await probe('payment', { PAYMENT_PROVIDER: 'stripe', STRIPE_PRODUCTS })).toMatchObject({ status: 'fail', message: 'STRIPE_SECRET_KEY 未配置' })
  })

  it('PayPal：OAuth 成功即可，不要求商品目录；webhook id 缺失或是占位值时失败', async () => {
    const env = {
      PAYMENT_PROVIDER: 'paypal',
      PAYPAL_MODE: 'sandbox',
      PAYPAL_CLIENT_ID: 'paypal-client',
      PAYPAL_CLIENT_SECRET: 'paypal-secret-value',
      PAYPAL_WEBHOOK_ID: 'WH-123',
    }
    const calls = stubFetch({ '/v1/oauth2/token': { body: { access_token: 'tok', expires_in: 300 } } })
    const result = await probe('payment', env)
    expect(result).toMatchObject({ status: 'ok', provider: 'paypal' })
    expect(result.message).toContain('积分包')
    expect(calls[0]?.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token')
    expect(await probe('payment', { ...env, PAYPAL_WEBHOOK_ID: 'WEBHOOK_ID' })).toMatchObject({ status: 'fail' })
    expect(await probe('payment', { PAYMENT_PROVIDER: 'paypal' })).toMatchObject({ status: 'fail' })
  })

  it('mock 不调用外部接口；生产环境配了 mock 时报 fail 而不是抛错', async () => {
    stubFetch({})
    expect(await probe('payment', { PAYMENT_PROVIDER: 'mock' })).toMatchObject({ status: 'ok', provider: 'mock' })
    expect(await probe('payment', { PAYMENT_PROVIDER: 'mock', APP_ENV: 'production' })).toMatchObject({ status: 'fail' })
  })
})

describe('视频服务商探测', () => {
  it('fal：余额充足 ok，低于 5 美元提示；403（Key 没有 billing 权限）只提示，401 fail', async () => {
    const env = { VIDEO_PROVIDER: 'fal', FAL_KEY: 'fal_key_abcdefgh' }
    const calls = stubFetch({ 'api.fal.ai/v1/account/billing': { body: { credits: { current_balance: 42.5, currency: 'USD' } } } })
    expect(await probe('video', env)).toMatchObject({ status: 'ok', message: '鉴权正常，余额 42.50 USD' })
    expect(calls[0]).toEqual({ url: 'https://api.fal.ai/v1/account/billing?expand=credits', auth: 'Key fal_key_abcdefgh' })

    stubFetch({ 'api.fal.ai': { body: { credits: { current_balance: 1.2 } } } })
    expect((await probe('video', env)).status).toBe('warn')
    stubFetch({ 'api.fal.ai': { status: 403 } })
    expect((await probe('video', env)).message).toContain('billing:usage:read')
    stubFetch({ 'api.fal.ai': { status: 401 } })
    expect(await probe('video', env)).toMatchObject({ status: 'fail', message: 'FAL_KEY 无效' })
  })

  it('yir：查余额接口，余额偏低提示；读不到余额只提示', async () => {
    const env = { VIDEO_PROVIDER: 'yir', YIR_API_KEY: 'yir_key_abcdefgh' }
    const calls = stubFetch({ 'gateway.yir.ai/v1/balance': { body: { available_amount: '3.10', currency: 'USD' } } })
    expect(await probe('video', env)).toMatchObject({ status: 'warn', provider: 'yir' })
    expect(calls[0]?.auth).toBe('Bearer yir_key_abcdefgh')
    stubFetch({ 'gateway.yir.ai': { body: {} } })
    expect(await probe('video', env)).toMatchObject({ status: 'warn', message: '鉴权正常，但读不到余额' })
    expect(await probe('video', { VIDEO_PROVIDER: 'yir' })).toMatchObject({ status: 'fail', message: 'YIR_API_KEY 未配置' })
  })

  it('nanoapi：查 /v1/balance，余额在 data 里；401 fail，余额偏低提示；mock 不要求密钥', async () => {
    const env = { VIDEO_PROVIDER: 'nanoapi', NANOAPI_API_KEY: 'nano_key_abcdefgh' }
    const calls = stubFetch({ 'api.nanoapi.ai/v1/balance': { body: { code: 200, data: { available: '12.50', frozen: '0', currency: 'USD' } } } })
    expect(await probe('video', env)).toMatchObject({ status: 'ok', message: '鉴权正常，余额 12.50 USD', provider: 'nanoapi' })
    expect(calls[0]?.auth).toBe('Bearer nano_key_abcdefgh')
    stubFetch({ 'api.nanoapi.ai': { body: { data: { available: '2.00', currency: 'USD' } } } })
    expect((await probe('video', env)).status).toBe('warn')
    stubFetch({ 'api.nanoapi.ai': { status: 401 } })
    expect(await probe('video', env)).toMatchObject({ status: 'fail', message: 'NANOAPI_API_KEY 无效' })
    expect(await probe('video', { VIDEO_PROVIDER: 'nanoapi' })).toMatchObject({ status: 'fail', message: 'NANOAPI_API_KEY 未配置' })
    expect(await probe('video', { VIDEO_PROVIDER: 'mock' })).toMatchObject({ status: 'ok', provider: 'mock' })
  })

  it('上游报错里出现的密钥值被替换掉', async () => {
    const key = 'fal_secret_value_123'
    vi.stubGlobal('fetch', async () => {
      throw new Error(`connect failed for Key ${key} (OPENAI ${'sk-other-secret'})`)
    })
    const result = await probe('video', { VIDEO_PROVIDER: 'fal', FAL_KEY: `${key}\n`, OPENAI_API_KEY: 'sk-other-secret', SITE_URL: 'http://localhost' })
    expect(result.status).toBe('fail')
    expect(result.message).toBe('connect failed for Key *** (OPENAI ***)')
  })

  it('env 是 fal、运行时是 yir：探测跟运行时，标签是 yir', async () => {
    const calls = stubFetch({ 'gateway.yir.ai/v1/balance': { body: { available_amount: 20, currency: 'USD' } } })
    const result = await runProbe({ VIDEO_PROVIDER: 'fal', FAL_KEY: 'fal_key_abcdefgh', YIR_API_KEY: 'yir_key_abcdefgh', APP_ENV: 'development' } as unknown as Env, 'video', admin, {
      settings: { videoProvider: 'yir' },
    })
    expect(result).toMatchObject({ status: 'ok', provider: 'yir' })
    expect(calls[0]?.url).toContain('gateway.yir.ai')
    expect(calls.some((call) => call.url.includes('api.fal.ai'))).toBe(false)
  })

  it('显式探测目标优先于运行时；未配置是 fail 且文案含未配置，不是 skipped', async () => {
    const calls = stubFetch({})
    const result = await runProbe({ VIDEO_PROVIDER: 'fal', FAL_KEY: 'fal_key_abcdefgh', APP_ENV: 'development' } as unknown as Env, 'video', admin, {
      provider: 'opengen',
      settings: { videoProvider: 'yir' },
    })
    expect(result.status).toBe('fail')
    expect(result.status).not.toBe('skipped')
    expect(result.provider).toBe('opengen')
    expect(result.message).toContain('未配置')
    expect(calls).toEqual([])
  })

  it('非法渠道探测失败，标签保留请求值', async () => {
    const result = await runProbe({ VIDEO_PROVIDER: 'fal', APP_ENV: 'production' } as unknown as Env, 'video', admin, { provider: 'kling' })
    expect(result).toMatchObject({ status: 'fail', provider: 'kling' })
    expect(result.message).toContain('VIDEO_PROVIDER')
  })

  it('联调 stub 的探测文案含联调，且不发请求；production 忽略 stub 并报未配置', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const stubbed = await probe('video', { VIDEO_PROVIDER: 'opengen', OPENGEN_STUB: '1', APP_ENV: 'preview' })
    expect(stubbed).toMatchObject({ status: 'ok', provider: 'opengen' })
    expect(stubbed.message).toContain('联调')
    const blocked = await probe('video', { VIDEO_PROVIDER: 'opengen', OPENGEN_STUB: '1', APP_ENV: 'production' })
    expect(blocked.status).toBe('fail')
    expect(blocked.message).toContain('未配置')
    expect(blocked.status).not.toBe('skipped')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('配了地址和密钥时探测打健康检查；401 报密钥无效', async () => {
    const calls = stubFetch({ 'og.example/base/v1/aimov/health': { body: { ok: true } } })
    const okResult = await probe('video', {
      VIDEO_PROVIDER: 'opengen',
      APP_ENV: 'production',
      OPENGEN_BASE_URL: 'https://og.example/base/',
      OPENGEN_API_KEY: 'og_secret_key_123',
      OPENGEN_STUB: '0',
    })
    expect(okResult).toMatchObject({ status: 'ok', provider: 'opengen', message: '鉴权正常，OpenGen 端点可达' })
    expect(calls[0]).toMatchObject({ url: 'https://og.example/base/v1/aimov/health', auth: 'Bearer og_secret_key_123' })
    stubFetch({ 'og.example': { status: 401 } })
    expect(await probe('video', { VIDEO_PROVIDER: 'opengen', APP_ENV: 'production', OPENGEN_BASE_URL: 'https://og.example', OPENGEN_API_KEY: 'og_secret_key_123' })).toMatchObject({
      status: 'fail',
      message: 'OPENGEN_API_KEY 无效',
    })
  })

  it('库里的渠道覆盖优先于 env；production 里存的 mock 回落到 env', async () => {
    const sqlite = new DatabaseSync(':memory:')
    migrate(sqlite)
    sqlite.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('videoProvider', ?, '2026-10-26')`).run(JSON.stringify('yir'))
    const kv = kvShim()
    const db = d1Shim(sqlite)
    const calls = stubFetch({ 'gateway.yir.ai/v1/balance': { body: { available_amount: 20, currency: 'USD' } } })
    const runtime = await runProbe(
      { DB: db, KV: kv, VIDEO_PROVIDER: 'fal', FAL_KEY: 'fal_key_abcdefgh', YIR_API_KEY: 'yir_key_abcdefgh', APP_ENV: 'development' } as unknown as Env,
      'video',
      admin,
    )
    expect(runtime).toMatchObject({ status: 'ok', provider: 'yir' })
    expect(calls[0]?.url).toContain('gateway.yir.ai')

    sqlite.prepare(`UPDATE settings SET value = ? WHERE key = 'videoProvider'`).run(JSON.stringify('mock'))
    kv.store.clear()
    stubFetch({ 'api.fal.ai/v1/account/billing': { body: { credits: { current_balance: 10, currency: 'USD' } } } })
    const dropped = await runProbe(
      { DB: db, KV: kv, VIDEO_PROVIDER: 'fal', FAL_KEY: 'fal_key_abcdefgh', APP_ENV: 'production' } as unknown as Env,
      'video',
      admin,
    )
    expect(dropped).toMatchObject({ status: 'ok', provider: 'fal' })
  })
})

describe('其他依赖', () => {
  it('发信未配置时 skipped；配置后给管理员发一封测试邮件', async () => {
    expect(await probe('email', {})).toMatchObject({ status: 'skipped' })
    const send = vi.fn(async () => ({ messageId: 'msg_1' }))
    const result = await probe('email', { EMAIL_FROM: 'noreply@example.com', EMAIL: { send } })
    expect(result.status).toBe('ok')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: admin.email, from: { email: 'noreply@example.com', name: site.brandName } }))
  })

  it('KV 和 R2 写读删，不留下探测数据；R2 写入失败时 fail', async () => {
    const kv = kvShim()
    expect(await probe('kv', { KV: kv })).toMatchObject({ status: 'ok' })
    expect(kv.store.size).toBe(0)

    const objects = new Map<string, string>()
    const media = {
      put: async (key: string, value: string) => void objects.set(key, value),
      head: async (key: string) => (objects.has(key) ? { key } : null),
      delete: async (key: string) => void objects.delete(key),
    }
    expect(await probe('storage', { MEDIA: media })).toMatchObject({ status: 'ok', provider: 'R2' })
    expect(objects.size).toBe(0)
    expect(await probe('storage', { MEDIA: { ...media, put: async () => Promise.reject(new Error('R2 down')) } })).toMatchObject({ status: 'fail', message: 'R2 down' })
  })

  it('审核：none 时 skipped；openai 查模型接口', async () => {
    expect(await probe('moderation', { MODERATION_PROVIDER: 'none' })).toMatchObject({ status: 'skipped' })
    stubFetch({ '/v1/models/omni-moderation-latest': { body: { id: 'omni-moderation-latest' } } })
    expect(await probe('moderation', { MODERATION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-12345678' })).toMatchObject({ status: 'ok' })
    stubFetch({ '/v1/models/': { status: 401 } })
    expect(await probe('moderation', { MODERATION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-12345678' })).toMatchObject({ status: 'fail' })
  })
})
