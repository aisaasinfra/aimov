// OpenGen 提交结果不明时怎么处理。纯函数，方便单测。
// 两次 404 的间隔用现有 OpenGen 轮询间隔，不是产品 SLA。SLA 分钟数未定，这里不写分钟级承诺。

export const RECONCILE_ABSENT_GAP_MS = 20_000

export type SubmitEvidence = 'not_sent' | 'unknown' | 'rejected_before_store' | 'accepted'
export type LookupKind = 'found' | 'absent' | 'unclear'

export interface FallbackLookup {
  kind: LookupKind
  atMs: number
  taskId?: string
}

export interface FallbackInput {
  taskIdRecorded: boolean
  submit: SubmitEvidence
  preflight?: 'unreachable' | 'unhealthy' | 'reachable' | 'skipped'
  lookups: readonly FallbackLookup[]
}

export type FallbackDecision =
  | { action: 'stay'; taskId?: string }
  | { action: 'manual'; reason: 'unreachable_before_submit' | 'confirmed_absent' }
  | { action: 'freeze'; reason: 'lookup_unclear' | 'absent_unconfirmed' | 'submit_unknown' }

function absentTimes(lookups: readonly FallbackLookup[]): number[] {
  return lookups
    .filter((item) => item.kind === 'absent')
    .map((item) => item.atMs)
    .filter((at) => Number.isFinite(at))
    .sort((a, b) => a - b)
}

export function decideOpenGenFallback(input: FallbackInput): FallbackDecision {
  const found = input.lookups.find((item) => item.kind === 'found' && item.taskId)
  if (input.taskIdRecorded || input.submit === 'accepted' || found) {
    return { action: 'stay', taskId: found?.taskId }
  }
  // 请求还没发出，健康检查就连不上：同一 generation 改人工。鉴权失败和未配置不走这里。
  if (input.submit === 'not_sent' && input.preflight === 'unreachable') {
    return { action: 'manual', reason: 'unreachable_before_submit' }
  }
  if (input.lookups.some((item) => item.kind === 'unclear')) {
    return { action: 'freeze', reason: 'lookup_unclear' }
  }
  const absents = absentTimes(input.lookups)
  if (input.submit === 'rejected_before_store' && absents.length >= 1) {
    return { action: 'manual', reason: 'confirmed_absent' }
  }
  if (input.submit === 'unknown' && absents.length >= 2 && absents[absents.length - 1]! - absents[0]! >= RECONCILE_ABSENT_GAP_MS) {
    return { action: 'manual', reason: 'confirmed_absent' }
  }
  if (absents.length > 0) return { action: 'freeze', reason: 'absent_unconfirmed' }
  return { action: 'freeze', reason: 'submit_unknown' }
}
