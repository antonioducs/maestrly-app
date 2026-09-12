import type { NativeImage, WebContents } from 'electron'
import { nativeImage } from 'electron'
import { MAX_EPHEMERAL_IMAGE_BYTES, decodedBase64ByteSize } from './chat/tool-output'
import { incrementPerformanceCounter } from './performance/metrics'

/**
 * Control the embedded browser through each WebContents' isolated CDP debugger, without opening a
 * remote-debugging port exposing all app targets. Supports navigation, evaluation, CSS-pixel input,
 * text insertion, and screenshots, including hidden windows. MCP tools drive this interface.
 */

const attached = new WeakSet<WebContents>()
const attachInFlight = new WeakMap<WebContents, Promise<void>>()
type CdpCaptureDomain = 'runtime' | 'log' | 'network'
type CdpDomainState = Record<CdpCaptureDomain, boolean>
const cdpDomains = new WeakMap<WebContents, CdpDomainState>()
const cdpCaptureActive = new WeakMap<WebContents, boolean>()
// Each capture-domain activation gets a generation. CDP request IDs can survive disable/enable cycles;
// generations prevent late idle-tab responses from affecting the next network-idle wait.
const cdpCaptureGeneration = new WeakMap<WebContents, number>()
// The governor owns the long-lived capture decision; log/network reads add a short-lived explicit
// lease so these helpers remain safe even when called outside the MCP wrapper.
const cdpGovernorActive = new WeakMap<WebContents, boolean>()
const cdpExplicitCaptureLeases = new WeakMap<WebContents, number>()
const cdpActivityInFlight = new WeakMap<WebContents, Promise<void>>()
// Last per-tab snapshot mapping refs to CSS-pixel centers.
const lastRefs = new WeakMap<WebContents, Array<{ x: number; y: number }>>()
// Current synthetic cursor position per tab in CSS pixels.
const mousePositions = new WeakMap<WebContents, { x: number; y: number }>()
// Automatically answer alert/confirm/prompt dialogs so synchronous page dialogs cannot block subsequent
// tools. Default is accept.
const dialogBehavior = new WeakMap<WebContents, { accept: boolean; promptText?: string }>()
// Per-tab prompt override script ID, removed before reinstalling because Electron does not support native
// prompt().
const promptScriptId = new WeakMap<WebContents, string>()

// Bounded console/network ring buffers collect while the tab is active or within governor grace; existing
// history remains available to tools.
const MAX_LOGS = 500
/** Hard RAM budgets for untrusted CDP payloads. Exported so focused tests can assert the contract. */
export const BROWSER_CDP_MAX_ENTRY_BYTES = 32 * 1024
export const BROWSER_CDP_MAX_BUFFER_BYTES = 512 * 1024
export const BROWSER_CDP_MAX_PENDING_BYTES = 256 * 1024
const BROWSER_CDP_MAX_CONTENT_BYTES = BROWSER_CDP_MAX_ENTRY_BYTES - 1024
export interface ConsoleEntry {
  ts: number
  level: string // log | warning | error | info | debug | exception
  text: string
}
export interface NetworkEntry {
  ts: number
  method: string
  url: string
  status?: number
  mimeType?: string
  failed?: boolean
  errorText?: string
}
interface Buffers {
  console: ConsoleEntry[]
  consoleBytes: number
  network: NetworkEntry[]
  networkBytes: number
  reqById: Map<string, { entry: NetworkEntry; generation: number; bytes: number }>
  reqByIdBytes: number
}
const buffers = new WeakMap<WebContents, Buffers>()

function getBuffers(wc: WebContents): Buffers {
  let b = buffers.get(wc)
  if (!b) {
    b = {
      console: [],
      consoleBytes: 0,
      network: [],
      networkBytes: 0,
      reqById: new Map(),
      reqByIdBytes: 0,
    }
    buffers.set(wc, b)
  }
  return b
}

function utf8JsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function storedEntryBytes(value: unknown): number {
  // One byte accounts for the separator when entries are represented as a JSON array.
  return utf8JsonBytes(value) + 1
}

/** Fits one untrusted string field without ever repeatedly serializing the original huge payload. */
function fitStringField<T extends Record<string, unknown>>(item: T, key: keyof T, maxBytes: number): T {
  const original = String(item[key] ?? '')
  if (utf8JsonBytes(item) <= maxBytes) return item
  const marker = '…[truncated]'
  const capped = original.slice(0, maxBytes)
  let low = 0
  let high = capped.length
  let best = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    let end = middle
    if (end > 0 && /[\uD800-\uDBFF]/.test(capped[end - 1])) end -= 1
    const candidate = `${capped.slice(0, end)}${end < original.length ? marker : ''}`
    const next = { ...item, [key]: candidate }
    if (utf8JsonBytes(next) <= maxBytes) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return { ...item, [key]: best }
}

function boundConsoleEntry(item: ConsoleEntry): ConsoleEntry {
  let bounded = fitStringField(item as unknown as Record<string, unknown>, 'level', BROWSER_CDP_MAX_CONTENT_BYTES)
  bounded = fitStringField(bounded, 'text', BROWSER_CDP_MAX_CONTENT_BYTES)
  return bounded as unknown as ConsoleEntry
}

function boundNetworkEntry(item: NetworkEntry): NetworkEntry {
  let bounded = item as unknown as Record<string, unknown>
  for (const field of ['method', 'url', 'mimeType', 'errorText'] as const) {
    if (bounded[field] !== undefined) bounded = fitStringField(bounded, field, BROWSER_CDP_MAX_CONTENT_BYTES)
  }
  return bounded as unknown as NetworkEntry
}

function trimBounded<T>(arr: T[], currentBytes: number): number {
  while (arr.length > MAX_LOGS || currentBytes > BROWSER_CDP_MAX_BUFFER_BYTES) {
    const removed = arr.shift()
    if (removed === undefined) break
    currentBytes -= storedEntryBytes(removed)
  }
  return Math.max(0, currentBytes)
}

function pushBounded<T>(arr: T[], item: T, currentBytes: number): number {
  arr.push(item)
  return trimBounded(arr, currentBytes + storedEntryBytes(item))
}

