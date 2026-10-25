import { useRouterState } from '@tanstack/react-router'
import { Plus, Upload } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { CaptionNameplate } from '#/components/caption-sleigh'
import { findVideoTemplate, site, type VideoTemplate } from '#/config/site'
import { api, errorCode, isActiveGeneration, type Generation } from '#/lib/api'
import { track } from '#/lib/attribution'
import { COVERFLOW_RELEASE_PX, coverflowSwipeDelta } from '#/lib/coverflow-drag'
import { useContent, useLocale, useLocalePath } from '#/lib/i18n'
import { playRequestPlan } from '#/lib/play-request'
import { signInHref, useSession } from '#/lib/session'

type Photo = { file: File; previewUrl: string; uploadId: string | null }
type TemplateSource = 'coverflow' | 'wall'

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
  selectTemplate: (id: string, source: TemplateSource) => void
  generate: () => Promise<void>
  requestCreate: () => void
  reset: () => void
  openFile: () => void
  wallPicked: boolean
  createVisible: boolean
}

const PlayContext = createContext<PlayApi | null>(null)
const POLL_MS = 3000
const MOBILE_QUERY = '(max-width: 1023px)'

export function usePlay() {
  const value = useContext(PlayContext)
  if (!value) throw new Error('usePlay must be used inside PlayProvider')
  return value
}

