import type { FleetScreenData, FleetScreenState, FleetScreenTargetInput } from '../../../preload/api-fleet'

export type ScreenCloseOutcome = 'released' | 'offline' | 'conflict' | 'retry' | 'error'
/**
 * What a closed screen channel means for its view. The gateway accepts the WebSocket before it checks the ticket, so
 * a refused ticket arrives as a close with code 4003: `limit` on a control request means another session holds the
 * display (watch instead of retrying); any other 4003 may be retried with a fresh ticket. A close without a code
 * (the transport lost the connection) is an error.
 */
export function screenCloseOutcome(
  close: Pick<FleetScreenState, 'code' | 'reason'>,
  mode: 'view' | 'control'
): ScreenCloseOutcome {
  if (close.code === 4001) return 'released'
  if (close.code === 4002) return 'offline'
  if (close.code !== 4003) return 'error'
  return mode === 'control' && close.reason === 'limit' ? 'conflict' : 'retry'
}

/**
 * Retries of a refused screen ticket: one per screen (target, area and mode). Another screen starts with a fresh
 * allowance, and so does a screen once it really connected.
 */
export class ScreenRetries {
  private key = ''
  private used = 0
  constructor(private readonly max = 1) {}
  /** Whether the screen named `key` may retry once more; it counts the retry. */
  take(key: string): boolean {
    if (key !== this.key) {
      this.key = key
      this.used = 0
    }
    if (this.used >= this.max) return false
    this.used++
    return true
  }
  reset(): void {
    this.used = 0
  }
}

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

  /** Opens a bot's browser or apps area, or an environment's screen; a bare bot id is its browser area. */
  static async open(
    api: ScreenApi,
    target: FleetScreenTargetInput,
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
      const { channelId } = await api.fleetScreenOpen(target, mode)
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