function pushConsole(b: Buffers, item: ConsoleEntry): void {
  b.consoleBytes = pushBounded(b.console, boundConsoleEntry(item), b.consoleBytes)
}

function pushNetwork(b: Buffers, item: NetworkEntry): NetworkEntry {
  const bounded = boundNetworkEntry(item)
  b.networkBytes = pushBounded(b.network, bounded, b.networkBytes)
  return bounded
}

function deletePending(b: Buffers, requestId: string): void {
  const pending = b.reqById.get(requestId)
  if (!pending) return
  b.reqById.delete(requestId)
  b.reqByIdBytes = Math.max(0, b.reqByIdBytes - pending.bytes)
}

function clearPending(b: Buffers): void {
  b.reqById.clear()
  b.reqByIdBytes = 0
}

function setPending(b: Buffers, requestId: string, entry: NetworkEntry, generation: number): void {
  const bytes = storedEntryBytes({ requestId, entry, generation })
  // An adversarial request id cannot be retained safely; the visible network entry remains useful.
  if (bytes > BROWSER_CDP_MAX_ENTRY_BYTES) return
  deletePending(b, requestId)
  b.reqById.set(requestId, { entry, generation, bytes })
  b.reqByIdBytes += bytes
  while (b.reqById.size > MAX_LOGS || b.reqByIdBytes > BROWSER_CDP_MAX_PENDING_BYTES) {
    const oldest = b.reqById.keys().next().value as string | undefined
    if (oldest === undefined) break
    deletePending(b, oldest)
  }
}

/** Re-measures a mutated pending entry and touches it, yielding deterministic Map-based LRU. */
function refreshPending(b: Buffers, requestId: string): void {
  const pending = b.reqById.get(requestId)
  if (!pending) return
  b.reqByIdBytes -= pending.bytes
  pending.bytes = storedEntryBytes({ requestId, entry: pending.entry, generation: pending.generation })
  b.reqById.delete(requestId)
  if (pending.bytes <= BROWSER_CDP_MAX_ENTRY_BYTES) {
    b.reqById.set(requestId, pending)
    b.reqByIdBytes += pending.bytes
  }
  while (b.reqByIdBytes > BROWSER_CDP_MAX_PENDING_BYTES) {
    const oldest = b.reqById.keys().next().value as string | undefined
    if (oldest === undefined) break
    deletePending(b, oldest)
  }
}

function setMousePosition(wc: WebContents, x: number, y: number): { x: number; y: number } {
  const pos = { x: Math.round(x), y: Math.round(y) }
  mousePositions.set(wc, pos)
  return pos
}

function argToText(a: { value?: unknown; description?: string; type?: string }): string {
  const text =
    a.value !== undefined
      ? typeof a.value === 'string'
        ? a.value
        : JSON.stringify(a.value)
      : (a.description ?? a.type ?? '')
  return String(text ?? '').slice(0, BROWSER_CDP_MAX_ENTRY_BYTES)
}

function consoleArgsToText(args: Array<{ value?: unknown; description?: string; type?: string }>): string {
  let text = ''
  for (const arg of args) {
    const next = argToText(arg)
    text += `${text ? ' ' : ''}${next}`
    if (text.length >= BROWSER_CDP_MAX_ENTRY_BYTES) return text.slice(0, BROWSER_CDP_MAX_ENTRY_BYTES)
  }
  return text
}

function isCaptureDomainMethod(method: string): boolean {
  return method.startsWith('Runtime.') || method.startsWith('Log.') || method.startsWith('Network.')
}

function attachCdpListeners(wc: WebContents): void {
  const b = getBuffers(wc)
  wc.debugger.on('message', (_e, method, params: Record<string, unknown>) => {
    // Keep Page enabled for navigation, screenshots, and dialogs. Ignore and disable Runtime/Log/Network
    // domains when policy marks the tab idle.
    if (isCaptureDomainMethod(method) && !cdpCaptureActive.get(wc)) return
    try {
      incrementPerformanceCounter('browserCdpEvents')
      const p = params as Record<string, any>
      switch (method) {
        case 'Runtime.consoleAPICalled':
          pushConsole(b, {
            ts: Date.now(),
            level: p.type === 'warning' ? 'warning' : String(p.type ?? 'log'),
            text: consoleArgsToText(Array.isArray(p.args) ? p.args : []),
          })
          break
        case 'Runtime.exceptionThrown': {
          const d = p.exceptionDetails
          pushConsole(b, {
            ts: Date.now(),
            level: 'exception',
            text: String(d?.exception?.description || d?.text || 'Uncaught exception'),
          })
          break
        }
        case 'Log.entryAdded':
          pushConsole(b, {
            ts: Date.now(),
            level: String(p.entry.level ?? 'info'), // verbose | info | warning | error
            text: `[${String(p.entry.source ?? '')}] ${String(p.entry.text ?? '')}`,
          })
          break
        case 'Network.requestWillBeSent': {
          const e = pushNetwork(b, {
            ts: Date.now(),
            method: String(p.request.method ?? ''),
            url: String(p.request.url ?? ''),
          })
          setPending(b, String(p.requestId ?? ''), e, cdpCaptureGeneration.get(wc) ?? 0)
          break
        }
        case 'Network.responseReceived': {
          const requestId = String(p.requestId ?? '')
          const pending = b.reqById.get(requestId)
          if (pending && pending.generation === (cdpCaptureGeneration.get(wc) ?? 0)) {
            const e = pending.entry
            const before = utf8JsonBytes(e)
            const status = Number(p.response.status)
            if (Number.isFinite(status)) e.status = status
            e.mimeType = String(p.response.mimeType ?? '')
            Object.assign(e, boundNetworkEntry(e))
            if (b.network.includes(e)) {
              b.networkBytes += utf8JsonBytes(e) - before
              b.networkBytes = trimBounded(b.network, b.networkBytes)
            }
            refreshPending(b, requestId)
          }
          break
        }
        case 'Network.loadingFailed': {
          const requestId = String(p.requestId ?? '')
          const pending = b.reqById.get(requestId)
          if (pending && pending.generation === (cdpCaptureGeneration.get(wc) ?? 0)) {
            const e = pending.entry
            const before = utf8JsonBytes(e)
            e.failed = true
            e.errorText = String(p.errorText ?? '')
            Object.assign(e, boundNetworkEntry(e))
            if (b.network.includes(e)) {
              b.networkBytes += utf8JsonBytes(e) - before
              b.networkBytes = trimBounded(b.network, b.networkBytes)
            }
            deletePending(b, requestId)
          }
          break
        }
        case 'Network.loadingFinished': {
          // Response metadata has already been attached by responseReceived. Nothing else needs the
          // request id after the terminal network event, so release it immediately.
          const requestId = String(p.requestId ?? '')
          const pending = b.reqById.get(requestId)
          if (pending?.generation === (cdpCaptureGeneration.get(wc) ?? 0)) deletePending(b, requestId)
          break
        }
        case 'Page.javascriptDialogOpening': {
          // Automatically answer dialogs using per-tab policy and log them for tool inspection; otherwise
          // they would block the page.
          const beh = dialogBehavior.get(wc) ?? { accept: true }
          pushConsole(b, {
            ts: Date.now(),
            level: 'info',
            text: `[dialog] ${p.type}: ${String(p.message ?? '').slice(0, 200)} → ${beh.accept ? 'accept' : 'dismiss'}`,
          })
          wc.debugger
            .sendCommand('Page.handleJavaScriptDialog', {
              accept: beh.accept,
              promptText: beh.promptText,
            })
            .catch(() => {
              /* Dialog already closed or session unavailable. */
            })
          break
        }
      }
    } catch {
      /* Never let a listener exception terminate the session. */
    }
  })
}

