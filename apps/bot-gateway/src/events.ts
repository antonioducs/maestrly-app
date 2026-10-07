import type { ServerResponse } from 'node:http'
import { fleetTranscriptItemReadable, type FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'

export class EventHub {
  readonly subscribers = new Set<ServerResponse>()
  readonly devices = new Map<ServerResponse, string>()
  /** Subscribers that asked for `reasoning` transcript items; an older app would drop every one of them. */
  private readonly reasoningReaders = new WeakSet<ServerResponse>()
  /**
   * Streams that asked for desktop calls, by device, newest last: a Mac is online for its bots while one is open, and
   * a call goes to its newest stream only.
   */
  private readonly bridges = new Map<ServerResponse, string>()
  /** A device opened or closed a stream that takes desktop calls. */
  onBridgeChange: (deviceId: string) => void = () => {}
  private heartbeat: NodeJS.Timeout | null = null
  private statsTimer: NodeJS.Timeout | null = null
  private readonly lastBotSent = new Map<string, number>()
  private readonly pendingBots = new Map<string, { event: FleetGatewayEvent; timer: NodeJS.Timeout }>()
  constructor(readonly refresh: () => Promise<void>) {}
  add(
    response: ServerResponse,
    lastActivitySeq: number,
    deviceId?: string,
    options: { reasoning?: boolean; desktopBridge?: boolean } = {}
  ) {
    if (options.reasoning) this.reasoningReaders.add(response)
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    })
    this.subscribers.add(response)
    if (deviceId) this.devices.set(response, deviceId)
    this.send(response, { type: 'hello', at: new Date().toISOString(), lastActivitySeq })
    response.on('close', () => {
      this.subscribers.delete(response)
      this.devices.delete(response)
      const bridge = this.bridges.get(response)
      this.bridges.delete(response)
      this.updateTimers()
      if (bridge) this.onBridgeChange(bridge)
    })
    this.updateTimers()
    if (deviceId && options.desktopBridge && !response.destroyed) {
      this.bridges.set(response, deviceId)
      this.onBridgeChange(deviceId)
    }
  }
  /** Whether a device has a stream open that takes desktop calls. */
  bridgeOnline(deviceId: string): boolean {
    for (const [response, id] of this.bridges) if (id === deviceId && !response.destroyed) return true
    return false
  }
  /**
   * Sends one event to a device's newest stream that takes desktop calls; false when it has none. A call may be far
   * larger than other events, so a slow reader is given room to drain it instead of being dropped at once.
   */
  sendToDevice(deviceId: string, event: FleetGatewayEvent): boolean {
    let target: ServerResponse | null = null
    for (const [response, id] of this.bridges) if (id === deviceId && !response.destroyed) target = response
    if (!target) return false
    this.send(target, event)
    return !target.destroyed
  }
  /** A stream too far behind is dropped; one that takes desktop calls may hold one large call while it drains. */
  private behind(response: ServerResponse): boolean {
    return response.writableLength > (this.bridges.has(response) ? 4 * 1024 * 1024 : 256 * 1024)
  }
  /** Sends every stream that takes desktop calls the event built for its device; null skips that stream. */
  emitToBridges(build: (deviceId: string) => FleetGatewayEvent | null) {
    for (const [response, deviceId] of [...this.bridges]) {
      const event = build(deviceId)
      if (event) this.send(response, event)
    }
  }
  emit(event: FleetGatewayEvent) {
    if (!this.subscribers.size) return
    // Bot and environment updates are coalesced per bot and per environment (their keys cannot collide, although an
    // environment may share its id with a bot); a removal drops the update still waiting.
    const removed =
      event.type === 'bot.removed'
        ? 'bot:' + event.botId
        : event.type === 'environment.removed'
          ? 'environment:' + event.environmentId
          : null
    if (removed) {
      const pending = this.pendingBots.get(removed)
      if (pending) clearTimeout(pending.timer)
      this.pendingBots.delete(removed)
      this.lastBotSent.delete(removed)
    }
    const updated =
      event.type === 'bot.updated'
        ? 'bot:' + event.bot.id
        : event.type === 'environment.updated'
          ? 'environment:' + event.environment.id
          : null
    if (updated) {
      const id = updated
      const delay = 250 - (Date.now() - (this.lastBotSent.get(id) ?? 0))
      if (delay > 0) {
        const pending = this.pendingBots.get(id)
        if (pending) pending.event = event
        else {
          const timer = setTimeout(() => {
            const latest = this.pendingBots.get(id)
            this.pendingBots.delete(id)
            if (latest) this.emit(latest.event)
          }, delay)
          this.pendingBots.set(id, { event, timer })
        }
        return
      }
      this.lastBotSent.set(id, Date.now())
    }
    for (const response of this.subscribers) this.send(response, event)
  }
  private send(response: ServerResponse, event: FleetGatewayEvent) {
    if (
      event.type === 'transcript.upsert' &&
      !fleetTranscriptItemReadable(event.item, this.reasoningReaders.has(response))
    )
      return
    if (response.destroyed || this.behind(response)) {
      response.destroy()
      this.subscribers.delete(response)
      return
    }
    if (!response.write('event: fleet\ndata: ' + JSON.stringify(event) + '\n\n') && !this.bridges.has(response)) {
      response.destroy()
      this.subscribers.delete(response)
    }
  }
  private updateTimers() {
    if (this.subscribers.size) {
      this.heartbeat ??= setInterval(() => {
        for (const response of this.subscribers)
          if (this.behind(response) || (!response.write(': ping\n\n') && !this.bridges.has(response)))
            response.destroy()
      }, 15000)
      this.statsTimer ??= setInterval(() => {
        void this.refresh()
      }, 10000)
    } else {
      if (this.heartbeat) clearInterval(this.heartbeat)
      if (this.statsTimer) clearInterval(this.statsTimer)
      this.heartbeat = null
      this.statsTimer = null
    }
  }
  closeDevice(deviceId: string) {
    for (const [response, id] of this.devices) if (id === deviceId) response.destroy()
  }
  close() {
    for (const pending of this.pendingBots.values()) clearTimeout(pending.timer)
    this.pendingBots.clear()
    for (const response of this.subscribers) response.end()
    this.subscribers.clear()
    this.bridges.clear()
    this.updateTimers()
  }
}
