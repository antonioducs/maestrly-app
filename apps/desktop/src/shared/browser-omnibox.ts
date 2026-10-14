/**
 * Address-bar logic shared by the main process (history matching) and the browser chrome (ranking and inline
 * completion). Pure: no Electron, React, or Node APIs.
 */

/** CSS height of the tab strip and address bar placed above a floating or popup browser page. */
export const BROWSER_CHROME_HEIGHT = 78

export const OMNIBOX_MAX_SUGGESTIONS = 8

/** One visited page as the address bar sees it. `icon` is a data URL; remote favicons cannot load under the CSP. */
export interface OmniboxHistoryItem {
  url: string
  title: string
  icon?: string
  visitCount: number
  typedCount: number
  lastVisitAt: number
}

export interface OmniboxTabItem {
  id: string
  url: string
  title: string
  icon?: string
}

/** Local candidates and search suggestions for one address-bar input. */
export interface OmniboxQueryResult {
  history: OmniboxHistoryItem[]
  tabs: OmniboxTabItem[]
  searchSuggestions: string[]
}

export type OmniboxSuggestion =
  | {
      kind: 'url'
      id: string
      url: string
      title: string
      icon?: string
      /** `input` is what the user typed; `history` comes from a visited page. */
      source: 'input' | 'history'
      removable: boolean
    }
  | {
      kind: 'search'
      id: string
      query: string
      url: string
      source: 'input' | 'suggest' | 'history'
      removable: boolean
      /** Stored history URL to remove, for a search that came from history. */
      historyUrl?: string
    }
  | { kind: 'tab'; id: string; tabId: string; url: string; title: string; icon?: string }

export interface OmniboxBuildOptions {
  input: string
  history: readonly OmniboxHistoryItem[]
  tabs: readonly OmniboxTabItem[]
  /** The active tab is never offered as "switch to this tab". */
  activeTabId?: string | null
  searchSuggestions: readonly string[]
  now: number
  /** Inline completion applies only while the user is typing forward at the end of the text. */
  allowInline?: boolean
  limit?: number
}

export interface OmniboxBuildResult {
  suggestions: OmniboxSuggestion[]
  /** Full address-bar text: the input followed by the completed remainder. Null without a completion. */
  inlineCompletion: string | null
}

