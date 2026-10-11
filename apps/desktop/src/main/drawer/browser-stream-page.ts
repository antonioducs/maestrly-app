import type { WebContents } from 'electron'
import { BROWSER_STREAM_LIMITS, type BrowserSelectOption } from '../../shared/browser-stream'

/**
 * What the remote browser stream runs inside the streamed page, always in an isolated world of its own: the page's
 * scripts can neither see nor call it. Chromium draws a `<select>` list in a separate popup widget that no screencast
 * shows, so while a page is streamed its lists are intercepted here and offered to the viewer's window instead; and
 * copying falls back to reading the selection from here when the page put nothing on the clipboard.
 */

const WORLD = 'maestrly-browser-stream'

// Runs once per document. The host waits for requests by evaluating `next()`, a promise that resolves with the next
// list the person opened; a newer wait supersedes an older one, which resolves with null. Only trusted events (input
// the host dispatched) open a list: the page cannot spam the viewer with synthetic clicks.
const SELECT_SCRIPT = `(() => {
  if (globalThis.__maestrlySelect) return true
  const maxOptions = ${BROWSER_STREAM_LIMITS.maxSelectOptions}
  const maxLabel = ${BROWSER_STREAM_LIMITS.maxLabelChars}
  const elements = new Map()
  const queue = []
  let waiter = null
  let nextId = 1
  const simple = (el) => el instanceof HTMLSelectElement && !el.multiple && el.size <= 1 && !el.disabled
  const describe = (el) => {
    const options = []
    for (const option of Array.from(el.options).slice(0, maxOptions)) {
      const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null
      options.push({
        label: String(option.label || option.text || '').slice(0, maxLabel),
        disabled: option.disabled || Boolean(group && group.disabled),
        group: group ? String(group.label).slice(0, maxLabel) : null,
      })
    }
    const r = el.getBoundingClientRect()
    return { options, selectedIndex: el.selectedIndex, rect: { x: r.x, y: r.y, width: r.width, height: r.height } }
  }
  const request = (el) => {
    const id = String(nextId++)
    elements.set(id, new WeakRef(el))
    if (elements.size > 32) elements.delete(elements.keys().next().value)
    const item = { id, ...describe(el) }
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve(item)
    } else {
      queue.push(item)
      if (queue.length > 4) queue.shift()
    }
  }
  const onMouseDown = (event) => {
    if (!event.isTrusted || event.button !== 0) return
    const el = event.target instanceof Element ? event.target.closest('select') : null
    if (!simple(el)) return
    event.preventDefault()
    el.focus()
    request(el)
  }
  const onKeyDown = (event) => {
    const el = event.target
    if (!event.isTrusted || !simple(el)) return
    const opens = (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) || event.key === 'F4'
    if (!opens) return
    event.preventDefault()
    request(el)
  }
  addEventListener('mousedown', onMouseDown, true)
  addEventListener('keydown', onKeyDown, true)
  globalThis.__maestrlySelect = {
    next() {
      if (queue.length) return Promise.resolve(queue.shift())
      if (waiter) waiter(null)
      return new Promise((resolve) => { waiter = resolve })
    },
    choose(id, index) {
      const el = elements.get(id)?.deref()
      elements.delete(id)
      if (!el || !el.isConnected) return false
      const option = Number.isInteger(index) ? el.options[index] : null
      if (option && !option.disabled && el.selectedIndex !== index) {
        el.selectedIndex = index
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      el.focus()
      return true
    },
    stop() {
      removeEventListener('mousedown', onMouseDown, true)
      removeEventListener('keydown', onKeyDown, true)
      if (waiter) waiter(null)
      waiter = null
      elements.clear()
      delete globalThis.__maestrlySelect
    },
  }
  return true
})()`

const SELECTION_SCRIPT = `(() => {
  const el = document.activeElement
  const field =
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && /^(text|search|url|tel|email|number)$/.test(el.type))
  if (field && el.selectionStart !== null && el.selectionEnd !== null)
    return el.value.slice(el.selectionStart, el.selectionEnd)
  const selection = getSelection()
  return selection ? String(selection) : ''
})()`

export interface PageSelectRequest {
  /** `<install>:<page id>`: tied to the document whose list it is. */
  requestId: string
  options: BrowserSelectOption[]
  selectedIndex: number
  /** In the page's CSS pixels. */
  rect: { x: number; y: number; width: number; height: number }
}

interface EvaluateResult {
  result?: { value?: unknown }
  exceptionDetails?: unknown
}

const send = (wc: WebContents, method: string, params?: Record<string, unknown>): Promise<unknown> =>
  wc.debugger.sendCommand(method, params)

/** An isolated world of this module in the page's main frame; Chromium returns the same one for the same name. */
async function isolatedContext(wc: WebContents): Promise<number> {
  const tree = (await send(wc, 'Page.getFrameTree')) as { frameTree?: { frame?: { id?: unknown } } }
  const frameId = tree.frameTree?.frame?.id
  if (typeof frameId !== 'string') throw new Error('The page has no main frame.')
  const world = (await send(wc, 'Page.createIsolatedWorld', { frameId, worldName: WORLD })) as {
    executionContextId?: unknown
  }
  if (typeof world.executionContextId !== 'number') throw new Error('The page refused an isolated world.')
  return world.executionContextId
}

