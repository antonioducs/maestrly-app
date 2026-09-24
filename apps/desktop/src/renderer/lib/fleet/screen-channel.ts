import type { FleetScreenData, FleetScreenState } from '../../../preload/api-fleet'

export type ScreenApi = Pick<
  typeof window.api,
  'fleetScreenOpen' | 'fleetScreenSend' | 'fleetScreenClose' | 'onFleetScreenData' | 'onFleetScreenState'
>

export class FleetScreenChannel {
  binaryType: BinaryType = 'arraybuffer'
  onerror: ((event: Event) => void) | null = null
  private messageHandler: ((event: MessageEvent<ArrayBuffer>) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  protocol = ''
  readyState: number = WebSocket.CONNECTING
  readonly channelId: string
  private pendingData: ArrayBuffer[] = []
  private offData: () => void
  private offState: () => void

  private constructor(
    channelId: string,
    private readonly api: ScreenApi,
    offData: () => void,
    offState: () => void
  ) {
    this.channelId = channelId
    this.offData = offData
    this.offState = offState
  }

  get onmessage(): ((event: MessageEvent<ArrayBuffer>) => void) | null {
    return this.messageHandler
  }

  set onmessage(handler: ((event: MessageEvent<ArrayBuffer>) => void) | null) {
    this.messageHandler = handler
    if (handler) {
      for (const data of this.pendingData.splice(0)) handler(new MessageEvent('message', { data }))
    }
  }

  static async open(
    api: ScreenApi,
    botId: string,
    mode: 'view' | 'control',
    onState?: (state: FleetScreenState) => void
  ): Promise<FleetScreenChannel> {
    const earlyStates: FleetScreenState[] = []
    const earlyData: FleetScreenData[] = []
    let channel: FleetScreenChannel | null = null
    const offData = api.onFleetScreenData((data) => {
      if (channel) channel.receive(data)
      else earlyData.push(data)
    })
    const offState = api.onFleetScreenState((state) => {
      if (channel) {
        if (state.channelId === channel.channelId) {
          channel.transition(state)
          onState?.(state)
        }
      } else earlyStates.push(state)
    })
    try {
      const { channelId } = await api.fleetScreenOpen(botId, mode)
      channel = new FleetScreenChannel(channelId, api, offData, offState)
      for (const state of earlyStates) {
        if (state.channelId === channelId) {
          channel.transition(state)
          onState?.(state)
        }
      }
      for (const data of earlyData) channel.receive(data)
      return channel
    } catch (error) {
      offData()
      offState()
      throw error
    }
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error('Screen channel is not open')
    const bytes =
      data instanceof ArrayBuffer
        ? data
        : Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).buffer
    void this.api.fleetScreenSend(this.channelId, bytes).catch(() => this.onerror?.(new Event('error')))
  }

  close(): void {
    if (this.readyState >= WebSocket.CLOSING) return
    this.readyState = WebSocket.CLOSING
    void this.api.fleetScreenClose(this.channelId).catch(() => this.onerror?.(new Event('error')))
  }

  private receive(event: FleetScreenData): void {
    if (event.channelId !== this.channelId || this.readyState === WebSocket.CLOSED) return
    if (this.messageHandler) this.messageHandler(new MessageEvent('message', { data: event.data }))
    else this.pendingData.push(event.data)
  }

  private transition(state: FleetScreenState): void {
    if (state.state === 'open' && this.readyState === WebSocket.CONNECTING) {
      this.readyState = WebSocket.OPEN
      this.onopen?.(new Event('open'))
    } else if (state.state === 'error') {
      this.onerror?.(new Event('error'))
    } else if (state.state === 'closed' && this.readyState !== WebSocket.CLOSED) {
      this.readyState = WebSocket.CLOSED
      this.offData()
      this.offState()
      this.onclose?.(new CloseEvent('close', { code: state.code ?? 1000, reason: state.reason ?? '' }))
    }
  }
}
