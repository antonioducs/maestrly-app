import { describe, expect, it, vi } from 'vitest'
import type { ArtifactApi } from '../src/shell/api.js'
import {
  parseBridgeMessage,
  type DesignScreen,
  type PublicComment,
  type ShellMessage,
  type ViewerDesign,
  type ViewerState,
} from '../src/shell/contract.js'
import { createDesignController } from '../src/shell/design.js'
import {
  canApplySuggestion,
  canSaveTokens,
  canSuggestTokens,
  classifyTokenValue,
  diffTokens,
  groupOfToken,
  groupTokens,
  mergeInspectedTokens,
  resolveScreenViewport,
  screenFrameUrl,
  selectLiveScreens,
  tokenDraftKey,
} from '../src/shell/design-model.js'

describe('parseBridgeMessage design protocol validation', () => {
  const validStyles = {
    fontFamily: 'Inter, sans-serif',
    fontSize: '14px',
    fontWeight: '500',
    lineHeight: '20px',
    color: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(37, 99, 235)',
    borderRadius: '8px',
    padding: '12px 16px',
  }
  const validRect = { x: 10, y: 20, width: 100, height: 40 }

  it('parses valid inspect-hover, inspect-pick, inventory, layout.inspectRect, and key "i"', () => {
    expect(parseBridgeMessage({ source: 'maestrly-bridge', type: 'key', key: 'i' })).toEqual({
      type: 'key',
      key: 'i',
    })
    expect(parseBridgeMessage({ source: 'maestrly-bridge', type: 'inspect-hover', target: null })).toEqual({
      type: 'inspect-hover',
      target: null,
    })
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-hover',
        target: { selector: 'button.primary', rect: validRect, tag: 'BUTTON', component: 'PrimaryButton', main: false },
      })
    ).toEqual({
      type: 'inspect-hover',
      target: { selector: 'button.primary', rect: validRect, tag: 'button', component: 'PrimaryButton', main: false },
    })

    const picked = parseBridgeMessage({
      source: 'maestrly-bridge',
      type: 'inspect-pick',
      target: {
        rect: validRect,
        selector: 'main > button:nth-of-type(1)',
        tag: 'button',
        component: 'PrimaryButton',
        props: { variant: 'solid', size: 'md' },
        main: true,
        styles: validStyles,
        tokens: [{ name: '--btn-bg', value: '#2563eb' }],
      },
    })
    expect(picked).toEqual({
      type: 'inspect-pick',
      target: {
        rect: validRect,
        selector: 'main > button:nth-of-type(1)',
        tag: 'button',
        component: 'PrimaryButton',
        props: { variant: 'solid', size: 'md' },
        main: true,
        styles: validStyles,
        tokens: [{ name: '--btn-bg', value: '#2563eb' }],
      },
    })

    const inv = parseBridgeMessage({
      source: 'maestrly-bridge',
      type: 'inventory',
      requestId: 'inv1',
      instances: { PrimaryButton: 3, Card: 0 },
      mains: ['PrimaryButton'],
    })
    expect(inv).toEqual({
      type: 'inventory',
      requestId: 'inv1',
      instances: { PrimaryButton: 3, Card: 0 },
      mains: ['PrimaryButton'],
    })

    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'layout',
        pins: {},
        width: 1200,
        height: 800,
        inspectRect: validRect,
      })
    ).toEqual({
      type: 'layout',
      pins: {},
      width: 1200,
      height: 800,
      inspectRect: validRect,
    })
  })

  it('rejects malformed, out-of-bounds, and prototype-polluting bridge payloads', () => {
    // Unforwarded key
    expect(parseBridgeMessage({ source: 'maestrly-bridge', type: 'key', key: 'x' })).toBeNull()

    // Bad component name in hover / pick / inventory
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-hover',
        target: { selector: 'div', rect: validRect, tag: 'div', component: 'bad_lower', main: false },
      })
    ).toBeNull()

    // Prototype pollution in props and instances must never pollute Object.prototype or pass invalid keys
    const protoProps = JSON.parse('{"__proto__":{"polluted":true},"constructor":"bad","variant":"primary"}') as Record<
      string,
      unknown
    >
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-pick',
        target: {
          rect: validRect,
          selector: 'button',
          tag: 'button',
          component: 'Btn',
          props: protoProps,
          main: false,
          styles: validStyles,
          tokens: [],
        },
      })
    ).toBeNull()

    // Whitespace in prop value rejected
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-pick',
        target: {
          rect: validRect,
          selector: 'button',
          tag: 'button',
          component: 'Btn',
          props: { variant: 'has space' },
          main: false,
          styles: validStyles,
          tokens: [],
        },
      })
    ).toBeNull()

    // > 64 inspected tokens rejected
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-pick',
        target: {
          rect: validRect,
          selector: 'button',
          tag: 'button',
          component: null,
          props: {},
          main: false,
          styles: validStyles,
          tokens: Array.from({ length: 65 }, (_, i) => ({ name: `--t-${i}`, value: '1px' })),
        },
      })
    ).toBeNull()

    // Inventory boundaries: negative, float, > 10_000, > 200 keys
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inventory',
        requestId: null,
        instances: { Btn: -1 },
        mains: [],
      })
    ).toBeNull()
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inventory',
        requestId: null,
        instances: { Btn: 10_001 },
        mains: [],
      })
    ).toBeNull()
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inventory',
        requestId: null,
        instances: { Btn: 1.5 },
        mains: [],
      })
    ).toBeNull()

    const tooManyInstances: Record<string, number> = {}
    for (let i = 0; i < 201; i++) tooManyInstances[`Comp${i}`] = 1
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inventory',
        requestId: null,
        instances: tooManyInstances,
        mains: [],
      })
    ).toBeNull()

    // Invalid inspectRect on layout
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'layout',
        pins: {},
        width: 800,
        height: 600,
        inspectRect: { ...validRect, width: Number.NaN },
      })
    ).toBeNull()
  })

  it('validates items 1-11 bridge fields across valid, exact-boundary, and over-boundary inputs', () => {
    // Item 11: forwarded keys include s and t, reject uppercase or unknown keys
    for (const k of ['Escape', 'c', 'f', 'i', 's', 't'] as const) {
      expect(parseBridgeMessage({ source: 'maestrly-bridge', type: 'key', key: k })).toEqual({ type: 'key', key: k })
    }
    for (const badKey of ['S', 'T', 'I', 'g', '', 12]) {
      expect(parseBridgeMessage({ source: 'maestrly-bridge', type: 'key', key: badKey })).toBeNull()
    }

    // Item 2: elementLabel (tag + up to 2 classes, max 80 chars)
    const exact80Label = `div.${'a'.repeat(76)}`
    expect(exact80Label).toHaveLength(80)
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-hover',
        target: {
          selector: 'div',
          rect: validRect,
          tag: 'div',
          elementLabel: exact80Label,
          component: null,
          main: false,
        },
      })
    ).toEqual({
      type: 'inspect-hover',
      target: {
        selector: 'div',
        rect: validRect,
        tag: 'div',
        elementLabel: exact80Label,
        component: null,
        main: false,
      },
    })
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-hover',
        target: {
          selector: 'h2',
          rect: validRect,
          tag: 'h2',
          elementLabel: 'h2.hero-title.muted',
          component: null,
          main: false,
        },
      })
    ).toEqual({
      type: 'inspect-hover',
      target: {
        selector: 'h2',
        rect: validRect,
        tag: 'h2',
        elementLabel: 'h2.hero-title.muted',
        component: null,
        main: false,
      },
    })
    for (const badLabel of [`div.${'a'.repeat(77)}`, 'div.one.two.three', 'div#id', 'div.bad space', '']) {
      expect(
        parseBridgeMessage({
          source: 'maestrly-bridge',
          type: 'inspect-hover',
          target: {
            selector: 'div',
            rect: validRect,
            tag: 'div',
            elementLabel: badLabel,
            component: null,
            main: false,
          },
        }),
        badLabel
      ).toBeNull()
    }

    // Items 1, 3, 6: chain (max 8), variants (max 32 when main=true), property, tokensFromManifest
    const chainAtLimit = Array.from({ length: 8 }, (_, i) => ({ component: `Comp${i}`, selector: `#anc-${i}` }))
    const variantsAtLimit = Array.from({ length: 32 }, (_, i) => `variant=v${i} size=md`)
    const maxPick = parseBridgeMessage({
      source: 'maestrly-bridge',
      type: 'inspect-pick',
      target: {
        rect: validRect,
        selector: '#btn',
        tag: 'button',
        elementLabel: 'button.primary',
        component: 'Button',
        props: { variant: 'v0' },
        main: true,
        styles: validStyles,
        tokens: [
          { name: '--btn-bg', value: '#2563eb', property: 'background-color' },
          { name: '--alias', value: '12px', property: '--local-gap' },
        ],
        chain: chainAtLimit,
        variants: variantsAtLimit,
        tokensFromManifest: true,
      },
    })
    expect(maxPick).toEqual({
      type: 'inspect-pick',
      target: {
        rect: validRect,
        selector: '#btn',
        tag: 'button',
        elementLabel: 'button.primary',
        component: 'Button',
        props: { variant: 'v0' },
        main: true,
        styles: validStyles,
        tokens: [
          { name: '--btn-bg', value: '#2563eb', property: 'background-color' },
          { name: '--alias', value: '12px', property: '--local-gap' },
        ],
        chain: chainAtLimit,
        variants: variantsAtLimit,
        tokensFromManifest: true,
      },
    })

    // Non-main target drops variants even if provided; over-limit chain (9) or variants (33) or bad property/tokensFromManifest rejected
    const nonMainWithVariants = parseBridgeMessage({
      source: 'maestrly-bridge',
      type: 'inspect-pick',
      target: {
        rect: validRect,
        selector: '#btn',
        tag: 'button',
        component: 'Button',
        props: {},
        main: false,
        styles: validStyles,
        tokens: [],
        variants: ['variant=v0'],
      },
    })
    expect(nonMainWithVariants).toEqual({
      type: 'inspect-pick',
      target: {
        rect: validRect,
        selector: '#btn',
        tag: 'button',
        component: 'Button',
        props: {},
        main: false,
        styles: validStyles,
        tokens: [],
      },
    })

    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-pick',
        target: {
          rect: validRect,
          selector: '#btn',
          tag: 'button',
          component: 'Button',
          props: {},
          main: true,
          styles: validStyles,
          tokens: [],
          chain: [...chainAtLimit, { component: 'Comp8', selector: '#anc-8' }],
        },
      })
    ).toBeNull()
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-pick',
        target: {
          rect: validRect,
          selector: '#btn',
          tag: 'button',
          component: 'Button',
          props: {},
          main: true,
          styles: validStyles,
          tokens: [],
          chain: [{ component: 'Button', selector: '#bad\u0000' }],
        },
      })
    ).toBeNull()
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-pick',
        target: {
          rect: validRect,
          selector: '#btn',
          tag: 'button',
          component: 'Button',
          props: {},
          main: true,
          styles: validStyles,
          tokens: [],
          variants: [...variantsAtLimit, 'variant=v32'],
        },
      })
    ).toBeNull()
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-pick',
        target: {
          rect: validRect,
          selector: '#btn',
          tag: 'button',
          component: 'Button',
          props: {},
          main: true,
          styles: validStyles,
          tokens: [],
          variants: ['not-a-prop-pair'],
        },
      })
    ).toBeNull()
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-pick',
        target: {
          rect: validRect,
          selector: '#btn',
          tag: 'button',
          component: 'Button',
          props: {},
          main: false,
          styles: validStyles,
          tokens: [{ name: '--btn-bg', value: '#000', property: 'color;bad' }],
        },
      })
    ).toBeNull()
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inspect-pick',
        target: {
          rect: validRect,
          selector: '#btn',
          tag: 'button',
          component: 'Button',
          props: {},
          main: false,
          styles: validStyles,
          tokens: [],
          tokensFromManifest: 'yes',
        },
      })
    ).toBeNull()

    // Inventory variants: 32 accepted, 33 rejected, prototype keys rejected
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inventory',
        requestId: 'r1',
        instances: { Button: 2 },
        mains: ['Button'],
        variants: { Button: variantsAtLimit },
      })
    ).toEqual({
      type: 'inventory',
      requestId: 'r1',
      instances: { Button: 2 },
      mains: ['Button'],
      variants: { Button: variantsAtLimit },
    })
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inventory',
        requestId: 'r1',
        instances: {},
        mains: [],
        variants: { Button: [...variantsAtLimit, 'variant=extra'] },
      })
    ).toBeNull()
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'inventory',
        requestId: 'r1',
        instances: {},
        mains: [],
        variants: JSON.parse('{"__proto__": ["variant=a"]}'),
      })
    ).toBeNull()

    // Item 4: matches and layout.matchRects (0 and 200 accepted, 201 or NaN rejected)
    const rects200 = Array.from({ length: 200 }, (_, i) => ({ x: i, y: 0, width: 10, height: 10 }))
    const rects201 = [...rects200, validRect]
    expect(parseBridgeMessage({ source: 'maestrly-bridge', type: 'matches', rects: [] })).toEqual({
      type: 'matches',
      rects: [],
    })
    expect(parseBridgeMessage({ source: 'maestrly-bridge', type: 'matches', rects: rects200 })).toEqual({
      type: 'matches',
      rects: rects200,
    })
    expect(parseBridgeMessage({ source: 'maestrly-bridge', type: 'matches', rects: rects201 })).toBeNull()
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'matches',
        rects: [{ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 }],
      })
    ).toBeNull()
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'layout',
        pins: {},
        width: 800,
        height: 600,
        matchRects: rects200,
      })
    ).toEqual({
      type: 'layout',
      pins: {},
      width: 800,
      height: 600,
      matchRects: rects200,
    })
    expect(
      parseBridgeMessage({
        source: 'maestrly-bridge',
        type: 'layout',
        pins: {},
        width: 800,
        height: 600,
        matchRects: rects201,
      })
    ).toBeNull()
  })
})

