import { describe, expect, it } from 'vitest'
import { activePaymentProviderId, checkoutChannels, getOrderProvider, resolveCheckoutChannel } from '#/server/payments'
import { activeVideoProviderId, getVideoProvider, resolveEffectiveVideoProvider } from '#/server/video'

// mock 支付/生成在生产环境必须不可用，否则任何人都能免费充值
describe('provider 选择', () => {
  const env = (vars: Record<string, string>) => vars as unknown as Env

  it('非生产环境允许 mock', () => {
    expect(activePaymentProviderId(env({ APP_ENV: 'development', PAYMENT_PROVIDER: 'mock' }))).toBe('mock')
    expect(activeVideoProviderId(env({ APP_ENV: 'preview', VIDEO_PROVIDER: 'mock' }))).toBe('mock')
  })

  it('生产环境和 staging 拒绝 mock，未知 provider 也拒绝', () => {
    expect(() => activePaymentProviderId(env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'mock' }))).toThrow(/PAYMENT_PROVIDER/)
    expect(() => activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'mock' }))).toThrow(/VIDEO_PROVIDER/)
    // staging 部署在公开的 workers.dev 上，mock 支付等于免费充值
    expect(() => activePaymentProviderId(env({ APP_ENV: 'staging', PAYMENT_PROVIDER: 'mock' }))).toThrow(/PAYMENT_PROVIDER/)
    expect(() => activePaymentProviderId(env({ APP_ENV: 'development', PAYMENT_PROVIDER: 'creem' }))).toThrow()
  })

  it('生产环境正常选择 waffo / dodo / fal / yir / nanoapi', () => {
    expect(activePaymentProviderId(env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'waffo' }))).toBe('waffo')
    expect(activePaymentProviderId(env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'dodo' }))).toBe('dodo')
    expect(activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal' }))).toBe('fal')
    expect(activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'yir' }))).toBe('yir')
    expect(activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'nanoapi' }))).toBe('nanoapi')
    expect(activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'opengen' }))).toBe('opengen')
    expect(() => activeVideoProviderId(env({ APP_ENV: 'staging', VIDEO_PROVIDER: 'mock' }))).toThrow(/VIDEO_PROVIDER/)
  })

  it('运行时渠道覆盖 env；production 下的 mock 覆盖不是合法渠道', () => {
    expect(resolveEffectiveVideoProvider(env({ APP_ENV: 'development', VIDEO_PROVIDER: 'mock' }), { videoProvider: 'opengen' })).toBe('opengen')
    expect(resolveEffectiveVideoProvider(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal' }), { videoProvider: null })).toBe('fal')
    expect(resolveEffectiveVideoProvider(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal' }), { videoProvider: '' })).toBe('fal')
    expect(() => resolveEffectiveVideoProvider(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal' }), { videoProvider: 'mock' })).toThrow(/VIDEO_PROVIDER/)
    expect(getVideoProvider(env({ APP_ENV: 'development', OPENGEN_STUB: '1' }), 'opengen').id).toBe('opengen')
    expect(() => getVideoProvider(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal' }), 'mock')).toThrow(/video provider/)
    expect(() => getVideoProvider(env({ APP_ENV: 'development', VIDEO_PROVIDER: 'mock' }), 'manual')).toThrow(/fulfillment mode/)
    expect(() => resolveEffectiveVideoProvider(env({ APP_ENV: 'development', VIDEO_PROVIDER: 'manual' }), { videoProvider: null })).toThrow(/fulfillment mode/)
    expect(() => resolveEffectiveVideoProvider(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal' }), { videoProvider: 'manual' })).toThrow(/fulfillment mode/)
  })

  it('本地 mock 忽略残留的 PayPal 密钥；Waffo 默认，PayPal 只卖积分包', () => {
    const leaked = env({
      APP_ENV: 'development',
      PAYMENT_PROVIDER: 'mock',
      PAYPAL_CLIENT_ID: 'id',
      PAYPAL_CLIENT_SECRET: 'secret',
      PAYPAL_MODE: 'sandbox',
    })
    expect(checkoutChannels(leaked)).toEqual(['mock'])

    const both = env({
      APP_ENV: 'production',
      PAYMENT_PROVIDER: 'waffo',
      WAFFO_MERCHANT_ID: 'm',
      WAFFO_PRIVATE_KEY: 'k',
      PAYPAL_CLIENT_ID: 'id',
      PAYPAL_CLIENT_SECRET: 'secret',
    })
    expect(checkoutChannels(both)).toEqual(['waffo', 'paypal'])
    expect(activePaymentProviderId(both)).toBe('waffo')
    expect(resolveCheckoutChannel(both, 'paypal', 'starter')).toBe('paypal')
    expect(resolveCheckoutChannel(both, undefined, 'monthly')).toBe('waffo')
    expect(() => resolveCheckoutChannel(both, 'paypal', 'yearly')).toThrow(expect.objectContaining({ code: 'paypal_packs_only' }))
    expect(() => resolveCheckoutChannel(both, 'stripe', 'starter')).toThrow(expect.objectContaining({ code: 'invalid_channel' }))

    const paypalOnly = env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'paypal', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' })
    expect(resolveCheckoutChannel(paypalOnly, undefined, 'starter')).toBe('paypal')
    expect(() => resolveCheckoutChannel(paypalOnly, undefined, 'monthly')).toThrow(expect.objectContaining({ code: 'paypal_packs_only' }))
  })

  it('两条都配齐时按 allow 过滤新订单；旧订单仍按订单支付商', () => {
    const both = env({
      APP_ENV: 'production',
      PAYMENT_PROVIDER: 'waffo',
      WAFFO_MERCHANT_ID: 'm',
      WAFFO_PRIVATE_KEY: 'k',
      PAYPAL_CLIENT_ID: 'id',
      PAYPAL_CLIENT_SECRET: 'secret',
    })
    expect(checkoutChannels(both, { allowWaffo: false })).toEqual(['paypal'])
    expect(checkoutChannels(both, { allowPaypal: false })).toEqual(['waffo'])
    expect(checkoutChannels(both, { allowWaffo: false, allowPaypal: false })).toEqual([])
    expect(checkoutChannels(both)).toEqual(['waffo', 'paypal'])
    expect(() => resolveCheckoutChannel(both, 'waffo', 'starter', { allowWaffo: false })).toThrow(expect.objectContaining({ code: 'invalid_channel' }))
    expect(resolveCheckoutChannel(both, undefined, 'starter', { allowPaypal: false })).toBe('waffo')
    expect(resolveCheckoutChannel(both, undefined, 'starter', { allowWaffo: false })).toBe('paypal')
    expect(() => resolveCheckoutChannel(both, 'paypal', 'starter', { allowWaffo: false, allowPaypal: false })).toThrow(
      expect.objectContaining({ code: 'payment_not_configured' }),
    )
    expect(getOrderProvider(both, 'paypal')?.id).toBe('paypal')
    expect(getOrderProvider(both, 'waffo')?.id).toBe('waffo')

    const waffoOnly = env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'waffo', WAFFO_MERCHANT_ID: 'm', WAFFO_PRIVATE_KEY: 'k' })
    expect(checkoutChannels(waffoOnly, { allowWaffo: false })).toEqual(['waffo'])
  })
})
