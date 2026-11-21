// Injected into every HTML file of an artifact, before the page's own scripts. A classic script with no imports.
//
// It tells the viewer shell where the comment anchors are in the page, what the reader selected, and, in comment mode,
// which passage or spot the reader chose. The shell draws the pins above the frame and treats every message from here
// as an untrusted hint. What the shell sends in is only the page's own text and places in it, and the response of the
// person viewing the page, never names, comments or other people's responses.
// Nothing here mutates the page's DOM tree (no elements, attributes or text nodes are added, edited or removed):
// the active passage is painted with the CSS Custom Highlight API, inspect outlines are drawn by the shell above the
// frame, and cursors and live token previews are applied only through constructable stylesheets in
// `document.adoptedStyleSheets`.
//
// It also gives the page `window.maestrly`: `submit(data)` saves a JSON object as the response of the person viewing
// the page, replacing the one they sent before, and `getResponse()` returns it, or null. Both reject with an error
// whose `code` is one of `closed`, `unavailable`, `cancelled`, `invalid`, `too_large`, `full`, `rate_limited`, `failed`.
// On a whiteboard, `maestrly.board` is its canvas's link to the board: `load()`, `push(elements)` and
// `subscribe(listener)`; they reject with `read_only`, `invalid`, `too_large`, `full`, `rate_limited`, `unavailable`
// or `failed`. A page whose root element has `data-maestrly-shortcuts="none"` keeps every key but Escape for itself.
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
  let inspecting = false
  let inspectedElement: Element | null = null
  let matchedComponent: string | null = null
  let componentTokenHints: Record<string, string[]> = {}
  const ranges = new Map<string, Range>()

  const TOKEN_NAME_RE = /^--[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}$/
  const COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9]{0,47}$/
  const DS_PROP_KEY_RE = /^[a-z][a-zA-Z0-9-]{0,31}$/
  const CLASS_NAME_RE = /^[a-zA-Z_-][a-zA-Z0-9_-]{0,78}$/
  const CSS_PROP_RE = /^(?:--[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}|-?[a-zA-Z][a-zA-Z0-9-]{0,62})$/
  const THEME_SELECTOR_RE =
    /^(?:(?::root|html)?\[data-theme=(?:"[a-zA-Z0-9_-]{1,32}"|'[a-zA-Z0-9_-]{1,32}')\]|(?::root|html)?\.(?:dark|light|theme-[a-zA-Z0-9_-]{1,32})|@media \((?:prefers-color-scheme: (?:dark|light))\))$/
  const FORBIDDEN_RAW_TOKEN_VALUE_RE = /[<\\]|\/\*|\*\//
  const FORBIDDEN_UNQUOTED_TOKEN_VALUE_RE =
    /!\s*important\b|@import\b|(?:url|-webkit-image-set|image-set|src|expression)\s*\(/i
  const CONTROL_CHAR_RE = /\p{Cc}/u
  const MAX_DS_PROPS = 32
  const MAX_DS_PROPS_RAW_CHARS = 200
  const MAX_DS_PROP_VALUE_CHARS = 120
  const MAX_COMPUTED_STYLE_CHARS = 120
  const MAX_TOKEN_VALUE_CHARS = 200
  const MAX_INSPECTED_TOKENS = 64
  const MAX_INSPECT_CHAIN = 8
  const MAX_INSPECT_CLASSES = 2
  const MAX_ELEMENT_LABEL_CHARS = 80
  const MAX_COMPONENT_VARIANTS = 32
  const MAX_MATCH_RECTS = 200
  const MAX_INVENTORY_NODES = 5000
  const MAX_INVENTORY_COMPONENTS = 200
  const MAX_INVENTORY_COUNT = 10_000
  const MAX_SCANNED_CSS_RULES = 2000

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

  function rectOf(element: Element): { x: number; y: number; width: number; height: number } {
    const box = element.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  }

  function collectMatchRects(component: string): { x: number; y: number; width: number; height: number }[] {
    const rects: { x: number; y: number; width: number; height: number }[] = []
    if (!COMPONENT_NAME_RE.test(component)) return rects
    const nodes = document.querySelectorAll('[data-ds]')
    const limit = Math.min(nodes.length, MAX_INVENTORY_NODES)
    for (let i = 0; i < limit && rects.length < MAX_MATCH_RECTS; i++) {
      const el = nodes[i]!
      if (el.getAttribute('data-ds') !== component || el.hasAttribute('data-ds-main')) continue
      const r = rectOf(el)
      if (r.width > 0 || r.height > 0) rects.push(r)
    }
    return rects
  }

  function layout(): void {
    const payload: Record<string, unknown> = {
      type: 'layout',
      pins: positions(),
      width: window.innerWidth,
      height: window.innerHeight,
    }
    if (inspectedElement) {
      if (!inspectedElement.isConnected) {
        inspectedElement = null
        payload.inspectRect = null
      } else {
        payload.inspectRect = rectOf(inspectedElement)
      }
    }
    if (matchedComponent !== null) {
      payload.matchRects = collectMatchRects(matchedComponent)
    }
    post(payload)
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

  // --- The active passage, the mode cursor, and live token previews, painted without touching the DOM.

  type HighlightRegistryLike = { set(name: string, highlight: unknown): unknown; delete(name: string): unknown }
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS?.highlights
  const HighlightClass = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  let sheet: CSSStyleSheet | null = null
  let previewSheet: CSSStyleSheet | null = null

  function style(): void {
    try {
      if (!sheet) {
        sheet = new CSSStyleSheet()
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
      }
      const cursorRule = commenting
        ? `*{cursor:${COMMENT_CURSOR} !important}`
        : inspecting
          ? '*{cursor:crosshair !important}'
          : ''
      sheet.replaceSync(`::highlight(${HIGHLIGHT}){background-color:rgba(255,204,64,.55);color:inherit}${cursorRule}`)
    } catch {
      // Without constructable style sheets the page keeps its own cursor and nothing is painted.
    }
  }

  function validPreviewTokenValue(value: unknown): value is string {
    if (typeof value !== 'string') return false
    if (value.length > MAX_TOKEN_VALUE_CHARS || CONTROL_CHAR_RE.test(value)) return false
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > MAX_TOKEN_VALUE_CHARS) return false
    if (FORBIDDEN_RAW_TOKEN_VALUE_RE.test(value)) return false

    let quote: '"' | "'" | null = null
    const stack: ('(' | '[')[] = []
    let unquoted = ''
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]!
      if (quote !== null) {
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        unquoted += '""'
        continue
      }
      if (ch === ';' || ch === '{' || ch === '}') return false
      if (ch === '(' || ch === '[') {
        stack.push(ch)
        unquoted += ch
      } else if (ch === ')') {
        if (stack.pop() !== '(') return false
        unquoted += ch
      } else if (ch === ']') {
        if (stack.pop() !== '[') return false
        unquoted += ch
      } else {
        unquoted += ch
      }
    }
    if (quote !== null || stack.length > 0) return false
    return !FORBIDDEN_UNQUOTED_TOKEN_VALUE_RE.test(unquoted)
  }

  function applyTokenPreview(rawTokens: unknown): void {
    try {
      if (!Array.isArray(rawTokens) || rawTokens.length === 0) {
        previewSheet?.replaceSync('')
        return
      }
      const rootDecls: string[] = []
      const themedDecls = new Map<string, string[]>()
      for (const item of rawTokens.slice(0, 200)) {
        if (typeof item !== 'object' || item === null) continue
        const rec = item as { name?: unknown; value?: unknown; theme?: unknown }
        if (typeof rec.name !== 'string' || !TOKEN_NAME_RE.test(rec.name)) continue
        if (!validPreviewTokenValue(rec.value)) continue
        const decl = `${rec.name}:${rec.value.trim()} !important;`
        if (rec.theme === null || rec.theme === undefined) {
          rootDecls.push(decl)
        } else if (typeof rec.theme === 'string' && rec.theme.length <= 120 && THEME_SELECTOR_RE.test(rec.theme)) {
          let list = themedDecls.get(rec.theme)
          if (!list) {
            list = []
            themedDecls.set(rec.theme, list)
          }
          list.push(decl)
        }
      }
      const blocks: string[] = []
      if (rootDecls.length) blocks.push(`:root{${rootDecls.join('')}}`)
      for (const [theme, decls] of themedDecls) {
        if (theme.startsWith('@media ')) blocks.push(`${theme}{:root{${decls.join('')}}}`)
        else blocks.push(`${theme}{${decls.join('')}}`)
      }
      if (!previewSheet) {
        previewSheet = new CSSStyleSheet()
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, previewSheet]
      }
      previewSheet.replaceSync(blocks.join('\n'))
    } catch {
      // Constructable stylesheets unavailable.
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

  function resolveInspectElement(hit: Element | null): Element | null {
    if (!hit) return null
    for (let node: Element | null = hit; node; node = node.parentElement) {
      const ds = node.getAttribute('data-ds')
      if (ds && COMPONENT_NAME_RE.test(ds)) return node
    }
    return hit
  }

  function buildInspectHover(element: Element): Record<string, unknown> {
    const { selector } = pathOf(element)
    const rawComponent = element.getAttribute('data-ds')
    const component = rawComponent && COMPONENT_NAME_RE.test(rawComponent) ? rawComponent : null
    const tag = element.tagName.toLowerCase().slice(0, 64)
    const classes: string[] = []
    for (let i = 0; i < element.classList.length && classes.length < MAX_INSPECT_CLASSES; i++) {
      const cls = element.classList[i]!
      if (CLASS_NAME_RE.test(cls)) classes.push(cls)
    }
    let elementLabel = tag
    for (const cls of classes) {
      const candidate = `${elementLabel}.${cls}`
      if (candidate.length <= MAX_ELEMENT_LABEL_CHARS) elementLabel = candidate
      else break
    }
    return {
      selector,
      rect: rectOf(element),
      tag,
      elementLabel,
      component,
      main: component !== null && element.hasAttribute('data-ds-main'),
    }
  }

  function parseDsProps(raw: string | null): Record<string, string> {
    const props: Record<string, string> = {}
    if (!raw) return props
    const parts = raw.slice(0, MAX_DS_PROPS_RAW_CHARS).trim().split(/\s+/)
    let count = 0
    for (const part of parts) {
      if (!part || count >= MAX_DS_PROPS) break
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      const key = part.slice(0, eq)
      const val = part.slice(eq + 1)
      if (!DS_PROP_KEY_RE.test(key) || key === 'constructor' || key === 'prototype') continue
      if (!val || val.length > MAX_DS_PROP_VALUE_CHARS || CONTROL_CHAR_RE.test(val)) continue
      Object.defineProperty(props, key, { value: val, enumerable: true, writable: true, configurable: true })
      count++
    }
    return props
  }

  function normalizeVariantProps(raw: string | null): string | null {
    const parsed = parseDsProps(raw)
    const keys = Object.keys(parsed)
    if (keys.length === 0) return null
    const joined = keys.map((k) => `${k}=${parsed[k]!}`).join(' ')
    return joined.length <= MAX_DS_PROPS_RAW_CHARS ? joined : null
  }

  function collectComponentVariantsFor(component: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    const nodes = document.querySelectorAll('[data-ds]')
    const limit = Math.min(nodes.length, MAX_INVENTORY_NODES)
    for (let i = 0; i < limit && out.length < MAX_COMPONENT_VARIANTS; i++) {
      const el = nodes[i]!
      if (el.hasAttribute('data-ds-main') || el.getAttribute('data-ds') !== component) continue
      const norm = normalizeVariantProps(el.getAttribute('data-ds-props'))
      if (norm && !seen.has(norm)) {
        seen.add(norm)
        out.push(norm)
      }
    }
    return out
  }

  const VAR_TOKEN_RE = /var\(\s*(--[a-zA-Z0-9][a-zA-Z0-9_-]{0,61})(?=[\s,)])/g

  function collectDeclarationTokens(rawBlock: string, into: Map<string, string | undefined>): void {
    let block = rawBlock.trim()
    if (block.startsWith('{') && block.endsWith('}')) block = block.slice(1, -1)
    let quote: '"' | "'" | null = null
    let depth = 0
    let start = 0

    const processDecl = (segment: string): void => {
      let dq: '"' | "'" | null = null
      let dp = 0
      let colon = -1
      for (let i = 0; i < segment.length; i++) {
        const c = segment[i]!
        if (dq) {
          if (c === dq) dq = null
          continue
        }
        if (c === '"' || c === "'") {
          dq = c
          continue
        }
        if (c === '(') dp++
        else if (c === ')' && dp > 0) dp--
        else if (c === ':' && dp === 0) {
          colon = i
          break
        }
      }
      if (colon <= 0) return
      const rawProp = segment.slice(0, colon).trim()
      const prop = CSS_PROP_RE.test(rawProp) ? rawProp : undefined
      const valText = segment.slice(colon + 1)
      VAR_TOKEN_RE.lastIndex = 0
      for (let match = VAR_TOKEN_RE.exec(valText); match; match = VAR_TOKEN_RE.exec(valText)) {
        const name = match[1]!
        if (!into.has(name)) {
          if (into.size >= MAX_INSPECTED_TOKENS) return
          into.set(name, prop)
        } else if (into.get(name) === undefined && prop !== undefined) {
          into.set(name, prop)
        }
      }
    }

    for (let i = 0; i < block.length && into.size < MAX_INSPECTED_TOKENS; i++) {
      const ch = block[i]!
      if (quote) {
        if (ch === quote) quote = null
        continue
      }
      if (ch === '/' && block[i + 1] === '*') {
        const end = block.indexOf('*/', i + 2)
        if (end < 0) break
        i = end + 1
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')' && depth > 0) depth--
      else if (ch === ';' && depth === 0) {
        processDecl(block.slice(start, i))
        start = i + 1
      }
    }
    if (start < block.length && into.size < MAX_INSPECTED_TOKENS) {
      processDecl(block.slice(start))
    }
  }

  function collectCssRuleTokens(element: Element, into: Map<string, string | undefined>): boolean {
    let scanned = 0
    let unreadableSheet = false
    const visitRules = (rules: CSSRuleList): void => {
      for (let i = 0; i < rules.length && scanned < MAX_SCANNED_CSS_RULES && into.size < MAX_INSPECTED_TOKENS; i++) {
        scanned++
        const rule = rules[i]
        if (!rule) continue
        if (typeof CSSStyleRule !== 'undefined' && rule instanceof CSSStyleRule) {
          let matched = false
          try {
            matched = element.matches(rule.selectorText)
          } catch {
            matched = false
          }
          if (matched) collectDeclarationTokens(rule.cssText.slice(rule.selectorText.length), into)
        } else if ('cssRules' in rule) {
          try {
            const nested = (rule as CSSGroupingRule).cssRules
            if (nested) visitRules(nested)
          } catch {
            unreadableSheet = true
          }
        }
      }
    }
    for (let i = 0; i < document.styleSheets.length && into.size < MAX_INSPECTED_TOKENS; i++) {
      const s = document.styleSheets[i]
      if (!s) continue
      try {
        visitRules(s.cssRules)
      } catch {
        // Stylesheet without CORS (`crossorigin`) in an opaque origin throws SecurityError.
        unreadableSheet = true
      }
    }
    return unreadableSheet
  }

  function buildInspectTarget(element: Element): Record<string, unknown> {
    const hover = buildInspectHover(element)
    const component = hover.component as string | null
    const computed = getComputedStyle(element)
    const capStyle = (val: string) => val.replace(/\p{Cc}/gu, '').slice(0, MAX_COMPUTED_STYLE_CHARS)
    const styles = {
      fontFamily: capStyle(computed.fontFamily),
      fontSize: capStyle(computed.fontSize),
      fontWeight: capStyle(computed.fontWeight),
      lineHeight: capStyle(computed.lineHeight),
      color: capStyle(computed.color),
      backgroundColor: capStyle(computed.backgroundColor),
      borderRadius: capStyle(computed.borderRadius),
      padding: capStyle(computed.padding),
    }

    const tokenProps = new Map<string, string | undefined>()
    const inlineStyle = element.getAttribute('style')
    if (inlineStyle) collectDeclarationTokens(inlineStyle, tokenProps)
    collectCssRuleTokens(element, tokenProps)
    const cssTokenCount = tokenProps.size
    if (component && Object.hasOwn(componentTokenHints, component)) {
      for (const hint of componentTokenHints[component]!) {
        if (tokenProps.size >= MAX_INSPECTED_TOKENS) break
        if (TOKEN_NAME_RE.test(hint) && !tokenProps.has(hint)) tokenProps.set(hint, undefined)
      }
    }
    const tokensFromManifest = cssTokenCount === 0 && tokenProps.size > 0

    const tokens: { name: string; value: string; property?: string }[] = []
    for (const [name, property] of tokenProps) {
      const val = computed
        .getPropertyValue(name)
        .trim()
        .replace(/\p{Cc}/gu, '')
        .slice(0, MAX_TOKEN_VALUE_CHARS)
      tokens.push({ name, value: val, ...(property !== undefined ? { property } : {}) })
    }

    const chain: { component: string; selector: string }[] = []
    for (
      let anc: Element | null = element.parentElement;
      anc && chain.length < MAX_INSPECT_CHAIN;
      anc = anc.parentElement
    ) {
      const ds = anc.getAttribute('data-ds')
      if (ds && COMPONENT_NAME_RE.test(ds)) {
        chain.unshift({ component: ds, selector: pathOf(anc).selector })
      }
    }

    const variants = hover.main === true && component ? collectComponentVariantsFor(component) : undefined

    return {
      ...hover,
      props: parseDsProps(element.getAttribute('data-ds-props')),
      styles,
      tokens,
      chain,
      ...(variants !== undefined ? { variants } : {}),
      ...(tokensFromManifest ? { tokensFromManifest: true } : {}),
    }
  }

  function collectInventory(): {
    instances: Record<string, number>
    mains: string[]
    variants: Record<string, string[]>
  } {
    const instances: Record<string, number> = {}
    const mains: string[] = []
    const variants: Record<string, string[]> = {}
    const seenMains = new Set<string>()
    let instanceKeys = 0
    let variantKeys = 0
    const nodes = document.querySelectorAll('[data-ds]')
    const limit = Math.min(nodes.length, MAX_INVENTORY_NODES)
    for (let i = 0; i < limit; i++) {
      const el = nodes[i]!
      const comp = el.getAttribute('data-ds')
      if (!comp || !COMPONENT_NAME_RE.test(comp)) continue
      if (el.hasAttribute('data-ds-main')) {
        if (!seenMains.has(comp) && mains.length < MAX_INVENTORY_COMPONENTS) {
          seenMains.add(comp)
          mains.push(comp)
        }
      } else {
        const normVariant = normalizeVariantProps(el.getAttribute('data-ds-props'))
        if (normVariant) {
          if (!Object.hasOwn(variants, comp)) {
            if (variantKeys < MAX_INVENTORY_COMPONENTS) {
              variantKeys++
              Object.defineProperty(variants, comp, {
                value: [normVariant],
                enumerable: true,
                writable: true,
                configurable: true,
              })
            }
          } else {
            const list = variants[comp]!
            if (list.length < MAX_COMPONENT_VARIANTS && !list.includes(normVariant)) {
              list.push(normVariant)
            }
          }
        }
        const hasKey = Object.hasOwn(instances, comp)
        if (!hasKey) {
          if (instanceKeys >= MAX_INVENTORY_COMPONENTS) continue
          instanceKeys++
          Object.defineProperty(instances, comp, { value: 1, enumerable: true, writable: true, configurable: true })
        } else if (instances[comp]! < MAX_INVENTORY_COUNT) {
          instances[comp]!++
        }
      }
    }
    return { instances, mains, variants }
  }

  let hoverQueued = false
  let lastPointerHit: Element | null = null
  function reportHoverSoon(hit: Element | null): void {
    lastPointerHit = hit
    if (hoverQueued) return
    hoverQueued = true
    const flush = () => {
      if (!hoverQueued) return
      hoverQueued = false
      if (!inspecting) return
      const candidate = resolveInspectElement(lastPointerHit)
      post({ type: 'inspect-hover', target: candidate ? buildInspectHover(candidate) : null })
    }
    requestAnimationFrame(flush)
    setTimeout(flush, FRAME_FALLBACK_MS)
  }

  window.addEventListener(
    'pointermove',
    (event) => {
      if (!inspecting) return
      reportHoverSoon(event.target instanceof Element ? event.target : null)
    },
    true
  )
  document.documentElement.addEventListener('pointerleave', () => {
    if (inspecting) post({ type: 'inspect-hover', target: null })
  })

  function onPointer(event: Event): void {
    if (!commenting && !inspecting) return
    // The page does not learn about clicks meant for comments or inspect; default stays for text selection.
    event.stopImmediatePropagation()
  }
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick'])
    window.addEventListener(type, onPointer, true)

  window.addEventListener(
    'submit',
    (event) => {
      if (!commenting && !inspecting) return
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    true
  )

  window.addEventListener(
    'click',
    (event) => {
      if (inspecting) {
        event.preventDefault()
        event.stopImmediatePropagation()
        const hit = event.target instanceof Element ? event.target : document.body
        const candidate = resolveInspectElement(hit)
        matchedComponent = null
        inspectedElement = candidate
        post({ type: 'inspect-pick', target: candidate ? buildInspectTarget(candidate) : null })
        return
      }
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
  function isEditableTarget(target: EventTarget | null): boolean {
    if (target instanceof HTMLElement && target.isContentEditable) return true
    if (!(target instanceof Element)) return false
    return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null
  }

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // A canvas such as the whiteboard's uses single keys as its own tools.
    if (document.documentElement.dataset.maestrlyShortcuts === 'none' && event.key !== 'Escape') return
    const typing = isEditableTarget(event.target)
    const lower = event.key.length === 1 ? event.key.toLowerCase() : event.key
    if (
      event.key === 'Escape' ||
      (!typing && (lower === 'c' || lower === 'f' || lower === 'i' || lower === 's' || lower === 't'))
    )
      post({ type: 'key', key: event.key === 'Escape' ? 'Escape' : lower })
  })

  // --- Responses: one per person, kept by the host. The page hands its data to the viewer, which saves it as the
  // person viewing it. The page never learns who that is, and gets back only what that person saved.

  const MAX_RESPONSE_BYTES = 32 * 1024
  const MAX_BOARD_PUSH_ELEMENTS = 1000
  const MAX_BOARD_PUSH_BYTES = 900 * 1024
  const boardListeners = new Set<(change: unknown) => void>()
  let nextRequest = 0
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const failure = (code: string) => Object.assign(new Error(`maestrly: ${code}`), { code })

  function ask(
    type: 'response-get' | 'response-submit' | 'board-load' | 'board-push',
    extra: Record<string, unknown>
  ): Promise<unknown> {
    // Opened outside the viewer, nobody can save anything.
    if (window.parent === window) return Promise.reject(failure('unavailable'))
    const requestId = `r${++nextRequest}`
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      post({ type, requestId, ...extra })
    })
  }

  const api = Object.freeze({
    /** Saves `data` (a JSON object) as this person's response, replacing the one they sent before. */
    submit(data: unknown): Promise<unknown> {
      let copy: unknown
      try {
        copy = JSON.parse(JSON.stringify(data))
      } catch {
        return Promise.reject(failure('invalid'))
      }
      if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) return Promise.reject(failure('invalid'))
      if (new TextEncoder().encode(JSON.stringify(copy)).byteLength > MAX_RESPONSE_BYTES)
        return Promise.reject(failure('too_large'))
      return ask('response-submit', { data: copy })
    },
    /** This person's saved response, as { data, version, updatedAt }, or null. */
    getResponse(): Promise<unknown> {
      return ask('response-get', {})
    },
    board: Object.freeze({
      /** The whiteboard as { revision, elements, canEdit }. */
      load(): Promise<unknown> {
        return ask('board-load', {})
      },
      /** Sends elements the person changed; resolves to { revision, kept }, the board's copy of those it refused. */
      push(elements: unknown): Promise<unknown> {
        let copy: unknown
        try {
          copy = JSON.parse(JSON.stringify(elements))
        } catch {
          return Promise.reject(failure('invalid'))
        }
        if (!Array.isArray(copy)) return Promise.reject(failure('invalid'))
        if (
          copy.length > MAX_BOARD_PUSH_ELEMENTS ||
          new TextEncoder().encode(JSON.stringify(copy)).byteLength > MAX_BOARD_PUSH_BYTES
        )
          return Promise.reject(failure('too_large'))
        return ask('board-push', { elements: copy })
      },
      /** Calls `listener` with { revision, elements } whenever others change the board. Returns the unsubscribe. */
      subscribe(listener: unknown): () => void {
        if (typeof listener !== 'function') throw failure('invalid')
        const call = listener as (change: unknown) => void
        boardListeners.add(call)
        return () => boardListeners.delete(call)
      },
    }),
  })
  if (!('maestrly' in window)) Object.defineProperty(window, 'maestrly', { value: api, configurable: true })

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
      if (commenting) inspecting = false
      style()
    } else if (data.type === 'inspect-mode') {
      inspecting = data.inspecting === true
      if (inspecting) commenting = false
      else {
        inspectedElement = null
        matchedComponent = null
        lastPointerHit = null
      }
      const nextHints: Record<string, string[]> = {}
      if (
        typeof data.componentTokens === 'object' &&
        data.componentTokens !== null &&
        !Array.isArray(data.componentTokens)
      ) {
        for (const [comp, list] of Object.entries(data.componentTokens as Record<string, unknown>)) {
          if (!COMPONENT_NAME_RE.test(comp) || !Array.isArray(list)) continue
          const filtered = list.filter((t): t is string => typeof t === 'string' && TOKEN_NAME_RE.test(t)).slice(0, 64)
          Object.defineProperty(nextHints, comp, {
            value: filtered,
            enumerable: true,
            writable: true,
            configurable: true,
          })
        }
      }
      componentTokenHints = nextHints
      style()
    } else if (data.type === 'inspect-clear') {
      inspectedElement = null
      matchedComponent = null
      layoutSoon()
    } else if (data.type === 'inspect-select' && typeof data.selector === 'string') {
      if (!data.selector || data.selector.length > MAX_SELECTOR_CHARS || CONTROL_CHAR_RE.test(data.selector)) return
      matchedComponent = null
      const target = query(data.selector)
      if (target) {
        const box = target.getBoundingClientRect()
        if (box.bottom < 0 || box.top > window.innerHeight) {
          target.scrollIntoView({ block: 'center' })
        }
        inspectedElement = target
        post({ type: 'inspect-pick', target: buildInspectTarget(target) })
        layoutSoon()
      } else {
        inspectedElement = null
        post({ type: 'inspect-pick', target: null })
      }
    } else if (data.type === 'highlight-component') {
      if (typeof data.component === 'string' && COMPONENT_NAME_RE.test(data.component)) {
        matchedComponent = data.component
        inspectedElement = null
        const escaped = CSS.escape(data.component)
        const first = query(`[data-ds="${escaped}"]:not([data-ds-main])`)
        if (first) {
          const box = first.getBoundingClientRect()
          if (box.bottom < 0 || box.top > window.innerHeight) {
            first.scrollIntoView({ block: 'nearest' })
          }
        }
        post({ type: 'matches', rects: collectMatchRects(data.component) })
        layoutSoon()
      } else if (data.component === null) {
        matchedComponent = null
        post({ type: 'matches', rects: [] })
        layoutSoon()
      }
    } else if (data.type === 'reveal-component' && typeof data.component === 'string') {
      if (!COMPONENT_NAME_RE.test(data.component)) return
      matchedComponent = null
      const escaped = CSS.escape(data.component)
      const target = query(`[data-ds="${escaped}"][data-ds-main]`) ?? query(`[data-ds="${escaped}"]`)
      if (target) {
        target.scrollIntoView({ block: 'center' })
        inspectedElement = target
        post({ type: 'inspect-pick', target: buildInspectTarget(target) })
        layoutSoon()
      } else {
        inspectedElement = null
        post({ type: 'inspect-pick', target: null })
      }
    } else if (data.type === 'inventory-request' && typeof data.requestId === 'string') {
      const { instances, mains, variants } = collectInventory()
      post({ type: 'inventory', requestId: data.requestId.slice(0, 32), instances, mains, variants })
    } else if (data.type === 'token-preview') {
      applyTokenPreview(data.tokens)
      if (inspectedElement?.isConnected) {
        post({ type: 'inspect-pick', target: buildInspectTarget(inspectedElement) })
      }
      layoutSoon()
    } else if (data.type === 'token-preview-clear') {
      previewSheet?.replaceSync('')
      if (inspectedElement?.isConnected) {
        post({ type: 'inspect-pick', target: buildInspectTarget(inspectedElement) })
      }
      layoutSoon()
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
    } else if (data.type === 'response-result' && typeof data.requestId === 'string') {
      const request = pending.get(data.requestId)
      if (!request) return
      pending.delete(data.requestId)
      if (data.ok === true) request.resolve(data.response ?? null)
      else request.reject(failure(typeof data.error === 'string' ? data.error : 'failed'))
    } else if ((data.type === 'board-loaded' || data.type === 'board-pushed') && typeof data.requestId === 'string') {
      const request = pending.get(data.requestId)
      if (!request) return
      pending.delete(data.requestId)
      if (data.ok !== true) request.reject(failure(typeof data.error === 'string' ? data.error : 'failed'))
      else if (data.type === 'board-loaded')
        request.resolve({ revision: data.revision, elements: data.elements, canEdit: data.canEdit === true })
      else request.resolve({ revision: data.revision, kept: data.kept })
    } else if (data.type === 'board-changes') {
      const change = { revision: data.revision, elements: data.elements }
      for (const listener of boardListeners) {
        try {
          listener(change)
        } catch (error) {
          post({ type: 'error', message: String((error as Error)?.message ?? error).slice(0, 300) })
        }
      }
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
