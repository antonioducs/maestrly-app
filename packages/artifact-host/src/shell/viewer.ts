// The viewer shell: the top bar, the page in a sandboxed frame, and the comments pinned above it. Every text reaches
// the DOM as text; nothing coming from the API or the frame is parsed as HTML.
import { type ArtifactApi, createApi } from './api.js'
import { createBar, type Viewport } from './bar.js'
import { type CommentsController, createComments } from './comments.js'
import {
  type BridgeMessage,
  CONTENT_SANDBOX,
  type FrameResponse,
  parseBridgeMessage,
  type ViewerState,
} from './contract.js'
import { copyText, h, toast } from './dom.js'
import { showEntry } from './gate.js'
import { entryScreen, hasAccess, type LinkFragment, parseFragment } from './gate-model.js'
import { format, pickLocale, type ShellKey } from './i18n.js'
import { closePopover, popoverOpen } from './popover.js'

const VIEWER_PATH = /^\/a\/([A-Za-z0-9_-]{22})$/
const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
const locale = pickLocale(languages)
const t = (key: ShellKey, vars?: Record<string, string | number>) => format(locale, key, vars)
const app = document.getElementById('app') as HTMLElement

document.documentElement.lang = locale

function showMessage(title: string, detail?: string): void {
  app.replaceChildren(h('main', { class: 'message' }, h('h1', {}, title), detail && h('p', {}, detail)))
  document.title = title
}

const unavailable = () => showMessage(t('notAvailable'), t('notAvailableDetail'))

function renderViewer(api: ArtifactApi, state: ViewerState, initialVersion: number, preview: boolean): void {
  const { artifact } = state
  const current = artifact.currentVersion
  let version = initialVersion
  let viewport: Viewport = 'desktop'
  let full = false
  let comments: CommentsController | null = null
  document.title = artifact.title

  const frame = h('iframe', {
    class: 'content',
    sandbox: CONTENT_SANDBOX,
    referrerpolicy: 'no-referrer',
    title: artifact.title,
  })
  // Pins live in the viewer, above the frame: the page never receives names or comment text.
  const overlay = h('div', { class: 'overlay' })
  const failure = h(
    'div',
    { class: 'frame-failure', role: 'alert', hidden: true },
    h('p', {}, t('pageFailed')),
    h('button', { type: 'button', class: 'button', onclick: () => void load(version) }, t('retry'))
  )
  const device = h('div', { class: 'device' }, frame, overlay, failure)
  const float = h('div', { class: 'float' })
  const exitFull = h(
    'button',
    { type: 'button', class: 'exit-full', hidden: true, onclick: () => setFull(false) },
    t('exitFullScreen'),
    h('kbd', {}, 'Esc')
  )
  float.append(exitFull)
  const stage = h('main', { class: 'stage', 'data-viewport': viewport }, device, float)
  const list = h('aside', { class: 'list', 'aria-label': t('listTitle'), hidden: true })
  const notice = h('div', { class: 'notice', role: 'status', hidden: true })

  const bar = createBar({
    t,
    locale,
    state,
    comments: !preview,
    onVersion: (next) => setVersion(next),
    onViewport: (next) => {
      viewport = next
      stage.dataset.viewport = next
      sync()
    },
    onToggleCommenting: () => comments?.setCommenting(!comments.commenting),
    onToggleList: () => comments?.setList(!comments.listOpen),
    onReload: () => void load(version),
    onFullScreen: () => setFull(true),
    onCopyVersionLink: async () => {
      const base = state.sharing?.link ?? `${location.origin}${location.pathname}`
      toast((await copyText(`${base}#v=${version}`)) ? t('versionLinkCopied', { n: version }) : t('copyFailed'))
    },
    onLeave: async () => {
      await api.write('session', 'DELETE').catch(() => undefined)
      showMessage(t('left'), t('leftDetail'))
    },
  })

  app.replaceChildren(bar.root, notice, h('div', { class: 'workspace' }, stage, list))

  function sync(): void {
    bar.update({
      version,
      viewport,
      commenting: comments?.commenting ?? false,
      listOpen: comments?.listOpen ?? false,
      openCounts: comments?.openCounts() ?? new Map(),
    })
    notice.hidden = version === current
    if (notice.hidden) return
    const summary = artifact.versions.find((item) => item.number === version)?.summary
    notice.replaceChildren(
      h(
        'span',
        {},
        summary
          ? t('noticeVersionSummary', { n: version, total: current, summary })
          : t('noticeVersion', { n: version, total: current })
      ),
      h('button', { type: 'button', class: 'notice-action', onclick: () => setVersion(current) }, t('noticeAction'))
    )
  }

  function setFull(on: boolean): void {
    full = on
    document.body.classList.toggle('is-full', on)
    exitFull.hidden = !on
    comments?.relayout()
  }

  async function load(number: number): Promise<void> {
    failure.hidden = true
    try {
      const response = await api.write('frame', 'POST', { version: number })
      if (!response.ok) throw new Error(String(response.status))
      const body = (await response.json()) as Partial<FrameResponse>
      if (typeof body.url !== 'string' || !body.url.startsWith('/c/')) throw new Error('Unexpected frame response')
      frame.src = body.url
    } catch {
      failure.hidden = false
    }
  }

  function setVersion(next: number): void {
    if (next < 1 || next > current || next === version) return
    version = next
    closePopover(false)
    comments?.setVersion(next)
    sync()
    void load(next)
  }

  if (!preview)
    comments = createComments({
      api,
      t,
      locale,
      state,
      frame,
      stage,
      overlay,
      float,
      list,
      version,
      onChange: sync,
      onShowVersion: setVersion,
    })

  function onKey(key: string): void {
    if (key === 'Escape') {
      if (popoverOpen()) closePopover()
      else if (comments?.escape()) return
      else if (full) setFull(false)
    } else if (key === 'c') comments?.setCommenting(!comments.commenting)
    else if (key === 'f') setFull(!full)
  }

  function onMessage(message: BridgeMessage): void {
    if (message.type === 'error') toast(t('pageError', { message: message.message }))
    else if (message.type === 'key') onKey(message.key)
    else {
      if (message.type === 'pointer') closePopover(false)
      comments?.handle(message)
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return
    const message = parseBridgeMessage(event.data)
    if (message) onMessage(message)
  })
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const typing = event.target instanceof Element && event.target.closest('input, textarea') !== null
    if (event.key === 'Escape') onKey('Escape')
    else if (!typing && (event.key === 'c' || event.key === 'f')) onKey(event.key)
  })
  // A press beside the page, around it, closes the conversation that is open.
  stage.addEventListener('pointerdown', (event) => {
    if (event.target === stage || event.target === float) comments?.escape()
  })
  // The page measures itself when its frame changes size; asking again covers a frame the browser is not painting.
  new ResizeObserver(() => comments?.relayout()).observe(device)
  device.addEventListener('transitionend', () => comments?.relayout())

  sync()
  void load(version)
}

