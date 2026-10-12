import { fleetGatewayEventSchema, type FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'
import { SseParser } from './sse'

export type StreamState = 'connecting' | 'open' | 'retrying' | 'unauthorized' | 'incompatible' | 'closed'
export type StreamReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }
export type StreamingFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ status: number; body: { getReader(): StreamReader } | null }>
export type TextDecoderLike = { decode(input?: Uint8Array, options?: { stream?: boolean }): string }
export type EventStreamOptions = {
  url: string
  headers: Record<string, string>
  fetch: StreamingFetch
  createDecoder: () => TextDecoderLike
  onEvent: (event: FleetGatewayEvent) => void
  onState: (state: StreamState, detail?: { retryInMs: number }) => void
  random?: () => number
  watchdogMs?: number
}

export const retryDelay = (attempt: number, random: () => number): number =>
  Math.round(Math.min(30_000, 1_000 * 2 ** attempt) * (0.75 + random() * 0.5))

const json = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The gateway's `/v1/events` stream, kept open: it reconnects with backoff until the device is removed or closed. */
export function openEventStream(o: EventStreamOptions): { close(): void; reconnectNow(): void } {
  const random = o.random ?? Math.random
  const watchdogMs = o.watchdogMs ?? 45_000
  let attempt = 0
  let closed = false
  let controller: AbortController | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null
  const clearTimers = () => {
    if (retry) clearTimeout(retry)
    if (watchdog) clearTimeout(watchdog)
    retry = watchdog = null
  }
  // The gateway pings every 15 s; a silent stream is a dead one.
  const arm = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => controller?.abort(), watchdogMs)
  }
  const stop = (state: StreamState) => {
    closed = true
    clearTimers()
    controller?.abort()
    o.onState(state)
  }
  async function connect(): Promise<void> {
    retry = null
    if (closed) return
    controller = new AbortController()
    o.onState('connecting')
    arm()
    try {
      const response = await o.fetch(o.url, { headers: o.headers, signal: controller.signal })
      if (response.status === 401) return stop('unauthorized')
      if (response.status === 426) return stop('incompatible')
      if (response.status !== 200 || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      const decoder = o.createDecoder()
      const parser = new SseParser()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.event !== 'fleet') continue
          // Newer gateways may send event types this app does not know yet.
          const parsed = fleetGatewayEventSchema.safeParse(json(frame.data))
          if (!parsed.success) continue
          if (parsed.data.type === 'hello') {
            attempt = 0
            o.onState('open')
          }
          o.onEvent(parsed.data)
        }
      }
    } catch {
      // Network errors, aborts and bad statuses all end in a retry below.
    }
    if (watchdog) clearTimeout(watchdog)
    if (closed) return
    const delay = retryDelay(attempt++, random)
    o.onState('retrying', { retryInMs: delay })
    retry = setTimeout(() => void connect(), delay)
  }
  void connect()
  return {
    close: () => stop('closed'),
    reconnectNow() {
      if (closed || !retry) return
      clearTimeout(retry)
      attempt = 0
      void connect()
    },
  }
}
