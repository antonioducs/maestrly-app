// The viewer shell: the top bar, the page in a sandboxed frame, and the comments pinned above it. Every text reaches
// the DOM as text; nothing coming from the API or the frame is parsed as HTML.
import { type ArtifactApi, bodyOf, createApi } from './api.js'
import { createBar, type Viewport } from './bar.js'
import { createBoardSync } from './board.js'
import { type CommentsController, createComments } from './comments.js'
import {
  type BridgeMessage,
  CONTENT_SANDBOX,
  type DesignScreen,
  type FrameResponse,
  parseBridgeMessage,
  type PublicComment,
  type ViewerState,
} from './contract.js'
import { createDesignController, type DesignController } from './design.js'
import { describeDraftChanges, describeSuggestionChanges, viewportKindOf } from './design-ui-model.js'
import { copyText, h, toast } from './dom.js'
import { showEntry } from './gate.js'
import { entryScreen, hasAccess, type LinkFragment, parseFragment } from './gate-model.js'
import { format, pickLocale, type ShellKey } from './i18n.js'
import { createInspectView, type InspectView } from './inspect.js'
import { closePopover, popoverOpen } from './popover.js'
import { createResponses } from './responses.js'
import { createScreensSurface, type ScreensSurface } from './screens.js'
import { createTokensPanel, openTokenSaveDialog, type TokenSaveDialog, type TokensPanel } from './tokens.js'

