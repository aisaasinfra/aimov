import { useRouterState } from '@tanstack/react-router'
import { Plus, Upload } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { findVideoTemplate, site, type VideoTemplate } from '#/config/site'
import { api, errorCode, isActiveGeneration, type Generation } from '#/lib/api'
import { track } from '#/lib/attribution'
import { useContent, useLocale, useLocalePath } from '#/lib/i18n'
import { signInHref, useSession } from '#/lib/session'

type Photo = { file: File; previewUrl: string; uploadId: string | null }

type PlayApi = {
  inputRef: RefObject<HTMLInputElement | null>
  photo: Photo | null
  uploading: boolean
  dragging: boolean
  setDragging: (value: boolean) => void
  durationId: string
  templateId: string
  template: VideoTemplate
  consent: boolean
  setConsent: (value: boolean) => void
  submitting: boolean
  error: string | null
  generation: Generation | null
  duration: (typeof site.durations)[number]
  shortfall: number
  busy: boolean
  selectFile: (file: File | undefined) => Promise<void>
  selectDuration: (id: string) => void
  selectTemplate: (id: string, source: 'strip' | 'wall') => void
  generate: () => Promise<void>
  requestCreate: () => void
  reset: () => void
  openFile: () => void
  wallPicked: boolean
  createVisible: boolean
}

const PlayContext = createContext<PlayApi | null>(null)
const POLL_MS = 3000

export function usePlay() {
  const value = useContext(PlayContext)
  if (!value) throw new Error('usePlay must be used inside PlayProvider')
  return value
}

