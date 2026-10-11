import {
  FLEET_DESKTOP_BRIDGE_QUERY,
  FLEET_GATEWAY_ROUTES,
  FLEET_REASONING_QUERY,
  buildPath,
  fleetGatewayEventSchema,
  type FleetGatewayEvent,
} from '@maestrly/bot-fleet-protocol'
import { type FleetApiClient, FleetClientError } from './api'

export type FleetConnectionState =
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unauthorized'
  | 'incompatible'

export class FleetEvents {
  private controller: AbortController | null = null
  private running = false
  constructor(
    private readonly api: FleetApiClient,
    private readonly onEvent: (event: FleetGatewayEvent) => void,
    private readonly onState: (state: FleetConnectionState, error: string | null) => void,
    private readonly onConnected: () => Promise<void>,
    private readonly pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly heartbeatMs = 45_000,
    /** `desktopBridge`: this Mac answers bots' desktop calls on this stream, and is online for them while it is open. */
    private readonly options: { desktopBridge?: boolean } = {}
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.controller?.abort()
    this.controller = null
  }

  private async loop(): Promise<void> {
    let attempt = 0
    while (this.running) {
      this.onState(attempt ? 'reconnecting' : 'connecting', null)
      try {
        // A stream that opened starts the backoff over: a gateway that drops now and then is reached again at once.
        await this.consume(() => {
          attempt = 0
        })
        if (!this.running) break
        throw new FleetClientError('INSTANCE_UNAVAILABLE', 0, 'Event stream ended')
      } catch (error) {
        if (!this.running) break
        if (error instanceof FleetClientError && error.status === 401) {
          this.onState('unauthorized', error.message)
          break
        }
        if (error instanceof FleetClientError && error.status === 426) {
          this.onState('incompatible', error.message)
          break
        }
        this.onState('reconnecting', error instanceof Error ? error.message : 'Gateway unavailable')
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5))
        await this.pause(delay * (0.75 + Math.random() * 0.5))
      }
    }
    this.running = false
  }

  private async consume(onOpen: () => void): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    let heartbeat: ReturnType<typeof setTimeout> | undefined
    const resetHeartbeat = (): void => {
      clearTimeout(heartbeat)
      heartbeat = setTimeout(() => controller.abort(), this.heartbeatMs)
    }
    try {
      // This app reads `reasoning` items; an older gateway ignores the parameter and sends none. The same holds for
      // desktop calls.
      const path = buildPath(
        FLEET_GATEWAY_ROUTES.events.path,
        {},
        { [FLEET_REASONING_QUERY]: 1, ...(this.options.desktopBridge ? { [FLEET_DESKTOP_BRIDGE_QUERY]: 1 } : {}) }
      )
      const response = await fetch(this.api.origin + path, {
        headers: { ...this.api.headers(), Accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (!response.ok)
        throw new FleetClientError(
          response.status === 401
            ? 'UNAUTHORIZED'
            : response.status === 426
              ? 'PROTOCOL_INCOMPATIBLE'
              : 'INSTANCE_UNAVAILABLE',
          response.status,
          'Event connection refused'
        )
      if (!response.body) throw new Error('Missing event stream')
      await this.onConnected()
      if (!this.running) return
      onOpen()
      this.onState('connected', null)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      resetHeartbeat()
      while (this.running) {
        const { done, value } = await reader.read()
        if (done) break
        resetHeartbeat()
        buffer += decoder.decode(value, { stream: true })
        let boundary: number
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const separator = buffer.startsWith('\r\n\r\n', boundary) ? 4 : 2
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + separator)
          let eventName = ''
          const data: string[] = []
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('event:')) eventName = line.slice(6).trimStart()
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
          }
          if (eventName === 'fleet' && data.length) {
            try {
              this.onEvent(fleetGatewayEventSchema.parse(JSON.parse(data.join('\n'))))
            } catch {
              // Ignore one malformed frame without losing the subscription.
            }
          }
        }
        if (buffer.length > 1_048_576) throw new Error('Event frame too large')
      }
    } finally {
      clearTimeout(heartbeat)
      controller.abort()
      if (this.controller === controller) this.controller = null
    }
  }
}
