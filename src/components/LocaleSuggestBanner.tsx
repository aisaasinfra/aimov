import { getRouteApi, useRouterState } from '@tanstack/react-router'
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  isLocaleSuggestionDismissed,
  localeDisplayName,
  localeSuggestionHref,
  rememberAcceptLanguage,
  rememberLocaleSuggestionDismissed,
  suggestLocaleSwitch,
} from '#/lib/accept-language'
import { htmlLang, useContent, useLocale } from '#/lib/i18n'

const rootRoute = getRouteApi('__root__')

function withHash(event: ReactMouseEvent<HTMLAnchorElement>) {
  if (location.hash) event.currentTarget.href = event.currentTarget.href.split('#')[0] + location.hash
}

/**
 * Accept-Language 和当前网址语言不一致时，在页顶问一句要不要切换。
 * 切换才跳转；关掉只在这个标签页里记住。组件自己不会改地址，也不读地理位置。
 * 首屏先不渲染，避免服务端 HTML 和关掉之后的水合不一致，也不把建议写进给爬虫的 HTML。
 */
export function LocaleSuggestBanner() {
  const { acceptLanguage } = rootRoute.useLoaderData()
  const locale = useLocale()
  const c = useContent()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const search = useRouterState({ select: (s) => s.location.searchStr })
  const header = rememberAcceptLanguage(acceptLanguage)
  const suggested = suggestLocaleSwitch({ acceptLanguage: header, currentLocale: locale })
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!suggested || isLocaleSuggestionDismissed()) {
      setOpen(false)
      return
    }
    setOpen(true)
  }, [suggested])

  if (!suggested || !open) return null

  const href = localeSuggestionHref(suggested, pathname, search ?? '')

  return (
    <div role="region" aria-label={c.localeSuggest.label} data-testid="locale-suggest" className="border-b border-line bg-bg-soft text-sm">
      <div className="container-page flex flex-wrap items-center justify-between gap-3 py-2">
        <p>{c.localeSuggest.banner(localeDisplayName(suggested))}</p>
        <div className="flex items-center gap-2">
          <a
            href={href}
            hrefLang={suggested}
            lang={htmlLang(suggested)}
            onClick={withHash}
            className="rounded-full bg-ink px-3 py-1 text-xs font-semibold text-ink-fg"
          >
            {c.localeSuggest.switch}
          </a>
          <button
            type="button"
            className="rounded-full border border-line bg-card px-3 py-1 text-xs font-semibold"
            onClick={() => {
              rememberLocaleSuggestionDismissed()
              setOpen(false)
            }}
          >
            {c.localeSuggest.dismiss}
          </button>
        </div>
      </div>
    </div>
  )
}
