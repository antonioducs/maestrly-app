import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeHostFrame, encodeBridgeFrame } from '../../src/main/remote-host/bridge-codec'
import { IpcHandlerTable } from '../../src/main/remote-host/ipc-handler-table'
import { RemoteUiHub } from '../../src/main/remote-host/server/remote-ui-hub'
import { isRemoteUiTarget } from '../../src/main/remote-ui-targets'
import { sendToConversation } from '../../src/main/window-ipc'
import {
  type BridgeClientFrame,
  type BridgeHostFrame,
  REMOTE_BRIDGE_CLOSE,
  REMOTE_BRIDGE_LIMITS,
  type RemoteHostInfo,
} from '../../src/shared/remote-bridge'

class FakeSocket extends EventEmitter {
  sent: string[] = []
  bufferedAmount = 0
  closed: [number, string] | null = null
  send(text: string) {
    this.sent.push(text)
  }
  close(code: number, reason: string) {
    if (this.closed) return
    this.closed = [code, reason]
    this.emit('close')
  }
}

const hostInfo: RemoteHostInfo = {
  os: 'linux',
  hostName: 'vps',
  homeDir: '/home/bot',
  roots: ['/home/bot', '/srv/maestrly'],
  desktopEffects: false,
  editor: false,
  browser: false,
}
const hello: BridgeClientFrame = {
  t: 'hello',
  protocol: 1,
  appVersion: '1.2.3',
  client: { deviceName: 'Laptop', os: 'mac', locale: 'pt-BR' },
}

