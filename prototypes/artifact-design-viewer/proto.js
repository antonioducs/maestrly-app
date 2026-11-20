// Prototype of Design mode v2 in the artifact viewer: Inspect, Screens and Tokens, inside the viewer's own bar, stage
// and panels. The DOM is built with the shell's `h()` and `icon()` and styled by viewer.css (an unchanged copy of the
// shell's) plus proto.css (only the new rules), so each part ports to packages/artifact-host/src/shell almost as is.
// Every state opens from the URL hash; HANDOFF.md lists them. Data and times are fixed so captures repeat exactly.
;(() => {
  // ---------------------------------------------------------------- DOM helpers, as in shell/dom.ts
  function put(parent, ...children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue
      if (Array.isArray(child)) put(parent, ...child)
      else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return parent
  }

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue
      if (typeof value === 'function') node.addEventListener(key.slice(2), value)
      else if (key === 'class') node.className = String(value)
      else node.setAttribute(key, value === true ? '' : String(value))
    }
    return put(node, ...children)
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  const CAPTURE = new URLSearchParams(location.search).has('capture')
  let toasts = null
  function toast(text, action) {
    if (!toasts?.isConnected) {
      toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })
      document.body.append(toasts)
    }
    const note = h('div', { class: 'toast' }, h('span', {}, text))
    const dismiss = () => note.remove()
    if (action)
      note.append(
        h(
          'button',
          {
            type: 'button',
            class: 'toast-action',
            onclick: () => {
              dismiss()
              action.run()
            },
          },
          action.label
        )
      )
    toasts.append(note)
    if (!CAPTURE) setTimeout(dismiss, action ? 6000 : 3200)
  }

  // ---------------------------------------------------------------- icons, as in shell/icons.ts (new ones marked)
  const path = (d) => ['path', { d }]
  const rect = (x, y, width, height, rx = 2) => [
    'rect',
    { x: String(x), y: String(y), width: String(width), height: String(height), rx: String(rx) },
  ]
  const circle = (cx, cy, r) => ['circle', { cx: String(cx), cy: String(cy), r: String(r) }]
  const ICONS = {
    artifact: [rect(2, 4, 20, 16), path('M2 8h20'), path('M6 4v4'), path('M10 4v4')],
    comment: [path('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')],
    left: [path('m15 18-6-6 6-6')],
    right: [path('m9 18 6-6-6-6')],
    down: [path('m6 9 6 6 6-6')],
    up: [path('m18 15-6-6-6 6')],
    check: [path('M20 6 9 17l-5-5')],
    close: [path('M18 6 6 18'), path('m6 6 12 12')],
    more: [circle(12, 12, 1), circle(19, 12, 1), circle(5, 12, 1)],
    link: [
      path('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'),
      path('M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'),
    ],
    desktop: [rect(2, 3, 20, 14), path('M8 21h8'), path('M12 17v4')],
    tablet: [rect(4, 2, 16, 20), path('M12 18h.01')],
    phone: [rect(5, 2, 14, 20), path('M12 18h.01')],
    panel: [rect(3, 3, 18, 18), path('M15 3v18')],
    reload: [
      path('M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'),
      path('M21 3v5h-5'),
      path('M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'),
      path('M8 16H3v5'),
    ],
    full: [
      path('M8 3H5a2 2 0 0 0-2 2v3'),
      path('M21 8V5a2 2 0 0 0-2-2h-3'),
      path('M3 16v3a2 2 0 0 0 2 2h3'),
      path('M16 21h3a2 2 0 0 0 2-2v-3'),
    ],
    send: [path('m5 12 7-7 7 7'), path('M12 19V5')],
    copy: [rect(8, 8, 14, 14), path('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2')],
    leave: [path('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), path('m16 17 5-5-5-5'), path('M21 12H9')],
    user: [path('M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'), circle(12, 7, 4)],
    // New: the design tools.
    screens: [rect(3, 3, 8, 8, 1.5), rect(13, 3, 8, 8, 1.5), rect(3, 13, 8, 8, 1.5), rect(13, 13, 8, 8, 1.5)],
    inspect: [
      path(
        'M12.03 12.68a.5.5 0 0 1 .65-.65l9 3.5a.5.5 0 0 1-.03.94l-3.45 1.07a1 1 0 0 0-.66.66l-1.07 3.44a.5.5 0 0 1-.94.03z'
      ),
      path('M5 3a2 2 0 0 0-2 2'),
      path('M19 3a2 2 0 0 1 2 2'),
      path('M5 21a2 2 0 0 1-2-2'),
      path('M9 3h1'),
      path('M9 21h2'),
      path('M14 3h1'),
      path('M3 9v1'),
      path('M21 9v2'),
      path('M3 14v1'),
    ],
    tokens: [
      path(
        'M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z'
      ),
      circle(13.5, 6.5, 0.5),
      circle(17.5, 10.5, 0.5),
      circle(6.5, 12.5, 0.5),
      circle(8.5, 7.5, 0.5),
    ],
    component: [
      path(
        'M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41L13.7 2.71a2.41 2.41 0 0 0-3.41 0z'
      ),
    ],
    main: [
      path(
        'M15.54 11.29a1 1 0 0 0 0 1.42l2.37 2.37a1 1 0 0 0 1.42 0l2.37-2.37a1 1 0 0 0 0-1.42l-2.37-2.37a1 1 0 0 0-1.42 0z'
      ),
      path(
        'M2.3 11.29a1 1 0 0 0 0 1.42l2.37 2.37a1 1 0 0 0 1.42 0l2.37-2.37a1 1 0 0 0 0-1.42L6.09 8.92a1 1 0 0 0-1.42 0z'
      ),
      path(
        'M8.92 17.91a1 1 0 0 0 0 1.42l2.37 2.37a1 1 0 0 0 1.42 0l2.37-2.37a1 1 0 0 0 0-1.42l-2.37-2.37a1 1 0 0 0-1.42 0z'
      ),
      path(
        'M8.92 4.67a1 1 0 0 0 0 1.42l2.37 2.37a1 1 0 0 0 1.42 0l2.37-2.37a1 1 0 0 0 0-1.42L12.71 2.3a1 1 0 0 0-1.42 0z'
      ),
    ],
    element: [
      path('M5 3a2 2 0 0 0-2 2'),
      path('M19 3a2 2 0 0 1 2 2'),
      path('M21 19a2 2 0 0 1-2 2'),
      path('M5 21a2 2 0 0 1-2-2'),
      path('M9 3h1'),
      path('M9 21h1'),
      path('M14 3h1'),
      path('M14 21h1'),
      path('M3 9v1'),
      path('M21 9v1'),
      path('M3 14v1'),
      path('M21 14v1'),
    ],
    minus: [path('M5 12h14')],
    plus: [path('M5 12h14'), path('M12 5v14')],
    arrow: [path('M5 12h14'), path('m13 6 6 6-6 6')],
    eye: [
      path('M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0'),
      circle(12, 12, 3),
    ],
    reset: [path('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'), path('M3 3v5h5')],
    search: [circle(11, 11, 7), path('m20 20-3.5-3.5')],
    alert: [
      path('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'),
      path('M12 9v4'),
      path('M12 17h.01'),
    ],
  }

  const SVG = 'http://www.w3.org/2000/svg'
  function icon(name, size = 16) {
    const svg = document.createElementNS(SVG, 'svg')
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24',
      width: String(size),
      height: String(size),
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    }))
      svg.setAttribute(key, value)
    for (const [tag, attributes] of ICONS[name]) {
      const shape = document.createElementNS(SVG, tag)
      for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value)
      svg.append(shape)
    }
    return svg
  }

  // ---------------------------------------------------------------- people, as in shell/avatar.ts
  const initials = (name) =>
    name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => [...word][0].toLocaleUpperCase())
      .join('')
  function avatarTone(kind, name) {
    let hash = 0
    for (const char of `${kind}:${name}`) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
    return hash % 8
  }
  function avatar(kind, name, size = 24) {
    const face = h('span', { class: `avatar is-${kind} tone-${avatarTone(kind, name)}`, 'aria-hidden': 'true' })
    face.style.setProperty('--size', `${size}px`)
    const letters = initials(name)
    if (letters) face.textContent = letters
    else face.append(icon('user', Math.round(size * 0.56)))
    return face
  }

  // ---------------------------------------------------------------- texts: messages.js holds both catalogs
  const CATALOG = window.PROTO_MESSAGES
  const params = new URLSearchParams(location.search)
  const preferred = params.get('lang') ?? navigator.languages?.[0] ?? navigator.language ?? 'en'
  const locale = preferred.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en'
  const t = (key, vars = {}) =>
    (CATALOG[locale][key] ?? CATALOG.en[key] ?? key).replace(/\{(\w+)\}/g, (match, name) =>
      name in vars ? String(vars[name]) : match
    )
  const plural = (n, one, many, vars = {}) => (n === 1 ? t(one, vars) : t(many, { n, ...vars }))
  document.documentElement.lang = locale

  // ---------------------------------------------------------------- fixed data
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  const NOW = Date.UTC(2026, 10, 20, 15, 0)
  function relativeTime(at) {
    const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' })
    const minutes = Math.floor((NOW - at) / MIN)
    if (minutes < 1) return t('now')
    if (minutes < 60) return format.format(-minutes, 'minute')
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return format.format(-hours, 'hour')
    const days = Math.floor(hours / 24)
    return days < 7 ? format.format(-days, 'day') : format.format(-Math.floor(days / 7), 'week')
  }

  const OWNER = 'Rafa Costa'
  const GUEST = 'Marina Souza'
  const ARTIFACTS = {
    crumb: {
      title: 'Crumb orders',
      dir: 'sample/',
      entry: 'index.html',
      versions: [
        { number: 1, summary: '', createdAt: NOW - 3 * DAY },
        { number: 2, summary: 'Empty and offline states', createdAt: NOW - DAY },
        { number: 3, summary: 'Tighter order rows and a mobile order screen', createdAt: NOW - 2 * HOUR },
      ],
    },
    plain: {
      title: 'Autumn menu',
      dir: 'plain/',
      entry: 'index.html',
      versions: [{ number: 1, summary: '', createdAt: NOW - 5 * HOUR }],
    },
  }
  const SIZES = { desktop: [1440, 900], tablet: [834, 1112], mobile: [390, 844] }
  const sizeOf = (viewport) => (typeof viewport === 'string' ? SIZES[viewport] : [viewport.width, viewport.height])
  const viewportFor = (screen) => {
    const [width] = sizeOf(screen.viewport)
    return width <= 480 ? 'phone' : width <= 900 ? 'tablet' : 'desktop'
  }
  const GROUPS = ['color', 'font', 'text', 'space', 'radius', 'shadow', 'duration', 'ease', 'other']
  const GROUP_LABEL = {
    color: 'groupColor',
    font: 'groupFont',
    text: 'groupText',
    space: 'groupSpace',
    radius: 'groupRadius',
    shadow: 'groupShadow',
    duration: 'groupDuration',
    ease: 'groupEase',
    other: 'groupOther',
  }

  // ---------------------------------------------------------------- the contract
  const SCREEN_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
  const BAD_VALUE = /[;{}<\\]|url\(|image-set\(|src\(|\/\*|\*\/|!important/i

  /** The manifest when it follows maestrly-prototype/v1; anything else turns the design tools but Inspect off. */
  function readManifest(raw) {
    if (!raw || raw.schema !== 'maestrly-prototype/v1') return null
    if (!Array.isArray(raw.tokens) || raw.tokens.length < 1 || raw.tokens.length > 8) return null
    if (!Array.isArray(raw.screens) || raw.screens.length < 1 || raw.screens.length > 50) return null
    const ids = new Set()
    for (const screen of raw.screens) {
      if (!SCREEN_ID.test(screen.id ?? '') || ids.has(screen.id)) return null
      if (typeof screen.name !== 'string' || screen.name.length > 80) return null
      if (typeof screen.path !== 'string' || screen.path.length > 300 || /^[a-z]+:|^\/|\.\./i.test(screen.path))
        return null
      const size = sizeOf(screen.viewport ?? '')
      if (!size || size.some((n) => !(n >= 320 && n <= 2560))) return null
      ids.add(screen.id)
    }
    return raw
  }

  const groupOf = (name) => {
    const prefix = name.slice(2).split('-')[0]
    return GROUPS.includes(prefix) && prefix !== 'other' ? prefix : 'other'
  }
  const kindOf = (value) =>
    /^#[0-9a-f]{3,8}$/i.test(value) || /^(rgb|hsl)a?\(/i.test(value)
      ? 'color'
      : /^-?\d*\.?\d+(px|rem|em|%|vh|vw|ms|s)$/.test(value)
        ? 'length'
        : /^-?\d*\.?\d+$/.test(value)
          ? 'number'
          : 'text'

  // Tokens live on :root and, optionally, in theme blocks. A token in a theme is keyed `theme:--name`.
  const THEME_ATTR = /^(?::root)?\[data-theme=(["'])([a-z0-9-]{1,32})\1\]$/
  const THEME_CLASS = /^(?::root)?\.theme-([a-z0-9-]{1,32})$/
  const keyOf = (theme, name) => (theme ? `${theme}:${name}` : name)
  const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1)

  /** The theme a block's selector (and media condition) declares, or null when the block is not one. */
  function themeOf(selector, media) {
    if (media) {
      const scheme = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/.exec(media)
      return scheme && selector === ':root'
        ? { id: `system-${scheme[1]}`, name: scheme[1], system: true, block: ':root', media: media.replace(/\s+/g, '') }
        : null
    }
    if (selector === ':root') return { id: '', block: ':root', media: null }
    const attr = THEME_ATTR.exec(selector)
    if (attr)
      return { id: attr[2], name: attr[2], force: { kind: 'attr', value: attr[2] }, block: selector, media: null }
    const cls = THEME_CLASS.exec(selector)
    if (cls) return { id: cls[1], name: cls[1], force: { kind: 'class', value: cls[1] }, block: selector, media: null }
    return null
  }

  function parseTokens(css) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const blocks = /@media\s*([^{]+?)\s*\{\s*([^{}]+?)\s*\{([^}]*)\}\s*\}|([^{}@]+?)\s*\{([^}]*)\}/g
    const themes = new Map()
    const tokens = []
    for (const match of text.matchAll(blocks)) {
      const theme = match[1] ? themeOf(match[2].trim(), match[1]) : themeOf(match[4].trim(), null)
      if (!theme) continue
      if (!themes.has(theme.id)) themes.set(theme.id, theme)
      for (const declaration of (match[3] ?? match[5]).split(';')) {
        const found = /^\s*(--[a-zA-Z0-9][a-zA-Z0-9_-]{0,62})\s*:\s*([\s\S]+?)\s*$/.exec(declaration)
        if (!found || found[2].length > 200 || BAD_VALUE.test(found[2])) continue
        const [, name, value] = found
        tokens.push({
          key: keyOf(theme.id, name),
          name,
          theme: theme.id,
          value,
          group: groupOf(name),
          kind: kindOf(value),
        })
      }
    }
    // The default block comes first, whatever its place in the file.
    const order = [...themes.values()].sort((a, b) => (a.id === '' ? -1 : b.id === '' ? 1 : 0))
    return { list: tokens.slice(0, 200), themes: order }
  }

  function validValue(token, value) {
    if (!value || value.length > 200 || BAD_VALUE.test(value)) return false
    if (token.kind === 'color') return CSS.supports('color', value)
    if (token.kind === 'length')
      return /m?s$/.test(value) && !/px$/.test(value)
        ? CSS.supports('transition-duration', value)
        : CSS.supports('width', value)
    if (token.kind === 'number') return /^-?\d*\.?\d+$/.test(value)
    return true
  }

  const paint = document.createElement('canvas').getContext('2d')
  /** #RRGGBB for a CSS color, or null when it has transparency the color picker cannot show. */
  function toHex(value) {
    if (!CSS.supports('color', value)) return null
    paint.fillStyle = '#000000'
    paint.fillStyle = value
    const out = paint.fillStyle
    return /^#[0-9a-f]{6}$/i.test(out) ? out.toUpperCase() : null
  }
  const showValue = (value, kind) => (kind === 'color' ? (toHex(value) ?? value) : value)

  // ---------------------------------------------------------------- frames
  // Locally the frames load by URL, as in the viewer. Inside a published artifact, where the page may not frame
  // other documents, the same files are loaded as srcdoc.
  const SANDBOXED = self.origin === 'null'
  // There, the frame may not take focus before the person interacts with it (the browser logs a permissions error),
  // so focus that a state moves by itself waits for that. The shell, a top-level page, focuses as usual.
  const focusOn = (el, options) => {
    if (!SANDBOXED || navigator.userActivation?.hasBeenActive) el?.focus(options)
  }
  let probeSource = ''
  const registry = new Map()
  let frameCount = 0

  function splitPath(value) {
    const hashAt = value.indexOf('#')
    const hash = hashAt >= 0 ? value.slice(hashAt) : ''
    const rest = hashAt >= 0 ? value.slice(0, hashAt) : value
    const queryAt = rest.indexOf('?')
    return {
      file: queryAt >= 0 ? rest.slice(0, queryAt) : rest,
      query: queryAt >= 0 ? rest.slice(queryAt + 1) : '',
      hash,
    }
  }

  function track(info) {
    if (info.frame.contentWindow) registry.set(info.frame.contentWindow, info)
  }

  const cache = new Map()
  async function srcdocOf(target) {
    const dir = target.file.slice(0, target.file.lastIndexOf('/') + 1)
    if (!cache.has(target.file)) {
      const response = await fetch(target.file)
      if (!response.ok) throw new Error(String(response.status))
      cache.set(target.file, await response.text())
    }
    const html = cache
      .get(target.file)
      .replace(/<script[^>]*_maestrly\/bridge\.js[^>]*><\/script>/gi, '')
      .replace(
        /(<(?:link|script|img)\b[^>]*?\s(?:href|src)=")(?![a-z][a-z0-9+.-]*:|\/|#)([^"]*)"/gi,
        (match, before, url) => `${before}${dir}${url}"`
      )
      .replace(/<link\b(?![^>]*crossorigin)/gi, '<link crossorigin="anonymous"')
    // The route goes in before the page's scripts read it. A srcdoc resolves relative URLs against this page, so the
    // hash must be absolute, and replacing (not assigning) keeps it out of the tab's history.
    const route = target.hash
      ? `<script>location.replace(${JSON.stringify(`about:srcdoc${target.hash}`)})</script>`
      : ''
    const boot = `${route}<script>${probeSource.replace(/<\/script/gi, '<\\/script')}</script>`
    return html.replace(/<head[^>]*>/i, (head) => head + boot)
  }

  function load(info, target) {
    info.ready = false
    info.target = target
    clearTimeout(info.timer)
    info.timer = setTimeout(() => {
      if (!info.ready) info.onFail?.()
    }, 10_000)
    if (!SANDBOXED) {
      const query = [target.query, `frame=${++frameCount}`].filter(Boolean).join('&')
      info.frame.onload = () => {
        try {
          const doc = info.frame.contentDocument
          if (!doc || doc.defaultView.__maestrlyProbe) return
          const script = doc.createElement('script')
          script.textContent = probeSource
          doc.head.append(script)
        } catch {
          info.onFail?.()
        }
      }
      info.frame.src = `${target.file}?${query}${target.hash}`
    } else {
      srcdocOf(target).then(
        (html) => {
          info.frame.srcdoc = html
        },
        () => info.onFail?.()
      )
    }
  }

  const send = (info, message) => info?.frame.contentWindow?.postMessage({ source: 'maestrly-proto', ...message }, '*')
  const next = (info, type, ms = 10_000) =>
    new Promise((resolve, reject) => {
      const waiter = { type, resolve }
      info.waiters.push(waiter)
      setTimeout(() => {
        const at = info.waiters.indexOf(waiter)
        if (at < 0) return
        info.waiters.splice(at, 1)
        reject(new Error(`no ${type}`))
      }, ms)
    })

  window.addEventListener('message', (event) => {
    const info = registry.get(event.source)
    const message = event.data
    if (!info || !message || message.source !== 'maestrly-probe') return
    onFrameMessage(info, message)
    for (const waiter of [...info.waiters])
      if (waiter.type === message.type) {
        info.waiters.splice(info.waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      }
  })

  // ---------------------------------------------------------------- state
  const S = {
    artifact: ARTIFACTS.crumb,
    manifest: null,
    identity: 'owner',
    canComment: true,
    version: 3,
    current: 3,
    view: 'page',
    viewport: 'desktop',
    page: { kind: 'screen', id: 'dashboard' },
    mode: null,
    panel: null,
    listOpen: false,
    full: false,
    hover: null,
    selection: null,
    rects: null,
    matchName: null,
    usage: null,
    usageAt: null,
    inventories: {},
    tokens: { status: 'idle', list: [], themes: [] },
    theme: '',
    saved: new Map(),
    changes: new Map(),
    trayOpen: true,
    filter: '',
    focus: null,
    forced: {},
    dialog: null,
    card: null,
    suggestion: null,
    suggestNote: '',
    previewSuggestion: false,
    freezeCount: null,
    freezeSave: null,
    backPath: null,
  }
  const isOwner = () => S.identity === 'owner'
  const contract = () => Boolean(S.manifest) && S.artifact === ARTIFACTS.crumb
  const tokensFile = () => S.manifest?.tokens[0] ?? 'tokens.css'
  const screenById = (id) => S.manifest?.screens.find((screen) => screen.id === id)
  const currentScreen = () => (S.page.kind === 'screen' ? screenById(S.page.id) : null)
  const tokenByKey = (key) => S.tokens.list.find((token) => token.key === key)
  const themeById = (id) => S.tokens.themes.find((theme) => theme.id === id)
  const themeLabel = (theme) =>
    !theme?.id
      ? t('themeDefault')
      : theme.system
        ? t('themeSystem', { name: capital(theme.name) })
        : capital(theme.name)
  const themeName = (id) => themeLabel(themeById(id) ?? { id, name: id })
  const baseValue = (key) => S.saved.get(key) ?? tokenByKey(key)?.value ?? ''
  const splitKey = (key) => {
    const at = key.indexOf(':--')
    return at < 0 ? { theme: '', name: key } : { theme: key.slice(0, at), name: key.slice(at + 1) }
  }
  const describeChange = (key, from, to) => ({
    key,
    ...splitKey(key),
    from,
    to,
    kind: tokenByKey(key)?.kind ?? kindOf(to),
  })
  const changeList = () => [...S.changes].map(([key, value]) => describeChange(key, baseValue(key), value))
  /** The name a change goes by in lists and summaries: the token, and its theme when it is not the default one. */
  const changeName = (change) => (change.theme ? `${change.name} (${themeName(change.theme)})` : change.name)
  /** The key a token resolves to in the theme on screen: the theme's own declaration, or the default one. */
  const shownKey = (name) => (S.theme && tokenByKey(keyOf(S.theme, name)) ? keyOf(S.theme, name) : name)

  /** What every open frame previews: values saved in this session, then the suggestion or the edits. */
  function previewValues() {
    const values = Object.fromEntries(S.saved)
    if (S.previewSuggestion && S.suggestion) for (const change of S.suggestion.changes) values[change.key] = change.to
    for (const [key, value] of S.changes) values[key] = value
    return values
  }
  /**
   * The preview a frame receives: each value with the block that declares it, so a theme keeps overriding the
   * default as in the file, and the theme on screen, which the bridge sets on the page's root element.
   */
  function previewMessage() {
    const values = []
    for (const [key, value] of Object.entries(previewValues())) {
      const { theme, name } = splitKey(key)
      const block = theme ? themeById(theme) : { block: ':root', media: null }
      if (block) values.push({ block: block.block, media: block.media, name, value })
    }
    return { type: 'tokens', theme: themeById(S.theme)?.force ?? null, values }
  }
  function applyPreview() {
    const message = previewMessage()
    for (const info of registry.values()) if (info.ready) send(info, message)
  }

  // ---------------------------------------------------------------- the shell
  let bar
  let notice
  let stage
  let device
  let frame
  let overlay
  let failure
  let float
  let list
  let side
  let workspace
  let main
  let counters
  let screens = null

  function renderViewer() {
    document.title = S.artifact.title
    frame = h('iframe', { class: 'content', referrerpolicy: 'no-referrer', title: S.artifact.title })
    overlay = h('div', { class: 'overlay' })
    failure = h(
      'div',
      { class: 'frame-failure', role: 'alert', hidden: true },
      h('p', {}, t('pageFailed')),
      h('button', { type: 'button', class: 'button', onclick: () => showPage(S.page) }, t('retry'))
    )
    device = h('div', { class: 'device' }, frame, overlay, failure)
    float = h('div', { class: 'float' })
    stage = h('main', { class: 'stage', 'data-viewport': S.viewport }, device, float)
    list = h('aside', { class: 'list', 'aria-label': t('listTitle'), hidden: true })
    side = h('aside', { class: 'side', hidden: true })
    notice = h('div', { class: 'notice', role: 'status', hidden: true })
    workspace = h('div', { class: 'workspace' }, stage, list, side)
    bar = createBar()
    counters = h('div', { 'aria-hidden': 'true', style: 'position:fixed;left:-20000px;top:0;visibility:hidden' })
    document.getElementById('app').replaceChildren(bar.root, notice, workspace)
    document.body.append(counters)

    main = { frame, role: 'main', waiters: [] }
    track(main)
    main.onReady = () => {
      failure.hidden = true
      send(main, { type: 'inspect', on: S.mode === 'inspect' })
      applyPreview()
      if (S.matchName) send(main, { type: 'matches', name: S.matchName })
    }
    main.onFail = () => {
      failure.hidden = false
    }

    stage.addEventListener('pointerdown', (event) => {
      if (event.target === stage || event.target === float) escapeCard()
    })
    new ResizeObserver(() => {
      send(main, { type: 'measure' })
      positionCard()
      screens?.resize()
    }).observe(stage)
    render()
  }

  function render() {
    stage.dataset.viewport = S.viewport
    stage.classList.toggle('is-inspecting', S.mode === 'inspect' && S.view === 'page')
    stage.classList.toggle('is-commenting', S.mode === 'comment' && S.view === 'page')
    device.hidden = S.view === 'screens'
    document.body.classList.toggle('is-full', S.full)
    if (S.view === 'screens' && !screens) screens = createScreens()
    if (S.view !== 'screens' && screens) {
      screens.destroy()
      screens = null
    }
    bar.update()
    renderNotice()
    renderOverlay()
    renderFloat()
    renderSide()
    renderList()
    renderCard()
    renderDialog()
  }

  const versionsOf = () => S.artifact.versions

  function renderNotice() {
    const behind = S.version !== S.current
    notice.hidden = !behind
    if (!behind) return
    const summary = versionsOf().find((item) => item.number === S.current)?.summary ?? ''
    notice.replaceChildren(
      h('span', {}, t('noticeVersionSummary', { n: S.version, total: S.current, summary })),
      h('button', { type: 'button', class: 'notice-action', onclick: () => setVersion(S.current) }, t('noticeAction'))
    )
  }

  function setVersion(number) {
    if (number === S.version || number < 1 || number > S.current) return
    S.version = number
    S.selection = null
    S.hover = null
    showPage(S.page)
    render()
  }

  // ---------------------------------------------------------------- popovers, as in shell/popover.ts
  let current = null
  function closePopover(restoreFocus = true) {
    if (!current) return
    const { el, anchor } = current
    current = null
    el.remove()
    anchor.setAttribute('aria-expanded', 'false')
    if (restoreFocus && anchor.isConnected) anchor.focus()
  }
  function togglePopover(anchor, className, build, align = 'end') {
    if (current?.anchor === anchor) return closePopover()
    closePopover(false)
    const el = h('div', { class: `popover ${className}` })
    const focus = build(el)
    document.body.append(el)
    anchor.setAttribute('aria-expanded', 'true')
    const box = anchor.getBoundingClientRect()
    const width = el.offsetWidth
    const left = align === 'center' ? box.left + box.width / 2 - width / 2 : box.right - width
    el.style.left = `${Math.min(Math.max(left, 8), Math.max(8, innerWidth - width - 8))}px`
    el.style.top = `${box.bottom + 8}px`
    el.style.maxHeight = `${Math.max(160, innerHeight - box.bottom - 20)}px`
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closePopover()
    })
    current = { el, anchor }
    ;(focus ?? el.querySelector('button, input, [tabindex]'))?.focus()
  }
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (current && !current.el.contains(event.target) && !current.anchor.contains(event.target)) closePopover(false)
    },
    true
  )

  // ---------------------------------------------------------------- the top bar, as in shell/bar.ts, plus Design
  const selfFace = (size) => (isOwner() ? avatar('owner', OWNER, size) : avatar('invited', GUEST, size))

  function createBar() {
    const title = h('h1', { class: 'doc-title', title: S.artifact.title }, S.artifact.title)
    const meta = h('p', { class: 'doc-meta' })
    const doc = h(
      'div',
      { class: 'doc' },
      h('span', { class: 'doc-mark' }, icon('artifact', 15)),
      h('div', { class: 'doc-text' }, title, meta)
    )

    const designButton = (kind, name, label, onclick) =>
      h(
        'button',
        { type: 'button', class: `button design-button ${kind}-button`, 'aria-pressed': 'false', onclick },
        icon(name, 15),
        h('span', { class: 'button-label' }, label)
      )
    const screensButton = designButton('screens', 'screens', t('screens'), () => toggleScreens())
    const inspectButton = designButton('inspect', 'inspect', t('inspect'), () => toggleInspect())
    const pending = h('span', { class: 'count is-pending', hidden: true })
    const tokensButton = designButton('tokens', 'tokens', t('tokens'), () => togglePanel('tokens'))
    tokensButton.append(pending)
    const design = h(
      'div',
      { class: 'design', role: 'group', 'aria-label': t('designGroup') },
      contract() && screensButton,
      inspectButton,
      contract() && tokensButton
    )

    const iconButton = (name, label, extra = '') =>
      h(
        'button',
        { type: 'button', class: `button icon${extra ? ` ${extra}` : ''}`, 'aria-label': label, title: label },
        icon(name, 16)
      )
    const previous = iconButton('left', t('versionPrevious'), 'version-step')
    const following = iconButton('right', t('versionNext'), 'version-step')
    previous.addEventListener('click', () => setVersion(S.version - 1))
    following.addEventListener('click', () => setVersion(S.version + 1))
    const versionButton = h('button', {
      type: 'button',
      class: 'version-current',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
    })
    versionButton.addEventListener('click', () =>
      togglePopover(
        versionButton,
        'listbox-popover',
        (el) => {
          const options = h('ul', { class: 'options', role: 'listbox', tabindex: '0', 'aria-label': t('versionList') })
          for (const item of [...versionsOf()].sort((a, b) => b.number - a.number)) {
            const open = item.number === 3 ? openThreads().length : 0
            options.append(
              h(
                'li',
                {
                  class: `option${item.number === S.version ? ' is-active' : ''}`,
                  role: 'option',
                  'aria-selected': String(item.number === S.version),
                  onclick: () => {
                    closePopover()
                    setVersion(item.number)
                  },
                },
                h('span', { class: 'option-badge' }, `v${item.number}`),
                h(
                  'span',
                  { class: 'option-text' },
                  h(
                    'span',
                    { class: 'option-label' },
                    item.summary || (item.number === 1 ? t('versionFirst') : t('versionNoSummary')),
                    item.number === S.current && h('em', { class: 'option-tag' }, t('versionCurrent'))
                  ),
                  h(
                    'span',
                    { class: 'option-meta' },
                    [relativeTime(item.createdAt), open ? plural(open, 'versionOpenOne', 'versionOpenMany') : '']
                      .filter(Boolean)
                      .join(' · ')
                  )
                ),
                item.number === S.version && icon('check', 15)
              )
            )
          }
          el.append(options)
          return options
        },
        'center'
      )
    )
    const version = h(
      'div',
      { class: 'version', role: 'group', 'aria-label': t('versionGroup') },
      previous,
      versionButton,
      following
    )

    const VIEWPORTS = ['desktop', 'tablet', 'phone']
    const widths = VIEWPORTS.map((viewport) => {
      const label = t(viewport === 'desktop' ? 'widthDesktop' : viewport === 'tablet' ? 'widthTablet' : 'widthPhone')
      return h(
        'button',
        {
          type: 'button',
          class: 'segment-item',
          'aria-label': label,
          title: label,
          'aria-pressed': 'false',
          onclick: () => {
            S.viewport = viewport
            render()
          },
        },
        icon(viewport, 15)
      )
    })
    const segment = h('div', { class: 'segment', role: 'group', 'aria-label': t('widthGroup') }, widths)

    const commentButton = h(
      'button',
      { type: 'button', class: 'button comment-button', 'aria-pressed': 'false', onclick: () => toggleComment() },
      icon('comment', 15),
      h('span', { class: 'button-label' }, t('commentMode')),
      h('kbd', {}, 'C')
    )
    const count = h('span', { class: 'count' })
    const listButton = h(
      'button',
      { type: 'button', class: 'button list-button', 'aria-pressed': 'false', onclick: () => setList(!S.listOpen) },
      icon('panel', 15),
      count
    )
    const comments = h('div', { class: 'joined' }, commentButton, listButton)

    const share =
      isOwner() &&
      h(
        'button',
        { type: 'button', class: 'button share-button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
        icon('link', 15),
        h('span', { class: 'button-label' }, t('share'))
      )
    if (share)
      share.addEventListener('click', () =>
        togglePopover(share, 'share', (el) => {
          el.setAttribute('role', 'dialog')
          el.setAttribute('aria-label', t('share'))
          const link = 'https://pages.example.com/a/AuPLA9YC7D_iJ5golJh4fQ'
          const copy = h(
            'button',
            {
              type: 'button',
              class: 'button primary',
              onclick: async () => {
                await copyText(link)
                closePopover()
                toast(t('shareCopied'))
              },
            },
            icon('copy', 14),
            t('shareCopy')
          )
          put(
            el,
            h('p', { class: 'popover-title' }, t('sharePeople')),
            h('p', { class: 'popover-text' }, t('sharePeopleText')),
            h(
              'div',
              { class: 'field-row' },
              h('input', { class: 'input mono', readonly: true, value: link, 'aria-label': t('shareLinkLabel') }),
              copy
            ),
            h('p', { class: 'popover-foot' }, t('shareManage'))
          )
          return copy
        })
      )

    const more = iconButton('more', t('more'))
    more.setAttribute('aria-haspopup', 'menu')
    more.setAttribute('aria-expanded', 'false')
    more.addEventListener('click', () =>
      togglePopover(more, 'actions', (el) => {
        el.setAttribute('role', 'menu')
        const item = (name, label, run, key) =>
          h(
            'button',
            {
              type: 'button',
              class: 'menu-item',
              role: 'menuitem',
              onclick: () => {
                closePopover()
                run()
              },
            },
            icon(name, 15),
            h('span', {}, label),
            key && h('kbd', {}, key)
          )
        put(
          el,
          item('reload', t('reloadPage'), () => showPage(S.page)),
          item('full', t('fullScreen'), () => setFull(true), 'F'),
          versionsOf().length > 1 && item('copy', t('copyVersionLink'), () => undefined)
        )
        return undefined
      })
    )

    const identity = h('button', {
      type: 'button',
      class: 'identity',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
    })
    identity.addEventListener('click', () =>
      togglePopover(identity, 'who', (el) => {
        el.setAttribute('role', 'dialog')
        put(
          el,
          h(
            'div',
            { class: 'who-head' },
            selfFace(36),
            h(
              'div',
              {},
              h('b', {}, isOwner() ? OWNER : GUEST),
              h('p', {}, isOwner() ? t('whoOwner') : t('whoInvited', { owner: OWNER }))
            )
          ),
          !isOwner() && h('p', { class: 'popover-text' }, t('stored')),
          h('button', { type: 'button', class: 'menu-item' }, icon('leave', 15), h('span', {}, t('leaveDevice')))
        )
        return undefined
      })
    )

    const root = h(
      'header',
      { class: 'bar' },
      h('div', { class: 'bar-start' }, doc, design),
      versionsOf().length > 1 && version,
      h('div', { class: 'tools' }, segment, comments, share, more, identity)
    )

    return {
      root,
      update() {
        const total = S.current
        const latest = versionsOf().find((item) => item.number === total)
        const when = relativeTime(latest?.createdAt ?? NOW)
        meta.textContent = isOwner() ? t('metaOwner', { when }) : t('metaFrom', { owner: OWNER, when })
        versionButton.replaceChildren(
          h('span', { class: 'version-number' }, `v${S.version}`),
          h('span', { class: 'version-tag' }, S.version === total ? t('versionCurrent') : t('versionOf', { total })),
          icon('down', 14)
        )
        versionButton.setAttribute('aria-label', t('versionTrigger', { n: S.version, total }))
        previous.disabled = S.version <= 1
        following.disabled = S.version >= total

        const screensView = S.view === 'screens'
        screensButton.setAttribute('aria-pressed', String(screensView))
        screensButton.title = t('screensTitle')
        inspectButton.setAttribute('aria-pressed', String(S.mode === 'inspect' && !screensView))
        inspectButton.disabled = screensView
        inspectButton.title = screensView ? t('inspectOffScreens') : t('inspectTitle')
        tokensButton.setAttribute('aria-pressed', String(S.panel === 'tokens'))
        const changes = S.changes.size
        pending.hidden = changes === 0
        pending.textContent = String(changes)
        tokensButton.title = changes ? plural(changes, 'tokensPendingOne', 'tokensPendingMany') : t('tokensTitle')

        segment.hidden = screensView
        for (const [index, button] of widths.entries())
          button.setAttribute('aria-pressed', String(VIEWPORTS[index] === S.viewport))
        commentButton.setAttribute('aria-pressed', String(S.mode === 'comment' && !screensView))
        commentButton.disabled = !S.canComment || screensView
        commentButton.title = !S.canComment
          ? t('commentsOff')
          : screensView
            ? t('commentOffScreens')
            : t('commentModeTitle')
        listButton.setAttribute('aria-pressed', String(S.listOpen))
        const open = S.version === 3 ? openThreads().length : 0
        count.textContent = String(open)
        const listLabel = t(S.listOpen ? 'listHide' : 'listShow', { n: open })
        listButton.setAttribute('aria-label', listLabel)
        listButton.title = listLabel
        identity.replaceChildren(selfFace(28))
        const label = isOwner()
          ? t('identityOwner', { name: OWNER })
          : t('identityInvited', { name: GUEST, owner: OWNER })
        identity.setAttribute('aria-label', label)
        identity.title = label
      },
    }
  }

  // ---------------------------------------------------------------- the page in the frame
  function targetOf(page) {
    const dir = S.artifact.dir
    if (page.kind === 'components') return { file: `${dir}${S.manifest.components}`, query: '', hash: '' }
    if (page.kind === 'screen' && contract()) {
      const parts = splitPath(screenById(page.id).path)
      return { ...parts, file: `${dir}${parts.file}` }
    }
    return { file: `${dir}${S.artifact.entry}`, query: '', hash: '' }
  }

  function showPage(page) {
    S.page = page
    S.hover = null
    S.rects = null
    if (S.selection && S.selection.page !== page) S.selection = null
    failure.hidden = true
    const ready = next(main, 'ready', 15_000)
    load(main, targetOf(page))
    renderOverlay()
    renderFloat()
    return ready
  }

  function onFrameMessage(info, message) {
    if (message.type === 'ready') {
      info.ready = true
      clearTimeout(info.timer)
      info.onReady?.()
      return
    }
    if (message.type === 'key') return onKey(message.key)
    if (info.role !== 'main') return
    if (message.type === 'hover') {
      S.hover = message.target
      renderOverlay()
    } else if (message.type === 'pick') onPick(message.target, message.quiet)
    else if (message.type === 'layout') {
      S.rects = message
      renderOverlay()
    } else if (message.type === 'inventory') S.inventories.current = message
  }

  // ---------------------------------------------------------------- Inspect
  function toggleInspect(on = S.mode !== 'inspect') {
    if (S.view === 'screens') return
    if (on) S.mode = 'inspect'
    else {
      S.mode = null
      S.selection = null
      S.hover = null
      S.matchName = null
      if (S.panel === 'inspect') S.panel = null
      send(main, { type: 'matches', name: null })
    }
    send(main, { type: 'inspect', on })
    render()
  }

  function clearSelection() {
    S.selection = null
    S.matchName = null
    S.usageAt = null
    if (S.panel === 'inspect') S.panel = null
    send(main, { type: 'select', path: null })
    send(main, { type: 'matches', name: null })
    render()
  }

  let expectMain = null
  function onPick(target, quiet) {
    if (!target) {
      if (expectMain) {
        toast(t('inspectMainMissing', { name: expectMain, file: S.manifest.components }))
        expectMain = null
      }
      if (!quiet) {
        S.selection = null
        if (S.panel === 'inspect') S.panel = null
        render()
      }
      return
    }
    expectMain = null
    const sameMain = S.selection?.main && target.main && S.selection.name === target.name
    S.selection = { ...target, page: S.page }
    S.hover = null
    if (!quiet) {
      S.panel = 'inspect'
      S.listOpen = false
      if (!sameMain) S.usageAt = null
      if (!target.main) S.matchName = null
    }
    if (target.main && S.usage?.name !== target.name) void countUses(target.name)
    render()
  }

  const elementLabel = (target) => `${target.tag}${target.classes?.[0] ? `.${target.classes[0]}` : ''}`

  function renderOverlay() {
    for (const el of overlay.querySelectorAll('.inspect-box, .inspect-tag')) el.remove()
    if (S.view !== 'page' || !S.rects) return
    const { width, height } = S.rects
    const box = (at, kind) => {
      const el = h('div', { class: `inspect-box ${kind}` })
      el.style.setProperty('--x', `${at.x}px`)
      el.style.setProperty('--y', `${at.y}px`)
      el.style.setProperty('--w', `${at.width}px`)
      el.style.setProperty('--h', `${at.height}px`)
      overlay.append(el)
    }
    const tag = (target, at) => {
      const el = h(
        'span',
        { class: `inspect-tag${target.name ? '' : ' is-element'}`, 'aria-hidden': 'true' },
        target.name && icon(target.main ? 'main' : 'component', 11),
        target.name ?? elementLabel(target),
        h('span', { class: 'inspect-tag-size' }, `${Math.round(at.width)} × ${Math.round(at.height)}`)
      )
      overlay.append(el)
      const x = Math.min(Math.max(at.x, 4), Math.max(4, width - el.offsetWidth - 4))
      let y = at.y - 24
      if (y < 4) y = at.y + at.height + 4
      if (y > height - 24) y = Math.max(4, at.y + 4)
      el.style.setProperty('--x', `${x}px`)
      el.style.setProperty('--y', `${y}px`)
    }
    for (const at of S.rects.matches ?? []) box(at, 'is-match')
    const hovering = S.mode === 'inspect' && S.hover && S.rects.hover
    if (hovering) box(S.rects.hover, 'is-hover')
    if (S.selection && S.rects.selected) {
      box(S.rects.selected, 'is-selected')
      tag(S.selection, S.rects.selected)
    }
    if (hovering) tag(S.hover, S.rects.hover)
  }

  const section = (title, count, ...children) =>
    h(
      'section',
      { class: 'side-section' },
      title &&
        h(
          'h3',
          { class: 'side-heading' },
          title,
          count !== undefined && h('span', { class: 'tab-count' }, String(count))
        ),
      children
    )

  const swatch = (value) => {
    const hex = toHex(value)
    const el = h('span', { class: `swatch${hex ? '' : ' is-clear'}`, 'aria-hidden': 'true' })
    if (hex) el.style.setProperty('--swatch', value)
    return el
  }

  const copyable = (value, withSwatch) =>
    h(
      'button',
      {
        type: 'button',
        class: 'value',
        title: t('inspectCopy', { value }),
        onclick: async () => {
          await copyText(value)
          toast(t('inspectCopied', { value }))
        },
      },
      withSwatch && swatch(value),
      h('span', { class: 'value-text' }, value)
    )

  function inspectPanel() {
    const target = S.selection
    const kind = target.name ? (target.main ? 'main' : 'component') : 'element'
    const screen = currentScreen()
    const name = target.name ?? elementLabel(target)
    const sub =
      kind === 'main'
        ? t('inspectMain', { file: S.manifest.components })
        : kind === 'component'
          ? screen
            ? t('inspectInstance', { screen: screen.name })
            : t('inspectInstancePage')
          : t('inspectElement')
    const head = h(
      'header',
      { class: 'side-head' },
      h('span', { class: `side-mark${kind === 'element' ? ' is-element' : ''}` }, icon(kind, 16)),
      h('div', { class: 'side-title' }, h('h2', { title: name }, name), h('p', { class: 'side-sub' }, sub)),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          'aria-label': t('inspectClose'),
          title: t('inspectClose'),
          onclick: () => clearSelection(),
        },
        icon('close', 15)
      )
    )

    const body = h('div', { class: 'side-body' })
    const back = S.page.kind === 'components' && S.page.back ? screenById(S.page.back.id) : null
    if (back)
      body.append(
        h(
          'button',
          { type: 'button', class: 'link side-back', onclick: () => void goBack() },
          icon('left', 14),
          t('inspectBack', { screen: back.name })
        )
      )
    if (!contract()) body.append(section(null, undefined, h('p', { class: 'side-note' }, t('inspectNoContract'))))

    const lead = []
    if (target.chain?.length)
      lead.push(
        h(
          'nav',
          { class: 'inspect-path', 'aria-label': t('inspectPath') },
          target.chain.flatMap((item) => [
            h(
              'button',
              {
                type: 'button',
                class: 'inspect-crumb',
                onclick: () => send(main, { type: 'select', path: item.path }),
              },
              icon('component', 12),
              item.name
            ),
            icon('right', 12),
          ]),
          h('span', { class: 'inspect-crumb', 'aria-current': 'true' }, icon('component', 12), name)
        )
      )
    if (kind === 'component') {
      const hasComponents = Boolean(S.manifest?.components)
      lead.push(
        h(
          'button',
          {
            type: 'button',
            class: 'button go-main',
            disabled: !hasComponents,
            title: hasComponents ? undefined : t('inspectNoComponents'),
            onclick: () => void goToMain(),
          },
          icon('main', 15),
          t('inspectGoMain'),
          icon('arrow', 14)
        )
      )
    }
    if (lead.length) body.append(section(null, undefined, lead))
    if (kind === 'main') body.append(usageSection(target.name))

    if (target.name)
      body.append(
        section(
          t('inspectProps'),
          undefined,
          target.props.length
            ? h(
                'dl',
                { class: 'props' },
                target.props.map(([key, value]) =>
                  h('div', { class: 'prop' }, h('dt', {}, key), h('dd', {}, h('span', { class: 'prop-chip' }, value)))
                )
              )
            : h('p', { class: 'side-note' }, t('inspectNoProps'))
        )
      )

    if (kind === 'main') {
      const own = target.props.map((pair) => pair.join('=')).join(' ')
      const variants = (S.inventories.current?.variants?.[target.name] ?? []).filter((props) => props !== own)
      if (variants.length)
        body.append(
          section(
            t('inspectVariants'),
            variants.length,
            h(
              'ul',
              { class: 'variants' },
              variants.map((props) => h('li', { class: 'variant' }, props))
            )
          )
        )
    }

    if (contract()) {
      let tokens = target.tokens ?? []
      let hinted = false
      if (!tokens.length && target.readable === false && target.name) {
        tokens = (S.manifest.componentTokens?.[target.name] ?? []).map((tokenName) => ({
          name: tokenName,
          property: '',
          value: previewValues()[shownKey(tokenName)] ?? baseValue(shownKey(tokenName)),
        }))
        hinted = tokens.length > 0
      }
      body.append(
        section(
          t('inspectTokens'),
          tokens.length || undefined,
          hinted && h('p', { class: 'side-note' }, t('inspectTokensHint')),
          tokens.length
            ? h(
                'ul',
                { class: 'token-uses' },
                tokens.map((token) => {
                  const tokenKind = kindOf(token.value)
                  return h(
                    'li',
                    {},
                    h(
                      'button',
                      {
                        type: 'button',
                        class: `token-use${S.changes.has(shownKey(token.name)) ? ' is-changed' : ''}`,
                        title: [
                          token.property && `${token.property}: var(${token.name})`,
                          t('inspectEditToken', { name: token.name }),
                        ]
                          .filter(Boolean)
                          .join('\n'),
                        onclick: () => openTokens(token.name),
                      },
                      h('span', { class: 'token-use-name' }, token.name),
                      h(
                        'span',
                        { class: 'token-use-value' },
                        tokenKind === 'color' && swatch(token.value),
                        h('span', { class: 'value-text' }, showValue(token.value, tokenKind))
                      )
                    )
                  )
                })
              )
            : h('p', { class: 'side-note' }, t('inspectTokensNone'))
        )
      )
    }

    const style = target.computed ?? {}
    const rows = [
      [t('styleFont'), `${style.font} · ${style.weight}`],
      [t('styleSize'), `${style.size} / ${style.lineHeight}`],
      [t('styleColor'), style.color, true],
      [t('styleBackground'), style.background, true],
      [t('styleRadius'), style.radius],
      [t('stylePadding'), style.padding],
      [t('styleBox'), `${Math.round(target.rect.width)} × ${Math.round(target.rect.height)}`],
    ]
    body.append(
      section(
        t('inspectStyles'),
        undefined,
        h(
          'dl',
          { class: 'props' },
          rows.map(([label, value, color]) =>
            h('div', { class: 'prop' }, h('dt', {}, label), h('dd', {}, copyable(value, color)))
          )
        )
      )
    )
    return [head, body]
  }

  function usageSection(name) {
    const usage = S.usage?.name === name ? S.usage : null
    const rows = S.manifest.screens.map((screen) => ({ screen, ...(usage?.rows[screen.id] ?? { status: 'queued' }) }))
    const measuring = (row) => row.status === 'queued' || row.status === 'measuring'
    const done = rows.filter((row) => !measuring(row)).length
    const total = rows.reduce((sum, row) => sum + (row.count ?? 0), 0)
    const screensWith = rows.filter((row) => row.count > 0).length
    const summary =
      done < rows.length
        ? t('inspectUsesCounting', { n: total, done, total: rows.length })
        : total === 0
          ? t('inspectUsesNone')
          : total === 1
            ? t('inspectUsesOne')
            : screensWith === 1
              ? t('inspectUsesOneScreen', { n: total })
              : t('inspectUsesMany', { n: total, screens: screensWith })
    return section(
      t('inspectUses'),
      undefined,
      h('p', { class: 'usage-total', role: 'status' }, summary),
      done < rows.length &&
        h(
          'div',
          {
            class: 'usage-meter',
            role: 'progressbar',
            'aria-label': t('inspectUses'),
            'aria-valuemin': '0',
            'aria-valuemax': String(rows.length),
            'aria-valuenow': String(done),
          },
          h('span', { style: `width:${(done / rows.length) * 100}%` })
        ),
      h(
        'ul',
        { class: 'usage' },
        rows.map((row) => {
          const viewport = viewportFor(row.screen)
          // Screens are measured in the background, two at a time; each count arrives on its own.
          const status =
            row.status === 'measuring'
              ? h(
                  'span',
                  { class: 'usage-state' },
                  h('span', { class: 'spinner', 'aria-hidden': 'true' }),
                  t('inspectUsesMeasuring')
                )
              : row.status === 'queued'
                ? h('span', { class: 'usage-state is-queued' }, t('inspectUsesQueued'))
                : h(
                    'span',
                    { class: 'usage-count' },
                    row.status === 'failed' ? t('inspectUsesFailed') : String(row.count)
                  )
          const usable = row.status === 'done' && row.count > 0
          return h(
            'li',
            {},
            h(
              'button',
              {
                type: 'button',
                class: `usage-row${row.status === 'done' && row.count === 0 ? ' is-zero' : ''}${row.status === 'failed' ? ' is-failed' : ''}${measuring(row) ? ' is-measuring' : ''}`,
                'aria-current': S.usageAt === row.screen.id ? 'true' : undefined,
                disabled: !usable,
                title: usable ? t('inspectUsesShow', { n: row.count, screen: row.screen.name }) : undefined,
                onclick: () => void showUses(name, row.screen.id),
              },
              icon(viewport, 14),
              h('span', { class: 'usage-name' }, row.screen.name),
              status
            )
          )
        })
      )
    )
  }

  async function countUses(name) {
    const list = S.manifest.screens
    S.usage = { name, rows: {} }
    for (const screen of list) S.usage.rows[screen.id] = { status: 'queued' }
    const queue = [...list]
    const freeze = S.freezeCount
    const worker = async () => {
      while (queue.length) {
        const screen = queue.shift()
        if (S.usage?.name !== name) return
        S.usage.rows[screen.id] = { status: 'measuring' }
        if (S.panel === 'inspect') renderSide()
        // Captures stop here, so this screen stays measuring and the ones after it stay queued.
        if (freeze !== null && list.indexOf(screen) >= freeze) return
        let row
        try {
          const inventory = S.inventories[screen.id] ?? (await inventoryOf(screen))
          S.inventories[screen.id] = inventory
          row = { status: 'done', count: inventory.counts[name] ?? 0 }
        } catch {
          row = { status: 'failed' }
        }
        if (S.usage?.name !== name) return
        S.usage.rows[screen.id] = row
        if (S.panel === 'inspect') renderSide()
      }
    }
    await Promise.all([worker(), worker()])
  }

  async function inventoryOf(screen) {
    const [width, height] = sizeOf(screen.viewport)
    const counter = h('iframe', {
      tabindex: '-1',
      title: screen.name,
      style: `width:${width}px;height:${height}px;border:0`,
    })
    counters.append(counter)
    const info = { frame: counter, role: 'count', waiters: [] }
    track(info)
    const inventory = next(info, 'inventory', 12_000)
    const parts = splitPath(screen.path)
    load(info, { ...parts, file: `${S.artifact.dir}${parts.file}` })
    try {
      return await inventory
    } finally {
      clearTimeout(info.timer)
      registry.delete(counter.contentWindow)
      counter.remove()
    }
  }

  async function goToMain() {
    const target = S.selection
    if (!target?.name) return
    const back = S.page.kind === 'components' ? S.page.back : S.page
    expectMain = target.name
    S.backPath = target.path
    S.mode = 'inspect'
    await showPage({ kind: 'components', back })
    const picked = next(main, 'pick')
    send(main, { type: 'select', main: target.name })
    return picked
  }

  async function goBack() {
    const back = S.page.back
    const path = S.backPath
    S.selection = null
    S.matchName = null
    S.usageAt = null
    if (S.panel === 'inspect') S.panel = null
    render()
    await showPage(back)
    if (path) send(main, { type: 'select', path })
  }

  async function showUses(name, screenId) {
    const screen = screenById(screenId)
    const keep = S.selection
    S.matchName = name
    S.usageAt = screenId
    S.viewport = viewportFor(screen)
    const ready = showPage({ kind: 'screen', id: screenId })
    S.selection = keep
    render()
    await ready
    const laid = next(main, 'layout')
    send(main, { type: 'matches', name })
    return laid.catch(() => undefined)
  }

  // ---------------------------------------------------------------- Comment mode, as today
  function toggleComment() {
    if (!S.canComment || S.view === 'screens') return
    if (S.mode === 'comment') S.mode = null
    else {
      if (S.mode === 'inspect') toggleInspect(false)
      S.mode = 'comment'
    }
    render()
  }

  // ---------------------------------------------------------------- the floating layer: hints, chips, Screens controls
  function renderFloat() {
    for (const el of float.querySelectorAll('.hint, .page-chip, .zoom, .screen-focus, .exit-full')) el.remove()
    if (S.full)
      float.append(
        h(
          'button',
          { type: 'button', class: 'exit-full', onclick: () => setFull(false) },
          t('exitFullScreen'),
          h('kbd', {}, 'Esc')
        )
      )
    if (S.view === 'screens') return screens?.controls(float)
    const hint = (text, exit) =>
      h(
        'div',
        { class: 'hint', role: 'status' },
        h('span', {}, text),
        h('button', { type: 'button', class: 'hint-exit', onclick: exit }, t('commentHintExit'), h('kbd', {}, 'Esc'))
      )
    if (S.mode === 'comment') float.append(hint(t('commentHint'), () => toggleComment()))
    if (S.mode === 'inspect' && !S.selection) float.append(hint(t('inspectHint'), () => toggleInspect(false)))
    const back = S.page.kind === 'components' && S.page.back ? screenById(S.page.back.id) : null
    if (back && !(S.selection && S.panel === 'inspect'))
      float.append(
        h(
          'button',
          { type: 'button', class: 'page-chip', onclick: () => void goBack() },
          icon('left', 15),
          t('inspectBack', { screen: back.name })
        )
      )
  }

  // ---------------------------------------------------------------- side panels
  function togglePanel(name) {
    if (!contract() && name === 'tokens') return
    S.panel = S.panel === name ? null : name
    if (S.panel) S.listOpen = false
    render()
  }

  let tokensPanel = null

  function renderSide() {
    const panel = S.panel === 'inspect' && !S.selection ? null : S.panel
    side.hidden = !panel
    side.className = `side${panel ? ` ${panel}-panel` : ''}`
    if (!panel) {
      side.replaceChildren()
      side.dataset.kind = ''
      tokensPanel = null
      return
    }
    if (panel === 'inspect') {
      side.dataset.kind = 'inspect'
      side.setAttribute('aria-label', t('inspectPanel'))
      const scroll = side.querySelector('.side-body')?.scrollTop ?? 0
      side.replaceChildren(...inspectPanel())
      const body = side.querySelector('.side-body')
      if (body) body.scrollTop = scroll
      tokensPanel = null
      return
    }
    side.setAttribute('aria-label', t('tokensPanel'))
    const kind = `tokens-${S.tokens.status}-${S.theme}`
    if (side.dataset.kind !== kind || (S.tokens.status === 'ready' && !tokensPanel)) {
      side.dataset.kind = kind
      buildTokensPanel()
    }
    updateTokensPanel()
  }

  // ---------------------------------------------------------------- Tokens
  async function loadTokens() {
    if (S.tokens.status !== 'idle') return
    S.tokens = { status: 'loading', list: [], themes: [] }
    renderSide()
    try {
      const response = await fetch(`${S.artifact.dir}${tokensFile()}`)
      if (!response.ok) throw new Error(String(response.status))
      const { list, themes } = parseTokens(await response.text())
      S.tokens = { status: list.length ? 'ready' : 'empty', list, themes }
      if (!themeById(S.theme)) S.theme = ''
      // Values in a theme preview in their own block, which is only known now.
      applyPreview()
    } catch {
      S.tokens = { status: 'error', list: [], themes: [] }
    }
    renderSide()
  }

  function openTokens(focusName) {
    S.panel = 'tokens'
    S.listOpen = false
    const key = focusName && shownKey(focusName)
    if (key && splitKey(key).theme !== S.theme) setActiveTheme(splitKey(key).theme)
    render()
    const row = key && tokensPanel?.rows.get(key)
    if (!row) return
    tokensPanel.groups.get(row.token.group)?.setOpen(true)
    S.filter = ''
    tokensPanel.filter.value = ''
    filterRows()
    row.el.scrollIntoView({ block: 'center' })
    row.el.classList.add('is-found')
    setTimeout(() => row.el.classList.remove('is-found'), 1600)
    focusOn(row.input)
    row.input.select()
  }

  /** Shows the theme in the panel and on every frame: the theme being edited is the theme on screen. */
  function setActiveTheme(id) {
    if (!themeById(id) || id === S.theme) return
    const fromTabs = document.activeElement?.closest?.('.theme-tabs')
    S.theme = id
    S.filter = ''
    applyPreview()
    if (S.panel) renderSide()
    if (fromTabs) focusOn(tokensPanel?.tabs.querySelector('[aria-pressed="true"]'))
  }

  function themeTabs() {
    const themes = S.tokens.themes
    if (themes.length < 2) return null
    const pending = (id) => [...S.changes.keys()].some((key) => splitKey(key).theme === id)
    return h(
      'div',
      { class: 'tabs theme-tabs', role: 'group', 'aria-label': t('themeGroup') },
      themes.map((theme) =>
        h(
          'button',
          {
            type: 'button',
            class: 'tab',
            'aria-pressed': String(theme.id === S.theme),
            title: theme.system ? t('themeSystemHint') : undefined,
            onclick: () => setActiveTheme(theme.id),
          },
          themeLabel(theme),
          h('span', { class: 'tab-count' }, String(S.tokens.list.filter((token) => token.theme === theme.id).length)),
          pending(theme.id) && h('span', { class: 'theme-dot', role: 'img', 'aria-label': t('themePending') })
        )
      )
    )
  }

  function tokensHead() {
    return h(
      'header',
      { class: 'side-head' },
      h('span', { class: 'side-mark is-tokens' }, icon('tokens', 16)),
      h(
        'div',
        { class: 'side-title' },
        h('h2', {}, t('tokensPanel')),
        h(
          'p',
          { class: 'side-sub' },
          S.tokens.status === 'ready'
            ? t('tokensFile', { file: tokensFile(), n: new Set(S.tokens.list.map((token) => token.name)).size })
            : tokensFile()
        )
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          'aria-label': t('tokensClose'),
          title: t('tokensClose'),
          onclick: () => togglePanel('tokens'),
        },
        icon('close', 15)
      )
    )
  }

  function buildTokensPanel() {
    const status = S.tokens.status
    if (status === 'idle') void loadTokens()
    if (status !== 'ready') {
      const body = h('div', { class: 'side-body' })
      if (status === 'loading' || status === 'idle')
        body.append(
          h(
            'div',
            { class: 'tokens-state', role: 'status', 'aria-label': t('tokensLoading') },
            [62, 48, 70, 55, 40, 66, 50, 58].map((width) =>
              h(
                'div',
                { class: 'skeleton-row' },
                h('span', { class: 'skeleton', style: `width:${width}%` }),
                h('span', { class: 'skeleton' })
              )
            )
          )
        )
      else if (status === 'error')
        body.append(
          h(
            'div',
            { class: 'tokens-state' },
            h('p', { class: 'list-empty is-error', role: 'alert' }, t('tokensFailed')),
            h(
              'button',
              {
                type: 'button',
                class: 'button',
                onclick: () => {
                  S.tokens = { status: 'idle', list: [], themes: [] }
                  void loadTokens()
                },
              },
              t('retry')
            )
          )
        )
      else
        body.append(
          h('div', { class: 'tokens-state' }, h('p', { class: 'list-empty' }, t('tokensEmpty', { file: tokensFile() })))
        )
      side.replaceChildren(tokensHead(), body)
      tokensPanel = null
      return
    }

    const rows = new Map()
    const groups = new Map()
    const filter = h('input', {
      class: 'input',
      type: 'search',
      placeholder: t('tokensFilter'),
      'aria-label': t('tokensFilter'),
      value: S.filter,
    })
    filter.addEventListener('input', () => {
      S.filter = filter.value
      filterRows()
    })
    const body = h('div', { class: 'side-body' })
    const empty = h('p', { class: 'list-empty', hidden: true })
    // A theme lists only what it declares; everything else keeps the default value.
    const inherited = S.theme
      ? new Set(S.tokens.list.filter((token) => !token.theme).map((token) => token.name)).size -
        S.tokens.list.filter((token) => token.theme === S.theme).length
      : 0
    const inheritNote =
      inherited > 0 &&
      h(
        'p',
        { class: 'tokens-inherit' },
        t('themeInherit', { n: inherited, theme: t('themeDefault') }),
        ' ',
        h(
          'button',
          { type: 'button', class: 'link', onclick: () => setActiveTheme('') },
          t('themeShow', { theme: t('themeDefault') })
        )
      )
    let sequence = 0
    const inView = S.tokens.list.filter((token) => token.theme === S.theme)
    for (const group of GROUPS) {
      const tokens = inView.filter((token) => token.group === group)
      if (!tokens.length) continue
      const items = h('ul', { class: 'token-list', id: `tokens-${group}` })
      const head = h(
        'button',
        { type: 'button', class: 'token-group-head', 'aria-expanded': 'true', 'aria-controls': `tokens-${group}` },
        icon('down', 14),
        t(GROUP_LABEL[group]),
        h('span', { class: 'tab-count' }, String(tokens.length))
      )
      const setOpen = (open) => {
        head.setAttribute('aria-expanded', String(open))
        items.hidden = !open
      }
      head.addEventListener('click', () => setOpen(head.getAttribute('aria-expanded') !== 'true'))
      const el = h('section', { class: 'token-group' }, head, items)
      groups.set(group, { el, setOpen })
      for (const token of tokens) {
        const id = `token-${++sequence}`
        const input = h('input', {
          id,
          class: 'token-input',
          spellcheck: 'false',
          autocomplete: 'off',
          maxlength: '200',
          'aria-describedby': `${id}-error`,
        })
        input.value = showValue(baseValue(token.key), token.kind)
        const field = h('div', { class: `token-field${token.kind === 'color' ? ' has-swatch' : ''}` })
        let picker = null
        let chip = null
        if (token.kind === 'color') {
          picker = h('input', { type: 'color', tabindex: '-1', 'aria-label': t('tokenPick', { name: token.name }) })
          chip = h('label', { class: 'token-swatch', title: t('tokenPick', { name: token.name }) }, picker)
          picker.addEventListener('input', () => {
            input.value = picker.value.toUpperCase()
            setToken(token, input.value)
          })
          field.append(chip)
        }
        field.append(input)
        const error = h('p', { class: 'token-error', id: `${id}-error`, hidden: true }, t('tokenInvalid'))
        const reset = h(
          'button',
          {
            type: 'button',
            class: 'icon-button token-reset',
            'aria-label': t('tokenReset', { name: token.name }),
            title: t('tokenReset', { name: token.name }),
            onclick: () => resetToken(token.key),
          },
          icon('reset', 13)
        )
        const row = h(
          'li',
          { class: `token-row is-${token.kind}`, 'data-token': token.key },
          h('label', { class: 'token-name', for: id, title: token.name }, token.name),
          field,
          reset,
          error
        )
        let before = ''
        input.addEventListener('focus', () => {
          before = input.value
        })
        input.addEventListener('input', () => setToken(token, input.value))
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            input.value = before
            setToken(token, before)
            input.blur()
          } else if (event.key === 'Enter') input.blur()
          else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && token.kind !== 'text') {
            const match = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(input.value.trim())
            if (!match) return
            event.preventDefault()
            const decimals = (match[1].split('.')[1] ?? '').length
            const unit = decimals ? 10 ** -decimals : Number(match[1]) >= 100 && !match[2] ? 50 : 1
            const step = unit * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1)
            input.value = `${(Number(match[1]) + step).toFixed(decimals)}${match[2]}`
            setToken(token, input.value)
          }
        })
        rows.set(token.key, { el: row, input, picker, chip, error, token })
        items.append(row)
      }
      body.append(el)
    }
    body.append(empty)
    if (inheritNote) body.append(inheritNote)

    const tray = h('footer', { class: 'tray' })
    const foot = h('p', { class: 'side-foot' })
    const tabs = themeTabs() ?? h('span', { hidden: true })
    side.replaceChildren(
      tokensHead(),
      tabs,
      h('div', { class: 'tokens-filter' }, icon('search', 14), filter),
      body,
      tray,
      foot
    )
    tokensPanel = { rows, groups, filter, empty, tray, foot, tabs }
    filterRows()
  }

  function filterRows() {
    if (!tokensPanel) return
    const query = S.filter.trim().toLowerCase()
    let shown = 0
    for (const [group, entry] of tokensPanel.groups) {
      let visible = 0
      for (const row of tokensPanel.rows.values()) {
        if (row.token.group !== group) continue
        const match =
          !query || row.token.name.toLowerCase().includes(query) || row.input.value.toLowerCase().includes(query)
        row.el.hidden = !match
        if (match) visible++
      }
      entry.el.hidden = visible === 0
      shown += visible
    }
    tokensPanel.empty.hidden = shown > 0
    tokensPanel.empty.textContent = t('tokensFilterEmpty', { query: S.filter.trim() })
  }

  function setToken(token, raw) {
    const value = raw.trim()
    const row = tokensPanel?.rows.get(token.key)
    const valid = validValue(token, value)
    if (row) {
      row.el.classList.toggle('is-invalid', !valid)
      row.error.hidden = valid
      row.input.setAttribute('aria-invalid', String(!valid))
    }
    if (!valid) return
    const base = baseValue(token.key)
    const same = token.kind === 'color' ? toHex(value) !== null && toHex(value) === toHex(base) : value === base
    if (same) S.changes.delete(token.key)
    else S.changes.set(token.key, value)
    applyPreview()
    updateTokensPanel()
    bar.update()
    if (S.panel === 'inspect') renderSide()
  }

  function resetToken(key) {
    S.changes.delete(key)
    const row = tokensPanel?.rows.get(key)
    if (row) {
      row.input.value = showValue(baseValue(key), row.token.kind)
      row.el.classList.remove('is-invalid')
      row.error.hidden = true
    }
    applyPreview()
    updateTokensPanel()
    bar.update()
  }

  function discardChanges() {
    for (const key of [...S.changes.keys()]) resetToken(key)
    render()
  }

  /** A change's token name, with a tag for its theme when it is not the default one. */
  const changeLabel = (change) =>
    h(
      'span',
      { class: 'change-name', title: changeName(change) },
      change.name,
      change.theme && h('span', { class: 'theme-tag' }, themeName(change.theme))
    )

  const changeValues = (change, withFrom = true) =>
    h(
      'span',
      { class: 'change-values' },
      withFrom &&
        h(
          'span',
          { class: 'change-from' },
          change.kind === 'color' && swatch(change.from),
          h('span', { class: 'value-text' }, showValue(change.from, change.kind))
        ),
      withFrom && icon('arrow', 12),
      h(
        'span',
        { class: 'change-to' },
        change.kind === 'color' && swatch(change.to),
        h('span', { class: 'value-text' }, showValue(change.to, change.kind))
      )
    )

  function updateTokensPanel() {
    if (!tokensPanel) return
    for (const row of tokensPanel.rows.values()) {
      const value = S.changes.get(row.token.key) ?? baseValue(row.token.key)
      row.el.classList.toggle('is-changed', S.changes.has(row.token.key))
      if (document.activeElement !== row.input && !row.el.classList.contains('is-invalid'))
        row.input.value = showValue(value, row.token.kind)
      if (row.chip) {
        row.chip.style.setProperty('--swatch', value)
        const hex = toHex(value)
        if (hex) row.picker.value = hex.toLowerCase()
      }
    }
    const tabs = themeTabs()
    if (tabs) {
      tokensPanel.tabs.replaceWith(tabs)
      tokensPanel.tabs = tabs
    }
    const changes = changeList()
    const { tray, foot } = tokensPanel
    tray.hidden = changes.length === 0
    foot.hidden = changes.length > 0
    foot.textContent = isOwner()
      ? t('tokensFootOwner')
      : S.canComment
        ? t('tokensFootGuest', { owner: OWNER })
        : t('tokensFootReadonly')
    if (!changes.length) return tray.replaceChildren()

    const behind = S.version !== S.current
    const primary = isOwner()
      ? h(
          'button',
          { type: 'button', class: 'button primary', disabled: behind, onclick: () => openSave('save') },
          t('saveAs', { n: S.current + 1 })
        )
      : S.canComment &&
        h(
          'button',
          { type: 'button', class: 'button primary', onclick: () => openSuggest() },
          icon('comment', 14),
          t('suggest')
        )
    tray.setAttribute('aria-label', plural(changes.length, 'changesOne', 'changesMany'))
    tray.replaceChildren(
      h(
        'div',
        { class: 'tray-head' },
        h('b', {}, plural(changes.length, 'changesOne', 'changesMany')),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-expanded': String(S.trayOpen),
            'aria-label': S.trayOpen ? t('changesHide') : t('changesShow'),
            title: S.trayOpen ? t('changesHide') : t('changesShow'),
            onclick: () => {
              S.trayOpen = !S.trayOpen
              updateTokensPanel()
            },
          },
          icon(S.trayOpen ? 'down' : 'up', 15)
        )
      ),
      S.trayOpen &&
        h(
          'ul',
          { class: 'change-list' },
          changes.map((change) =>
            h(
              'li',
              { class: 'change' },
              changeLabel(change),
              changeValues(change),
              h(
                'button',
                {
                  type: 'button',
                  class: 'icon-button token-reset',
                  'aria-label': t('tokenReset', { name: changeName(change) }),
                  title: t('tokenReset', { name: changeName(change) }),
                  onclick: () => resetToken(change.key),
                },
                icon('reset', 13)
              )
            )
          )
        ),
      h(
        'p',
        { class: 'tray-note' },
        behind && isOwner()
          ? t('changesOldVersion')
          : isOwner()
            ? t('changesPreview')
            : S.canComment
              ? t('changesPreviewGuest', { owner: OWNER })
              : t('changesPreviewReadonly')
      ),
      h(
        'div',
        { class: 'tray-actions' },
        h('button', { type: 'button', class: 'button', onclick: () => discardChanges() }, t('discard')),
        primary
      )
    )
  }

  // ---------------------------------------------------------------- saving a version
  let dialogEl = null

  function openSave(kind) {
    S.dialog = { kind, status: 'idle' }
    renderDialog()
  }

  function closeDialog() {
    S.dialog = null
    renderDialog()
  }

  const savedChanges = () =>
    S.dialog?.kind === 'apply'
      ? S.suggestion.changes.map((change) => describeChange(change.key, change.from, change.to))
      : changeList()

  function renderDialog() {
    if (!S.dialog) {
      if (dialogEl?.open) dialogEl.close()
      dialogEl?.remove()
      dialogEl = null
      return
    }
    const { kind, status } = S.dialog
    const n = S.current + 1
    const changes = savedChanges()
    const names = changes.map(changeName).join(', ')
    const summary =
      kind === 'apply'
        ? t('summaryApplied', { author: S.suggestion.author.name, names })
        : t('summaryTokens', { names })
    const confirm = h(
      'button',
      { type: 'submit', class: 'button primary', disabled: status === 'saving' },
      status === 'saving' && h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      status === 'stale' && icon('tokens', 14),
      status === 'saving'
        ? t('saving')
        : status === 'conflict'
          ? t('saveConflictAction', { n: S.current })
          : status === 'stale'
            ? t('suggestionEdit')
            : t('saveConfirm', { n })
    )
    const form = h(
      'form',
      { method: 'dialog' },
      h('h2', { id: 'save-title' }, kind === 'apply' ? t('applyTitle', { n }) : t('saveTitle', { n })),
      h(
        'p',
        {},
        kind === 'apply'
          ? t('applyDetail', { author: S.suggestion.author.name, n, file: tokensFile() })
          : t('saveDetail', { file: tokensFile(), n })
      ),
      h(
        'ul',
        { class: 'dialog-changes' },
        changes.map((change) => h('li', {}, changeLabel(change), changeValues(change, false)))
      ),
      status !== 'stale' &&
        h(
          'p',
          { class: 'dialog-meta' },
          // Token names never break at their hyphens.
          t('saveSummary', { summary })
            .split(/(--[a-zA-Z0-9_-]+)/)
            .map((part) => (part.startsWith('--') ? h('span', { class: 'nowrap' }, part) : part))
        ),
      status === 'conflict' &&
        h(
          'p',
          { class: 'dialog-error is-warn', role: 'alert' },
          icon('alert', 15),
          h('span', {}, t('saveConflict', { n: S.current }))
        ),
      status === 'failed' &&
        h('p', { class: 'dialog-error', role: 'alert' }, icon('alert', 15), h('span', {}, t('saveFailed'))),
      status === 'stale' &&
        h(
          'p',
          { class: 'dialog-error is-warn', role: 'alert' },
          icon('alert', 15),
          h(
            'span',
            {},
            t('applyStale', {
              names: changes.filter(isStale).map(changeName).join(', '),
              author: S.suggestion.author.name.split(' ')[0],
            })
          )
        ),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'button', onclick: () => closeDialog() }, t('cancel')),
        confirm
      )
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (S.dialog.status === 'conflict') return rebase()
      if (S.dialog.status === 'stale') return editSuggestion()
      void save()
    })
    const fresh = h(
      'dialog',
      { class: 'name-dialog save-dialog', 'aria-labelledby': 'save-title', 'aria-busy': String(status === 'saving') },
      form
    )
    fresh.addEventListener('cancel', (event) => {
      event.preventDefault()
      if (S.dialog?.status !== 'saving') closeDialog()
    })
    dialogEl?.remove()
    dialogEl = fresh
    document.body.append(fresh)
    fresh.showModal()
    focusOn(status === 'saving' ? fresh : confirm)
  }

  async function save() {
    S.dialog.status = 'saving'
    renderDialog()
    if (S.freezeSave === 'saving') return
    await new Promise((resolve) => setTimeout(resolve, CAPTURE ? 50 : 900))
    if (S.freezeSave === 'conflict') {
      S.freezeSave = null
      S.artifact.versions.push({
        number: S.current + 1,
        summary: 'Roomier mobile order screen',
        createdAt: NOW - 4 * MIN,
      })
      S.current += 1
      S.dialog.status = 'conflict'
      render()
      return
    }
    if (S.freezeSave === 'stale') {
      // Someone saved a version that changed a suggested token while the owner was confirming.
      S.freezeSave = null
      S.artifact.versions.push({ number: S.current + 1, summary: 'Tokens: --radius-md', createdAt: NOW - 2 * MIN })
      S.saved.set('--radius-md', '12px')
      S.current += 1
      S.version = S.current
      S.dialog.status = 'stale'
      applyPreview()
      render()
      return
    }
    const changes = savedChanges()
    const names = changes.map(changeName).join(', ')
    const kind = S.dialog.kind
    const n = S.current + 1
    S.artifact.versions.push({
      number: n,
      summary:
        kind === 'apply'
          ? t('summaryApplied', { author: S.suggestion.author.name, names })
          : t('summaryTokens', { names }),
      createdAt: NOW,
    })
    for (const change of changes) S.saved.set(change.key, change.to)
    if (kind === 'apply') {
      S.suggestion.applied = n
      S.previewSuggestion = false
    } else S.changes.clear()
    S.current = n
    S.version = n
    S.dialog = null
    applyPreview()
    render()
    renderCard(true)
    toast(t('savedToast', { n }))
  }

  function rebase() {
    S.version = S.current
    S.dialog = null
    showPage(S.page)
    render()
    toast(t('rebasedToast', { n: S.current }))
  }

  // ---------------------------------------------------------------- suggestions, in the comment card
  const openThreads = () =>
    [
      {
        id: 'c1',
        author: { kind: 'owner', name: OWNER },
        body: 'Can the totals line up with the column header?',
        quote: 'Good morning, Crumb Bakehouse',
        createdAt: NOW - 3 * HOUR,
      },
      S.suggestion && {
        id: 'c2',
        author: S.suggestion.author,
        body: S.suggestion.body || autoBody(S.suggestion.changes),
        createdAt: S.suggestion.createdAt,
        suggestion: S.suggestion,
      },
    ].filter(Boolean)
  const authorLabel = (author) =>
    (author.kind === 'owner' && isOwner()) || (author.kind === 'invited' && !isOwner())
      ? t('you')
      : author.kind === 'owner'
        ? t('commentOwner', { name: author.name })
        : author.name

  let cardEl = null
  let cardKind = null

  function openSuggest() {
    S.card = 'suggest'
    render()
    focusOn(cardEl?.querySelector('textarea'))
  }

  function escapeCard() {
    if (!S.card) return false
    S.card = null
    render()
    return true
  }

  /** A suggested change whose token no longer has the value it was suggested over. */
  const isStale = (change) => {
    const now = baseValue(change.key)
    return Boolean(now) && now !== change.from && (toHex(now) === null || toHex(now) !== toHex(change.from))
  }

  /** The body of a suggestion sent without a note, as the host writes it: what agents read too. */
  const autoBody = (changes) =>
    t('summaryTokens', {
      names: changes
        .map((change) => describeChange(change.key, change.from, change.to))
        .map(
          (change) =>
            `${changeName(change)} ${showValue(change.from, change.kind)} → ${showValue(change.to, change.kind)}`
        )
        .join(', '),
    })

  /** Takes a suggestion's values into Tokens as the owner's own changes, to review and save on the current version. */
  function editSuggestion() {
    for (const change of S.suggestion.changes) {
      if (change.to === baseValue(change.key)) S.changes.delete(change.key)
      else S.changes.set(change.key, change.to)
    }
    S.previewSuggestion = false
    S.dialog = null
    renderDialog()
    S.card = null
    S.listOpen = false
    S.panel = 'tokens'
    const theme = splitKey(S.suggestion.changes[0]?.key ?? '').theme
    if (theme !== S.theme && themeById(theme)) S.theme = theme
    applyPreview()
    render()
    toast(t('suggestionEdited', { author: S.suggestion.author.name.split(' ')[0] }))
  }

  function suggestionBlock(suggestion, { draft = false } = {}) {
    const changes = suggestion.changes.map((change) => describeChange(change.key, change.from, change.to))
    const applied = suggestion.applied
    return h(
      'div',
      { class: `suggestion${applied ? ' is-applied' : ''}` },
      h(
        'div',
        { class: 'suggestion-head' },
        icon(applied ? 'check' : 'tokens', 14),
        applied ? t('suggestionApplied', { n: applied }) : plural(changes.length, 'suggestionOne', 'suggestionMany')
      ),
      h(
        'ul',
        { class: 'suggestion-list' },
        changes.map((change) => {
          const now = baseValue(change.key)
          const stale = !draft && !applied && isStale(change)
          return h(
            'li',
            {},
            changeLabel(change),
            changeValues(change),
            stale &&
              h('span', { class: 'suggestion-stale' }, t('suggestionStale', { value: showValue(now, change.kind) }))
          )
        })
      ),
      !draft &&
        !applied &&
        h(
          'div',
          { class: 'suggestion-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'button small',
              'aria-pressed': String(S.previewSuggestion),
              onclick: () => {
                S.previewSuggestion = !S.previewSuggestion
                applyPreview()
                renderCard(true)
              },
            },
            icon('eye', 13),
            t('suggestionPreview')
          ),
          // A suggestion over values that changed since cannot be applied as is; the owner takes it into Tokens.
          isOwner() &&
            (changes.some(isStale)
              ? h(
                  'button',
                  { type: 'button', class: 'button small primary', onclick: () => editSuggestion() },
                  icon('tokens', 13),
                  t('suggestionEdit')
                )
              : h(
                  'button',
                  { type: 'button', class: 'button small primary', onclick: () => openSave('apply') },
                  t('suggestionApply')
                ))
        )
    )
  }

  function composer({ placeholder, submitLabel, value, foot, allowEmpty, onSubmit }) {
    const area = h('textarea', { rows: '1', maxlength: '4000', placeholder, 'aria-label': placeholder })
    area.value = value ?? ''
    const sendButton = h(
      'button',
      { type: 'submit', class: 'send', 'aria-label': submitLabel, title: submitLabel },
      icon('send', 15)
    )
    const form = h(
      'form',
      { class: 'composer', novalidate: true },
      h('div', { class: 'composer-row' }, selfFace(26), area, sendButton),
      foot &&
        h(
          'div',
          { class: 'composer-foot' },
          h('span', {}, t('composerHint')),
          h('button', { type: 'button', class: 'link', onclick: foot.onCancel }, t('cancel'))
        )
    )
    const sync = () => {
      sendButton.disabled = !allowEmpty && !area.value.trim()
      area.style.height = 'auto'
      area.style.height = `${Math.min(area.scrollHeight, 160)}px`
    }
    area.addEventListener('input', sync)
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        form.requestSubmit()
      }
    })
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      onSubmit(area.value.trim(), sendButton)
    })
    queueMicrotask(sync)
    return form
  }

  function sendSuggestion(body, button, changes) {
    button.disabled = true
    setTimeout(
      () => {
        S.suggestion = {
          author: { kind: 'invited', name: GUEST },
          body: body || autoBody(changes),
          createdAt: NOW,
          changes: changes.map((change) => ({ key: change.key, from: change.from, to: change.to })),
          applied: null,
        }
        S.changes.clear()
        S.card = null
        applyPreview()
        render()
        toast(t('suggestSent', { owner: OWNER }), {
          label: t('suggestView'),
          run: () => {
            S.card = 'thread'
            setList(true)
          },
        })
      },
      CAPTURE ? 0 : 500
    )
  }

  function suggestCard() {
    const changes = changeList()
    const title = plural(changes.length, 'suggestTitleOne', 'suggestTitleMany')
    return h(
      'section',
      { class: 'card is-draft suggest-card', tabindex: '-1', role: 'dialog', 'aria-label': title },
      h(
        'header',
        { class: 'card-head' },
        h('span', { class: 'card-title' }, title),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': t('cancel'),
            title: t('cancel'),
            onclick: () => escapeCard(),
          },
          icon('close', 15)
        )
      ),
      suggestionBlock({ changes }, { draft: true }),
      h('p', { class: 'suggest-auto' }, t('suggestAutoHint')),
      composer({
        placeholder: t('suggestPlaceholder', { owner: OWNER.split(' ')[0] }),
        submitLabel: t('suggestSend'),
        value: S.suggestNote,
        allowEmpty: true,
        foot: { onCancel: () => escapeCard() },
        onSubmit: (body, button) => sendSuggestion(body, button, changes),
      })
    )
  }

  function threadCard(typed) {
    const threads = openThreads()
    const at = threads.findIndex((thread) => thread.suggestion)
    const thread = threads[at]
    const { author } = thread
    return h(
      'section',
      {
        class: 'card',
        tabindex: '-1',
        role: 'dialog',
        'aria-label': t('threadLabel', { author: authorLabel(author) }),
      },
      h(
        'header',
        { class: 'card-head' },
        h(
          'span',
          { class: 'stepper' },
          h(
            'button',
            { type: 'button', class: 'icon-button', 'aria-label': t('threadPrevious'), title: t('threadPrevious') },
            icon('left', 15)
          ),
          h('span', { class: 'stepper-at' }, t('threadAt', { n: at + 1, total: threads.length })),
          h(
            'button',
            { type: 'button', class: 'icon-button', 'aria-label': t('threadNext'), title: t('threadNext') },
            icon('right', 15)
          )
        ),
        h('span', { class: 'card-spacer' }),
        isOwner() && h('button', { type: 'button', class: 'button small' }, icon('check', 14), t('resolve')),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': t('closeThread'),
            title: t('closeThread'),
            onclick: () => escapeCard(),
          },
          icon('close', 15)
        )
      ),
      h(
        'div',
        { class: 'card-body' },
        h('p', { class: 'card-note' }, t('aboutPage')),
        h(
          'div',
          { class: 'entry' },
          avatar(author.kind, author.name, 26),
          h(
            'div',
            { class: 'entry-main' },
            h(
              'p',
              { class: 'entry-head' },
              h('b', {}, authorLabel(author)),
              author.kind === 'invited' &&
                isOwner() &&
                h(
                  'span',
                  {
                    class: 'tick',
                    title: t('tickInvited', { owner: OWNER }),
                    'aria-label': t('tickInvited', { owner: OWNER }),
                  },
                  icon('check', 11)
                ),
              h('time', {}, relativeTime(thread.createdAt))
            ),
            h('p', { class: 'entry-body' }, thread.body),
            suggestionBlock(thread.suggestion)
          )
        )
      ),
      composer({
        placeholder: t('placeholderReply'),
        submitLabel: t('sendReply'),
        value: typed,
        onSubmit: () => undefined,
      })
    )
  }

  function renderCard(force = false) {
    const kind = S.card
    if (!kind) {
      cardEl?.remove()
      cardEl = null
      cardKind = null
      workspace.classList.remove('has-card')
      return
    }
    workspace.classList.add('has-card')
    if (cardEl && cardKind === kind && !force) return positionCard()
    const typed = cardEl?.querySelector('textarea')?.value ?? ''
    cardEl?.remove()
    cardKind = kind
    cardEl = kind === 'suggest' ? suggestCard() : threadCard(typed)
    float.append(cardEl)
    positionCard()
  }

  function positionCard() {
    if (!cardEl) return
    const bounds = stage.getBoundingClientRect()
    cardEl.style.left = `${bounds.width - cardEl.offsetWidth - 16}px`
    cardEl.style.top = '16px'
    cardEl.style.transformOrigin = 'right 0px'
  }

  // ---------------------------------------------------------------- the list of comments, as in shell/comments.ts
  // The width at which viewer.css turns the list into a full-stage panel and the card into a sheet.
  const narrow = () => matchMedia('(max-width: 720px)').matches

  function setList(open) {
    S.listOpen = open
    if (open) S.panel = null
    render()
  }

  function renderList() {
    list.hidden = !S.listOpen
    if (!S.listOpen) return
    const threads = openThreads()
    const item = (thread) =>
      h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            class: `item${S.card === 'thread' && thread.suggestion ? ' is-active' : ''}`,
            onclick: () => {
              if (!thread.suggestion) return
              S.card = 'thread'
              // On a phone the list covers the stage, so it gives way to the conversation's sheet.
              if (narrow()) S.listOpen = false
              render()
            },
          },
          avatar(thread.author.kind, thread.author.name, 26),
          h(
            'span',
            { class: 'item-main' },
            h(
              'span',
              { class: 'item-head' },
              h('b', {}, authorLabel(thread.author)),
              h('time', {}, relativeTime(thread.createdAt)),
              thread.suggestion &&
                isOwner() &&
                !thread.suggestion.applied &&
                h('span', { class: 'dot', role: 'img', 'aria-label': t('unread') })
            ),
            thread.quote && h('span', { class: 'item-quote' }, thread.quote),
            h('span', { class: 'item-body' }, thread.body),
            h(
              'span',
              { class: 'item-meta' },
              !thread.quote && h('span', { class: 'tag' }, t('tagPage')),
              thread.suggestion &&
                h(
                  'span',
                  { class: 'tag' },
                  thread.suggestion.applied
                    ? t('suggestionApplied', { n: thread.suggestion.applied })
                    : plural(thread.suggestion.changes.length, 'suggestionOne', 'suggestionMany')
                )
            )
          )
        )
      )
    list.replaceChildren(
      h(
        'header',
        { class: 'list-head' },
        h('h2', {}, t('listTitle')),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': t('listClose'),
            title: t('listClose'),
            onclick: () => setList(false),
          },
          icon('close', 15)
        )
      ),
      h(
        'div',
        { class: 'tabs', role: 'group', 'aria-label': t('listGroup') },
        h(
          'button',
          { type: 'button', class: 'tab', 'aria-pressed': 'true' },
          t('listOpen'),
          h('span', { class: 'tab-count' }, String(threads.length))
        ),
        h(
          'button',
          { type: 'button', class: 'tab', 'aria-pressed': 'false' },
          t('listResolved'),
          h('span', { class: 'tab-count' }, '0')
        )
      ),
      h('div', { class: 'list-body' }, h('ul', { class: 'items' }, threads.map(item))),
      h(
        'footer',
        { class: 'list-foot' },
        h('button', { type: 'button', class: 'button' }, icon('comment', 14), t('pageComment'))
      )
    )
  }

  // ---------------------------------------------------------------- Screens
  const GAP_X = 160
  const GAP_Y = 240
  // Rows wrap at whichever of these widths shows every screen largest, so a narrow window gets fewer per row.
  const ROW_WIDTHS = [4800, 3200, 1600]
  // Screen pixels kept between rows for the names, whose size does not follow the zoom.
  const LABEL_ROOM = 32
  // Frames kept live at once on the canvas, as in the viewer's core.
  const LIVE_MAX = 6
  const padFor = (box) => (box.width <= 720 ? { x: 16, top: 76, bottom: 68 } : { x: 56, top: 76, bottom: 76 })

  function toggleScreens(on = S.view !== 'screens') {
    if (!contract()) return
    if (on) {
      if (S.mode === 'inspect') toggleInspect(false)
      S.mode = null
      S.view = 'screens'
      S.card = null
    } else S.view = 'page'
    render()
    if (on) focusOn(screens?.surface, { preventScroll: true })
  }

  function openScreen(id) {
    const screen = screenById(id)
    S.view = 'page'
    S.focus = null
    S.viewport = viewportFor(screen)
    S.selection = null
    S.matchName = null
    render()
    return showPage({ kind: 'screen', id })
  }

  function wrap(list, rowMax, gapY) {
    const placed = []
    let x = 0
    let y = 0
    let rowHeight = 0
    let row = 0
    for (const screen of list) {
      const [width, height] = sizeOf(screen.viewport)
      if (x > 0 && x + width > rowMax) {
        x = 0
        y += rowHeight + gapY
        rowHeight = 0
        row++
      }
      placed.push({ screen, x, y, width, height, row })
      x += width + GAP_X
      rowHeight = Math.max(rowHeight, height)
    }
    return {
      placed,
      width: Math.max(...placed.map((item) => item.x + item.width)),
      height: Math.max(...placed.map((item) => item.y + item.height)),
    }
  }

  /** The layout that fits every screen largest in a room of this size, with room for the names between rows. */
  function arrange(list, box) {
    const pad = padFor(box)
    const fit = (layout) =>
      Math.min((box.width - pad.x * 2) / layout.width, (box.height - pad.top - pad.bottom) / layout.height, 1)
    let best = null
    for (const rowMax of ROW_WIDTHS) {
      let layout = wrap(list, rowMax, GAP_Y)
      // A smaller zoom shrinks the gap on screen, so widen it until the names fit; this settles in a pass or two.
      for (let pass = 0; pass < 4 && GAP_Y * fit(layout) < LABEL_ROOM; pass++)
        layout = wrap(list, rowMax, Math.max(GAP_Y, Math.ceil(LABEL_ROOM / fit(layout))))
      const zoom = fit(layout)
      // A narrower wrap must win clearly, so the layout does not flip on small resizes.
      if (!best || zoom > best.zoom * 1.05) best = { ...layout, rowMax, zoom }
    }
    return best
  }

  function createScreens() {
    let layout = arrange(S.manifest.screens, stage.getBoundingClientRect())
    const placed = layout.placed
    const bounds = { width: layout.width, height: layout.height }
    const world = h('div', { class: 'screens-world' })
    const surface = h(
      'div',
      { class: 'screens', role: 'region', 'aria-label': t('screensLabel'), tabindex: '0' },
      world
    )
    const cam = { x: 0, y: 0, z: 0.2 }
    let fitted = true
    let zoomLabel = null
    const items = new Map()

    for (const item of placed) {
      const { screen, width, height } = item
      const placeholder = h('div', { class: 'screen-placeholder' })
      const frameBox = h('div', { class: 'screen-frame' }, placeholder)
      const el = h(
        'div',
        {
          class: 'screen',
          role: 'button',
          tabindex: '-1',
          'data-screen': screen.id,
          'aria-label': t('screenLabel', { name: screen.name, width, height }),
          'aria-pressed': 'false',
          style: `left:${item.x}px;top:${item.y}px;width:${width}px;height:${height}px;--w:${width}px`,
        },
        h(
          'div',
          { class: 'screen-label' },
          h('b', {}, screen.name),
          h('span', { class: 'screen-size' }, t('screenSize', { width, height }))
        ),
        frameBox
      )
      world.append(el)
      items.set(screen.id, { ...item, el, frameBox, placeholder, info: null, state: 'idle' })
    }
    stage.append(surface)

    function placeholderState(entry, state) {
      entry.state = state
      entry.placeholder.hidden = state === 'live'
      entry.placeholder.classList.toggle('is-failed', state === 'failed')
      entry.placeholder.replaceChildren(
        h(
          'div',
          { class: 'screen-placeholder-body' },
          state === 'failed'
            ? [
                h('p', {}, t('screenFailed')),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'button',
                    onclick: () => {
                      delete S.forced[entry.screen.id]
                      unload(entry)
                      live()
                    },
                  },
                  t('retry')
                ),
              ]
            : [h('span', { class: 'spinner' }), h('p', {}, t('loading'))]
        )
      )
    }

    function loadEntry(entry) {
      const forced = S.forced[entry.screen.id]
      if (forced) return placeholderState(entry, forced)
      placeholderState(entry, 'loading')
      const iframe = h('iframe', {
        title: entry.screen.name,
        tabindex: '-1',
        'aria-hidden': 'true',
        style: `width:${entry.width}px;height:${entry.height}px`,
      })
      entry.frameBox.prepend(iframe)
      const info = { frame: iframe, role: 'screen', id: entry.screen.id, waiters: [] }
      track(info)
      info.onReady = () => {
        placeholderState(entry, 'live')
        send(info, previewMessage())
      }
      info.onFail = () => placeholderState(entry, 'failed')
      entry.info = info
      const parts = splitPath(entry.screen.path)
      load(info, { ...parts, file: `${S.artifact.dir}${parts.file}` })
    }

    function unload(entry) {
      if (entry.info) {
        clearTimeout(entry.info.timer)
        registry.delete(entry.info.frame.contentWindow)
        entry.info.frame.remove()
      }
      entry.info = null
      placeholderState(entry, 'idle')
    }

    let liveTimer = 0
    function live() {
      clearTimeout(liveTimer)
      liveTimer = setTimeout(() => {
        const box = surface.getBoundingClientRect()
        const view = {
          left: -box.width * 0.25,
          top: -box.height * 0.25,
          right: box.width * 1.25,
          bottom: box.height * 1.25,
        }
        const ranked = [...items.values()]
          .map((entry) => {
            const left = cam.x + entry.x * cam.z
            const top = cam.y + entry.y * cam.z
            const right = left + entry.width * cam.z
            const bottom = top + entry.height * cam.z
            const visible = right > view.left && left < view.right && bottom > view.top && top < view.bottom
            const distance = Math.hypot((left + right - box.width) / 2, (top + bottom - box.height) / 2)
            return { entry, visible, distance }
          })
          .sort((a, b) => a.distance - b.distance)
        let count = 0
        for (const { entry, visible } of ranked) {
          if (visible && count < LIVE_MAX) {
            count++
            if (entry.state === 'idle') loadEntry(entry)
          } else if (entry.info || entry.state !== 'idle') unload(entry)
        }
      }, 120)
    }

    function apply(animate) {
      world.classList.toggle('is-moving', animate)
      world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`
      world.style.setProperty('--zoom', String(cam.z))
      if (zoomLabel) zoomLabel.textContent = `${Math.round(cam.z * 100)}%`
      live()
    }

    function relayout() {
      const next = arrange(S.manifest.screens, surface.getBoundingClientRect())
      if (next.width === layout.width && next.height === layout.height) return
      layout = next
      bounds.width = next.width
      bounds.height = next.height
      next.placed.forEach((item, index) => {
        Object.assign(placed[index], item)
        const entry = items.get(item.screen.id)
        Object.assign(entry, { x: item.x, y: item.y, row: item.row })
        entry.el.style.left = `${item.x}px`
        entry.el.style.top = `${item.y}px`
      })
    }

    function fitAll(animate = false) {
      const box = surface.getBoundingClientRect()
      const pad = padFor(box)
      const z = Math.min((box.width - pad.x * 2) / bounds.width, (box.height - pad.top - pad.bottom) / bounds.height, 1)
      cam.z = Math.max(0.04, z)
      cam.x = (box.width - bounds.width * cam.z) / 2
      cam.y = pad.top + (box.height - pad.top - pad.bottom - bounds.height * cam.z) / 2
      fitted = true
      apply(animate)
    }

    function fitScreen(id, animate = true) {
      const entry = items.get(id)
      if (!entry) return
      const box = surface.getBoundingClientRect()
      const pad = padFor(box)
      const top = pad.top + 16
      const z = Math.min((box.width - pad.x * 2) / entry.width, (box.height - top - pad.bottom) / entry.height, 1)
      cam.z = z
      cam.x = box.width / 2 - (entry.x + entry.width / 2) * z
      cam.y = top + (box.height - top - pad.bottom - entry.height * z) / 2 - entry.y * z
      fitted = false
      apply(animate)
    }

    function zoomAt(px, py, factor) {
      const z = Math.min(2, Math.max(0.04, cam.z * factor))
      cam.x = px - (px - cam.x) * (z / cam.z)
      cam.y = py - (py - cam.y) * (z / cam.z)
      cam.z = z
      fitted = false
      apply(false)
    }

    function zoomCenter(factor) {
      const box = surface.getBoundingClientRect()
      zoomAt(box.width / 2, box.height / 2, factor)
    }

    function setFocus(id, animate = true) {
      S.focus = id
      for (const [key, entry] of items) {
        entry.el.classList.toggle('is-focused', key === id)
        entry.el.setAttribute('aria-pressed', String(key === id))
        entry.el.tabIndex = key === (id ?? placed[0].screen.id) ? 0 : -1
      }
      if (id) fitScreen(id, animate)
      else fitAll(animate)
      renderFloat()
    }

    function step(delta) {
      const order = placed.map((item) => item.screen.id)
      const at = order.indexOf(S.focus)
      const id = at < 0 ? order[0] : order[(at + delta + order.length) % order.length]
      setFocus(id)
      items.get(id).el.focus({ preventScroll: true })
    }

    function stepRow(delta) {
      const from = items.get(S.focus) ?? items.get(placed[0].screen.id)
      const candidates = placed.filter((item) => item.row === from.row + delta)
      if (!candidates.length) return
      const middle = from.x + from.width / 2
      const nearest = candidates.reduce((best, item) =>
        Math.abs(item.x + item.width / 2 - middle) < Math.abs(best.x + best.width / 2 - middle) ? item : best
      )
      setFocus(nearest.screen.id)
      items.get(nearest.screen.id).el.focus({ preventScroll: true })
    }

    let drag = null
    surface.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return
      drag = {
        x: event.clientX,
        y: event.clientY,
        cx: cam.x,
        cy: cam.y,
        moved: false,
        id: event.target.closest('.screen')?.dataset.screen ?? null,
      }
      surface.setPointerCapture(event.pointerId)
    })
    surface.addEventListener('pointermove', (event) => {
      if (!drag) return
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (!drag.moved && Math.hypot(dx, dy) < 4) return
      drag.moved = true
      surface.classList.add('is-panning')
      cam.x = drag.cx + dx
      cam.y = drag.cy + dy
      fitted = false
      apply(false)
    })
    surface.addEventListener('pointerup', () => {
      if (!drag) return
      const { moved, id } = drag
      drag = null
      surface.classList.remove('is-panning')
      if (!moved && id !== S.focus) setFocus(id)
    })
    surface.addEventListener('dblclick', (event) => {
      const id = event.target.closest('.screen')?.dataset.screen
      if (id) void openScreen(id)
    })
    surface.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        const box = surface.getBoundingClientRect()
        if (event.ctrlKey || event.metaKey)
          zoomAt(event.clientX - box.left, event.clientY - box.top, Math.exp(-event.deltaY * 0.01))
        else {
          cam.x -= event.deltaX
          cam.y -= event.deltaY
          fitted = false
          apply(false)
        }
      },
      { passive: false }
    )
    surface.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'ArrowRight') step(1)
      else if (event.key === 'ArrowLeft') step(-1)
      else if (event.key === 'ArrowDown') stepRow(1)
      else if (event.key === 'ArrowUp') stepRow(-1)
      else if (event.key === 'Enter' && S.focus) void openScreen(S.focus)
      else if (event.key === '+' || event.key === '=') zoomCenter(1.25)
      else if (event.key === '-' || event.key === '_') zoomCenter(0.8)
      else if (event.key === '0') setFocus(null)
      else return
      event.preventDefault()
    })

    const controller = {
      surface,
      focus: (id) => setFocus(id),
      resize() {
        relayout()
        if (S.focus) fitScreen(S.focus, false)
        else if (fitted) fitAll(false)
      },
      controls(layer) {
        zoomLabel = h(
          'button',
          { type: 'button', class: 'zoom-level', title: t('zoomFitTitle'), onclick: () => setFocus(null) },
          `${Math.round(cam.z * 100)}%`
        )
        layer.append(
          h(
            'div',
            { class: 'zoom', role: 'group', 'aria-label': t('zoomGroup') },
            h(
              'button',
              {
                type: 'button',
                class: 'icon-button',
                'aria-label': t('zoomOut'),
                title: t('zoomOut'),
                onclick: () => zoomCenter(0.8),
              },
              icon('minus', 15)
            ),
            zoomLabel,
            h(
              'button',
              {
                type: 'button',
                class: 'icon-button',
                'aria-label': t('zoomIn'),
                title: t('zoomIn'),
                onclick: () => zoomCenter(1.25),
              },
              icon('plus', 15)
            ),
            h('span', { class: 'zoom-divider', 'aria-hidden': 'true' }),
            h(
              'button',
              { type: 'button', class: 'zoom-fit', title: t('zoomFitTitle'), onclick: () => setFocus(null) },
              t('zoomFit')
            )
          )
        )
        const focused = items.get(S.focus)
        if (!focused) return
        const at = placed.findIndex((item) => item.screen.id === S.focus)
        layer.append(
          h(
            'div',
            { class: 'screen-focus', role: 'group', 'aria-label': focused.screen.name },
            h(
              'span',
              { class: 'stepper' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'icon-button',
                  'aria-label': t('screenPrevious'),
                  title: t('screenPrevious'),
                  onclick: () => step(-1),
                },
                icon('left', 15)
              ),
              h('span', { class: 'stepper-at' }, t('threadAt', { n: at + 1, total: placed.length })),
              h(
                'button',
                {
                  type: 'button',
                  class: 'icon-button',
                  'aria-label': t('screenNext'),
                  title: t('screenNext'),
                  onclick: () => step(1),
                },
                icon('right', 15)
              )
            ),
            h(
              'span',
              { class: 'screen-focus-name' },
              h('b', {}, focused.screen.name),
              h('span', { class: 'screen-size' }, t('screenSize', { width: focused.width, height: focused.height }))
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'button small primary',
                title: t('screenOpenTitle', { name: focused.screen.name }),
                onclick: () => void openScreen(focused.screen.id),
              },
              t('screenOpen'),
              h('kbd', {}, '↵')
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-button',
                'aria-label': t('screenUnfocus'),
                title: t('screenUnfocus'),
                onclick: () => setFocus(null),
              },
              icon('close', 15)
            )
          )
        )
      },
      destroy() {
        clearTimeout(liveTimer)
        for (const entry of items.values()) unload(entry)
        surface.remove()
      },
    }

    for (const entry of items.values()) placeholderState(entry, 'idle')
    requestAnimationFrame(() => setFocus(S.focus, false))
    return controller
  }

  // ---------------------------------------------------------------- keys
  function setFull(on) {
    S.full = on
    render()
  }

  function escape() {
    if (current) return closePopover()
    if (S.dialog) return
    if (escapeCard()) return
    if (S.selection && S.mode === 'inspect') return clearSelection()
    if (S.mode === 'inspect') return toggleInspect(false)
    if (S.mode === 'comment') return toggleComment()
    if (S.view === 'screens' && S.focus) return screens?.focus(null)
    if (S.full) setFull(false)
  }

  function onKey(key) {
    if (key === 'Escape') return escape()
    if (S.dialog) return
    if (key === 'c') toggleComment()
    else if (key === 'f') setFull(!S.full)
    else if (key === 'i') toggleInspect()
    else if (key === 's') toggleScreens()
    else if (key === 't') togglePanel('tokens')
  }

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const typing =
      event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]') !== null
    if (event.key === 'Escape') {
      if (!event.defaultPrevented) onKey('Escape')
      return
    }
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    if (!typing && ['c', 'f', 'i', 's', 't'].includes(key)) onKey(key)
  })
  window.addEventListener('resize', () => closePopover(false))

  // ---------------------------------------------------------------- states
  const OWNER_CHANGES = [
    ['--color-accent', '#4054B2'],
    ['--color-accent-soft', '#E6E9F8'],
    ['--radius-md', '14px'],
  ]
  const DARK_CHANGE = ['dark:--color-accent', '#8C9BF2']
  const SUGGESTION = (note = true) => ({
    author: { kind: 'invited', name: GUEST },
    body: note ? 'A deep teal accent and rounder buttons read better on the delivery screens.' : '',
    createdAt: NOW - 70 * MIN,
    changes: [
      { key: '--color-accent', from: '#b4532a', to: '#0F766E' },
      { key: 'dark:--color-accent', from: '#e07a4b', to: '#2DB5A6' },
      { key: '--radius-md', from: '10px', to: '14px' },
    ],
    applied: null,
  })
  const NOTE = 'Indigo reads calmer next to the status badges. Rounder buttons too?'
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let firstLoad = null
  const withChanges = () => {
    for (const [name, value] of OWNER_CHANGES) S.changes.set(name, value)
    S.panel = 'tokens'
  }
  const tokensReady = async () => {
    await loadTokens()
    renderSide()
    bar.update()
  }
  const selectButton = async () => {
    await firstLoad
    const picked = next(main, 'pick')
    send(main, { type: 'select', selector: '[data-ds="Button"]', index: 1 })
    await picked
  }
  const settleUsage = async () => {
    for (
      let i = 0;
      i < 100 && Object.values(S.usage?.rows ?? {}).some((row) => /queued|measuring/.test(row.status));
      i++
    )
      await wait(100)
  }
  /** Version 4, saved by the owner after the suggestion was made, changes one of its tokens. */
  const newerVersion = () => {
    S.artifact.versions.push({ number: 4, summary: 'Tokens: --radius-md', createdAt: NOW - 12 * MIN })
    S.saved.set('--radius-md', '12px')
    S.current = 4
    S.version = 4
  }
  const thread =
    (preview, note = true) =>
    () => {
      S.suggestion = SUGGESTION(note)
      S.listOpen = !narrow()
      S.card = 'thread'
      S.previewSuggestion = preview
    }
  const saving = async (kind) => {
    await tokensReady()
    openSave(kind)
    await save()
  }

  const STATES = [
    { id: 'page', label: 'Page view, the design tools in the bar' },
    {
      id: 'inspect-hover',
      label: 'Inspect · pointing at a component',
      setup: () => (S.mode = 'inspect'),
      run: async () => {
        const laid = next(main, 'layout')
        send(main, { type: 'hover', selector: '[data-ds="OrderRow"]', index: 1 })
        await laid
      },
    },
    {
      id: 'inspect-instance',
      label: 'Inspect · an instance selected',
      setup: () => (S.mode = 'inspect'),
      run: async () => {
        await tokensReady()
        await selectButton()
      },
    },
    {
      id: 'inspect-nested',
      label: 'Inspect · a component inside another',
      setup: () => (S.mode = 'inspect'),
      run: async () => {
        await tokensReady()
        const picked = next(main, 'pick')
        send(main, { type: 'select', selector: '[data-ds="OrderRow"] [data-ds="Badge"]', index: 0 })
        await picked
      },
    },
    {
      id: 'inspect-main',
      label: 'Inspect · the main component and its uses',
      setup: () => (S.mode = 'inspect'),
      run: async () => {
        await tokensReady()
        await selectButton()
        await goToMain()
        await settleUsage()
      },
    },
    {
      id: 'inspect-main-counting',
      label: 'Inspect · measuring the uses, screen by screen',
      setup: () => {
        S.mode = 'inspect'
        S.freezeCount = 3
      },
      run: async () => {
        await tokensReady()
        await selectButton()
        await goToMain()
        for (let i = 0; i < 80; i++) {
          const rows = Object.values(S.usage?.rows ?? {})
          if (
            rows.filter((row) => row.status === 'done').length >= 3 &&
            rows.filter((row) => row.status === 'measuring').length >= 2
          )
            break
          await wait(100)
        }
      },
    },
    {
      id: 'inspect-uses',
      label: 'Inspect · the uses on one screen',
      setup: () => (S.mode = 'inspect'),
      run: async () => {
        await tokensReady()
        await selectButton()
        await goToMain()
        await settleUsage()
        await showUses('Button', 'orders-empty')
      },
    },
    {
      id: 'inspect-plain',
      label: 'Inspect · a page without the contract',
      setup: () => {
        S.artifact = ARTIFACTS.plain
        S.version = 1
        S.current = 1
        S.page = { kind: 'entry' }
        S.mode = 'inspect'
      },
      run: async () => {
        const picked = next(main, 'pick')
        send(main, { type: 'select', selector: '.dish', index: 0 })
        await picked
      },
    },
    { id: 'screens', label: 'Screens · every screen', setup: () => (S.view = 'screens'), run: () => wait(1500) },
    {
      id: 'screens-focus',
      label: 'Screens · one screen in focus',
      setup: () => {
        S.view = 'screens'
        S.focus = 'order-detail'
      },
      run: () => wait(1500),
    },
    {
      id: 'screens-loading',
      label: 'Screens · loading and a failed screen',
      setup: () => {
        S.view = 'screens'
        S.forced = { orders: 'loading', 'order-mobile': 'loading', 'sync-error': 'failed' }
      },
      run: () => wait(1500),
    },
    { id: 'tokens', label: 'Tokens · no changes', setup: () => (S.panel = 'tokens'), run: tokensReady },
    {
      id: 'tokens-loading',
      label: 'Tokens · reading the file',
      setup: () => {
        S.panel = 'tokens'
        S.tokens = { status: 'loading', list: [], themes: [] }
      },
    },
    {
      id: 'tokens-error',
      label: 'Tokens · the file could not be read',
      setup: () => {
        S.panel = 'tokens'
        S.tokens = { status: 'error', list: [], themes: [] }
      },
    },
    { id: 'tokens-changes', label: 'Tokens · changes previewed', setup: withChanges, run: tokensReady },
    {
      id: 'tokens-theme',
      label: 'Tokens · editing the dark theme',
      setup: () => {
        withChanges()
        S.changes.set(...DARK_CHANGE)
        S.theme = 'dark'
      },
      run: tokensReady,
    },
    {
      id: 'tokens-screens',
      label: 'Tokens · the preview on every screen',
      setup: () => {
        withChanges()
        S.view = 'screens'
      },
      run: async () => {
        await tokensReady()
        await wait(1500)
      },
    },
    {
      id: 'tokens-save',
      label: 'Tokens · the owner confirms a new version',
      setup: withChanges,
      run: async () => {
        await tokensReady()
        openSave('save')
      },
    },
    {
      id: 'tokens-saving',
      label: 'Tokens · saving',
      setup: () => {
        withChanges()
        S.freezeSave = 'saving'
      },
      run: () => saving('save'),
    },
    { id: 'tokens-saved', label: 'Tokens · saved as a new version', setup: withChanges, run: () => saving('save') },
    {
      id: 'tokens-conflict',
      label: 'Tokens · a newer version was published',
      setup: () => {
        withChanges()
        S.freezeSave = 'conflict'
      },
      run: () => saving('save'),
    },
    {
      id: 'tokens-guest',
      label: 'Tokens · an invited person’s changes',
      setup: () => {
        S.identity = 'guest'
        withChanges()
      },
      run: tokensReady,
    },
    {
      id: 'tokens-suggest',
      label: 'Tokens · an invited person suggests them',
      setup: () => {
        S.identity = 'guest'
        S.suggestNote = NOTE
        withChanges()
      },
      run: async () => {
        await tokensReady()
        openSuggest()
      },
    },
    {
      id: 'tokens-suggest-sent',
      label: 'Tokens · the suggestion was sent',
      setup: () => {
        S.identity = 'guest'
        S.suggestNote = NOTE
        withChanges()
      },
      run: async () => {
        await tokensReady()
        openSuggest()
        cardEl.querySelector('form').requestSubmit()
        await wait(50)
      },
    },
    {
      id: 'tokens-readonly',
      label: 'Tokens · comments are off',
      setup: () => {
        S.identity = 'guest'
        S.canComment = false
        withChanges()
      },
      run: tokensReady,
    },
    {
      id: 'thread-suggestion',
      label: 'Comments · a suggestion the owner can apply',
      setup: thread(false),
      run: tokensReady,
    },
    { id: 'thread-preview', label: 'Comments · previewing a suggestion', setup: thread(true), run: tokensReady },
    {
      id: 'thread-apply',
      label: 'Comments · applying a suggestion',
      setup: thread(true),
      run: async () => {
        await tokensReady()
        openSave('apply')
      },
    },
    {
      id: 'thread-applied',
      label: 'Comments · the suggestion was applied',
      setup: thread(true),
      run: () => saving('apply'),
    },
    {
      id: 'thread-summary',
      label: 'Comments · a suggestion sent without a note',
      setup: thread(false, false),
      run: tokensReady,
    },
    {
      id: 'thread-stale',
      label: 'Comments · a suggestion over values that changed since',
      setup: () => {
        thread(false)()
        newerVersion()
      },
      run: tokensReady,
    },
    {
      id: 'thread-apply-stale',
      label: 'Comments · applying fails, a token changed meanwhile',
      setup: () => {
        thread(false)()
        S.freezeSave = 'stale'
      },
      run: () => saving('apply'),
    },
  ]

  // ---------------------------------------------------------------- the prototype's own state picker (not to port)
  function statePicker(active) {
    if (CAPTURE) return
    const menu = h(
      'div',
      { class: 'proto-states-menu', hidden: true },
      STATES.map((state) =>
        h(
          'a',
          {
            class: 'proto-states-item',
            href: `#${state.id}`,
            'aria-current': state.id === active.id ? 'true' : undefined,
          },
          h('code', {}, state.id),
          h('span', {}, state.label)
        )
      )
    )
    const button = h(
      'button',
      { type: 'button', class: 'proto-states-button', 'aria-expanded': 'false' },
      h('span', { class: 'proto-states-tag' }, 'Prototype'),
      h('span', {}, active.label),
      icon('up', 14)
    )
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true'
      menu.hidden = !open
      button.setAttribute('aria-expanded', String(open))
    })
    document.body.append(h('nav', { class: 'proto-states', 'aria-label': 'Prototype states' }, menu, button))
  }

  async function boot() {
    try {
      probeSource = await (await fetch('probe.js')).text()
      S.manifest = readManifest(await (await fetch('sample/maestrly-design.json')).json())
    } catch {
      S.manifest = null
    }
    const state = STATES.find((item) => item.id === location.hash.slice(1)) ?? STATES[0]
    state.setup?.()
    renderViewer()
    firstLoad = showPage(S.page)
    statePicker(state)
    try {
      await firstLoad
      await state.run?.()
    } catch (error) {
      console.warn('state did not settle', state.id, error)
    } finally {
      await wait(300)
      document.documentElement.dataset.ready = state.id
    }
  }

  window.addEventListener('hashchange', () => location.reload())
  void boot()
})()
