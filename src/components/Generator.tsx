import { useRouterState } from '@tanstack/react-router'
import { CircleAlert, CircleCheck, Download, Upload } from 'lucide-react'
import { site } from '#/config/site'
import { isActiveGeneration, type Generation } from '#/lib/api'
import { useContent, useLocale, useLocalePath } from '#/lib/i18n'
import { signInHref, useSession } from '#/lib/session'
import { usePlay } from './play'
import { AiBadge, ErrorText, GoogleIcon, LocalLink, Spinner, formatDate } from './ui'

export function Generator() {
  const c = useContent()
  const g = c.generator
  const lp = useLocalePath()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { user, config, loading } = useSession()
  const play = usePlay()
  const { duration, photo, uploading, dragging, busy, consent, shortfall, error, generation } = play

  return (
    <section
      className="card space-y-5 p-5 shadow-[0_1px_0_var(--line),0_20px_40px_-24px_rgba(0,0,0,0.25)] sm:p-6"
      aria-labelledby="generator-title"
      data-testid="generator"
    >
      <h2 id="generator-title" className="sr-only">
        {g.title}
      </h2>
      <section className="space-y-3">
        <StepTitle n={1}>{g.stepPhoto}</StepTitle>
        <button
          type="button"
          disabled={busy}
          onClick={play.openFile}
          onDragOver={(event) => {
            event.preventDefault()
            play.setDragging(true)
          }}
          onDragLeave={() => play.setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            play.setDragging(false)
            void play.selectFile(event.dataTransfer.files?.[0])
          }}
          className={`flex w-full items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${
            dragging ? 'border-accent bg-accent/5' : 'border-line hover:border-fg/40'
          }`}
        >
          {photo ? (
            <span className="flex items-center gap-4 text-left">
              <img src={photo.previewUrl} alt="" className="size-20 rounded-lg object-cover" />
              <span className="space-y-1">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {uploading ? <Spinner /> : <CircleCheck className="size-4 text-emerald-600" />}
                  {uploading ? g.uploading : g.uploaded}
                </span>
                <span className="block text-xs text-muted underline">{g.change}</span>
              </span>
            </span>
          ) : (
            <span className="flex flex-col items-center gap-2.5">
              <span className="grid size-11 place-items-center rounded-full bg-ink text-ink-fg">
                <Upload className="size-5" />
              </span>
              <span className="text-sm font-semibold">{g.dropTitle}</span>
              <span className="text-xs text-muted">{g.dropHint}</span>
            </span>
          )}
        </button>
        <p className="text-xs leading-5 text-muted">{g.guidance}</p>
      </section>

      <section className="space-y-3">
        <StepTitle n={2}>{g.stepLength}</StepTitle>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-bg-soft p-1" role="radiogroup" aria-label={g.stepLength}>
          {site.durations.map((item) => {
            const active = item.id === play.durationId
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                data-testid={`duration-${item.id}`}
                onClick={() => play.selectDuration(item.id)}
                className={`rounded-lg px-2 py-2 text-center transition ${active ? 'bg-card shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg'}`}
              >
                <span className="block text-sm font-semibold">
                  {g.seconds(item.seconds)}
                  {'isFull' in item && item.isFull ? ` · ${g.full}` : ''}
                </span>
                <span className="block text-xs text-muted">{g.creditsLabel(item.credits)}</span>
              </button>
            )
          })}
        </div>
      </section>

      <label className="flex items-start gap-3 text-xs leading-5 text-muted">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => play.setConsent(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--ink)]"
          data-testid="consent"
        />
        <span>{g.consent}</span>
      </label>

      <div className="space-y-2">
        {loading ? (
          <div className="btn-primary w-full py-3.5 opacity-60">
            <Spinner />
          </div>
        ) : !user ? (
          <a href={signInHref(config, pathname, lp('/sign-in'))} className="btn-primary w-full py-3.5" data-testid="generator-sign-up">
            <GoogleIcon /> {g.ctaSignUp}
          </a>
        ) : shortfall > 0 ? (
          <LocalLink to="/pricing" className="btn-primary w-full py-3.5" data-testid="generator-buy">
            {g.ctaBuy}
          </LocalLink>
        ) : (
          <button
            type="button"
            className="btn-primary w-full py-3.5"
            disabled={busy || !photo || !consent}
            onClick={() => void play.generate()}
            data-testid="generate"
          >
            {play.submitting ? <Spinner /> : null}
            {g.ctaGenerate(duration.credits)}
          </button>
        )}
        {user ? (
          <p className="text-center text-xs text-muted" data-testid="generator-balance">
            {g.balance(user.credits)}
            {shortfall > 0 ? ` · ${g.needMore(shortfall)}` : ''}
          </p>
        ) : null}
        {user && photo && !consent && !generation ? <p className="text-center text-xs text-muted">{g.needConsent}</p> : null}
        <ErrorText code={error} />
      </div>

      {generation ? <GenerationResult generation={generation} onReset={play.reset} /> : null}
    </section>
  )
}

function StepTitle({ n, children }: { n: number; children: string }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold">
      <span className="grid size-5 place-items-center rounded-full bg-ink text-[11px] text-ink-fg">{n}</span>
      {children}
    </h3>
  )
}

function GenerationResult({ generation, onReset }: { generation: Generation; onReset: () => void }) {
  const g = useContent().generator
  const locale = useLocale()
  return (
    <div className="space-y-3 rounded-xl border border-line bg-bg-soft p-4" data-testid="generation-status" data-status={generation.status}>
      {isActiveGeneration(generation) ? (
        <p className="flex items-start gap-2 text-sm">
          <Spinner className="mt-0.5 size-4 shrink-0" />
          {generation.status === 'queued' ? g.queued : g.processing}
        </p>
      ) : generation.status === 'succeeded' && generation.videoUrl ? (
        <>
          <p className="flex items-center gap-2 text-sm font-semibold">
            <CircleCheck className="size-4 text-emerald-600" /> {g.succeeded}
          </p>
          <div className="relative mx-auto w-fit">
            <AiBadge />
            <video src={generation.videoUrl} controls playsInline className="max-h-[420px] rounded-lg bg-black" data-testid="generation-video" />
          </div>
          <p className="text-xs text-muted" data-testid="ai-notice">
            {g.aiNotice}
            {generation.expiresAt ? ` ${g.expiresOn(formatDate(generation.expiresAt, locale))}` : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={`${generation.videoUrl}?download=1`} className="btn-primary px-4 py-2" download>
              <Download className="size-4" /> {g.download}
            </a>
            <LocalLink to="/dashboard" className="btn-ghost px-4 py-2">
              {g.viewAll}
            </LocalLink>
            <button type="button" className="btn-ghost px-4 py-2" onClick={onReset}>
              {g.makeAnother}
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2 font-semibold text-red-600 dark:text-red-400">
            <CircleAlert className="size-4" /> {g.failed}
          </p>
          {generation.refunded ? <p className="text-muted">{g.refunded}</p> : null}
          <button type="button" className="btn-ghost px-4 py-2" onClick={onReset}>
            {g.makeAnother}
          </button>
        </div>
      )}
    </div>
  )
}
