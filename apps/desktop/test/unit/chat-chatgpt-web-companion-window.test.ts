import type { BrowserWindow, Session, WebContentsView, WebContentsViewConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHATGPT_WEB_PARTITION,
  CHATGPT_WEB_URL,
  createChatGptWebCompanionWindows,
  resumableChatGptConversationUrl,
} from '../../src/main/chat/chatgpt-web/companion-window'
import { getDrawer, setActiveConvId, setSlot, setVisibleKind } from '../../src/main/drawer/state'
import {
  acquireAgentActivity,
  disposeConversationResources,
  setResourceVisible,
} from '../../src/main/performance/resource-governor'
import {
  disposeMemoryReclaimer,
  runMemoryReclaim,
  setMemoryAutoReclaimEnabledForTests,
} from '../../src/main/performance/memory-reclaimer'
import { CHATGPT_VIEW_COLD_TTL_MS } from '../../src/main/performance/policy'

class FakeWebContents {
  listeners = new Map<string, Array<(...args: any[]) => void>>()
  windowOpenHandler: ((details: any) => any) | null = null
  destroyed = false
  currentUrl = ''
  loadURL = vi.fn(async (url: string) => {
    this.currentUrl = url
  })
  close = vi.fn(() => {
    this.destroyed = true
    this.emit('destroyed')
  })
  setBackgroundThrottling = vi.fn()

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const wrapped = (...args: any[]) => {
      this.removeListener(event, wrapped)
      listener(...args)
    }
    return this.on(event, wrapped)
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener)
    )
    return this
  }

  setWindowOpenHandler(handler: (details: any) => any): void {
    this.windowOpenHandler = handler
  }

  executeJavaScript = vi.fn(async () => false)
  isLoading = vi.fn(() => false)

  isDestroyed(): boolean {
    return this.destroyed
  }

  getURL(): string {
    return this.currentUrl
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

class FakeView {
  webContents = new FakeWebContents()
  bounds: unknown
  background: string | undefined

  setBackgroundColor(color: string): void {
    this.background = color
  }

  setBounds(bounds: unknown): void {
    this.bounds = bounds
  }
}

class FakeContentView {
  children: FakeView[] = []

  addChildView(view: FakeView): void {
    this.children = this.children.filter((candidate) => candidate !== view)
    this.children.push(view)
  }

  removeChildView(view: FakeView): void {
    this.children = this.children.filter((candidate) => candidate !== view)
  }
}

class FakeWindow {
  contentView = new FakeContentView()
  webContents = new FakeWebContents()
  destroyed = false
  listeners = new Map<string, Array<(...args: any[]) => void>>()

  isDestroyed(): boolean {
    return this.destroyed
  }

  setVisibleOnAllWorkspaces(): void {}
  center(): void {}
  show(): void {}
  focus(): void {}

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const listener of [...(this.listeners.get('closed') ?? [])]) listener()
  }
}

function harness() {
  const views: FakeView[] = []
  const viewOptions: WebContentsViewConstructorOptions[] = []
  const mainWindow = new FakeWindow()
  const isolatedSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    clearStorageData: vi.fn(async () => undefined),
  }
  const savedUrls = new Map<string, string>()
  const clearConversationUrls = vi.fn(() => savedUrls.clear())
  const companion = createChatGptWebCompanionWindows({
    session: isolatedSession as unknown as Session,
    getMainWindow: () => mainWindow as unknown as BrowserWindow,
    createView: (options) => {
      viewOptions.push(options)
      const view = new FakeView()
      views.push(view)
      return view as unknown as WebContentsView
    },
    loadConversationUrl: (conversationId) => savedUrls.get(conversationId),
    saveConversationUrl: (conversationId, url) => savedUrls.set(conversationId, url),
    clearConversationUrls,
  })
  return { companion, isolatedSession, mainWindow, views, viewOptions, savedUrls, clearConversationUrls }
}

