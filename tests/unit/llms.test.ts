import { describe, expect, it } from 'vitest'
import type { Locale } from '#/config/site'
import type { ChangelogEntry } from '#/content/changelog'
import { buildDocMarkdown, buildLlmsFullTxt, buildLlmsTxt, isLlmDocSlug } from '#/server/llms'
import { isSeoPath, seoRoutes } from '#/server/seo'

function texts<T>(en: T): Record<Locale, T> {
  return { en, de: en, es: en, fr: en, 'pt-BR': en, 'zh-TW': en }
}

const hidden: ChangelogEntry = {
  version: 'draft',
  date: '2026-10-26',
  published: false,
  title: texts('Secret title'),
  summary: texts('hidden'),
  items: texts(['do not index']),
}

describe('llms.txt', () => {
  it('索引写明六种语言、没有简体、Google 登录和支付通道，并指向全文', () => {
    const text = buildLlmsTxt(['/', '/pricing', '/changelog', '/waitlist'])
    expect(text).toContain('# aimov')
    expect(text).toContain('video SaaS')
    expect(text).toContain('/zh-TW')
    expect(text).toContain('/pt-BR')
    expect(text).toContain('/de')
    expect(text).toContain('no Simplified Chinese')
    expect(text).not.toContain('简体中文, prefix /zh')
    expect(text).toContain('Google only')
    expect(text).toContain('PayPal.cn')
    expect(text).toContain('/llms-full.txt')
    expect(text).toContain('/docs-md/changelog')
    expect(text).toContain('/waitlist')
    expect(text).not.toContain('Secret title')
  })

  it('未发布的更新日志不进 Markdown，未知 slug 没有正文', () => {
    expect(isLlmDocSlug('overview')).toBe(true)
    expect(isLlmDocSlug('../etc/passwd')).toBe(false)
    expect(buildDocMarkdown('nope')).toBeNull()
    const doc = buildDocMarkdown('changelog', [hidden])
    expect(doc).not.toContain('Secret title')
    expect(doc).toContain('No published entries')
    expect(buildLlmsFullTxt(['/'], [hidden])).toContain('# aimov')
  })

  it('Hono 提供 llms.txt、全文和单篇 Markdown', async () => {
    expect(isSeoPath('/llms.txt')).toBe(true)
    expect(isSeoPath('/llms-full.txt')).toBe(true)
    expect(isSeoPath('/docs-md/overview')).toBe(true)
    expect(isSeoPath('/changelog')).toBe(false)
    const index = await seoRoutes.request('/llms.txt')
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/markdown')
    expect(await index.text()).toContain('Google only')
    const full = await seoRoutes.request('/llms-full.txt')
    expect(full.status).toBe(200)
    const corpus = await full.text()
    expect(corpus).toContain('# aimov changelog')
    expect(corpus).toContain('# aimov waitlist')
    expect((await seoRoutes.request('/docs-md/waitlist')).status).toBe(200)
    expect((await seoRoutes.request('/docs-md/not-a-page')).status).toBe(404)
  })
})
