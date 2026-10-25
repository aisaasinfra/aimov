import { createFileRoute, useHydrated } from '@tanstack/react-router'
import { CircleCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Turnstile } from '#/components/Turnstile'
import { Breadcrumbs, ErrorText, LocalLink, Spinner } from '#/components/ui'
import { api, errorCode } from '#/lib/api'
import { getContent, localeFromParam, pageHead, useContent, useLocale } from '#/lib/i18n'
import { breadcrumbJsonLd, jsonLdScript } from '#/lib/seo'
import { useSession } from '#/lib/session'

export const Route = createFileRoute('/{-$locale}/waitlist')({
  head: ({ params }) => {
    const locale = localeFromParam(params.locale)
    const c = getContent(locale)
    const items = [{ name: c.waitlist.title, path: '/waitlist' }]
    return {
      ...pageHead(locale, '/waitlist', c.meta.waitlistTitle, c.meta.waitlistDescription),
      scripts: [jsonLdScript(breadcrumbJsonLd(locale, c.meta.breadcrumbHome, items))],
    }
  },
  component: WaitlistPage,
})

function WaitlistPage() {
  const c = useContent()
  const t = c.waitlist
  const locale = useLocale()
  const { config } = useSession()
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'added' | 'already'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const siteKey = config?.turnstileSiteKey ?? null
  const hydrated = useHydrated()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setState('sending')
    try {
      const result = await api<{ status: 'added' | 'already' }>('/api/waitlist', {
        json: { email, locale, source: 'waitlist', turnstileToken: token },
      })
      setState(result.status)
    } catch (err) {
      setError(errorCode(err))
      setState('idle')
      setResetKey((n) => n + 1)
    }
  }

  return (
    <div className="container-page max-w-xl py-16">
      <Breadcrumbs items={[{ name: t.title, path: '/waitlist' }]} />
      <h1 className="font-display text-5xl">{t.title}</h1>
      <p className="mt-4 text-muted">{t.body}</p>
      {state === 'added' || state === 'already' ? (
        <p className="card mt-10 flex items-center gap-2 p-6 font-medium" data-testid="waitlist-sent">
          <CircleCheck className="size-5 text-emerald-600" /> {state === 'added' ? t.added : t.already}
        </p>
      ) : (
        <form onSubmit={submit} className="card mt-10 space-y-5 p-6" data-testid="waitlist-form">
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t.email}</span>
            <input className="input" type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </label>
          {siteKey ? <Turnstile siteKey={siteKey} onToken={setToken} resetKey={resetKey} /> : null}
          <ErrorText code={error} />
          <button type="submit" className="btn-primary" disabled={!hydrated || state === 'sending' || Boolean(siteKey && !token)}>
            {state === 'sending' ? <Spinner /> : null} {t.send}
          </button>
          <p className="text-sm text-muted">
            {t.privacy}{' '}
            <LocalLink to="/privacy-policy" className="underline">
              {c.footer.privacy}
            </LocalLink>
          </p>
        </form>
      )}
    </div>
  )
}