async function ensureAttached(wc: WebContents): Promise<void> {
  if (attached.has(wc)) return
  const previous = attachInFlight.get(wc)
  if (previous) return previous
  const current = (async () => {
    if (attached.has(wc)) return
    try {
      wc.debugger.attach('1.3')
    } catch (e) {
      // A racing attach by us is harmless; propagate conflicts with another debugger client.
      if (!String((e as Error).message).includes('already attached')) throw e
    }
    attachCdpListeners(wc)
    await wc.debugger.sendCommand('Page.enable')
    cdpDomains.set(wc, { runtime: false, log: false, network: false })
    cdpCaptureActive.set(wc, false)
    attached.add(wc)
    wc.once('destroyed', () => {
      attached.delete(wc)
      cdpCaptureActive.delete(wc)
      cdpCaptureGeneration.delete(wc)
      cdpGovernorActive.delete(wc)
      cdpExplicitCaptureLeases.delete(wc)
      cdpDomains.delete(wc)
    })
    // Install prompt override on attach with default accept so unsupported native prompt() cannot break
    // pages before explicit configuration.
    await installPromptOverride(wc).catch(() => {
      /* best-effort: setDialogBehavior reinstala sob demanda */
    })
  })()
  attachInFlight.set(wc, current)
  try {
    await current
  } finally {
    if (attachInFlight.get(wc) === current) attachInFlight.delete(wc)
  }
}

function enqueueCdpActivity(wc: WebContents, operation: () => Promise<void>): Promise<void> {
  const previous = cdpActivityInFlight.get(wc) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  cdpActivityInFlight.set(wc, current)
  void current
    .finally(() => {
      if (cdpActivityInFlight.get(wc) === current) cdpActivityInFlight.delete(wc)
    })
    .catch(() => {})
  return current
}

async function ensureCdpDomain(wc: WebContents, domain: CdpCaptureDomain): Promise<void> {
  await ensureAttached(wc)
  return enqueueCdpActivity(wc, async () => {
    const state = cdpDomains.get(wc)
    if (!state || state[domain]) return
    await wc.debugger.sendCommand(`${domain === 'runtime' ? 'Runtime' : domain === 'log' ? 'Log' : 'Network'}.enable`)
    state[domain] = true
  })
}

function wantsCdpCapture(wc: WebContents): boolean {
  return cdpGovernorActive.get(wc) === true || (cdpExplicitCaptureLeases.get(wc) ?? 0) > 0
}

/** Reconciles the protocol domains with the governor plus any short-lived explicit reader lease. */
async function reconcileCdpCapture(wc: WebContents): Promise<void> {
  await ensureAttached(wc)
  return enqueueCdpActivity(wc, async () => {
    const state = cdpDomains.get(wc)
    if (!state) return
    if (wantsCdpCapture(wc)) {
      if (!cdpCaptureActive.get(wc)) {
        cdpCaptureGeneration.set(wc, (cdpCaptureGeneration.get(wc) ?? 0) + 1)
        // Requests from the previous active epoch are no longer evidence about the current page
        // settling. Keep the completed network log, but discard only the correlation table.
        clearPending(getBuffers(wc))
      }
      for (const domain of ['runtime', 'log', 'network'] as const) {
        if (state[domain]) continue
        const protocol = domain === 'runtime' ? 'Runtime' : domain === 'log' ? 'Log' : 'Network'
        await wc.debugger.sendCommand(`${protocol}.enable`)
        state[domain] = true
      }
      cdpCaptureActive.set(wc, true)
      return
    }
    // Stop processing before disabling so events racing the commands do not refill the buffers.
    cdpCaptureActive.set(wc, false)
    clearPending(getBuffers(wc))
    for (const domain of ['network', 'log', 'runtime'] as const) {
      if (!state[domain]) continue
      const protocol = domain === 'runtime' ? 'Runtime' : domain === 'log' ? 'Log' : 'Network'
      await wc.debugger.sendCommand(`${protocol}.disable`).catch(() => {})
      state[domain] = false
    }
  })
}

/** Follows the resource governor: Page stays available, expensive capture domains do not. */
export async function setBrowserCdpActivity(wc: WebContents, active: boolean): Promise<void> {
  cdpGovernorActive.set(wc, active)
  return reconcileCdpCapture(wc)
}

async function withExplicitCdpCapture<T>(wc: WebContents, operation: () => Promise<T>): Promise<T> {
  cdpExplicitCaptureLeases.set(wc, (cdpExplicitCaptureLeases.get(wc) ?? 0) + 1)
  try {
    await reconcileCdpCapture(wc)
    return await operation()
  } finally {
    const remaining = Math.max(0, (cdpExplicitCaptureLeases.get(wc) ?? 1) - 1)
    if (remaining === 0) cdpExplicitCaptureLeases.delete(wc)
    else cdpExplicitCaptureLeases.set(wc, remaining)
    await reconcileCdpCapture(wc).catch(() => {})
  }
}