function setup() {
  const table = new IpcHandlerTable()
  const applyLocale = vi.fn()
  const hub = new RemoteUiHub({ table, appVersion: '1.2.3', hostInfo: () => hostInfo, applyLocale, log: vi.fn() })
  const socket = new FakeSocket()
  hub.attach(socket)
  const frame = (value: BridgeClientFrame) => socket.emit('message', encodeBridgeFrame(value))
  const frames = (): BridgeHostFrame[] => socket.sent.map(decodeHostFrame)
  const last = (): BridgeHostFrame => frames().at(-1)!
  /** Lets the hub answer an invoke: it runs the handler after a microtask. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
  return { table, hub, socket, frame, frames, last, settle, applyLocale }
}
function connected() {
  const h = setup()
  h.frame(hello)
  h.frame({ t: 'open', origin: 5, role: 'main' })
  return h
}

afterEach(() => vi.useRealTimers())

describe('remote UI hub', () => {
  it('refuses anything before hello', () => {
    const h = setup()
    h.frame({ t: 'invoke', id: 1, origin: 5, channel: 'x:get', args: [] })
    expect(h.socket.closed?.[0]).toBe(REMOTE_BRIDGE_CLOSE.badFrame)
    expect(h.socket.sent).toEqual([])
  })

  it('refuses a client of another app version or protocol, telling it the host version', () => {
    const version = setup()
    version.frame({ ...hello, appVersion: '1.2.4' } as BridgeClientFrame)
    expect(version.last()).toEqual({ t: 'refused', reason: 'version', hostVersion: '1.2.3' })
    expect(version.socket.closed?.[0]).toBe(REMOTE_BRIDGE_CLOSE.refused)

    const protocol = setup()
    protocol.frame({ ...hello, protocol: 2 } as BridgeClientFrame)
    expect(protocol.last()).toEqual({ t: 'refused', reason: 'protocol', hostVersion: '1.2.3' })
    expect(protocol.socket.closed?.[0]).toBe(REMOTE_BRIDGE_CLOSE.refused)
  })

  it('welcomes a matching client with what the host is and takes its locale', () => {
    const h = setup()
    h.frame(hello)
    expect(h.last()).toEqual({ t: 'welcome', protocol: 1, appVersion: '1.2.3', host: hostInfo })
    expect(h.applyLocale).toHaveBeenCalledWith('pt-BR')
    expect(h.socket.closed).toBeNull()
    expect(h.hub.sessionCount()).toBe(1)
  })

  it('runs a recorded handler for an invoke, with the origin as its sender', async () => {
    const h = connected()
    const seen: { id: number; frame: unknown }[] = []
    h.table.record('x:get', 'invoke', async (event, a: number, b: number) => {
      seen.push({ id: event.sender.id, frame: event.senderFrame })
      event.sender.send('ev', 1)
      return { sum: a + b }
    })
    h.frame({ t: 'invoke', id: 9, origin: 5, channel: 'x:get', args: [2, 3] })
    await h.settle()
    expect(seen).toHaveLength(1)
    expect(seen[0].id).toBeLessThan(0)
    expect(seen[0].frame).toBeNull()
    expect(h.frames()).toContainEqual({ t: 'event', origin: 5, channel: 'ev', args: [1] })
    expect(h.last()).toEqual({ t: 'result', id: 9, ok: true, value: { sum: 5 } })
  })

  it('refuses channels of the calling computer, desktop effects, unknown channels and unknown origins', async () => {
    const h = connected()
    const local = vi.fn()
    h.table.record('drawer:layout', 'send', local)
    h.table.record('open:external', 'invoke', local)
    h.table.record('x:get', 'invoke', () => 1)
    const codeOf = async (frame: BridgeClientFrame) => {
      h.frame(frame)
      await h.settle()
      const result = h.last()
      return result.t === 'result' && !result.ok ? result.error.code : result
    }
    expect(await codeOf({ t: 'invoke', id: 1, origin: 5, channel: 'drawer:layout', args: [] })).toBe(
      'remote-unsupported'
    )
    expect(await codeOf({ t: 'invoke', id: 2, origin: 5, channel: 'open:external', args: [] })).toBe(
      'remote-unsupported'
    )
    expect(await codeOf({ t: 'invoke', id: 3, origin: 5, channel: 'nope:get', args: [] })).toBe('unknown-channel')
    expect(await codeOf({ t: 'invoke', id: 4, origin: 6, channel: 'x:get', args: [] })).toBe('unknown-origin')
    // A `send` has no answer: a refused one is dropped.
    h.frame({ t: 'send', origin: 5, channel: 'drawer:layout', args: [{}] })
    expect(local).not.toHaveBeenCalled()
  })

  it('runs a recorded handler for a send, with binary arguments intact', () => {
    const h = connected()
    const set = vi.fn()
    h.table.record('x:set', 'send', set)
    h.frame({ t: 'send', origin: 5, channel: 'x:set', args: ['a', new Uint8Array([1, 2]), undefined, 4] })
    expect(set).toHaveBeenCalledTimes(1)
    const [event, text, bytes, missing, four] = set.mock.calls[0]
    expect(event.sender.id).toBeLessThan(0)
    expect(text).toBe('a')
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect([...bytes]).toEqual([1, 2])
    expect(missing).toBeUndefined()
    expect(four).toBe(4)
    // An invoke handler is not reachable with a send, nor the other way around.
    h.table.record('x:get', 'invoke', set)
    h.frame({ t: 'send', origin: 5, channel: 'x:get', args: [] })
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('reports a handler failure with its message and code, and survives a failing send handler', async () => {
    const h = connected()
    h.table.record('x:fail', 'invoke', () => {
      throw Object.assign(new Error('boom'), { code: 'outside-roots' })
    })
    h.table.record('x:reject', 'invoke', async () => Promise.reject('plain'))
    h.table.record('x:bad-send', 'send', () => {
      throw new Error('ignored')
    })
    h.frame({ t: 'invoke', id: 1, origin: 5, channel: 'x:fail', args: [] })
    await h.settle()
    expect(h.last()).toEqual({ t: 'result', id: 1, ok: false, error: { message: 'boom', code: 'outside-roots' } })
    h.frame({ t: 'invoke', id: 2, origin: 5, channel: 'x:reject', args: [] })
    await h.settle()
    expect(h.last()).toEqual({ t: 'result', id: 2, ok: false, error: { message: 'plain' } })
    h.frame({ t: 'send', origin: 5, channel: 'x:bad-send', args: [] })
    expect(h.socket.closed).toBeNull()
  })

  it('answers with an error when a result cannot be sent', async () => {
    const h = connected()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    h.table.record('x:cyclic', 'invoke', () => cyclic)
    h.frame({ t: 'invoke', id: 3, origin: 5, channel: 'x:cyclic', args: [] })
    await h.settle()
    expect(h.last()).toMatchObject({ t: 'result', id: 3, ok: false, error: { code: 'unsendable' } })
  })

  it('routes pushes for a panel origin by its conversation and panel', () => {
    const h = setup()
    h.frame(hello)
    h.frame({ t: 'open', origin: 8, role: 'panel', convId: 'c1', panel: 'terminal' })
    sendToConversation('c1', 'drawer:terminal-state', { n: 1 }, { includeMain: false, panel: 'terminal' })
    sendToConversation('c2', 'drawer:terminal-state', { n: 2 }, { includeMain: false, panel: 'terminal' })
    expect(h.frames().filter((frame) => frame.t === 'event')).toEqual([
      { t: 'event', origin: 8, channel: 'drawer:terminal-state', args: [{ n: 1 }] },
    ])
    h.socket.close(1000, 'bye')
  })

  it('destroys the sender of an origin when the client closes it', async () => {
    const h = connected()
    let sender: { isDestroyed(): boolean; once(event: string, cb: () => void): void } | null = null
    const destroyed = vi.fn()
    h.table.record('x:hold', 'invoke', (event) => {
      sender = event.sender
      event.sender.once('destroyed', destroyed)
    })
    h.frame({ t: 'invoke', id: 1, origin: 5, channel: 'x:hold', args: [] })
    await h.settle()
    expect(isRemoteUiTarget(sender)).toBe(true)
    h.frame({ t: 'close', origin: 5 })
    expect(destroyed).toHaveBeenCalledTimes(1)
    expect(sender!.isDestroyed()).toBe(true)
    expect(isRemoteUiTarget(sender)).toBe(false)
    // Opening the same origin again gives a new sender.
    h.frame({ t: 'open', origin: 5, role: 'main' })
    h.frame({ t: 'invoke', id: 2, origin: 5, channel: 'x:hold', args: [] })
    await h.settle()
    expect(sender!.isDestroyed()).toBe(false)
    h.socket.close(1000, 'bye')
  })

  it('destroys every sender of a session when its socket closes, and drops late results', async () => {
    const h = connected()
    h.frame({ t: 'open', origin: 6, role: 'panel', convId: 'c', panel: 'notes' })
    const senders: Array<{ isDestroyed(): boolean }> = []
    let finish!: (value: number) => void
    h.table.record('x:slow', 'invoke', (event) => {
      senders.push(event.sender)
      return new Promise<number>((resolve) => {
        finish = resolve
      })
    })
    h.frame({ t: 'invoke', id: 1, origin: 5, channel: 'x:slow', args: [] })
    h.frame({ t: 'invoke', id: 2, origin: 6, channel: 'x:slow', args: [] })
    await h.settle()
    const before = h.socket.sent.length
    h.socket.close(1006, 'gone')
    expect(senders.map((sender) => sender.isDestroyed())).toEqual([true, true])
    expect(h.hub.sessionCount()).toBe(0)
    finish(1)
    await h.settle()
    expect(h.socket.sent).toHaveLength(before)
  })

  it('drops a client that does not keep up instead of buffering without bound', async () => {
    const h = connected()
    h.table.record('x:push', 'invoke', (event) => event.sender.send('ev', 1))
    h.socket.bufferedAmount = REMOTE_BRIDGE_LIMITS.clientBufferMax + 1
    h.frame({ t: 'invoke', id: 1, origin: 5, channel: 'x:push', args: [] })
    await h.settle()
    expect(h.socket.closed?.[0]).toBe(REMOTE_BRIDGE_CLOSE.slowClient)
  })

  it('answers pings, pings on its own, and drops a silent client', () => {
    vi.useFakeTimers()
    const h = connected()
    h.frame({ t: 'ping', n: 3 })
    expect(h.last()).toEqual({ t: 'pong', n: 3 })
    vi.advanceTimersByTime(REMOTE_BRIDGE_LIMITS.pingMs)
    expect(h.last().t).toBe('ping')
    expect(h.socket.closed).toBeNull()
    vi.advanceTimersByTime(REMOTE_BRIDGE_LIMITS.deadMs)
    expect(h.socket.closed?.[0]).toBe(REMOTE_BRIDGE_CLOSE.dead)
  })

  it('closes a client that sends a malformed frame', () => {
    const h = connected()
    h.socket.emit('message', '{"t":"nope"}')
    expect(h.socket.closed?.[0]).toBe(REMOTE_BRIDGE_CLOSE.badFrame)
  })

  it('closes every session on request', () => {
    const h = connected()
    h.hub.closeAll()
    expect(h.socket.closed).not.toBeNull()
    expect(h.hub.sessionCount()).toBe(0)
  })

  describe('phones', () => {
    const phoneHello: BridgeClientFrame = {
      t: 'hello',
      protocol: 1,
      appVersion: '0.1.0',
      client: { deviceName: 'iPhone', os: 'ios', locale: 'pt-BR', kind: 'mobile', mobileApi: 1 },
    }

    it('welcomes a phone of the same mobile API whatever its app version, keeping the host language', () => {
      const h = setup()
      h.frame(phoneHello)
      expect(h.last()).toEqual({ t: 'welcome', protocol: 1, appVersion: '1.2.3', host: hostInfo, mobileApi: 1 })
      expect(h.applyLocale).not.toHaveBeenCalled()
      expect(h.socket.closed).toBeNull()
    })

    it('refuses a phone of another mobile API, and a hello whose device and kind disagree', () => {
      const newer = setup()
      newer.frame({ ...phoneHello, client: { ...phoneHello.client, mobileApi: 2 } } as BridgeClientFrame)
      expect(newer.last()).toEqual({ t: 'refused', reason: 'mobile-api', hostVersion: '1.2.3' })
      expect(newer.socket.closed?.[0]).toBe(REMOTE_BRIDGE_CLOSE.refused)

      const mixed = setup()
      mixed.frame({ ...hello, client: { ...hello.client, kind: 'mobile', mobileApi: 1 } } as BridgeClientFrame)
      expect(mixed.socket.closed?.[0]).toBe(REMOTE_BRIDGE_CLOSE.badFrame)
      const unlabeled = setup()
      unlabeled.frame({
        ...phoneHello,
        client: { deviceName: 'iPhone', os: 'android', locale: 'en' },
      } as BridgeClientFrame)
      expect(unlabeled.socket.closed?.[0]).toBe(REMOTE_BRIDGE_CLOSE.badFrame)
    })

    it('lets a phone call the mobile API only, never the host IPC handlers', async () => {
      const h = setup()
      const secret = vi.fn(() => 'host secrets')
      h.table.record('chat:key-set', 'invoke', secret)
      h.table.record('conversation:list-standalone', 'invoke', () => [])
      h.table.record('workspace:list', 'invoke', () => [])
      h.frame(phoneHello)
      h.frame({ t: 'open', origin: 1, role: 'main' })
      h.frame({ t: 'invoke', id: 1, origin: 1, channel: 'chat:key-set', args: ['x'] })
      h.frame({ t: 'send', origin: 1, channel: 'chat:key-set', args: ['x'] })
      h.frame({ t: 'invoke', id: 2, origin: 1, channel: 'mobile:v1:lists', args: [{}] })
      h.frame({ t: 'invoke', id: 3, origin: 9, channel: 'mobile:v1:lists', args: [{}] })
      await h.settle()
      await h.settle()
      expect(secret).not.toHaveBeenCalled()
      const results = h.frames().filter((frame) => frame.t === 'result')
      expect(results.sort((a, b) => (a.t === 'result' && b.t === 'result' ? a.id - b.id : 0))).toEqual([
        { t: 'result', id: 1, ok: false, error: { message: 'Unknown channel', code: 'unknown-channel' } },
        { t: 'result', id: 2, ok: true, value: { workspaces: [], chats: [] } },
        { t: 'result', id: 3, ok: false, error: { message: 'Unknown origin', code: 'unknown-origin' } },
      ])
      expect(isRemoteUiTarget).toBeDefined()
    })
  })
})
