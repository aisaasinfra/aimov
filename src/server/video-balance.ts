import { cleanSecret } from './util'
import { describeAutoRoute } from './auto-route'
import type { VideoProviderId } from './video/types'
import { getSettings } from './settings'

// 视频服务商余额查询：Cron 健康检查（alerts.ts）用。只发一次只读 GET，不回显密钥。
// OpenGen 没有余额接口：明确返回 unsupported，不要落到 yir。
// 后台“测试连接”仍走 probes.ts 自己的探测，避免改 OpenGen 健康检查。

export interface VideoBalance {
  provider: string
  amount: number
  currency: string
}

export type BalanceQuery =
  | { status: 'mock' }
  | { status: 'unsupported' }
  | { status: 'no_key'; keyName: string }
  | { status: 'unauthorized'; keyName: string }
  // 只有 fal：Key 有效但权限范围不含 billing:usage:read
  | { status: 'forbidden'; keyName: string }
  | { status: 'http'; code: number }
  | { status: 'unreadable' }
  | ({ status: 'ok' } & VideoBalance)

function readBalance(provider: string, amount: unknown, currency: unknown): BalanceQuery {
  const value = Number(amount)
  return Number.isFinite(value) ? { status: 'ok', provider, amount: value, currency: String(currency ?? 'USD') } : { status: 'unreadable' }
}

async function providerForBalance(env: Env): Promise<VideoProviderId> {
  try {
    const settings = env.DB && env.KV ? await getSettings(env) : null
    const route = describeAutoRoute(env, settings)
    if (route.ok) return route.provider
  } catch (error) {
    console.error('[alert] video provider resolve failed', error instanceof Error ? error.message : String(error))
  }
  // 日常 auto 解析失败时不要去查 fal / yir / nanoapi 余额。
  return 'opengen'
}

export async function queryVideoBalance(env: Env, providerId?: VideoProviderId): Promise<BalanceQuery> {
  const id = providerId ?? (await providerForBalance(env))
  if (id === 'mock') return { status: 'mock' }
  if (id === 'opengen') return { status: 'unsupported' }
  if (id === 'fal') {
    const key = cleanSecret(env.FAL_KEY)
    if (!key) return { status: 'no_key', keyName: 'FAL_KEY' }
    const response = await fetch('https://api.fal.ai/v1/account/billing?expand=credits', { headers: { Authorization: `Key ${key}` } })
    if (response.status === 401) return { status: 'unauthorized', keyName: 'FAL_KEY' }
    if (response.status === 403) return { status: 'forbidden', keyName: 'FAL_KEY' }
    if (!response.ok) return { status: 'http', code: response.status }
    const body = (await response.json().catch(() => null)) as { credits?: { current_balance?: unknown; currency?: unknown } } | null
    return readBalance('fal', body?.credits?.current_balance, body?.credits?.currency)
  }
  if (id === 'nanoapi') {
    const key = cleanSecret(env.NANOAPI_API_KEY)
    if (!key) return { status: 'no_key', keyName: 'NANOAPI_API_KEY' }
    const response = await fetch('https://api.nanoapi.ai/v1/balance', { headers: { Authorization: `Bearer ${key}` } })
    if (response.status === 401) return { status: 'unauthorized', keyName: 'NANOAPI_API_KEY' }
    if (!response.ok) return { status: 'http', code: response.status }
    const body = (await response.json().catch(() => null)) as { data?: { available?: unknown; currency?: unknown } } | null
    return readBalance('NanoAPI', body?.data?.available, body?.data?.currency)
  }
  if (id !== 'yir') return { status: 'unsupported' }
  const key = cleanSecret(env.YIR_API_KEY)
  if (!key) return { status: 'no_key', keyName: 'YIR_API_KEY' }
  const response = await fetch('https://gateway.yir.ai/v1/balance', { headers: { Authorization: `Bearer ${key}` } })
  if (response.status === 401) return { status: 'unauthorized', keyName: 'YIR_API_KEY' }
  if (!response.ok) return { status: 'http', code: response.status }
  const body = (await response.json().catch(() => null)) as { available_amount?: unknown; currency?: unknown } | null
  return readBalance('yir', body?.available_amount, body?.currency)
}

// 查到余额返回 { provider, amount, currency }；mock、OpenGen、没配 Key、Key 无效、没权限或读不到时返回 null。
// 网络错误和 HTTP 非 2xx 会抛出，由调用方记日志。
export async function fetchVideoBalance(env: Env): Promise<VideoBalance | null> {
  const result = await queryVideoBalance(env)
  if (result.status === 'http') throw new Error(`video balance HTTP ${result.code}`)
  return result.status === 'ok' ? { provider: result.provider, amount: result.amount, currency: result.currency } : null
}