describe('ChatGPT Web companion WebContentsView tab', () => {
  beforeEach(() => {
    setMemoryAutoReclaimEnabledForTests(false)
  })
  afterEach(() => {
    setMemoryAutoReclaimEnabledForTests(null)
    disposeMemoryReclaimer()
    setActiveConvId(null)
    setSlot(null)
    setVisibleKind(null)
    vi.useRealTimers()
  })

  it('creates isolated views on demand without preload or automation', async () => {
    const h = harness()
    await h.companion.open('companion-create')

    expect(h.viewOptions).toHaveLength(1)
    expect(h.viewOptions[0]).toMatchObject({
      webPreferences: {
        partition: CHATGPT_WEB_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    expect(h.viewOptions[0].webPreferences).not.toHaveProperty('backgroundThrottling')
    expect(h.viewOptions[0].webPreferences).not.toHaveProperty('preload')
    expect(h.views[0].webContents.loadURL).toHaveBeenLastCalledWith(CHATGPT_WEB_URL)
    expect(h.mainWindow.contentView.children).toEqual([h.views[0]])
    expect(h.views[0].webContents.listeners.get('before-input-event')).toHaveLength(2)
    expect(h.isolatedSession.setPermissionRequestHandler).toHaveBeenCalledOnce()
    expect(h.isolatedSession.setPermissionCheckHandler).toHaveBeenCalledOnce()
  })

  it('reuses views per conversation while isolating conversations', async () => {
    const h = harness()
    await h.companion.open('companion-reuse')
    await h.companion.open('companion-reuse')
    await h.companion.open('companion-separate')

    expect(h.views).toHaveLength(2)
    expect(h.views[0].webContents.loadURL).toHaveBeenCalledTimes(2)
    expect(h.views[1].webContents.loadURL).toHaveBeenCalledTimes(2)
  })

  it('resumes remote conversations after companion restart', async () => {
    const h = harness()
    await h.companion.open('companion-resume')
    h.views[0].webContents.emit(
      'did-navigate-in-page',
      {},
      'https://chatgpt.com/g/g-example/c/12345678-abcd?temporary=1#fragment'
    )

    expect(h.savedUrls.get('companion-resume')).toBe('https://chatgpt.com/g/g-example/c/12345678-abcd')
    h.companion.close('companion-resume')
    await h.companion.open('companion-resume')

    expect(h.views).toHaveLength(2)
    expect(h.views[1].webContents.loadURL).toHaveBeenLastCalledWith('https://chatgpt.com/g/g-example/c/12345678-abcd')
  })

  it('restores safe persisted URLs after manager recreation', async () => {
    const h = harness()
    h.savedUrls.set('companion-persisted', 'https://chatgpt.com/c/persisted-chat-123?ignored=1')
    h.savedUrls.set('companion-invalid', 'https://chatgpt.com.evil.test/c/not-allowed')

    await h.companion.open('companion-persisted')
    await h.companion.open('companion-invalid')

    expect(h.views[0].webContents.loadURL).toHaveBeenLastCalledWith('https://chatgpt.com/c/persisted-chat-123')
    expect(h.views[1].webContents.loadURL).toHaveBeenLastCalledWith(CHATGPT_WEB_URL)
  })

  it('does not persist unowned pages or lookalike origins', () => {
    expect(resumableChatGptConversationUrl('https://chatgpt.com/')).toBeNull()
    expect(resumableChatGptConversationUrl('https://chatgpt.com/plugins')).toBeNull()
    expect(resumableChatGptConversationUrl('https://chatgpt.com.evil.test/c/12345678')).toBeNull()
    expect(resumableChatGptConversationUrl('http://chatgpt.com/c/12345678')).toBeNull()
  })

  it('blocks unsafe navigation and secures HTTPS popups', async () => {
    const h = harness()
    await h.companion.open('companion-navigation')
    const wc = h.views[0].webContents
    const prevented = vi.fn()
    wc.emit('will-navigate', { preventDefault: prevented }, 'file:///tmp/secret')
    expect(prevented).toHaveBeenCalledOnce()

    const unsafe = wc.windowOpenHandler?.({ url: 'http://example.com', disposition: 'new-window' })
    const oauth = wc.windowOpenHandler?.({ url: 'https://auth.example.com', disposition: 'new-window' })
    expect(unsafe).toEqual({ action: 'deny' })
    expect(oauth?.action).toBe('allow')
    expect(oauth?.overrideBrowserWindowOptions?.webPreferences).not.toHaveProperty('preload')
  })

  it('closes only companion-owned OAuth popups', async () => {
    const h = harness()
    const drawerOauth = new FakeWindow()
    getDrawer('companion-oauth-owner').oauthWindows.add(drawerOauth as unknown as BrowserWindow)
    await h.companion.open('companion-oauth-owner')

    const companionOauth = new FakeWindow()
    h.views[0].webContents.emit('did-create-window', companionOauth)
    h.companion.close('companion-oauth-owner')

    expect(companionOauth.destroyed).toBe(true)
    expect(drawerOauth.destroyed).toBe(false)
    drawerOauth.destroy()
    getDrawer('companion-oauth-owner').oauthWindows.clear()
  })

  it('propagates load failures and removes invalid views for clean retries', async () => {
    const h = harness()
    const firstFailure = new Error('dns-failure')
    const loadURL = vi.fn(async () => undefined)
    loadURL.mockRejectedValueOnce(firstFailure)
    const retryHarness = createChatGptWebCompanionWindows({
      session: h.isolatedSession as unknown as Session,
      getMainWindow: () => h.mainWindow as unknown as BrowserWindow,
      createView: (options) => {
        h.viewOptions.push(options)
        const view = new FakeView()
        view.webContents.loadURL = loadURL
        h.views.push(view)
        return view as unknown as WebContentsView
      },
    })

    await expect(retryHarness.open('companion-load-retry')).rejects.toThrow('dns-failure')
    expect(h.mainWindow.contentView.children).toEqual([])
    expect(h.views[0].webContents.close).toHaveBeenCalledOnce()

    await retryHarness.open('companion-load-retry')
    expect(h.views).toHaveLength(2)
    expect(h.views[1].webContents.loadURL).toHaveBeenLastCalledWith(CHATGPT_WEB_URL)
    expect(h.mainWindow.contentView.children).toEqual([h.views[1]])
  })

  it('ending and clearing storage closes dedicated views', async () => {
    const h = harness()
    await h.companion.open('companion-clear-a')
    await h.companion.open('companion-clear-b')
    h.views[0].webContents.emit('did-navigate', {}, 'https://chatgpt.com/c/clear-me-123')
    await h.companion.clearStorage()

    expect(h.views.every((view) => view.webContents.close.mock.calls.length === 1)).toBe(true)
    expect(h.mainWindow.contentView.children).toEqual([])
    expect(h.isolatedSession.clearStorageData).toHaveBeenCalledOnce()
    expect(h.savedUrls.size).toBe(0)
    expect(h.clearConversationUrls).toHaveBeenCalledOnce()
  })

  it('evicts a hidden view after the TTL while keeping the persisted URL and allowing restore', async () => {
    setMemoryAutoReclaimEnabledForTests(true)
    vi.useFakeTimers()
    const h = harness()
    await h.companion.open('companion-cold')
    h.views[0].webContents.emit('did-navigate', {}, 'https://chatgpt.com/c/cold-restore-123')
    setActiveConvId('other')
    setVisibleKind('chatgpt')

    await vi.advanceTimersByTimeAsync(CHATGPT_VIEW_COLD_TTL_MS)
    await runMemoryReclaim('normal')

    expect(h.views[0].webContents.close).toHaveBeenCalledOnce()
    expect(getDrawer('companion-cold').chatgptView).toBeNull()
    expect(h.savedUrls.get('companion-cold')).toBe('https://chatgpt.com/c/cold-restore-123')

    await h.companion.open('companion-cold')
    expect(h.views[1].webContents.loadURL).toHaveBeenLastCalledWith('https://chatgpt.com/c/cold-restore-123')
  })

  it('keeps the two most recent hidden views warm and immediately reclaims only older extras', async () => {
    setMemoryAutoReclaimEnabledForTests(true)
    vi.useFakeTimers()
    const h = harness()

    await h.companion.open('companion-warm-a')
    await vi.advanceTimersByTimeAsync(1)
    await h.companion.open('companion-warm-b')
    await runMemoryReclaim('normal')

    expect(h.views[0].webContents.close).not.toHaveBeenCalled()
    expect(h.views[1].webContents.close).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await h.companion.open('companion-warm-c')
    await runMemoryReclaim('normal')

    expect(h.views[0].webContents.close).toHaveBeenCalledOnce()
    expect(h.views[1].webContents.close).not.toHaveBeenCalled()
    expect(h.views[2].webContents.close).not.toHaveBeenCalled()
  })

  it('resets TTL when a long-visible view becomes hidden', async () => {
    setMemoryAutoReclaimEnabledForTests(true)
    vi.useFakeTimers()
    const h = harness()
    const conversationId = 'companion-visible-hide'
    await h.companion.open(conversationId)

    setActiveConvId(conversationId)
    setVisibleKind('chatgpt')
    setSlot({ x: 0, y: 0, width: 800, height: 600 })
    setResourceVisible('chatgpt', conversationId, undefined, true)
    h.companion.noteSurfaceVisibility(conversationId) // Baseline: visible protects the surface without touching it.

    await vi.advanceTimersByTimeAsync(CHATGPT_VIEW_COLD_TTL_MS + 1)
    await runMemoryReclaim('normal')
    expect(h.views[0].webContents.close).not.toHaveBeenCalled()

    setActiveConvId('other-conversation')
    setResourceVisible('chatgpt', conversationId, undefined, false)
    h.companion.noteSurfaceVisibility(conversationId)

    await vi.advanceTimersByTimeAsync(CHATGPT_VIEW_COLD_TTL_MS - 1)
    await runMemoryReclaim('normal')
    expect(h.views[0].webContents.close).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await runMemoryReclaim('normal')
    expect(h.views[0].webContents.close).toHaveBeenCalledOnce()
  })

  it('skips cheap protections but probes and protects eligible hidden drafts', async () => {
    setMemoryAutoReclaimEnabledForTests(true)
    const visibleHarness = harness()
    await visibleHarness.companion.open('companion-protect-visible')
    setActiveConvId('companion-protect-visible')
    setVisibleKind('chatgpt')
    setResourceVisible('chatgpt', 'companion-protect-visible', undefined, true)

    await runMemoryReclaim('hard')
    expect(visibleHarness.views[0].webContents.executeJavaScript).not.toHaveBeenCalled()
    expect(visibleHarness.views[0].webContents.close).not.toHaveBeenCalled()
    visibleHarness.companion.close('companion-protect-visible')

    const leaseHarness = harness()
    await leaseHarness.companion.open('companion-protect-lease')
    const releaseLease = acquireAgentActivity('chatgpt', 'companion-protect-lease')
    await runMemoryReclaim('hard')
    expect(leaseHarness.views[0].webContents.executeJavaScript).not.toHaveBeenCalled()
    leaseHarness.companion.close('companion-protect-lease')
    releaseLease()
    disposeConversationResources('companion-protect-lease')

    const oauthHarness = harness()
    await oauthHarness.companion.open('companion-protect-oauth')
    const oauth = new FakeWindow()
    oauthHarness.views[0].webContents.emit('did-create-window', oauth)
    setActiveConvId('other')
    await runMemoryReclaim('hard')
    expect(oauthHarness.views[0].webContents.executeJavaScript).not.toHaveBeenCalled()
    expect(oauthHarness.views[0].webContents.close).not.toHaveBeenCalled()
    oauth.destroy()
    oauthHarness.companion.close('companion-protect-oauth')

    const loadingHarness = harness()
    loadingHarness.companion.ensure('companion-protect-loading')
    loadingHarness.views[0].webContents.isLoading.mockReturnValue(true)
    await runMemoryReclaim('hard')
    expect(loadingHarness.views[0].webContents.executeJavaScript).not.toHaveBeenCalled()
    expect(loadingHarness.views[0].webContents.close).not.toHaveBeenCalled()
    loadingHarness.companion.close('companion-protect-loading')

    const eligibleHarness = harness()
    await eligibleHarness.companion.open('companion-protect-draft')
    eligibleHarness.views[0].webContents.executeJavaScript.mockResolvedValueOnce(true)
    await runMemoryReclaim('hard')
    expect(eligibleHarness.views[0].webContents.executeJavaScript).toHaveBeenCalledOnce()
    expect(eligibleHarness.views[0].webContents.close).not.toHaveBeenCalled()
    eligibleHarness.companion.close('companion-protect-draft')
  })

  it('does not let a stale close destroy a replacement view', async () => {
    const h = harness()
    await h.companion.open('companion-stale')
    const first = h.views[0]
    h.companion.close('companion-stale')
    await h.companion.open('companion-stale')
    first.webContents.emit('destroyed')

    expect(getDrawer('companion-stale').chatgptView).toBe(h.views[1] as never)
    expect(h.views[1].webContents.close).not.toHaveBeenCalled()
  })
})
