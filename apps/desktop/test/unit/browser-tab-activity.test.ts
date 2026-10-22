import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  acquireBrowserForControl: vi.fn(),
  getBrowserState: vi.fn(),
  createBrowserTab: vi.fn(),
  closeBrowserTab: vi.fn(),
  switchBrowserTab: vi.fn(),
  touchActiveBrowserActivity: vi.fn(),
  browserControlReady: vi.fn(async () => {}),
  navigate: vi.fn(async () => ({ url: 'https://page.test/' })),
}))

vi.mock('../../src/main/drawer-manager', () => h)
vi.mock('../../src/main/browser-control', () => ({ navigate: h.navigate }))

import { registerBrowserTools } from '../../src/main/mcp/tools/browser'

type Handler = (input: Record<string, unknown>) => Promise<unknown>

describe('browser tab management activity lease', () => {
  const handlers: Record<string, Handler> = {}

  beforeEach(() => {
    vi.clearAllMocks()
    h.getBrowserState.mockReturnValue({
      convId: 'conv-1',
      tabs: [
        { id: 'tab-1', title: 'First', url: 'https://first.test', loading: false },
        { id: 'tab-2', title: 'Second', url: 'https://second.test', loading: false },
      ],
      activeId: 'tab-1',
      canGoBack: false,
      canGoForward: false,
      devtoolsOpen: false,
    })
    for (const key of Object.keys(handlers)) delete handlers[key]
    registerBrowserTools({
      server: {
        registerTool: (name: string, _definition: unknown, handler: Handler) => {
          handlers[name] = handler
        },
      } as never,
      convId: 'conv-1',
      locale: 'en',
      t: ((key: string) => key) as never,
    })
  })

  it('renews the active tab lease when listing tabs without creating a tab', async () => {
    await handlers.browser_tabs({})

    expect(h.touchActiveBrowserActivity).toHaveBeenCalledWith('conv-1')
    expect(h.createBrowserTab).not.toHaveBeenCalled()
  })

  it('renews the selected tab lease after switching and the new tab lease after creation', async () => {
    await handlers.browser_switch_tab({ index: 2 })
    expect(h.switchBrowserTab).toHaveBeenCalledWith('conv-1', 'tab-2')
    expect(h.touchActiveBrowserActivity).toHaveBeenCalledWith('conv-1')

    await handlers.browser_new_tab({ url: 'https://new.test' })
    expect(h.createBrowserTab).toHaveBeenCalledWith('conv-1', 'https://new.test')
    expect(h.touchActiveBrowserActivity).toHaveBeenCalledWith('conv-1')
  })

  it('drives a view only once it is ready: a headless view created by the call still loads its first page', async () => {
    const webContents = { id: 7 }
    const release = vi.fn()
    h.acquireBrowserForControl.mockReturnValue({ webContents, captureFrame: vi.fn(), release })
    let ready!: () => void
    h.browserControlReady.mockReturnValueOnce(new Promise<void>((resolve) => (ready = resolve)))

    const navigated = handlers.browser_navigate({ url: 'https://page.test' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.browserControlReady).toHaveBeenCalledWith(webContents)
    // A navigation sent now would be replaced by the view's own first page.
    expect(h.navigate).not.toHaveBeenCalled()

    ready()
    await navigated
    expect(h.navigate).toHaveBeenCalledWith(webContents, 'https://page.test', {})
    expect(release).toHaveBeenCalledTimes(1)
  })
})
