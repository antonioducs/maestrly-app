import { randomUUID } from 'node:crypto'
import { clipboard, type WebContents } from 'electron'
import type { FleetScreenTicketResponse } from '@maestrly/bot-fleet-protocol'
import type { FleetScreenTargetInput } from '../../../shared/fleet-targets'
import type { FleetApiClient } from './api'

export type FleetScreenState = {
  channelId: string
  state: 'connecting' | 'open' | 'closed' | 'error'
  code?: number
  reason?: string
}
export type FleetScreenData = { channelId: string; data: ArrayBuffer }

type Socket = Pick<WebSocket, 'binaryType' | 'readyState' | 'send' | 'close' | 'addEventListener'>
type ScreenChannel = { socket: Socket; owner: WebContents; mode: 'view' | 'control' }

const MAX_CLIPBOARD_TEXT = 1_048_576
/** The gateway takes WebSocket messages of at most 256 KiB; the screen stream reassembles pieces of any size. */
const MAX_SOCKET_MESSAGE = 64 * 1024

/** The bridge that opened each channel: every server's client has its own, and a channel id names one of them. */
const owners = new Map<string, FleetScreenBridge>()

export class FleetScreenBridge {
  private readonly channels = new Map<string, ScreenChannel>()

  /** The bridge of the client that opened a channel, whichever server it reaches. */
  static forChannel(channelId: string): FleetScreenBridge | null {
    return owners.get(channelId) ?? null
  }

  private forget(channelId: string): void {
    this.channels.delete(channelId)
    if (owners.get(channelId) === this) owners.delete(channelId)
  }
  private pending = 0
  private generation = 0
  constructor(
    private readonly getApi: () => FleetApiClient,
    private readonly makeSocket: (url: string) => Socket = (url) => new WebSocket(url)
  ) {}

  /**
   * Opens a bot's browser or apps area, an environment's screen, or a workspaces conversation's computer or browser
   * tile; a bare bot id is its browser area.
   */
  async openScreen(
    owner: WebContents,
    target: FleetScreenTargetInput,
    mode: 'view' | 'control'
  ): Promise<{ channelId: string }> {
    if (this.channels.size + this.pending >= 4) throw new Error('Too many screen channels')
    const screen = typeof target === 'string' ? { botId: target, surface: 'browser' as const } : target
    this.pending++
    const generation = this.generation
    let api: FleetApiClient
    let ticket: FleetScreenTicketResponse
    try {
      api = this.getApi()
      ticket =
        'conversationId' in screen
          ? await api.call('conversationScreenTicket', {
              params: { eid: screen.environmentId, cid: screen.conversationId },
              body: { mode, surface: screen.surface },
            })
          : 'environmentId' in screen
            ? await api.call('environmentScreenTicket', { params: { eid: screen.environmentId }, body: { mode } })
            : await api.call('botScreenTicket', {
                params: { id: screen.botId },
                body: { mode, surface: screen.surface },
              })
    } finally {
      this.pending--
    }
    if (generation !== this.generation || owner.isDestroyed()) throw new Error('Screen channel unavailable')
    if (!/^\/v1\/screen\?ticket=[A-Za-z0-9_-]+$/.test(ticket.path)) throw new Error('Invalid screen ticket path')
    const url = new URL(api.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = this.makeSocket(url.origin + ticket.path)
    socket.binaryType = 'arraybuffer'
    const channelId = randomUUID()
    const state = (payload: Omit<FleetScreenState, 'channelId'>): void => {
      if (!owner.isDestroyed()) owner.send('fleet:screen:state', { channelId, ...payload })
    }
    this.channels.set(channelId, { socket, owner, mode })
    owners.set(channelId, this)
    owner.once('destroyed', () => this.closeOwner(owner))
    state({ state: 'connecting' })
    socket.addEventListener('open', () => state({ state: 'open' }))
    socket.addEventListener('message', (event: Event) => {
      if (owner.isDestroyed()) return
      const data = (event as MessageEvent).data
      if (data instanceof ArrayBuffer) owner.send('fleet:screen:data', { channelId, data } satisfies FleetScreenData)
      else if (data instanceof Blob)
        void data.arrayBuffer().then((bytes) => {
          if (!owner.isDestroyed())
            owner.send('fleet:screen:data', { channelId, data: bytes } satisfies FleetScreenData)
        })
    })
    socket.addEventListener('error', () => state({ state: 'error' }))
    socket.addEventListener('close', (event: Event) => {
      this.forget(channelId)
      const close = event as Event & { code: number; reason: string }
      state({ state: 'closed', code: close.code, reason: close.reason })
    })
    return { channelId }
  }

  send(owner: WebContents, channelId: string, data: ArrayBuffer): void {
    const channel = this.channels.get(channelId)
    if (!channel || channel.owner !== owner) throw new Error('Screen channel unavailable')
    if (channel.socket.readyState !== WebSocket.OPEN) throw new Error('Screen channel is not open')
    if (data.byteLength <= MAX_SOCKET_MESSAGE) {
      channel.socket.send(data)
      return
    }
    for (let offset = 0; offset < data.byteLength; offset += MAX_SOCKET_MESSAGE)
      channel.socket.send(data.slice(offset, Math.min(data.byteLength, offset + MAX_SOCKET_MESSAGE)))
  }

  /** Finish an explicit remote copy even if the user has already switched to another local app. */
  async writeClipboard(owner: WebContents, channelId: string, text: unknown): Promise<void> {
    this.controlChannel(owner, channelId, false)
    if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_TEXT) throw new Error('Invalid clipboard text')
    await clipboard.writeText(text)
  }

  /** Read only for an explicit paste in the focused owner's control session. */
  async readClipboard(owner: WebContents, channelId: string): Promise<string> {
    const channel = this.controlChannel(owner, channelId, true)
    const text = await clipboard.readText()
    // The native read is asynchronous: disclose nothing if the channel closed, was replaced, or lost its
    // owner, focus, or control while it was pending.
    if (this.controlChannel(owner, channelId, true) !== channel) throw new Error('Screen channel unavailable')
    if (text.length > MAX_CLIPBOARD_TEXT) throw new Error('Invalid clipboard text')
    return text
  }

  private controlChannel(owner: WebContents, channelId: string, requireFocus: boolean): ScreenChannel {
    const channel = this.channels.get(channelId)
    if (
      !channel ||
      channel.owner !== owner ||
      owner.isDestroyed() ||
      channel.mode !== 'control' ||
      (requireFocus && !owner.isFocused())
    )
      throw new Error('Screen channel unavailable')
    if (channel.socket.readyState !== WebSocket.OPEN) throw new Error('Screen channel is not open')
    return channel
  }

  close(owner: WebContents, channelId: string): void {
    const channel = this.channels.get(channelId)
    if (!channel || channel.owner !== owner) throw new Error('Screen channel unavailable')
    this.forget(channelId)
    channel.socket.close()
  }

  closeOwner(owner: WebContents): void {
    for (const [id, channel] of this.channels) {
      if (channel.owner === owner) {
        this.forget(id)
        channel.socket.close()
      }
    }
  }

  closeAll(): void {
    this.generation++
    for (const [id, channel] of [...this.channels]) {
      this.forget(id)
      channel.socket.close()
    }
  }
}