describe('pure design-model helpers', () => {
  it('classifies token groups and value kinds, resolves viewports, builds screen URLs, and selects pooled screens', () => {
    expect(groupOfToken('--color-accent')).toBe('color')
    expect(groupOfToken('--font-mono')).toBe('font')
    expect(groupOfToken('--space-4')).toBe('space')
    expect(groupOfToken('--radius-lg')).toBe('radius')
    expect(groupOfToken('--shadow-card')).toBe('shadow')
    expect(groupOfToken('--brand-custom')).toBe('other')

    expect(classifyTokenValue('--brand', '#ff5500')).toBe('color')
    expect(classifyTokenValue('--brand', 'oklch(0.7 0.15 240)')).toBe('color')
    expect(classifyTokenValue('--pad', '1.25rem')).toBe('length')
    expect(classifyTokenValue('--font-body', '"Inter", sans-serif')).toBe('text')
    expect(classifyTokenValue('--elevation', '0 4px 12px rgba(0,0,0,0.2)')).toBe('text')

    expect(resolveScreenViewport('desktop')).toEqual({ width: 1440, height: 900 })
    expect(resolveScreenViewport('tablet')).toEqual({ width: 834, height: 1112 })
    expect(resolveScreenViewport('mobile')).toEqual({ width: 390, height: 844 })
    expect(resolveScreenViewport({ width: 500, height: 700 })).toEqual({ width: 500, height: 700 })

    expect(screenFrameUrl('/c/abc.def/index.html', 'screens/pay wall.html?tab=1#top')).toBe(
      '/c/abc.def/screens/pay%20wall.html?tab=1#top'
    )
    expect(screenFrameUrl('/c/abc.def/index.html', '../secret.html')).toBeNull()
    expect(screenFrameUrl('https://evil.test/index.html', 'index.html')).toBeNull()

    const screens: DesignScreen[] = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      name: `S${i}`,
      path: `index.html#s${i}`,
      viewport: 'desktop',
    }))
    const live = selectLiveScreens({
      screens,
      focusedId: 's8',
      visibleIds: ['s2', 's3'],
      lruIds: ['s5', 's2', 's1', 's9'],
      limit: 5,
    })
    expect(live).toEqual(['s8', 's2', 's3', 's5', 's1'])
  })

  it('merges inspected tokens with manifest componentTokens and active theme/drafts', () => {
    const design: ViewerDesign = {
      title: 'Demo',
      tokenFile: 'tokens.css',
      allTokenFiles: ['tokens.css'],
      componentsPath: 'components.html',
      screens: [],
      componentTokens: { Card: ['--card-bg', '--card-radius'] },
      tokens: [
        { name: '--card-bg', group: 'color', kind: 'color', value: '#ffffff', themes: { '.dark': '#111111' } },
        { name: '--card-radius', group: 'radius', kind: 'length', value: '12px', themes: {} },
      ],
      themes: ['.dark'],
    }
    expect([...groupTokens(design.tokens).keys()]).toEqual(['color', 'radius'])

    const merged = mergeInspectedTokens(
      [{ name: '--card-bg', value: 'rgb(255, 255, 255)' }],
      'Card',
      design,
      [{ name: '--card-bg', theme: '.dark', value: '#050505' }],
      '.dark'
    )
    expect(merged).toEqual([
      { name: '--card-bg', value: '#050505' },
      { name: '--card-radius', value: '12px' },
    ])
  })
})

