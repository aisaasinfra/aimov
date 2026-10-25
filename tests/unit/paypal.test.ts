import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureApprovedPaypalOrder,
  crc32Decimal,
  createPaypalProvider,
  minorUnitsFromPaypalValue,
  normalizePaypalEvent,
  paypalAmountValue,
  paypalCertUrlAllowed,
  resetPaypalForTests,
  setPaypalCertFetcherForTests,
  spkiFromCertificateDer,
  verifyPaypalWebhook,
} from '#/server/payments/paypal'

const CERT_URL = 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-unit'
const LIVE_CERT_URL = 'https://api.paypal.com/v1/notifications/certs/CERT-live'

function paypalEnv(extra: Record<string, string> = {}): Env {
  return {
    PAYPAL_CLIENT_ID: 'client',
    PAYPAL_CLIENT_SECRET: 'secret',
    PAYPAL_WEBHOOK_ID: 'WH-1',
    PAYPAL_MODE: 'sandbox',
    ...extra,
  } as unknown as Env
}

function derLen(length: number) {
  if (length < 0x80) return [length]
  if (length < 0x100) return [0x81, length]
  return [0x82, (length >> 8) & 0xff, length & 0xff]
}

function tlv(tag: number, content: Uint8Array) {
  const len = derLen(content.length)
  const out = new Uint8Array(1 + len.length + content.length)
  out[0] = tag
  out.set(len, 1)
  out.set(content, 1 + len.length)
  return out
}

function seq(...parts: Uint8Array[]) {
  const body = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    body.set(part, offset)
    offset += part.length
  }
  return tlv(0x30, body)
}

function pemFrom(der: Uint8Array) {
  let binary = ''
  for (const byte of der) binary += String.fromCharCode(byte)
  return `-----BEGIN CERTIFICATE-----\n${btoa(binary)}\n-----END CERTIFICATE-----\n`
}

/** 最小 X.509：tbs 里跳过序列号、算法、签发者、有效期、主体后就是 SPKI。不校验证书自身签名。 */
function wrapSpki(spki: Uint8Array) {
  const empty = tlv(0x30, new Uint8Array())
  const tbs = seq(tlv(0x02, new Uint8Array([1])), empty, empty, empty, empty, spki)
  return seq(tbs, empty, tlv(0x03, new Uint8Array([0])))
}

async function signingMaterial() {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))
  const pem = pemFrom(wrapSpki(spki))
  return { privateKey: keys.privateKey, pem, spki }
}