/**
 * Attach CDP when creating the tab, before navigation or DevTools. Keep Page available and allow user
 * DevTools coexistence; enable Runtime/Log/Network only for governor activity or requested logs. Safe
 * fire-and-forget.
 */
export function attachToView(wc: WebContents): void {
  ensureAttached(wc).catch(() => {
    /* best-effort: navigate/snapshot re-tentam o attach sob demanda */
  })
}

/** Collected console/exception logs, oldest first. */
export async function getConsoleLogs(
  wc: WebContents,
  opts?: { level?: string; limit?: number }
): Promise<ConsoleEntry[]> {
  return withExplicitCdpCapture(wc, async () => {
    let logs = getBuffers(wc).console
    if (opts?.level) logs = logs.filter((l) => l.level === opts.level)
    return logs.slice(-(opts?.limit ?? 100))
  })
}

/** Collected network requests, oldest first. */
export async function getNetworkLogs(
  wc: WebContents,
  opts?: { onlyErrors?: boolean; limit?: number }
): Promise<NetworkEntry[]> {
  return withExplicitCdpCapture(wc, async () => {
    let net = getBuffers(wc).network
    if (opts?.onlyErrors) net = net.filter((n) => n.failed || (n.status ?? 0) >= 400)
    return net.slice(-(opts?.limit ?? 100))
  })
}

/** Clear buffers before reproducing an issue. */
export async function clearLogs(wc: WebContents): Promise<void> {
  const b = getBuffers(wc)
  b.console.length = 0
  b.consoleBytes = 0
  b.network.length = 0
  b.networkBytes = 0
  clearPending(b)
}

/**
 * Replace unsupported Electron window.prompt in current and future documents. On accept return
 * configured promptText or the prompt's default; on cancel return null.
 * addScriptToEvaluateOnNewDocument keeps behavior across navigation.
 */
async function installPromptOverride(wc: WebContents): Promise<void> {
  const beh = dialogBehavior.get(wc) ?? { accept: true }
  const ret = beh.accept
    ? beh.promptText !== undefined
      ? JSON.stringify(beh.promptText)
      : '(d!=null?String(d):"")'
    : 'null'
  const source = `window.prompt=function(m,d){return ${ret};};`
  const prev = promptScriptId.get(wc)
  if (prev) {
    await wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: prev }).catch(() => {
      /* Script already removed or session unavailable. */
    })
  }
  const { identifier } = (await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source,
  })) as { identifier: string }
  promptScriptId.set(wc, identifier)
  // New-document scripts do not affect the current document, so apply the override there too.
  await wc.debugger.sendCommand('Runtime.evaluate', { expression: source }).catch(() => {
    /* Document unavailable or crossing origins during navigation. */
  })
}

/**
 * Set automatic dialog responses. CDP handles alert/confirm; reinstall the JS prompt override so
 * accept/promptText changes apply immediately.
 */
export async function setDialogBehavior(wc: WebContents, accept: boolean, promptText?: string): Promise<void> {
  dialogBehavior.set(wc, { accept, promptText })
  await ensureCdpDomain(wc, 'runtime')
  await installPromptOverride(wc)
}

async function evalJs<T = unknown>(wc: WebContents, expression: string): Promise<T> {
  await ensureCdpDomain(wc, 'runtime')
  const r = (await wc.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result: { value: T }; exceptionDetails?: { text?: string } }
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JavaScript evaluation failed')
  return r.result.value
}

interface RemoteObject {
  type: string
  subtype?: string
  value?: unknown
  description?: string
  className?: string
}
interface EvalResponse {
  result: RemoteObject
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

/**
 * Evaluate arbitrary page JavaScript like the DevTools console, returning the last expression and
 * awaiting Promises. Return serializable values, explicit undefined, or runtime descriptions for
 * functions, DOM nodes, and other nonserializable results.
 */
export async function evaluate(wc: WebContents, expression: string): Promise<{ type: string; value: string }> {
  await ensureCdpDomain(wc, 'runtime')
  let r: EvalResponse
  try {
    r = (await wc.debugger.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // replMode matches DevTools: allow let/const redeclarations and top-level await between calls while
      // retaining last-expression semantics. Otherwise repeated declarations in the shared page context
      // would fail.
      replMode: true,
    })) as EvalResponse
  } catch (e) {
    // CDP cannot serialize some results by value, including circular references and window.
    throw new Error(
      `could not serialize the return value (${(e as Error).message}). ` +
        'Return a JSON-serializable value, e.g.: JSON.stringify(x), x.length, x.outerHTML.'
    )
  }
  if (r.exceptionDetails) {
    const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JavaScript evaluation failed'
    // If a declaration conflict remains despite replMode, explain persistent scope rather than only echoing
    // the error.
    if (/already been declared/i.test(msg)) {
      throw new Error(
        `${msg}\nTip: scope PERSISTS between calls (same page context). Reuse the variable ` +
          'without redeclaring it, choose another name, or reload the page (browser_navigate) to clear the context.'
      )
    }
    throw new Error(msg)
  }
  const res = r.result
  if (res.type === 'undefined') return { type: 'undefined', value: 'undefined' }
  if (res.value !== undefined) {
    return {
      type: res.type,
      value: typeof res.value === 'string' ? res.value : JSON.stringify(res.value),
    }
  }
  // For nonserialized objects/elements/functions, return the runtime description.
  return { type: res.subtype || res.type, value: res.description || res.className || `(${res.type})` }
}

/**
 * Resolve on the first matching CDP method or timeout. Back/forward can restore from bfcache without
 * loadEventFired, so also accept frameNavigated.
 */
function waitForLoad(wc: WebContents, ms = 15000, methods = ['Page.loadEventFired']): Promise<void> {
  return new Promise<void>((resolve) => {
    const onMsg = (_e: unknown, method: string): void => {
      if (methods.includes(method)) {
        wc.debugger.off('message', onMsg)
        resolve()
      }
    }
    wc.debugger.on('message', onMsg)
    setTimeout(() => {
      wc.debugger.off('message', onMsg)
      resolve()
    }, ms)
  })
}

