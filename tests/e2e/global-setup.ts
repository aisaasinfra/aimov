import type { FullConfig } from '@playwright/test'
import { site } from '../../src/config/site'

// mock 生成会直接复用 R2 里的模板源视频；没 seed 时尽早给出明确提示。
// 产品默认履行是 manual（不入队）。这套 e2e 仍要走 mock 自动出片，所以开跑前把站点拨到 auto。
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]!.use.baseURL!
  const response = await fetch(`${baseURL}/media/templates/${site.durations[0]!.source}`, { method: 'HEAD' })
  if (!response.ok) {
    throw new Error(`模板视频不可用（HTTP ${response.status}），请先运行 npm run seed:local`)
  }
  const login = await fetch(`${baseURL}/api/auth/dev-login`, {
    method: 'POST',
    headers: { origin: baseURL, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com' }),
  })
  if (!login.ok) throw new Error(`e2e 无法用管理员登录来设置履行方式（HTTP ${login.status}）`)
  const sid = /(?:^|,\s*)sid=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]
  if (!sid) throw new Error('e2e 管理员登录没有返回 sid')
  const saved = await fetch(`${baseURL}/api/admin/settings`, {
    method: 'POST',
    headers: { origin: baseURL, 'content-type': 'application/json', cookie: `sid=${sid}` },
    body: JSON.stringify({ values: { fulfillmentMode: 'auto' } }),
  })
  if (!saved.ok) throw new Error(`e2e 无法把 fulfillmentMode 设为 auto（HTTP ${saved.status}）`)
}
