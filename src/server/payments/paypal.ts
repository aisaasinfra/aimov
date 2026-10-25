// PayPal Orders v2（PayPal.cn 用同一套全球 REST，没有单独的中国支付 API）。
// 只用 fetch + WebCrypto，不依赖 Node SDK，可直接跑在 Workers。
// 只卖一次性积分包。订阅不在这个通道上建，webhook 里的订阅事件记为 ignored，不入账。
import { site } from '#/config/site'
import { ApiError, cleanSecret, parseJsonRecord } from '../util'
import { currencyExponent, minorToDisplay } from './amount'
import type { CheckoutResult, PaidEvent, PaidLookup, PaymentEvent, PaymentProvider, RefundRequest, RefundRequestResult } from './types'
import { WebhookVerificationError } from './types'

export const PAYPAL_API_HOSTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const

export type PaypalMode = keyof typeof PAYPAL_API_HOSTS

const REQUEST_TIMEOUT_MS = 20_000
const BODY_MAX_BYTES = 1_000_000
const CERT_MAX_BYTES = 65_536
const CERT_CACHE_MAX = 32

const CERT_HOSTS = new Set(['api-m.paypal.com', 'api-m.sandbox.paypal.com', 'api.paypal.com', 'api.sandbox.paypal.com'])
const CERT_PATH = /^\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]{1,128}$/
const APPROVAL_HOST = /^(?:[a-z0-9-]+\.)*paypal\.(?:com|cn)$/i
const PAYPAL_AMOUNT = /^(0|[1-9]\d*)\.(\d{2})$/

// 路径第一段是站点语言键。区域默认：德语 de-DE、西班牙语 es-ES、法语 fr-FR、英语 en-US。
// pt-BR 与 zh-TW 本身就是区域标签。没有简体，zh / zh-CN 不会出现在这张表里。
export const PAYPAL_LOCALE_TAGS: Record<string, string> = {
  en: 'en-US',
  de: 'de-DE',
  es: 'es-ES',
  fr: 'fr-FR',
  'pt-BR': 'pt-BR',
  'zh-TW': 'zh-TW',
}

type CertFetcher = (url: string) => Promise<string | undefined>

const certCache = new Map<string, string>()
let certFetcher: CertFetcher = defaultFetchCert
let tokenCache: { key: string; token: string; expiresAt: number } | undefined

export function resetPaypalForTests() {
  certCache.clear()
  certFetcher = defaultFetchCert
  tokenCache = undefined
}

export function setPaypalCertFetcherForTests(next: CertFetcher | undefined) {
  certFetcher = next ?? defaultFetchCert
  certCache.clear()
}

/** `"123456789"` 的 CRC-32（ISO-HDLC）十进制是 `3421780262`。PayPal 验签用这个值，不用十六进制。 */
export function crc32Decimal(body: string): string {
  let crc = 0xffffffff
  const bytes = new TextEncoder().encode(body)
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(10)
}

export function paypalAmountValue(minor: number, currency: string): string | null {
  if (!Number.isSafeInteger(minor) || minor <= 0) return null
  if (currencyExponent(currency) !== 2) return null
  const whole = Math.floor(minor / 100)
  const fraction = minor % 100
  return `${whole}.${String(fraction).padStart(2, '0')}`
}

export function minorUnitsFromPaypalValue(value: string): number | null {
  const match = PAYPAL_AMOUNT.exec(value.trim())
  if (!match) return null
  const minor = Number(match[1]) * 100 + Number(match[2])
  if (!Number.isSafeInteger(minor) || minor <= 0) return null
  return minor
}

/** 证书地址只能是 PayPal 官方通知证书。其他地址验签失败，并且不会去请求。 */
export function paypalCertUrlAllowed(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.port || url.search || url.hash) return null
  if (!CERT_HOSTS.has(url.hostname)) return null
  if (!CERT_PATH.test(url.pathname)) return null
  return url
}

