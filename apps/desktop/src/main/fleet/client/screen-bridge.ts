import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
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

export class FleetScreenBridge {
  private readonly channels = new Map<string, { socket: Socket; owner: WebContents }>()
  private pending = 0
  private generation = 0
  constructor(
    private readonly getApi: () => FleetApiClient,
    private readonly makeSocket: (url: string) => Socket = (url) => new WebSocket(url)
  ) {}

  /** Opens a bot's browser or apps area, or an environment's screen; a bare bot id is its browser area. */
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
        'environmentId' in screen
          ? await api.call('environmentScreenTicket', { params: { eid: screen.environmentId }, body: { mode } })
          : await api.call('botScreenTicket', { params: { id: screen.botId }, body: { mode, surface: screen.surface } })
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
    this.channels.set(channelId, { socket, owner })
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
      this.channels.delete(channelId)
      const close = event as Event & { code: number; reason: string }
      state({ state: 'closed', code: close.code, reason: close.reason })
    })
    return { channelId }
  }

  send(owner: WebContents, channelId: string, data: ArrayBuffer): void {
    const channel = this.channels.get(channelId)
    if (!channel || channel.owner !== owner) throw new Error('Screen channel unavailable')
    if (channel.socket.readyState !== WebSocket.OPEN) throw new Error('Screen channel is not open')
    channel.socket.send(data)
  }

  close(owner: WebContents, channelId: string): void {
    const channel = this.channels.get(channelId)
    if (!channel || channel.owner !== owner) throw new Error('Screen channel unavailable')
    this.channels.delete(channelId)
    channel.socket.close()
  }

  closeOwner(owner: WebContents): void {
    for (const [id, channel] of this.channels) {
      if (channel.owner === owner) {
        this.channels.delete(id)
        channel.socket.close()
      }
    }
  }

  closeAll(): void {
    this.generation++
    for (const channel of this.channels.values()) channel.socket.close()
    this.channels.clear()
  }
}
