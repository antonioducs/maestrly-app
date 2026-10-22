import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CdpPipe } from '../../src/main/fleet/instance/bot-browser/cdp-pipe'
import { ChromiumPage } from '../../src/main/fleet/instance/bot-browser/chromium-page'

function page(send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  return new ChromiumPage({ send } as unknown as CdpPipe, 'target-1', 'session-1', {
    targetId: 'target-1',
    url: 'about:blank',
    title: '',
  })
}

afterEach(() => vi.useRealTimers())

describe('ChromiumPage.loadURL', () => {
  it('returns once the page has loaded, not when the browser starts the navigation', async () => {
    const tab = page(async () => ({}))
    let settled = false
    const load = tab.loadURL('http://example.test/').then(() => (settled = true))
    await vi.waitFor(() => expect(tab.debugger.listenerCount('message')).toBe(1))
    await Promise.resolve()
    expect(settled).toBe(false)
    tab.handleEvent({ method: 'Page.frameNavigated', params: { frame: { url: 'http://example.test/' } } })
    expect(settled).toBe(false)
    tab.handleEvent({ method: 'Page.loadEventFired', params: {} })
    await load
    expect(settled).toBe(true)
    expect(tab.debugger.listenerCount('message')).toBe(0)
  })

  it('gives a load that never fires a fixed wait', async () => {
    vi.useFakeTimers()
    const tab = page(async () => ({}))
    const load = tab.loadURL('http://example.test/')
    await vi.advanceTimersByTimeAsync(15_000)
    await load
    expect(tab.debugger.listenerCount('message')).toBe(0)
  })

  it('rejects a navigation the browser refused and stops listening', async () => {
    const tab = page(async () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }))
    await expect(tab.loadURL('http://nowhere.test/')).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/)
    expect(tab.debugger.listenerCount('message')).toBe(0)
  })

  it('stops waiting when the tab closes', async () => {
    const tab = page(async () => ({}))
    const load = tab.loadURL('http://example.test/')
    await vi.waitFor(() => expect(tab.debugger.listenerCount('message')).toBe(1))
    tab.markDestroyed()
    await load
  })
})
