import { describe, expect, it } from 'vitest'
import { cheapestPackageCovering, findDuration, findVideoTemplate, templateSourceFile } from '#/config/site'

describe('templateSourceFile', () => {
  const short = findDuration('short')!
  const medium = findDuration('medium')!

  it('没有 sources 时用时长档位上的共享源视频', () => {
    expect(templateSourceFile(findVideoTemplate('new-york'), short)).toBe('neon-shuffle-v1-6s.mp4')
    expect(templateSourceFile(undefined, short)).toBe(short.source)
    expect(templateSourceFile({ sources: { short: '   ' } }, short)).toBe(short.source)
  })

  it('声明了这一时长就用它；其它时长回退', () => {
    const world = { sources: { short: '  city-6s.mp4  ' } }
    expect(templateSourceFile(world, short)).toBe('city-6s.mp4')
    expect(templateSourceFile(world, medium)).toBe('neon-shuffle-v1-12s.mp4')
  })
})

describe('cheapestPackageCovering', () => {
  it('选积分够用且最便宜的积分包', () => {
    expect(cheapestPackageCovering(1)?.id).toBe('starter')
    expect(cheapestPackageCovering(20)?.id).toBe('starter')
    expect(cheapestPackageCovering(21)?.id).toBe('party')
    expect(cheapestPackageCovering(100)?.id).toBe('squad')
    expect(cheapestPackageCovering(101)).toBeUndefined()
  })
})