export function paypalClientId(env: Env) {
  return cleanSecret(env.PAYPAL_CLIENT_ID)
}

export function paypalClientSecret(env: Env) {
  return cleanSecret(env.PAYPAL_CLIENT_SECRET)
}

export function paypalWebhookId(env: Env) {
  const id = cleanSecret(env.PAYPAL_WEBHOOK_ID)
  if (!id || id === 'WEBHOOK_ID') return undefined
  return id
}

/** 没写模式时按 sandbox，半截本地配置不会打到正式环境。其他值关掉通道。 */
export function paypalMode(env: Env): PaypalMode | null {
  const raw = env.PAYPAL_MODE?.trim().toLowerCase() ?? ''
  if (!raw) return 'sandbox'
  if (raw === 'sandbox' || raw === 'live') return raw
  return null
}

export function paypalApiBase(env: Env): string | null {
  const mode = paypalMode(env)
  if (!mode) return null
  const expected = PAYPAL_API_HOSTS[mode]
  const raw = env.PAYPAL_API_BASE?.trim()
  if (!raw) return expected
  const normalized = raw.replace(/\/+$/, '')
  return normalized === expected ? normalized : null
}

export function paypalReady(env: Env) {
  return Boolean(paypalClientId(env) && paypalClientSecret(env) && paypalMode(env) && paypalApiBase(env))
}

export function createPaypalProvider(env: Env): PaymentProvider {
  return {
    id: 'paypal',
    async createCheckout(input): Promise<CheckoutResult> {
      assertReady(env)
      const value = paypalAmountValue(input.order.amountCents, input.order.currency)
      if (!value) throw new ApiError(503, 'payment_not_configured', `PayPal cannot charge ${input.order.currency}`)
      if (input.order.id.length > 127) throw new ApiError(400, 'invalid_package', 'PayPal custom_id cannot store this order id')
      const money = { currency_code: input.order.currency.toUpperCase(), value }
      const locale = paypalLocale(input.successUrl)
      const created = await paypalJson<PaypalOrder>(env, '/v2/checkout/orders', {
        method: 'POST',
        requestId: input.order.id,
        body: {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: input.order.packageId,
              custom_id: input.order.id,
              invoice_id: input.order.id,
              amount: { ...money, breakdown: { item_total: money } },
              items: [
                {
                  name: `Credits ${input.order.packageId}`.slice(0, 127),
                  quantity: '1',
                  sku: input.order.packageId,
                  category: 'DIGITAL_GOODS',
                  unit_amount: money,
                },
              ],
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
                return_url: input.successUrl,
                cancel_url: input.cancelUrl,
                brand_name: site.brandName.slice(0, 127),
                ...(locale ? { locale } : {}),
              },
            },
          },
        },
      })
      const url = approvalUrl(created)
      if (!created.id || !url) throw new ApiError(502, 'payment_provider_error', 'PayPal order did not return an approval URL')
      return { url, sessionId: created.id }
    },
    async refund(input: RefundRequest): Promise<RefundRequestResult> {
      assertReady(env)
      const value = paypalAmountValue(input.amountCents, input.currency)
      if (!value) throw new ApiError(400, 'invalid_amount', 'PayPal refund amount is not a positive two-decimal value')
      const refund = await paypalJson<{ id?: string; status?: string }>(env, `/v2/payments/captures/${encodeURIComponent(input.providerPaymentId)}/refund`, {
        method: 'POST',
        requestId: `refund:${input.orderId}:${input.amountCents}`,
        body: {
          amount: { currency_code: input.currency.toUpperCase(), value },
          note_to_payer: input.reason.slice(0, 255),
          invoice_id: input.orderId,
        },
      })
      return { refundId: refund.id ?? null, status: refund.status ?? 'PENDING' }
    },
    async fetchPaidEvent(order): Promise<PaidLookup | null> {
      assertReady(env)
      const paypalOrderId = order.providerSessionId?.trim()
      if (!paypalOrderId) return null
      let remote = await readPaypalOrder(env, paypalOrderId)
      if (remote.status === 'APPROVED') {
        await capturePaypalOrder(env, paypalOrderId)
        remote = await readPaypalOrder(env, paypalOrderId)
      }
      const capture = completedCapture(remote)
      if (!capture) return null
      return { event: paidEventFromCapture(capture, remote, `reconcile:${capture.id}`, 'reconcile', order.id), raw: remote }
    },
  }
}

