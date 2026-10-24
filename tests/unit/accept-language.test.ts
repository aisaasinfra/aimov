import { describe, expect, it } from 'vitest'
import {
  LOCALE_SUGGEST_DISMISS_KEY,
  isLocaleSuggestionDismissed,
  localeSuggestionHref,
  matchAcceptLanguageTag,
  rememberLocaleSuggestionDismissed,
  sanitizeAcceptLanguage,
  suggestLocaleSwitch,
} from '#/lib/accept-language'

function memoryStorage(initial?: Record<string, string>) {
  const data = new Map(Object.entries(initial ?? {}))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

describe('Accept-Language 建议', () => {
  it('按权重挑已启用的语言，权重相同则保持头里的顺序', () => {
    expect(suggestLocaleSwitch({ acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8', currentLocale: 'en' })).toBe('zh')
    expect(suggestLocaleSwitch({ acceptLanguage: 'en-US,en;q=0.9,zh;q=0.8', currentLocale: 'zh' })).toBe('en')
    expect(suggestLocaleSwitch({ acceptLanguage: 'ja;q=0.8, zh;q=0.8', currentLocale: 'en' })).toBe('zh')
  })

  it('当前语言已经是首选时不建议，q=0 和 * 忽略', () => {
    expect(suggestLocaleSwitch({ acceptLanguage: 'en-US,en;q=0.9,zh;q=0.8', currentLocale: 'en' })).toBeNull()
    expect(suggestLocaleSwitch({ acceptLanguage: 'zh-TW,en;q=0.5', currentLocale: 'zh' })).toBeNull()
    expect(suggestLocaleSwitch({ acceptLanguage: 'en;q=0, zh;q=0.4', currentLocale: 'en' })).toBe('zh')
    expect(suggestLocaleSwitch({ acceptLanguage: 'pt-BR,pt;q=0.9,*;q=0.5', currentLocale: 'en' })).toBeNull()
    expect(suggestLocaleSwitch({ acceptLanguage: '', currentLocale: 'en' })).toBeNull()
    expect(suggestLocaleSwitch({ acceptLanguage: null, currentLocale: 'zh' })).toBeNull()
  })

  it('地区标签映射到启用语言，不认识的主语言跳过', () => {
    expect(matchAcceptLanguageTag('zh-Hans')).toBe('zh')
    expect(matchAcceptLanguageTag('en-GB')).toBe('en')
    expect(matchAcceptLanguageTag('ja')).toBeNull()
    expect(matchAcceptLanguageTag('not a tag')).toBeNull()
  })

  it('控制字符整段丢掉，超长头只保留前面的标签', () => {
    expect(sanitizeAcceptLanguage('zh-CN\nX-Injected: 1')).toBeNull()
    expect(sanitizeAcceptLanguage(`zh-CN, ${'en-US,'.repeat(200)}`)).toMatch(/^zh-CN/)
    expect(suggestLocaleSwitch({ acceptLanguage: 'zh-CN\r\n, en;q=0.5', currentLocale: 'en' })).toBeNull()
  })

  it('切换链接保留路径、query 和 hash，默认语言不带前缀', () => {
    expect(localeSuggestionHref('zh', '/pricing', '?checkout=success', '#play')).toBe('/zh/pricing?checkout=success#play')
    expect(localeSuggestionHref('en', '/zh/pricing', '?checkout=success', '#play')).toBe('/pricing?checkout=success#play')
    expect(localeSuggestionHref('zh', '/', '', '')).toBe('/zh')
  })

  it('关闭只写当前传入的存储，键是标签页级的', () => {
    const storage = memoryStorage()
    expect(isLocaleSuggestionDismissed(storage)).toBe(false)
    rememberLocaleSuggestionDismissed(storage)
    expect(storage.getItem(LOCALE_SUGGEST_DISMISS_KEY)).toBe('1')
    expect(isLocaleSuggestionDismissed(storage)).toBe(true)
  })
})
