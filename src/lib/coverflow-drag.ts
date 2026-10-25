// 封面流横向拖动手势：拖过一档就换一个世界，松手时短扫也算一步。
// 手指往左（dx 为负）返回正数，选中下一个世界。

export const COVERFLOW_LIVE_PX = 78
export const COVERFLOW_RELEASE_PX = 42

export function coverflowSwipeDelta(dx: number, phase: 'move' | 'release'): number {
  if (!Number.isFinite(dx)) return 0
  const steps = Math.trunc(dx / COVERFLOW_LIVE_PX)
  if (steps !== 0) return -steps
  if (phase === 'release' && Math.abs(dx) >= COVERFLOW_RELEASE_PX) return dx < 0 ? 1 : -1
  return 0
}
