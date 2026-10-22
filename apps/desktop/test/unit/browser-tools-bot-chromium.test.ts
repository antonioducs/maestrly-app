import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  navigate: vi.fn(async (_page: unknown, url: string) => ({ url })),
  screenshot: vi.fn(
    async (
      _page: unknown,
      options: { signal?: AbortSignal; captureFrame: (signal: AbortSignal) => Promise<unknown> }
    ) => {
      await options.captureFrame(options.signal ?? new AbortController().signal)
      return 'image'
    }
  ),
  acquireBrowserForControl: vi.fn(),
}))

vi.mock('../../src/main/drawer-manager', () => ({
  acquireBrowserForControl: h.acquireBrowserForControl,
  acquireBrowserTabForControl: vi.fn(),
  browserControlReady: async () => {},
  getBrowserState: vi.fn(() => ({ tabs: [], activeId: null })),
  getBrowserStateForScope: vi.fn(() => ({ tabs: [], activeId: null })),
  createBrowserTab: vi.fn(),
  closeBrowserTab: vi.fn(),
  closeBrowserWindowsOwnedByScope: vi.fn(),
  switchBrowserTab: vi.fn(),
  getBrowserTabOwnerScopeId: vi.fn(),
  listBrowserTabIdsOwnedByScope: vi.fn(() => []),
  touchActiveBrowserActivity: vi.fn(),
}))
vi.mock('../../src/main/browser-control', () => ({
  navigate: h.navigate,
  screenshot: h.screenshot,
  mousePosition: vi.fn(() => ({ x: 0, y: 0 })),
  scrollPosition: vi.fn(async () => ({ x: 0, y: 0, maxX: 0, maxY: 0 })),
}))

import { nativeImage } from 'electron'
import { createMaestroWorkerScope, type MaestroWorkerScope } from '../../src/main/maestro-worker-scope'
import { registerBrowserTools } from '../../src/main/mcp/tools/browser'
import { setBrowserBackendResolver } from '../../src/main/mcp/tools/browser-backend'
import { botChromiumBackend } from '../../src/main/fleet/instance/bot-browser/backend'
import type { BotChromium } from '../../src/main/fleet/instance/bot-browser/bot-chromium'

type Handler = (
  input: Record<string, unknown>,
  extra?: { signal: AbortSignal }
) => Promise<{
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}>

interface FakeTab {
  id: string
  url: string
  title: string
  conversationId: string
  scopeId?: string
}

/** The part of a bot's Chromium the backend uses, keeping tabs in memory. */
function fakeChromium() {
  const tabs: FakeTab[] = []
  const active = new Map<string, string>()
  let seq = 0
  const touch = vi.fn()
  const pages = new Map<string, { targetId: string; captureScreenshot: () => Promise<Buffer> }>()
  const pageOf = (id: string) => {
    let page = pages.get(id)
    if (!page) {
      page = { targetId: id, captureScreenshot: vi.fn(async () => Buffer.from('png')) }
      pages.set(id, page)
    }
    return page
  }
  const owned = (conversationId: string, scopeId?: string) =>
    tabs.filter((tab) => tab.conversationId === conversationId && tab.scopeId === scopeId)
  const chromium = {
    touch,
    state: vi.fn(async (conversationId: string, scopeId?: string) => {
      const list = owned(conversationId, scopeId).map(({ id, url, title }) => ({ id, url, title }))
      return { tabs: list, activeId: scopeId ? (list[0]?.id ?? null) : (active.get(conversationId) ?? null) }
    }),
    page: vi.fn(async (conversationId: string, tabId?: string) => {
      const id = tabId ?? active.get(conversationId)
      const tab = tabs.find((candidate) => candidate.id === id && candidate.conversationId === conversationId)
      if (!tab) throw new Error('This tab of the bot’s Chromium is no longer open.')
      return pageOf(tab.id)
    }),
    createTab: vi.fn(
      async (
        conversationId: string,
        url: string | undefined,
        options: { ownerScopeId?: string; activate?: boolean } = {}
      ) => {
        const id = `T${++seq}`
        tabs.push({
          id,
          url: url ?? 'https://www.google.com',
          title: '',
          conversationId,
          ...(options.ownerScopeId ? { scopeId: options.ownerScopeId } : {}),
        })
        if ((options.activate ?? true) && !options.ownerScopeId) active.set(conversationId, id)
        return id
      }
    ),
    closeTab: vi.fn(async (conversationId: string, tabId: string) => {
      const index = tabs.findIndex((tab) => tab.id === tabId && tab.conversationId === conversationId)
      if (index >= 0) tabs.splice(index, 1)
    }),
    switchTab: vi.fn(async (conversationId: string, tabId: string) => void active.set(conversationId, tabId)),
    ownerScopeOf: vi.fn((conversationId: string, tabId: string) => {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      return tab?.conversationId === conversationId ? tab.scopeId : undefined
    }),
    tabIdsOwnedByScope: vi.fn((conversationId: string, scopeId: string) =>
      owned(conversationId, scopeId).map((tab) => tab.id)
    ),
  }
  return { chromium: chromium as unknown as BotChromium, mock: chromium, tabs, pages }
}

