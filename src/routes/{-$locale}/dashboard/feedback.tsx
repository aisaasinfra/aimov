import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { ErrorText, Spinner } from '#/components/ui'
import { api, errorCode } from '#/lib/api'
import { useContent } from '#/lib/i18n'

export const Route = createFileRoute('/{-$locale}/dashboard/feedback')({
  component: FeedbackPage,
})

type Item = {
  id: string
  title: string
  body: string
  status: string
  adminNote: string | null
  createdAt: string
  updatedAt: string
}

function FeedbackPage() {
  const c = useContent()
  const t = c.feedback
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  async function load() {
    const data = await api<{ feedback: Item[] }>('/api/feedback')
    setItems(data.feedback)
  }

  useEffect(() => {
    load().catch((err) => setError(errorCode(err)))
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSent(false)
    setSending(true)
    try {
      await api('/api/feedback', { json: { title, body } })
      setTitle('')
      setBody('')
      setSent(true)
      await load()
    } catch (err) {
      setError(errorCode(err))
    } finally {
      setSending(false)
    }
  }

  async function remove(id: string) {
    if (!confirm(t.confirmDelete)) return
    setError(null)
    try {
      await api(`/api/feedback/${id}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError(errorCode(err))
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h2 className="font-display text-3xl">{t.title}</h2>
        <p className="mt-2 text-sm text-muted">{t.intro}</p>
      </div>
      <form onSubmit={submit} className="card space-y-4 p-6" data-testid="feedback-form">
        <label className="block space-y-1.5 text-sm font-medium">
          <span>{t.titleLabel}</span>
          <input className="input" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block space-y-1.5 text-sm font-medium">
          <span>{t.bodyLabel}</span>
          <textarea className="input min-h-32" required maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <ErrorText code={error} />
        {sent ? <p className="text-sm font-medium">{t.sent}</p> : null}
        <button type="submit" className="btn-primary" disabled={sending}>
          {sending ? <Spinner /> : null} {t.send}
        </button>
      </form>
      <div>
        <h2 className="font-display text-2xl">{t.mine}</h2>
        {items === null ? <Spinner className="mt-4 size-5" /> : null}
        {items && items.length === 0 ? <p className="mt-3 text-sm text-muted">{t.empty}</p> : null}
        <div className="mt-4 space-y-3" data-testid="feedback-list">
          {items?.map((item) => (
            <article key={item.id} className="card space-y-2 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{item.title}</h3>
                <span className="chip text-xs">{t.statuses[item.status] ?? item.status}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-6">{item.body}</p>
              {item.adminNote ? (
                <p className="text-sm text-muted">
                  {t.reply}: {item.adminNote}
                </p>
              ) : null}
              <div className="flex items-center justify-between text-xs text-muted">
                <time dateTime={item.createdAt}>{item.createdAt.slice(0, 10)}</time>
                {item.status === 'open' ? (
                  <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => remove(item.id)}>
                    {t.delete}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}
