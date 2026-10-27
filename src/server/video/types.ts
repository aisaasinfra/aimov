export interface VideoSubmitInput {
  generationId: string
  durationSeconds: number
  imageUrl: string
  sourceVideoUrl: string
  sourceVideoKey: string
  webhookUrl: string
  meta: Record<string, unknown>
}

export interface VideoSubmitResult {
  requestId: string
  meta: Record<string, unknown>
}

export type VideoStatus =
  // next：多步任务进入下一步，jobs.ts 把它写回 provider_request_id / provider_meta，之后轮询新的服务商任务
  | { state: 'pending'; next?: VideoSubmitResult }
  // costCents：服务商返回了已结算的实际费用时带上，否则用 costCents() 估算
  | { state: 'completed'; output: { url: string } | { r2Key: string }; costCents?: number }
  | { state: 'failed'; code: string; message: string; retryable?: boolean }

// manual 只出现在 generations.provider：人工履约，不是 VIDEO_PROVIDER，也不能交给 getVideoProvider。
export const VIDEO_PROVIDER_IDS = ['fal', 'yir', 'nanoapi', 'opengen', 'mock', 'manual'] as const
export type VideoProviderId = (typeof VIDEO_PROVIDER_IDS)[number]
export type ExecutableVideoProviderId = Exclude<VideoProviderId, 'manual'>

export function isManualProvider(id: string): id is 'manual' {
  return id === 'manual'
}

export interface VideoProvider {
  id: ExecutableVideoProviderId
  submit(input: VideoSubmitInput): Promise<VideoSubmitResult>
  status(requestId: string, meta: Record<string, unknown>): Promise<VideoStatus>
  // 出一条成片的估算成本（美分），出片后写入 generations.provider_cost_cents
  costCents(durationSeconds: number): number
}

// 可重试错误（网络/限流/5xx）：队列会重投；不可重试错误直接失败并退积分
export class VideoProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}