export function PlayProvider({ children }: { children: ReactNode }) {
  const lp = useLocalePath()
  const locale = useLocale()
  const dropTitle = useContent().generator.dropTitle
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { user, config, loading, refresh } = useSession()
  const inputRef = useRef<HTMLInputElement>(null)
  const first = site.videoTemplates[0]!
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [templateId, setTemplateId] = useState<string>(first.id)
  const [durationId, setDurationId] = useState<string>(first.durationId)
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState<Generation | null>(null)
  const [wallPicked, setWallPicked] = useState(false)
  const [createVisible, setCreateVisible] = useState(true)

  const template = findVideoTemplate(templateId) ?? first
  const duration = site.durations.find((item) => item.id === durationId) ?? site.durations[0]!
  const shortfall = user ? Math.max(0, duration.credits - user.credits) : 0
  const busy = uploading || submitting || (generation !== null && isActiveGeneration(generation))

  useEffect(
    () => () => {
      if (photo) URL.revokeObjectURL(photo.previewUrl)
    },
    [photo],
  )

  useEffect(() => {
    if (!generation || !isActiveGeneration(generation)) return
    const timer = setTimeout(async () => {
      try {
        const data = await api<{ generation: Generation }>(`/api/generations/${generation.id}`)
        setGeneration(data.generation)
        if (!isActiveGeneration(data.generation)) await refresh()
      } catch (err) {
        setError(errorCode(err))
        setGeneration({ ...generation })
      }
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [generation, refresh])

  useEffect(() => {
    const node = document.getElementById('create')
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => setCreateVisible(entry?.isIntersecting ?? true),
      { threshold: 0.15 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const pad = createVisible ? '' : '5.5rem'
    document.body.style.paddingBottom = pad
    document.documentElement.style.scrollPaddingBottom = pad
    return () => {
      document.body.style.paddingBottom = ''
      document.documentElement.style.scrollPaddingBottom = ''
    }
  }, [createVisible])

  async function upload(file: File) {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const data = await api<{ upload: { id: string } }>('/api/uploads', { form })
      return data.upload.id
    } finally {
      setUploading(false)
    }
  }

  async function selectFile(file: File | undefined) {
    if (!file) return
    setError(null)
    if (!(site.upload.contentTypes as readonly string[]).includes(file.type)) return setError('unsupported_file_type')
    if (file.size > site.upload.maxBytes) return setError('file_too_large')
    const next: Photo = { file, previewUrl: URL.createObjectURL(file), uploadId: null }
    setPhoto(next)
    setGeneration(null)
    if (!user) return
    try {
      const uploadId = await upload(file)
      setPhoto((current) => (current?.file === file ? { ...current, uploadId } : current))
    } catch (err) {
      setError(errorCode(err))
    }
  }

  function selectTemplate(id: string, source: 'strip' | 'wall') {
    const next = findVideoTemplate(id)
    if (!next || busy) return
    setTemplateId(next.id)
    setDurationId(next.durationId)
    if (source === 'wall') setWallPicked(true)
  }

  function selectDuration(id: string) {
    if (busy) return
    setDurationId(id)
    const match = site.videoTemplates.find((item) => item.durationId === id)
    if (match) setTemplateId(match.id)
  }

  async function generate() {
    if (!photo) return setError('invalid_upload')
    setError(null)
    setSubmitting(true)
    try {
      const uploadId = photo.uploadId ?? (await upload(photo.file))
      if (!photo.uploadId) setPhoto({ ...photo, uploadId })
      const data = await api<{ generation: Generation }>('/api/generations', {
        json: { uploadId, durationId, templateId, locale },
      })
      track('generate_video', { duration_id: durationId, template_id: templateId, credits: data.generation.creditsCost })
      setGeneration(data.generation)
      await refresh()
    } catch (err) {
      setError(errorCode(err))
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }

  function openFile() {
    inputRef.current?.click()
  }

  function requestCreate() {
    if (loading || busy) return
    if (!user) {
      location.href = signInHref(config, pathname, lp('/sign-in'))
      return
    }
    if (shortfall > 0) {
      location.href = lp('/pricing')
      return
    }
    if (!photo) {
      openFile()
      return
    }
    if (!consent) return
    void generate()
  }

  function reset() {
    setGeneration(null)
    setError(null)
  }

  const apiValue: PlayApi = {
    inputRef,
    photo,
    uploading,
    dragging,
    setDragging,
    durationId,
    templateId,
    template,
    consent,
    setConsent,
    submitting,
    error,
    generation,
    duration,
    shortfall,
    busy,
    selectFile,
    selectDuration,
    selectTemplate,
    generate,
    requestCreate,
    reset,
    openFile,
    wallPicked,
    createVisible,
  }

  return (
    <PlayContext.Provider value={apiValue}>
      <input
        ref={inputRef}
        type="file"
        accept={site.upload.contentTypes.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-label={dropTitle}
        data-testid="photo-input"
        onChange={(event) => {
          void selectFile(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      {children}
      <PlayChrome />
    </PlayContext.Provider>
  )
}

function templateCopy(templates: Record<string, { name: string; blurb: string }>, id: string) {
  return templates[id] ?? { name: id, blurb: '' }
}

export function TemplateStrip() {
  const play = usePlay()
  const c = useContent().play
  return (
    <div className="space-y-2" data-testid="template-strip">
      <p className="text-xs font-medium tracking-[0.18em] text-accent-text uppercase">{c.stripLabel}</p>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 snap-x">
        {site.videoTemplates.map((item) => {
          const active = item.id === play.templateId
          const copy = templateCopy(c.templates, item.id)
          const seconds = site.durations.find((duration) => duration.id === item.durationId)?.seconds ?? 0
          return (
            <article
              key={item.id}
              data-testid={`template-${item.id}`}
              data-selected={active ? 'true' : 'false'}
              className={`w-36 shrink-0 snap-start overflow-hidden rounded-2xl border bg-card ${active ? 'border-accent ring-2 ring-accent' : 'border-line'}`}
            >
              <video src={item.preview} poster={item.poster} muted playsInline loop className="aspect-[3/4] w-full object-cover" />
              <div className="space-y-2 p-2.5">
                <p className="text-sm font-semibold leading-tight">{copy.name}</p>
                <p className="text-xs text-muted">{c.seconds(seconds)}</p>
                <button
                  type="button"
                  className={active ? 'btn-primary w-full px-3 py-1.5 text-xs' : 'btn-ghost w-full px-3 py-1.5 text-xs'}
                  aria-pressed={active}
                  data-testid={`template-use-${item.id}`}
                  onClick={() => play.selectTemplate(item.id, 'strip')}
                >
                  {active ? c.selected : c.use}
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

export function TemplateWall() {
  const play = usePlay()
  const c = useContent().play
  return (
    <section id="examples" className="scroll-mt-20 border-t border-line bg-bg-soft/60 py-20" data-testid="template-wall">
      <div className="container-page">
        <p className="eyebrow text-accent-text">{c.eyebrow}</p>
        <h2 className="mt-3 max-w-2xl font-display text-4xl leading-tight sm:text-5xl">{c.wallTitle}</h2>
        <p className="mt-4 max-w-2xl text-lg leading-8 text-muted">{c.wallBody}</p>
        <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {site.videoTemplates.map((item) => {
            const active = item.id === play.templateId
            const copy = templateCopy(c.templates, item.id)
            const seconds = site.durations.find((duration) => duration.id === item.durationId)?.seconds ?? 0
            return (
              <article key={item.id} className={`card overflow-hidden ${active ? 'ring-2 ring-accent' : ''}`} data-testid={`template-wall-${item.id}`}>
                <video src={item.preview} poster={item.poster} muted playsInline loop preload="metadata" className="aspect-[3/4] w-full object-cover" />
                <div className="space-y-2 p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-semibold">{copy.name}</h3>
                    <span className="text-xs text-muted">{c.seconds(seconds)}</span>
                  </div>
                  <p className="text-sm leading-6 text-muted">{copy.blurb}</p>
                  <button
                    type="button"
                    className={active ? 'btn-primary w-full py-2 text-sm' : 'btn-ghost w-full py-2 text-sm'}
                    aria-pressed={active}
                    data-testid={`template-wall-use-${item.id}`}
                    onClick={() => play.selectTemplate(item.id, 'wall')}
                  >
                    {active ? c.selected : c.use}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export function TemplatePreview() {
  const play = usePlay()
  const c = useContent()
  const copy = templateCopy(c.play.templates, play.template.id)
  return (
    <figure className="mx-auto w-full max-w-sm" data-testid="template-preview">
      <div className="relative overflow-hidden rounded-3xl bg-ink shadow-lg ring-1 ring-black/10">
        <video
          key={play.template.preview}
          src={play.template.preview}
          poster={play.template.poster}
          muted
          playsInline
          loop
          autoPlay
          className="aspect-[9/16] max-h-[640px] w-full object-cover"
        />
      </div>
      <figcaption className="mt-3 text-center text-sm text-muted">
        {c.play.previewLabel}: {copy.name} · {c.play.seconds(play.duration.seconds)}
      </figcaption>
    </figure>
  )
}

function PlayChrome() {
  const play = usePlay()
  const c = useContent().play
  const copy = templateCopy(c.templates, play.template.id)
  if (play.createVisible) return null
  const showSticky = play.wallPicked
  return (
    <>
      <div
        data-testid="sticky-create"
        className={`${showSticky ? 'flex' : 'hidden lg:flex'} fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card/95 px-4 py-3 backdrop-blur`}
      >
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
          <img src={play.photo?.previewUrl ?? play.template.poster} alt="" className="size-12 rounded-lg object-cover" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{copy.name}</p>
            <p className="text-xs text-muted">{c.seconds(play.duration.seconds)}</p>
          </div>
          <button type="button" className="btn-ghost px-4 py-2" onClick={play.openFile}>
            <Upload className="size-4" /> {c.stickyUpload}
          </button>
          <button type="button" className="btn-primary px-4 py-2" onClick={play.requestCreate} data-testid="sticky-create-button">
            {c.stickyCreate}
          </button>
        </div>
      </div>
      {showSticky ? null : (
        <button
          type="button"
          data-testid="play-fab"
          aria-label={c.fabLabel}
          className="fixed right-5 bottom-5 z-40 grid size-14 place-items-center rounded-full bg-ink text-2xl text-ink-fg shadow-lg lg:hidden"
          onClick={play.openFile}
        >
          <Plus className="size-7" />
        </button>
      )}
    </>
  )
}