export async function navigate(wc: WebContents, url: string): Promise<{ url: string }> {
  await ensureAttached(wc)
  const loaded = waitForLoad(wc)
  await wc.debugger.sendCommand('Page.navigate', { url: normalizeUrl(url) })
  await loaded
  return { url: await currentUrl(wc) }
}

/**
 * Navigate backward/forward or reload, await loading, and return final URL plus whether navigation
 * occurred.
 */
export async function navHistory(
  wc: WebContents,
  dir: 'back' | 'forward' | 'reload'
): Promise<{ url: string; moved: boolean }> {
  await ensureAttached(wc)
  if (dir === 'back' && !wc.canGoBack()) return { url: await currentUrl(wc), moved: false }
  if (dir === 'forward' && !wc.canGoForward()) return { url: await currentUrl(wc), moved: false }
  // Reload waits for load up to 15 seconds; back/forward also accepts bfcache frameNavigated within 8 seconds.
  const loaded =
    dir === 'reload' ? waitForLoad(wc) : waitForLoad(wc, 8000, ['Page.loadEventFired', 'Page.frameNavigated'])
  if (dir === 'back') wc.goBack()
  else if (dir === 'forward') wc.goForward()
  else wc.reload()
  await loaded
  return { url: await currentUrl(wc), moved: true }
}

/**
 * Poll for a selector, body text, or roughly 450 ms of network inactivity. Return whether it matched
 * and elapsed time, avoiding premature SPA snapshots. Requests without status count as pending.
 */
export async function waitFor(
  wc: WebContents,
  opts: { selector?: string; text?: string; networkIdle?: boolean; timeoutMs?: number; signal?: AbortSignal }
): Promise<{ matched: boolean; waitedMs: number }> {
  opts.signal?.throwIfAborted()
  await ensureAttached(wc)
  opts.signal?.throwIfAborted()
  const poll = async (): Promise<{ matched: boolean; waitedMs: number }> => {
    const timeout = Number.isFinite(opts.timeoutMs) ? (opts.timeoutMs as number) : 10000
    const start = Date.now()
    let idleStreak = 0
    for (;;) {
      opts.signal?.throwIfAborted()
      if (opts.selector) {
        if (await evalJs<boolean>(wc, `!!document.querySelector(${JSON.stringify(opts.selector)})`))
          return { matched: true, waitedMs: Date.now() - start }
      } else if (opts.text) {
        const expr = `!!(document.body&&document.body.innerText&&document.body.innerText.includes(${JSON.stringify(
          opts.text
        )}))`
        if (await evalJs<boolean>(wc, expr)) return { matched: true, waitedMs: Date.now() - start }
      } else if (opts.networkIdle) {
        const generation = cdpCaptureGeneration.get(wc) ?? 0
        const pending = [...getBuffers(wc).reqById.values()].filter(
          (request) => request.generation === generation && request.entry.status === undefined && !request.entry.failed
        ).length
        idleStreak = pending === 0 ? idleStreak + 1 : 0
        if (idleStreak >= 3) return { matched: true, waitedMs: Date.now() - start }
      }
      if (Date.now() - start >= timeout) return { matched: false, waitedMs: Date.now() - start }
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  return opts.networkIdle ? withExplicitCdpCapture(wc, poll) : poll()
}

export async function currentUrl(wc: WebContents): Promise<string> {
  return evalJs<string>(wc, 'location.href')
}

export interface SnapshotElement {
  ref: number
  tag: string
  type: string
  name: string
}

/**
 * List visible interactive elements with stable refs and store click centers. Include viewport bounds
 * and current mouse position.
 */
export async function snapshot(wc: WebContents): Promise<{
  url: string
  elements: SnapshotElement[]
  viewport: { width: number; height: number }
  scroll: ScrollPosition
  mouse: { x: number; y: number }
}> {
  await ensureAttached(wc)
  const raw = await evalJs<{
    viewport: { width: number; height: number }
    scroll: ScrollPosition
    elements: Array<{ ref: number; tag: string; type: string; name: string; x: number; y: number }>
  }>(
    wc,
    `(()=>{const out=[];let i=0;
      const sel='a,button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],summary,[contenteditable=true]';
      for(const el of document.querySelectorAll(sel)){
        const r=el.getBoundingClientRect();
        if(r.width===0||r.height===0)continue;
        if(r.bottom<0||r.top>innerHeight||r.right<0||r.left>innerWidth)continue;
        const s=getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')continue;
        const name=(el.getAttribute('aria-label')||el.innerText||el.value||el.getAttribute('placeholder')||el.getAttribute('title')||el.getAttribute('name')||'').replace(/\\s+/g,' ').trim().slice(0,100);
        out.push({ref:i++,tag:el.tagName.toLowerCase(),type:el.getAttribute('type')||'',name,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
      }
      const de=document.documentElement;
      return {viewport:{width:innerWidth,height:innerHeight},scroll:{x:Math.round(scrollX),y:Math.round(scrollY),maxX:Math.round(Math.max(0,de.scrollWidth-innerWidth)),maxY:Math.round(Math.max(0,de.scrollHeight-innerHeight))},elements:out};})()`
  )
  lastRefs.set(
    wc,
    raw.elements.map((e) => ({ x: e.x, y: e.y }))
  )
  return {
    url: await currentUrl(wc),
    elements: raw.elements.map(({ ref, tag, type, name }) => ({ ref, tag, type, name })),
    viewport: raw.viewport,
    scroll: raw.scroll,
    mouse: mousePosition(wc),
  }
}

async function clickXY(wc: WebContents, x: number, y: number): Promise<void> {
  const base = { x, y, button: 'left' as const, clickCount: 1 }
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    ...base,
    type: 'mousePressed',
    buttons: 1,
  })
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    ...base,
    type: 'mouseReleased',
    buttons: 0,
  })
  setMousePosition(wc, x, y)
}

/**
 * Move the synthetic cursor in CSS pixels from the top-left origin and record it. Dispatch real
 * mouseMoved so hover/mouseenter runs; snapshot/screenshot reports the position.
 */
