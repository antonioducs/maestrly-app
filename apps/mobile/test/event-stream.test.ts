import type { FleetGatewayEvent } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openEventStream, retryDelay, type StreamingFetch, type StreamState } from '../src/gateway/event-stream'

const at = '2026-10-12T12:00:00.000Z'
const frame = (data: unknown) => `event: fleet\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
const hello = frame({ type: 'hello', at, lastActivitySeq: 3 })

/** One connection the test drives: what the server sends, and when it ends. */
class Connection {
  private chunks: Uint8Array[] = []
  private ended = false
  private wake: (() => void) | null = null
  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener('abort', () => this.wake?.())
  }
  push(text: string) {
    this.chunks.push(new TextEncoder().encode(text))
    this.wake?.()
  }
  end() {
    this.ended = true
    this.wake?.()
  }
  reader() {
    return {
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        for (;;) {
          if (this.signal.aborted) throw new Error('aborted')
          const chunk = this.chunks.shift()
          if (chunk) return { done: false, value: chunk }
          if (this.ended) return { done: true }
          await new Promise<void>((resolve) => {
            this.wake = resolve
          })
        }
      },
      cancel: async () => {},
    }
  }
}

function harness(statuses: number[] = []) {
  const connections: Connection[] = []
  const events: FleetGatewayEvent[] = []
  const states: Array<[StreamState, number | undefined]> = []
  const fetch = vi.fn<StreamingFetch>(async (_url, init) => {
    const status = statuses.shift() ?? 200
    const connection = new Connection(init.signal)
    connections.push(connection)
    return { status, body: status === 200 ? { getReader: () => connection.reader() } : null }
  })
  const stream = openEventStream({
    url: 'https://g.example/v1/events',
    headers: { Authorization: 'Bearer t' },
    fetch,
    createDecoder: () => new TextDecoder(),
    onEvent: (event) => events.push(event),
    onState: (state, detail) => states.push([state, detail?.retryInMs]),
    random: () => 0.5,
  })
  return { connections, events, states, fetch, stream }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('gateway event stream', () => {
  it('computes jittered, capped backoff', () => {
    expect(retryDelay(0, () => 0.5)).toBe(1000)
    expect(retryDelay(1, () => 0.5)).toBe(2000)
    expect(retryDelay(10, () => 0.5)).toBe(30_000)
    expect(retryDelay(0, () => 0)).toBe(750)
  })

  it('delivers validated events, opens on hello and skips frames it cannot read', async () => {
    const h = harness()
    await flush()
    h.connections[0].push(hello)
    h.connections[0].push(frame('{not json'))
    h.connections[0].push(frame({ type: 'from.the.future', at }))
    h.connections[0].push(frame({ type: 'bot.removed', at, botId: 'juno' }))
    await flush()
    expect(h.events.map((event) => event.type)).toEqual(['hello', 'bot.removed'])
    expect(h.states.map(([state]) => state)).toEqual(['connecting', 'open'])
    h.stream.close()
  })

  it('reconnects with growing delays, and starts over after a successful hello', async () => {
    const h = harness()
    await flush()
    h.connections[0].end()
    await flush()
    expect(h.states.at(-1)).toEqual(['retrying', 1000])
    await vi.advanceTimersByTimeAsync(999)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.fetch).toHaveBeenCalledTimes(2)
    h.connections[1].end()
    await flush()
    expect(h.states.at(-1)).toEqual(['retrying', 2000])
    await vi.advanceTimersByTimeAsync(2000)
    h.connections[2].push(hello)
    await flush()
    h.connections[2].end()
    await flush()
    expect(h.states.at(-1)).toEqual(['retrying', 1000])
    h.stream.close()
  })

  it('stops for good when the device is removed or the server is incompatible', async () => {
    const removed = harness([401])
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(removed.states.at(-1)).toEqual(['unauthorized', undefined])
    expect(removed.fetch).toHaveBeenCalledTimes(1)
    const incompatible = harness([426])
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(incompatible.states.at(-1)).toEqual(['incompatible', undefined])
    expect(incompatible.fetch).toHaveBeenCalledTimes(1)
  })

  it('drops a silent connection after 45 seconds and reconnects', async () => {
    const h = harness()
    await flush()
    h.connections[0].push(hello)
    await vi.advanceTimersByTimeAsync(44_999)
    expect(h.states.at(-1)?.[0]).toBe('open')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.states.at(-1)).toEqual(['retrying', 1000])
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.fetch).toHaveBeenCalledTimes(2)
    h.stream.close()
  })

  it('closes for good, and reconnects at once when asked during a wait', async () => {
    const h = harness()
    await flush()
    h.connections[0].end()
    await flush()
    expect(h.states.at(-1)?.[0]).toBe('retrying')
    h.stream.reconnectNow()
    await flush()
    expect(h.fetch).toHaveBeenCalledTimes(2)
    h.stream.close()
    await flush()
    expect(h.states.at(-1)).toEqual(['closed', undefined])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })
})
