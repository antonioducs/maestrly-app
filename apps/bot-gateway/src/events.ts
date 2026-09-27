import type { ServerResponse } from 'node:http'
import type { FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'

export class EventHub {
  readonly subscribers = new Set<ServerResponse>()
  readonly devices = new Map<ServerResponse, string>()
  private heartbeat: NodeJS.Timeout | null = null
  private statsTimer: NodeJS.Timeout | null = null
  private readonly lastBotSent = new Map<string, number>()
  private readonly pendingBots = new Map<string, { event: FleetGatewayEvent; timer: NodeJS.Timeout }>()
  constructor(readonly refresh: () => Promise<void>) {}
  add(response: ServerResponse, lastActivitySeq: number, deviceId?: string) {
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
      this.updateTimers()
    })
    this.updateTimers()
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
    if (response.destroyed || response.writableLength > 256 * 1024) {
      response.destroy()
      this.subscribers.delete(response)
      return
    }
    if (!response.write('event: fleet\ndata: ' + JSON.stringify(event) + '\n\n')) {
      response.destroy()
      this.subscribers.delete(response)
    }
  }
  private updateTimers() {
    if (this.subscribers.size) {
      this.heartbeat ??= setInterval(() => {
        for (const response of this.subscribers) if (!response.write(': ping\n\n')) response.destroy()
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
    this.updateTimers()
  }
}