export async function moveMouse(wc: WebContents, x: number, y: number): Promise<{ x: number; y: number }> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('mouse coordinates must be finite numbers')
  }
  await ensureAttached(wc)
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  return setMousePosition(wc, x, y)
}

/** Current synthetic cursor position in CSS pixels. */
export function mousePosition(wc: WebContents): { x: number; y: number } {
  return { ...(mousePositions.get(wc) ?? { x: 0, y: 0 }) }
}

/** Page scroll position and maximum scrollable offsets in CSS pixels. */
export interface ScrollPosition {
  x: number
  y: number
  maxX: number
  maxY: number
}

const SCROLL_READ =
  '(()=>{const de=document.documentElement;return {x:Math.round(scrollX),y:Math.round(scrollY),' +
  'maxX:Math.round(Math.max(0,de.scrollWidth-innerWidth)),maxY:Math.round(Math.max(0,de.scrollHeight-innerHeight))};})()'

/** Read current scroll position to accompany screenshots. */
export async function scrollPosition(
  wc: WebContents,
  opts: BrowserControlOperationOptions = {}
): Promise<ScrollPosition> {
  return settleBrowserOperation(
    async (signal) => {
      await ensureAttached(wc)
      signal.throwIfAborted()
      return evalJs<ScrollPosition>(wc, SCROLL_READ)
    },
    opts,
    'reading screenshot position'
  )
}

/**
 * Scroll the document deterministically using scrollBy/scrollTo. Priority: top/bottom target, absolute
 * coordinates, then deltas. Reread maxima afterward to reflect lazy/infinite loading.
 */
export async function scroll(
  wc: WebContents,
  opts: {
    dx?: number
    dy?: number
    x?: number
    y?: number
    to?: 'top' | 'bottom'
    selector?: string
    container?: string
  }
): Promise<ScrollPosition> {
  await ensureAttached(wc)
  const n = (v: number | undefined): number => (Number.isFinite(v) ? (v as number) : 0)
  // JavaScript expression returning a scrollable element's x, y, maxX, and maxY.
  const report = (el: string): string =>
    `{x:Math.round(${el}.scrollLeft),y:Math.round(${el}.scrollTop),` +
    `maxX:Math.round(Math.max(0,${el}.scrollWidth-${el}.clientWidth)),` +
    `maxY:Math.round(Math.max(0,${el}.scrollHeight-${el}.clientHeight))}`
  let js: string
  if (opts.selector) {
    // scrollIntoView may scroll nested ancestors. Report the ancestor that actually scrolls, based on
    // overflow and content size, rather than incorrectly returning document zero offsets for nested
    // scroll containers.
    js =
      `(()=>{const t=document.querySelector(${JSON.stringify(opts.selector)});if(!t)return null;` +
      `t.scrollIntoView({block:'center',inline:'nearest'});` +
      `const sc=(el)=>{let m=el.parentElement;while(m){const s=getComputedStyle(m);` +
      `if((/(auto|scroll|overlay)/.test(s.overflowY)&&m.scrollHeight>m.clientHeight)||` +
      `(/(auto|scroll|overlay)/.test(s.overflowX)&&m.scrollWidth>m.clientWidth))return m;` +
      `m=m.parentElement;}return document.scrollingElement||document.documentElement;};` +
      `const E=sc(t);return ${report('E')};})()`
  } else {
    // Scroll a chosen container or document scrollingElement directly for deterministic behavior, rather
    // than whichever element is beneath a wheel event.
    const targetExpr = opts.container
      ? `document.querySelector(${JSON.stringify(opts.container)})`
      : '(document.scrollingElement||document.documentElement)'
    let action: string
    if (opts.to === 'top') action = 'E.scrollTop=0,E.scrollLeft=0'
    else if (opts.to === 'bottom') action = 'E.scrollTop=E.scrollHeight'
    else if (opts.x !== undefined || opts.y !== undefined) {
      const parts: string[] = []
      if (opts.y !== undefined) parts.push(`E.scrollTop=${n(opts.y)}`)
      if (opts.x !== undefined) parts.push(`E.scrollLeft=${n(opts.x)}`)
      action = parts.join(';')
    } else action = `E.scrollTop+=${n(opts.dy)};E.scrollLeft+=${n(opts.dx)}`
    js = `(()=>{const E=${targetExpr};if(!E)return null;${action};return ${report('E')};})()`
  }
  const r = await evalJs<ScrollPosition | null>(wc, js)
  if (!r) throw new Error(`scroll target not found: ${opts.container ?? opts.selector ?? '(document)'}`)
  return r
}

function requireRef(wc: WebContents, ref: number): { x: number; y: number } {
  const p = lastRefs.get(wc)?.[ref]
  if (!p) throw new Error(`invalid ref ${ref}; call browser_snapshot first`)
  return p
}

/**
 * Select all focused input/textarea content with select(), or contenteditable content with Range,
 * retaining selection. Injected Command/Control+A key events alone do not execute Chromium's native
 * editing command.
 */
async function selectAllInFocused(wc: WebContents): Promise<void> {
  await evalJs(
    wc,
    `(()=>{const el=document.activeElement;if(!el)return;
      if(typeof el.select==='function'){try{el.select();return;}catch(e){}}
      if(el.isContentEditable){const r=document.createRange();r.selectNodeContents(el);
        const s=window.getSelection();s.removeAllRanges();s.addRange(r);}})()`
  )
}

export async function clickRef(wc: WebContents, ref: number): Promise<void> {
  await ensureAttached(wc)
  const p = requireRef(wc, ref)
  await clickXY(wc, p.x, p.y)
}

