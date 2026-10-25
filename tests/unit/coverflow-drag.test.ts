import { describe, expect, it } from 'vitest'
import { COVERFLOW_LIVE_PX, COVERFLOW_RELEASE_PX, coverflowSwipeDelta } from '#/lib/coverflow-drag'

describe('coverflowSwipeDelta', () => {
  it('没拖够时不换世界', () => {
    expect(coverflowSwipeDelta(0, 'move')).toBe(0)
    expect(coverflowSwipeDelta(COVERFLOW_RELEASE_PX - 1, 'release')).toBe(0)
    expect(coverflowSwipeDelta(-(COVERFLOW_RELEASE_PX - 1), 'move')).toBe(0)
  })

  it('松手时超过短扫阈值走一步，往左是下一个世界', () => {
    expect(coverflowSwipeDelta(-COVERFLOW_RELEASE_PX, 'release')).toBe(1)
    expect(coverflowSwipeDelta(COVERFLOW_RELEASE_PX, 'release')).toBe(-1)
    expect(coverflowSwipeDelta(-COVERFLOW_RELEASE_PX, 'move')).toBe(0)
  })

  it('拖过一档就按档数换，方向可来回', () => {
    expect(coverflowSwipeDelta(-COVERFLOW_LIVE_PX, 'move')).toBe(1)
    expect(coverflowSwipeDelta(-COVERFLOW_LIVE_PX * 2, 'move')).toBe(2)
    expect(coverflowSwipeDelta(COVERFLOW_LIVE_PX, 'move')).toBe(-1)
    expect(coverflowSwipeDelta(-COVERFLOW_LIVE_PX * 2, 'release')).toBe(2)
  })

  it('非数字位移不当成滑动', () => {
    expect(coverflowSwipeDelta(Number.NaN, 'release')).toBe(0)
  })
})
