import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { clipboard, type WebContents } from 'electron'
import type { FleetApiClient } from '../../src/main/fleet/client/api'
import { FleetScreenBridge } from '../../src/main/fleet/client/screen-bridge'

class FakeSocket extends EventTarget {
  binaryType = 'blob'
  readyState = 0
  sent: ArrayBuffer[] = []
  close = vi.fn(() => {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  })
  send(data: ArrayBuffer): void {
    this.sent.push(data)
  }
  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  data(bytes: ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data: bytes }))
  }
  remoteClose(code: number, reason: string): void {
    const event = Object.assign(new Event('close'), { code, reason })
    this.dispatchEvent(event)
  }
}
class Owner extends EventEmitter {
  messages: { channel: string; payload: unknown }[] = []
  focused = true
  isFocused(): boolean {
    return this.focused
  }
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  send(channel: string, payload: unknown): void {
    this.messages.push({ channel, payload })
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

describe('fleet screen bridge', () => {
  it('reads clipboard only for a focused sender owning an open control session', async () => {
    const socket = new FakeSocket()
    const api = {
      origin: 'https://fleet.example',
      call: async () => ({ path: '/v1/screen?ticket=test' }),
    } as unknown as FleetApiClient
    const bridge = new FleetScreenBridge(
      () => api,
      () => socket as unknown as WebSocket
    )
    const fake = new Owner()
    const owner = fake as unknown as WebContents
    const read = vi.spyOn(clipboard, 'readText').mockResolvedValue('host text')
    try {
      const { channelId } = await bridge.openScreen(owner, 'bot', 'control')
      await expect(bridge.readClipboard(owner, channelId)).rejects.toThrow('Screen channel is not open')
      socket.open()
      await expect(bridge.readClipboard(new Owner() as unknown as WebContents, channelId)).rejects.toThrow(
        'Screen channel unavailable'
      )
      fake.focused = false
      await expect(bridge.readClipboard(owner, channelId)).rejects.toThrow('Screen channel unavailable')
      fake.focused = true
      fake.destroyed = true
      await expect(bridge.readClipboard(owner, channelId)).rejects.toThrow('Screen channel unavailable')
      fake.destroyed = false
      expect(read).not.toHaveBeenCalled()
      await expect(bridge.readClipboard(owner, channelId)).resolves.toBe('host text')
      read.mockResolvedValueOnce('a'.repeat(1_048_577))
      await expect(bridge.readClipboard(owner, channelId)).rejects.toThrow('Invalid clipboard text')
      read.mockRejectedValueOnce(new Error('Clipboard unavailable'))
      await expect(bridge.readClipboard(owner, channelId)).rejects.toThrow('Clipboard unavailable')
      bridge.close(owner, channelId)
      await expect(bridge.readClipboard(owner, channelId)).rejects.toThrow('Screen channel unavailable')
      const view = await bridge.openScreen(owner, 'bot', 'view')
      socket.open()
      await expect(bridge.readClipboard(owner, view.channelId)).rejects.toThrow('Screen channel unavailable')
      expect(read).toHaveBeenCalledTimes(3)
    } finally {
      read.mockRestore()
    }
  })

  it('discloses nothing when the session changes while the native read is pending', async () => {
    const sockets: FakeSocket[] = []
    const api = {
      origin: 'https://fleet.example',
      call: async () => ({ path: '/v1/screen?ticket=pending-read' }),
    } as unknown as FleetApiClient
    const bridge = new FleetScreenBridge(
      () => api,
      () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket as unknown as WebSocket
      }
    )
    const fake = new Owner()
    const owner = fake as unknown as WebContents
    const channels = (bridge as unknown as { channels: Map<string, object> }).channels
    const read = vi.spyOn(clipboard, 'readText')
    const changes: Array<[string, (channelId: string) => void]> = [
      ['closed', (channelId) => bridge.close(owner, channelId)],
      ['closed remotely', () => sockets.at(-1)!.remoteClose(4001, 'released')],
      ['disconnected', () => bridge.closeAll()],
      ['replaced', (channelId) => channels.set(channelId, { ...channels.get(channelId) })],
      ['unfocused', () => (fake.focused = false)],
      ['destroyed', () => (fake.destroyed = true)],
    ]
    try {
      for (const [label, change] of changes) {
        const { channelId } = await bridge.openScreen(owner, 'bot', 'control')
        sockets.at(-1)!.open()
        let finish!: (text: string) => void
        read.mockReturnValueOnce(new Promise<string>((resolve) => (finish = resolve)))
        const pending = bridge.readClipboard(owner, channelId)
        change(channelId)
        finish('private host text')
        await expect(pending, label).rejects.toThrow('Screen channel unavailable')
        fake.focused = true
        fake.destroyed = false
        bridge.closeOwner(owner)
      }
      expect(read).toHaveBeenCalledTimes(changes.length)
    } finally {
      read.mockRestore()
    }
  })

  it('writes only bounded text from an open control channel owned by the sender', async () => {
    const socket = new FakeSocket()
    const api = {
      origin: 'https://fleet.example',
      call: async () => ({ path: '/v1/screen?ticket=clipboard' }),
    } as unknown as FleetApiClient
    const bridge = new FleetScreenBridge(
      () => api,
      () => socket as unknown as WebSocket
    )
    const fake = new Owner()
    const owner = fake as unknown as WebContents
    const other = new Owner() as unknown as WebContents
    const write = vi.spyOn(clipboard, 'writeText')
    try {
      const { channelId } = await bridge.openScreen(owner, 'bot', 'control')
      await expect(bridge.writeClipboard(owner, channelId, 'before open')).rejects.toThrow('Screen channel is not open')
      socket.open()
      await expect(bridge.writeClipboard(other, channelId, 'wrong owner')).rejects.toThrow('Screen channel unavailable')
      await expect(bridge.writeClipboard(owner, channelId, 123)).rejects.toThrow('Invalid clipboard text')
      await expect(bridge.writeClipboard(owner, channelId, 'a'.repeat(1_048_577))).rejects.toThrow(
        'Invalid clipboard text'
      )
      expect(write).not.toHaveBeenCalled()
      // A remote copy completes after focus moves elsewhere, and only once the native write settles.
      fake.focused = false
      let settle!: () => void
      write.mockReturnValueOnce(new Promise<void>((resolve) => (settle = resolve)))
      let written = false
      const pending = bridge.writeClipboard(owner, channelId, 'copied text').then(() => {
        written = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(write).toHaveBeenCalledWith('copied text')
      expect(written).toBe(false)
      settle()
      await pending
      expect(written).toBe(true)
      write.mockRejectedValueOnce(new Error('Clipboard unavailable'))
      await expect(bridge.writeClipboard(owner, channelId, 'failed copy')).rejects.toThrow('Clipboard unavailable')
      bridge.close(owner, channelId)
      await expect(bridge.writeClipboard(owner, channelId, 'stale')).rejects.toThrow('Screen channel unavailable')
      const view = await bridge.openScreen(owner, 'bot', 'view')
      socket.open()
      await expect(bridge.writeClipboard(owner, view.channelId, 'view only')).rejects.toThrow(
        'Screen channel unavailable'
      )
      expect(write).toHaveBeenCalledTimes(2)
    } finally {
      write.mockRestore()
    }
  })
  it('relays binary data both ways, reports close codes, enforces ownership and cap', async () => {
    const sockets: FakeSocket[] = []
    const urls: string[] = []
    let ticketNumber = 0
    const usedTickets = new Set<string>()
    const api = {
      origin: 'https://fleet.example',
      call: vi.fn(async () => {
        const ticket = ticketNumber++ === 0 ? 'secret-ticket' : `secret-ticket-${ticketNumber}`
        return { ticket, path: `/v1/screen?ticket=${ticket}`, expiresAt: '2026-01-01T00:00:00Z' }
      }),
    } as unknown as FleetApiClient
    const bridge = new FleetScreenBridge(
      () => api,
      (url) => {
        urls.push(url)
        const ticket = new URL(url).searchParams.get('ticket') ?? ''
        if (usedTickets.has(ticket)) throw new Error('Ticket already used')
        usedTickets.add(ticket)
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket as unknown as WebSocket
      }
    )
    const owner = new Owner()
    const other = new Owner()
    const { channelId } = await bridge.openScreen(owner as unknown as WebContents, 'bot', 'view')
    expect(urls[0]).toBe('wss://fleet.example/v1/screen?ticket=secret-ticket')
    expect(sockets[0].binaryType).toBe('arraybuffer')
    expect(JSON.stringify(owner.messages)).not.toContain('secret-ticket')
    sockets[0].open()
    const bytes = new Uint8Array([1, 2]).buffer
    sockets[0].data(bytes)
    expect(owner.messages.at(-1)).toEqual({ channel: 'fleet:screen:data', payload: { channelId, data: bytes } })
    bridge.send(owner as unknown as WebContents, channelId, bytes)
    expect(sockets[0].sent).toEqual([bytes])
    expect(() => bridge.send(other as unknown as WebContents, channelId, bytes)).toThrow()
    for (let n = 0; n < 3; n++) await bridge.openScreen(owner as unknown as WebContents, 'bot', 'view')
    await expect(bridge.openScreen(owner as unknown as WebContents, 'bot', 'view')).rejects.toThrow('Too many')
    sockets[0].remoteClose(4001, 'released')
    expect(owner.messages.at(-1)).toEqual({
      channel: 'fleet:screen:state',
      payload: { channelId, state: 'closed', code: 4001, reason: 'released' },
    })
    for (const [index, code, reason] of [
      [1, 4002, 'bot_offline'],
      [2, 4003, 'ticket_invalid'],
    ] as const) {
      sockets[index].remoteClose(code, reason)
      expect(owner.messages.at(-1)).toMatchObject({ channel: 'fleet:screen:state', payload: { code, reason } })
    }
    owner.destroy()
    expect(sockets[3].close.mock.calls.length).toBeGreaterThan(0)
  })

  it('reserves pending slots and discards a ticket after disconnect', async () => {
    const resolveTickets: Array<(ticket: { ticket: string; path: string; expiresAt: string }) => void> = []
    const api = {
      origin: 'http://127.0.0.1:7443',
      call: () =>
        new Promise((resolve) => {
          resolveTickets.push(resolve)
        }),
    } as unknown as FleetApiClient
    const bridge = new FleetScreenBridge(
      () => api,
      () => {
        throw new Error('Socket must not open after disconnect')
      }
    )
    const owner = new Owner()
    const pending = bridge.openScreen(owner as unknown as WebContents, 'bot', 'view')
    for (let n = 0; n < 3; n++)
      void bridge.openScreen(owner as unknown as WebContents, 'bot', 'view').catch(() => undefined)
    await expect(bridge.openScreen(owner as unknown as WebContents, 'bot', 'view')).rejects.toThrow('Too many')
    bridge.closeAll()
    for (const resolve of resolveTickets)
      resolve({ ticket: 'single-use', path: '/v1/screen?ticket=single-use', expiresAt: '2026-01-01T00:00:00Z' })
    await expect(pending).rejects.toThrow('Screen channel unavailable')
  })
})