const VIEWER_PATH = /^\/a\/([A-Za-z0-9_-]{22})$/
/** How often a reader without earlier versions checks whether a newer one replaced the page on screen. */
const REPLACED_CHECK_MS = 30_000
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
  let current = artifact.currentVersion
  let version = initialVersion
  let viewport: Viewport = 'desktop'
  let full = false
  let comments: CommentsController | null = null
  let design: DesignController | null = null
  let inspectView: InspectView | null = null
  let tokensPanel: TokensPanel | null = null
  let screensSurface: ScreensSurface | null = null
  let screensSurfaceVersion = -1
  let activeDialog: TokenSaveDialog | null = null
  let lastInspectedSelector: string | null = null
  // A newer version replaced the one on screen for a reader who cannot open earlier ones: only reloading shows it.
  let replaced = false
  // A whiteboard's canvas fills the frame: comments are about the whole board, never a spot in it.
  const whiteboard = artifact.kind === 'whiteboard'
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
  const side = h('aside', { class: 'side', hidden: true })
  const notice = h('div', { class: 'notice', role: 'status', hidden: true })

  function applyScreenViewport(screen: DesignScreen): void {
    const next = viewportKindOf(screen.viewport)
    if (next === viewport) return
    viewport = next
    stage.dataset.viewport = next
  }

  function toggleScreens(): void {
    if (!design) return
    const snap = design.snapshot()
    if (!snap.design) return
    const entering = snap.view !== 'screens'
    if (entering) {
      comments?.setCommenting(false)
      comments?.escape()
    }
    design.setView(entering ? 'screens' : 'page')
    if (entering) screensSurface?.surface.focus({ preventScroll: true })
  }

  function toggleInspect(): void {
    if (!design) return
    const snap = design.snapshot()
    if (snap.view === 'screens') return
    design.setInspecting(!snap.inspecting)
  }

  function toggleTokens(): void {
    if (!design) return
    const snap = design.snapshot()
    if (!snap.design && !snap.loading && !snap.loadError) return
    const opening = !snap.tokensOpen
    if (opening) comments?.setList(false)
    design.setTokensOpen(opening)
  }

  const bar = createBar({
    t,
    locale,
    state,
    comments: !preview,
    design:
      !whiteboard && !preview
        ? { onToggleScreens: toggleScreens, onToggleInspect: toggleInspect, onToggleTokens: toggleTokens }
        : undefined,
    onVersion: (next) => setVersion(next),
    onViewport: (next) => {
      viewport = next
      stage.dataset.viewport = next
      sync()
    },
    onToggleCommenting: () => toggleCommenting(),
    onToggleList: () => {
      if (!comments) return
      const opening = !comments.listOpen
      if (opening) {
        design?.setTokensOpen(false)
        design?.clearSelection()
      }
      comments.setList(opening)
    },
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

  app.replaceChildren(bar.root, notice, h('div', { class: 'workspace' }, stage, list, side))

  function sync(): void {
    const snap = design?.snapshot() ?? null
    if (snap) {
      const nextSel = snap.inspected ? `${snap.inspected.selector}\n${snap.inspected.component ?? ''}` : null
      if (nextSel !== lastInspectedSelector) {
        lastInspectedSelector = nextSel
        if (nextSel !== null) {
          if (comments?.listOpen) comments.setList(false)
          if (snap.tokensOpen) design?.setTokensOpen(false)
        }
      }
      const isScreens = snap.view === 'screens' && Boolean(snap.design)
      device.hidden = isScreens
      if (isScreens) {
        if (!screensSurface || screensSurfaceVersion !== snap.version) {
          screensSurface?.destroy()
          screensSurface = createScreensSurface({
            t,
            controller: design!,
            stage,
            float,
            onScreenOpened: applyScreenViewport,
          })
          screensSurfaceVersion = snap.version
        }
        screensSurface.sync(snap)
        screensSurface.renderControls(snap)
      } else if (screensSurface) {
        screensSurface.destroy()
        screensSurface = null
        screensSurfaceVersion = -1
      }
      if (snap.tokensOpen) {
        inspectView?.render(snap)
        tokensPanel?.render(snap)
      } else {
        tokensPanel?.render(snap)
        inspectView?.render(snap)
      }
      comments?.refreshView()
    }
    bar.update({
      version,
      viewport,
      commenting: comments?.commenting ?? false,
      listOpen: comments?.listOpen ?? false,
      openCounts: comments?.openCounts() ?? new Map(),
      design: snap
        ? {
            hasContract: Boolean(snap.design || snap.tokensOpen || snap.loadError),
            view: snap.view,
            inspecting: snap.inspecting,
            tokensOpen: snap.tokensOpen,
            pendingChanges: snap.draftChanges.length,
          }
        : undefined,
    })
    notice.hidden = !replaced && version === current
    if (notice.hidden) return
    if (replaced) {
      notice.replaceChildren(
        h('span', {}, t('noticeReplaced')),
        h(
          'button',
          { type: 'button', class: 'notice-action', onclick: () => location.reload() },
          t('noticeReplacedAction')
        )
      )
      return
    }
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
      if (response.status === 409 && (await bodyOf(response)).error === 'version_replaced') return showReplaced()
      if (!response.ok) throw new Error(String(response.status))
      const body = (await response.json()) as Partial<FrameResponse>
      if (typeof body.url !== 'string' || !body.url.startsWith('/c/')) throw new Error('Unexpected frame response')
      frame.src = body.url
      void design?.setVersion(number, body.url, body.expiresAt)
    } catch {
      failure.hidden = false
    }
  }

  function showReplaced(): void {
    if (replaced) return
    replaced = true
    sync()
  }

  // Without earlier versions, the page on screen stops loading once a new one is published; the viewer says so.
  if (!state.can.history && !preview) {
    const check = async () => {
      if (replaced || document.visibilityState !== 'visible') return
      const next = await api.state()
      if (hasAccess(next) && next.artifact.currentVersion !== current) showReplaced()
    }
    const timer = setInterval(() => void check(), REPLACED_CHECK_MS)
    document.addEventListener('visibilitychange', () => void check())
    window.addEventListener('pagehide', () => clearInterval(timer))
  }

  function setVersion(next: number): void {
    if (next < 1 || next > current || next === version) return
    version = next
    closePopover(false)
    comments?.setVersion(next)
    sync()
    void load(next)
  }

  async function editSuggestion(comment: PublicComment): Promise<void> {
    if (!design || !comment.suggestion) return
    comments?.escape()
    comments?.setList(false)
    await design.editSuggestionInTokens(comment.suggestion.changes)
    toast(t('suggestionEdited', { author: comment.author.name.split(' ')[0] || comment.author.name }))
  }

  function openSaveDialog(): void {
    if (!design) return
    const snap = design.snapshot()
    if (!snap.design) return
    const changes = describeDraftChanges(snap.design, snap.draftChanges)
    if (changes.length === 0) return
    activeDialog?.close()
    activeDialog = openTokenSaveDialog({
      t,
      kind: 'save',
      nextVersion: current + 1,
      tokenFile: snap.design.tokenFile,
      changes,
      onConfirm: async () => {
        const res = await design!.saveTokens()
        if (res.ok) return { outcome: 'done', savedVersion: res.version.number }
        if (res.error === 'version_conflict' && res.currentVersion !== undefined) {
          if (res.currentVersion > current) {
            current = res.currentVersion
            sync()
          }
          return { outcome: 'conflict', currentVersion: res.currentVersion }
        }
        return { outcome: 'failed' }
      },
      onRebase: async (nextVersion) => {
        await design!.rebaseTokensToVersion(nextVersion)
      },
      onClose: () => {
        activeDialog = null
      },
    })
  }

  function openApplyDialog(comment: PublicComment): void {
    if (!design || !comment.suggestion) return
    const snap = design.snapshot()
    if (!snap.design) return
    const changes = describeSuggestionChanges(snap.design, comment.suggestion.changes)
    if (changes.length === 0) return
    activeDialog?.close()
    activeDialog = openTokenSaveDialog({
      t,
      kind: 'apply',
      nextVersion: current + 1,
      tokenFile: snap.design.tokenFile,
      authorName: comment.author.name,
      changes,
      onConfirm: async () => {
        const res = await design!.applySuggestion(comment.id)
        if (res.ok) {
          comments?.ingestComment(res.comment, true)
          return { outcome: 'done', savedVersion: res.version.number }
        }
        if (res.error === 'suggestion_conflict') {
          return { outcome: 'stale', staleNames: res.staleTokens ? [...res.staleTokens] : undefined }
        }
        if (res.error === 'version_conflict' && res.currentVersion !== undefined) {
          if (res.currentVersion > current) {
            current = res.currentVersion
            sync()
          }
          return { outcome: 'conflict', currentVersion: res.currentVersion }
        }
        return { outcome: 'failed' }
      },
      onRebase: async (nextVersion) => {
        await design!.rebaseTokensToVersion(nextVersion)
      },
      onEditInTokens: () => {
        void editSuggestion(comment)
      },
      onClose: () => {
        activeDialog = null
      },
    })
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
      onReplaced: showReplaced,
      suggestions: !whiteboard
        ? {
            getDesign: () => design?.snapshot().design ?? null,
            getPreviewingCommentId: () => design?.snapshot().previewingCommentId ?? null,
            getDraftChanges: () => {
              const snap = design?.snapshot()
              return snap?.design ? describeDraftChanges(snap.design, snap.draftChanges) : []
            },
            onTogglePreview: (comment) => {
              if (!design || !comment.suggestion) return
              const previewing = design.snapshot().previewingCommentId === comment.id
              design.previewSuggestion(
                previewing ? null : comment.id,
                previewing ? undefined : comment.suggestion.changes
              )
            },
            onApply: (comment) => openApplyDialog(comment),
            onEditInTokens: (comment) => void editSuggestion(comment),
            onSubmitSuggestion: (body, guestName) => design!.suggestTokens(body, guestName),
          }
        : undefined,
    })

  const responses = createResponses({
    api,
    t,
    state,
    frame,
    preview,
    version: () => version,
    onIdentity: sync,
    onReplaced: showReplaced,
  })
  const board = whiteboard
    ? createBoardSync({ api, frame, preview, onLost: () => showMessage(t('boardLost'), t('boardLostDetail')) })
    : null

  if (!whiteboard && !preview) {
    design = createDesignController({
      api,
      state,
      stageFrame: frame,
      version,
      preview,
      onChange: sync,
      onDisableCommenting: () => comments?.setCommenting(false),
      onVersionCreated: (nextVersion) => {
        current = nextVersion.number
        version = nextVersion.number
        comments?.setVersion(nextVersion.number)
        sync()
        void load(nextVersion.number)
      },
      onVersionSynced: (nextVersion, latestCurrent) => {
        if (latestCurrent > current) current = latestCurrent
        version = nextVersion
        comments?.setVersion(nextVersion)
        sync()
      },
      onReplaced: showReplaced,
      onIdentityChanged: sync,
    })
    inspectView = createInspectView({
      t,
      controller: design,
      stage,
      overlay,
      float,
      side,
      onOpenToken: (name) => {
        comments?.setList(false)
        tokensPanel?.focusToken(name)
      },
      onScreenOpened: applyScreenViewport,
    })
    tokensPanel = createTokensPanel({
      t,
      state,
      controller: design,
      side,
      onRequestSave: openSaveDialog,
      onRequestSuggest: () => {
        comments?.openSuggestDraft()
      },
    })
  }

  function toggleCommenting(): void {
    if (!comments) return
    if (design?.snapshot().view === 'screens') return
    if (whiteboard) comments.setList(!comments.listOpen)
    else {
      const next = !comments.commenting
      if (next) design?.setInspecting(false)
      comments.setCommenting(next)
    }
  }

  function onKey(key: string): void {
    if (key === 'Escape') {
      if (popoverOpen()) closePopover()
      else if (design?.snapshot().view === 'screens' && design.snapshot().focusedScreenId && screensSurface) {
        screensSurface.focus(null)
      } else if (comments?.hasCard) {
        comments.escape()
      } else if (design?.escape()) return
      else if (comments?.escape()) return
      else if (full) setFull(false)
    } else if (key === 'c') toggleCommenting()
    else if (key === 'f') setFull(!full)
    else if (key === 'i') toggleInspect()
    else if (key === 's') toggleScreens()
    else if (key === 't') toggleTokens()
  }

  function onMessage(message: BridgeMessage): void {
    if (message.type === 'error') toast(t('pageError', { message: message.message }))
    else if (message.type === 'key') onKey(message.key)
    else if (message.type === 'response-get' || message.type === 'response-submit') responses.handle(message)
    else if (message.type === 'board-load' || message.type === 'board-push') board?.handle(message)
    else if (whiteboard && (message.type === 'selection' || message.type === 'pick')) return
    else {
      if (message.type === 'pointer') closePopover(false)
      comments?.handle(message)
    }
  }

  window.addEventListener('message', (event) => {
    const message = parseBridgeMessage(event.data)
    if (!message) return
    const target = design
      ? design.routeMessage(event.source, message)
      : event.source === frame.contentWindow
        ? 'stage'
        : null
    if (target === 'screen') {
      if (
        message.type === 'key' &&
        (message.key === 'Escape' || message.key === 's' || message.key === 't' || message.key === 'f')
      ) {
        onKey(message.key)
      }
      return
    }
    if (target === 'stage') onMessage(message)
  })
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const typing =
      (event.target instanceof HTMLElement && event.target.isContentEditable) ||
      (event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null)
    const lower = event.key.length === 1 ? event.key.toLowerCase() : event.key
    if (event.key === 'Escape') onKey('Escape')
    else if (!typing && (lower === 'c' || lower === 'f' || lower === 'i' || lower === 's' || lower === 't'))
      onKey(lower)
  })
  // A press beside the page, around it, closes the conversation that is open.
  stage.addEventListener('pointerdown', (event) => {
    if (event.target === stage || event.target === float) comments?.escape()
  })
  // The page measures itself when its frame changes size; asking again covers a frame the browser is not painting.
  const relayoutOverlays = () => {
    comments?.relayout()
    if (design) inspectView?.renderOverlay(design.snapshot())
  }
  new ResizeObserver(relayoutOverlays).observe(device)
  device.addEventListener('transitionend', (event) => {
    if (event.target === device) relayoutOverlays()
  })

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
