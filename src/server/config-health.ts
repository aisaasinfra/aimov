// 上线配置检查：部署前的 `npm run doctor`（scripts/doctor.mjs，按 wrangler 配置和 `wrangler secret list` 的名字检查）
// 与后台概览的“配置检查”卡片（按运行时 env 检查）共用这一套规则。只报告缺什么、错在哪，不输出任何密钥值。
// 本文件不能有 import：scripts/doctor.mjs 用 Node 直接加载 .ts 源码。

export type ConfigLevel = 'error' | 'warn'
export interface ConfigIssue {
  level: ConfigLevel
  key: string
  message: string
}

export interface ConfigInput {
  vars: Record<string, string | undefined>
  // 运行时传入密钥的值（可额外检查强度）；doctor 只知道名字，已配置的传 true
  secrets: Record<string, string | true | undefined>
  bindings: readonly string[]
  packageIds: readonly string[]
  // 在售的订阅套餐 id（sellingPlans，订阅开关关掉时为空），同样要在 *_PRODUCTS 里有商品
  planIds?: readonly string[]
  siteDomain: string
  // doctor 在没核对或查不到 secret 列表时，会把每个名字都当成已配置。这时不要把厂商密钥报成“确实在 Worker 上”。
  secretsAssumed?: boolean
}

// .dev.vars.example 里的占位值：模板公开后人人都知道，生产环境不能用
export const EXAMPLE_SESSION_SECRET = 'change-me-to-a-long-random-string'

// 与 src/server/sentry.ts 的 parseSentryDsn 同一格式。空 DSN 表示关闭，不在这里报错。
export const SENTRY_DSN_PATTERN = /^https:\/\/([0-9a-f]+)@([A-Za-z0-9.-]+)\/([0-9]+)$/i

export function isSentryDsn(value: string) {
  return SENTRY_DSN_PATTERN.test(value.trim())
}
export const REQUIRED_BINDINGS = [
  'DB',
  'MEDIA',
  'KV',
  'VIDEO_QUEUE',
  'EMAIL',
  'ASSETS',
  'UPLOAD_LIMITER',
  'GENERATE_LIMITER',
  'AUTH_LIMITER',
] as const

export function isWeakSessionSecret(secret: string) {
  return secret.length < 32 || secret === EXAMPLE_SESSION_SECRET
}

const PAYMENT_SECRETS: Record<string, string[]> = {
  waffo: ['WAFFO_MERCHANT_ID', 'WAFFO_PRIVATE_KEY'],
  paypal: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'],
  dodo: ['DODO_API_KEY', 'DODO_WEBHOOK_SECRET'],
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
}
const PAYPAL_HOSTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
}
// opengen 只检查连接信息（OPENGEN_API_KEY），不把厂商 Key 放进必填清单。URL 在下面单独查。
const VIDEO_SECRETS: Record<string, string[]> = { fal: ['FAL_KEY'], yir: ['YIR_API_KEY'], nanoapi: ['NANOAPI_API_KEY'], opengen: ['OPENGEN_API_KEY'] }
const MODERATION_SECRETS: Record<string, string[]> = { openai: ['OPENAI_API_KEY'], none: [] }
const PLACEHOLDER_HOSTS = /(^|\.)(example\.(com|org|net)|localhost)$|^127\.|SUBDOMAIN/i

const text = (value: string | undefined) => value?.replace(/^\uFEFF+/, '').trim() ?? ''

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

// 同一站点：完全相同，或一方是另一方的子域名（www.、发信子域名等）
const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)

