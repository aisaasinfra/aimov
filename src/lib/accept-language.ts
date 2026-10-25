import { DEFAULT_LOCALE, LOCALE_META, LOCALES, isLocale, localePath, type Locale } from '#/config/site'

/**
 * 从 Accept-Language 里挑一个本站已启用的语言。
 *
 * 只读这一个请求头。不查国家、IP 或地理位置，也不改地址。
 * 调用方用横幅询问，等访客点击后才跳转。
 */

const languageTag = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/
const MAX_HEADER_LENGTH = 512

// 主语言 → 站点键。葡萄牙语只有 pt-BR。中文不走这张表：简体不能落到已删除的 zh，光秃的 zh 也不猜繁体。
const primaryLocale: Record<string, Locale> = {
  en: 'en',
  de: 'de',
  es: 'es',
  fr: 'fr',
  pt: 'pt-BR',
}

export function sanitizeAcceptLanguage(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // 超长头只保留前面的标签；截断处的残片过不了 languageTag，会被排名跳过
  const sliced = trimmed.slice(0, MAX_HEADER_LENGTH)
  if (/[\u0000-\u001f\u007f]/.test(sliced)) return null
  return sliced
}

/** zh-TW、zh-HK、zh-MO、zh-Hant* → 繁体。zh-CN、zh-Hans、zh-SG 和单独的 zh 不匹配任何公开语言。 */
export function matchChineseTag(tag: string, enabled: readonly Locale[]): Locale | null {
  const target: Locale = 'zh-TW'
  if (!enabled.includes(target)) return null
  const parts = tag.split('-')
  if (parts[0] !== 'zh') return null
  const script = parts.find((part) => part === 'hant' || part === 'hans')
  const region = parts.find((part) => part === 'tw' || part === 'hk' || part === 'mo' || part === 'cn' || part === 'sg')
  if (script === 'hans' || region === 'cn' || region === 'sg') return null
  if (script === 'hant' || region === 'tw' || region === 'hk' || region === 'mo') return target
  return null
}

export function matchAcceptLanguageTag(tag: string, enabled: readonly Locale[] = LOCALES): Locale | null {
  const value = tag.trim().toLowerCase()
  if (!languageTag.test(value)) return null

  if (value === 'zh' || value.startsWith('zh-')) return matchChineseTag(value, enabled)

  const exact = enabled.find((locale) => locale.toLowerCase() === value)
  if (exact) return exact

  const primary = value.split('-')[0] ?? ''
  const fromPrimary = primaryLocale[primary]
  if (fromPrimary && enabled.includes(fromPrimary)) return fromPrimary

  return null
}

/**
 * 头里权重最高、且本站启用的语言。已经是当前语言、头为空、或没有匹配时返回 null。
 * `q=0` 和 `*` 不算建议。权重相同时保持头里的先后顺序。
 */
export function suggestLocaleSwitch(input: {
  acceptLanguage: string | null | undefined
  currentLocale: string | null | undefined
  enabledLocales?: readonly Locale[]
}): Locale | null {
  const enabled = input.enabledLocales ?? LOCALES
  const current = isLocale(input.currentLocale ?? undefined) ? input.currentLocale : null
  const ranked = rankAcceptLanguage(sanitizeAcceptLanguage(input.acceptLanguage))

  for (const tag of ranked) {
    const match = matchAcceptLanguageTag(tag, enabled)
    if (!match) continue
    return match === current ? null : match
  }

  return null
}

function rankAcceptLanguage(header: string | null): string[] {
  if (!header) return []

  const ranked: { tag: string; q: number; index: number }[] = []
  const parts = header.split(',')

  for (let index = 0; index < parts.length; index += 1) {
    const [rawTag, ...params] = parts[index]!.split(';').map((part) => part.trim())
    if (!rawTag || rawTag === '*') continue
    if (!languageTag.test(rawTag)) continue

    let q = 1
    let validQ = true
    for (const param of params) {
      const [key, rawValue] = param.split('=').map((part) => part.trim())
      if (key !== 'q') continue
      const parsed = Number(rawValue)
      if (!Number.isFinite(parsed)) {
        validQ = false
        break
      }
      q = Math.min(1, Math.max(0, parsed))
    }
    if (!validQ || q <= 0) continue
    ranked.push({ tag: rawTag, q, index })
  }

  ranked.sort((a, b) => b.q - a.q || a.index - b.index)
  return ranked.map((item) => item.tag)
}

function stripLocalePrefix(pathname: string): string {
  const first = pathname.split('/')[1]
  if (!isLocale(first) || first === DEFAULT_LOCALE) return pathname || '/'
  const rest = pathname.slice(first.length + 1)
  return rest || '/'
}

export function localeSuggestionHref(locale: Locale, pathname: string, search = '', hash = ''): string {
  const cleanHash = hash && !hash.startsWith('#') ? `#${hash}` : hash
  return `${localePath(locale, stripLocalePrefix(pathname || '/'))}${search}${cleanHash}`
}

export function localeDisplayName(locale: Locale): string {
  return LOCALE_META[locale].name
}

/** 只在当前标签页有效。关掉横幅后，直到关掉标签页才再问。 */
export const LOCALE_SUGGEST_DISMISS_KEY = 'aimov.locale-suggest.dismissed'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

// 服务端模块会跨请求复用，不能把某个访客的头记在模块变量里
let rememberedHeader: string | null = null

export function rememberAcceptLanguage(value: string | null): string | null {
  if (import.meta.env.SSR) return value
  if (value) rememberedHeader = value
  return value ?? rememberedHeader
}

function browserSessionStorage(): StorageLike | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    return null
  }
}

export function isLocaleSuggestionDismissed(storage?: StorageLike | null): boolean {
  try {
    const target = storage === undefined ? browserSessionStorage() : storage
    return target?.getItem(LOCALE_SUGGEST_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberLocaleSuggestionDismissed(storage?: StorageLike | null): void {
  try {
    const target = storage === undefined ? browserSessionStorage() : storage
    target?.setItem(LOCALE_SUGGEST_DISMISS_KEY, '1')
  } catch {
    // 隐私模式可能抛错。下次导航横幅可能再出现。
  }
}
