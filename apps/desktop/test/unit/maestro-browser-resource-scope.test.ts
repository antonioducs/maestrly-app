import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => {
  const tabs: Array<{
    id: string
    title: string
    url: string
    loading: boolean
    ownerScopeId?: string
  }> = []
  let seq = 0
  let activeId: string | null = null
  const createBrowserTab = vi.fn(
    (convId: string, url = 'https://www.google.com', options: { ownerScopeId?: string; activate?: boolean } = {}) => {
      const tab = {
        id: `${convId}:b${++seq}`,
        title: url,
        url,
        loading: false,
        ...(options.ownerScopeId ? { ownerScopeId: options.ownerScopeId } : {}),
      }
      tabs.push(tab)
      if (options.activate ?? true) activeId = tab.id
      return tab.id
    }
  )
  const closeBrowserTab = vi.fn((_convId: string, id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    tabs.splice(index, 1)
    if (activeId === id) activeId = tabs[index]?.id ?? tabs[index - 1]?.id ?? null
  })
  const captureUiFrame = vi.fn(async () => ({ source: 'ui' }))
  const captureScopedFrame = vi.fn(async () => ({ source: 'scoped' }))
  return {
    tabs,
    reset: () => {
      tabs.length = 0
      seq = 0
      const ui = {
        id: 'conv-1:ui',
        title: 'UI tab',
        url: 'https://ui.test',
        loading: false,
      }
      tabs.push(ui)
      activeId = ui.id
    },
    activeId: () => activeId,
    createBrowserTab,
    closeBrowserTab,
    closeBrowserWindowsOwnedByScope: vi.fn(),
    getBrowserState: vi.fn((convId: string) => ({
      convId,
      tabs: tabs.filter((tab) => !tab.ownerScopeId).map(({ ownerScopeId: _ownerScopeId, ...tab }) => tab),
      activeId: tabs.some((tab) => !tab.ownerScopeId && tab.id === activeId) ? activeId : null,
      canGoBack: false,
      canGoForward: false,
      devtoolsOpen: false,
    })),
    getBrowserStateForScope: vi.fn((convId: string, ownerScopeId: string) => {
      const owned = tabs.filter((tab) => tab.ownerScopeId === ownerScopeId)
      return {
        convId,
        tabs: owned.map(({ ownerScopeId: _ownerScopeId, ...tab }) => tab),
        activeId: owned[0]?.id ?? null,
        canGoBack: false,
        canGoForward: false,
        devtoolsOpen: false,
      }
    }),
    getBrowserTabOwnerScopeId: vi.fn((_convId: string, id: string) => tabs.find((tab) => tab.id === id)?.ownerScopeId),
    listBrowserTabIdsOwnedByScope: vi.fn((_convId: string, ownerScopeId: string) =>
      tabs.filter((tab) => tab.ownerScopeId === ownerScopeId).map((tab) => tab.id)
    ),
    captureUiFrame,
    captureScopedFrame,
    acquireBrowserForControl: vi.fn(() => ({
      webContents: { id: activeId },
      captureFrame: captureUiFrame,
      release: vi.fn(),
    })),
    acquireBrowserTabForControl: vi.fn((_convId: string, tabId: string) => ({
      tabId,
      webContents: { id: tabId },
      captureFrame: captureScopedFrame,
      release: vi.fn(),
    })),
    switchBrowserTab: vi.fn((_convId: string, id: string) => {
      activeId = id
    }),
    touchActiveBrowserActivity: vi.fn(),
    navigate: vi.fn(async (_browser: { id: string }, url: string) => ({ url })),
    waitFor: vi.fn(),
    screenshot: vi.fn(
      async (
        _browser: unknown,
        options: { signal: AbortSignal; captureFrame: (signal: AbortSignal) => Promise<unknown> }
      ) => {
        await options.captureFrame(options.signal)
        return 'scoped-image'
      }
    ),
    mousePosition: vi.fn(() => ({ x: 1, y: 2 })),
    scrollPosition: vi.fn(async () => ({ y: 0, maxY: 0 })),
  }
})