export async function typeRef(wc: WebContents, ref: number, text: string, clear = false): Promise<void> {
  await ensureAttached(wc)
  const p = requireRef(wc, ref)
  await clickXY(wc, p.x, p.y) // foca o campo
  if (clear) {
    // After clicking, reselect all content through JavaScript and delete with Backspace, which generates
    // actual beforeinput/input events for controlled inputs. This also supports empty replacement text;
    // insertText adds the new value afterward.
    await selectAllInFocused(wc)
    const bs = { windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' }
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...bs })
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...bs })
  }
  await wc.debugger.sendCommand('Input.insertText', { text })
}

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
// Chromium editing shortcuts need explicit CDP commands; injected key events alone do not execute
// select-all/copy/paste. Use Meta on macOS and Control elsewhere.
const EDIT_COMMAND_BY_KEY: Record<string, string> = {
  a: 'selectAll',
  c: 'copy',
  v: 'paste',
  x: 'cut',
  z: 'undo',
  y: 'redo',
}
const NAMED_KEYS: Record<string, { keyCode: number; key: string; code: string }> = {
  Enter: { keyCode: 13, key: 'Enter', code: 'Enter' },
  Tab: { keyCode: 9, key: 'Tab', code: 'Tab' },
  Escape: { keyCode: 27, key: 'Escape', code: 'Escape' },
  Backspace: { keyCode: 8, key: 'Backspace', code: 'Backspace' },
  Delete: { keyCode: 46, key: 'Delete', code: 'Delete' },
  ArrowUp: { keyCode: 38, key: 'ArrowUp', code: 'ArrowUp' },
  ArrowDown: { keyCode: 40, key: 'ArrowDown', code: 'ArrowDown' },
  ArrowLeft: { keyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' },
  ArrowRight: { keyCode: 39, key: 'ArrowRight', code: 'ArrowRight' },
  Home: { keyCode: 36, key: 'Home', code: 'Home' },
  End: { keyCode: 35, key: 'End', code: 'End' },
  PageUp: { keyCode: 33, key: 'PageUp', code: 'PageUp' },
  PageDown: { keyCode: 34, key: 'PageDown', code: 'PageDown' },
  Space: { keyCode: 32, key: ' ', code: 'Space' },
}

function resolveKey(key: string): { keyCode: number; key: string; code: string } {
  const named = NAMED_KEYS[key]
  if (named) return named
  if (key.length === 1) {
    const up = key.toUpperCase()
    if (up >= 'A' && up <= 'Z') return { keyCode: up.charCodeAt(0), key, code: `Key${up}` }
    if (key >= '0' && key <= '9') return { keyCode: key.charCodeAt(0), key, code: `Digit${key}` }
  }
  throw new Error(`unsupported key: "${key}"`)
}

/** Press a named or single-character key with optional modifiers. */
export async function pressKey(wc: WebContents, key: string, modifiers?: string[]): Promise<void> {
  await ensureAttached(wc)
  const k = resolveKey(key)
  const modList = modifiers ?? []
  const mods = modList.reduce((acc, m) => acc | (MODIFIER_BITS[m] ?? 0), 0)
  const base = { windowsVirtualKeyCode: k.keyCode, key: k.key, code: k.code, modifiers: mods }
  // Attach editing commands on keyDown, not keyUp, so synthetic shortcuts execute their action.
  // Command/Control+Shift+Z maps to redo.
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
  let editCmd = key.length === 1 ? EDIT_COMMAND_BY_KEY[key.toLowerCase()] : undefined
  if (editCmd && modList.includes(accel)) {
    if (editCmd === 'undo' && modList.includes('Shift')) editCmd = 'redo'
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...base,
      commands: [editCmd],
    })
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    return
  }
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

export async function doubleClickRef(wc: WebContents, ref: number): Promise<void> {
  await ensureAttached(wc)
  const p = requireRef(wc, ref)
  for (const clickCount of [1, 2]) {
    const base = { x: p.x, y: p.y, button: 'left', clickCount }
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
  }
  setMousePosition(wc, p.x, p.y)
}

export async function rightClickRef(wc: WebContents, ref: number): Promise<void> {
  await ensureAttached(wc)
  const p = requireRef(wc, ref)
  const base = { x: p.x, y: p.y, button: 'right', clickCount: 1 }
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 2 })
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
  setMousePosition(wc, p.x, p.y)
}

/**
 * Drag between snapshot refs with mouse press, interpolated movement for drag-and-drop detection, then
 * release at the target.
 */
export async function dragRef(wc: WebContents, fromRef: number, toRef: number): Promise<void> {
  await ensureAttached(wc)
  const a = requireRef(wc, fromRef)
  const b = requireRef(wc, toRef)
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, buttons: 0 })
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: a.x,
    y: a.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  const STEPS = 12
  for (let i = 1; i <= STEPS; i++) {
    const x = Math.round(a.x + ((b.x - a.x) * i) / STEPS)
    const y = Math.round(a.y + ((b.y - a.y) * i) / STEPS)
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
  }
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: b.x,
    y: b.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  setMousePosition(wc, b.x, b.y)
}

export async function readText(wc: WebContents): Promise<string> {
  await ensureAttached(wc)
  return evalJs<string>(wc, 'document.body ? document.body.innerText.slice(0, 8000) : ""')
}

// Capture screenshots within the host byte limit. Large/ultrawide native PNGs may exceed
// MAX_EPHEMERAL_IMAGE_BYTES, so proportionally downscale without cropping until they fit. Prefer native
// Electron capture for hidden-page rendering; CDP is fallback.

/** Geometry budgets apply even to highly compressible PNGs that are tiny on the wire. */
export const SCREENSHOT_MAX_LONG_SIDE = 2560
export const SCREENSHOT_MAX_PIXELS = 4 * 1024 * 1024
/**
 * Safety margin over square-root byte scaling because PNG size is not exactly proportional to image
 * area.
 */
const SCREENSHOT_SCALE_HEADROOM = 0.85
/** Relative scale floor bounds retries; five percent of original remains inspectable. */
const SCREENSHOT_MIN_SCALE = 0.05
const SCREENSHOT_MAX_DOWNSCALE_ATTEMPTS = 5
/** Central timeout prevents screenshot capture from waiting indefinitely on Chromium. */
export const SCREENSHOT_TIMEOUT_MS = 10_000

export interface BrowserControlOperationOptions {
  /** Electron/CDP operation deadline; invalid values use the operation default. */
  timeoutMs?: number
  /** Cancel waits immediately when the turn/tool is interrupted. */
  signal?: AbortSignal
}

export interface ScreenshotOptions extends BrowserControlOperationOptions {
  /** Decoded-byte ceiling, defaulting to the host MAX_EPHEMERAL_IMAGE_BYTES limit. */
  maxBytes?: number
  /** Surface-aware capture supplied by WebContentsView owners for tabs parked outside the visible window. */
  captureFrame?: (signal: AbortSignal) => Promise<NativeImage>
}