export function templateCopy(templates: Record<string, { name: string; blurb: string }>, id: string) {
  return templates[id] ?? { name: id, blurb: '' }
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
  const [durationId, setDurationId] = useState<string>(site.durations[0]!.id)
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
    document.body.dataset.playPage = 'home'
    return () => {
      delete document.body.dataset.playPage
    }
  }, [])

  useEffect(() => {
    const node = document.getElementById('create')
    if (!node || typeof IntersectionObserver === 'undefined') return
    let observer: IntersectionObserver
    try {
      observer = new IntersectionObserver(
        ([entry]) => setCreateVisible(entry?.isIntersecting ?? true),
        { root: null, rootMargin: '-64px 0px 0px 0px', threshold: 0 },
      )
    } catch {
      return
    }
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

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

  function selectTemplate(id: string, source: TemplateSource) {
    const next = findVideoTemplate(id)
    if (!next || busy) return
    setTemplateId(next.id)
    if (source === 'wall') setWallPicked(true)
  }

  function selectDuration(id: string) {
    if (busy) return
    if (!site.durations.some((item) => item.id === id)) return
    setDurationId(id)
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
    const top = window.scrollY
    inputRef.current?.click()
    const restore = () => {
      if (window.scrollY !== top) window.scrollTo(0, top)
    }
    restore()
    window.requestAnimationFrame(restore)
  }

  function requestCreate() {
    const plan = playRequestPlan({
      loading,
      busy,
      signedIn: !!user,
      shortfall,
      hasPhoto: !!photo,
      consent,
    })
    if (plan === 'wait') return
    if (plan === 'sign-in') {
      location.href = signInHref(config, pathname, lp('/sign-in'))
      return
    }
    if (plan === 'pricing') {
      location.href = lp('/pricing')
      return
    }
    if (plan === 'pick-file') {
      openFile()
      return
    }
    if (plan === 'need-consent') {
      // The checkbox sits in the hero. The sticky bar is the control the visitor can see.
      const box = document.getElementById('consent')
      box?.scrollIntoView({ block: 'center' })
      if (box instanceof HTMLElement) box.focus()
      return
    }
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

function wrapOffset(index: number, selected: number, count: number) {
  let offset = index - selected
  if (offset > count / 2) offset -= count
  if (offset < -count / 2) offset += count
  return offset
}

function indexAt(base: number, delta: number, count: number) {
  if (count <= 0) return 0
  return ((base + delta) % count + count) % count
}

export function SceneCoverflow() {
  const play = usePlay()
  const c = useContent().play
  const templates = site.videoTemplates
  const selected = Math.max(0, templates.findIndex((item) => item.id === play.templateId))
  const copy = templateCopy(c.templates, play.template.id)
  // 滑动没有产生 click 时这个标记会留下来，下一次按下先清掉，避免下一次点选被吞掉。
  const dragged = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const stopDrag = useRef<(() => void) | null>(null)

  useEffect(() => () => stopDrag.current?.(), [])

  function selectAt(base: number, delta: number) {
    const next = templates[indexAt(base, delta, templates.length)]
    if (!next) return
    play.selectTemplate(next.id, 'coverflow')
  }

  function focusScene(id: string) {
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLButtonElement>(`[data-scene-id="${id}"]`)?.focus({ preventScroll: true })
    })
  }

  function step(delta: number) {
    const next = templates[indexAt(selected, delta, templates.length)]
    if (!next) return
    play.selectTemplate(next.id, 'coverflow')
    focusScene(next.id)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    step(event.key === 'ArrowRight' ? 1 : -1)
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    dragged.current = false
    stopDrag.current?.()
    const state = { x: event.clientX, pointerId: event.pointerId, base: selected, applied: 0 }
    const end = (clientX: number) => {
      stopDrag.current?.()
      stopDrag.current = null
      const dx = clientX - state.x
      const delta = coverflowSwipeDelta(dx, 'release')
      if (Math.abs(dx) >= COVERFLOW_RELEASE_PX) {
        dragged.current = true
        // 松手时指针可能已经滑到「生成」或别的按钮上，吞掉这一下 click，避免误触。
        const swallow = (clickEvent: MouseEvent) => {
          clickEvent.preventDefault()
          clickEvent.stopPropagation()
        }
        window.addEventListener('click', swallow, true)
        requestAnimationFrame(() => window.removeEventListener('click', swallow, true))
      }
      if (delta !== state.applied) selectAt(state.base, delta)
    }
    const move = (native: PointerEvent) => {
      if (native.pointerId !== state.pointerId) return
      const dx = native.clientX - state.x
      if (Math.abs(dx) >= COVERFLOW_RELEASE_PX) dragged.current = true
      const delta = coverflowSwipeDelta(dx, 'move')
      if (delta === state.applied) return
      state.applied = delta
      selectAt(state.base, delta)
    }
    const up = (native: PointerEvent) => {
      if (native.pointerId !== state.pointerId) return
      end(native.clientX)
    }
    stopDrag.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const cards = templates
    .map((item, index) => ({ item, offset: wrapOffset(index, selected, templates.length) }))
    .filter((card) => Math.abs(card.offset) <= 2)
    .sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset))

  return (
    <div className="christmas-hero-flow" data-testid="template-coverflow">
      <div
        ref={rootRef}
        className="merry-coverflow"
        data-scene-stage=""
        data-scene={play.template.id}
        role="region"
        aria-label={c.stripLabel}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      >
        <div className="merry-coverflow-stage">
          {cards.map(({ item, offset }) => {
            const active = offset === 0
            const itemCopy = templateCopy(c.templates, item.id)
            return (
              <button
                key={item.id}
                type="button"
                className="merry-coverflow-card"
                data-offset={offset}
                data-scene-id={item.id}
                data-testid={`template-use-${item.id}`}
                data-selected={active ? 'true' : 'false'}
                aria-pressed={active}
                aria-label={itemCopy.name}
                tabIndex={offset === -2 ? -1 : 0}
                onClick={() => {
                  if (dragged.current) {
                    dragged.current = false
                    return
                  }
                  play.selectTemplate(item.id, 'coverflow')
                }}
              >
                <span className="merry-coverflow-frame">
                  <img src={item.poster} alt={active ? itemCopy.name : ''} draggable={false} />
                  {active ? (
                    <span className="merry-coverflow-hint" aria-hidden="true">
                      {c.use}
                    </span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
        <div className="merry-coverflow-fade" aria-hidden="true" />
        <div className="merry-coverflow-caption" data-testid="coverflow-caption">
          <CaptionNameplate name={copy.name} />
        </div>
      </div>
    </div>
  )
}

export function TemplateWall() {
  const play = usePlay()
  const c = useContent().play
  return (
    <section id="examples" className="scroll-mt-20 border-t border-line bg-bg-soft/50 py-16" data-testid="template-wall">
      <div className="container-page">
        <h2 className="max-w-2xl font-display text-4xl leading-tight sm:text-5xl">{c.wallTitle}</h2>
        <p className="mt-4 max-w-2xl text-lg leading-8 text-muted">{c.wallBody}</p>
        <ul className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {site.videoTemplates.map((item) => {
            const active = item.id === play.templateId
            const copy = templateCopy(c.templates, item.id)
            return (
              <li key={item.id} data-scene-card={item.id}>
                <button
                  type="button"
                  className={`block w-full overflow-hidden rounded-2xl border bg-card text-left transition hover:bg-bg-soft ${active ? 'border-ink' : 'border-line'}`}
                  aria-pressed={active}
                  data-testid={`template-wall-use-${item.id}`}
                  onClick={() => play.selectTemplate(item.id, 'wall')}
                >
                  <img src={item.thumb} alt="" className="aspect-[3/4] w-full object-cover object-top" />
                  <span className="flex items-baseline justify-between gap-2 px-3 py-2.5">
                    <span className="font-display text-base leading-tight">{copy.name}</span>
                    <span className="shrink-0 text-sm text-accent-text">{active ? c.selected : c.use}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

function PlayChrome() {
  const play = usePlay()
  const c = useContent().play
  const copy = templateCopy(c.templates, play.template.id)
  const [isMobile, setIsMobile] = useState(false)
  const [fabHidden, setFabHidden] = useState(false)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(MOBILE_QUERY)
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const stickyVisible = !play.createVisible && (!isMobile || play.wallPicked)
  const fabEligible = isMobile && !play.createVisible && !stickyVisible

  useEffect(() => {
    if (!fabEligible) return
    setFabHidden(false)
    let lastY = window.scrollY || document.documentElement.scrollTop || 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const y = window.scrollY || document.documentElement.scrollTop || 0
        const delta = y - lastY
        if (delta > 8) setFabHidden(true)
        else if (delta < -8) setFabHidden(false)
        lastY = y
      }, 150)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (timer) clearTimeout(timer)
    }
  }, [fabEligible])

  useEffect(() => {
    const mode = stickyVisible ? 'sticky' : fabEligible ? 'fab' : ''
    if (mode) document.body.dataset.playChrome = mode
    else delete document.body.dataset.playChrome
    const pad = stickyVisible ? '5.75rem' : ''
    document.body.style.paddingBottom = pad
    document.documentElement.style.scrollPaddingBottom = pad
    return () => {
      delete document.body.dataset.playChrome
      document.body.style.paddingBottom = ''
      document.documentElement.style.scrollPaddingBottom = ''
    }
  }, [stickyVisible, fabEligible])

  if (play.createVisible) return null

  return (
    <>
      {stickyVisible ? (
        <div role="region" aria-label={c.stickyCreate} data-testid="sticky-create" data-scene={play.template.id} className="play-sticky-bar">
          <div className="container-page play-sticky-bar-inner">
            <span className="play-sticky-thumb" data-testid="sticky-selected-world">
              <img src={play.template.thumb} alt="" />
            </span>
            <p className="play-sticky-title">{copy.name}</p>
            <div className="play-sticky-actions">
              <button type="button" className="btn-ghost px-3 py-2" onClick={play.openFile}>
                <Upload className="size-4" /> {play.photo ? c.stickyUploaded : c.stickyUpload}
              </button>
              <button type="button" className="btn-berry px-4 py-2" onClick={play.requestCreate} data-testid="sticky-create-button">
                {c.stickyCreate}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {fabEligible ? (
        <button
          type="button"
          data-testid="play-fab"
          aria-label={c.fabLabel}
          className={fabHidden ? 'play-upload-fab is-hidden' : 'play-upload-fab'}
          onClick={play.openFile}
        >
          <Plus className="size-7" />
        </button>
      ) : null}
    </>
  )
}
