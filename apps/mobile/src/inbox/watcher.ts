import {
  buildPath,
  FLEET_ATTENTION_QUERY,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_GATEWAY_ROUTES,
  type FleetAttentionEntry,
  type FleetAttentionSnapshot,
  type FleetAttentionUpdatedEvent,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError, type GatewayClient } from '../gateway/client'
import {
  openEventStream,
  retryDelay,
  type EventStreamOptions,
  type StreamState,
  type StreamingFetch,
  type TextDecoderLike,
} from '../gateway/event-stream'

export interface WatchedServerState {
  readonly serverId: string
  /** Active attention entries keyed by raw server entry key. */
  readonly entries: ReadonlyMap<string, FleetAttentionEntry>
  /** Known environments for this server (environmentId -> name). */
  readonly environments: ReadonlyMap<string, string>
  /** False after a failed fetch or stream drop until recovery. */
  readonly reachable: boolean
  /** True once at least one snapshot fetch has succeeded. */
  readonly loaded: boolean
}

export interface AttentionWatcher {
  getState(): WatchedServerState
  subscribe(listener: (state: WatchedServerState) => void): () => void
  start(): void
  /** Pauses background network activity (AppState -> background). */
  background(): void
  /** Resumes stream and refetches snapshot (AppState -> active). */
  foreground(): void
  /** Permanently stops watching (e.g. unpair or unmount). */
  stop(): void
}

/** Shared stream handle exposed by the active server's `FleetController` so we never open a second SSE stream. */
export interface SharedAttentionStream {
  getConnection(): StreamState
  getEnvironments(): ReadonlyArray<{ id: string; name: string }>
  subscribeStore(listener: () => void): () => void
  onAttentionStream(handlers: { onEvent(event: FleetAttentionUpdatedEvent): void; onHello(): void }): () => void
}

export interface StandaloneAttentionTransport {
  readonly mode: 'standalone'
  origin: string
  headers(): Record<string, string>
  fetchStream: StreamingFetch
  createDecoder?: () => TextDecoderLike
  /** Optional override for tests. */
  openStream?: typeof openEventStream
  watchdogMs?: number
}

export interface SharedAttentionTransport {
  readonly mode: 'shared'
  stream: SharedAttentionStream
}

export interface AttentionWatcherOptions {
  serverId: string
  features: readonly string[]
  call: Pick<GatewayClient, 'call'>['call']
  transport: StandaloneAttentionTransport | SharedAttentionTransport
  random?: () => number
}

function applyDelta(
  current: ReadonlyMap<string, FleetAttentionEntry>,
  delta: FleetAttentionUpdatedEvent
): Map<string, FleetAttentionEntry> {
  const next = new Map(current)
  for (const key of delta.remove) next.delete(key)
  for (const entry of delta.upsert) next.set(entry.key, entry)
  return next
}

function isTerminalError(error: unknown): boolean {
  return error instanceof GatewayError && (error.code === 'UNAUTHORIZED' || error.code === 'PROTOCOL_INCOMPATIBLE')
}

function isUnhealthyStreamState(state: StreamState): boolean {
  return state === 'retrying' || state === 'unauthorized' || state === 'incompatible'
}

/**
 * Watches one paired server's attention store: fetches `GET /v1/attention` on connect and after every reconnect,
 * applies incremental `attention.updated` SSE frames (buffering frames received while a snapshot is in flight),
 * backs off with jitter on failure, pauses in background, and reuses the active server's stream when `mode === 'shared'`.
 */
