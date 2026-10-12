import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRemoteUiTarget, registerRemoteUiTarget } from '../../src/main/remote-ui-targets'
import {
  broadcastGlobal,
  isTrustedSender,
  sendToConversation,
  sendToMainTargets,
  sendToPanel,
  sendToPanelTargets,
  setBroadcastMainWindow,
} from '../../src/main/window-ipc'

let nextId = -1000
function target() {
  return { id: nextId--, send: vi.fn(), isDestroyed: () => false }
}
function mainWindow() {
  const webContents = { send: vi.fn(), isDestroyed: () => false }
  return { webContents, isDestroyed: () => false }
}

const cleanup: Array<() => void> = []
const register: typeof registerRemoteUiTarget = (remote, meta) => {
  const off = registerRemoteUiTarget(remote, meta)
  cleanup.push(off)
  return off
}
afterEach(() => {
  for (const off of cleanup.splice(0)) off()
  setBroadcastMainWindow(null)
})

describe('remote UI targets', () => {
  it('gives a remote main renderer what the main window receives', () => {
    const local = mainWindow()
    setBroadcastMainWindow(local as never)
    const main = target()
    const panel = target()
    register(main, { role: 'main' })
    register(panel, { role: 'panel', convId: 'c', panel: 'terminal' })

    broadcastGlobal('x', 1)
    expect(local.webContents.send).toHaveBeenCalledWith('x', 1)
    expect(main.send).toHaveBeenCalledWith('x', 1)
    expect(panel.send).not.toHaveBeenCalled()

    // Panels have their own i18n, so they hear the few application-wide channels panels of this computer hear.
    broadcastGlobal('settings:locale-changed', 'pt-BR')
    expect(panel.send).toHaveBeenCalledWith('settings:locale-changed', 'pt-BR')

    sendToMainTargets('w', { a: 1 })
    expect(local.webContents.send).toHaveBeenCalledWith('w', { a: 1 })
    expect(main.send).toHaveBeenCalledWith('w', { a: 1 })
    expect(panel.send).not.toHaveBeenCalledWith('w', { a: 1 })
  })

  it('delivers conversation events to remote mains and to the remote panels of that conversation', () => {
    const main = target()
    const terminal = target()
    const notes = target()
    const other = target()
    register(main, { role: 'main' })
    register(terminal, { role: 'panel', convId: 'c', panel: 'terminal' })
    register(notes, { role: 'panel', convId: 'c', panel: 'notes' })
    register(other, { role: 'panel', convId: 'd', panel: 'terminal' })

    sendToConversation('c', 'y', 2)
    expect(main.send).toHaveBeenCalledWith('y', 2)
    expect(terminal.send).toHaveBeenCalledWith('y', 2)
    expect(notes.send).toHaveBeenCalledWith('y', 2)
    expect(other.send).not.toHaveBeenCalled()

    sendToConversation('c', 'only-notes', 3, { includeMain: false, panel: 'notes' })
    expect(main.send).not.toHaveBeenCalledWith('only-notes', 3)
    expect(terminal.send).not.toHaveBeenCalledWith('only-notes', 3)
    expect(notes.send).toHaveBeenCalledWith('only-notes', 3)

    sendToPanel('c', 'terminal', 'z', 4)
    expect(terminal.send).toHaveBeenCalledWith('z', 4)
    expect(main.send).not.toHaveBeenCalledWith('z', 4)
    expect(notes.send).not.toHaveBeenCalledWith('z', 4)
    expect(other.send).not.toHaveBeenCalledWith('z', 4)

    sendToPanelTargets('terminal', 'all-terminals', 5)
    expect(terminal.send).toHaveBeenCalledWith('all-terminals', 5)
    expect(other.send).toHaveBeenCalledWith('all-terminals', 5)
    expect(notes.send).not.toHaveBeenCalledWith('all-terminals', 5)
  })

  it('trusts a remote renderer only while it is registered', () => {
    const remote = target()
    expect(isTrustedSender(remote as never)).toBe(false)
    const off = register(remote, { role: 'main' })
    expect(isRemoteUiTarget(remote)).toBe(true)
    expect(isTrustedSender(remote as never)).toBe(true)
    off()
    expect(isRemoteUiTarget(remote)).toBe(false)
    expect(isTrustedSender(remote as never)).toBe(false)
  })

  it('forgets a remote renderer that is gone or whose send fails', () => {
    const failing = target()
    failing.send.mockImplementation(() => {
      throw new Error('socket closed')
    })
    const gone = { ...target(), isDestroyed: () => true }
    register(failing, { role: 'main' })
    register(gone, { role: 'main' })

    sendToMainTargets('a')
    sendToMainTargets('b')
    expect(failing.send).toHaveBeenCalledTimes(1)
    expect(gone.send).not.toHaveBeenCalled()
    expect(isRemoteUiTarget(failing)).toBe(false)
    expect(isRemoteUiTarget(gone)).toBe(false)
  })

  it('changes nothing on a computer with no remote renderer', () => {
    const local = mainWindow()
    setBroadcastMainWindow(local as never)
    sendToMainTargets('only-local', 1)
    expect(local.webContents.send.mock.calls).toEqual([['only-local', 1]])
  })
})
