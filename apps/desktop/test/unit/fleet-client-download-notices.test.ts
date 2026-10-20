import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  notifications: [] as {
    options: { title: string; body: string }
    handlers: Map<string, () => void>
    shown: boolean
  }[],
  windows: new Map<object, { focused: boolean; visible: boolean; minimized: boolean }>(),
  reveal: vi.fn(),
  focus: vi.fn(),
  path: vi.fn(async (_receipt: string): Promise<string> => '/downloads/report.pdf'),
}))
vi.mock('electron', () => ({
  Notification: class {
    static isSupported() {
      return true
    }
    private readonly entry: (typeof state.notifications)[number]
    constructor(options: { title: string; body: string }) {
      this.entry = { options, handlers: new Map(), shown: false }
      state.notifications.push(this.entry)
    }
    once(event: string, handler: () => void) {
      this.entry.handlers.set(event, handler)
      return this
    }
    show() {
      this.entry.shown = true
    }
  },
  BrowserWindow: {
    fromWebContents: (contents: object) => {
      const window = state.windows.get(contents)
      return window
        ? {
            isDestroyed: () => false,
            isFocused: () => window.focused,
            isVisible: () => window.visible,
            isMinimized: () => window.minimized,
          }
        : null
    },
  },
  shell: { showItemInFolder: state.reveal },
}))
vi.mock('../../src/main/window-ipc', () => ({ focusMainWindow: state.focus }))
vi.mock('../../src/main/fleet/client/download-history', () => ({ fleetDownloadPath: state.path }))

import { noticeFleetDownload, setAttendedFleetFiles } from '../../src/main/fleet/client/download-notices'
import type { FleetServerId } from '../../src/shared/fleet-servers'

function contents() {
  const listeners = new Map<string, () => void>()
  const value = {
    destroyed: false,
    isDestroyed: () => value.destroyed,
    once: (event: string, listener: () => void) => listeners.set(event, listener),
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    emit: (event: string) => listeners.get(event)?.(),
    destroy: () => {
      value.destroyed = true
      listeners.get('destroyed')?.()
    },
  }
  return value
}
const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const OTHER_SERVER = 'bbbbbbbb-0000-4000-8000-000000000002' as FleetServerId
const shown = { serverId: SERVER, botId: 'bot', fileId: 'f-report' }
const saved = {
  outcome: 'saved' as const,
  botId: 'bot',
  fileId: 'f-report',
  name: 'report.pdf',
  path: '/downloads/report.pdf',
  receipt: '550e8400-e29b-41d4-a716-446655440000',
}

beforeEach(() => {
  state.notifications.length = 0
  state.windows.clear()
  vi.clearAllMocks()
})

describe('fleet download notices', () => {
  it('stays quiet only while a focused, visible window shows the file', async () => {
    const main = contents()
    state.windows.set(main, { focused: true, visible: true, minimized: false })
    setAttendedFleetFiles(main as never, [shown])
    noticeFleetDownload(SERVER, saved, 'Scout')
    expect(state.notifications).toEqual([])
    // Another bot's file with the same id is not the one shown.
    noticeFleetDownload(SERVER, { ...saved, botId: 'other' }, null)
    expect(state.notifications).toHaveLength(1)
    // The same bot and file of another server is not the one shown either.
    noticeFleetDownload(OTHER_SERVER, saved, null)
    expect(state.notifications).toHaveLength(2)
    state.notifications.pop()
    // The owner switched to another app.
    state.windows.set(main, { focused: false, visible: true, minimized: false })
    noticeFleetDownload(SERVER, saved, 'Scout')
    expect(state.notifications).toHaveLength(2)
    // The owner left the bot's chat: the window reports what it shows now.
    state.windows.set(main, { focused: true, visible: true, minimized: false })
    setAttendedFleetFiles(main as never, [])
    noticeFleetDownload(SERVER, saved, 'Scout')
    expect(state.notifications).toHaveLength(3)
    expect(state.notifications.at(-1)).toMatchObject({
      options: { title: 'Download complete', body: 'report.pdf from Scout' },
      shown: true,
    })
    // A reloaded page shows none of its old cards until they mount again.
    setAttendedFleetFiles(main as never, [shown])
    main.emit('did-navigate')
    noticeFleetDownload(SERVER, saved, 'Scout')
    expect(state.notifications).toHaveLength(4)
    // A closed window no longer counts.
    setAttendedFleetFiles(main as never, [shown])
    main.destroy()
    noticeFleetDownload(SERVER, saved, 'Scout')
    expect(state.notifications).toHaveLength(5)
  })

  it('shows the saved file in its folder on click, or brings the app forward for a failure', async () => {
    noticeFleetDownload(SERVER, saved, null)
    expect(state.notifications[0].options).toEqual({ title: 'Download complete', body: 'report.pdf' })
    state.notifications[0].handlers.get('click')?.()
    await vi.waitFor(() => expect(state.reveal).toHaveBeenCalledExactlyOnceWith('/downloads/report.pdf'))
    expect(state.path).toHaveBeenCalledWith(saved.receipt)
    // A file moved away since: the app comes forward instead.
    state.path.mockRejectedValueOnce(new Error('FLEET_LOCAL_DOWNLOAD_MISSING'))
    noticeFleetDownload(SERVER, saved, null)
    state.notifications[1].handlers.get('click')?.()
    await vi.waitFor(() => expect(state.focus).toHaveBeenCalledOnce())
    noticeFleetDownload(
      SERVER,
      { outcome: 'failed', botId: 'bot', fileId: 'f-report', name: null, error: 'FLEET_DOWNLOAD_FAILED' },
      'Scout'
    )
    expect(state.notifications[2].options).toEqual({ title: 'Download failed', body: 'Bot file from Scout' })
    state.notifications[2].handlers.get('click')?.()
    expect(state.focus).toHaveBeenCalledTimes(2)
    expect(state.reveal).toHaveBeenCalledOnce()
  })
})