vi.mock('../../src/main/drawer-manager', () => ({
  acquireBrowserForControl: h.acquireBrowserForControl,
  acquireBrowserTabForControl: h.acquireBrowserTabForControl,
  getBrowserState: h.getBrowserState,
  getBrowserStateForScope: h.getBrowserStateForScope,
  createBrowserTab: h.createBrowserTab,
  closeBrowserTab: h.closeBrowserTab,
  closeBrowserWindowsOwnedByScope: h.closeBrowserWindowsOwnedByScope,
  switchBrowserTab: h.switchBrowserTab,
  getBrowserTabOwnerScopeId: h.getBrowserTabOwnerScopeId,
  listBrowserTabIdsOwnedByScope: h.listBrowserTabIdsOwnedByScope,
  touchActiveBrowserActivity: h.touchActiveBrowserActivity,
}))
vi.mock('../../src/main/browser-control', () => ({
  navigate: h.navigate,
  waitFor: h.waitFor,
  screenshot: h.screenshot,
  mousePosition: h.mousePosition,
  scrollPosition: h.scrollPosition,
}))

import { createMaestroWorkerScope } from '../../src/main/maestro-worker-scope'
import { registerBrowserTools } from '../../src/main/mcp/tools/browser'

type Handler = (
  input: Record<string, unknown>,
  extra?: { signal: AbortSignal }
) => Promise<{
  content: Array<{ type: string; text?: string; data?: string }>
  isError?: boolean
}>

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function register(scope: ReturnType<typeof createMaestroWorkerScope>): Record<string, Handler> {
  const handlers: Record<string, Handler> = {}
  registerBrowserTools({
    server: {
      registerTool: (name: string, _definition: unknown, handler: Handler) => {
        handlers[name] = handler
      },
    } as never,
    convId: 'conv-1',
    locale: 'en',
    t: ((key: string, values?: Record<string, unknown>) =>
      `${key}${values ? ` ${JSON.stringify(values)}` : ''}`) as never,
    workerScope: scope,
  })
  return handlers
}