class BrowserControlInterruptedError extends Error {
  constructor(
    readonly reason: 'timeout' | 'aborted',
    operation: string,
    timeoutMs: number
  ) {
    super(
      reason === 'aborted'
        ? `${operation} cancelled.`
        : `${operation} exceeded ${timeoutMs} ms without a browser response; try again.`
    )
    this.name = 'BrowserControlInterruptedError'
  }
}

function validTimeout(value: number | undefined, fallback = SCREENSHOT_TIMEOUT_MS): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback
}

/**
 * Races an Electron/CDP request against cancellation and a deadline. `sendCommand` itself cannot be
 * aborted, but handlers stay attached to its eventual settlement so a late reply never becomes an
 * unhandled rejection and, crucially, never keeps the tool call open.
 */
function settleBrowserOperation<T>(
  run: (signal: AbortSignal) => Promise<T>,
  opts: BrowserControlOperationOptions,
  operation: string | (() => string),
  fallbackTimeoutMs = SCREENSHOT_TIMEOUT_MS
): Promise<T> {
  const timeoutMs = validTimeout(opts.timeoutMs, fallbackTimeoutMs)
  const operationName = () => (typeof operation === 'function' ? operation() : operation)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const deadlineController = new AbortController()
    const operationSignal = opts.signal
      ? AbortSignal.any([opts.signal, deadlineController.signal])
      : deadlineController.signal
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      deadlineController.abort()
      complete()
    }
    const onAbort = (): void =>
      finish(() => reject(new BrowserControlInterruptedError('aborted', operationName(), timeoutMs)))
    const timer = setTimeout(
      () => finish(() => reject(new BrowserControlInterruptedError('timeout', operationName(), timeoutMs))),
      timeoutMs
    )
    timer.unref?.()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) {
      onAbort()
      return
    }
    let promise: Promise<T>
    try {
      promise = run(operationSignal)
    } catch (error) {
      finish(() => reject(error))
      return
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}

function capturePresentedFrame(wc: WebContents, signal: AbortSignal): Promise<NativeImage> {
  return new Promise((resolve, reject) => {
    let settled = false
    let subscribed = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (subscribed) {
        try {
          wc.endFrameSubscription()
        } catch {
          /* WebContents may have been destroyed while capture was in flight. */
        }
      }
      complete()
    }
    const onAbort = () => finish(() => reject(new Error('presented-frame capture was canceled')))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    try {
      subscribed = true
      wc.beginFrameSubscription(false, (image) => {
        if (image.isEmpty()) return
        finish(() => resolve(image))
      })
      wc.invalidate()
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

/**
 * Proportionally resize base64 PNG until within the byte limit. Begin with a square-root estimate plus
 * margin, decrease monotonically, and reencode/measure every attempt.
 */
function boundPngToBudget(data: string, initialSize: number, maxBytes: number): string {
  const img = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
  const sizeOf = img.getSize()
  if (img.isEmpty() || sizeOf.width <= 0 || sizeOf.height <= 0) {
    throw new Error('could not decode the screenshot to resize it to the model limit')
  }
  const longSide = Math.max(sizeOf.width, sizeOf.height)
  let scale = Math.min(
    1,
    Math.sqrt(maxBytes / Math.max(1, initialSize)) * SCREENSHOT_SCALE_HEADROOM,
    SCREENSHOT_MAX_LONG_SIDE / longSide,
    Math.sqrt(SCREENSHOT_MAX_PIXELS / Math.max(1, sizeOf.width * sizeOf.height))
  )
  if (
    initialSize <= maxBytes &&
    longSide <= SCREENSHOT_MAX_LONG_SIDE &&
    sizeOf.width * sizeOf.height <= SCREENSHOT_MAX_PIXELS
  ) {
    return data
  }
  let out = data
  for (let attempt = 0; attempt < SCREENSHOT_MAX_DOWNSCALE_ATTEMPTS; attempt++) {
    let width = Math.max(1, Math.round(sizeOf.width * scale))
    let height = Math.max(1, Math.round(sizeOf.height * scale))
    // Independent rounding can exceed the area budget by a thin row/column.
    while (width * height > SCREENSHOT_MAX_PIXELS) {
      if (width >= height && width > 1) width -= 1
      else if (height > 1) height -= 1
      else break
    }
    out = img.resize({ width, height, quality: 'best' }).toPNG().toString('base64')
    const outSize = decodedBase64ByteSize(out)
    if (outSize !== null && outSize <= maxBytes) return out
    if (scale <= SCREENSHOT_MIN_SCALE) break
    scale = Math.max(SCREENSHOT_MIN_SCALE, scale * 0.5)
  }
  throw new Error('could not reduce the screenshot below the model byte limit')
}

/** Full-viewport base64 PNG within the byte ceiling, including when the drawer is hidden. */
export async function screenshot(wc: WebContents, opts: ScreenshotOptions = {}): Promise<string> {
  let stage = 'preparing browser screenshot'
  return settleBrowserOperation(
    async (signal) => {
      const maxBytes = opts.maxBytes ?? MAX_EPHEMERAL_IMAGE_BYTES
      let image: NativeImage
      try {
        stage = 'browser frame capture'
        image = opts.captureFrame ? await opts.captureFrame(signal) : await capturePresentedFrame(wc, signal)
        signal.throwIfAborted()
        if (image.isEmpty()) throw new Error('browser capture returned an empty image')
      } catch (error) {
        if (error instanceof BrowserControlInterruptedError && error.reason === 'aborted') throw error
        throw new Error(`${stage} failed: ${String((error as Error)?.message ?? error)}`)
      }
      stage = 'serializing browser screenshot as PNG'
      try {
        const data = image.toPNG().toString('base64')
        const size = decodedBase64ByteSize(data)
        return boundPngToBudget(data, size ?? maxBytes + 1, maxBytes)
      } catch (error) {
        throw new Error(`${stage} failed: ${String((error as Error)?.message ?? error)}`)
      }
    },
    opts,
    () => stage
  )
}

function normalizeUrl(input: string): string {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return s
  if (/^[^\s]+\.[^\s]+$/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}
