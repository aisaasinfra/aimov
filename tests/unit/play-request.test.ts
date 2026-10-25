import { describe, expect, it } from 'vitest'
import { playRequestPlan } from '#/lib/play-request'

const ready = {
  loading: false,
  busy: false,
  signedIn: true,
  shortfall: 0,
  hasPhoto: true,
  consent: true,
}

describe('playRequestPlan', () => {
  it('生成条件齐了才生成', () => {
    expect(playRequestPlan(ready)).toBe('generate')
  })

  it('加载中或正在提交时不动', () => {
    expect(playRequestPlan({ ...ready, loading: true })).toBe('wait')
    expect(playRequestPlan({ ...ready, busy: true })).toBe('wait')
  })

  it('未登录去登录，积分不够去价格页', () => {
    expect(playRequestPlan({ ...ready, signedIn: false })).toBe('sign-in')
    expect(playRequestPlan({ ...ready, shortfall: 6 })).toBe('pricing')
  })

  it('没照片先选文件', () => {
    expect(playRequestPlan({ ...ready, hasPhoto: false, consent: false })).toBe('pick-file')
  })

  it('有照片但没勾授权时把人带回授权框，而不是什么都不做', () => {
    expect(playRequestPlan({ ...ready, consent: false })).toBe('need-consent')
  })
})