function b64(bytes: ArrayBuffer) {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function headers(values: Record<string, string>) {
  return new Headers(values)
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const checkoutInput = {
  order: { id: 'ord_1', packageId: 'starter', credits: 20, amountCents: 990, currency: 'USD' },
  user: { id: 'u1', email: 'a@example.com', name: null },
  successUrl: 'https://example.com/zh/checkout/success',
  cancelUrl: 'https://example.com/zh/pricing',
}

beforeEach(() => {
  resetPaypalForTests()
})

afterEach(() => {
  resetPaypalForTests()
  vi.unstubAllGlobals()
})

describe('PayPal 金额与证书地址', () => {
  it('CRC-32 用十进制，官方示例 123456789 是 3421780262', () => {
    expect(crc32Decimal('123456789')).toBe('3421780262')
  })

  it('只收两位小数的币种；日元指数是 0，不能下单', () => {
    expect(paypalAmountValue(990, 'USD')).toBe('9.90')
    expect(paypalAmountValue(5, 'usd')).toBe('0.05')
    expect(paypalAmountValue(0, 'USD')).toBeNull()
    expect(paypalAmountValue(100, 'JPY')).toBeNull()
    expect(minorUnitsFromPaypalValue('9.90')).toBe(990)
    expect(minorUnitsFromPaypalValue('9.9')).toBeNull()
  })

  it('证书地址只允许 PayPal 官方通知证书', () => {
    expect(paypalCertUrlAllowed(CERT_URL)?.href).toBe(CERT_URL)
    expect(paypalCertUrlAllowed(LIVE_CERT_URL)).not.toBeNull()
    expect(paypalCertUrlAllowed('http://api.paypal.com/v1/notifications/certs/CERT-1')).toBeNull()
    expect(paypalCertUrlAllowed('https://user:pw@api.paypal.com/v1/notifications/certs/CERT-1')).toBeNull()
    expect(paypalCertUrlAllowed('https://api.paypal.com:8443/v1/notifications/certs/CERT-1')).toBeNull()
    expect(paypalCertUrlAllowed(`${CERT_URL}?x=1`)).toBeNull()
    expect(paypalCertUrlAllowed('https://evil.example/v1/notifications/certs/CERT-1')).toBeNull()
    expect(paypalCertUrlAllowed('https://api.paypal.com/v1/notifications/certs/not-a-cert')).toBeNull()
  })

  it('可以从合成证书里取出 SPKI', async () => {
    const { spki } = await signingMaterial()
    expect(spkiFromCertificateDer(wrapSpki(spki))).toEqual(spki)
  })
})

describe('verifyPaypalWebhook', () => {
  const body = JSON.stringify({ id: 'WH-9', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-9', status: 'COMPLETED' } })

  async function signed(raw: string, env: Env = paypalEnv(), certUrl = CERT_URL) {
    const material = await signingMaterial()
    setPaypalCertFetcherForTests(async () => material.pem)
    const transmissionId = 'tx-1'
    const transmissionTime = '2026-10-25T00:00:00Z'
    const message = `${transmissionId}|${transmissionTime}|WH-1|${crc32Decimal(raw)}`
    const signature = b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', material.privateKey, new TextEncoder().encode(message)))
    const payload = await verifyPaypalWebhook(
      raw,
      headers({
        'paypal-transmission-id': transmissionId,
        'paypal-transmission-time': transmissionTime,
        'paypal-transmission-sig': signature,
        'paypal-cert-url': certUrl,
        'paypal-auth-algo': 'SHA256withRSA',
      }),
      env,
    )
    return payload
  }

  it('接受官方证书上的 RSA-SHA256 签名', async () => {
    await expect(signed(body)).resolves.toMatchObject({ id: 'WH-9' })
    await expect(signed(body, paypalEnv({ PAYPAL_MODE: 'live' }), LIVE_CERT_URL)).resolves.toMatchObject({ id: 'WH-9' })
  })

  it('拒绝篡改 body、模式不符、占位 webhook id、非官方证书', async () => {
    const material = await signingMaterial()
    setPaypalCertFetcherForTests(async () => material.pem)
    const transmissionId = 'tx-1'
    const transmissionTime = '2026-10-25T00:00:00Z'
    const signature = b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', material.privateKey, new TextEncoder().encode(`${transmissionId}|${transmissionTime}|WH-1|${crc32Decimal(body)}`)))
    const okHeaders = headers({
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-time': transmissionTime,
      'paypal-transmission-sig': signature,
      'paypal-cert-url': CERT_URL,
      'paypal-auth-algo': 'SHA256withRSA',
    })
    await expect(verifyPaypalWebhook(body.replace('CAP-9', 'CAP-8'), okHeaders, paypalEnv())).rejects.toThrow('invalid signature')
    await expect(signed(body, paypalEnv({ PAYPAL_MODE: 'live' }))).rejects.toThrow('mode mismatch')
    await expect(signed(body, paypalEnv({ PAYPAL_WEBHOOK_ID: 'WEBHOOK_ID' }))).rejects.toThrow('PAYPAL_WEBHOOK_ID missing')
    await expect(signed(body, paypalEnv({ PAYPAL_WEBHOOK_ID: '' }))).rejects.toThrow('PAYPAL_WEBHOOK_ID missing')
    let fetched = false
    setPaypalCertFetcherForTests(async () => {
      fetched = true
      return '-----BEGIN CERTIFICATE-----\nYQ==\n-----END CERTIFICATE-----'
    })
    await expect(
      verifyPaypalWebhook(
        body,
        headers({
          'paypal-transmission-id': 'tx-1',
          'paypal-transmission-time': '2026-10-25T00:00:00Z',
          'paypal-transmission-sig': 'YQ==',
          'paypal-cert-url': 'https://evil.example/cert.pem',
          'paypal-auth-algo': 'SHA256withRSA',
        }),
        paypalEnv(),
      ),
    ).rejects.toThrow('paypal cert url rejected')
    expect(fetched).toBe(false)
  })

  it('拒绝缺头、错误算法和签过名但不是 JSON 的 body', async () => {
    await expect(verifyPaypalWebhook(body, headers({ 'paypal-auth-algo': 'SHA256withRSA' }), paypalEnv())).rejects.toThrow('missing paypal transmission headers')
    const material = await signingMaterial()
    setPaypalCertFetcherForTests(async () => material.pem)
    const raw = 'not-json'
    const message = `tx-1|2026-10-25T00:00:00Z|WH-1|${crc32Decimal(raw)}`
    const signature = b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', material.privateKey, new TextEncoder().encode(message)))
    await expect(
      verifyPaypalWebhook(
        raw,
        headers({
          'paypal-transmission-id': 'tx-1',
          'paypal-transmission-time': '2026-10-25T00:00:00Z',
          'paypal-transmission-sig': signature,
          'paypal-cert-url': CERT_URL,
          'paypal-auth-algo': 'SHA1withRSA',
        }),
        paypalEnv(),
      ),
    ).rejects.toThrow('missing paypal transmission headers')
  })
})

describe('normalizePaypalEvent', () => {
  it('CAPTURE.COMPLETED 入账；APPROVED、订阅和未完成的 capture 忽略；退款和拒付分开', () => {
    const paid = normalizePaypalEvent({
      id: 'WH-9',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP-9',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '9.90' },
        custom_id: 'ord_1',
        supplementary_data: { related_ids: { order_id: 'EC-9' } },
        items: [{ sku: 'starter' }],
      },
    })
    expect(paid).toMatchObject({
      kind: 'paid',
      eventId: 'WH-9',
      orderId: 'ord_1',
      providerOrderId: 'EC-9',
      providerPaymentId: 'CAP-9',
      paidAmountCents: 990,
      paidCurrency: 'USD',
      packageId: 'starter',
      productId: null,
      subscription: null,
    })
    expect(normalizePaypalEvent({ id: 'WH-a', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'EC-1', status: 'APPROVED' } })).toMatchObject({
      kind: 'ignored',
      eventId: 'WH-a',
    })
    expect(normalizePaypalEvent({ id: 'WH-s', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource_type: 'subscription', resource: { id: 'I-1' } })).toMatchObject({
      kind: 'ignored',
    })
    expect(normalizePaypalEvent({ id: 'WH-p', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-p', status: 'PENDING' } })).toMatchObject({ kind: 'ignored' })
    expect(
      normalizePaypalEvent({
        id: 'WH-r',
        event_type: 'PAYMENT.CAPTURE.PARTIALLY_REFUNDED',
        resource: { id: 'RF-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '3.30' }, custom_id: 'ord_1', capture_id: 'CAP-9' },
      }),
    ).toMatchObject({ kind: 'refunded', refundId: 'RF-1', refundAmountCents: 330, providerPaymentId: 'CAP-9', orderId: 'ord_1' })
    expect(normalizePaypalEvent({ id: 'WH-d', event_type: 'PAYMENT.CAPTURE.DENIED', resource: { id: 'CAP-d', custom_id: 'ord_1' } })).toMatchObject({
      kind: 'failed',
      orderId: 'ord_1',
    })
  })
})

describe('createPaypalProvider', () => {
  it('只接受 paypal.com / paypal.cn 的审批地址，并按订单金额建数字商品', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'tok', expires_in: 300 })
      bodies.push(JSON.parse(String(init?.body)))
      expect(new Headers(init?.headers).get('PayPal-Request-Id')).toBe('ord_1')
      const href = url.includes('evil') ? 'https://evil.example/pay' : 'https://www.paypal.cn/checkoutnow?token=EC-1'
      return json({ id: 'EC-1', links: [{ rel: 'payer-action', href }] })
    })
    const provider = createPaypalProvider(paypalEnv())
    await expect(provider.createCheckout(checkoutInput)).resolves.toEqual({
      url: 'https://www.paypal.cn/checkoutnow?token=EC-1',
      sessionId: 'EC-1',
    })
    expect(bodies[0]).toMatchObject({
      intent: 'CAPTURE',
      purchase_units: [{ custom_id: 'ord_1', invoice_id: 'ord_1', reference_id: 'starter', items: [{ category: 'DIGITAL_GOODS', sku: 'starter' }] }],
      payment_source: { paypal: { experience_context: { shipping_preference: 'NO_SHIPPING', locale: 'zh-CN' } } },
    })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'tok', expires_in: 300 })
      return json({ id: 'EC-2', links: [{ rel: 'approve', href: 'https://evil.example/pay' }] })
    })
    await expect(provider.createCheckout(checkoutInput)).rejects.toMatchObject({ status: 502, code: 'payment_provider_error' })
    await expect(provider.createCheckout({ ...checkoutInput, order: { ...checkoutInput.order, currency: 'JPY', amountCents: 100 } })).rejects.toMatchObject({
      code: 'payment_not_configured',
    })
  })

  it('APPROVED 会去 capture；已经 capture 过则再读订单', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'tok', expires_in: 300 })
      if (url.endsWith('/capture')) return json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, 422)
      return json({
        id: 'EC-1',
        status: 'COMPLETED',
        purchase_units: [
          {
            reference_id: 'starter',
            payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '9.90' }, custom_id: 'ord_1' }] },
          },
        ],
      })
    })
    await captureApprovedPaypalOrder(paypalEnv(), { event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'EC-1', status: 'APPROVED' } })
    expect(calls.some((call) => call.startsWith('POST') && call.includes('/v2/checkout/orders/EC-1/capture'))).toBe(true)
    expect(calls.some((call) => call.startsWith('GET') && call.includes('/v2/checkout/orders/EC-1'))).toBe(true)
  })

  it('查单：APPROVED 先 capture，完成后用 reconcile 事件入账', async () => {
    let reads = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'tok', expires_in: 300 })
      if (url.endsWith('/capture') || (init?.method === 'GET' && reads++ > 0)) {
        return json({
          id: 'EC-1',
          status: 'COMPLETED',
          purchase_units: [
            {
              reference_id: 'starter',
              payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '9.90' }, custom_id: 'ord_1' }] },
            },
          ],
        })
      }
      return json({ id: 'EC-1', status: 'APPROVED', purchase_units: [{ reference_id: 'starter' }] })
    })
    const provider = createPaypalProvider(paypalEnv())
    await expect(provider.fetchPaidEvent!({ id: 'ord_1', packageId: 'starter', providerSessionId: null })).resolves.toBeNull()
    const lookup = await provider.fetchPaidEvent!({ id: 'ord_1', packageId: 'starter', providerSessionId: 'EC-1' })
    expect(lookup?.event).toMatchObject({ kind: 'paid', eventId: 'reconcile:CAP-1', orderId: 'ord_1', providerPaymentId: 'CAP-1', paidAmountCents: 990, packageId: 'starter' })
  })
})
