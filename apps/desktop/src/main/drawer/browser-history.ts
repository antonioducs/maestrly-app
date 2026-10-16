import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  browserHistoryKey,
  foldText,
  historyFrecency,
  matchesTypedAddress,
  scoreHistoryEntry,
  searchQueryFromUrl,
  type OmniboxHistoryItem,
} from '../../shared/browser-omnibox'

/**
 * Global history of the drawer browser, shared by every conversation like its `persist:drawer-browser` session.
 * It lives in memory, loads lazily from `<userData>/browser-history.json`, and is written after a short debounce
 * and synchronously at exit. Only user-facing tabs record visits; delegated worker tabs never do.
 */

export const BROWSER_HISTORY_MAX_ENTRIES = 5000
const PRUNE_TARGET = 4500
const MAX_ICONS = 500
const ICON_MAX_BYTES = 32 * 1024
const ICON_TIMEOUT_MS = 5000
const SAVE_DEBOUNCE_MS = 1500
const MAX_URL_LENGTH = 4096
const MAX_TITLE_LENGTH = 512

interface StoredEntry {
  url: string
  title: string
  faviconUrl?: string
  visitCount: number
  typedCount: number
  lastVisitAt: number
}

interface StoredIcon {
  data: string
  usedAt: number
}

/** Fetches a favicon with the browser's own session, so it sees the same cookies and cache as the page. */
export type FaviconLoader = (url: string, signal: AbortSignal) => Promise<Response>

let fileOverride: string | null = null
let entries: Map<string, StoredEntry> | null = null
let icons = new Map<string, StoredIcon>()
const iconLoads = new Set<string>()
let saveTimer: ReturnType<typeof setTimeout> | null = null
let tempSeq = 0
let writeEpoch = 0

function historyFile(): string {
  return fileOverride ?? path.join(app.getPath('userData'), 'browser-history.json')
}

/** Points the store at another file and drops the in-memory state. Tests only. */
export function configureBrowserHistoryFile(file: string | null): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  writeEpoch++
  fileOverride = file
  entries = null
  icons = new Map()
  iconLoads.clear()
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parseEntry(value: unknown): StoredEntry | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.url !== 'string' || !isCount(raw.visitCount) || !isCount(raw.lastVisitAt)) return null
  const key = browserHistoryKey(raw.url)
  if (!key || key.length > MAX_URL_LENGTH) return null
  return {
    url: key,
    title: typeof raw.title === 'string' ? clip(raw.title, MAX_TITLE_LENGTH) : '',
    ...(typeof raw.faviconUrl === 'string' ? { faviconUrl: raw.faviconUrl } : {}),
    visitCount: Math.floor(raw.visitCount),
    typedCount: isCount(raw.typedCount) ? Math.floor(raw.typedCount) : 0,
    lastVisitAt: raw.lastVisitAt,
  }
}

function load(): Map<string, StoredEntry> {
  if (entries) return entries
  entries = new Map()
  icons = new Map()
  const file = historyFile()
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return entries
  }
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown; icons?: unknown }
    if (Array.isArray(parsed.entries)) {
      for (const value of parsed.entries) {
        const entry = parseEntry(value)
        if (entry) entries.set(entry.url, entry)
      }
    }
    if (parsed.icons && typeof parsed.icons === 'object') {
      for (const [url, value] of Object.entries(parsed.icons as Record<string, unknown>)) {
        const icon = value as Partial<StoredIcon> | null
        if (typeof icon?.data === 'string' && icon.data.startsWith('data:image/') && isCount(icon.usedAt)) {
          icons.set(url, { data: icon.data, usedAt: icon.usedAt })
        }
      }
    }
  } catch (error) {
    // Keep the unreadable file aside instead of replacing the only copy on the next save.
    console.warn('[browser-history] Unreadable history file:', error instanceof Error ? error.message : String(error))
    try {
      fs.renameSync(file, `${file}.corrupt`)
    } catch {
      /* best effort */
    }
  }
  return entries
}