/** Shows the page, or what this browser may do to get to it. */
async function open(api: ArtifactApi, fragment: LinkFragment, note?: string): Promise<void> {
  const state = await api.state()
  const screen = entryScreen({ fragment, state })
  if (screen.screen === 'unavailable') return unavailable()
  if (screen.screen === 'viewer' && hasAccess(state)) {
    const known = state.artifact.versions.some((version) => version.number === fragment.version)
    return renderViewer(
      api,
      state,
      known && fragment.version ? fragment.version : state.artifact.currentVersion,
      fragment.preview === true
    )
  }
  if (screen.screen === 'viewer') return unavailable()
  const stay: LinkFragment = { version: fragment.version }
  showEntry(
    screen,
    {
      app,
      api,
      t,
      ownerName: state?.ownerName ?? '',
      onEntered: () => void open(api, stay),
      reconsider: (reason) => void open(api, stay, reason),
      unavailable,
    },
    note
  )
}

async function main(): Promise<void> {
  const match = VIEWER_PATH.exec(location.pathname)
  if (!match) return unavailable()
  const api = createApi(`/a/${match[1]}/api`)
  // Tokens travel in the fragment, which never reaches a server; drop it from the address bar before anything else.
  const fragment = parseFragment(location.hash)
  if (location.hash) history.replaceState(null, '', location.pathname)

  showMessage(t('loading'))
  if (fragment.owner) await api.write('session/owner', 'POST', { ticket: fragment.owner }).catch(() => undefined)
  await open(api, fragment)
}

void main()
