// Prototype only. Stands in for the bridge extension the host would inject into the page: it reports what is under
// the pointer in Inspect mode, counts components, and applies token previews. The viewer prototype injects it into
// every frame it loads; the sample app does not include it. Messages are tagged like the real bridge's.
;(() => {
  if (window.__maestrlyProbe) return
  window.__maestrlyProbe = true

  const TOKEN_NAME = /^--[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/
  const BAD_VALUE = /[;{}<\\]|url\(|image-set\(|src\(|\/\*|\*\/|!important/i
  const MAX_TOKENS = 200
  const post = (message) => window.parent.postMessage({ source: 'maestrly-probe', ...message }, '*')

  let inspecting = false
  let hovered = null
  let selected = null
  let matches = []
  let rules = null
  let readable = true

  // --- What an element is.

  const component = (el) => el?.closest?.('[data-ds]') ?? null
  const parseProps = (text) =>
    (text ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((pair) => pair.split('='))
      .filter(([key, value]) => key && value !== undefined)
      .slice(0, 16)

  function pathOf(el) {
    const steps = []
    for (let node = el; node && node !== document.body; node = node.parentElement)
      steps.unshift([...node.parentElement.children].indexOf(node))
    return steps.join('/')
  }

  function byPath(path) {
    let node = document.body
    for (const step of String(path)
      .split('/')
      .filter((part) => part !== '')) {
      node = node?.children[Number(step)]
      if (!node) return null
    }
    return node
  }

  function rectOf(el) {
    const box = el.getBoundingClientRect()
    return { x: box.left, y: box.top, width: box.width, height: box.height }
  }

  const hex = (color) => {
    const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(color)
    if (!match) return color
    const [r, g, b] = match.slice(1, 4).map((n) => Math.round(Number(n)))
    const alpha = match[4] === undefined ? 1 : Number(match[4])
    if (alpha === 0) return 'transparent'
    const out = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
    return alpha < 1 ? `${out} · ${Math.round(alpha * 100)}%` : out
  }

  function styleRules() {
    if (rules) return rules
    rules = []
    const walk = (list) => {
      for (const rule of list) {
        if (rule.selectorText && rule.style) rules.push(rule)
        else if (rule.cssRules && (!rule.media || matchMedia(rule.media.mediaText).matches)) walk(rule.cssRules)
      }
    }
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules)
      } catch {
        readable = false
      }
    }
    return rules
  }

  const tokenValue = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

  /** Tokens the element's own rules refer to, in the order they appear. */
  function tokensOf(el) {
    const found = new Map()
    for (const rule of styleRules()) {
      const selector = rule.selectorText.replace(/::?(before|after|placeholder|marker)\b/g, '')
      let applies = false
      try {
        applies = el.matches(selector)
      } catch {
        applies = false
      }
      if (!applies || rule.selectorText.includes(':hover')) continue
      // Longhands of a shorthand written with var() read as empty, so the declarations come from the rule's text.
      for (const declaration of rule.style.cssText.split(';')) {
        const at = declaration.indexOf(':')
        if (at < 0) continue
        const property = declaration.slice(0, at).trim()
        for (const match of declaration.slice(at + 1).matchAll(/var\((--[a-zA-Z0-9_-]+)/g))
          if (!found.has(match[1])) found.set(match[1], property)
      }
    }
    return [...found].map(([name, property]) => ({ name, property, value: tokenValue(name) }))
  }

  function computedOf(el) {
    const style = getComputedStyle(el)
    return {
      font: style.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
      weight: style.fontWeight,
      size: style.fontSize,
      lineHeight: style.lineHeight,
      color: hex(style.color),
      background: hex(style.backgroundColor),
      radius: style.borderRadius,
      padding: style.padding,
    }
  }

  function describe(el, full) {
    const root = component(el)
    const target = root ?? el
    const info = {
      path: pathOf(target),
      name: root ? root.dataset.ds : null,
      main: root ? root.hasAttribute('data-ds-main') : false,
      props: root ? parseProps(root.dataset.dsProps) : [],
      tag: target.tagName.toLowerCase(),
      classes: [...target.classList].slice(0, 3),
      rect: rectOf(target),
    }
    if (!full) return info
    const chain = []
    for (let node = target.parentElement?.closest('[data-ds]'); node; node = node.parentElement?.closest('[data-ds]'))
      chain.unshift({ name: node.dataset.ds, path: pathOf(node) })
    return { ...info, chain, tokens: tokensOf(target), readable, computed: computedOf(target) }
  }

  // --- Reporting.

  function layout() {
    post({
      type: 'layout',
      hover: hovered?.isConnected ? rectOf(hovered) : null,
      selected: selected?.isConnected ? rectOf(selected) : null,
      matches: matches.filter((el) => el.isConnected).map(rectOf),
      width: innerWidth,
      height: innerHeight,
    })
  }

  function inventory() {
    const counts = {}
    for (const el of document.querySelectorAll('[data-ds]')) {
      if (el.hasAttribute('data-ds-main')) continue
      counts[el.dataset.ds] = (counts[el.dataset.ds] ?? 0) + 1
    }
    const variants = {}
    for (const el of document.querySelectorAll('[data-ds]')) {
      const list = (variants[el.dataset.ds] ??= [])
      const props = el.dataset.dsProps ?? ''
      if (props && !list.includes(props)) list.push(props)
    }
    const mains = [...document.querySelectorAll('[data-ds-main]')].map((el) => el.dataset.ds)
    post({ type: 'inventory', counts, variants, mains })
  }

  const targetAt = (x, y) => {
    const el = document.elementFromPoint(x, y)
    if (!el || el === document.documentElement || el === document.body) return null
    return component(el) ?? el
  }

  function select(el, reveal) {
    selected = el
    hovered = null
    if (reveal && el) {
      const box = el.getBoundingClientRect()
      if (box.top < 0 || box.bottom > innerHeight * reveal) scrollBy({ top: box.top - innerHeight * 0.18 })
    }
    post({ type: 'pick', target: el ? describe(el, true) : null })
    layout()
  }

  // --- Pointer and keys.

  const style = document.createElement('style')
  style.textContent = 'html.maestrly-inspecting, html.maestrly-inspecting * { cursor: default !important; }'
  document.documentElement.append(style)

  document.addEventListener(
    'pointermove',
    (event) => {
      if (!inspecting) return
      const next = targetAt(event.clientX, event.clientY)
      if (next === hovered) return
      hovered = next === selected ? null : next
      post({ type: 'hover', target: hovered ? describe(hovered, false) : null })
      layout()
    },
    true
  )
  document.addEventListener(
    'pointerleave',
    () => {
      if (!inspecting || !hovered) return
      hovered = null
      post({ type: 'hover', target: null })
      layout()
    },
    true
  )
  for (const type of ['click', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'submit'])
    document.addEventListener(
      type,
      (event) => {
        if (!inspecting) return
        event.preventDefault()
        event.stopPropagation()
        if (type === 'click') select(targetAt(event.clientX, event.clientY), 0)
      },
      true
    )
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const typing = event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]')
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    if (key === 'Escape' || (!typing && ['c', 'f', 'i', 's', 't'].includes(key))) post({ type: 'key', key })
  })
  addEventListener('scroll', layout, { passive: true })
  addEventListener('resize', layout)
  // A srcdoc resolves "#…" links against the page that framed it, so in-page links move by fragment instead.
  if (location.href.startsWith('about:srcdoc'))
    document.addEventListener('click', (event) => {
      const link = event.target instanceof Element && event.target.closest('a[href^="#"]')
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
        return
      event.preventDefault()
      location.hash = link.getAttribute('href').slice(1)
    })

  // --- Token previews: only validated names and values reach the page. Each value replaces the declaration in the
  // block that declares it, the default one or a theme's, so themes keep overriding the default as in the file. When
  // the stylesheet cannot be read, values fall back to custom properties on the root element.

  const BLOCK =
    /^(:root|\[data-theme="[a-z0-9-]{1,32}"\]|:root\[data-theme="[a-z0-9-]{1,32}"\]|\.theme-[a-z0-9-]{1,32})$/
  const MEDIA = /^\(prefers-color-scheme:(dark|light)\)$/
  const THEME_VALUE = /^[a-z0-9-]{1,32}$/
  const normal = (text) => text.replace(/\s+/g, '').replace(/'/g, '"')
  let edits = []
  let inline = []
  let forced = null

  function blockRules(block, media) {
    const found = []
    const walk = (list, condition) => {
      for (const rule of list) {
        if (rule.selectorText !== undefined && rule.style) {
          if (normal(rule.selectorText) === block && condition === media) found.push(rule)
        } else if (rule.cssRules && rule.conditionText !== undefined && condition === null)
          walk(rule.cssRules, normal(rule.conditionText))
      }
    }
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules, null)
      } catch {
        // Unreadable sheets are skipped; their tokens preview inline.
      }
    }
    return found
  }

  /** The theme on screen: the attribute or class its block uses, set on the root element while previewing. */
  function force(theme) {
    const root = document.documentElement
    if (forced?.kind === 'attr') {
      if (forced.had === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', forced.had)
    } else if (forced?.kind === 'class' && !forced.had) root.classList.remove(`theme-${forced.value}`)
    forced = null
    if (!theme || !THEME_VALUE.test(theme.value ?? '')) return
    if (theme.kind === 'attr') {
      forced = { kind: 'attr', value: theme.value, had: root.getAttribute('data-theme') }
      root.setAttribute('data-theme', theme.value)
    } else if (theme.kind === 'class') {
      forced = { kind: 'class', value: theme.value, had: root.classList.contains(`theme-${theme.value}`) }
      root.classList.add(`theme-${theme.value}`)
    }
  }

  function preview(message) {
    const root = document.documentElement
    for (const edit of edits.reverse()) edit.style.setProperty(edit.name, edit.value, edit.priority)
    edits = []
    for (const name of inline) root.style.removeProperty(name)
    inline = []
    force(message.theme)
    const values = Array.isArray(message.values) ? message.values.slice(0, MAX_TOKENS) : []
    for (const entry of values) {
      const { name, value } = entry ?? {}
      const block = typeof entry?.block === 'string' ? normal(entry.block) : ''
      const media = typeof entry?.media === 'string' ? normal(entry.media) : null
      if (!BLOCK.test(block) || (media !== null && !MEDIA.test(media))) continue
      if (!TOKEN_NAME.test(name) || typeof value !== 'string' || value.length > 200 || BAD_VALUE.test(value)) continue
      const declared = blockRules(block, media).filter((rule) => rule.style.getPropertyValue(name) !== '')
      for (const rule of declared) {
        edits.push({
          style: rule.style,
          name,
          value: rule.style.getPropertyValue(name),
          priority: rule.style.getPropertyPriority(name),
        })
        rule.style.setProperty(name, value)
      }
      if (declared.length || media !== null || !root.matches(block)) continue
      root.style.setProperty(name, value)
      inline.push(name)
    }
    rules = null
    if (selected?.isConnected) post({ type: 'pick', target: describe(selected, true), quiet: true })
    layout()
  }

  addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const message = event.data
    if (!message || message.source !== 'maestrly-proto') return
    if (message.type === 'inspect') {
      inspecting = Boolean(message.on)
      document.documentElement.classList.toggle('maestrly-inspecting', inspecting)
      if (!inspecting) {
        hovered = null
        selected = null
      }
      layout()
    } else if (message.type === 'select') {
      const el = message.path
        ? byPath(message.path)
        : message.main
          ? document.querySelector(`[data-ds="${CSS.escape(message.main)}"][data-ds-main]`)
          : message.selector
            ? document.querySelectorAll(message.selector)[message.index ?? 0]
            : null
      if (message.main && el) el.scrollIntoView({ block: 'center' })
      select(el ? (component(el) ?? el) : null, message.main ? 0 : 0.6)
    } else if (message.type === 'hover') {
      const el = message.selector ? document.querySelectorAll(message.selector)[message.index ?? 0] : null
      hovered = el ? (component(el) ?? el) : null
      post({ type: 'hover', target: hovered ? describe(hovered, false) : null })
      layout()
    } else if (message.type === 'matches') {
      matches = message.name ? [...document.querySelectorAll(`[data-ds="${CSS.escape(message.name)}"]`)] : []
      layout()
    } else if (message.type === 'tokens') preview(message)
    else if (message.type === 'inventory') inventory()
    else if (message.type === 'measure') layout()
  })

  let pending = 0
  new MutationObserver(() => {
    clearTimeout(pending)
    pending = setTimeout(() => {
      if (selected && !selected.isConnected) select(null, 0)
      inventory()
      layout()
    }, 60)
  }).observe(document.documentElement, { childList: true, subtree: true })

  const ready = () => {
    post({ type: 'ready', width: innerWidth, height: innerHeight })
    inventory()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready)
  else ready()
})()