describe('Maestro browser resource isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.reset()
  })

  it('keeps scope-local tabs/control, serializes each tab, and cleans up only exact ownership', async () => {
    const scopeA = createMaestroWorkerScope({ conversationId: 'conv-1', delegationId: 'delegate-a' })
    const scopeB = createMaestroWorkerScope({ conversationId: 'conv-1', delegationId: 'delegate-b' })
    const a = register(scopeA)
    const b = register(scopeB)

    await a.browser_tabs({})
    await b.browser_tabs({})
    const lazyA = h.tabs.find((tab) => tab.ownerScopeId === scopeA.id)!
    const lazyB = h.tabs.find((tab) => tab.ownerScopeId === scopeB.id)!
    expect(lazyA.url).toBe('https://ui.test')
    expect(lazyB.url).toBe('https://ui.test')
    expect(h.activeId()).toBe('conv-1:ui')
    expect(h.createBrowserTab).toHaveBeenCalledWith('conv-1', 'https://ui.test', {
      ownerScopeId: scopeA.id,
      activate: false,
    })

    await a.browser_new_tab({ url: 'https://a-only.test' })
    await b.browser_new_tab({ url: 'https://b-only.test' })
    const activeA = h.tabs.find((tab) => tab.url === 'https://a-only.test')!
    const activeB = h.tabs.find((tab) => tab.url === 'https://b-only.test')!
    const listA = await a.browser_tabs({})
    expect(listA.content[0]!.text).toContain('https://a-only.test')
    expect(listA.content[0]!.text).not.toContain('https://b-only.test')
    expect(listA.content[0]!.text).not.toContain('UI tab')
    const listB = await b.browser_tabs({})
    expect(listB.content[0]!.text).toContain('https://b-only.test')
    expect(listB.content[0]!.text).not.toContain('https://a-only.test')
    await expect(a.browser_switch_tab({ index: 3 })).resolves.toMatchObject({ isError: true })

    const firstGate = deferred()
    const runningByTab = new Map<string, number>()
    const maxByTab = new Map<string, number>()
    let firstA = true
    h.navigate.mockImplementation(async (browser: { id: string }, url: string) => {
      const running = (runningByTab.get(browser.id) ?? 0) + 1
      runningByTab.set(browser.id, running)
      maxByTab.set(browser.id, Math.max(maxByTab.get(browser.id) ?? 0, running))
      if (browser.id === activeA.id && firstA) {
        firstA = false
        await firstGate.promise
      }
      runningByTab.set(browser.id, running - 1)
      return { url }
    })

    const first = a.browser_navigate({ url: 'https://a-nav-1.test' })
    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(1))
    const second = a.browser_navigate({ url: 'https://a-nav-2.test' })
    const otherScope = b.browser_navigate({ url: 'https://b-nav.test' })
    await otherScope
    expect(h.navigate.mock.calls.filter(([browser]) => browser.id === activeA.id)).toHaveLength(1)
    expect(h.navigate.mock.calls.some(([browser]) => browser.id === activeB.id)).toBe(true)

    firstGate.resolve()
    await Promise.all([first, second])
    expect(maxByTab.get(activeA.id)).toBe(1)
    expect(h.acquireBrowserTabForControl).toHaveBeenCalledWith('conv-1', activeA.id)
    expect(h.acquireBrowserTabForControl).toHaveBeenCalledWith('conv-1', activeB.id)
    expect(h.acquireBrowserForControl).not.toHaveBeenCalled()

    await scopeA.close()
    expect(h.tabs.map((tab) => tab.id)).toEqual(['conv-1:ui', lazyB.id, activeB.id])
    expect(h.activeId()).toBe('conv-1:ui')
    expect(h.closeBrowserWindowsOwnedByScope).toHaveBeenCalledWith('conv-1', scopeA.id)
    await scopeA.close()
    expect(h.closeBrowserTab).toHaveBeenCalledTimes(2)

    await scopeB.close()
    expect(h.tabs.map((tab) => tab.id)).toEqual(['conv-1:ui'])
  })

  it('inherits runtime ownership for page-created tabs and popups', () => {
    const source = readFileSync('src/main/drawer/browser.ts', 'utf8')
    expect(source).toContain('ownerScopeId: tab.ownerScopeId, activate: false')
    expect(source).toContain('oauthOwnerScopeByWindow.set(child, tab.ownerScopeId)')
    expect(source).toContain('closeBrowserWindowsOwnedByScope')
  })

  it('captures screenshots from the exact scoped tab without touching the UI tab', async () => {
    const scope = createMaestroWorkerScope({ conversationId: 'conv-1', delegationId: 'delegate-shot' })
    const handlers = register(scope)
    await handlers.browser_tabs({})
    const owned = h.tabs.find((tab) => tab.ownerScopeId === scope.id)!
    const controller = new AbortController()

    const result = await handlers.browser_screenshot({}, { signal: controller.signal })

    expect(h.acquireBrowserTabForControl).toHaveBeenCalledWith('conv-1', owned.id)
    expect(h.acquireBrowserForControl).not.toHaveBeenCalled()
    expect(h.screenshot).toHaveBeenCalledWith(
      { id: owned.id },
      { signal: controller.signal, captureFrame: h.captureScopedFrame }
    )
    expect(h.captureScopedFrame).toHaveBeenCalledWith(controller.signal)
    expect(h.captureUiFrame).not.toHaveBeenCalled()
    expect(result.content[0]).toMatchObject({ type: 'image', data: 'scoped-image' })

    await scope.close()
  })

  it('threads the worker abort signal through browser_wait_for and then cleans up', async () => {
    const controller = new AbortController()
    const scope = createMaestroWorkerScope({
      conversationId: 'conv-1',
      delegationId: 'delegate-abort',
      signal: controller.signal,
    })
    const handlers = register(scope)
    h.waitFor.mockImplementation(
      async (_browser: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
    )

    const running = handlers.browser_wait_for({ selector: '#never', timeout_ms: 60_000 })
    await vi.waitFor(() => expect(h.waitFor).toHaveBeenCalledOnce())
    expect(h.waitFor.mock.calls[0]![1].signal).toBe(controller.signal)
    const rejected = expect(running).rejects.toThrow()
    controller.abort()

    await rejected
    await scope.close()
    expect(h.tabs).toEqual([expect.objectContaining({ id: 'conv-1:ui' })])
  })
})
