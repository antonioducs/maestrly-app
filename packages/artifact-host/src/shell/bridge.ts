// Injected into every HTML file of an artifact, before the page's own scripts. A classic script with no imports. It
// reports load state, errors and the reader's text selection to the viewer shell, which treats every message as
// untrusted, and highlights the passages the shell asks for. It never changes the page's DOM, and what it receives
// is only text to look for in the page.
;(() => {
  const MAX_QUOTE_CHARS = 500
  const MAX_CONTEXT_CHARS = 64
  const MAX_HIGHLIGHTS = 200
  const MAX_INDEXED_CHARS = 1_000_000
  const SELECTION_DELAY_MS = 150
  const COMMENT_ID = /^[A-Za-z0-9_-]{22}$/
  const UNREAD_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])
  const HIGHLIGHT = 'maestrly-comment'
  const HIGHLIGHT_ACTIVE = 'maestrly-comment-active'

  const post = (message: Record<string, unknown>) =>
    window.parent.postMessage({ source: 'maestrly-bridge', ...message }, '*')
  window.addEventListener('error', (event) => post({ type: 'error', message: String(event.message).slice(0, 300) }))
  window.addEventListener('unhandledrejection', (event) =>
    post({ type: 'error', message: String((event.reason as Error)?.message ?? event.reason).slice(0, 300) })
  )
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => post({ type: 'ready' }))
  else post({ type: 'ready' })

  // --- The reader's selection, so the shell can offer to comment on it.

  const oneLine = (text: string): string => text.replace(/\s+/g, ' ')

  function currentSelection(): Record<string, unknown> {
    const none = { type: 'selection', quote: null, rect: null }
    try {
      const selection = document.getSelection()
      const body = document.body
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !body) return none
      const range = selection.getRangeAt(0)
      const exact = oneLine(range.toString()).trim().slice(0, MAX_QUOTE_CHARS)
      if (!exact) return none
      const before = document.createRange()
      before.setStart(body, 0)
      before.setEnd(range.startContainer, range.startOffset)
      const after = document.createRange()
      after.setStart(range.endContainer, range.endOffset)
      after.setEnd(body, body.childNodes.length)
      const box = range.getBoundingClientRect()
      return {
        type: 'selection',
        quote: {
          exact,
          prefix: oneLine(before.toString()).slice(-MAX_CONTEXT_CHARS),
          suffix: oneLine(after.toString()).slice(0, MAX_CONTEXT_CHARS),
        },
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      }
    } catch {
      // A selection outside the body, such as inside a shadow tree.
      return none
    }
  }

  let selectionTimer: ReturnType<typeof setTimeout> | undefined
  let selecting = false
  const reportSelection = () => {
    clearTimeout(selectionTimer)
    selectionTimer = setTimeout(() => {
      const message = currentSelection()
      // Scrolling and resizing only matter while something is selected.
      if (message.quote === null && !selecting) return
      selecting = message.quote !== null
      post(message)
    }, SELECTION_DELAY_MS)
  }
  document.addEventListener('selectionchange', reportSelection)
  window.addEventListener('scroll', reportSelection, { capture: true, passive: true })
  window.addEventListener('resize', reportSelection)

  // --- Highlights of commented passages. Ranges are registered with the CSS Custom Highlight API, which paints them
  // without touching the DOM.

  interface TextIndex {
    /** The page's visible text without any whitespace. */
    text: string
    nodes: Text[]
    /** For each character of `text`, the node it is in and its offset there. */
    nodeOf: number[]
    offsetOf: number[]
  }

  function indexText(): TextIndex {
    const index: TextIndex = { text: '', nodes: [], nodeOf: [], offsetOf: [] }
    if (!document.body) return index
    const parts: string[] = []
    let total = 0
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node && total < MAX_INDEXED_CHARS; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent || UNREAD_TAGS.has(parent.tagName)) continue
      const data = (node as Text).data
      const nodeIndex = index.nodes.push(node as Text) - 1
      let kept = ''
      for (let offset = 0; offset < data.length; offset++) {
        const char = data[offset]!
        if (char.trim() === '') continue
        kept += char
        index.nodeOf.push(nodeIndex)
        index.offsetOf.push(offset)
      }
      parts.push(kept)
      total += kept.length
    }
    index.text = parts.join('')
    return index
  }

  const dense = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.slice(0, max).replace(/\s+/g, '') : ''

  /** Looks for the quote with its surroundings first, then alone: the page may have changed around it. */
  function locate(index: TextIndex, quote: { exact?: unknown; prefix?: unknown; suffix?: unknown }): Range | null {
    const exact = dense(quote.exact, MAX_QUOTE_CHARS)
    if (!exact) return null
    const prefix = dense(quote.prefix, MAX_CONTEXT_CHARS)
    let start = index.text.indexOf(prefix + exact + dense(quote.suffix, MAX_CONTEXT_CHARS))
    if (start >= 0) start += prefix.length
    else start = index.text.indexOf(exact)
    if (start < 0) return null
    const last = start + exact.length - 1
    const range = document.createRange()
    range.setStart(index.nodes[index.nodeOf[start]!]!, index.offsetOf[start]!)
    range.setEnd(index.nodes[index.nodeOf[last]!]!, index.offsetOf[last]! + 1)
    return range
  }

  type HighlightRegistryLike = { set(name: string, highlight: unknown): unknown; delete(name: string): unknown }
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS?.highlights
  const HighlightClass = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  let styled = false
  let lastActive: string | null = null

  function paint(ranges: Range[], active: Range | null): void {
    if (!registry || !HighlightClass) return
    if (!styled) {
      styled = true
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(
        `::highlight(${HIGHLIGHT}){background-color:rgba(255,213,79,.45);color:inherit}` +
          `::highlight(${HIGHLIGHT_ACTIVE}){background-color:rgba(255,152,0,.7);color:inherit}`
      )
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
    }
    if (ranges.length) registry.set(HIGHLIGHT, new HighlightClass(...ranges))
    else registry.delete(HIGHLIGHT)
    if (active) registry.set(HIGHLIGHT_ACTIVE, new HighlightClass(active))
    else registry.delete(HIGHLIGHT_ACTIVE)
  }

  window.addEventListener('message', (event) => {
    // Only the viewer that frames this page may ask, and only for this one thing.
    if (event.source !== window.parent) return
    const data = event.data as { source?: unknown; type?: unknown; quotes?: unknown; active?: unknown } | null
    if (data?.source !== 'maestrly-shell' || data.type !== 'highlight' || !Array.isArray(data.quotes)) return
    const found: string[] = []
    const missing: string[] = []
    const ranges: Range[] = []
    let active: Range | null = null
    // Where highlights cannot be painted the passages are still looked for, so "not found" keeps its meaning.
    const index = indexText()
    for (const quote of data.quotes.slice(0, MAX_HIGHLIGHTS) as {
      id?: unknown
      exact?: unknown
      prefix?: unknown
      suffix?: unknown
    }[]) {
      const id = quote?.id
      if (typeof id !== 'string' || !COMMENT_ID.test(id)) continue
      let range: Range | null = null
      try {
        range = locate(index, quote)
      } catch {
        range = null
      }
      if (!range) {
        missing.push(id)
        continue
      }
      found.push(id)
      if (id === data.active) active = range
      else ranges.push(range)
    }
    try {
      paint(ranges, active)
      const activeId = active && typeof data.active === 'string' ? data.active : null
      if (active && activeId !== lastActive)
        active.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      lastActive = activeId
    } catch {
      // Highlighting is a convenience; the comments stay readable in the viewer without it.
    }
    post({ type: 'anchors', found, missing })
  })
})()