function serialize(): string {
  return JSON.stringify({
    version: 1,
    entries: [...(entries ?? new Map()).values()],
    icons: Object.fromEntries(icons),
  })
}

function tempPath(file: string): string {
  return `${file}.${process.pid}.${++tempSeq}.tmp`
}

async function writeAsync(): Promise<void> {
  if (!entries) return
  const file = historyFile()
  const temp = tempPath(file)
  const epoch = ++writeEpoch
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(temp, serialize(), { encoding: 'utf8', mode: 0o600 })
    // A synchronous flush or a clear that ran meanwhile holds newer state; never replace it with this snapshot.
    if (epoch !== writeEpoch) {
      await fs.promises.rm(temp, { force: true })
      return
    }
    await fs.promises.rename(temp, file)
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => {})
    console.warn('[browser-history] Could not save history:', error instanceof Error ? error.message : String(error))
  }
}

function writeSync(): void {
  if (!entries) return
  const file = historyFile()
  const temp = tempPath(file)
  writeEpoch++
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, serialize(), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      /* best effort */
    }
    console.warn('[browser-history] Could not save history:', error instanceof Error ? error.message : String(error))
  }
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void writeAsync()
  }, SAVE_DEBOUNCE_MS)
  saveTimer.unref?.()
}

/** Writes pending changes synchronously; called at exit. */
export function flushBrowserHistory(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  writeSync()
}

/** Forgets every visit and favicon, in memory and on disk. Throws when the file cannot be deleted. */
export function clearBrowserHistory(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  writeEpoch++
  entries = new Map()
  icons = new Map()
  fs.rmSync(historyFile(), { force: true })
}

function pruneIcons(): void {
  const referenced = new Set<string>()
  for (const entry of entries?.values() ?? []) if (entry.faviconUrl) referenced.add(entry.faviconUrl)
  for (const url of [...icons.keys()]) if (!referenced.has(url)) icons.delete(url)
  if (icons.size <= MAX_ICONS) return
  const oldest = [...icons.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)
  for (const [url] of oldest.slice(0, icons.size - MAX_ICONS)) icons.delete(url)
}

function prune(now: number): void {
  const map = load()
  if (map.size <= BROWSER_HISTORY_MAX_ENTRIES) return
  const ranked = [...map.values()].sort((a, b) => historyFrecency(a, now) - historyFrecency(b, now))
  for (const entry of ranked.slice(0, map.size - PRUNE_TARGET)) map.delete(entry.url)
  pruneIcons()
}

/** Records a committed main-frame visit. Non-web URLs are ignored. */
export function recordBrowserVisit(url: string, options: { title?: string; typed?: boolean; now?: number } = {}): void {
  const key = browserHistoryKey(url)
  if (!key || key.length > MAX_URL_LENGTH) return
  const map = load()
  const now = options.now ?? Date.now()
  const title = options.title ? clip(options.title, MAX_TITLE_LENGTH) : ''
  const existing = map.get(key)
  if (existing) {
    existing.visitCount += 1
    if (options.typed) existing.typedCount += 1
    existing.lastVisitAt = now
    if (title) existing.title = title
  } else {
    map.set(key, { url: key, title, visitCount: 1, typedCount: options.typed ? 1 : 0, lastVisitAt: now })
    prune(now)
  }
  scheduleSave()
}

export function updateBrowserHistoryTitle(url: string, title: string): void {
  const key = browserHistoryKey(url)
  const entry = key ? load().get(key) : undefined
  const next = clip(title.trim(), MAX_TITLE_LENGTH)
  if (!entry || !next || entry.title === next) return
  entry.title = next
  scheduleSave()
}

function iconContentType(response: Response, url: string): string | null {
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type.startsWith('image/')) return type
  // Many servers label .ico files as a generic binary.
  if ((type === '' || type === 'application/octet-stream') && /\.ico(?:$|\?)/i.test(url)) return 'image/x-icon'
  return null
}

