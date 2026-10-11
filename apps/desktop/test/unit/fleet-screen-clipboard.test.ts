import { describe, expect, it, vi } from 'vitest'
import { DisplayManager } from '../../src/main/fleet/instance/displays'
import { attachScreenClipboard } from '../../src/renderer/lib/fleet/screen-clipboard'

function setup(isMac = true) {
  const container = new EventTarget()
  const doc = { visibilityState: 'visible', hasFocus: () => true, activeElement: container }
  Object.assign(container, { ownerDocument: doc, contains: (element: unknown) => element === container })
  const remote = Object.assign(new EventTarget(), { clipboardPasteFrom: vi.fn(), sendKey: vi.fn() })
  const write = vi.fn(async (_text: string) => {})
  const read = vi.fn(async () => 'terminal')
  const error = vi.fn()
  const detach = attachScreenClipboard(container as HTMLElement, remote, write, isMac, error, read)
  const emit = (type: string, data = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), data)
    container.dispatchEvent(event)
    return event
  }
  const receive = (text: unknown) => remote.dispatchEvent(Object.assign(new Event('clipboard'), { detail: { text } }))
  return { container, doc, remote, write, read, error, detach, emit, receive }
}

describe('controlled screen text clipboard', () => {
  it.each(['menu', 'Command+Shift+V'])('copies the latest %s paste without a server notification', async (path) => {
    const s = setup()
    try {
      s.receive('A')
      if (path === 'menu') {
        s.emit('paste', { clipboardData: { types: ['text/plain'], getData: () => 'M' } })
      } else {
        s.read.mockResolvedValueOnce('M')
        s.emit('keydown', { code: 'KeyV', key: 'V', metaKey: true, shiftKey: true })
        s.emit('keyup', { code: 'KeyV', key: 'V', metaKey: true, shiftKey: true })
        await Promise.resolve()
      }
      expect(s.remote.clipboardPasteFrom).toHaveBeenCalledWith('M')
      expect(s.write).not.toHaveBeenCalled()
      // x11vnc suppresses notifications when CLIPBOARD still matches the pasted text.
      s.emit('copy')
      expect(s.write.mock.calls).toEqual([['M']])
    } finally {
      s.detach()
    }
  })
  it.each(['copy', 'cut'])(
    'keeps the copied text after %s with no notification and a new PRIMARY selection',
    async (action) => {
      const s = setup()
      let serverArgs: string[] = []
      const manager = new DisplayManager({
        home: '/srv/maestrly-clipboard-test',
        mkdir: async () => {},
        setTimeout,
        clearTimeout,
        log: () => {},
        spawn: (command, args) => {
          if (command !== 'x11vnc') return { exited: Promise.resolve(0), kill: () => {} }
          serverArgs = [...args]
          let exit!: (code: number) => void
          const exited = new Promise<number>((resolve) => {
            exit = resolve
          })
          return { exited, kill: () => exit(0) }
        },
      })
      const now = vi.spyOn(Date, 'now').mockReturnValue(100)
      try {
        await manager.acquireVnc({ kind: 'environment' }, 'control')
        // Model x11vnc's selection filtering using the actual server startup arguments.
        // RFB cut text has no selection type, so PRIMARY must be filtered before receive().
        const select = (text: string) => {
          if (!serverArgs.includes('-noprimary')) s.receive(text)
        }
        s.receive('X')
        select('selection from another app')
        s.emit(action)
        // An unchanged CLIPBOARD produces no notification; the copy remains pending.
        now.mockReturnValue(1_100)
        select('selection')
        expect(s.write.mock.calls).toEqual([['X']])
        s.emit('paste', { clipboardData: { types: ['text/plain'], getData: () => s.write.mock.calls.at(-1)![0] } })
        expect(s.remote.clipboardPasteFrom).toHaveBeenCalledWith('X')
      } finally {
        now.mockRestore()
        s.detach()
        await manager.dispose()
      }
    }
  )
  it('reads macOS terminal paste explicitly and never leaves Shift for a menu paste', async () => {
    const s = setup()
    const event = s.emit('keydown', { code: 'KeyV', key: 'V', metaKey: true, shiftKey: true })
    expect(event.defaultPrevented).toBe(true)
    s.emit('keyup', { code: 'KeyV', key: 'V', metaKey: true, shiftKey: true })
    await Promise.resolve()
    expect(s.read).toHaveBeenCalledOnce()
    expect(s.remote.clipboardPasteFrom).toHaveBeenCalledWith('terminal')
    expect(s.remote.sendKey.mock.calls).toContainEqual([0xffe1, 'ShiftLeft', true])
    s.remote.sendKey.mockClear()
    s.emit('paste', { clipboardData: { types: ['text/plain'], getData: () => 'menu' } })
    expect(s.remote.sendKey.mock.calls).not.toContainEqual([0xffe1, 'ShiftLeft', true])
  })
  it.each(['focusout', 'disconnect', 'dispose'])('discards a pending native read after %s', async (action) => {
    const s = setup()
    let resolve!: (text: string) => void
    s.read.mockReturnValueOnce(
      new Promise<string>((done) => {
        resolve = done
      })
    )
    s.emit('keydown', { code: 'KeyV', key: 'V', metaKey: true, shiftKey: true })
    if (action === 'disconnect') s.remote.dispatchEvent(new Event('disconnect'))
    else if (action === 'dispose') s.detach()
    else s.emit('focusout')
    resolve('stale')
    await Promise.resolve()
    expect(s.remote.clipboardPasteFrom).not.toHaveBeenCalled()
  })
  it('reports native read failures without contaminating later menu pastes', async () => {
    const s = setup()
    s.read.mockRejectedValueOnce(new Error('denied'))
    s.emit('keydown', { code: 'KeyV', key: 'V', metaKey: true, shiftKey: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(s.error).toHaveBeenCalledWith('readFailed')
    s.emit('paste', { clipboardData: { types: ['text/plain'], getData: () => 'menu' } })
    expect(s.remote.sendKey.mock.calls).not.toContainEqual([0xffe1, 'ShiftLeft', true])
  })
  it('clears Shift on keyup when no native paste event arrives', () => {
    const s = setup(false)
    s.emit('keydown', { code: 'KeyV', key: 'V', ctrlKey: true, shiftKey: true })
    s.emit('keyup', { code: 'ShiftLeft', key: 'Shift', ctrlKey: true })
    s.emit('paste', { clipboardData: { types: ['text/plain'], getData: () => 'menu' } })
    expect(s.remote.sendKey.mock.calls).not.toContainEqual([0xffe1, 'ShiftLeft', true])
  })

  it('sends clipboard data before the paste shortcut without altering text', () => {
    const s = setup()
    const text = 'Olá\nsecond line\t123'
    const event = s.emit('paste', { clipboardData: { types: ['text/plain'], getData: () => text } })
    expect(event.defaultPrevented).toBe(true)
    expect(s.remote.clipboardPasteFrom).toHaveBeenCalledWith(text)
    expect(s.remote.clipboardPasteFrom.mock.invocationCallOrder[0]).toBeLessThan(
      s.remote.sendKey.mock.invocationCallOrder[0]
    )
    expect(s.remote.sendKey.mock.calls).toEqual([
      [0xffe3, 'ControlLeft', true],
      [118, 'KeyV'],
      [0xffe3, 'ControlLeft', false],
    ])
  })
  it('releases the noVNC Mac Command mapping while copying, then restores it', () => {
    const s = setup()
    s.emit('keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true })
    const key = s.emit('keydown', { code: 'KeyC', key: 'c', metaKey: true })
    expect(key.defaultPrevented).toBe(false)
    s.emit('copy')
    expect(s.remote.sendKey.mock.calls).toEqual([
      [0xffe9, 'MetaLeft', false],
      [0xffe3, 'ControlLeft', true],
      [99, 'KeyC'],
      [0xffe3, 'ControlLeft', false],
      [0xffe9, 'MetaLeft', true],
    ])
    s.receive('copied remotely')
    expect(s.write).toHaveBeenCalledWith('copied remotely')
  })
  it('supports terminal Ctrl+Shift+V and menu cut', () => {
    const s = setup(false)
    s.emit('keydown', { code: 'KeyV', key: 'V', ctrlKey: true, shiftKey: true })
    s.emit('paste', { clipboardData: { types: ['text/plain'], getData: () => 'terminal' } })
    expect(s.remote.sendKey.mock.calls).toContainEqual([0xffe1, 'ShiftLeft', true])
    s.emit('keyup', { code: 'KeyV', key: 'V', ctrlKey: true, shiftKey: true })
    s.remote.sendKey.mockClear()
    s.emit('cut')
    expect(s.remote.sendKey.mock.calls).toEqual([
      [0xffe3, 'ControlLeft', true],
      [120, 'KeyX'],
      [0xffe3, 'ControlLeft', false],
    ])
  })
  it('does not exchange clipboard while another control or a hidden window has focus', () => {
    const s = setup()
    s.doc.activeElement = new EventTarget()
    s.receive('not focused')
    s.emit('paste', { clipboardData: { types: ['text/plain'], getData: () => 'private' } })
    expect(s.write).not.toHaveBeenCalled()
    expect(s.remote.clipboardPasteFrom).not.toHaveBeenCalled()
    s.doc.activeElement = s.container
    s.doc.visibilityState = 'hidden'
    s.receive('hidden')
    expect(s.write).not.toHaveBeenCalled()
  })
  it('caches unsolicited CLIPBOARD updates without writing until an explicit copy', () => {
    const s = setup()
    s.receive('unsolicited clipboard text')
    expect(s.write).not.toHaveBeenCalled()
    s.emit('copy')
    s.receive('requested copy')
    expect(s.write.mock.calls).toEqual([['unsolicited clipboard text'], ['requested copy']])
    s.write.mockClear()
    s.receive('later unsolicited clipboard text')
    expect(s.write).not.toHaveBeenCalled()
  })
  it('ignores non-text data and reports write failures', async () => {
    const s = setup()
    s.emit('paste', { clipboardData: { types: ['Files'], getData: () => '' } })
    s.receive(123)
    expect(s.write).not.toHaveBeenCalled()
    expect(s.remote.clipboardPasteFrom).not.toHaveBeenCalled()
    const failure = new Error('denied')
    s.write.mockRejectedValueOnce(failure)
    s.emit('copy')
    s.receive('text')
    await Promise.resolve()
    expect(s.error).toHaveBeenCalledWith('writeFailed')
  })
  it('finishes a requested copy after switching apps, but ignores later unsolicited updates', () => {
    const s = setup()
    s.emit('copy')
    s.doc.hasFocus = () => false
    s.receive('requested text')
    s.receive('unsolicited text')
    expect(s.write.mock.calls).toEqual([['requested text']])
  })
  it('re-copies the cached remote CLIPBOARD when the server suppresses unchanged text', () => {
    const s = setup()
    s.receive('same clipboard text')
    s.write.mockClear()
    s.emit('copy')
    expect(s.write.mock.calls).toEqual([['same clipboard text']])
  })
  it('expires a pending copy instead of replacing the clipboard much later', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100)
    try {
      const s = setup()
      s.emit('copy')
      s.doc.hasFocus = () => false
      now.mockReturnValue(20_101)
      s.receive('expired')
      expect(s.write).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
    }
  })
  it('refuses incompatible characters and oversized text without sending paste keys', () => {
    const s = setup()
    for (const text of ['emoji 😀', '日本語', 'a'.repeat(1024 * 1024 + 1)]) {
      s.emit('paste', { clipboardData: { types: ['text/plain'], getData: () => text } })
    }
    expect(s.error.mock.calls).toEqual([['unsupportedText'], ['unsupportedText'], ['tooLarge']])
    expect(s.remote.sendKey).not.toHaveBeenCalled()
    expect(s.remote.clipboardPasteFrom).not.toHaveBeenCalled()
  })
  it.each(['disconnect', 'dispose'])('stops both directions after %s', (action) => {
    const s = setup()
    s.emit('copy')
    s.remote.sendKey.mockClear()
    if (action === 'disconnect') s.remote.dispatchEvent(new Event('disconnect'))
    else s.detach()
    s.receive('stale')
    s.emit('copy')
    s.emit('paste', { clipboardData: { types: ['text/plain'], getData: () => 'stale' } })
    expect(s.write).not.toHaveBeenCalled()
    expect(s.remote.sendKey).not.toHaveBeenCalled()
    expect(s.remote.clipboardPasteFrom).not.toHaveBeenCalled()
  })
})