describe('createDesignController progressive inventory, pool, preview, save, suggest, and apply', () => {
  class FakeIframe {
    attributes = new Map<string, string>()
    style = { width: '', height: '' }
    title = ''
    src = ''
    isConnected = true
    ownerDocument: FakeDoc
    parentElement: FakeElement | null = null
    posted: Array<{ source: string } & ShellMessage> = []
    contentWindow: { postMessage: (msg: { source: string } & ShellMessage) => void }

    constructor(doc: FakeDoc) {
      this.ownerDocument = doc
      this.contentWindow = {
        postMessage: (msg) => {
          this.posted.push(msg)
        },
      }
    }
    setAttribute(k: string, v: string) {
      this.attributes.set(k, v)
    }
    remove() {
      this.isConnected = false
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this)
        if (idx >= 0) this.parentElement.children.splice(idx, 1)
      }
    }
  }

  class FakeElement {
    hidden = false
    style = { cssText: '' }
    children: Array<FakeIframe | FakeElement> = []
    ownerDocument: FakeDoc
    constructor(doc: FakeDoc) {
      this.ownerDocument = doc
    }
    setAttribute() {}
    appendChild<T extends FakeIframe | FakeElement>(child: T): T {
      if (child instanceof FakeIframe) {
        child.parentElement = this
        child.isConnected = true
      }
      this.children.push(child)
      return child
    }
    remove() {
      this.children.length = 0
    }
  }

  class FakeDoc {
    body: FakeElement
    createdIframes: FakeIframe[] = []
    constructor() {
      this.body = new FakeElement(this)
    }
    createElement(tag: string) {
      if (tag === 'iframe') {
        const frame = new FakeIframe(this)
        this.createdIframes.push(frame)
        return frame
      }
      return new FakeElement(this)
    }
  }

  const eightScreens: DesignScreen[] = Array.from({ length: 8 }, (_, i) => ({
    id: `scr-${i + 1}`,
    name: `Screen ${i + 1}`,
    path: `index.html#s${i + 1}`,
    viewport: 'desktop',
  }))

  const sampleDesign: ViewerDesign = {
    title: 'Design System',
    tokenFile: 'tokens.css',
    allTokenFiles: ['tokens.css'],
    componentsPath: 'components.html',
    screens: eightScreens,
    componentTokens: { Button: ['--btn-bg'] },
    tokens: [{ name: '--btn-bg', group: 'color', kind: 'color', value: '#2563eb', themes: { '.dark': '#60a5fa' } }],
    themes: ['.dark'],
  }

  function jsonRes(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  it('progressively measures all 8 screens on requestInventory() while respecting MAX_LIVE_SCREEN_FRAMES=6 and MAX_CONCURRENT_FRAME_LOADS=2', async () => {
    const doc = new FakeDoc()
    const stage = doc.createElement('iframe') as FakeIframe
    doc.body.appendChild(stage)

    const state: ViewerState = {
      artifact: {
        id: 'A'.repeat(22),
        kind: 'page',
        title: 'App',
        currentVersion: 1,
        versions: [{ number: 1, createdAt: 100, summary: 'Init' }],
      },
      identity: { kind: 'owner' },
      ownerName: 'Antonio',
      can: { comment: true, resolve: true, respond: true, edit: false, history: true },
    }

    const api: ArtifactApi = {
      state: async () => state,
      read: async (action) => {
        if (action.startsWith('design')) return jsonRes(200, { design: sampleDesign })
        return jsonRes(404, {})
      },
      write: async (action) => {
        if (action === 'frame') return jsonRes(200, { url: '/c/cap.sig/index.html', expiresAt: Date.now() + 600_000 })
        return jsonRes(404, {})
      },
    }

    const onChange = vi.fn()
    const ctrl = createDesignController({
      api,
      state,
      stageFrame: stage as unknown as HTMLIFrameElement,
      version: 1,
      preview: false,
      onChange,
      onDisableCommenting: () => {},
      onVersionCreated: () => {},
      onReplaced: () => {},
      onIdentityChanged: () => {},
    })

    await ctrl.setVersion(1, '/c/cap.sig/index.html', Date.now() + 600_000)
    expect(ctrl.snapshot().design?.screens).toHaveLength(8)

    // Before requestInventory: counts are null, status is queued, and measuring is false
    expect(ctrl.snapshot().componentUsage('Button')[0]).toEqual({
      screenId: 'scr-1',
      screenName: 'Screen 1',
      status: 'queued',
      count: null,
      measuring: false,
    })

    ctrl.requestInventory()
    await new Promise((r) => setTimeout(r, 0))

    // All 8 unmeasured screens report measuring: true; up to 2 loading frames report status 'measuring' while queued ones stay 'queued'
    const duringLoad = ctrl.snapshot().componentUsage('Button')
    expect(duringLoad.every((u) => u.count === null && u.measuring)).toBe(true)
    expect(duringLoad.filter((u) => u.status === 'measuring').length).toBe(2)
    expect(duringLoad.filter((u) => u.status === 'queued').length).toBe(6)

    // At most 2 frames start loading concurrently!
    const liveConnected = () => doc.createdIframes.slice(1).filter((f) => f.isConnected)
    expect(liveConnected().length).toBeLessThanOrEqual(2)

    // Progressively complete ready + inventory across all pooled frames until all 8 screens are measured
    for (let round = 0; round < 10; round++) {
      const currentFrames = liveConnected()
      expect(currentFrames.length).toBeLessThanOrEqual(6)
      for (const frame of currentFrames) {
        const hashIdx = frame.src.indexOf('#s')
        const screenNum = hashIdx >= 0 ? Number(frame.src.slice(hashIdx + 2)) : 0
        if (!frame.posted.some((m) => m.type === 'inventory-request')) {
          ctrl.routeMessage(frame.contentWindow as unknown as MessageEventSource, { type: 'ready' })
          await new Promise((r) => setTimeout(r, 0))
        }
        const invReq = frame.posted.find((m) => m.type === 'inventory-request') as
          | { type: 'inventory-request'; requestId: string }
          | undefined
        if (invReq) {
          ctrl.routeMessage(frame.contentWindow as unknown as MessageEventSource, {
            type: 'inventory',
            requestId: invReq.requestId,
            instances: { Button: screenNum },
            mains: [],
          })
          await new Promise((r) => setTimeout(r, 0))
        }
      }
      if (
        ctrl
          .snapshot()
          .componentUsage('Button')
          .every((u) => u.count !== null)
      )
        break
    }

    expect(ctrl.snapshot().componentUsage('Button')).toEqual(
      eightScreens.map((s, idx) => ({
        screenId: s.id,
        screenName: s.name,
        status: 'done',
        count: idx + 1,
        measuring: false,
      }))
    )

    ctrl.destroy()
    expect(liveConnected()).toHaveLength(0)
  })

  it('handles guest naming + auto-summary on suggestTokens, and owner saveTokens / applySuggestion', async () => {
    const doc = new FakeDoc()
    const stage = doc.createElement('iframe') as FakeIframe
    doc.body.appendChild(stage)

    const guestState: ViewerState = {
      artifact: {
        id: 'A'.repeat(22),
        kind: 'page',
        title: 'App',
        currentVersion: 1,
        versions: [{ number: 1, createdAt: 100, summary: 'Init' }],
      },
      identity: { kind: 'guest', name: null },
      ownerName: 'Antonio',
      can: { comment: true, resolve: false, respond: true, edit: false, history: false },
    }

    const writes: Array<{ action: string; method: string; body: unknown }> = []
    const createdComment: PublicComment = {
      id: 'C'.repeat(22),
      version: 1,
      parentId: null,
      author: { kind: 'guest', name: 'Ana', verified: false, self: true },
      body: 'Tokens: --btn-bg (.dark) #60a5fa → #93c5fd',
      anchor: null,
      suggestion: {
        file: 'tokens.css',
        changes: [{ name: '--btn-bg', theme: '.dark', from: '#60a5fa', to: '#93c5fd' }],
        appliedVersion: null,
      },
      status: 'open',
      createdAt: 200,
      canDelete: true,
    }

    const guestApi: ArtifactApi = {
      state: async () => guestState,
      read: async () => jsonRes(200, { design: sampleDesign }),
      write: async (action, method, body) => {
        writes.push({ action, method, body })
        if (action === 'session/name') return new Response(null, { status: 204 })
        if (action === 'comments') return jsonRes(201, createdComment)
        return jsonRes(404, {})
      },
    }

    expect(canSaveTokens(guestState, 1, sampleDesign)).toBe(false)
    expect(canSuggestTokens(guestState, sampleDesign)).toBe(true)
    expect(canApplySuggestion(guestState, sampleDesign)).toBe(false)

    const ctrl = createDesignController({
      api: guestApi,
      state: guestState,
      stageFrame: stage as unknown as HTMLIFrameElement,
      version: 1,
      preview: false,
      onChange: () => {},
      onDisableCommenting: () => {},
      onVersionCreated: () => {},
      onReplaced: () => {},
      onIdentityChanged: () => {},
    })

    await ctrl.setVersion(1, '/c/cap.sig/index.html', Date.now() + 600_000)
    expect(ctrl.setTokenValue('--btn-bg', '#93c5fd', '.dark')).toBe(true)
    expect(stage.posted.at(-1)).toEqual({
      source: 'maestrly-shell',
      type: 'token-preview',
      tokens: [{ name: '--btn-bg', theme: '.dark', value: '#93c5fd' }],
    })
    expect(
      diffTokens(
        sampleDesign,
        new Map([[tokenDraftKey('--btn-bg', '.dark'), { name: '--btn-bg', theme: '.dark', value: '#93c5fd' }]])
      )
    ).toEqual([{ name: '--btn-bg', theme: '.dark', from: '#60a5fa', to: '#93c5fd' }])

    // Unnamed guest without guestName fails with name_required
    expect(await ctrl.suggestTokens('')).toEqual({ ok: false, error: 'name_required' })

    // Providing guestName sets name via PUT session/name and auto-populates empty body!
    const suggested = await ctrl.suggestTokens('   ', 'Ana')
    expect(suggested).toEqual({ ok: true, comment: createdComment })
    expect(writes).toEqual([
      { action: 'session/name', method: 'PUT', body: { name: 'Ana' } },
      {
        action: 'comments',
        method: 'POST',
        body: {
          version: 1,
          body: 'Tokens: --btn-bg (.dark) #60a5fa → #93c5fd',
          suggestion: { changes: [{ name: '--btn-bg', theme: '.dark', value: '#93c5fd' }] },
        },
      },
    ])
    ctrl.destroy()
  })

  it('covers loadError/reloadDesign, retryScreen, activeTheme projection, component uses/return, and rebase/edit hooks', async () => {
    const doc = new FakeDoc()
    const stage = doc.createElement('iframe') as FakeIframe
    doc.body.appendChild(stage)

    let failDesignOnce = true
    const serverDesignV2: ViewerDesign = {
      ...sampleDesign,
      componentsPath: 'components.html',
      screens: [
        { id: 'home', name: 'Home', path: 'index.html', viewport: 'desktop' },
        { id: 'checkout', name: 'Checkout', path: 'checkout.html', viewport: 'mobile' },
      ],
      tokens: [
        { name: '--btn-bg', group: 'color', kind: 'color', value: '#1d4ed8', themes: { '.dark': '#3b82f6' } },
        { name: '--space-md', group: 'space', kind: 'length', value: '16px', themes: {} },
      ],
    }

    const state: ViewerState = {
      artifact: {
        id: 'A'.repeat(22),
        kind: 'page',
        title: 'App',
        currentVersion: 1,
        versions: [{ number: 1, createdAt: 100, summary: 'Init' }],
      },
      identity: { kind: 'owner' },
      ownerName: 'Antonio',
      can: { comment: true, resolve: true, respond: true, edit: false, history: true },
    }
    const syncedVersions: Array<{ version: number; current: number }> = []
    const api: ArtifactApi = {
      async read(path) {
        if (path.startsWith('design?version=')) {
          if (failDesignOnce) {
            failDesignOnce = false
            return jsonRes(500, { error: 'boom' })
          }
          const v = Number(path.split('=')[1])
          return jsonRes(200, {
            design:
              v === 2
                ? serverDesignV2
                : {
                    ...sampleDesign,
                    componentsPath: 'components.html',
                    screens: serverDesignV2.screens,
                    tokens: [
                      {
                        name: '--btn-bg',
                        group: 'color',
                        kind: 'color',
                        value: '#2563eb',
                        themes: { '.dark': '#60a5fa' },
                      },
                      { name: '--space-md', group: 'space', kind: 'length', value: '16px', themes: {} },
                    ],
                  },
          })
        }
        return jsonRes(404, {})
      },
      async write(action, _method, body) {
        if (action === 'frame') {
          const v = (body as { version: number }).version
          return jsonRes(200, { url: `/c/cap${v}.sig/index.html`, expiresAt: Date.now() + 600_000 })
        }
        if (action === 'tokens') {
          return jsonRes(409, { error: 'version_conflict', currentVersion: 2 })
        }
        if (action.endsWith('/apply')) {
          return jsonRes(409, {
            error: 'suggestion_conflict',
            currentVersion: 2,
            staleTokens: ['--btn-bg'],
          })
        }
        return jsonRes(404, {})
      },
      async state() {
        return {
          ...state,
          artifact: {
            ...state.artifact,
            currentVersion: 2,
            versions: [
              { number: 2, summary: 'v2', createdAt: 2 },
              { number: 1, summary: null, createdAt: 1 },
            ],
          },
        }
      },
    }

    const ctrl = createDesignController({
      api,
      state,
      stageFrame: stage as unknown as HTMLIFrameElement,
      version: 1,
      preview: false,
      onChange: () => {},
      onDisableCommenting: () => {},
      onVersionCreated: () => {},
      onVersionSynced: (v, cur) => syncedVersions.push({ version: v, current: cur }),
      onReplaced: () => {},
      onIdentityChanged: () => {},
    })

    // 1. loadError vs reloadDesign
    await ctrl.setVersion(1, '/c/cap1.sig/index.html', Date.now() + 600_000)
    expect(ctrl.snapshot().loadError).toBe(true)
    expect(ctrl.snapshot().design).toBeNull()
    await ctrl.reloadDesign()
    expect(ctrl.snapshot().loadError).toBe(false)
    expect(ctrl.snapshot().design?.title).toBe('Design System')

    // 2. Active theme projects onto :root in preview tokens without mutating draftChanges
    ctrl.setActiveTheme('.dark')
    expect(ctrl.snapshot().draftChanges).toEqual([])
    expect(stage.posted.at(-1)).toEqual({
      source: 'maestrly-shell',
      type: 'token-preview',
      tokens: [
        { name: '--btn-bg', value: '#60a5fa' },
        { name: '--space-md', value: '16px' },
      ],
    })
    ctrl.setActiveTheme(null)
    expect(stage.posted.at(-1)).toEqual({ source: 'maestrly-shell', type: 'token-preview-clear' })

    // 3. retryScreen recovers a failed screen frame
    ctrl.setView('screens')
    ctrl.setVisibleScreens(['home'], 'home')
    await new Promise((r) => setTimeout(r, 0))
    const firstHomeFrame = ctrl.screenFrame('home') as unknown as FakeIframe
    expect(firstHomeFrame).toBeTruthy()
    ctrl.routeMessage(firstHomeFrame.contentWindow as unknown as MessageEventSource, {
      type: 'error',
      message: 'Failed screen',
    })
    expect(ctrl.snapshot().screensState.get('home')?.status).toBe('error')
    expect(ctrl.snapshot().componentUsage('Button')[0]?.status).toBe('failed')
    ctrl.retryScreen('home')
    await new Promise((r) => setTimeout(r, 0))
    const retriedHomeFrame = ctrl.screenFrame('home') as unknown as FakeIframe
    expect(retriedHomeFrame).toBeTruthy()
    expect(retriedHomeFrame).not.toBe(firstHomeFrame)

    // 4. openMainComponent probes components.html first: missing component returns false without navigating stageFrame
    await ctrl.openScreen('home')
    ctrl.routeMessage(stage.contentWindow as unknown as MessageEventSource, { type: 'ready' })
    ctrl.setInspecting(true)
    ctrl.routeMessage(stage.contentWindow as unknown as MessageEventSource, {
      type: 'inspect-pick',
      target: {
        selector: '#cta-btn',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        tag: 'button',
        elementLabel: 'button.primary',
        component: 'Button',
        main: false,
        props: { variant: 'primary' },
        styles: {
          fontFamily: 'sans-serif',
          fontSize: '14px',
          fontWeight: '600',
          lineHeight: '20px',
          color: '#fff',
          backgroundColor: '#2563eb',
          borderRadius: '8px',
          padding: '8px 16px',
        },
        tokens: [{ name: '--btn-bg', value: '#2563eb', property: 'background-color' }],
        chain: [{ component: 'Card', selector: '#hero-card' }],
      },
    })
    expect(ctrl.snapshot().inspected?.tokens[0]?.property).toBe('background-color')
    stage.posted.length = 0
    ctrl.selectElement('#hero-card')
    expect(stage.posted).toEqual([{ source: 'maestrly-shell', type: 'inspect-select', selector: '#hero-card' }])
    ctrl.selectElement('#bad\u0000')
    expect(stage.posted).toHaveLength(1)

    const stageSrcBeforeProbe = stage.src
    const missingPromise = ctrl.openMainComponent('UnknownWidget')
    await new Promise((r) => setTimeout(r, 0))
    const probeFrame = doc.createdIframes.at(-1)!
    ctrl.routeMessage(probeFrame.contentWindow as unknown as MessageEventSource, { type: 'ready' })
    const probeInvReq = probeFrame.posted.find((m) => m.type === 'inventory-request') as { requestId: string }
    ctrl.routeMessage(probeFrame.contentWindow as unknown as MessageEventSource, {
      type: 'inventory',
      requestId: probeInvReq.requestId,
      instances: {},
      mains: ['Button'],
      variants: { Button: ['variant=primary', 'variant=ghost'] },
    })
    expect(await missingPromise).toBe(false)
    expect(stage.src).toBe(stageSrcBeforeProbe)
    expect(ctrl.componentVariants('Button')).toEqual(['variant=primary', 'variant=ghost'])

    // Existing main component navigates to components.html and tracks backScreenId
    expect(await ctrl.openMainComponent('Button')).toBe(true)
    expect(ctrl.snapshot().stagePath).toBe('components.html')
    expect(ctrl.snapshot().backScreenId).toBe('home')

    // returnFromMainComponent navigates back to 'home' and re-selects '#cta-btn'
    await ctrl.returnFromMainComponent()
    expect(ctrl.snapshot().stagePath).toBe('index.html')
    expect(ctrl.snapshot().backScreenId).toBeNull()
    stage.posted.length = 0
    ctrl.routeMessage(stage.contentWindow as unknown as MessageEventSource, { type: 'ready' })
    expect(stage.posted).toContainEqual({
      source: 'maestrly-shell',
      type: 'inspect-select',
      selector: '#cta-btn',
    })

    // 5. showComponentUses highlights matches and updates matchRects
    await ctrl.showComponentUses('Button', 'home')
    expect(stage.posted.at(-1)).toEqual({
      source: 'maestrly-shell',
      type: 'highlight-component',
      component: 'Button',
    })
    ctrl.routeMessage(stage.contentWindow as unknown as MessageEventSource, {
      type: 'matches',
      rects: [{ x: 12, y: 24, width: 88, height: 36 }],
    })
    expect(ctrl.snapshot().matchRects).toEqual([{ x: 12, y: 24, width: 88, height: 36 }])
    expect(ctrl.escape()).toBe(true)
    expect(ctrl.snapshot().matchRects).toEqual([])

    // 6. saveTokens conflict -> rebaseTokensToVersion preserves drafts and marks changed-origin drafts in staleDraftKeys
    expect(ctrl.setTokenValue('--space-md', '24px')).toBe(true)
    expect(ctrl.setTokenValue('--btn-bg', '#ef4444')).toBe(true)
    expect(ctrl.setTokenValue('--btn-bg', '#3b82f6', '.dark')).toBe(true)
    const conflictSave = await ctrl.saveTokens()
    expect(conflictSave).toEqual({ ok: false, error: 'version_conflict', currentVersion: 2 })
    await ctrl.rebaseTokensToVersion(2)
    expect(syncedVersions.at(-1)).toEqual({ version: 2, current: 2 })
    // .dark #3b82f6 matched v2's base so it was pruned; --space-md (unchanged origin) kept clean; --btn-bg (:root origin changed #2563eb -> #1d4ed8) marked stale
    expect(ctrl.snapshot().draftChanges).toEqual([
      { name: '--space-md', value: '24px' },
      { name: '--btn-bg', value: '#ef4444' },
    ])
    expect([...ctrl.snapshot().staleDraftKeys]).toEqual([tokenDraftKey('--btn-bg', null)])
    // Editing the stale draft clears its stale flag
    expect(ctrl.setTokenValue('--btn-bg', '#dc2626')).toBe(true)
    expect(ctrl.snapshot().staleDraftKeys.size).toBe(0)

    const conflictApply = await ctrl.applySuggestion('c'.repeat(22))
    expect(conflictApply).toEqual({
      ok: false,
      error: 'suggestion_conflict',
      currentVersion: 2,
      staleTokens: ['--btn-bg'],
    })

    await ctrl.editSuggestionInTokens([{ name: '--btn-bg', from: '#2563eb', to: '#93c5fd', theme: '.dark' }])
    expect(ctrl.snapshot().tokensOpen).toBe(true)
    expect(ctrl.snapshot().activeTheme).toBe('.dark')
    expect(ctrl.snapshot().draftChanges).toEqual([{ name: '--btn-bg', value: '#93c5fd', theme: '.dark' }])

    ctrl.destroy()
  })
})
