import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, LOCALES, localePath, site, templatePrompt, usesTraditionalPrompt } from '#/config/site'

describe('公开语言', () => {
  it('六种语言，英文默认，繁体排在最后，没有简体', () => {
    expect(LOCALES).toEqual(['en', 'de', 'es', 'fr', 'pt-BR', 'zh-TW'])
    expect(DEFAULT_LOCALE).toBe('en')
    expect(LOCALES).not.toContain('zh')
    expect(LOCALES).not.toContain('zh-CN')
    expect(localePath('en', '/pricing')).toBe('/pricing')
    expect(localePath('pt-BR', '/')).toBe('/pt-BR')
    expect(localePath('zh-TW', '/pricing')).toBe('/zh-TW/pricing')
  })

  it('繁体 prompt 不给简体', () => {
    const template = site.videoTemplates[0]!
    expect(usesTraditionalPrompt('zh-TW')).toBe(true)
    expect(usesTraditionalPrompt('zh-HK')).toBe(true)
    expect(usesTraditionalPrompt('zh-Hant')).toBe(true)
    expect(usesTraditionalPrompt('zh-CN')).toBe(false)
    expect(usesTraditionalPrompt('zh-Hans')).toBe(false)
    expect(usesTraditionalPrompt('zh')).toBe(false)
    expect(usesTraditionalPrompt('de')).toBe(false)
    expect(templatePrompt(template, 'zh-TW')).toBe(template.promptZh)
    expect(templatePrompt(template, 'zh-CN')).toBe(template.prompt)
    expect(template.promptZh).not.toContain('简')
    expect(template.promptZh).toContain('聖誕')
  })
})
