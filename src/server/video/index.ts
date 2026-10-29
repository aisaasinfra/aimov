import { ApiError, isProduction } from '../util'
import { createFalProvider } from './fal'
import { createNanoapiProvider } from './nanoapi'
import { createOpenGenProvider } from './opengen'
import { isManualProvider, type ExecutableVideoProviderId, type VideoProvider } from './types'
import { createYirProvider } from './yir'

// mock：本地与 e2e 用。几秒后“完成”，输出直接复制该时长档位的模板源视频。
// 生成请求带 mockOutcome（仅非生产）：'fail' 模拟失败，用于验证自动退积分；'hang' 一直处理中，直到超时、死信或管理员处理。
function createMockProvider(): VideoProvider {
  return {
    id: 'mock',
    async submit(input) {
      return {
        requestId: `mock_${input.generationId}`,
        meta: { ...input.meta, readyAt: Date.now() + 3000, sourceKey: input.sourceVideoKey },
      }
    },
    async status(_requestId, meta) {
      if (meta.mockOutcome === 'hang' || Date.now() < Number(meta.readyAt ?? 0)) return { state: 'pending' }
      if (meta.mockOutcome === 'fail') return { state: 'failed', code: 'mock_failure', message: 'Simulated provider failure' }
      return { state: 'completed', output: { r2Key: String(meta.sourceKey) } }
    },
    costCents: () => 0,
  }
}

const REAL_VIDEO_PROVIDERS = ['fal', 'yir', 'nanoapi', 'opengen'] as const

// 日常三选一。nanoapi 仍可由 getVideoProvider 执行在途工单，但不进这个下拉（是否并入待确认）。
export const DAILY_VIDEO_PROVIDER_IDS = ['yir', 'fal', 'opengen'] as const

export function isDailyVideoProvider(value: string, env: { APP_ENV?: string }): boolean {
  if ((DAILY_VIDEO_PROVIDER_IDS as readonly string[]).includes(value)) return true
  return value === 'mock' && !isProduction(env)
}

export function videoProviderOptions(env: { APP_ENV?: string }): { value: ExecutableVideoProviderId; label: string }[] {
  const options: { value: ExecutableVideoProviderId; label: string }[] = [
    { value: 'yir', label: 'Yir' },
    { value: 'fal', label: 'FAL' },
    { value: 'opengen', label: 'OpenGen' },
  ]
  if (!isProduction(env)) options.push({ value: 'mock', label: 'mock（仅开发 / preview）' })
  return options
}

export function parseVideoProviderId(value: string, env: { APP_ENV?: string }): ExecutableVideoProviderId {
  if (isManualProvider(value)) {
    throw new ApiError(503, 'video_not_configured', 'manual is a fulfillment mode, not VIDEO_PROVIDER')
  }
  if ((REAL_VIDEO_PROVIDERS as readonly string[]).includes(value)) return value as ExecutableVideoProviderId
  if (value === 'mock' && !isProduction(env)) return 'mock'
  throw new ApiError(503, 'video_not_configured', `Unsupported VIDEO_PROVIDER: ${value || '(空)'}`)
}

// 按 settings 覆盖或 env.VIDEO_PROVIDER 解析可执行的渠道 id。不检查密钥。
// 新 auto 工单的三选一和缺配拒绝在 describeAutoRoute。飞行中的工单把 generations.provider 直接交给 getVideoProvider。
// settings.videoProvider 为 null / 空表示没有合法覆盖。mock 在 isProduction 时不是合法覆盖，调用方应先丢掉。
export function resolveEffectiveVideoProvider(env: Env, settings?: { videoProvider?: string | null } | null): ExecutableVideoProviderId {
  const override = settings?.videoProvider
  const raw = typeof override === 'string' && override ? override : (env.VIDEO_PROVIDER ?? '')
  return parseVideoProviderId(raw, env)
}

export function activeVideoProviderId(env: Env, settings?: { videoProvider?: string | null } | null): ExecutableVideoProviderId {
  return resolveEffectiveVideoProvider(env, settings)
}

export function getVideoProvider(env: Env, id: string = activeVideoProviderId(env)): VideoProvider {
  // 人工单没有厂商实现。调用方应先跳过；这里拒绝，避免队列误提交。
  if (isManualProvider(id)) throw new ApiError(503, 'video_not_configured', 'manual is a fulfillment mode, not a video provider')
  if (id === 'fal') return createFalProvider(env)
  if (id === 'yir') return createYirProvider(env)
  if (id === 'nanoapi') return createNanoapiProvider(env)
  if (id === 'opengen') return createOpenGenProvider(env)
  if (id === 'mock' && !isProduction(env)) return createMockProvider()
  throw new ApiError(503, 'video_not_configured', `Unsupported video provider: ${id}`)
}
