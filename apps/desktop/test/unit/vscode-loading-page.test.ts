import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeWebContents {
    destroyed = false
    url = ''
    listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    loadURL = vi.fn(async (url: string) => {
      this.url = url
    })
    executeJavaScript = vi.fn(async (_code: string) => undefined)
    getURL(): string {
      return this.url
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      return this.on(event, listener)
    }
  }
  class FakeWebContentsView {
    webContents = new FakeWebContents()
    setBackgroundColor = vi.fn()
    setBounds = vi.fn()
  }
  return { WebContentsView: FakeWebContentsView, running: { value: true }, stop: vi.fn() }
})

vi.mock('electron', () => ({ WebContentsView: h.WebContentsView, session: { fromPartition: vi.fn() } }))
vi.mock('../../src/main/i18n', () => ({
  tMain: vi.fn(() => (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key)),
  getMainLocale: vi.fn(() => 'en'),
}))
vi.mock('../../src/main/hotkeys', () => ({ attachHotkeyCapture: vi.fn() }))
vi.mock('../../src/main/mouse-navigation', () => ({ attachMacMouseNavigation: vi.fn() }))
vi.mock('../../src/main/vscode/vscode-navigation', () => ({ requestVSCodeNavigation: vi.fn() }))
vi.mock('../../src/main/drawer/layout', () => ({ applyLayout: vi.fn() }))
vi.mock('../../src/main/performance/resource-governor', () => ({
  registerThrottleTarget: vi.fn(),
  resourceNeedsFullSpeed: vi.fn(() => false),
  unregisterThrottleTarget: vi.fn(),
}))
vi.mock('../../src/main/performance/metrics', () => ({
  registerPerformanceWebContents: vi.fn(),
  unregisterPerformanceWebContents: vi.fn(),
}))
vi.mock('../../src/main/vscode/vscode-memory', () => ({
  hasVSCodeBridgeInFlight: vi.fn(() => false),
  onVSCodeBridgeIdle: vi.fn(() => () => {}),
  requestVSCodeMemorySnapshot: vi.fn(async () => null),
}))
vi.mock('../../src/main/vscode/vscode-server', () => ({
  isVSCodeServerRunning: vi.fn(() => h.running.value),
  stopVSCodeServer: h.stop,
}))
vi.mock('../../src/main/store', () => ({ getConversation: vi.fn(() => undefined) }))

import { drawers, initDrawer } from '../../src/main/drawer/state'
import {
  loadVSCode,
  noteRemoteEditorActivity,
  showVSCodeLoading,
  stopVSCodeServerIfIdle,
  vscodeLoadingHtml,
} from '../../src/main/drawer/vscode'
import { disposeMemoryReclaimer } from '../../src/main/performance/memory-reclaimer'
import { noteVSCodeSetup } from '../../src/main/vscode/setup-progress'

const TOTAL = 229_217_515

/** The view model a page starts from, or null when it has no progress bar. */
function initialView(html: string): unknown {
  const match = /window\.__vscodeSetup\((\{.*?\})\);/.exec(html)
  return match ? JSON.parse(match[1]) : null
}

function webContents(convId: string) {
  return drawers.get(convId)!.vscodeView!.webContents as unknown as InstanceType<
    typeof h.WebContentsView
  >['webContents']
}

beforeEach(() => {
  // Pushes are throttled by a timer: each test starts and ends with none pending.
  vi.useFakeTimers()
  drawers.clear()
  initDrawer({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } } as never)
  h.running.value = true
  h.stop.mockClear()
})
afterEach(async () => {
  noteVSCodeSetup({ kind: 'reset' })
  await vi.advanceTimersByTimeAsync(1000)
  noteRemoteEditorActivity(0)
  disposeMemoryReclaimer()
  drawers.clear()
  vi.useRealTimers()
})

describe('the loading page of the editor', () => {
  it('starts from the current setup, with a bar only on pages of this computer that can wait on a download', () => {
    expect(initialView(vscodeLoadingHtml('downloading'))).toEqual({ visible: false, percent: null, label: '' })
    noteVSCodeSetup({ kind: 'server-download', received: TOTAL / 2, total: TOTAL })
    for (const phase of ['downloading', 'updating', 'starting', 'restarting'] as const) {
      expect(initialView(vscodeLoadingHtml(phase))).toEqual({
        visible: true,
        percent: 50,
        label: 'drawerLoading.progressDownload {"percent":50,"received":"115","total":"229"}',
      })
    }
    expect(vscodeLoadingHtml('updating')).toContain('drawerLoading.updatingTitle')
    for (const phase of ['error', 'remoteDownloading', 'remoteStarting', 'remoteFailed'] as const) {
      expect(initialView(vscodeLoadingHtml(phase))).toBeNull()
    }
  })

  it('moves the bar of local loading pages without reloading them, at most every 250 ms', async () => {
    showVSCodeLoading('waiting', 'http://127.0.0.1:8930/?tkn=t&folder=%2Fa', 'updating')
    loadVSCode('editing', 'http://127.0.0.1:8930/?tkn=t&folder=%2Fb')
    showVSCodeLoading('server-1/workspaces#conv-1', '', 'remoteDownloading')
    const waiting = webContents('waiting')
    expect(waiting.loadURL).toHaveBeenCalledTimes(1)

    noteVSCodeSetup({ kind: 'server-download', received: 0, total: TOTAL })
    noteVSCodeSetup({ kind: 'server-download', received: TOTAL / 4, total: TOTAL })
    noteVSCodeSetup({ kind: 'server-download', received: TOTAL / 2, total: TOTAL })
    expect(waiting.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(waiting.executeJavaScript.mock.calls[0][0]).toContain('"percent":0')

    await vi.advanceTimersByTimeAsync(250)
    expect(waiting.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(waiting.executeJavaScript.mock.calls[1][0]).toMatch(/^window\.__vscodeSetup&&window\.__vscodeSetup\(/)
    expect(waiting.executeJavaScript.mock.calls[1][0]).toContain('"percent":50')
    expect(waiting.loadURL).toHaveBeenCalledTimes(1)
    expect(webContents('editing').executeJavaScript).not.toHaveBeenCalled()
    expect(webContents('server-1/workspaces#conv-1').executeJavaScript).not.toHaveBeenCalled()
  })

  it('stops the editor server a warm-up started only while nothing uses it', () => {
    expect(stopVSCodeServerIfIdle()).toBe(true)
    expect(h.stop).toHaveBeenCalledTimes(1)

    noteRemoteEditorActivity(1)
    expect(stopVSCodeServerIfIdle()).toBe(false)
    noteRemoteEditorActivity(0)

    loadVSCode('editing', 'http://127.0.0.1:8930/?tkn=t&folder=%2Fb')
    expect(stopVSCodeServerIfIdle()).toBe(false)
    drawers.clear()

    h.running.value = false
    expect(stopVSCodeServerIfIdle()).toBe(false)
    expect(h.stop).toHaveBeenCalledTimes(1)
  })
})