async function evaluateIn(wc: WebContents, contextId: number, expression: string, awaitPromise = false) {
  const evaluated = (await send(wc, 'Runtime.evaluate', {
    expression,
    contextId,
    awaitPromise,
    returnByValue: true,
  })) as EvaluateResult
  if (evaluated.exceptionDetails) throw new Error('The page script failed.')
  return evaluated.result?.value
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** A request the page script reported, checked like any input from a page: it is untrusted. */
function parseRequest(value: unknown, install: number): PageSelectRequest | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^\d{1,9}$/.test(value.id)) return null
  if (!Array.isArray(value.options) || value.options.length > BROWSER_STREAM_LIMITS.maxSelectOptions) return null
  const options: BrowserSelectOption[] = []
  for (const option of value.options) {
    if (!isRecord(option) || typeof option.label !== 'string' || typeof option.disabled !== 'boolean') return null
    if (option.group !== null && typeof option.group !== 'string') return null
    options.push({
      label: option.label.slice(0, BROWSER_STREAM_LIMITS.maxLabelChars),
      disabled: option.disabled,
      group: option.group === null ? null : (option.group as string).slice(0, BROWSER_STREAM_LIMITS.maxLabelChars),
    })
  }
  const rect = value.rect
  if (!Number.isInteger(value.selectedIndex) || (value.selectedIndex as number) < -1) return null
  if (!isRecord(rect) || ![rect.x, rect.y, rect.width, rect.height].every(finite)) return null
  return {
    requestId: `${install}:${value.id}`,
    options,
    selectedIndex: value.selectedIndex as number,
    rect: { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number },
  }
}

let installCounter = 0
/** The isolated world of each install, by install number, for each intercepted page. */
const installedContexts = new WeakMap<WebContents, Map<number, number>>()

/**
 * Intercepts the page's `<select>` lists until the returned function is called, following the page across
 * navigations. `onRequest` receives each list the person opens.
 */
export function interceptSelects(wc: WebContents, onRequest: (request: PageSelectRequest) => void): () => void {
  let stopped = false
  let install = 0
  let contextId: number | null = null
  const contexts = new Map<number, number>()
  installedContexts.set(wc, contexts)

  const poll = async (current: number, context: number): Promise<void> => {
    while (!stopped && install === current && !wc.isDestroyed()) {
      let value: unknown
      try {
        value = await evaluateIn(
          wc,
          context,
          'globalThis.__maestrlySelect ? globalThis.__maestrlySelect.next() : null',
          true
        )
      } catch {
        return // The document went away; the next one installs again.
      }
      if (value === null || value === undefined) return
      if (stopped || install !== current) return
      const request = parseRequest(value, current)
      if (request) onRequest(request)
    }
  }

  const installNow = async (): Promise<void> => {
    if (stopped || wc.isDestroyed()) return
    const current = ++installCounter
    install = current
    try {
      const context = await isolatedContext(wc)
      if (stopped || install !== current) return
      await evaluateIn(wc, context, SELECT_SCRIPT)
      if (stopped || install !== current) return
      contextId = context
      contexts.set(current, context)
      if (contexts.size > 8) contexts.delete(contexts.keys().next().value as number)
      void poll(current, context)
    } catch {
      /* A page between documents: the next dom-ready installs again. */
    }
  }

  const onDomReady = (): void => void installNow()
  wc.on('dom-ready', onDomReady)
  void installNow()
  return () => {
    if (stopped) return
    stopped = true
    if (installedContexts.get(wc) === contexts) installedContexts.delete(wc)
    wc.removeListener('dom-ready', onDomReady)
    const context = contextId
    if (context !== null && !wc.isDestroyed()) {
      void evaluateIn(wc, context, 'globalThis.__maestrlySelect && globalThis.__maestrlySelect.stop()').catch(() => {})
    }
  }
}

/** Applies the option the viewer picked (or none, when it dismissed the list); false when the list is gone. */
export async function chooseSelectOption(wc: WebContents, requestId: string, index: number | null): Promise<boolean> {
  const match = /^(\d{1,9}):(\d{1,9})$/.exec(requestId)
  const contexts = installedContexts.get(wc)
  if (!match || !contexts || (index !== null && (!Number.isInteger(index) || index < 0))) return false
  const context = contexts.get(Number(match[1]))
  if (context === undefined || wc.isDestroyed()) return false
  try {
    const chosen = await evaluateIn(
      wc,
      context,
      `globalThis.__maestrlySelect ? globalThis.__maestrlySelect.choose(${JSON.stringify(match[2])}, ${index === null ? 'null' : index}) : false`
    )
    return chosen === true
  } catch {
    return false
  }
}

/** The text selected in the page (or in its focused text field), read from an isolated world. */
export async function readPageSelection(wc: WebContents): Promise<string> {
  if (wc.isDestroyed()) return ''
  try {
    const value = await evaluateIn(wc, await isolatedContext(wc), SELECTION_SCRIPT)
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}
