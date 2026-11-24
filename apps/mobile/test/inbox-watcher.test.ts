import {
  FLEET_ATTENTION_FEATURE,
  FLEET_ENVIRONMENTS_FEATURE,
  type FleetAttentionEntry,
  type FleetAttentionUpdatedEvent,
  type FleetGatewayEvent,
} from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFleetController } from '../src/fleet/controller'
import { environmentRecord } from '../src/fleet/factories'
import type { EventHandlers, FleetSource } from '../src/fleet/source'
import { GatewayError } from '../src/gateway/client'
import { retryDelay, type StreamingFetch } from '../src/gateway/event-stream'
import { createAttentionWatcher } from '../src/inbox/watcher'
import { memoryStores } from '../src/servers/registry'

const AT = '2026-10-12T12:00:00.000Z'
const frame = (data: unknown) => `event: fleet\ndata: ${JSON.stringify(data)}\n\n`
const helloFrame = frame({ type: 'hello', at: AT, lastActivitySeq: 1 })

const entry = (overrides: Partial<FleetAttentionEntry> & Pick<FleetAttentionEntry, 'key'>): FleetAttentionEntry => ({
  source: 'chat',
  kind: 'finished',
  at: AT,
  title: 'Example',
  environmentId: 'personal',
  conversationId: 'c1',
  ...overrides,
})

