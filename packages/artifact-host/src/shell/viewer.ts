// The viewer shell: identity, version picker and the sandboxed content frame. Every text reaches the DOM through
// `textContent`; nothing coming from the API or the frame is parsed as HTML.
import {
  ARTIFACT_HEADER,
  CONTENT_SANDBOX,
  type FrameResponse,
  parseBridgeMessage,
  type ViewerState,
} from './contract.js'
import { format, pickLocale, type ShellKey } from './i18n.js'
import { createListbox } from './listbox.js'

const VIEWER_PATH = /^\/a\/([A-Za-z0-9_-]{22})$/
const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
const locale = pickLocale(languages)
const t = (key: ShellKey, vars?: Record<string, string | number>) => format(locale, key, vars)
const app = document.getElementById('app') as HTMLElement

document.documentElement.lang = locale

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function write(path: string, method: 'POST' | 'DELETE', body?: unknown): Promise<Response> {
  return fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', [ARTIFACT_HEADER]: '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function showMessage(title: string, detail?: string): void {
  const box = element('main', 'message')
  box.append(element('h1', undefined, title))
  if (detail) box.append(element('p', undefined, detail))
  app.replaceChildren(box)
  document.title = title
}

function renderViewer(api: string, state: ViewerState, initialVersion: number): void {
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
  const chip = element('span', 'chip', t('owner'))
  const leave = element('button', 'button', t('leave'))
  leave.type = 'button'
  leave.addEventListener('click', async () => {
    leave.disabled = true
    await write(`${api}/session`, 'DELETE').catch(() => undefined)
    showMessage(t('left'), t('leftDetail'))
  })
  identity.append(chip, leave)
  header.append(title, picker, identity)

  const banner = element('div', 'banner')
  banner.setAttribute('role', 'status')
  banner.hidden = true

  const frame = element('iframe', 'content')
  frame.setAttribute('sandbox', CONTENT_SANDBOX)
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.title = artifact.title

  app.replaceChildren(header, banner, frame)

  const showBanner = (text: string, retry?: () => void) => {
    const message = element('span', undefined, text)
    banner.replaceChildren(message)
    if (retry) {
      const button = element('button', 'button', t('retry'))
      button.type = 'button'
      button.addEventListener('click', retry)
      banner.append(button)
    }
    banner.hidden = false
  }

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return
    const message = parseBridgeMessage(event.data)
    if (message?.type === 'error') showBanner(t('pageError', { message: message.message }))
  })

  async function load(version: number): Promise<void> {
    banner.hidden = true
    try {
      const response = await write(`${api}/frame`, 'POST', { version })
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

async function main(): Promise<void> {
  const match = VIEWER_PATH.exec(location.pathname)
  if (!match) {
    showMessage(t('notAvailable'), t('notAvailableDetail'))
    return
  }
  const api = `/a/${match[1]}/api`
  // Tokens travel in the fragment, which never reaches a server; drop it from the address bar before anything else.
  const params = new URLSearchParams(location.hash.slice(1))
  const ticket = params.get('o')
  const requested = Number(params.get('v'))
  if (location.hash) history.replaceState(null, '', location.pathname)

  showMessage(t('loading'))
  if (ticket) await write(`${api}/session/owner`, 'POST', { ticket }).catch(() => undefined)

  let state: ViewerState
  try {
    const response = await fetch(`${api}/state`, { credentials: 'same-origin' })
    if (response.status !== 200) throw new Error(String(response.status))
    state = (await response.json()) as ViewerState
  } catch {
    showMessage(t('notAvailable'), t('notAvailableDetail'))
    return
  }
  const known = state.artifact.versions.some((version) => version.number === requested)
  renderViewer(api, state, known ? requested : state.artifact.currentVersion)
}

void main()
