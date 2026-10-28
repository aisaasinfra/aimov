// 新的 auto 工单走哪条通道。飞行中的行仍读 generations.provider，不经过这里。
// 日常 auto 只有 OpenGen。fal / yir / nanoapi 只在默认关闭的应急开关里出现，并且不能和 OpenGen 同时配置。
// VIDEO_PROVIDER=fal|yir|nanoapi 不是目标态 auto。

import { cleanSecret, isProduction } from './util'
import { openGenStubEnabled } from './video/opengen'

export const EMERGENCY_PROVIDER_IDS = ['fal', 'yir', 'nanoapi'] as const
export type EmergencyProviderId = (typeof EMERGENCY_PROVIDER_IDS)[number]
export type AutoRouteProvider = 'opengen' | 'mock' | EmergencyProviderId

const NOT_CONFIGURED = 'OpenGen 未配置：需要 OPENGEN_BASE_URL 和 OPENGEN_API_KEY'

export type AutoRoute =
  | { ok: true; provider: AutoRouteProvider; fulfillment: 'opengen' | 'mock' | 'emergency' }
  | { ok: false; status: 503; code: 'emergency_switch_invalid' | 'emergency_switch_conflict' | 'provider_not_configured'; message: string }

export function parseEmergencyProvider(raw: string | undefined): EmergencyProviderId | null | 'invalid' {
  const value = (raw ?? '').trim()
  if (!value) return null
  if ((EMERGENCY_PROVIDER_IDS as readonly string[]).includes(value)) return value as EmergencyProviderId
  return 'invalid'
}

// stub、任一连接密钥、或任一非空 base URL 都算「OpenGen 已接上」。半截配置也算，用来失败关闭应急开关。
export function openGenConnectionConfigured(env: {
  APP_ENV?: string
  OPENGEN_STUB?: string
  OPENGEN_BASE_URL?: string
  OPENGEN_API_KEY?: string
}): boolean {
  if (openGenStubEnabled(env)) return true
  if (cleanSecret(env.OPENGEN_API_KEY)) return true
  return Boolean((env.OPENGEN_BASE_URL ?? '').trim())
}

export function describeAutoRoute(env: Env, settings?: { videoProvider?: string | null } | null): AutoRoute {
  const emergency = parseEmergencyProvider(env.EMERGENCY_VIDEO_PROVIDER)
  if (emergency === 'invalid') {
    return { ok: false, status: 503, code: 'emergency_switch_invalid', message: '应急开关 EMERGENCY_VIDEO_PROVIDER 无效' }
  }
  if (emergency && openGenConnectionConfigured(env)) {
    return {
      ok: false,
      status: 503,
      code: 'emergency_switch_conflict',
      message: '应急开关与 OpenGen 同时配置，已失败关闭。不是未配置。',
    }
  }
  if (emergency) return { ok: true, provider: emergency, fulfillment: 'emergency' }

  const override = settings?.videoProvider
  const selected = typeof override === 'string' && override ? override : (env.VIDEO_PROVIDER ?? '')
  // 应急开关优先于开发 mock。mock 只在 development / preview，且没有应急开关时，给本地和 e2e。
  if (!isProduction(env) && selected === 'mock') return { ok: true, provider: 'mock', fulfillment: 'mock' }

  // 日常 auto。settings 或 VIDEO_PROVIDER 里的 fal / yir / nanoapi 不选为通道。
  if (!openGenConnectionConfigured(env)) {
    return { ok: false, status: 503, code: 'provider_not_configured', message: NOT_CONFIGURED }
  }
  return { ok: true, provider: 'opengen', fulfillment: 'opengen' }
}
