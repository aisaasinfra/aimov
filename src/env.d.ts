// 可选 secret：没写进 .dev.vars 时 `npm run cf:types` 不会生成它们，这里补上类型
interface Env {
  TURNSTILE_SECRET_KEY?: string
  OPENAI_API_KEY?: string
  YIR_API_KEY?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  PAYMENT_NOTIFY_WEBHOOK_URL?: string
  // PayPal.cn（Orders v2）。模式和主机在 wrangler vars；这三个是 secret。
  PAYPAL_CLIENT_ID?: string
  PAYPAL_CLIENT_SECRET?: string
  PAYPAL_WEBHOOK_ID?: string
}