async function loadIcon(faviconUrl: string, loader: FaviconLoader): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ICON_TIMEOUT_MS)
  try {
    const response = await loader(faviconUrl, controller.signal)
    if (!response.ok) return
    const type = iconContentType(response, faviconUrl)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (!type || declared > ICON_MAX_BYTES) return
    const body = Buffer.from(await response.arrayBuffer())
    if (body.byteLength === 0 || body.byteLength > ICON_MAX_BYTES) return
    if (!entries) return // cleared while loading
    icons.set(faviconUrl, { data: `data:${type};base64,${body.toString('base64')}`, usedAt: Date.now() })
    pruneIcons()
    scheduleSave()
  } catch {
    // A missing favicon falls back to a generic icon.
  } finally {
    clearTimeout(timer)
  }
}

/** Associates a page with its favicon and caches the image as a data URL. */
export function noteBrowserHistoryFavicon(pageUrl: string, faviconUrl: string, loader: FaviconLoader): void {
  const key = browserHistoryKey(pageUrl)
  const entry = key ? load().get(key) : undefined
  if (!entry || faviconUrl.length > MAX_URL_LENGTH) return
  if (entry.faviconUrl !== faviconUrl) {
    entry.faviconUrl = faviconUrl
    scheduleSave()
  }
  const cached = icons.get(faviconUrl)
  if (cached) {
    cached.usedAt = Date.now()
    return
  }
  if (faviconUrl.startsWith('data:image/')) {
    if (faviconUrl.length <= ICON_MAX_BYTES * 2) {
      icons.set(faviconUrl, { data: faviconUrl, usedAt: Date.now() })
      pruneIcons()
      scheduleSave()
    }
    return
  }
  if (!/^https?:\/\//i.test(faviconUrl) || iconLoads.has(faviconUrl)) return
  iconLoads.add(faviconUrl)
  void loadIcon(faviconUrl, loader).finally(() => iconLoads.delete(faviconUrl))
}

function toItem(entry: StoredEntry): OmniboxHistoryItem {
  const icon = entry.faviconUrl ? icons.get(entry.faviconUrl)?.data : undefined
  return {
    url: entry.url,
    title: entry.title,
    ...(icon ? { icon } : {}),
    visitCount: entry.visitCount,
    typedCount: entry.typedCount,
    lastVisitAt: entry.lastVisitAt,
  }
}

/**
 * Best history candidates for typed text; the renderer re-ranks them with the same scoring. A page visited at
 * exactly the typed address is always included, so inline completion never skips past it.
 */
export function queryBrowserHistory(text: string, limit = 24, now = Date.now()): OmniboxHistoryItem[] {
  const scored: Array<{ entry: StoredEntry; score: number }> = []
  let exact: StoredEntry | null = null
  for (const entry of load().values()) {
    const score = scoreHistoryEntry(text, entry, now)
    if (score > 0) scored.push({ entry, score })
    if (
      matchesTypedAddress(text, entry.url) &&
      (!exact || historyFrecency(entry, now) > historyFrecency(exact, now))
    ) {
      exact = entry
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit).map(({ entry }) => entry)
  if (exact && !top.includes(exact)) top.push(exact)
  return top.map(toItem)
}

/** Cached favicon of a visited page, as a data URL. */
export function browserHistoryIconFor(url: string): string | undefined {
  const key = browserHistoryKey(url)
  const faviconUrl = key ? load().get(key)?.faviconUrl : undefined
  return faviconUrl ? icons.get(faviconUrl)?.data : undefined
}

/** Removes a page; removing a Google search also removes every other visit of the same query. */
export function removeBrowserHistoryEntry(url: string): boolean {
  const key = browserHistoryKey(url)
  if (!key) return false
  const map = load()
  let removed = map.delete(key)
  const query = searchQueryFromUrl(key)
  if (query !== null) {
    const folded = foldText(query)
    for (const [candidateKey, entry] of map) {
      const other = searchQueryFromUrl(entry.url)
      if (other !== null && foldText(other) === folded) {
        map.delete(candidateKey)
        removed = true
      }
    }
  }
  if (removed) {
    pruneIcons()
    scheduleSave()
  }
  return removed
}
