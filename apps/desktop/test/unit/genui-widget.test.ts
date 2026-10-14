import vm from 'node:vm'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { APP_CONTENT_SECURITY_POLICY, appPolicyHeaders } from '../../src/main/content-security-policy'
import { PRIVILEGED_SCHEMES } from '../../src/main/privileged-schemes'
import { GenUiContext, type GenUiHost } from '../../src/renderer/genui/context'
import { GenUiIssues } from '../../src/renderer/genui/GenUiIssues'
import { HtmlWidgetBlock, hasTransientActivation } from '../../src/renderer/genui/HtmlWidgetBlock'
import { addGenUiIssue, MAX_GENUI_ISSUES } from '../../src/renderer/genui/issues'
import {
  GENUI_WIDGET_FRAME_URL,
  GENUI_WIDGET_MAX_CHARS,
  GENUI_WIDGET_MAX_HEIGHT,
  GENUI_WIDGET_MAX_SEND_CHARS,
  parseGenUiWidgetMessage,
} from '../../src/shared/genui-widget'
import {
  GENUI_WIDGET_BASE_CSS,
  GENUI_WIDGET_CSP,
  GENUI_WIDGET_FRAME_HTML,
  genUiWidgetFrameResponse,
} from '../../src/shared/genui-widget-frame'

const message = (fields: Record<string, unknown>) => ({ source: 'maestrly-widget', ...fields })

describe('inline HTML frame messages', () => {
  it('accepts only the frame envelope and known types', () => {
    expect(parseGenUiWidgetMessage(null)).toBeNull()
    expect(parseGenUiWidgetMessage('ready')).toBeNull()
    expect(parseGenUiWidgetMessage({ type: 'ready' })).toBeNull()
    expect(parseGenUiWidgetMessage(message({ type: 'render', html: '<b>x</b>' }))).toBeNull()
    expect(parseGenUiWidgetMessage(message({ type: 'ready' }))).toEqual({ type: 'ready' })
    expect(parseGenUiWidgetMessage(message({ type: 'loaded' }))).toEqual({ type: 'loaded' })
  })

  it('bounds heights and the text a frame sends', () => {
    expect(parseGenUiWidgetMessage(message({ type: 'size', height: 321.2 }))).toEqual({ type: 'size', height: 322 })
    expect(parseGenUiWidgetMessage(message({ type: 'size', height: 1e9 }))).toEqual({
      type: 'size',
      height: GENUI_WIDGET_MAX_HEIGHT,
    })
    for (const height of [-1, Number.NaN, Infinity, '200'])
      expect(parseGenUiWidgetMessage(message({ type: 'size', height }))).toBeNull()
    expect(parseGenUiWidgetMessage(message({ type: 'send', text: '  Tell me more  ' }))).toEqual({
      type: 'send',
      text: 'Tell me more',
    })
    expect(parseGenUiWidgetMessage(message({ type: 'send', text: '   ' }))).toBeNull()
    expect(
      parseGenUiWidgetMessage(message({ type: 'send', text: 'x'.repeat(GENUI_WIDGET_MAX_SEND_CHARS + 1) }))
    ).toBeNull()
    expect(parseGenUiWidgetMessage(message({ type: 'issue', kind: 'script', detail: 'e'.repeat(500) }))).toEqual({
      type: 'issue',
      kind: 'script',
      detail: 'e'.repeat(300),
    })
    for (const issue of [{ kind: 'nonsense', detail: 'x' }, { kind: 'image' }, { kind: 'toString', detail: 'x' }])
      expect(parseGenUiWidgetMessage(message({ type: 'issue', ...issue }))).toBeNull()
    expect(parseGenUiWidgetMessage(message({ type: 'error', message: 'old protocol' }))).toBeNull()
  })

  it('opens only web addresses without credentials', () => {
    expect(parseGenUiWidgetMessage(message({ type: 'open', url: 'https://example.com/a?b=1' }))).toEqual({
      type: 'open',
      url: 'https://example.com/a?b=1',
    })
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'maestrly-widget://frame/',
      'https://user:pass@example.com/',
      'not a url',
    ])
      expect(parseGenUiWidgetMessage(message({ type: 'open', url })), url).toBeNull()
  })
})

