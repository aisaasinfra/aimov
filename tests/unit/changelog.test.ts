import { describe, expect, it } from 'vitest'
import type { Locale } from '#/config/site'
import { CHANGELOG, latestChangelogDate, selectChangelog, type ChangelogEntry } from '#/content/changelog'

function texts<T>(en: T, zhTW: T): Record<Locale, T> {
  return { en, de: en, es: en, fr: en, 'pt-BR': en, 'zh-TW': zhTW }
}

const sample: ChangelogEntry[] = [
  { version: 'old', date: '2026-01-02', title: texts('Old', '舊'), summary: texts('s', '概'), items: texts(['a'], ['甲']) },
  { version: 'new', date: '2026-03-01', title: texts('New', '新'), summary: texts('s', '概'), items: texts(['b'], ['乙']) },
  { version: 'hide', date: '2026-04-01', published: false, title: texts('Hide', '藏'), summary: texts('s', '概'), items: texts(['c'], ['丙']) },
  { version: 'bad', date: 'March', title: texts('Bad', '壞'), summary: texts('s', '概'), items: texts([], []) },
]

describe('selectChangelog', () => {
  it('丢掉未发布和坏日期，新的在前，并取出当前语言', () => {
    expect(selectChangelog(sample, 'zh-TW').map((entry) => entry.title)).toEqual(['新', '舊'])
    expect(selectChangelog(sample, 'en')[0]?.items).toEqual(['b'])
  })

  it('站内日志六种语言齐全，日期可做 sitemap lastmod', () => {
    const en = selectChangelog(CHANGELOG, 'en')
    const zh = selectChangelog(CHANGELOG, 'zh-TW')
    expect(en.length).toBe(zh.length)
    expect(en.length).toBe(selectChangelog(CHANGELOG, 'pt-BR').length)
    expect(en.length).toBeGreaterThan(0)
    expect(en[0]?.date).toBe(latestChangelogDate())
    expect(zh.some((entry) => entry.title.includes('等候名單'))).toBe(true)
    expect(en.some((entry) => /waitlist/i.test(entry.title))).toBe(true)
  })
})
