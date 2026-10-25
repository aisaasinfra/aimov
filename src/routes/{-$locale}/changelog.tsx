import { createFileRoute } from '@tanstack/react-router'
import { Breadcrumbs } from '#/components/ui'
import { CHANGELOG, selectChangelog } from '#/content/changelog'
import { getContent, localeFromParam, pageHead, useContent, useLocale } from '#/lib/i18n'
import { breadcrumbJsonLd, jsonLdScript } from '#/lib/seo'

export const Route = createFileRoute('/{-$locale}/changelog')({
  head: ({ params }) => {
    const locale = localeFromParam(params.locale)
    const c = getContent(locale)
    const items = [{ name: c.changelog.title, path: '/changelog' }]
    return {
      ...pageHead(locale, '/changelog', c.meta.changelogTitle, c.meta.changelogDescription),
      scripts: [jsonLdScript(breadcrumbJsonLd(locale, c.meta.breadcrumbHome, items))],
    }
  },
  component: ChangelogPage,
})

function ChangelogPage() {
  const c = useContent()
  const locale = useLocale()
  const entries = selectChangelog(CHANGELOG, locale)
  return (
    <div className="container-page max-w-3xl py-16">
      <Breadcrumbs items={[{ name: c.changelog.title, path: '/changelog' }]} />
      <h1 className="font-display text-5xl">{c.changelog.title}</h1>
      <p className="mt-4 text-muted">{c.changelog.intro}</p>
      {entries.length === 0 ? <p className="mt-10 text-muted">{c.changelog.empty}</p> : null}
      <div className="mt-10 space-y-8">
        {entries.map((entry) => (
          <article key={entry.version} className="card space-y-3 p-6">
            <p className="text-sm text-muted">
              <time dateTime={entry.date}>{entry.date}</time>
              <span className="mx-2">·</span>
              {entry.version}
            </p>
            <h2 className="font-display text-2xl">{entry.title}</h2>
            <p className="leading-7">{entry.summary}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-6">
              {entry.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </div>
  )
}