export function createAttentionWatcher(options: AttentionWatcherOptions): AttentionWatcher {
  const random = options.random ?? Math.random
  const listeners = new Set<(state: WatchedServerState) => void>()

  let entries = new Map<string, FleetAttentionEntry>()
  let environments = new Map<string, string>()
  let reachable = true
  let loaded = false
  let started = false
  let stopped = false
  let paused = false

  let streamHandle: { close(): void; reconnectNow(): void } | null = null
  let unsubscribeSharedAttention: (() => void) | null = null
  let unsubscribeSharedStore: (() => void) | null = null
  let streamState: StreamState = 'closed'

  let fetchGen = 0
  let inFlightGen: number | null = null
  let bufferedDeltas: FleetAttentionUpdatedEvent[] = []
  let fetchAttempt = 0
  let fetchRetryTimer: ReturnType<typeof setTimeout> | null = null

  const snapshotState = (): WatchedServerState => ({
    serverId: options.serverId,
    entries,
    environments,
    reachable,
    loaded,
  })

  let currentState = snapshotState()
  const emit = () => {
    currentState = snapshotState()
    for (const listener of listeners) listener(currentState)
  }

  const clearFetchRetry = () => {
    if (fetchRetryTimer) clearTimeout(fetchRetryTimer)
    fetchRetryTimer = null
  }

  const syncSharedEnvironments = () => {
    if (options.transport.mode !== 'shared') return false
    const list = options.transport.stream.getEnvironments()
    if (list.length === environments.size && list.every((env) => environments.get(env.id) === env.name)) return false
    environments = new Map(list.map((env) => [env.id, env.name]))
    return true
  }

  const scheduleFetchRetry = () => {
    clearFetchRetry()
    if (stopped || paused) return
    const delay = retryDelay(fetchAttempt++, random)
    fetchRetryTimer = setTimeout(() => {
      fetchRetryTimer = null
      if (!stopped && !paused) void fetchSnapshot()
    }, delay)
  }

  const handleAttentionDelta = (delta: FleetAttentionUpdatedEvent) => {
    if (stopped || paused) return
    if (inFlightGen !== null) {
      bufferedDeltas.push(delta)
      return
    }
    entries = applyDelta(entries, delta)
    emit()
  }

  async function fetchSnapshot(): Promise<void> {
    if (stopped || paused) return
    clearFetchRetry()
    const gen = ++fetchGen
    inFlightGen = gen
    bufferedDeltas = []
    try {
      const wantsEnvironments =
        options.transport.mode === 'standalone' && options.features.includes(FLEET_ENVIRONMENTS_FEATURE)
      const [snapshot, envList]: [
        FleetAttentionSnapshot,
        { environments: Array<{ id: string; name: string }> } | null,
      ] = await Promise.all([
        options.call('attention'),
        wantsEnvironments ? options.call('environmentsList').catch(() => null) : Promise.resolve(null),
      ])
      if (stopped || paused || gen !== fetchGen) return
      inFlightGen = null
      let nextEntries = new Map<string, FleetAttentionEntry>()
      for (const entry of snapshot.entries) nextEntries.set(entry.key, entry)
      for (const delta of bufferedDeltas) nextEntries = applyDelta(nextEntries, delta)
      bufferedDeltas = []
      entries = nextEntries
      if (envList) environments = new Map(envList.environments.map((env) => [env.id, env.name]))
      else syncSharedEnvironments()
      loaded = true
      fetchAttempt = 0
      reachable = !isUnhealthyStreamState(streamState)
      emit()
    } catch (error) {
      if (stopped || paused || gen !== fetchGen) return
      inFlightGen = null
      bufferedDeltas = []
      if (reachable) {
        reachable = false
        emit()
      }
      if (!isTerminalError(error)) scheduleFetchRetry()
    }
  }

  const handleStreamState = (next: StreamState) => {
    if (stopped) return
    streamState = next
    if (isUnhealthyStreamState(next)) {
      clearFetchRetry()
      if (reachable) {
        reachable = false
        emit()
      }
    }
  }

  const openStandaloneStream = () => {
    if (options.transport.mode !== 'standalone' || streamHandle || stopped || paused) return
    const transport = options.transport
    const opener = transport.openStream ?? openEventStream
    const url = transport.origin + buildPath(FLEET_GATEWAY_ROUTES.events.path, {}, { [FLEET_ATTENTION_QUERY]: 1 })
    const streamOptions: EventStreamOptions = {
      url,
      headers: transport.headers(),
      fetch: transport.fetchStream,
      createDecoder: transport.createDecoder ?? (() => new TextDecoder()),
      onEvent(event) {
        if (event.type === 'hello') {
          streamState = 'open'
          void fetchSnapshot()
        }
      },
      onAttention: handleAttentionDelta,
      onState: handleStreamState,
      random,
      ...(transport.watchdogMs !== undefined ? { watchdogMs: transport.watchdogMs } : {}),
    }
    streamHandle = opener(streamOptions)
  }

  const attachSharedStream = () => {
    if (options.transport.mode !== 'shared' || unsubscribeSharedAttention || stopped) return
    const { stream } = options.transport
    streamState = stream.getConnection()
    syncSharedEnvironments()
    if (isUnhealthyStreamState(streamState)) reachable = false
    unsubscribeSharedAttention = stream.onAttentionStream({
      onEvent: handleAttentionDelta,
      onHello() {
        streamState = 'open'
        if (!paused && !stopped) void fetchSnapshot()
      },
    })
    unsubscribeSharedStore = stream.subscribeStore(() => {
      if (stopped) return
      const nextConnection = stream.getConnection()
      const envChanged = syncSharedEnvironments()
      let reachChanged = false
      if (nextConnection !== streamState) {
        streamState = nextConnection
        if (isUnhealthyStreamState(nextConnection) && reachable) {
          clearFetchRetry()
          reachable = false
          reachChanged = true
        }
      }
      if (envChanged || reachChanged) emit()
    })
    if (streamState === 'open' && !paused) void fetchSnapshot()
    else emit()
  }

  return {
    getState: () => currentState,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      if (started || stopped) return
      started = true
      if (options.transport.mode === 'standalone') openStandaloneStream()
      else attachSharedStream()
    },
    background() {
      if (stopped || paused) return
      paused = true
      fetchGen++
      inFlightGen = null
      bufferedDeltas = []
      clearFetchRetry()
      if (options.transport.mode === 'standalone') {
        streamHandle?.close()
        streamHandle = null
      }
    },
    foreground() {
      if (stopped || !started || !paused) return
      paused = false
      fetchAttempt = 0
      if (options.transport.mode === 'standalone') {
        openStandaloneStream()
      } else {
        streamState = options.transport.stream.getConnection()
        if (streamState === 'open') void fetchSnapshot()
      }
    },
    stop() {
      if (stopped) return
      stopped = true
      fetchGen++
      inFlightGen = null
      bufferedDeltas = []
      clearFetchRetry()
      streamHandle?.close()
      streamHandle = null
      unsubscribeSharedAttention?.()
      unsubscribeSharedAttention = null
      unsubscribeSharedStore?.()
      unsubscribeSharedStore = null
    },
  }
}
