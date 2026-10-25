import { findPlan } from '#/config/site'
import { ApiError, isProduction } from '../util'
import { createDodoProvider } from './dodo'
import { createPaypalProvider, paypalReady } from './paypal'
import { createStripeProvider } from './stripe'
import type { PaidEvent, PaymentProvider, PaymentProviderId } from './types'
import { createWaffoProvider } from './waffo'

// mock：本地与 e2e 用，跳转到站内 /checkout/mock 页面模拟付款（生产环境禁止）
// 与 successUrl 保持同一语言前缀（/zh-TW/checkout/success → /zh-TW/checkout/mock）
function createMockProvider(env: Env): PaymentProvider {
  return {
    id: 'mock',
    async createCheckout(input) {
      const url = new URL(input.successUrl)
      url.pathname = url.pathname.replace(/\/checkout\/success$/, '/checkout/mock')
      url.search = ''
      url.searchParams.set('order', input.order.id)
      return { url: `${url.pathname}${url.search}`, sessionId: `mock_${input.order.id}` }
    },
    // “支付商那边已付款”的状态由 /api/mock-payments/complete（deliver: false）写入 KV，模拟 webhook 丢失
    async fetchPaidEvent(order) {
      const event = await env.KV.get<PaidEvent>(mockPaidKey(order.id), 'json')
      return event ? { event, raw: event } : null
    },
    // 订阅：取消、恢复直接成功（状态变化由 /api/mock-payments/subscription 模拟 webhook），门户回到账单页
    async cancelSubscription() {},
    async resumeSubscription() {},
    // 和 createCheckout 一样只返回 path：本地 SITE_URL 的端口不一定是 dev server 的端口
    async portalUrl(_subscription, returnUrl) {
      return `${new URL(returnUrl).pathname}#mock-portal`
    },
  }
}

export function mockPaidKey(orderId: string) {
  return `mock_paid:${orderId}`
}

function waffoReady(env: Env) {
  return Boolean(env.WAFFO_MERCHANT_ID?.trim() && env.WAFFO_PRIVATE_KEY?.trim())
}

// 结账可选通道。本地 mock 只有 mock。产品默认是 Waffo + PayPal.cn：两个都配齐就都能选。
// Dodo / Stripe 仍可当 PAYMENT_PROVIDER，但不和这两条主通道混在一个选择器里。
export function checkoutChannels(env: Env): PaymentProviderId[] {
  const configured = env.PAYMENT_PROVIDER as PaymentProviderId
  if (configured === 'mock') return isProduction(env) ? [] : ['mock']
  if (configured === 'dodo' || configured === 'stripe') return [configured]
  const channels: PaymentProviderId[] = []
  if (waffoReady(env) || configured === 'waffo') channels.push('waffo')
  if (paypalReady(env) || configured === 'paypal') channels.push('paypal')
  return channels
}

export function defaultCheckoutChannel(env: Env): PaymentProviderId {
  const channels = checkoutChannels(env)
  const configured = env.PAYMENT_PROVIDER as PaymentProviderId
  if (channels.includes(configured)) return configured
  if (channels.includes('waffo')) return 'waffo'
  if (channels[0]) return channels[0]
  throw new ApiError(503, 'payment_not_configured', `Unsupported PAYMENT_PROVIDER: ${env.PAYMENT_PROVIDER}`)
}

// 积分包用买家选的通道（没选就用默认）。订阅不能走 PayPal，落到 Waffo / Dodo / Stripe / mock。
export function resolveCheckoutChannel(env: Env, requested: string | undefined, packageId: string): PaymentProviderId {
  const channels = checkoutChannels(env)
  if (!channels.length) throw new ApiError(503, 'payment_not_configured', `Unsupported PAYMENT_PROVIDER: ${env.PAYMENT_PROVIDER}`)
  const plan = !!findPlan(packageId)
  const allowed = plan ? channels.filter((id) => id !== 'paypal') : channels
  if (!allowed.length) throw new ApiError(400, 'paypal_packs_only', 'PayPal checkout only sells credit packs')
  if (requested) {
    if (!channels.includes(requested as PaymentProviderId)) throw new ApiError(400, 'invalid_channel', `Unsupported channel: ${requested}`)
    if (plan && requested === 'paypal') throw new ApiError(400, 'paypal_packs_only', 'PayPal checkout only sells credit packs')
    return requested as PaymentProviderId
  }
  const preferred = defaultCheckoutChannel(env)
  if (allowed.includes(preferred)) return preferred
  return allowed[0]!
}

export function activePaymentProviderId(env: Env): PaymentProviderId {
  return defaultCheckoutChannel(env)
}

// 退款、查单按订单所属支付商走（切换 PAYMENT_PROVIDER 后，旧订单仍找原支付商）；生产环境不认 mock 订单
export function getOrderProvider(env: Env, id: string): PaymentProvider | null {
  if (id === 'waffo') return createWaffoProvider(env)
  if (id === 'paypal') return createPaypalProvider(env)
  if (id === 'dodo') return createDodoProvider(env)
  if (id === 'stripe') return createStripeProvider(env)
  if (id === 'mock' && !isProduction(env)) return createMockProvider(env)
  return null
}

export function getPaymentProvider(env: Env): PaymentProvider {
  const provider = getOrderProvider(env, activePaymentProviderId(env))
  if (!provider) throw new ApiError(503, 'payment_not_configured', `Unsupported PAYMENT_PROVIDER: ${env.PAYMENT_PROVIDER}`)
  return provider
}
