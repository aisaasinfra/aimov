import { describe, expect, it } from 'vitest'
import { CHANGELOG, latestChangelogDate, selectChangelog, type ChangelogEntry } from '#/content/changelog'

const sample: ChangelogEntry[] = [
  { version: 'old', date: '2026-01-02', title: { en: 'Old', zh: '旧' }, summary: { en: 's', zh: '概' }, items: { en: ['a'], zh: ['甲'] } },
  { version: 'new', date: '2026-03-01', title: { en: 'New', zh: '新' }, summary: { en: 's', zh: '概' }, items: { en: ['b'], zh: ['乙'] } },
  { version: 'hide', date: '2026-04-01', published: false, title: { en: 'Hide', zh: '藏' }, summary: { en: 's', zh: '概' }, items: { en: ['c'], zh: ['丙'] } },
  { version: 'bad', date: 'March', title: { en: 'Bad', zh: '坏' }, summary: { en: 's', zh: '概' }, items: { en: [], zh: [] } },
]

describe('selectChangelog', () => {
  it('丢掉未发布和坏日期，新的在前，并取出当前语言', () => {
    expect(selectChangelog(sample, 'zh').map((entry) => entry.title)).toEqual(['新', '旧'])
    expect(selectChangelog(sample, 'en')[0]?.items).toEqual(['b'])
  })

  it('站内日志有中英两份，日期可做 sitemap lastmod', () => {
    const en = selectChangelog(CHANGELOG, 'en')
    const zh = selectChangelog(CHANGELOG, 'zh')
    expect(en.length).toBe(zh.length)
    expect(en.length).toBeGreaterThan(0)
    expect(en[0]?.date).toBe(latestChangelogDate())
    expect(zh.some((entry) => entry.title.includes('等待列表'))).toBe(true)
    expect(en.some((entry) => /waitlist/i.test(entry.title))).toBe(true)
  })
})