export function checkConfig(input: ConfigInput): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const error = (key: string, message: string) => issues.push({ level: 'error', key, message })
  const warn = (key: string, message: string) => issues.push({ level: 'warn', key, message })
  const vars = (name: string) => text(input.vars[name])
  const requireSecrets = (names: string[], reason: string) => {
    for (const name of names) {
      const value = input.secrets[name]
      if (value === true) continue
      if (!text(value)) error(name, `缺少密钥 ${name}（${reason}），用 wrangler secret put 写入`)
    }
  }

  const appEnv = vars('APP_ENV')
  const production = appEnv === 'production'
  if (appEnv !== 'production' && appEnv !== 'staging') {
    error('APP_ENV', `APP_ENV=${appEnv || '(空)'}：上线必须是 production（预发用 staging），否则 Cookie 不带 Secure，mock 和开发登录不会被拦截`)
  }

  const siteUrl = vars('SITE_URL')
  const host = hostOf(siteUrl)
  if (!host || !siteUrl.startsWith('https://')) {
    error('SITE_URL', `SITE_URL=${siteUrl || '(空)'}：必须是 https 的站点地址`)
  } else if (PLACEHOLDER_HOSTS.test(host)) {
    error('SITE_URL', `SITE_URL 仍是占位地址（${host}）`)
  } else if (production && !sameSite(host, input.siteDomain.toLowerCase())) {
    error('SITE_URL', `SITE_URL 的域名 ${host} 与 site.domain（${input.siteDomain}）不一致：canonical、sitemap 和 CSRF 同源校验都依赖它们一致`)
  }
  if (production && PLACEHOLDER_HOSTS.test(input.siteDomain)) {
    error('site.domain', `src/config/site.ts 的 domain 仍是占位值（${input.siteDomain}）`)
  }

  const missingBindings = REQUIRED_BINDINGS.filter((name) => !input.bindings.includes(name))
  if (missingBindings.length) error('bindings', `缺少绑定：${missingBindings.join('、')}`)

  // 只有 Google 登录：不配就没人能登录
  if (!vars('GOOGLE_CLIENT_ID')) error('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID 为空：站点只有 Google 登录，用户无法登录')
  else requireSecrets(['GOOGLE_CLIENT_SECRET'], 'Google 登录')

  const sessionSecret = input.secrets.SESSION_SECRET
  if (typeof sessionSecret === 'string' && text(sessionSecret) && isWeakSessionSecret(text(sessionSecret))) {
    error('SESSION_SECRET', 'SESSION_SECRET 短于 32 个字符或仍是示例值：生成任务提交不出去，上传图片地址返回 503')
  } else {
    requireSecrets(['SESSION_SECRET'], '签名图片地址和视频服务商回调')
  }

  const payment = vars('PAYMENT_PROVIDER')
  if (payment === 'mock') error('PAYMENT_PROVIDER', 'PAYMENT_PROVIDER=mock：生产环境下单会返回 503')
  else if (!PAYMENT_SECRETS[payment]) error('PAYMENT_PROVIDER', `未知的 PAYMENT_PROVIDER=${payment || '(空)'}，可选 waffo、paypal、dodo、stripe`)
  else {
    requireSecrets(PAYMENT_SECRETS[payment], `${payment} 支付`)
    const productsKey = `${payment.toUpperCase()}_PRODUCTS`
    let products: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(vars(productsKey) || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) products = parsed as Record<string, unknown>
      else error(productsKey, `${productsKey} 必须是 JSON 对象`)
    } catch {
      error(productsKey, `${productsKey} 不是合法 JSON`)
    }
    const planIds = input.planIds ?? []
    // PayPal 按订单金额收积分包，不要求后台商品目录。订阅不走这条通道。
    if (payment !== 'paypal') {
      const missing = input.packageIds.filter((id) => typeof products[id] !== 'string' || !products[id])
      if (missing.length) error(productsKey, `${productsKey} 缺少积分包的商品 id：${missing.join('、')}`)
      const missingPlans = planIds.filter((id) => typeof products[id] !== 'string' || !products[id])
      if (missingPlans.length) error(productsKey, `${productsKey} 缺少订阅套餐的商品 id：${missingPlans.join('、')}（订阅商品要按周期单独建）`)
    }
    // Waffo 的客户门户（换卡、恢复订阅）要店铺 ID；没有它扣款失败的用户无法自助更新付款方式
    if (payment === 'waffo' && planIds.length && !vars('WAFFO_STORE_ID')) {
      error('WAFFO_STORE_ID', 'WAFFO_STORE_ID 为空：开了订阅时，账单页的“管理付款”打不开，扣款失败的用户无法换卡')
    }
    const hook = input.secrets.PAYPAL_WEBHOOK_ID
    if (payment === 'paypal' && typeof hook === 'string' && text(hook) === 'WEBHOOK_ID') {
      error('PAYPAL_WEBHOOK_ID', 'PAYPAL_WEBHOOK_ID 仍是占位值 WEBHOOK_ID，验签会拒绝所有回调')
    }
    const modeRaw = vars('PAYPAL_MODE')
    const paypalMode = (modeRaw || 'sandbox').toLowerCase()
    if ((payment === 'paypal' || modeRaw) && paypalMode !== 'sandbox' && paypalMode !== 'live') {
      error('PAYPAL_MODE', `PAYPAL_MODE=${modeRaw}：只能是 sandbox 或 live`)
    }
    const paypalBase = vars('PAYPAL_API_BASE').replace(/\/+$/, '')
    if (paypalBase) {
      const expected = paypalMode === 'live' ? PAYPAL_HOSTS.live : paypalMode === 'sandbox' ? PAYPAL_HOSTS.sandbox : ''
      if (!expected || paypalBase !== expected) error('PAYPAL_API_BASE', `PAYPAL_API_BASE 只能是官方主机${expected ? ` ${expected}` : ''}`)
    }
    const live = payment === 'waffo' ? ['prod', 'production'].includes(vars('WAFFO_ENVIRONMENT')) : payment === 'paypal' ? paypalMode === 'live' : vars(`${payment.toUpperCase()}_ENVIRONMENT`) === 'live'
    const envKey = payment === 'paypal' ? 'PAYPAL_MODE' : `${payment.toUpperCase()}_ENVIRONMENT`
    // Stripe 的 test / live Key 前缀不同（sk_test_、rk_test_ / sk_live_、rk_live_），和 STRIPE_ENVIRONMENT 不符时 webhook 的 livemode 核对会拒收所有事件
    const stripeKey = input.secrets.STRIPE_SECRET_KEY
    if (payment === 'stripe' && typeof stripeKey === 'string' && text(stripeKey)) {
      const keyMode = /^(sk|rk)_live_/.test(text(stripeKey)) ? 'live' : /^(sk|rk)_test_/.test(text(stripeKey)) ? 'test' : null
      if (!keyMode) error('STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY 不是 sk_ 或 rk_ 开头的 Stripe 密钥')
      else if (keyMode !== (live ? 'live' : 'test')) error('STRIPE_SECRET_KEY', `STRIPE_SECRET_KEY 是 ${keyMode} 模式的 Key，但 STRIPE_ENVIRONMENT=${vars('STRIPE_ENVIRONMENT') || '(空)'}`)
    }
    if (production && !live) warn(envKey, `${envKey}=${vars(envKey) || '(空)'}：仍是 test 模式，不会真实收款`)
    if (!production && live) warn(envKey, `${envKey} 是正式模式，但 APP_ENV 不是 production：预发应使用 test 店铺`)
  }

  // 日常 auto 只认 OpenGen。下面的规则是内联的，本文件不能 import。
  // 没有 error 也不等于生产收口完成，更不能把隧道、本机或 stub 说成④就绪。
  const video = vars('VIDEO_PROVIDER')
  const emergency = vars('EMERGENCY_VIDEO_PROVIDER')
  const emergencyIds = ['fal', 'yir', 'nanoapi']
  const vendorSecretNames = [
    ['fal', 'FAL_KEY'],
    ['yir', 'YIR_API_KEY'],
    ['nanoapi', 'NANOAPI_API_KEY'],
  ] as const
  const secretPresent = (name: string) => {
    const value = input.secrets[name]
    if (value === true) return true
    return Boolean(text(typeof value === 'string' ? value : undefined))
  }
  const opengenConfigured = Boolean(vars('OPENGEN_BASE_URL') || secretPresent('OPENGEN_API_KEY') || vars('OPENGEN_STUB') === '1')
  const baseClass = (raw: string) => {
    let url: URL | null = null
    try {
      url = raw ? new URL(raw) : null
    } catch {
      url = null
    }
    if (!url) return 'invalid'
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.local')) return 'local'
    if (/trycloudflare\.com|ngrok|loca\.lt|localhost\.run|localtunnel/i.test(host)) return 'tunnel'
    return 'public'
  }

  if (emergency && !emergencyIds.includes(emergency)) error('EMERGENCY_VIDEO_PROVIDER', '应急开关 EMERGENCY_VIDEO_PROVIDER 无效')
  else if (emergency && opengenConfigured) error('EMERGENCY_VIDEO_PROVIDER', '应急开关与 OpenGen 同时配置，已失败关闭。不是未配置。')
  else if (emergency) {
    const secretName = emergency === 'fal' ? 'FAL_KEY' : emergency === 'yir' ? 'YIR_API_KEY' : 'NANOAPI_API_KEY'
    if (!secretPresent(secretName)) error(secretName, `应急开关指向 ${emergency}，但 ${secretName} 未配置`)
    warn('EMERGENCY_VIDEO_PROVIDER', `应急开关已打开（${emergency}），只作用于新订单，不是日常 auto。`)
    if (!input.secretsAssumed) {
      for (const [id, name] of vendorSecretNames) {
        if (id !== emergency && secretPresent(name)) warn(name, `${name} 仍在 Worker 上。应急窗口里最多一个站内厂商。`)
      }
    }
  } else if (!input.secretsAssumed) {
    for (const [, name] of vendorSecretNames) {
      if (secretPresent(name)) warn(name, `${name} 仍在 Worker 上。日常 auto 不应携带厂商密钥，应急开关当前关闭。`)
    }
  }

  if (video === 'mock') error('VIDEO_PROVIDER', 'VIDEO_PROVIDER=mock：生产环境提交生成会返回 503')
  else if (video === 'opengen') {
    requireSecrets(VIDEO_SECRETS.opengen, 'OpenGen 视频生成')
    const base = vars('OPENGEN_BASE_URL')
    let baseHost: string | null = null
    let baseUrl: URL | null = null
    try {
      baseUrl = base ? new URL(base) : null
      baseHost = baseUrl?.hostname ?? null
    } catch {
      baseHost = null
    }
    if (!base || !baseHost || !baseUrl || baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search) {
      error('OPENGEN_BASE_URL', 'OPENGEN_BASE_URL 未配置或不是不含密钥的 https 地址：Worker 必须能访问该端点。这是连接信息，不是厂商 Key')
    }
    if (vars('OPENGEN_STUB') === '1') error('OPENGEN_STUB', 'OPENGEN_STUB=1：联调 stub 不能用于 staging 或 production')
  } else if (video === 'fal' || video === 'yir' || video === 'nanoapi') {
    warn('VIDEO_PROVIDER', `VIDEO_PROVIDER=${video} 不是目标态 auto。日常 auto 只提交 OpenGen，不因此要求厂商密钥。`)
  } else error('VIDEO_PROVIDER', `未知的 VIDEO_PROVIDER=${video || '(空)'}。日常 auto 应为 opengen`)

  const openGenBase = vars('OPENGEN_BASE_URL')
  const hostClass = baseClass(openGenBase)
  if (openGenBase && (hostClass === 'local' || hostClass === 'tunnel')) {
    warn('OPENGEN_BASE_URL', 'OPENGEN_BASE_URL 指向本机或隧道。这不是生产就绪，也不是④。')
  }

  const moderation = vars('MODERATION_PROVIDER')
  if (moderation === 'mock') error('MODERATION_PROVIDER', 'MODERATION_PROVIDER=mock：生产环境上传图片一律返回 503')
  else if (!MODERATION_SECRETS[moderation]) error('MODERATION_PROVIDER', `未知的 MODERATION_PROVIDER=${moderation || '(空)'}，可选 openai、none`)
  else if (moderation === 'none') warn('MODERATION_PROVIDER', 'MODERATION_PROVIDER=none：上传图片不做审核')
  else requireSecrets(MODERATION_SECRETS[moderation], '图片审核')

  if (vars('TURNSTILE_SITE_KEY')) requireSecrets(['TURNSTILE_SECRET_KEY'], 'Turnstile')
  else warn('TURNSTILE_SITE_KEY', 'TURNSTILE_SITE_KEY 为空：留言、举报和等待列表没有人机校验，只靠限流')

  // 可选。doctor 只知道 secret 是否存在（值为 true），格式要等运行时拿到字符串再查。不合法就保持关闭，不阻断上线。
  const sentry = input.secrets.SENTRY_DSN
  if (typeof sentry === 'string' && text(sentry) && !isSentryDsn(sentry)) {
    warn('SENTRY_DSN', 'SENTRY_DSN 不是 https://<key>@<host>/<project>：错误上报保持关闭')
  }

  // 付款即时通知（可选）：只检查格式，不输出地址（里面带 token）
  const chat = input.secrets.PAYMENT_NOTIFY_WEBHOOK_URL
  if (typeof chat === 'string' && text(chat)) {
    const chatHost = hostOf(text(chat))
    if (!chatHost || !text(chat).startsWith('https://')) {
      warn('PAYMENT_NOTIFY_WEBHOOK_URL', 'PAYMENT_NOTIFY_WEBHOOK_URL 不是 https 地址：付款通知发不出去')
    } else if (chatHost === 'api.telegram.org' && !/[?&]chat_id=[^&]/.test(text(chat))) {
      warn('PAYMENT_NOTIFY_WEBHOOK_URL', 'PAYMENT_NOTIFY_WEBHOOK_URL 是 Telegram 地址但没带 chat_id：付款通知发不出去')
    }
  }

  const admins = vars('ADMIN_EMAILS')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
  if (!admins.length) error('ADMIN_EMAILS', 'ADMIN_EMAILS 为空：没有管理员，举报、留言提醒和系统告警无人接收')
  else if (admins.some((email) => PLACEHOLDER_HOSTS.test(email.split('@')[1] ?? ''))) {
    warn('ADMIN_EMAILS', 'ADMIN_EMAILS 含占位邮箱（example.com 等）：发往它的提醒和告警收不到')
  }

  const from = vars('EMAIL_FROM')
  const fromDomain = from.split('@')[1]?.toLowerCase() ?? ''
  if (!from) warn('EMAIL_FROM', 'EMAIL_FROM 为空：不发交易邮件和管理员提醒')
  else if (!fromDomain || PLACEHOLDER_HOSTS.test(fromDomain)) error('EMAIL_FROM', `EMAIL_FROM=${from}：不是可发信的地址`)
  else if (production && !PLACEHOLDER_HOSTS.test(input.siteDomain) && !sameSite(fromDomain, input.siteDomain.toLowerCase())) {
    warn('EMAIL_FROM', `EMAIL_FROM 的域名 ${fromDomain} 与站点域名 ${input.siteDomain} 不同：确认该域名已在 Email Service 完成 Onboard`)
  }

  // 履行默认 manual。Sheet 只是人工镜像，缺密钥不阻断上线：新单仍落 D1。三个都要有，只配一部分也提醒。
  const sheetSecrets = ['GOOGLE_SHEETS_SPREADSHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'] as const
  const missingSheets = sheetSecrets.filter((name) => {
    const value = input.secrets[name]
    if (value === true) return false
    return !text(typeof value === 'string' ? value : undefined)
  })
  if (missingSheets.length) {
    warn(
      'GOOGLE_SHEETS',
      `人工履约默认是 manual，Sheet 镜像还缺 ${missingSheets.join('、')}。新单仍写入 D1，同步失败记在 provider_meta.sheetError，配齐后可在后台重试`,
    )
  }

  return issues
}
