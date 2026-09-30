// The viewer shell: who is viewing, the version picker and the sandboxed content frame. Every text reaches the DOM
// through `textContent`; nothing coming from the API or the frame is parsed as HTML.
import { type ArtifactApi, createApi } from './api.js'
import { createComments } from './comments.js'
import { CONTENT_SANDBOX, type FrameResponse, parseBridgeMessage, type ViewerState } from './contract.js'
import { button, element } from './dom.js'
import { showEntry } from './gate.js'
import { entryScreen, hasAccess, type LinkFragment, parseFragment } from './gate-model.js'
import { format, pickLocale, type ShellKey } from './i18n.js'
import { createListbox } from './listbox.js'

const VIEWER_PATH = /^\/a\/([A-Za-z0-9_-]{22})$/
const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
const locale = pickLocale(languages)
const t = (key: ShellKey, vars?: Record<string, string | number>) => format(locale, key, vars)
const app = document.getElementById('app') as HTMLElement

document.documentElement.lang = locale

function showMessage(title: string, detail?: string): void {
  const box = element('main', 'message')
  box.append(element('h1', undefined, title))
  if (detail) box.append(element('p', undefined, detail))
  app.replaceChildren(box)
  document.title = title
}

const unavailable = () => showMessage(t('notAvailable'), t('notAvailableDetail'))

const guestLabel = (name: string | null): string => (name ? t('unverified', { name }) : t('guest'))

/** Who the viewer is here: the owner, a person the owner confirmed, or a guest whose name nobody checked. */
function identityChip(state: ViewerState): HTMLElement {
  const { identity } = state
  if (identity.kind === 'owner') return element('span', 'chip', t('owner'))
  if (identity.kind === 'guest') return element('span', 'chip', guestLabel(identity.name))
  const chip = element('span', 'chip verified', t('verified', { name: identity.name }))
  const owner = state.ownerName || t('theOwner')
  chip.title = t(identity.kind === 'invited' ? 'invitedBy' : 'approvedBy', { owner })
  return chip
}

function renderViewer(api: ArtifactApi, state: ViewerState, initialVersion: number): void {
  const { artifact } = state
  document.title = artifact.title

  const header = element('header', 'bar')
  const title = element('h1', 'title', artifact.title)
  title.title = artifact.title
  const versions = [...artifact.versions].sort((a, b) => b.number - a.number)
  const picker = createListbox({
    label: t('versionsLabel'),
    value: String(initialVersion),
    items: versions.map((version) => ({
      value: String(version.number),
      label: t('version', { n: version.number }),
      hint: version.number === artifact.currentVersion ? t('current') : undefined,
    })),
    onChange: (value) => void load(Number(value)),
  })
  const identity = element('div', 'identity')
  const leave = button(t('leave'), 'button', async () => {
    leave.disabled = true
    await api.write('session', 'DELETE').catch(() => undefined)
    showMessage(t('left'), t('leftDetail'))
  })
  const chip = identityChip(state)
  identity.append(chip, leave)

  const banner = element('div', 'banner')
  banner.setAttribute('role', 'status')
  banner.hidden = true

  const frame = element('iframe', 'content')
  frame.setAttribute('sandbox', CONTENT_SANDBOX)
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.title = artifact.title

  const comments = createComments({
    api,
    t,
    locale,
    state,
    frame,
    version: initialVersion,
    onNamed: (name) => {
      chip.textContent = guestLabel(name)
    },
  })
  header.append(title, picker, comments.toggle, identity)
  // The frame and the button that floats over a selection share one box; the panel sits beside it.
  const stage = element('div', 'stage')
  stage.append(frame, comments.action)
  const workspace = element('div', 'workspace')
  workspace.append(stage, comments.panel)

  app.replaceChildren(header, banner, workspace)

  const showBanner = (text: string, retry?: () => void) => {
    banner.replaceChildren(element('span', undefined, text))
    if (retry) banner.append(button(t('retry'), 'button', retry))
    banner.hidden = false
  }

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return
    const message = parseBridgeMessage(event.data)
    if (!message) return
    if (message.type === 'error') showBanner(t('pageError', { message: message.message }))
    else comments.handle(message)
  })

  async function load(version: number): Promise<void> {
    banner.hidden = true
    comments.setVersion(version)
    try {
      const response = await api.write('frame', 'POST', { version })
      if (!response.ok) throw new Error(String(response.status))
      const body = (await response.json()) as Partial<FrameResponse>
      if (typeof body.url !== 'string' || !body.url.startsWith('/c/')) throw new Error('Unexpected frame response')
      frame.src = body.url
    } catch {
      showBanner(t('notAvailable'), () => void load(version))
    }
  }

  void load(initialVersion)
}

/** Shows the page, or what this browser may do to get to it. */
async function open(api: ArtifactApi, fragment: LinkFragment, note?: string): Promise<void> {
  const state = await api.state()
  const screen = entryScreen({ fragment, state })
  if (screen.screen === 'unavailable') return unavailable()
  if (screen.screen === 'viewer' && hasAccess(state)) {
    const known = state.artifact.versions.some((version) => version.number === fragment.version)
    return renderViewer(api, state, known && fragment.version ? fragment.version : state.artifact.currentVersion)
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
