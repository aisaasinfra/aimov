import { Outlet, createFileRoute } from '@tanstack/react-router'
import { Footer, SupportButton } from '#/components/Footer'
import { LocaleSuggestBanner } from '#/components/LocaleSuggestBanner'
import { Nav } from '#/components/Nav'
import { SiteNotice } from '#/components/SiteNotice'
import { DEFAULT_LOCALE, isLocale } from '#/config/site'

// 语言布局：/ 与 /de、/es、/fr、/pt-BR、/zh-TW 共用。默认语言不允许带前缀（/en/... → 404，避免重复内容）
// params.parse 返回 false 时路由不参与匹配。连字符在一段路径里（pt-BR、zh-TW）合法。未知前缀落到根 404。
export const Route = createFileRoute('/{-$locale}')({
  params: {
    parse: (raw) => (raw.locale === undefined || (isLocale(raw.locale) && raw.locale !== DEFAULT_LOCALE) ? raw : false),
  },
  component: LocaleLayout,
})

function LocaleLayout() {
  return (
    <>
      <LocaleSuggestBanner />
      <SiteNotice />
      <Nav />
      <main className="min-h-[60vh]">
        <Outlet />
      </main>
      <Footer />
      <SupportButton />
    </>
  )
}
