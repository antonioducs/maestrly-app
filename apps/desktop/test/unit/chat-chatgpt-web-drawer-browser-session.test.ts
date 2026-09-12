import { describe, expect, it, vi } from 'vitest'
import type { BrowserSurface } from '../../src/main/chat/browser-surface'
import { createDrawerBrowserSession } from '../../src/main/chat/chatgpt-web/drawer-browser-session'

function surface(url: string): BrowserSurface {
  return {
    partition: 'persist:drawer-browser',
    origin: new URL(url).origin,
    info: () => ({ state: 'ready', url }),
    show: vi.fn(() => true),
    navigate: vi.fn(),
    reload: vi.fn(),
    waitFor: vi.fn(),
    snapshot: vi.fn(),
    screenshot: vi.fn(),
    readText: vi.fn(),
    scroll: vi.fn(),
    consoleLogs: vi.fn(),
    networkLogs: vi.fn(),
    click: vi.fn(),
    doubleClick: vi.fn(),
    type: vi.fn(),
    pressKey: vi.fn(),
    drag: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } as unknown as BrowserSurface
}

describe('drawer browser companion session', () => {
  it('lists only same-conversation loopback tabs with opaque stable IDs', () => {
    const getState = vi.fn(() => ({
      convId: 'conv-1',
      activeId: 'conv-1:b1',
      canGoBack: false,
      canGoForward: false,
      devtoolsOpen: false,
      tabs: [
        { id: 'conv-1:b1', title: 'Game\nClient', url: 'http://localhost:5173/play', loading: false },
        { id: 'conv-1:b2', title: 'Email', url: 'https://mail.example.com/', loading: false },
        { id: 'conv-1:b3', title: 'Admin', url: 'http://127.0.0.1:5174/', loading: false },
      ],
    }))
    const session = createDrawerBrowserSession({ conversationId: 'conv-1', getState: getState as never })
    const first = session.list()
    const second = session.list()

    expect(first).toHaveLength(2)
    expect(first[0]).toMatchObject({ title: 'Game Client', url: 'http://localhost:5173/play', active: true })
    expect(first[0].id).toMatch(/^browser_[0-9a-f]{24}$/)
    expect(first[0].id).not.toContain('conv-1:b1')
    expect(second.map((tab) => tab.id)).toEqual(first.map((tab) => tab.id))
  })

  it('attaches without ownership and creates an independent review lease for the same opaque tab', async () => {
    const getState = () => ({
      convId: 'conv-1',
      activeId: 'conv-1:b1',
      canGoBack: false,
      canGoForward: false,
      devtoolsOpen: false,
      tabs: [{ id: 'conv-1:b1', title: 'Game', url: 'http://localhost:5173/', loading: false }],
    })
    const surfaces: BrowserSurface[] = []
    const createSurface = vi.fn(async ({ url }: { url: string }) => {
      const created = surface(url)
      surfaces.push(created)
      return created
    })
    const session = createDrawerBrowserSession({
      conversationId: 'conv-1',
      getState: getState as never,
      createSurface: createSurface as never,
    })
    const browserId = session.list()[0].id

    expect(await session.attach(browserId)).toBe(surfaces[0])
    expect(session.active()).toBe(surfaces[0])
    const review = await session.createReviewSurface({
      browserId,
      signal: new AbortController().signal,
      onStateChange: vi.fn(),
    })
    expect(review).toMatchObject({ url: 'http://localhost:5173/', ownership: 'attached' })
    expect(review.browser).toBe(surfaces[1])

    await review.browser.dispose()
    expect(session.active()).toBe(surfaces[0])
    await session.detach()
    expect(session.active()).toBeNull()
    expect(surfaces[0].dispose).toHaveBeenCalledOnce()
  })

  it('rejects invented IDs and invalidates a token when its local tab disappears', async () => {
    let tabs = [{ id: 'conv-1:b1', title: 'Game', url: 'http://localhost:5173/', loading: false }]
    const getState = () => ({
      convId: 'conv-1',
      activeId: tabs[0]?.id ?? null,
      canGoBack: false,
      canGoForward: false,
      devtoolsOpen: false,
      tabs,
    })
    const session = createDrawerBrowserSession({ conversationId: 'conv-1', getState: getState as never })
    const id = session.list()[0].id
    await expect(session.attach('browser_invented')).rejects.toThrow('Unknown or expired')
    tabs = []
    await expect(session.attach(id)).rejects.toThrow('no longer available')
  })
})