/** CHECKOUT.ORDER.APPROVED 只负责 capture。入账等 PAYMENT.CAPTURE.COMPLETED，或成功页查单。 */
export async function captureApprovedPaypalOrder(env: Env, payload: Record<string, unknown>) {
  if (eventTypeOf(payload) !== 'CHECKOUT.ORDER.APPROVED') return
  const resource = record(payload.resource)
  const status = str(resource.status)?.toUpperCase()
  if (status === 'COMPLETED' || status === 'VOIDED') return
  const id = str(resource.id)
  if (!id) return
  await capturePaypalOrder(env, id)
}

export async function capturePaypalOrder(env: Env, paypalOrderId: string): Promise<'completed' | 'pending' | 'declined'> {
  assertReady(env)
  try {
    const captured = await paypalJson<PaypalOrder>(env, `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
      method: 'POST',
      requestId: `capture:${paypalOrderId}`,
      body: {},
    })
    return outcomeOf(captured) ?? 'pending'
  } catch (error) {
    if (paypalIssue(error) === 'ORDER_ALREADY_CAPTURED') {
      const remote = await readPaypalOrder(env, paypalOrderId)
      return outcomeOf(remote) ?? 'pending'
    }
    throw error
  }
}

export async function verifyPaypalWebhook(
  rawBody: string,
  headers: Headers,
  env: Env,
): Promise<Record<string, unknown>> {
  if (new TextEncoder().encode(rawBody).byteLength > BODY_MAX_BYTES) throw new WebhookVerificationError('body too large')
  const transmissionId = headers.get('paypal-transmission-id')?.trim() ?? ''
  const transmissionTime = headers.get('paypal-transmission-time')?.trim() ?? ''
  const signature = headers.get('paypal-transmission-sig')?.trim() ?? ''
  const certUrlRaw = headers.get('paypal-cert-url')?.trim() ?? ''
  const algo = headers.get('paypal-auth-algo')?.trim() ?? ''
  if (!transmissionId || !transmissionTime || !signature || !certUrlRaw || !isRsaSha256Algo(algo)) {
    throw new WebhookVerificationError('missing paypal transmission headers')
  }
  const certUrl = paypalCertUrlAllowed(certUrlRaw)
  if (!certUrl) throw new WebhookVerificationError('paypal cert url rejected')
  const webhookId = paypalWebhookId(env)
  if (!webhookId) throw new WebhookVerificationError('PAYPAL_WEBHOOK_ID missing')
  const mode = paypalMode(env)
  const livemode = !certUrl.hostname.includes('sandbox')
  if (!mode || (mode === 'live') !== livemode) throw new WebhookVerificationError('mode mismatch')

  const pem = await loadCertificate(certUrl.toString())
  if (!pem) throw new WebhookVerificationError('paypal cert unavailable')
  let spki: Uint8Array
  try {
    spki = spkiFromCertificateDer(pemToDer(pem))
  } catch {
    certCache.delete(certUrl.toString())
    throw new WebhookVerificationError('paypal cert unreadable')
  }
  const key = await crypto.subtle.importKey('spki', spki.buffer.slice(spki.byteOffset, spki.byteOffset + spki.byteLength) as ArrayBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32Decimal(rawBody)}`
  let signatureBytes: Uint8Array
  try {
    signatureBytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0))
  } catch {
    throw new WebhookVerificationError('invalid signature encoding')
  }
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signatureBytes.buffer.slice(signatureBytes.byteOffset, signatureBytes.byteOffset + signatureBytes.byteLength) as ArrayBuffer,
    new TextEncoder().encode(message),
  )
  if (!valid) throw new WebhookVerificationError('invalid signature')
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    throw new WebhookVerificationError('invalid json')
  }
  if (!payload || typeof payload !== 'object') throw new WebhookVerificationError('invalid payload')
  return payload as Record<string, unknown>
}