const GOOGLE_SEARCH = 'https://www.google.com/search?q='
const SCHEME_RE = /^(https?|about|data|file):/i
const LOCAL_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[^\s/:]+\.localhost)(:\d{1,5})?(?:[/?#]\S*)?$/i
const IP_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:[/?#]\S*)?$/
const DAY_MS = 86_400_000

export function googleSearchUrl(query: string): string {
  return `${GOOGLE_SEARCH}${encodeURIComponent(query.trim())}`
}

/**
 * Decides whether address-bar text is a URL or a web search. Local development hosts default to http, every other
 * host-looking text to https; anything else searches Google.
 */
export function classifyBrowserInput(input: string): { kind: 'url' | 'search'; url: string } {
  const s = input.trim()
  if (SCHEME_RE.test(s)) return { kind: 'url', url: s }
  if (LOCAL_HOST_RE.test(s)) return { kind: 'url', url: `http://${s}` }
  if (/^[^\s]+\.[^\s]+$/.test(s)) return { kind: 'url', url: `https://${s}` }
  return { kind: 'search', url: googleSearchUrl(s) }
}

export function normalizeBrowserInput(input: string): string {
  return classifyBrowserInput(input).url
}

/** Typed text that may be sent to the search-suggestion service: never URLs with a scheme, local hosts or IPs. */
export function isSearchSuggestEligible(input: string): boolean {
  const s = input.trim()
  if (!s || s.length > 200) return false
  if (/^(https?|file|about|data|javascript|chrome|view-source|blob):/i.test(s)) return false
  return !LOCAL_HOST_RE.test(s) && !IP_RE.test(s)
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function isWebUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/** History identity of a page: http(s) only, without the fragment. Null for anything else. */
export function browserHistoryKey(raw: string): string | null {
  const url = parseUrl(raw)
  if (!url || !isWebUrl(url)) return null
  url.hash = ''
  return url.href
}

/** The query of a Google results page, or null for any other URL. */
export function searchQueryFromUrl(raw: string): string | null {
  const url = parseUrl(raw)
  if (!url || !isWebUrl(url) || url.pathname !== '/search') return null
  if (!/(^|\.)google\.[a-z.]{2,6}$/i.test(url.hostname)) return null
  const query = url.searchParams.get('q')?.trim()
  return query ? query : null
}

/** Compact URL as the address bar lists it: no scheme, no `www.`, no lone trailing slash. */
export function displayUrl(raw: string): string {
  const url = parseUrl(raw)
  if (!url || !isWebUrl(url)) return raw
  const host = url.host.replace(/^www\./i, '')
  let rest = url.pathname + url.search + url.hash
  if (rest === '/') rest = ''
  const text = host + rest
  try {
    return decodeURI(text)
  } catch {
    return text
  }
}

/** Text the address bar shows while a suggestion is selected with the arrow keys. */
export function omniboxFillText(suggestion: OmniboxSuggestion): string {
  return suggestion.kind === 'search' ? suggestion.query : displayUrl(suggestion.url)
}

export function foldText(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function startsWord(haystack: string, term: string): boolean {
  let index = haystack.indexOf(term)
  while (index !== -1) {
    if (index === 0 || !/[\p{L}\p{N}]/u.test(haystack[index - 1]!)) return true
    index = haystack.indexOf(term, index + 1)
  }
  return false
}

/** Recent visits weigh more; the weight never drops to zero so old favorites stay reachable. */
export function historyRecency(entry: Pick<OmniboxHistoryItem, 'lastVisitAt'>, now: number): number {
  const ageDays = Math.max(0, now - entry.lastVisitAt) / DAY_MS
  return 0.25 + 0.75 / (1 + ageDays / 14)
}

/** Frequency and recency of use; typed visits count three times. Used for pruning and inline completion. */
export function historyFrecency(
  entry: Pick<OmniboxHistoryItem, 'visitCount' | 'typedCount' | 'lastVisitAt'>,
  now: number
): number {
  return (entry.visitCount + 3 * entry.typedCount) * historyRecency(entry, now)
}

/**
 * Relevance of a history entry for typed text; zero when it does not match. Host prefixes beat URL prefixes,
 * which beat word starts in the title or URL, which beat plain substrings. Short inputs accept only prefixes.
 */
export function scoreHistoryEntry(input: string, entry: OmniboxHistoryItem, now: number): number {
  const query = foldText(input.trim())
  if (!query) return 0
  const words = query.split(/\s+/)
  let base: number
  const searched = searchQueryFromUrl(entry.url)
  if (searched !== null) {
    const text = foldText(searched)
    if (text.startsWith(query)) base = 90
    else if (words.every((word) => startsWord(text, word))) base = 50
    else if (words.every((word) => text.includes(word))) base = 20
    else return 0
  } else {
    const url = parseUrl(entry.url)
    if (!url) return 0
    const host = url.host.toLowerCase()
    const isRoot = url.pathname === '/' && !url.search
    const shown = foldText(displayUrl(entry.url))
    // The compact form drops a root's trailing slash, which the user may still type.
    const typedForm = isRoot ? `${shown}/` : shown
    const title = foldText(entry.title)
    if (host.replace(/^www\./, '').startsWith(query) || host.startsWith(query)) base = 100
    else if (typedForm.startsWith(query) || foldText(entry.url).startsWith(query)) base = 80
    else if (words.every((word) => startsWord(title, word) || startsWord(shown, word))) base = 50
    else if (words.every((word) => title.includes(word) || shown.includes(word))) base = 20
    else return 0
    if (isRoot) base *= 1.15
  }
  if (query.length < 3 && base < 50) return 0
  const usage = 1 + Math.log2(1 + entry.visitCount + 3 * entry.typedCount)
  return base * usage * historyRecency(entry, now)
}

function textMatches(query: string, haystacks: string[]): boolean {
  const words = query.split(/\s+/)
  const strict = query.length < 3
  return words.every((word) =>
    haystacks.some((haystack) => (strict ? startsWord(haystack, word) : haystack.includes(word)))
  )
}

/**
 * Whether typed text is exactly this page's address, ignoring the scheme, case, `www.`, and a root's trailing
 * slash. Text without a slash names a host, so it matches every page of that host.
 */
export function matchesTypedAddress(input: string, rawUrl: string): boolean {
  const query = input.trim().toLowerCase()
  const url = parseUrl(rawUrl)
  if (!query || !url || !isWebUrl(url)) return false
  const host = url.host.toLowerCase()
  const bare = host.replace(/^www\./, '')
  if (!query.includes('/')) return query === bare || query === host
  const shown = displayUrl(rawUrl).toLowerCase()
  const rest = shown.slice(bare.length)
  const forms = [shown, host + rest]
  if (url.pathname === '/' && !url.search) forms.push(`${bare}/`, `${host}/`)
  return forms.includes(query)
}

interface InlineTarget {
  text: string
  url: string
  title: string
  icon?: string
}

/**
 * Inline completion for text typed without spaces: the most used host (or, once the text has a path, the most used
 * URL) that extends it. Only pages typed before or visited more than once qualify, so a single stray visit never
 * hijacks the address bar.
 */
export function inlineCompletionFor(
  input: string,
  history: readonly OmniboxHistoryItem[],
  now: number
): InlineTarget | null {
  if (!input || /\s/.test(input)) return null
  const query = input.toLowerCase()
  const withPath = query.includes('/')
  const targets = new Map<
    string,
    { weight: number; best: number; url: string; icon?: string; title: string; rootTitle?: string }
  >()
  for (const entry of history) {
    if (searchQueryFromUrl(entry.url) !== null) continue
    // A page already visited at exactly the typed address wins over any longer completion.
    if (matchesTypedAddress(input, entry.url)) return null
    if (entry.typedCount < 1 && entry.visitCount < 2) continue
    const url = parseUrl(entry.url)
    if (!url || !isWebUrl(url)) continue
    const host = url.host.toLowerCase()
    const bare = host.replace(/^www\./, '')
    const isRoot = url.pathname === '/' && !url.search
    const origin = `${url.protocol}//${url.host}/`
    const forms: Array<{ text: string; url: string }> = []
    if (withPath) {
      const shown = displayUrl(entry.url)
      forms.push({ text: shown, url: entry.url })
      if (host !== bare) forms.push({ text: host + shown.slice(bare.length), url: entry.url })
    } else {
      forms.push({ text: bare, url: origin })
      if (host !== bare) forms.push({ text: host, url: origin })
    }
    const frecency = historyFrecency(entry, now)
    for (const form of forms) {
      if (form.text.length <= query.length || !form.text.toLowerCase().startsWith(query)) continue
      const target = targets.get(form.text)
      const title = withPath ? entry.title : ''
      if (!target) {
        targets.set(form.text, {
          weight: frecency,
          best: frecency,
          url: form.url,
          icon: entry.icon,
          title,
          ...(isRoot ? { rootTitle: entry.title } : {}),
        })
        continue
      }
      target.weight += frecency
      if (isRoot && !target.rootTitle) target.rootTitle = entry.title
      if (frecency > target.best) {
        target.best = frecency
        target.url = form.url
        target.title = title
        if (entry.icon) target.icon = entry.icon
      } else if (!target.icon && entry.icon) target.icon = entry.icon
    }
  }
  let chosen: [string, { weight: number; url: string; icon?: string; title: string; rootTitle?: string }] | null = null
  for (const candidate of targets) {
    if (
      !chosen ||
      candidate[1].weight > chosen[1].weight ||
      (candidate[1].weight === chosen[1].weight && candidate[0].length < chosen[0].length)
    ) {
      chosen = candidate
    }
  }
  if (!chosen) return null
  const [text, target] = chosen
  return {
    text: input + text.slice(input.length),
    url: target.url,
    title: target.rootTitle ?? target.title,
    ...(target.icon ? { icon: target.icon } : {}),
  }
}

/**
 * Address-bar rows in a fixed order: what was typed (or its inline completion), matching open tabs, history, then
 * search suggestions, without duplicates and at most `limit` rows.
 */
export function buildOmniboxSuggestions(options: OmniboxBuildOptions): OmniboxBuildResult {
  const trimmed = options.input.trim()
  const limit = options.limit ?? OMNIBOX_MAX_SUGGESTIONS
  if (!trimmed || limit <= 0) return { suggestions: [], inlineCompletion: null }
  const query = foldText(trimmed)
  const seenUrls = new Set<string>()
  const seenQueries = new Set<string>()
  const urlKey = (url: string): string => browserHistoryKey(url) ?? url

  const typed = classifyBrowserInput(trimmed)
  const inline = options.allowInline ? inlineCompletionFor(options.input, options.history, options.now) : null
  const remote: string[] = []
  let first: OmniboxSuggestion
  if (inline) {
    first = {
      kind: 'url',
      id: 'input',
      url: inline.url,
      title: inline.title,
      ...(inline.icon ? { icon: inline.icon } : {}),
      source: 'history',
      removable: false,
    }
    seenUrls.add(urlKey(inline.url))
    // The completion replaces the typed search, which stays available among the search rows.
    if (typed.kind === 'search') remote.push(trimmed)
  } else if (typed.kind === 'url') {
    first = { kind: 'url', id: 'input', url: typed.url, title: '', source: 'input', removable: false }
    seenUrls.add(urlKey(typed.url))
  } else {
    first = { kind: 'search', id: 'input', query: trimmed, url: typed.url, source: 'input', removable: false }
    seenQueries.add(query)
  }
  remote.push(...options.searchSuggestions)

  const tabRows: OmniboxSuggestion[] = []
  for (const tab of options.tabs) {
    if (tabRows.length >= 2) break
    if (tab.id === options.activeTabId) continue
    if (!textMatches(query, [foldText(tab.title), foldText(displayUrl(tab.url))])) continue
    tabRows.push({
      kind: 'tab',
      id: `tab:${tab.id}`,
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      ...(tab.icon ? { icon: tab.icon } : {}),
    })
    seenUrls.add(urlKey(tab.url))
  }

  const remoteUnique = new Set(remote.map(foldText).filter((key) => key && !seenQueries.has(key)))
  const historyBudget = Math.max(0, limit - 1 - tabRows.length - Math.min(4, remoteUnique.size))
  const historyRows: OmniboxSuggestion[] = []
  const ranked = options.history
    .map((entry) => ({ entry, score: scoreHistoryEntry(trimmed, entry, options.now) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
  for (const { entry } of ranked) {
    if (historyRows.length >= historyBudget) break
    const searched = searchQueryFromUrl(entry.url)
    if (searched !== null) {
      const key = foldText(searched)
      if (seenQueries.has(key)) continue
      seenQueries.add(key)
      historyRows.push({
        kind: 'search',
        id: `history:${entry.url}`,
        query: searched,
        url: googleSearchUrl(searched),
        source: 'history',
        removable: true,
        historyUrl: entry.url,
      })
      continue
    }
    const key = urlKey(entry.url)
    if (seenUrls.has(key)) continue
    seenUrls.add(key)
    historyRows.push({
      kind: 'url',
      id: `history:${entry.url}`,
      url: entry.url,
      title: entry.title,
      ...(entry.icon ? { icon: entry.icon } : {}),
      source: 'history',
      removable: true,
    })
  }

  const searchRows: OmniboxSuggestion[] = []
  const searchBudget = limit - 1 - tabRows.length - historyRows.length
  for (const text of remote) {
    if (searchRows.length >= searchBudget) break
    const clean = text.trim()
    const key = foldText(clean)
    if (!key || seenQueries.has(key)) continue
    seenQueries.add(key)
    searchRows.push({
      kind: 'search',
      id: `suggest:${key}`,
      query: clean,
      url: googleSearchUrl(clean),
      source: 'suggest',
      removable: false,
    })
  }

  return {
    suggestions: [first, ...tabRows, ...historyRows, ...searchRows].slice(0, limit),
    inlineCompletion: inline ? inline.text : null,
  }
}
