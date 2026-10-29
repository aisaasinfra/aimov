// 新的 auto 工单在 Yir / FAL / OpenGen 中三选一（选哪个走哪个）。
// 飞行中的行仍读 generations.provider，不经过这里。
// settings.videoProvider 覆盖优先于 env.VIDEO_PROVIDER。
// EMERGENCY_VIDEO_PROVIDER 不参与选路，也不再因为和 OpenGen 同时存在而拒绝新单。
// nanoapi 适配器仍在，供在途工单使用，但不进入日常三选一（是否并入待确认）。

import { cleanSecret, isProduction } from './util'
import { describeOpenGenConfig } from './video/opengen'

export type AutoRouteProvider = 'yir' | 'fal' | 'opengen' | 'mock'

export type AutoRoute =
  | { ok: true; provider: AutoRouteProvider; fulfillment: AutoRouteProvider }
  | { ok: false; status: 503; code: 'provider_not_configured'; provider: string; message: string }

function allow(provider: AutoRouteProvider): AutoRoute {
  return { ok: true, provider, fulfillment: provider }
}

function reject(provider: string, message: string): AutoRoute {
  return { ok: false, status: 503, code: 'provider_not_configured', provider, message }
}

export function describeAutoRoute(env: Env, settings?: { videoProvider?: string | null } | null): AutoRoute {
  const override = settings?.videoProvider
  const selected = (typeof override === 'string' && override.trim() ? override.trim() : (env.VIDEO_PROVIDER ?? '').trim())

  if (selected === 'mock' && !isProduction(env)) return allow('mock')

  if (selected === 'yir') {
    if (!cleanSecret(env.YIR_API_KEY)) return reject('yir', 'Yir 未配置：需要 YIR_API_KEY')
    return allow('yir')
  }
  if (selected === 'fal') {
    if (!cleanSecret(env.FAL_KEY)) return reject('fal', 'FAL 未配置：需要 FAL_KEY')
    return allow('fal')
  }
  if (selected === 'opengen') {
    const config = describeOpenGenConfig(env)
    if (config.mode === 'missing') return reject('opengen', config.message)
    return allow('opengen')
  }
  if (selected === 'nanoapi') {
    return reject('nanoapi', 'nanoapi 未配置为日常渠道。请在 Yir、FAL、OpenGen 中三选一。适配器仍保留给在途工单。')
  }
  if (selected === 'mock') {
    return reject('mock', 'mock 未配置为日常渠道：production / staging 不能使用 mock。请选择 Yir、FAL 或 OpenGen。')
  }
  return reject(selected || '(空)', `视频渠道未配置：请选择 Yir、FAL 或 OpenGen（当前 ${selected || '空'}）`)
}