export function normalizePaypalEvent(payload: Record<string, unknown>): PaymentEvent {
  const eventType = eventTypeOf(payload)
  const eventId = str(payload.id)
  if (!eventId || !eventType) throw new WebhookVerificationError('missing event id')
  const resource = record(payload.resource)
  const resourceType = str(payload.resource_type)?.toLowerCase() ?? ''
  if (eventType.startsWith('BILLING.SUBSCRIPTION.') || eventType.startsWith('BILLING.PLAN.') || eventType.startsWith('PAYMENT.SALE.') || resourceType === 'subscription' || resourceType === 'sale') {
    return { kind: 'ignored', eventId, eventType }
  }
  if (isRefundType(eventType, resource)) {
    const amount = readMoney(resource.amount)
    const captureId = captureIdFromRefund(resource)
    return {
      kind: 'refunded',
      eventId,
      eventType,
      orderId: orderIdFrom(resource),
      providerPaymentId: captureId,
      refundId: str(resource.id) ?? eventId,
      refundAmountCents: amount?.value ? minorUnitsFromPaypalValue(amount.value) : null,
      originalAmountCents: null,
    }
  }
  if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    const status = str(resource.status)?.toUpperCase() ?? ''
    if (status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED') {
      return {
        kind: 'refunded',
        eventId,
        eventType,
        orderId: orderIdFrom(resource),
        providerPaymentId: str(resource.id),
        refundId: eventId,
        refundAmountCents: null,
        originalAmountCents: null,
      }
    }
    if (status !== 'COMPLETED') return { kind: 'ignored', eventId, eventType }
    const capture = captureFromResource(resource)
    if (!capture) return { kind: 'ignored', eventId, eventType }
    return paidEventFromCapture(capture, { id: capture.orderId, purchase_units: resource.purchase_units }, eventId, eventType, orderIdFrom(resource))
  }
  if (eventType === 'PAYMENT.CAPTURE.DENIED' || eventType === 'PAYMENT.CAPTURE.DECLINED' || eventType === 'PAYMENT.CAPTURE.FAILED') {
    return { kind: 'failed', eventId, eventType, orderId: orderIdFrom(resource) }
  }
  return { kind: 'ignored', eventId, eventType }
}

type PaypalMoney = { currency_code?: string; value?: string }
type PaypalCapture = { id: string; status: string; amount?: PaypalMoney; custom_id?: string; invoice_id?: string; orderId?: string; sku?: string }
type PaypalOrder = {
  id?: string
  status?: string
  links?: Array<{ rel?: string; href?: string }>
  purchase_units?: unknown
}

function paidEventFromCapture(capture: PaypalCapture, order: { id?: string; purchase_units?: unknown }, eventId: string, eventType: string, fallbackOrderId: string | null): PaidEvent {
  const amount = readMoney(capture.amount)
  const cents = amount?.value ? minorUnitsFromPaypalValue(amount.value) : null
  const packageId = capture.sku ?? skuFromOrder(order)
  return {
    kind: 'paid',
    eventId,
    eventType,
    orderId: orderIdFrom({ custom_id: capture.custom_id, invoice_id: capture.invoice_id }) ?? fallbackOrderId,
    providerOrderId: capture.orderId ?? str(order.id),
    providerPaymentId: capture.id,
    paidAmount: amount?.value ?? (cents !== null ? minorToDisplay(cents, amount?.currency_code ?? 'USD') : null),
    paidCurrency: amount?.currency_code ?? null,
    paidAmountCents: cents,
    packageId,
    productId: null,
    site: site.domain,
    subscription: null,
  }
}

