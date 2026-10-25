// 结构化数据（JSON-LD）。全部由 site 配置与文案生成，上新词无需改这里。
// 注意：不要编造 aggregateRating / review，SoftwareApplication 没有评分时拿不到星级富结果，但实体信息仍会被理解。
import { localePath, site, type Locale } from '#/config/site'
import { absoluteUrl, htmlLang } from './i18n'

const ORG_ID = absoluteUrl('/#organization')
const SITE_ID = absoluteUrl('/#website')

// 防止文案中的 "</script>" 提前闭合标签
export function jsonLdScript(data: unknown) {
  return { type: 'application/ld+json', children: JSON.stringify(data).replace(/</g, '\\u003c') }
}

function organization() {
  return {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: site.brandName,
    url: absoluteUrl('/'),
    logo: absoluteUrl('/favicon.svg'),
    email: site.supportEmail,
    ...(site.seo.sameAs.length ? { sameAs: site.seo.sameAs } : {}),
  }
}

const publisherRef = { '@type': 'Organization', '@id': ORG_ID, name: site.brandName, url: absoluteUrl('/') }

function priceOf(cents: number) {
  return (cents / 100).toFixed(2)
}

// 首页：组织 + 网站 + 应用（全部积分包汇总成 AggregateOffer）。
// 没有真实的节日成片 MP4，不把静帧或 neon demo 写成 VideoObject。
export function homeJsonLd(locale: Locale, description: string) {
  const prices = site.packages.map((p) => p.priceCents)
  return {
    '@context': 'https://schema.org',
    '@graph': [
      organization(),
      { '@type': 'WebSite', '@id': SITE_ID, url: absoluteUrl('/'), name: site.brandName, inLanguage: htmlLang(locale), publisher: { '@id': ORG_ID } },
      {
        '@type': 'SoftwareApplication',
        name: site.brandName,
        url: absoluteUrl(localePath(locale, '/')),
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Web',
        description,
        inLanguage: htmlLang(locale),
        publisher: { '@id': ORG_ID },
        offers: {
          '@type': 'AggregateOffer',
          priceCurrency: site.packages[0]!.currency,
          lowPrice: priceOf(Math.min(...prices)),
          highPrice: priceOf(Math.max(...prices)),
          offerCount: site.packages.length,
        },
      },
    ],
  }
}

export function breadcrumbJsonLd(locale: Locale, homeName: string, items: Array<{ name: string; path: string }>) {
  const trail = [{ name: homeName, path: '/' }, ...items]
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(localePath(locale, item.path)),
    })),
  }
}

export function articleJsonLd(
  locale: Locale,
  path: string,
  text: { title: string; description: string },
  dates: { publishedAt: string; updatedAt: string },
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: text.title,
    description: text.description,
    inLanguage: htmlLang(locale),
    datePublished: dates.publishedAt,
    dateModified: dates.updatedAt,
    image: [absoluteUrl(site.ogImage)],
    author: publisherRef,
    publisher: { ...publisherRef, logo: { '@type': 'ImageObject', url: absoluteUrl('/favicon.svg') } },
    mainEntityOfPage: absoluteUrl(localePath(locale, path)),
  }
}
