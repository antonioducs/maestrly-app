import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  broadcastGlobal,
  registerPanelTarget,
  sendToConversation,
  sendToPanel,
  sendToPanelTargets,
  setBroadcastMainWindow,
  unregisterPanelTarget,
} from '../../src/main/window-ipc'

function contents() {
  return {
    sends: [] as Array<[string, unknown]>,
    destroyed: false,
    send(channel: string, payload: unknown) {
      this.sends.push([channel, payload])
    },
    isDestroyed() {
      return this.destroyed
    },
    once: vi.fn(),
  }
}

describe('window IPC routing', () => {
  afterEach(() => setBroadcastMainWindow(null))

  it('delivers global events only to global targets and directed events to the matching panel', () => {
    const mainContents = contents()
    const terminal = contents()
    const notes = contents()
    const browser = contents()
    const strip = contents()
    const main = { webContents: mainContents, isDestroyed: () => false }

    setBroadcastMainWindow(main as never)
    registerPanelTarget(terminal as never, { convId: 'conv-1', panel: 'terminal' })
    registerPanelTarget(notes as never, { convId: 'conv-1', panel: 'notes' })
    registerPanelTarget(browser as never, { convId: 'conv-2', panel: 'browser' })
    registerPanelTarget(strip as never, { global: true, panel: 'floating-strip' })

    broadcastGlobal('global:event', { ok: true })
    expect(mainContents.sends).toHaveLength(1)
    expect(terminal.sends).toHaveLength(0)
    expect(notes.sends).toHaveLength(0)
    expect(strip.sends).toHaveLength(1)

    sendToPanel('conv-1', 'terminal', 'pty:data', 'chunk')
    expect(terminal.sends).toEqual([['pty:data', 'chunk']])
    expect(notes.sends).toHaveLength(0)

    sendToConversation('conv-1', 'drawer:notes-state', { page: 1 }, { panel: 'notes' })
    expect(mainContents.sends).toHaveLength(2)
    expect(notes.sends).toEqual([['drawer:notes-state', { page: 1 }]])

    sendToPanelTargets('browser', 'browser:changed', { conversationId: 'conv-2' })
    expect(terminal.sends).toHaveLength(1)
    expect(browser.sends).toEqual([['browser:changed', { conversationId: 'conv-2' }]])

    unregisterPanelTarget(terminal as never)
    unregisterPanelTarget(notes as never)
    unregisterPanelTarget(browser as never)
    unregisterPanelTarget(strip as never)
  })
})