function completedCapture(order: PaypalOrder): PaypalCapture | null {
  return capturesOf(order).find((capture) => capture.status === 'COMPLETED') ?? null
}

function capturesOf(order: PaypalOrder): PaypalCapture[] {
  const units = Array.isArray(order.purchase_units) ? order.purchase_units : []
  return units.flatMap((unit) => {
    if (!unit || typeof unit !== 'object') return []
    const item = unit as Record<string, unknown>
    const payments = record(item.payments)
    const captures = Array.isArray(payments.captures) ? payments.captures : []
    const sku = skuOf(item)
    return captures.flatMap((capture) => {
      if (!capture || typeof capture !== 'object') return []
      const row = capture as Record<string, unknown>
      const id = str(row.id)
      const status = str(row.status)?.toUpperCase()
      if (!id || !status) return []
      return [{ id, status, amount: readMoney(row.amount) ?? undefined, custom_id: str(row.custom_id) ?? undefined, invoice_id: str(row.invoice_id) ?? undefined, orderId: orderIdOnCapture(row) ?? str(order.id) ?? undefined, sku: sku ?? undefined }]
    })
  })
}

function captureFromResource(resource: Record<string, unknown>): PaypalCapture | null {
  const id = str(resource.id)
  const status = str(resource.status)?.toUpperCase()
  if (!id || !status) return null
  return {
    id,
    status,
    amount: readMoney(resource.amount) ?? undefined,
    custom_id: str(resource.custom_id) ?? undefined,
    invoice_id: str(resource.invoice_id) ?? undefined,
    orderId: orderIdOnCapture(resource) ?? undefined,
    sku: skuOf(resource) ?? undefined,
  }
}

function outcomeOf(order: PaypalOrder): 'completed' | 'pending' | 'declined' | null {
  const captures = capturesOf(order)
  if (captures.some((capture) => capture.status === 'COMPLETED')) return 'completed'
  if (captures.some((capture) => capture.status === 'PENDING')) return 'pending'
  if (captures.some((capture) => capture.status === 'DECLINED' || capture.status === 'FAILED') || order.status === 'VOIDED') return 'declined'
  if (order.status === 'COMPLETED') return 'completed'
  return null
}

