import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ChatWindowManager } from '../../src/main/chat-window-manager'

function contents() {
  let handler = (_details: {
    url: string
    frameName: string
  }): { action: string; overrideBrowserWindowOptions?: Record<string, unknown> } => ({ action: 'deny' })
  return Object.assign(new EventEmitter(), {
    mainFrame: {},
    open: (frameName: string, url = 'about:blank') => handler({ frameName, url }),
    setWindowOpenHandler(value: typeof handler) {
      handler = value
    },
    isDestroyed: () => false,
    send: vi.fn(),
    getBackgroundThrottling: () => true,
    setBackgroundThrottling: vi.fn(),
  })
}
function setup() {
  const owner = contents()
  let now = 0
  const focusSource = vi.fn()
  const manager = new ChatWindowManager(owner as never, {
    targetExists: ({ id }) => id !== 'missing',
    workArea: () => ({ x: 0, y: 0, width: 1000, height: 900 }),
    now: () => now,
    focusSource,
  })
  const event = { sender: owner, senderFrame: owner.mainFrame } as never
  const request = { kind: 'conversation', id: 'test-chat', title: 'Test chat' } as const
  const prepare = () => manager.prepare(event, request)
  const create = (frameName: string) => {
    let destroyed = false
    const window = Object.assign(new EventEmitter(), {
      webContents: contents(),
      isDestroyed: () => destroyed,
      isMinimized: (): boolean => true,
      isMaximized: () => false,
      isFullScreen: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      getBounds: () => ({ x: 950, y: 850, width: 780, height: 820 }),
      destroy: vi.fn(() => {
        destroyed = true
        window.emit('closed')
      }),
    })
    owner.emit('did-create-window', window, { frameName })
    return window
  }
  return {
    owner,
    manager,
    event,
    request,
    prepare,
    create,
    focusSource,
    advance: () => {
      now += 15_001
    },
  }
}

describe('ChatWindowManager', () => {
  it('requires the owner main frame and validates targets and bounded input', () => {
    const s = setup()
    expect(() => s.manager.prepare({ sender: contents() } as never, s.request)).toThrow('sender')
    expect(() => s.manager.prepare({ sender: s.owner, senderFrame: {} } as never, s.request)).toThrow('sender')
    for (const request of [
      null,
      { ...s.request, id: 'missing' },
      { ...s.request, id: 'x'.repeat(257) },
      { ...s.request, title: '\n' },
      { ...s.request, kind: 'url' },
    ]) {
      expect(() => s.manager.prepare(s.event, request)).toThrow('target')
    }
  })
  it('allows exact about:blank once, expires tickets, and bounds pending requests', () => {
    const s = setup()
    const { frameName } = s.prepare()
    expect(s.owner.open(frameName, 'https://example.test').action).toBe('deny')
    expect(s.owner.open(frameName, 'about:blank#fragment').action).toBe('deny')
    expect(s.owner.open('unknown').action).toBe('deny')
    expect(s.owner.open(frameName).action).toBe('allow')
    expect(s.owner.open(frameName).action).toBe('deny')
    s.advance()
    expect(s.owner.open(frameName).action).toBe('deny')
    for (let index = 0; index < 64; index++) s.manager.prepare(s.event, { ...s.request, id: `chat-${index}` })
    expect(() => s.prepare()).toThrow('Too many')
  })
  it('deduplicates targets, restores focus, and denies child navigation and opens', () => {
    const s = setup()
    const prepared = s.prepare()
    expect(s.prepare()).toEqual(prepared)
    s.owner.open(prepared.frameName)
    const child = s.create(prepared.frameName)
    expect(s.prepare()).toEqual(prepared)
    expect(child.restore).toHaveBeenCalled()
    expect(child.focus).toHaveBeenCalled()
    expect(child.webContents.open('').action).toBe('deny')
    const preventDefault = vi.fn()
    child.webContents.emit('will-navigate', { preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(s.owner.setBackgroundThrottling).toHaveBeenCalledWith(false)
  })
  it('waits for acknowledgement on close and restores throttling and clamped bounds', () => {
    const s = setup()
    const { key, frameName } = s.prepare()
    s.owner.open(frameName)
    const child = s.create(frameName)
    child.isMinimized = () => false
    const preventDefault = vi.fn()
    child.emit('close', { preventDefault })
    child.emit('close', { preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(2)
    expect(child.destroy).not.toHaveBeenCalled()
    expect(s.owner.send).toHaveBeenCalledExactlyOnceWith('chat-window:close-requested', key)
    expect(() => s.manager.close({ sender: contents() } as never, key)).toThrow('sender')
    s.manager.close(s.event, key)
    expect(child.destroy).toHaveBeenCalledOnce()
    expect(s.focusSource).toHaveBeenCalledOnce()
    expect(s.owner.send).toHaveBeenCalledWith('chat-window:closed', key)
    expect(s.owner.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
    expect(s.owner.open(s.prepare().frameName).overrideBrowserWindowOptions).toMatchObject({
      x: 220,
      y: 80,
      width: 780,
      height: 820,
    })
  })
  it('reveals the source only for an owned, open chat window', () => {
    const s = setup()
    const { key, frameName } = s.prepare()
    s.manager.showSource(s.event, key)
    expect(s.focusSource).not.toHaveBeenCalled()
    s.owner.open(frameName)
    s.create(frameName)
    expect(() => s.manager.showSource({ sender: contents() } as never, key)).toThrow('sender')
    s.manager.showSource(s.event, key)
    expect(s.focusSource).toHaveBeenCalledOnce()
  })
  it.each(['dispose', 'reload', 'crash'])('cleans windows and tokens without handshake on %s', (cause) => {
    const s = setup()
    const { frameName } = s.prepare()
    s.owner.open(frameName)
    const child = s.create(frameName)
    const pending = s.manager.prepare(s.event, { ...s.request, id: 'pending' })
    if (cause === 'dispose') s.manager.dispose()
    if (cause === 'reload') s.owner.emit('did-start-navigation', {}, 'file:///app', false, true)
    if (cause === 'crash') s.owner.emit('render-process-gone')
    expect(child.destroy).toHaveBeenCalledOnce()
    expect(s.owner.open(pending.frameName).action).toBe('deny')
    expect(s.owner.send).not.toHaveBeenCalledWith('chat-window:close-requested', expect.anything())
  })
})