describe('inline HTML frame page', () => {
  it('is served at its one URL with its own policy', () => {
    const response = genUiWidgetFrameResponse({ method: 'GET', url: GENUI_WIDGET_FRAME_URL })
    expect(response.status).toBe(200)
    expect(response.body).toBe(GENUI_WIDGET_FRAME_HTML)
    expect(response.headers['content-security-policy']).toBe(GENUI_WIDGET_CSP)
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    for (const request of [
      { method: 'POST', url: GENUI_WIDGET_FRAME_URL },
      { method: 'GET', url: 'maestrly-widget://frame/other' },
      { method: 'GET', url: 'maestrly-widget://other/' },
      { method: 'GET', url: 'maestrly-widget://frame/?html=x' },
      { method: 'GET', url: '::' },
    ])
      expect(genUiWidgetFrameResponse(request).status, request.url).toBe(404)
  })

  it('gives blocks scripts and web images, but no network, frames, forms or plugins', () => {
    const directives = Object.fromEntries(
      GENUI_WIDGET_CSP.split('; ').map((directive) => {
        const [name, ...values] = directive.split(' ')
        return [name, values.join(' ')]
      })
    )
    expect(directives.sandbox).toBe('allow-scripts')
    expect(directives['default-src']).toBe("'none'")
    expect(directives['connect-src']).toBe("'none'")
    expect(directives['frame-src']).toBe("'none'")
    expect(directives['form-action']).toBe("'none'")
    expect(directives['object-src']).toBe("'none'")
    expect(directives['img-src']).toBe('https: data: blob:')
    expect(directives['script-src']).toContain("'unsafe-inline'")
    expect(directives['script-src']).not.toMatch(/\bhttps:(\s|$)/)
  })

  it('holds a single script element', () => {
    // Inside a script element only `</script` and `<!--` change how the HTML parser reads on.
    expect(GENUI_WIDGET_FRAME_HTML.split('</script')).toHaveLength(2)
    expect(GENUI_WIDGET_FRAME_HTML).not.toContain('<!--')
  })
})

describe('inline HTML frame styles', () => {
  /** Each rule of the stylesheet as [selector, declarations]. */
  const rules = GENUI_WIDGET_BASE_CSS.split('}')
    .filter((rule) => rule.includes('{'))
    .map((rule) => rule.split('{') as [string, string])

  it('never outweighs the block: every element and class rule has no specificity', () => {
    // Only the document itself, the box model reset and failed-image placeholders are styled directly.
    const direct = new Set([':root', '*,*::before,*::after', 'html,body', 'body', 'img[data-ui-failed]'])
    for (const [selector] of rules) {
      if (direct.has(selector)) continue
      expect(selector, selector).toMatch(/^:where\(.*\)(>\*)?$/)
    }
  })

  it('styles plain elements, and no class but the scroll box the bridge wraps wide tables in', () => {
    expect(GENUI_WIDGET_BASE_CSS).toContain(':where(button){')
    expect(GENUI_WIDGET_BASE_CSS).toContain(':where(table){')
    expect(new Set(GENUI_WIDGET_BASE_CSS.match(/\.[a-z][\w-]*/g))).toEqual(new Set(['.ui-scroll']))
  })

  it('cannot end the style element it is written into', () => {
    expect(GENUI_WIDGET_BASE_CSS).not.toContain('</')
    expect(GENUI_WIDGET_BASE_CSS).not.toContain('<!--')
  })
})

