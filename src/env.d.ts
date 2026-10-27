// 可选 secret：没写进 .dev.vars 时 `npm run cf:types` 不会生成它们，这里补上类型
interface Env {
  TURNSTILE_SECRET_KEY?: string
  OPENAI_API_KEY?: string
  YIR_API_KEY?: string
  NANOAPI_API_KEY?: string
  // OpenGen 连接鉴权。不是厂商 Key；厂商 Key 留在 OpenGen 主机。
  OPENGEN_API_KEY?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  PAYMENT_NOTIFY_WEBHOOK_URL?: string
  // 可选。空着则不向 Sentry（或兼容的 envelope 端点）上报，错误仍只进 Workers 日志。
  SENTRY_DSN?: string
  // PayPal.cn（Orders v2）。模式和主机在 wrangler vars；这三个是 secret。
  PAYPAL_CLIENT_ID?: string
  PAYPAL_CLIENT_SECRET?: string
  PAYPAL_WEBHOOK_ID?: string
  // 人工履行队列的 Google Sheet。三个都配才写表；缺了新单仍落 D1。不是厂商 Key。
  // 私钥用服务账号 JSON 里的 private_key（PKCS8）。换行可以写成 \n。表格共享给这个 email，编辑权限。
  // 用第一张工作表的 A:G：created_at, email, template_id, user_image_url, status, result_link, generation_id。
  GOOGLE_SHEETS_SPREADSHEET_ID?: string
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string
}