async function readPaypalOrder(env: Env, paypalOrderId: string) {
  return paypalJson<PaypalOrder>(env, `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, { method: 'GET' })
}

async function paypalJson<T>(env: Env, path: string, init: { method: string; body?: unknown; requestId?: string }): Promise<T> {
  const base = paypalApiBase(env)
  if (!base) throw new ApiError(503, 'payment_not_configured', 'PayPal API host is not configured')
  const token = await paypalAccessToken(env)
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  })
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  if (init.method !== 'GET') headers.set('Prefer', 'return=representation')
  if (init.requestId) headers.set('PayPal-Request-Id', init.requestId)
  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new ApiError(502, 'payment_provider_error', `PayPal ${path} failed: ${error instanceof Error ? error.name : 'fetch'}`)
  }
  const text = await response.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  if (!response.ok) {
    const issue = issueOf(parsed)
    const message = `PayPal ${path}: HTTP ${response.status}${issue ? ` ${issue}` : ''}`
    if (response.status === 401) throw new ApiError(503, 'payment_not_configured', message)
    if (response.status === 409 || response.status === 422) throw new PaypalRequestError(response.status, issue, message, parsed)
    throw new ApiError(502, 'payment_provider_error', message)
  }
  if (!parsed || typeof parsed !== 'object') throw new ApiError(502, 'payment_provider_error', `PayPal ${path} returned non-JSON`)
  return parsed as T
}

export async function paypalAccessToken(env: Env): Promise<string> {
  assertReady(env)
  const id = paypalClientId(env)!
  const secret = paypalClientSecret(env)!
  const mode = paypalMode(env)!
  const key = `${mode}\n${id}\n${secret}`
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now()) return tokenCache.token
  const base = paypalApiBase(env)!
  let response: Response
  try {
    response = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${encodeBasic(id, secret)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new ApiError(502, 'payment_provider_error', `PayPal token failed: ${error instanceof Error ? error.name : 'fetch'}`)
  }
  const body = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null
  if (!response.ok || !body?.access_token) throw new ApiError(503, 'payment_not_configured', `PayPal token HTTP ${response.status}`)
  const ttl = Math.max(30, (body.expires_in ?? 300) - 60)
  tokenCache = { key, token: body.access_token, expiresAt: Date.now() + ttl * 1000 }
  return body.access_token
}

class PaypalRequestError extends ApiError {
  issue: string | null
  parsed: unknown
  constructor(status: number, issue: string | null, message: string, parsed: unknown) {
    super(status === 409 ? 409 : 502, status === 409 ? 'payment_provider_conflict' : 'payment_provider_error', message)
    this.issue = issue
    this.parsed = parsed
  }
}

function paypalIssue(error: unknown) {
  return error instanceof PaypalRequestError ? error.issue : null
}

function issueOf(parsed: unknown) {
  const details = record(parsed).details
  if (!Array.isArray(details)) return null
  for (const detail of details) {
    const issue = str(record(detail).issue)
    if (issue) return issue
  }
  return str(record(parsed).name)
}

function assertReady(env: Env) {
  if (paypalReady(env)) return
  throw new ApiError(503, 'payment_not_configured', 'PayPal credentials or API host missing')
}

function approvalUrl(order: PaypalOrder) {
  const links = order.links ?? []
  const link = links.find((candidate) => candidate.rel === 'payer-action') ?? links.find((candidate) => candidate.rel === 'approve')
  if (!link?.href) return null
  let parsed: URL
  try {
    parsed = new URL(link.href)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null
  if (!APPROVAL_HOST.test(parsed.hostname)) return null
  parsed.hash = ''
  return parsed.toString()
}

function paypalLocale(successUrl: string) {
  try {
    const path = new URL(successUrl).pathname
    const base = path.split('/').filter(Boolean)[0]
    return PAYPAL_LOCALE_TAGS[base ?? ''] ?? 'en-US'
  } catch {
    return 'en-US'
  }
}

function eventTypeOf(payload: Record<string, unknown>) {
  return str(payload.event_type)?.toUpperCase() ?? ''
}

function isRefundType(eventType: string, resource: Record<string, unknown>) {
  if (eventType === 'PAYMENT.CAPTURE.REFUNDED' || eventType === 'PAYMENT.CAPTURE.REVERSED' || eventType === 'PAYMENT.CAPTURE.PARTIALLY_REFUNDED') {
    const status = str(resource.status)?.toUpperCase()
    return !status || status === 'COMPLETED'
  }
  return false
}

function orderIdFrom(resource: Record<string, unknown>) {
  return str(resource.custom_id) ?? str(resource.invoice_id) ?? orderIdFromUnits(resource)
}

function orderIdFromUnits(resource: Record<string, unknown>) {
  const units = Array.isArray(resource.purchase_units) ? resource.purchase_units : []
  for (const unit of units) {
    const id = str(record(unit).custom_id) ?? str(record(unit).invoice_id)
    if (id) return id
  }
  return null
}

function orderIdOnCapture(resource: Record<string, unknown>) {
  const related = record(record(resource.supplementary_data).related_ids)
  return str(related.order_id)
}

function skuFromOrder(order: { purchase_units?: unknown }) {
  const units = Array.isArray(order.purchase_units) ? order.purchase_units : []
  for (const unit of units) {
    const sku = skuOf(record(unit))
    if (sku) return sku
  }
  return null
}

function skuOf(unit: Record<string, unknown>) {
  const items = Array.isArray(unit.items) ? unit.items : []
  for (const item of items) {
    const sku = str(record(item).sku)
    if (sku) return sku
  }
  return str(unit.reference_id)
}

function captureIdFromRefund(resource: Record<string, unknown>) {
  const direct = str(resource.capture_id)
  if (direct) return direct
  const links = Array.isArray(resource.links) ? resource.links : []
  for (const link of links) {
    const href = str(record(link).href)
    const match = href ? /\/captures\/([^/?]+)/.exec(href) : null
    if (match) return match[1]
  }
  return null
}

function readMoney(value: unknown): PaypalMoney | null {
  if (!value || typeof value !== 'object') return null
  const row = value as { currency_code?: unknown; value?: unknown }
  const currency_code = typeof row.currency_code === 'string' ? row.currency_code : undefined
  const amount = typeof row.value === 'string' ? row.value : undefined
  if (!currency_code && !amount) return null
  return { currency_code, value: amount }
}

function isRsaSha256Algo(value: string) {
  const normalized = value.replace(/[\s_-]/g, '').toLowerCase()
  return normalized === 'sha256withrsa' || normalized === 'sha256withrsaencryption'
}

async function defaultFetchCert(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return undefined
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > CERT_MAX_BYTES) return undefined
    return text
  } catch {
    return undefined
  }
}

async function loadCertificate(url: string) {
  const cached = certCache.get(url)
  if (cached) return cached
  const pem = await certFetcher(url)
  if (!pem?.includes('BEGIN CERTIFICATE')) return undefined
  if (certCache.size >= CERT_CACHE_MAX) {
    const oldest = certCache.keys().next().value
    if (oldest) certCache.delete(oldest)
  }
  certCache.set(url, pem)
  return pem
}

function pemToDer(pem: string) {
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
}

/** 从 X.509 证书 DER 取出 SubjectPublicKeyInfo，供 WebCrypto 验签。不校验证书自身的签名。 */
export function spkiFromCertificateDer(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('not a certificate')
  let cursor = tlvContentOffset(der, 0)
  if (der[cursor] !== 0x30) throw new Error('missing tbsCertificate')
  cursor = tlvContentOffset(der, cursor)
  if (der[cursor] === 0xa0) cursor = skipTlv(der, cursor)
  cursor = skipTlv(der, cursor)
  cursor = skipTlv(der, cursor)
  cursor = skipTlv(der, cursor)
  cursor = skipTlv(der, cursor)
  cursor = skipTlv(der, cursor)
  if (der[cursor] !== 0x30) throw new Error('missing subjectPublicKeyInfo')
  return sliceTlv(der, cursor)
}

function tlvContentOffset(bytes: Uint8Array, offset: number) {
  const { header } = readLength(bytes, offset + 1)
  return offset + 1 + header
}

function skipTlv(bytes: Uint8Array, offset: number) {
  const { length, header } = readLength(bytes, offset + 1)
  return offset + 1 + header + length
}

function sliceTlv(bytes: Uint8Array, offset: number) {
  const { length, header } = readLength(bytes, offset + 1)
  return bytes.slice(offset, offset + 1 + header + length)
}

function readLength(bytes: Uint8Array, offset: number) {
  const first = bytes[offset]
  if (first === undefined) throw new Error('truncated')
  if (first < 0x80) return { length: first, header: 1 }
  const count = first & 0x7f
  if (count === 0 || count > 4) throw new Error('bad length')
  let length = 0
  for (let i = 0; i < count; i += 1) length = (length << 8) | (bytes[offset + 1 + i] ?? 0)
  return { length, header: 1 + count }
}

function encodeBasic(id: string, secret: string) {
  const bytes = new TextEncoder().encode(`${id}:${secret}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function str(value: unknown) {
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null
}

function record(value: unknown) {
  return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
}

// 商品映射可选。PayPal 按订单金额收款，不要求后台里有商品 ID。留着是为了和别的支付商同一套配置入口。
export function paypalProducts(env: Env) {
  return parseJsonRecord(env.PAYPAL_PRODUCTS)
}