/** Runs the frame page's script against a minimal window: its parent, listeners and the document it writes. */
function runShell(extra: Record<string, unknown> = {}) {
  const script = /<script>([\s\S]*)<\/script>/.exec(GENUI_WIDGET_FRAME_HTML)![1]
  const posted: unknown[] = []
  const parent = { postMessage: (data: unknown) => posted.push(data) }
  const listeners = new Map<string, (event: unknown) => void>()
  let written = ''
  const document = {
    open: () => {
      written = ''
    },
    write: (html: string) => {
      written += html
    },
    close: () => {},
  }
  const window = {
    parent,
    top: parent,
    document,
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    removeEventListener: (type: string, listener: unknown) => {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
    ...extra,
  }
  vm.runInNewContext(script, { window, document })
  return {
    parent,
    posted,
    written: () => written,
    listening: () => listeners.has('message'),
    dispatch: (event: unknown) => listeners.get('message')?.(event),
  }
}

const render = (html: string, theme: Record<string, unknown> = {}) => ({
  source: 'maestrly-host',
  type: 'render',
  html,
  theme,
})

describe('inline HTML frame script', () => {
  it('announces itself, then writes the first block its parent sends', () => {
    const frame = runShell()
    expect(frame.posted).toEqual([{ source: 'maestrly-widget', type: 'ready' }])
    frame.dispatch({ source: {}, data: render('<p>impostor</p>') })
    frame.dispatch({ source: frame.parent, data: { ...render('<p>x</p>'), source: 'someone' } })
    expect(frame.written()).toBe('')
    frame.dispatch({ source: frame.parent, data: render('<p id="answer">Hello</p>') })
    const document = frame.written()
    expect(document.startsWith('<!doctype html><html><head><meta charset="utf-8"><style>:root{')).toBe(true)
    expect(document).toContain("Object.defineProperty(window, 'maestrly'")
    expect(document.endsWith('<body><p id="answer">Hello</p></body></html>')).toBe(true)
    expect(frame.listening()).toBe(false)
  })

  it('takes the block from the opener of a separate chat window', () => {
    const opener = { postMessage: () => {} }
    const frame = runShell({ top: { opener } })
    frame.dispatch({ source: opener, data: render('<p>from the main window</p>') })
    expect(frame.written()).toContain('<p>from the main window</p>')
  })

  it('keeps only theme values that cannot leave their declaration', () => {
    const frame = runShell()
    frame.dispatch({
      source: frame.parent,
      data: render('<p>x</p>', {
        text: 'rgba(237, 234, 227, 0.96)',
        font: '"SF Pro Text", sans-serif',
        accent: 'red;}body{display:none',
        muted: '</style><script>alert(1)</script>',
        radius: 12,
        bogus: 'blue',
      }),
    })
    const document = frame.written()
    expect(document).toContain(':root{--ui-text:rgba(237, 234, 227, 0.96);--ui-font:"SF Pro Text", sans-serif;}')
    expect(document).not.toContain('display:none')
    expect(document).not.toContain('alert(1)')
    expect(document).not.toContain('--ui-bogus')
  })
})

interface FakeImage {
  tagName: 'IMG'
  src: string
  currentSrc: string
  attributes: Map<string, string>
  parentElement: { tagName: string; querySelectorAll: () => { remove: () => void }[] } | null
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

function fakeImage(src: string, parentElement: FakeImage['parentElement'] = null): FakeImage {
  const attributes = new Map([
    ['src', src],
    ['srcset', `${src} 2x`],
  ])
  return {
    tagName: 'IMG',
    src,
    currentSrc: src,
    attributes,
    parentElement,
    hasAttribute: (name) => attributes.has(name),
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  }
}

/**
 * Runs the bridge the frame writes before the block against a minimal window: its storage refused as in an opaque
 * origin, timers run by hand, and a page whose height follows `contentHeight`.
 */
function runBridge(page: { contentHeight?: (viewportHeight: number) => number; scrollbar?: number } = {}) {
  const frame = runShell()
  frame.dispatch({ source: frame.parent, data: render('') })
  const bridge = /<script>([\s\S]*)<\/script><\/head>/.exec(frame.written())![1]
  const posted: Record<string, unknown>[] = []
  const listeners = new Map<string, (event: unknown) => void>()
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const refused = {
    get: () => {
      throw new Error('SecurityError')
    },
    configurable: true,
  }
  const window: Record<string, unknown> = {
    parent: { postMessage: (data: Record<string, unknown>) => posted.push(data) },
    innerWidth: 700,
    innerHeight: 160,
  }
  Object.defineProperty(window, 'localStorage', refused)
  Object.defineProperty(window, 'sessionStorage', refused)
  const contentHeight = page.contentHeight ?? (() => 240.4)
  const document = {
    documentElement: {
      getBoundingClientRect: () => ({ height: contentHeight(window.innerHeight as number) }),
      get clientHeight() {
        return (window.innerHeight as number) - (page.scrollbar ?? 0)
      },
      scrollWidth: 700,
      clientWidth: 700,
      style: { overflowY: '' },
    },
    body: { scrollHeight: 100, getElementsByTagName: () => [] },
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(`document:${type}`, listener),
  }
  window.addEventListener = (type: string, listener: (event: unknown) => void) => listeners.set(type, listener)
  vm.runInNewContext(bridge, {
    window,
    document,
    setTimeout: (callback: () => void) => {
      timers.set(nextTimer, callback)
      return nextTimer++
    },
    clearTimeout: (id: number) => timers.delete(id),
    getComputedStyle: () => ({ overflowX: 'visible', overflowY: 'visible' }),
  })
  /** The host gives the frame the height it last asked for, which fires the frame's resize event. */
  const applyHeight = () => {
    const sizes = posted.filter((item) => item.type === 'size')
    window.innerHeight = sizes.at(-1)?.height
    listeners.get('resize')!({})
  }
  const runTimers = () => {
    const pending = [...timers.values()]
    timers.clear()
    for (const callback of pending) callback()
  }
  const issues = () => posted.filter((item) => item.type === 'issue')
  return { window: window as any, document, posted, listeners, applyHeight, runTimers, issues }
}

describe('inline HTML frame bridge', () => {
  it('sends messages and links to the host', () => {
    const { window, posted } = runBridge()
    window.maestrly.send('Tell me more')
    window.maestrly.openLink('https://example.com')
    expect(posted).toEqual([
      { source: 'maestrly-widget', type: 'send', text: 'Tell me more' },
      { source: 'maestrly-widget', type: 'open', url: 'https://example.com' },
    ])
    expect(Object.isFrozen(window.maestrly)).toBe(true)
  })

  it('opens clicked links in the browser instead of navigating the frame', () => {
    const { posted, listeners } = runBridge()
    let prevented = false
    const link = { getAttribute: () => 'https://example.com/item', href: 'https://example.com/item' }
    listeners.get('document:click')!({ target: { closest: () => link }, preventDefault: () => (prevented = true) })
    expect(prevented).toBe(true)
    expect(posted).toContainEqual({ source: 'maestrly-widget', type: 'open', url: 'https://example.com/item' })
    const anchor = { getAttribute: () => '#details', href: 'maestrly-widget://frame/#details' }
    prevented = false
    listeners.get('document:click')!({ target: { closest: () => anchor }, preventDefault: () => (prevented = true) })
    expect(prevented).toBe(false)
  })

  it('replaces refused storage with one that lasts until the page reloads', () => {
    const { window } = runBridge()
    window.localStorage.setItem('seats', 9)
    expect(window.localStorage.getItem('seats')).toBe('9')
    expect(window.localStorage.length).toBe(1)
    expect(window.sessionStorage.getItem('seats')).toBeNull()
  })

  it('reports the height of its content once it is known', () => {
    const { posted, listeners } = runBridge()
    listeners.get('load')!({})
    listeners.get('document:DOMContentLoaded')!({})
    expect(posted.filter((item) => item.type === 'size')).toEqual([
      { source: 'maestrly-widget', type: 'size', height: 241 },
    ])
  })

  it('says it loaded after checking the loaded page, so a preview waits for its problems', () => {
    const { posted, listeners, runTimers } = runBridge()
    listeners.get('error')!({ message: 'Uncaught TypeError: x is undefined' })
    listeners.get('load')!({})
    expect(posted.some((item) => item.type === 'loaded')).toBe(false)
    runTimers()
    expect(posted.map((item) => item.type)).toEqual(['issue', 'size', 'loaded'])
  })

  it('never scrolls down, unless the block is taller than the frame can grow', () => {
    let height = 300
    const { document, listeners } = runBridge({ contentHeight: () => height })
    listeners.get('load')!({})
    expect(document.documentElement.style.overflowY).toBe('')
    height = GENUI_WIDGET_MAX_HEIGHT + 500
    listeners.get('load')!({})
    expect(document.documentElement.style.overflowY).toBe('auto')
    expect(GENUI_WIDGET_BASE_CSS).toContain(':where(html){overflow-y:hidden}')
  })

  it('asks for the height of a horizontal scrollbar too, so no vertical one appears', () => {
    const { posted, listeners } = runBridge({ scrollbar: 15 })
    listeners.get('load')!({})
    expect(posted.filter((item) => item.type === 'size')).toEqual([
      { source: 'maestrly-widget', type: 'size', height: 256 },
    ])
  })

  it('replaces an image that did not load with a placeholder, once', () => {
    const { listeners, issues } = runBridge()
    const removed: string[] = []
    const picture = {
      tagName: 'PICTURE',
      querySelectorAll: () => [{ remove: () => removed.push('webp') }, { remove: () => removed.push('avif') }],
    }
    const image = fakeImage('https://images.example.com/missing.jpg', picture)
    listeners.get('document:error')!({ target: image })
    expect(image.src.startsWith('data:image/svg+xml,')).toBe(true)
    expect(image.hasAttribute('data-ui-failed')).toBe(true)
    expect(image.hasAttribute('srcset')).toBe(false)
    expect(removed).toEqual(['webp', 'avif'])
    // The placeholder itself never counts as a second failure
    listeners.get('document:error')!({ target: image })
    listeners.get('document:error')!({ target: { tagName: 'SCRIPT' } })
    expect(issues()).toEqual([
      { source: 'maestrly-widget', type: 'issue', kind: 'image', detail: 'https://images.example.com/missing.jpg' },
    ])
  })

  it('reports script errors, rejected promises and blocked requests once each', () => {
    const { listeners, issues } = runBridge()
    listeners.get('error')!({ message: 'Uncaught ReferenceError: chart is not defined' })
    listeners.get('error')!({ message: 'Uncaught ReferenceError: chart is not defined' })
    listeners.get('unhandledrejection')!({ reason: new Error('Failed to fetch') })
    listeners.get('document:securitypolicyviolation')!({
      effectiveDirective: 'connect-src',
      blockedURI: 'https://api.example.com/prices',
    })
    expect(issues().map((item) => [item.kind, item.detail])).toEqual([
      ['script', 'Uncaught ReferenceError: chart is not defined'],
      ['script', 'Failed to fetch'],
      ['blocked', 'connect-src https://api.example.com/prices'],
    ])
  })

  it('lists at most twenty issues', () => {
    const { listeners, issues } = runBridge()
    for (let i = 0; i < 30; i++) listeners.get('error')!({ message: `error ${i}` })
    expect(issues()).toHaveLength(20)
  })

  it('stops growing a layout sized by the frame itself, and says so', () => {
    // height: calc(100vh + 20px): every height the host applies makes the content 20 px taller
    const { posted, listeners, applyHeight, issues } = runBridge({ contentHeight: (viewport) => viewport + 20 })
    listeners.get('load')!({})
    for (let i = 0; i < 10; i++) applyHeight()
    expect(posted.filter((item) => item.type === 'size').map((item) => item.height)).toEqual([180, 200, 220])
    expect(issues().map((item) => item.kind)).toEqual(['viewport'])
  })

  it('keeps following content that grows on its own', () => {
    let height = 200
    const { posted, listeners, applyHeight, issues } = runBridge({ contentHeight: () => height })
    listeners.get('load')!({})
    for (let i = 0; i < 6; i++) {
      height += 50
      listeners.get('load')!({})
      applyHeight()
    }
    expect(posted.filter((item) => item.type === 'size').map((item) => item.height)).toEqual([
      200, 250, 300, 350, 400, 450, 500,
    ])
    expect(issues()).toEqual([])
  })
})

describe('inline HTML block', () => {
  const block = (host: GenUiHost, code: string, complete: boolean) =>
    renderToString(
      createElement(GenUiContext.Provider, { value: host }, createElement(HtmlWidgetBlock, { code, complete }))
    )

  it('waits for its closing fence while the message streams, then frames the block', () => {
    expect(block({ live: true }, '<p>half', false)).toContain('genUi.building')
    expect(block({ live: true }, '<p>half', false)).not.toContain('<iframe')
    for (const html of [block({ live: true }, '<p>done</p>', true), block({ live: false }, '<p>done</p>', false)]) {
      expect(html).toContain(`src="${GENUI_WIDGET_FRAME_URL}"`)
      expect(html).toContain('sandbox="allow-scripts"')
      expect(html).toMatch(/referrer[pP]olicy="no-referrer"/)
    }
  })

  it('says so when an answer names a preview its message does not hold', () => {
    const html = block({ live: false }, '', true)
    expect(html).toContain('genUi.missing')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('genUi.source')
  })

  it('shows the source of a block too large to frame', () => {
    const html = block({ live: false }, 'x'.repeat(GENUI_WIDGET_MAX_CHARS + 1), true)
    expect(html).not.toContain('<iframe')
    expect(html).toContain('genUi.tooLong')
  })

  it('acts only right after the person interacted with the window', () => {
    const view = (isActive?: boolean) =>
      ({ navigator: isActive === undefined ? {} : { userActivation: { isActive } } }) as unknown as Window
    expect(hasTransientActivation(view(true))).toBe(true)
    expect(hasTransientActivation(view(false))).toBe(false)
    expect(hasTransientActivation(view())).toBe(false)
  })
})

describe('app windows and the frame', () => {
  it('lets app pages frame the scheme and leaves the frame its own policy', () => {
    expect(APP_CONTENT_SECURITY_POLICY).toContain("frame-src 'self' maestrly-widget:")
    expect(APP_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
    expect(appPolicyHeaders(GENUI_WIDGET_FRAME_URL, { 'content-security-policy': [GENUI_WIDGET_CSP] })).toBeNull()
    expect(appPolicyHeaders('file:///app/index.html', { 'x-test': ['1'] })).toEqual({
      'x-test': ['1'],
      'Content-Security-Policy': [APP_CONTENT_SECURITY_POLICY],
    })
  })

  it('declares every privileged scheme in one list', () => {
    expect(PRIVILEGED_SCHEMES.map((entry) => entry.scheme)).toEqual(['maestrly-media', 'maestrly-widget'])
    expect(PRIVILEGED_SCHEMES[1].privileges).toEqual({ standard: true, secure: true })
  })
})

describe('inline HTML block problems', () => {
  it('keeps each problem once and at most a fixed number', () => {
    let issues = addGenUiIssue([], { kind: 'image', detail: 'a.jpg' })
    expect(addGenUiIssue(issues, { kind: 'image', detail: 'a.jpg' })).toBe(issues)
    for (let i = 0; i < 40; i++) issues = addGenUiIssue(issues, { kind: 'image', detail: `${i}.jpg` })
    expect(issues).toHaveLength(MAX_GENUI_ISSUES)
  })

  it('folds the list under one line, and shows nothing without problems', () => {
    expect(renderToString(createElement(GenUiIssues, { issues: [] }))).toBe('')
    const html = renderToString(createElement(GenUiIssues, { issues: [{ kind: 'clipped', detail: 'div.card' }] }))
    expect(html).toContain('<details class="genui-issues')
    expect(html).toContain('genUi.issues.summary')
    expect(html).toContain('genUi.issues.clipped')
  })
})