function register(convId: string, workerScope?: MaestroWorkerScope) {
  const handlers: Record<string, Handler> = {}
  const descriptions: Record<string, string> = {}
  registerBrowserTools({
    server: {
      registerTool: (name: string, definition: { description: string }, handler: Handler) => {
        handlers[name] = handler
        descriptions[name] = definition.description
      },
    } as never,
    convId,
    locale: 'en',
    t: ((key: string, values?: Record<string, unknown>) =>
      `${key}${values ? ` ${JSON.stringify(values)}` : ''}`) as never,
    ...(workerScope ? { workerScope } : {}),
  })
  return { handlers, descriptions }
}

describe('browser tools on a bot’s own Chromium', () => {
  let fake: ReturnType<typeof fakeChromium>

  beforeEach(() => {
    fake = fakeChromium()
    setBrowserBackendResolver((convId) => (convId.startsWith('bot-') ? botChromiumBackend(fake.chromium) : null))
  })

  afterEach(() => {
    setBrowserBackendResolver(null)
    vi.clearAllMocks()
  })

  it('drives the conversation’s active tab and describes the bot’s browser', async () => {
    const { handlers, descriptions } = register('bot-conv')
    expect(descriptions.browser_navigate).toContain('notes.botChromium')
    await handlers.browser_new_tab({ url: 'https://a.test' })
    await handlers.browser_navigate({ url: 'https://b.test' })
    expect(h.navigate).toHaveBeenCalledWith(fake.pages.get('T1'), 'https://b.test', {})
    expect(fake.mock.page).toHaveBeenCalledWith('bot-conv')
    // Each call renews the browser's activity.
    expect(fake.mock.touch).toHaveBeenCalled()
    expect(h.acquireBrowserForControl).not.toHaveBeenCalled()

    const listed = await handlers.browser_tabs({})
    expect(listed.content[0]!.text).toContain('https://a.test')
    await handlers.browser_new_tab({ url: 'https://c.test' })
    await handlers.browser_switch_tab({ index: 1 })
    expect(fake.mock.switchTab).toHaveBeenCalledWith('bot-conv', 'T1')
    await handlers.browser_close_tab({ index: 2 })
    expect(fake.mock.closeTab).toHaveBeenCalledWith('bot-conv', 'T2')
    await expect(handlers.browser_close_tab({ index: 5 })).resolves.toMatchObject({ isError: true })
  })

  it('takes screenshots through the protocol', async () => {
    const decoded = { isEmpty: () => false }
    const createFromBuffer = vi.spyOn(nativeImage, 'createFromBuffer').mockReturnValue(decoded as never)
    const { handlers } = register('bot-conv')
    await handlers.browser_new_tab({})
    await handlers.browser_screenshot({}, { signal: new AbortController().signal })
    expect(fake.pages.get('T1')!.captureScreenshot).toHaveBeenCalled()
    expect(createFromBuffer).toHaveBeenCalledWith(Buffer.from('png'))
    createFromBuffer.mockRestore()
  })

  it('gives a delegated worker tabs of its own, closed with it', async () => {
    const { handlers: main } = register('bot-conv')
    await main.browser_new_tab({ url: 'https://shared.test' })
    const scope = createMaestroWorkerScope({ conversationId: 'bot-conv', delegationId: 'worker-1' })
    const { handlers } = register('bot-conv', scope)
    await handlers.browser_navigate({ url: 'https://worker.test' })
    expect(fake.mock.createTab).toHaveBeenLastCalledWith('bot-conv', 'https://shared.test', {
      ownerScopeId: scope.id,
      activate: false,
    })
    const workerTab = fake.tabs.find((tab) => tab.scopeId === scope.id)!
    expect(fake.mock.page).toHaveBeenCalledWith('bot-conv', workerTab.id)
    expect(h.navigate).toHaveBeenLastCalledWith(fake.pages.get(workerTab.id), 'https://worker.test', {})
    await handlers.browser_new_tab({ url: 'https://second.test' })
    const listed = (await handlers.browser_tabs({})).content[0]!.text!
    // The worker's own two tabs, not the conversation's.
    expect(listed.split('\n')).toHaveLength(2)
    expect(listed).toContain('https://second.test')
    await scope.close()
    expect(fake.tabs.map((tab) => tab.url)).toEqual(['https://shared.test'])
  })

  it('keeps every other conversation on the drawer’s browser', async () => {
    const lease = { webContents: { drawer: true }, captureFrame: vi.fn(), release: vi.fn() }
    h.acquireBrowserForControl.mockReturnValue(lease)
    const { handlers, descriptions } = register('owner-conv')
    expect(descriptions.browser_navigate).toContain('notes.drawer')
    await handlers.browser_navigate({ url: 'https://d.test' })
    expect(h.navigate).toHaveBeenCalledWith(lease.webContents, 'https://d.test', {})
    expect(lease.release).toHaveBeenCalled()
    expect(fake.mock.page).not.toHaveBeenCalled()
  })
})
