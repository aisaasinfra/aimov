// 给 LLM 爬虫的纯文本：llms.txt 是索引，llms-full.txt 和 /docs-md/* 是去掉站点外壳的 Markdown。
// 内容来自站点配置和 content/changelog.ts，不读文件系统（Workers 上没有）。
import { LOCALES, localePath, site } from '#/config/site'
import { CHANGELOG, selectChangelog, type ChangelogEntry } from '#/content/changelog'
import { absoluteUrl } from '#/lib/i18n'

export const LLM_DOC_SLUGS = ['overview', 'pricing', 'changelog', 'waitlist'] as const
export type LlmDocSlug = (typeof LLM_DOC_SLUGS)[number]

const PATH_BLURB: Record<string, string> = {
  '/': 'Home: one photo into a vertical holiday video',
  '/pricing': 'Credit packs and plans',
  '/guides': 'Guides',
  '/changelog': 'In-app changelog in English and Chinese',
  '/waitlist': 'Public email waitlist; does not create an account',
  '/contact': 'Contact the team (not the product feedback box)',
  '/report': 'Report a video or request removal',
  '/privacy-policy': 'Privacy policy',
  '/terms-of-service': 'Terms of service',
  '/refund-policy': 'Refund policy',
}

export function isLlmDocSlug(slug: string): slug is LlmDocSlug {
  return (LLM_DOC_SLUGS as readonly string[]).includes(slug)
}

export function llmRobotsLines() {
  return [`# llms.txt: ${absoluteUrl('/llms.txt')}`, `# llms-full.txt: ${absoluteUrl('/llms-full.txt')}`]
}

function label(path: string) {
  return PATH_BLURB[path] ?? 'Guide'
}

export function buildLlmsTxt(paths: readonly string[]) {
  const lines = [
    `# ${site.brandName}`,
    '',
    `> ${site.brandName} is a video SaaS. Upload one photo, pick a ${site.keyword} template, and download a vertical MP4. English is the default locale and has no URL prefix. Simplified Chinese is under /zh. Sign-in is Google only.`,
    '',
    '## Public pages',
    ...paths.map((path) => `- [${path === '/' ? 'Home' : path}](${absoluteUrl(path)}) — ${label(path)}. Chinese: ${absoluteUrl(localePath('zh', path))}`),
    '',
    '## Locales',
    ...LOCALES.map((locale) => `- ${locale}${locale === 'en' ? ' (default, x-default)' : ' (简体中文, prefix /zh)'}`),
    '',
    '## For AI agents',
    `- Full corpus: ${absoluteUrl('/llms-full.txt')}`,
    ...LLM_DOC_SLUGS.map((slug) => `- [${slug}](${absoluteUrl(`/docs-md/${slug}`)})`),
    '',
    '## Auth and payments',
    '- Accounts are created by Google sign-in, including One Tap. There is no email-and-password login.',
    '- The waitlist stores an email for product news. It does not create an account or a password.',
    '- Videos spend credits. Packs can be checked out with Waffo, PayPal.cn, Dodo, or Stripe when that provider is configured. Subscriptions do not use PayPal. There is no Stripe-only plan gate.',
    '',
    '## Not documentation',
    '- /api/, /admin, /dashboard, /sign-in, and /checkout are account or machine endpoints.',
    '- Shared videos at /v/<id> are user content and are noindex.',
    '',
  ]
  return `${lines.join('\n')}\n`
}

function changelogMarkdown(entries: readonly ChangelogEntry[]) {
  const blocks = LOCALES.map((locale) => {
    const views = selectChangelog(entries, locale)
    const body = views
      .map((entry) => [`### ${entry.date} · ${entry.title}`, '', entry.summary, '', ...entry.items.map((item) => `- ${item}`)].join('\n'))
      .join('\n\n')
    return `## ${locale}\n\n${body || '_No published entries._'}`
  })
  return blocks.join('\n\n')
}

export function buildDocMarkdown(slug: string, entries: readonly ChangelogEntry[] = CHANGELOG): string | null {
  if (!isLlmDocSlug(slug)) return null
  if (slug === 'overview') {
    return [
      `# ${site.brandName}`,
      '',
      `${site.brandName} (${site.domain}) turns one photo into a ${site.keyword}. The download is an MP4. Locales: English at ${absoluteUrl('/')} and 简体中文 at ${absoluteUrl('/zh')}.`,
      '',
      'Sign-in is Google only. Credits pay for render seconds. Failed renders refund credits. Photos and finished videos are private until the owner shares a video.',
      '',
      `Support: ${site.supportEmail}.`,
      '',
      'Key routes:',
      ...['/', '/pricing', '/guides', '/changelog', '/waitlist', '/contact', '/report'].map((path) => `- ${absoluteUrl(path)} — ${label(path)}`),
      '',
    ].join('\n')
  }
  if (slug === 'pricing') {
    return [
      `# Pricing`,
      '',
      `${site.brandName} sells credits for ${site.keyword} renders. Pack credits do not expire. Where subscriptions are enabled, plan credits are granted each period and PayPal is not used for plans.`,
      '',
      `Page: ${absoluteUrl('/pricing')} and ${absoluteUrl('/zh/pricing')}.`,
      '',
      'Configured checkout channels depend on the deployment (Waffo, PayPal.cn, Dodo, Stripe). The product does not require Stripe.',
      '',
    ].join('\n')
  }
  if (slug === 'waitlist') {
    return [
      `# ${site.brandName} waitlist`,
      '',
      `Anyone can leave an email at ${absoluteUrl('/waitlist')} (Chinese: ${absoluteUrl('/zh/waitlist')}). Joining does not create an account and does not replace Google sign-in.`,
      '',
      'When Turnstile is configured, the form requires a token. Duplicate emails are accepted as already listed. Admins can export the list as CSV.',
      '',
    ].join('\n')
  }
  return [`# ${site.brandName} changelog`, '', `Page: ${absoluteUrl('/changelog')} and ${absoluteUrl('/zh/changelog')}.`, '', changelogMarkdown(entries), ''].join('\n')
}

export function buildLlmsFullTxt(paths: readonly string[], entries: readonly ChangelogEntry[] = CHANGELOG) {
  const docs = LLM_DOC_SLUGS.map((slug) => buildDocMarkdown(slug, entries)).filter((text): text is string => text != null)
  return [`# ${site.brandName} — full corpus`, '', buildLlmsTxt(paths).trim(), '', ...docs].join('\n\n') + '\n'
}
