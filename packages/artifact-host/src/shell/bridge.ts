// Injected into every HTML file of an artifact, before the page's own scripts. A classic script with no imports.
//
// It tells the viewer shell where the comment anchors are in the page, what the reader selected, and, in comment mode,
// which passage or spot the reader chose. The shell draws the pins above the frame and treats every message from here
// as an untrusted hint. What the shell sends in is only the page's own text and places in it, never names or comments.
// Nothing here changes the page's DOM: the active passage is painted with the CSS Custom Highlight API.
;(() => {
  const MAX_QUOTE_CHARS = 500
  const MAX_CONTEXT_CHARS = 64
  const MAX_SELECTOR_CHARS = 300
  const MAX_ANCHORS = 200
  const MAX_INDEXED_CHARS = 1_000_000
  const SELECTION_DELAY_MS = 150
  const REINDEX_DELAY_MS = 300
  /** When the browser holds animation frames (a frame it is not painting), measure anyway after this long. */
  const FRAME_FALLBACK_MS = 120
  const ANCHOR_ID = /^(?:[A-Za-z0-9_-]{22}|draft)$/
  const UNREAD_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])
  const HIGHLIGHT = 'maestrly-comment'
  // A speech bubble with a plus: the cursor of comment mode.
  const COMMENT_CURSOR =
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='30'%3E%3Cpath d='M4 26V13a9 9 0 0 1 9-9h4a9 9 0 0 1 0 18H8z' fill='%231b1c1f' stroke='white' stroke-width='2'/%3E%3Cpath d='M15 9v8M11 13h8' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E\") 4 26, crosshair"

  type Quote = { exact: string; prefix: string; suffix: string }
  type Point = { selector: string; rx: number; ry: number }
  type Anchor = { id: string; quote?: Quote; point?: Point }

  const post = (message: Record<string, unknown>) =>
    window.parent.postMessage({ source: 'maestrly-bridge', ...message }, '*')

  window.addEventListener('error', (event) => post({ type: 'error', message: String(event.message).slice(0, 300) }))
  window.addEventListener('unhandledrejection', (event) =>
    post({ type: 'error', message: String((event.reason as Error)?.message ?? event.reason).slice(0, 300) })
  )

  let anchors: Anchor[] = []
  let activeId: string | null = null
  let commenting = false
  const ranges = new Map<string, Range>()

  // --- Finding quoted passages again, whatever the whitespace around them.

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
      const at = index.nodes.push(node as Text) - 1
      let kept = ''
      for (let offset = 0; offset < data.length; offset++) {
        const char = data[offset]!
        if (char.trim() === '') continue
        kept += char
        index.nodeOf.push(at)
        index.offsetOf.push(offset)
      }
      parts.push(kept)
      total += kept.length
    }
    index.text = parts.join('')
    return index
  }

  const dense = (value: string, max: number): string => value.slice(0, max).replace(/\s+/g, '')

  /** Looks for the quote with its surroundings first, then alone: the page may have changed around it. */
  function locate(index: TextIndex, quote: Quote): Range | null {
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

  function resolveRanges(): void {
    ranges.clear()
    if (!anchors.some((anchor) => anchor.quote)) return
    const index = indexText()
    for (const anchor of anchors) {
      if (!anchor.quote) continue
      try {
        const range = locate(index, anchor.quote)
        if (range) ranges.set(anchor.id, range)
      } catch {
        // A passage that cannot be found has no pin.
      }
    }
  }

  const query = (selector: string): Element | null => {
    try {
      return document.querySelector(selector)
    } catch {
      return null
    }
  }

  // --- Where each anchor is now, in the frame's viewport.

  /** The box of a passage's last character: its pin sits there, whatever elements the passage crosses. */
  function endOf(range: Range): DOMRect | null {
    const { endContainer, endOffset } = range
    if (endContainer.nodeType === Node.TEXT_NODE && endOffset > 0) {
      const last = document.createRange()
      last.setStart(endContainer, endOffset - 1)
      last.setEnd(endContainer, endOffset)
      const box = last.getBoundingClientRect()
      if (box.width || box.height) return box
    }
    const rects = range.getClientRects()
    return rects[rects.length - 1] ?? null
  }

  function positions(): Record<string, { x: number; y: number } | null> {
    const pins: Record<string, { x: number; y: number } | null> = {}
    for (const anchor of anchors) {
      pins[anchor.id] = null
      if (anchor.quote) {
        const range = ranges.get(anchor.id)
        // A passage the page removed since it was found has no pin.
        if (!range?.startContainer.isConnected) continue
        const end = endOf(range)
        if (end) pins[anchor.id] = { x: end.right, y: end.top }
      } else if (anchor.point) {
        const element = query(anchor.point.selector)
        if (!element) continue
        const box = element.getBoundingClientRect()
        if (box.width || box.height)
          pins[anchor.id] = { x: box.left + anchor.point.rx * box.width, y: box.top + anchor.point.ry * box.height }
      }
    }
    return pins
  }

  function layout(): void {
    post({ type: 'layout', pins: positions(), width: window.innerWidth, height: window.innerHeight })
    if (selecting) reportSelection()
  }

  let queued = false
  const layoutSoon = () => {
    if (queued) return
    queued = true
    const run = () => {
      if (!queued) return
      queued = false
      layout()
    }
    requestAnimationFrame(run)
    setTimeout(run, FRAME_FALLBACK_MS)
  }

  // --- The active passage, and the comment-mode cursor, painted without touching the DOM.

  type HighlightRegistryLike = { set(name: string, highlight: unknown): unknown; delete(name: string): unknown }
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS?.highlights
  const HighlightClass = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  let sheet: CSSStyleSheet | null = null

  function style(): void {
    try {
      if (!sheet) {
        sheet = new CSSStyleSheet()
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
      }
      sheet.replaceSync(
        `::highlight(${HIGHLIGHT}){background-color:rgba(255,204,64,.55);color:inherit}` +
          (commenting ? `*{cursor:${COMMENT_CURSOR} !important}` : '')
      )
    } catch {
      // Without constructable style sheets the page keeps its own cursor and nothing is painted.
    }
  }

  function paint(): void {
    if (!registry || !HighlightClass) return
    const range = activeId ? ranges.get(activeId) : undefined
    try {
      if (range) registry.set(HIGHLIGHT, new HighlightClass(range))
      else registry.delete(HIGHLIGHT)
    } catch {
      // Highlighting is a convenience; the comment stays readable in the viewer without it.
    }
  }

  // --- What the reader selected, so the shell can offer to comment on it.

  const oneLine = (text: string): string => text.replace(/\s+/g, ' ')

  function selectedQuote(): { quote: Quote; rect: { x: number; y: number; width: number; height: number } } | null {
    try {
      const selection = document.getSelection()
      const body = document.body
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !body) return null
      const range = selection.getRangeAt(0)
      const exact = oneLine(range.toString()).trim().slice(0, MAX_QUOTE_CHARS)
      if (!exact) return null
      const before = document.createRange()
      before.setStart(body, 0)
      before.setEnd(range.startContainer, range.startOffset)
      const after = document.createRange()
      after.setStart(range.endContainer, range.endOffset)
      after.setEnd(body, body.childNodes.length)
      const rects = range.getClientRects()
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
      return {
        quote: {
          exact,
          prefix: oneLine(before.toString()).slice(-MAX_CONTEXT_CHARS),
          suffix: oneLine(after.toString()).slice(0, MAX_CONTEXT_CHARS),
        },
        rect: { x: last.x, y: last.y, width: last.width, height: last.height },
      }
    } catch {
      // A selection outside the body, such as inside a shadow tree.
      return null
    }
  }

  let selecting = false
  function reportSelection(): void {
    const selected = selectedQuote()
    // Nothing selected before and nothing now: the shell has nothing to update.
    if (!selected && !selecting) return
    selecting = selected !== null
    post({ type: 'selection', quote: selected?.quote ?? null, rect: selected?.rect ?? null })
  }
  let selectionTimer: ReturnType<typeof setTimeout> | undefined
  document.addEventListener('selectionchange', () => {
    clearTimeout(selectionTimer)
    selectionTimer = setTimeout(reportSelection, SELECTION_DELAY_MS)
  })

  // --- Comment mode: a click places a comment and never reaches the page's own links, buttons and handlers.

  /** A selector for the element, short enough to store; an element with an ID anchors it. */
  function pathOf(element: Element): { selector: string; element: Element } {
    let target = element
    for (;;) {
      const parts: string[] = []
      for (let node: Element | null = target; node && node !== document.body; node = node.parentElement) {
        if (node.id) {
          parts.unshift(`#${CSS.escape(node.id)}`)
          break
        }
        let nth = 1
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling)
          if (sibling.tagName === node.tagName) nth++
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${nth})`)
      }
      const selector = parts.length ? (parts[0]!.startsWith('#') ? '' : 'body > ') + parts.join(' > ') : 'body'
      if (selector.length <= MAX_SELECTOR_CHARS || !target.parentElement) return { selector, element: target }
      target = target.parentElement
    }
  }

  const unit = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)

  let clickedAt = 0
  function pickSelection(): boolean {
    const selected = selectedQuote()
    if (selected) post({ type: 'pick', anchor: { quote: selected.quote } })
    return selected !== null
  }

  // These two come before the blockers below, which stop every later listener on the window.
  window.addEventListener('pointerdown', () => post({ type: 'pointer' }), true)
  // A drag that selects text across elements may end without a click on them.
  window.addEventListener(
    'mouseup',
    () => {
      if (commenting) setTimeout(() => performance.now() - clickedAt > 60 && pickSelection(), 20)
    },
    true
  )

  function onPointer(event: Event): void {
    if (!commenting) return
    // The page does not learn about clicks meant for comments; the default stays, so text can still be selected.
    event.stopImmediatePropagation()
  }
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick'])
    window.addEventListener(type, onPointer, true)

  window.addEventListener(
    'click',
    (event) => {
      if (!commenting) return
      event.preventDefault()
      event.stopImmediatePropagation()
      clickedAt = performance.now()
      if (pickSelection()) return
      // A click from the keyboard has no position to anchor to.
      if (event.detail === 0) return
      const hit = event.target instanceof Element ? event.target : document.body
      if (!hit) return
      const { selector, element } = pathOf(hit)
      const box = element.getBoundingClientRect()
      post({
        type: 'pick',
        anchor: {
          point: {
            selector,
            rx: unit(box.width ? (event.clientX - box.left) / box.width : 0),
            ry: unit(box.height ? (event.clientY - box.top) / box.height : 0),
          },
        },
      })
    },
    true
  )
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const typing =
      event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]') !== null
    if (event.key === 'Escape' || (!typing && (event.key === 'c' || event.key === 'f')))
      post({ type: 'key', key: event.key })
  })

  // --- What the shell asks. Only the viewer that frames this page may ask.

  const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

  function readAnchor(value: unknown): Anchor | null {
    if (typeof value !== 'object' || value === null) return null
    const raw = value as { id?: unknown; quote?: Record<string, unknown>; point?: Record<string, unknown> }
    if (typeof raw.id !== 'string' || !ANCHOR_ID.test(raw.id)) return null
    if (raw.quote && typeof raw.quote === 'object')
      return {
        id: raw.id,
        quote: {
          exact: text(raw.quote.exact, MAX_QUOTE_CHARS),
          prefix: text(raw.quote.prefix, MAX_CONTEXT_CHARS),
          suffix: text(raw.quote.suffix, MAX_CONTEXT_CHARS),
        },
      }
    if (raw.point && typeof raw.point === 'object') {
      const selector = text(raw.point.selector, MAX_SELECTOR_CHARS)
      if (!selector) return null
      return { id: raw.id, point: { selector, rx: unit(Number(raw.point.rx)), ry: unit(Number(raw.point.ry)) } }
    }
    return null
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const data = event.data as { source?: unknown; type?: unknown } & Record<string, unknown>
    if (data?.source !== 'maestrly-shell') return
    if (data.type === 'anchors' && Array.isArray(data.anchors)) {
      anchors = data.anchors
        .slice(0, MAX_ANCHORS + 1)
        .map(readAnchor)
        .filter((anchor): anchor is Anchor => anchor !== null)
      activeId = typeof data.active === 'string' ? data.active : null
      resolveRanges()
      paint()
      layout()
    } else if (data.type === 'mode') {
      commenting = data.commenting === true
      style()
    } else if (data.type === 'reveal' && typeof data.id === 'string') {
      const anchor = anchors.find((item) => item.id === data.id)
      const target = anchor?.quote
        ? ranges.get(anchor.id)?.startContainer.parentElement
        : anchor?.point
          ? query(anchor.point.selector)
          : null
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else if (data.type === 'measure') {
      layout()
    } else if (data.type === 'clear-selection') {
      document.getSelection()?.removeAllRanges()
    }
  })

  // Scrolling reports at once, so pins stay on their passage; everything else waits for the next frame.
  window.addEventListener('scroll', layout, { capture: true, passive: true })
  window.addEventListener('resize', layoutSoon)
  window.addEventListener('load', layoutSoon)

  // Pages that change by themselves (tabs, lists, charts) move their passages: find them again.
  // At most once per delay, so a page that never stops changing, such as a clock, is still followed.
  let reindexTimer: ReturnType<typeof setTimeout> | null = null
  const reindexSoon = () => {
    if (!anchors.length || reindexTimer) return
    reindexTimer = setTimeout(() => {
      reindexTimer = null
      resolveRanges()
      paint()
      layout()
    }, REINDEX_DELAY_MS)
  }

  const ready = () => {
    style()
    new ResizeObserver(layoutSoon).observe(document.documentElement)
    if (document.body)
      new MutationObserver(reindexSoon).observe(document.body, { childList: true, subtree: true, characterData: true })
    post({ type: 'ready' })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready)
  else ready()
})()