class FakeSseConnection {
  private chunks: Uint8Array[] = []
  private ended = false
  private wake: (() => void) | null = null
  constructor(readonly signal: AbortSignal) {
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

function createStandaloneHarness(
  options: {
    features?: string[]
    attentionCall?: () => Promise<{ entries: FleetAttentionEntry[]; at: string }>
    environmentsCall?: () => Promise<{ environments: Array<{ id: string; name: string }> }>
    statuses?: number[]
    random?: () => number
  } = {}
) {
  const connections: FakeSseConnection[] = []
  const urls: string[] = []
  const statuses = [...(options.statuses ?? [])]
  const fetchStream = vi.fn<StreamingFetch>(async (url, init) => {
    urls.push(url)
    const status = statuses.shift() ?? 200
    const connection = new FakeSseConnection(init.signal)
    connections.push(connection)
    return { status, body: status === 200 ? { getReader: () => connection.reader() } : null }
  })
  const attentionFn = vi.fn(
    options.attentionCall ?? (async () => ({ entries: [entry({ key: 'chat:personal/c1' })], at: AT }))
  )
  const envsFn = vi.fn(
    options.environmentsCall ??
      (async () => ({
        environments: [
          { id: 'personal', name: 'Personal' },
          { id: 'company', name: 'Company' },
        ],
      }))
  )
  const call = vi.fn(async (key: string) => {
    if (key === 'attention') return attentionFn()
    if (key === 'environmentsList') return envsFn()
    throw new Error(`Unexpected call: ${key}`)
  })
  const watcher = createAttentionWatcher({
    serverId: 's1',
    features: options.features ?? [FLEET_ATTENTION_FEATURE, FLEET_ENVIRONMENTS_FEATURE],
    call: call as never,
    transport: {
      mode: 'standalone',
      origin: 'https://s1.example.dev',
      headers: () => ({ Authorization: 'Bearer tok' }),
      fetchStream,
    },
    random: options.random ?? (() => 0.5),
  })
  return { watcher, connections, urls, fetchStream, attentionFn, envsFn, call }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('inbox attention watcher', () => {
  it('subscribes with ?attention=2, fetches snapshot + environments on hello, ignores non-attention frames, and applies SSE deltas', async () => {
    const h = createStandaloneHarness()
    h.watcher.start()
    await flush()

    expect(h.urls[0]).toBe('https://s1.example.dev/v1/events?attention=2')
    h.connections[0].push(helloFrame)
    await flush()

    expect(h.attentionFn).toHaveBeenCalledTimes(1)
    expect(h.envsFn).toHaveBeenCalledTimes(1)
    expect(h.watcher.getState().loaded).toBe(true)
    expect(h.watcher.getState().snapshotSeq).toBe(1)
    expect(h.watcher.getState().reachable).toBe(true)
    expect([...h.watcher.getState().entries.keys()]).toEqual(['chat:personal/c1'])
    expect(h.watcher.getState().environments.get('personal')).toBe('Personal')
    expect(h.watcher.getState().environments.get('company')).toBe('Company')

    // Defensively ignore any non-hello fleet frames (e.g. transcript or bot updates from an older gateway).
    const onEmit = vi.fn()
    h.watcher.subscribe(onEmit)
    h.connections[0].push(
      frame({
        type: 'transcript.appended',
        at: AT,
        botId: 'atlas',
        item: {
          id: 't1',
          kind: 'message',
          role: 'assistant',
          at: AT,
          text: 'hello',
        },
      })
    )
    h.connections[0].push(frame({ type: 'bot.deleted', at: AT, botId: 'atlas' }))
    await flush()
    expect(onEmit).not.toHaveBeenCalled()
    expect(h.attentionFn).toHaveBeenCalledTimes(1)

    // Apply an incremental upsert + remove over SSE.
    h.connections[0].push(
      frame({
        type: 'attention.updated',
        upsert: [entry({ key: 'bot:atlas', source: 'bot', kind: 'help', botId: 'atlas', title: 'Atlas' })],
        remove: ['chat:personal/c1'],
      })
    )
    await flush()

    expect(onEmit).toHaveBeenCalledTimes(1)
    expect([...h.watcher.getState().entries.keys()]).toEqual(['bot:atlas'])
    expect(h.watcher.getState().entries.get('bot:atlas')?.kind).toBe('help')
    h.watcher.stop()
  })

  it('buffers attention.updated deltas that arrive while a snapshot fetch is in flight', async () => {
    let resolveSnapshot!: (value: { entries: FleetAttentionEntry[]; at: string }) => void
    const h = createStandaloneHarness({
      attentionCall: () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        }),
    })
    h.watcher.start()
    await flush()
    h.connections[0].push(helloFrame)
    await flush()

    // Delta arrives before the snapshot resolves.
    h.connections[0].push(
      frame({
        type: 'attention.updated',
        upsert: [entry({ key: 'chat:company/k1', environmentId: 'company', conversationId: 'k1', title: 'Newer' })],
        remove: ['chat:personal/c1'],
      })
    )
    await flush()

    // Stale snapshot resolves with c1 still present and without k1.
    resolveSnapshot({ entries: [entry({ key: 'chat:personal/c1' })], at: AT })
    await flush()

    expect([...h.watcher.getState().entries.keys()]).toEqual(['chat:company/k1'])
    h.watcher.stop()
  })

  it('marks reachable=false on snapshot failure, retries with jittered exponential backoff, and recovers', async () => {
    let attempts = 0
    const h = createStandaloneHarness({
      random: () => 0.5,
      attentionCall: async () => {
        attempts++
        if (attempts <= 2) throw new GatewayError('NETWORK', 0, 'offline')
        return { entries: [entry({ key: 'chat:personal/c1' })], at: AT }
      },
    })
    h.watcher.start()
    await flush()
    h.connections[0].push(helloFrame)
    await flush()

    // First failure: reachable flips to false, retry scheduled at retryDelay(0, 0.5) = 1000ms.
    expect(attempts).toBe(1)
    expect(h.watcher.getState().reachable).toBe(false)

    await vi.advanceTimersByTimeAsync(retryDelay(0, () => 0.5) - 1)
    expect(attempts).toBe(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(2)
    expect(h.watcher.getState().reachable).toBe(false)

    // Second failure: retry scheduled at retryDelay(1, 0.5) = 2000ms.
    await vi.advanceTimersByTimeAsync(retryDelay(1, () => 0.5) - 1)
    expect(attempts).toBe(2)

    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(3)
    expect(h.watcher.getState().reachable).toBe(true)
    expect(h.watcher.getState().loaded).toBe(true)
    h.watcher.stop()
  })

  it('marks reachable=false on SSE drop and refetches snapshot after reconnect', async () => {
    let snapshotCount = 0
    const h = createStandaloneHarness({
      random: () => 0.5,
      attentionCall: async () => {
        snapshotCount++
        return {
          entries: [
            entry({
              key: snapshotCount === 1 ? 'chat:personal/c1' : 'chat:personal/c2',
              conversationId: snapshotCount === 1 ? 'c1' : 'c2',
            }),
          ],
          at: AT,
        }
      },
    })
    h.watcher.start()
    await flush()
    h.connections[0].push(helloFrame)
    await flush()

    expect(h.watcher.getState().reachable).toBe(true)
    expect([...h.watcher.getState().entries.keys()]).toEqual(['chat:personal/c1'])

    // Stream drops -> reachable becomes false.
    h.connections[0].end()
    await flush()
    expect(h.watcher.getState().reachable).toBe(false)
    // Last known entries remain visible (stale) while unreachable.
    expect([...h.watcher.getState().entries.keys()]).toEqual(['chat:personal/c1'])

    // Advance past SSE retry delay -> reconnects -> sends hello -> refetches snapshot!
    await vi.advanceTimersByTimeAsync(retryDelay(0, () => 0.5))
    expect(h.connections).toHaveLength(2)
    h.connections[1].push(helloFrame)
    await flush()

    expect(snapshotCount).toBe(2)
    expect(h.watcher.getState().reachable).toBe(true)
    expect([...h.watcher.getState().entries.keys()]).toEqual(['chat:personal/c2'])
    h.watcher.stop()
  })

  it('pauses stream on background and resumes + refetches snapshot on foreground', async () => {
    const h = createStandaloneHarness()
    h.watcher.start()
    await flush()
    h.connections[0].push(helloFrame)
    await flush()
    expect(h.attentionFn).toHaveBeenCalledTimes(1)

    // Background closes the active SSE connection.
    h.watcher.background()
    expect(h.connections[0].signal.aborted).toBe(true)

    // No retries occur while paused in background.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.connections).toHaveLength(1)
    expect(h.attentionFn).toHaveBeenCalledTimes(1)

    // Foreground opens a fresh stream and refetches on hello.
    h.watcher.foreground()
    await flush()
    expect(h.connections).toHaveLength(2)
    h.connections[1].push(helloFrame)
    await flush()
    expect(h.attentionFn).toHaveBeenCalledTimes(2)
    h.watcher.stop()
  })

  it('stops watching permanently on stop() (unpair)', async () => {
    const h = createStandaloneHarness()
    h.watcher.start()
    await flush()
    h.connections[0].push(helloFrame)
    await flush()

    h.watcher.stop()
    expect(h.connections[0].signal.aborted).toBe(true)

    // Foreground after stop is a no-op.
    h.watcher.foreground()
    await flush()
    expect(h.connections).toHaveLength(1)
  })

  it('reuses the active FleetController stream in shared mode without opening a second SSE stream', async () => {
    let streamHandlers: EventHandlers | null = null
    const openEvents = vi.fn((handlers: EventHandlers) => {
      streamHandlers = handlers
      return { close: vi.fn(), reconnectNow: vi.fn() }
    })
    const attentionFn = vi.fn(async () => ({
      entries: [entry({ key: 'bot:ledger', source: 'bot', kind: 'finished', botId: 'ledger', title: 'Ledger' })],
      at: AT,
    }))
    const source: FleetSource = {
      serverId: 'active-1',
      features: [FLEET_ATTENTION_FEATURE, FLEET_ENVIRONMENTS_FEATURE],
      call: vi.fn(async (key: string) => {
        if (key === 'meta')
          return {
            protocol: 1,
            gatewayVersion: '1',
            botImage: 'x',
            botImageVersion: null,
            features: [FLEET_ENVIRONMENTS_FEATURE],
            moreFeatures: [FLEET_ATTENTION_FEATURE],
          }
        if (key === 'botsList') return { bots: [] }
        if (key === 'environmentsList') return { environments: [environmentRecord({ id: 'studio', name: 'Studio' })] }
        if (key === 'inbox') return { items: [] }
        if (key === 'attention') return attentionFn()
        throw new Error(`Unexpected call: ${key}`)
      }) as never,
      openEvents,
      imageSource: () => ({ uri: '', headers: {} }),
      fileSource: () => ({ uri: '', headers: {} }),
      readAttachment: async () => '',
    }

    const fleet = createFleetController(source, memoryStores().kv)
    await fleet.start()
    expect(openEvents).toHaveBeenCalledTimes(1)

    const watcher = createAttentionWatcher({
      serverId: 'active-1',
      features: source.features,
      call: source.call,
      transport: {
        mode: 'shared',
        stream: {
          getConnection: () => fleet.store.getState().connection,
          getEnvironments: () => fleet.store.getState().environments,
          subscribeStore: (listener) => fleet.store.subscribe(listener),
          onAttentionStream: (handlers) => fleet.onAttentionStream(handlers),
        },
      },
    })
    watcher.start()

    // Still only ONE stream opened!
    expect(openEvents).toHaveBeenCalledTimes(1)

    streamHandlers!.onState('open')
    streamHandlers!.onEvent({ type: 'hello', at: AT, lastActivitySeq: 0 } as FleetGatewayEvent)
    await flush()

    expect(attentionFn).toHaveBeenCalledTimes(1)
    expect([...watcher.getState().entries.keys()]).toEqual(['bot:ledger'])
    expect(watcher.getState().environments.get('studio')).toBe('Studio')

    // Attention delta routed over the shared fleet stream reaches the watcher.
    const delta: FleetAttentionUpdatedEvent = {
      type: 'attention.updated',
      upsert: [entry({ key: 'chat:studio/c9', environmentId: 'studio', conversationId: 'c9', title: 'Deploy' })],
      remove: ['bot:ledger'],
    }
    streamHandlers!.onAttention?.(delta)
    expect([...watcher.getState().entries.keys()]).toEqual(['chat:studio/c9'])

    // Connection drop marks watcher unreachable; reconnect hello refetches snapshot and recovers.
    streamHandlers!.onState('retrying')
    expect(watcher.getState().reachable).toBe(false)

    streamHandlers!.onState('open')
    streamHandlers!.onEvent({ type: 'hello', at: AT, lastActivitySeq: 1 } as FleetGatewayEvent)
    await flush()
    expect(attentionFn).toHaveBeenCalledTimes(2)
    expect(watcher.getState().reachable).toBe(true)

    watcher.stop()
    fleet.stop()
  })

  it('tracks lastSyncedAt across snapshots, deltas, and failures', async () => {
    let clock = Date.parse('2026-10-12T12:00:00.000Z')
    let failSnapshot = false
    const connections: FakeSseConnection[] = []
    const fetchStream = vi.fn<StreamingFetch>(async (_url, init) => {
      const connection = new FakeSseConnection(init.signal)
      connections.push(connection)
      return { status: 200, body: { getReader: () => connection.reader() } }
    })
    const watcher = createAttentionWatcher({
      serverId: 's1',
      features: [FLEET_ATTENTION_FEATURE],
      call: (async () => {
        if (failSnapshot) throw new GatewayError('NETWORK', 0, 'offline')
        return { entries: [entry({ key: 'chat:personal/c1' })], at: AT }
      }) as never,
      transport: {
        mode: 'standalone',
        origin: 'https://s1.example.dev',
        headers: () => ({ Authorization: 'Bearer tok' }),
        fetchStream,
      },
      now: () => clock,
      random: () => 0.5,
    })

    expect(watcher.getState().lastSyncedAt).toBeNull()
    watcher.start()
    await flush()
    expect(watcher.getState().lastSyncedAt).toBeNull()

    clock += 5_000
    connections[0].push(helloFrame)
    await flush()
    const snapshotSyncedAt = clock
    expect(watcher.getState().lastSyncedAt).toBe(snapshotSyncedAt)

    clock += 12_000
    connections[0].push(
      frame({
        type: 'attention.updated',
        upsert: [entry({ key: 'chat:personal/c2', conversationId: 'c2' })],
        remove: [],
      })
    )
    await flush()
    const deltaSyncedAt = clock
    expect(watcher.getState().lastSyncedAt).toBe(deltaSyncedAt)

    // Failing snapshot or stream drop preserves the last successful sync timestamp.
    clock += 8_000
    failSnapshot = true
    connections[0].end()
    await flush()
    expect(watcher.getState().reachable).toBe(false)
    expect(watcher.getState().lastSyncedAt).toBe(deltaSyncedAt)

    watcher.stop()
  })

  it('retryNow resets backoff, refetches snapshot, reconnects stream, and no-ops when paused or stopped', async () => {
    let attempts = 0
    let shouldFail = true
    const h = createStandaloneHarness({
      random: () => 0.5,
      attentionCall: async () => {
        attempts++
        if (shouldFail) throw new GatewayError('NETWORK', 0, 'offline')
        return { entries: [entry({ key: 'chat:personal/c1' })], at: AT }
      },
    })

    // No-op before start.
    h.watcher.retryNow()
    await flush()
    expect(attempts).toBe(0)

    h.watcher.start()
    await flush()
    h.connections[0].push(helloFrame)
    await flush()
    expect(attempts).toBe(1)

    // Advance past first retry so fetchAttempt escalates to 2 (2000ms pending).
    await vi.advanceTimersByTimeAsync(retryDelay(0, () => 0.5))
    expect(attempts).toBe(2)

    // Drop the SSE stream as well so stream reconnect backoff is pending.
    h.connections[0].end()
    await flush()
    expect(h.connections).toHaveLength(1)

    // retryNow reconnects the SSE stream immediately, resets fetchAttempt to 0, and refetches snapshot.
    h.watcher.retryNow()
    await flush()
    expect(h.connections).toHaveLength(2)
    expect(attempts).toBe(3)

    // Since fetchAttempt was reset to 0, the next scheduled retry uses retryDelay(0, 0.5) = 1000ms, not 4000ms.
    shouldFail = false
    await vi.advanceTimersByTimeAsync(retryDelay(0, () => 0.5) - 1)
    expect(attempts).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(4)

    // No-op while paused in background.
    h.watcher.background()
    h.watcher.retryNow()
    await flush()
    expect(attempts).toBe(4)
    expect(h.connections).toHaveLength(2)

    // No-op after stop.
    h.watcher.foreground()
    await flush()
    h.watcher.stop()
    h.watcher.retryNow()
    await flush()
    expect(attempts).toBe(4)
  })

  it('retryNow calls shared stream reconnectNow and refetches snapshot in shared mode', async () => {
    const reconnectNow = vi.fn()
    const attentionFn = vi.fn(async () => ({ entries: [entry({ key: 'bot:ledger' })], at: AT }))
    let connection: 'open' | 'retrying' = 'retrying'
    const storeListeners = new Set<() => void>()
    const watcher = createAttentionWatcher({
      serverId: 'active-1',
      features: [FLEET_ATTENTION_FEATURE],
      call: (() => attentionFn()) as never,
      transport: {
        mode: 'shared',
        stream: {
          getConnection: () => connection,
          getEnvironments: () => [],
          subscribeStore: (listener) => {
            storeListeners.add(listener)
            return () => storeListeners.delete(listener)
          },
          onAttentionStream: () => () => {},
          reconnectNow: () => {
            reconnectNow()
            connection = 'open'
            for (const listener of storeListeners) listener()
          },
        },
      },
    })

    watcher.start()
    await flush()
    expect(attentionFn).not.toHaveBeenCalled()
    expect(watcher.getState().reachable).toBe(false)

    watcher.retryNow()
    await flush()
    expect(reconnectNow).toHaveBeenCalledTimes(1)
    expect(attentionFn).toHaveBeenCalledTimes(1)
    expect(watcher.getState().reachable).toBe(true)
    expect(watcher.getState().lastSyncedAt).not.toBeNull()

    watcher.stop()
  })
})
