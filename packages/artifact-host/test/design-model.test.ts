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

    // Before requestInventory: counts are null and measuring is false
    expect(ctrl.snapshot().componentUsage('Button')[0]).toEqual({
      screenId: 'scr-1',
      screenName: 'Screen 1',
      count: null,
      measuring: false,
    })

    ctrl.requestInventory()
    await new Promise((r) => setTimeout(r, 0))

    // All 8 unmeasured screens report measuring: true
    expect(
      ctrl
        .snapshot()
        .componentUsage('Button')
        .every((u) => u.count === null && u.measuring)
    ).toBe(true)

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
})
