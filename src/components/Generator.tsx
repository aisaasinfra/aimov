import { useRouterState } from '@tanstack/react-router'
import { CircleAlert, CircleCheck, Download } from 'lucide-react'
import { site } from '#/config/site'
import { isActiveGeneration, type Generation } from '#/lib/api'
import { useContent, useLocale, useLocalePath } from '#/lib/i18n'
import { signInHref, useSession } from '#/lib/session'
import { templateCopy, usePlay } from './play'
import { AiBadge, ErrorText, LocalLink, Spinner, formatDate } from './ui'

export function Generator() {
  const c = useContent()
  const g = c.generator
  const playCopy = c.play
  const lp = useLocalePath()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { user, config, loading } = useSession()
  const play = usePlay()
  const { photo, uploading, dragging, busy, consent, shortfall, error, generation } = play
  const world = templateCopy(playCopy.templates, play.template.id)

  return (
    <section className="play-studio" aria-labelledby="generator-title" data-testid="generator">
      <h2 id="generator-title" className="sr-only">
        {g.title}
      </h2>
      <div className="play-studio-photo">
        <p className="play-guest-note text-sm leading-6 text-muted">{playCopy.guestNote}</p>
        <p className="mt-3 text-sm font-semibold">{g.stepPhoto}</p>
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
          className={`mt-2 flex w-full items-center gap-3 rounded-xl border border-dashed px-3 py-2.5 text-left transition ${
            dragging ? 'border-accent bg-accent/5' : 'border-line bg-bg hover:border-fg/30'
          }`}
        >
          {photo ? (
            <img src={photo.previewUrl} alt="" className="size-12 rounded-lg object-cover" />
          ) : (
            <span className="btn-berry pointer-events-none shrink-0 whitespace-nowrap px-3 py-1.5 text-sm">{playCopy.choosePhoto}</span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">
              {photo ? (uploading ? g.uploading : photo.file.name) : playCopy.noFile}
            </span>
            <span className="block text-xs text-muted">{photo ? g.change : g.dropHint}</span>
          </span>
          {photo ? uploading ? <Spinner className="ml-auto" /> : <CircleCheck className="ml-auto size-4 shrink-0 text-emerald-700" /> : null}
        </button>
      </div>
      <div className="play-studio-actions">
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
        <label className="flex items-start gap-3 text-xs leading-5 text-muted">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => play.setConsent(event.target.checked)}
            id="consent"
            className="mt-0.5 size-4 shrink-0 accent-[#8b2d32]"
            data-testid="consent"
          />
          <span>{g.consent}</span>
        </label>
        <div className="space-y-2">
          {loading ? (
            <div className="btn-berry w-full py-3.5 opacity-60">
              <Spinner />
            </div>
          ) : !user ? (
            <a href={signInHref(config, pathname, lp('/sign-in'))} className="btn-berry w-full py-3.5" data-testid="generator-sign-up">
              {playCopy.create}
            </a>
          ) : shortfall > 0 ? (
            <LocalLink to="/pricing" className="btn-berry w-full py-3.5" data-testid="generator-buy">
              {g.ctaBuy}
            </LocalLink>
          ) : (
            <button
              type="button"
              className="btn-berry w-full py-3.5"
              disabled={busy || !photo || !consent}
              onClick={() => void play.generate()}
              data-testid="generate"
            >
              {play.submitting ? <Spinner /> : null}
              {playCopy.create}
            </button>
          )}
          <div className="play-selected-world" data-testid="selected-world" data-scene={play.template.id}>
            <img src={play.template.thumb} alt="" />
            <span className="min-w-0">
              <span className="play-selected-kicker">{playCopy.selectedWorld}</span>
              <span className="play-selected-name">{world.name}</span>
            </span>
          </div>
          {user ? (
            <p className="text-center text-xs text-muted">
              {g.balance(user.credits)}
              {shortfall > 0 ? ` · ${g.needMore(shortfall)}` : ''}
            </p>
          ) : null}
          {user && photo && !consent && !generation ? <p className="text-center text-xs text-muted">{g.needConsent}</p> : null}
          <ErrorText code={error} />
        </div>
        {generation ? <GenerationResult generation={generation} onReset={play.reset} /> : null}
      </div>
    </section>
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
            <a href={`${generation.videoUrl}?download=1`} className="btn-berry px-4 py-2" download>
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
