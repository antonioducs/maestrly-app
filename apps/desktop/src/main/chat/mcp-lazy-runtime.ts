import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { mcpServerFingerprint } from './mcp-catalog'
import type { ListedMcpTool, McpCallToolResult, McpConnection, McpRequestOptions, McpServer } from './mcp-types'

export const MCP_STARTUP_TIMEOUT_MS = 5_000
export const MCP_IDLE_TTL_MS = 5 * 60_000
export const MCP_CIRCUIT_INITIAL_BACKOFF_MS = 30_000
export const MCP_CIRCUIT_MAX_BACKOFF_MS = 5 * 60_000

export interface LazyMcpDiagnostic {
  kind:
    | 'mcp-lazy-connect'
    | 'mcp-lazy-list'
    | 'mcp-lazy-call'
    | 'mcp-lazy-pool-reuse'
    | 'mcp-lazy-pool-evict'
    | 'mcp-lazy-circuit-open'
    | 'mcp-lazy-circuit-reject'
    | 'mcp-lazy-circuit-reset'
  serverId: string
  transport?: McpServer['transport']
  outcome?: 'success' | 'error'
  durationMs?: number
  toolCount?: number
  backoffMs?: number
  retryAt?: number
  reason?: 'idle' | 'invalidated' | 'configuration-changed' | 'transport-error' | 'dispose'
}

type TimerHandle = unknown

export interface LazyMcpRuntimeDependencies {
  connect: (server: McpServer, options: McpRequestOptions) => Promise<McpConnection>
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => TimerHandle
  cancel?: (handle: TimerHandle) => void
  diagnostic?: (event: LazyMcpDiagnostic) => void
}

interface PoolEntry {
  fingerprint: string
  server: McpServer
  connection: McpConnection | null
  tools: ListedMcpTool[] | null
  initializing: Promise<void> | null
  activeCalls: number
  idleTimer: TimerHandle | null
}

interface CircuitState {
  fingerprint: string
  failures: number
  openUntil: number
}

export class McpCircuitOpenError extends Error {
  constructor(
    readonly serverId: string,
    readonly retryAt: number
  ) {
    super(
      `External MCP server "${serverId}" is temporarily unavailable; retry after ${new Date(retryAt).toISOString()}.`
    )
    this.name = 'McpCircuitOpenError'
  }
}

function requestOptions(signal: AbortSignal | undefined, timeout: number): McpRequestOptions {
  return { ...(signal ? { signal } : {}), timeout }
}

function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof McpError)) return true
  return error.code === ErrorCode.ConnectionClosed || error.code === ErrorCode.RequestTimeout
}

export class LazyMcpRuntime {
  private readonly entries = new Map<string, PoolEntry>()
  private readonly circuits = new Map<string, CircuitState>()
  private readonly now: () => number
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle
  private readonly cancel: (handle: TimerHandle) => void
  private readonly diagnostic: (event: LazyMcpDiagnostic) => void

  constructor(private readonly dependencies: LazyMcpRuntimeDependencies) {
    this.now = dependencies.now ?? Date.now
    this.schedule =
      dependencies.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs)
        timer.unref?.()
        return timer
      })
    this.cancel = dependencies.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.diagnostic = dependencies.diagnostic ?? (() => {})
  }

  async listTools(server: McpServer, signal?: AbortSignal): Promise<ListedMcpTool[]> {
    const entry = await this.ensure(server, signal)
    this.scheduleIdle(entry)
    return [...(entry.tools ?? [])]
  }

  async callTool(
    server: McpServer,
    name: string,
    args: Record<string, unknown>,
    options?: McpRequestOptions
  ): Promise<McpCallToolResult> {
    const entry = await this.ensure(server, options?.signal)
    const connection = entry.connection
    if (!connection) throw new Error(`External MCP server "${server.id}" did not initialize.`)
    this.clearIdle(entry)
    entry.activeCalls += 1
    const startedAt = this.now()
    try {
      const result = await connection.callTool(name, args, options)
      this.diagnostic({
        kind: 'mcp-lazy-call',
        serverId: server.id,
        transport: server.transport,
        outcome: 'success',
        durationMs: Math.max(0, this.now() - startedAt),
      })
      return result
    } catch (error) {
      this.diagnostic({
        kind: 'mcp-lazy-call',
        serverId: server.id,
        transport: server.transport,
        outcome: 'error',
        durationMs: Math.max(0, this.now() - startedAt),
      })
      if (isTransportFailure(error)) {
        this.recordFailure(server, entry.fingerprint)
        await this.evictEntry(server.id, entry, 'transport-error')
      }
      throw error
    } finally {
      entry.activeCalls = Math.max(0, entry.activeCalls - 1)
      if (this.entries.get(server.id) === entry) this.scheduleIdle(entry)
    }
  }

  invalidate(serverId: string): void {
    const entry = this.entries.get(serverId)
    if (entry) void this.evictEntry(serverId, entry, 'invalidated')
    this.circuits.delete(serverId)
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.entries()]
    this.entries.clear()
    this.circuits.clear()
    await Promise.all(entries.map(([serverId, entry]) => this.closeEntry(serverId, entry, 'dispose')))
  }

  private async ensure(server: McpServer, signal?: AbortSignal): Promise<PoolEntry> {
    signal?.throwIfAborted()
    const fingerprint = mcpServerFingerprint(server)
    this.assertCircuit(server, fingerprint)

    const existing = this.entries.get(server.id)
    if (existing && existing.fingerprint !== fingerprint) {
      this.circuits.delete(server.id)
      await this.evictEntry(server.id, existing, 'configuration-changed')
    }

    let entry = this.entries.get(server.id)
    if (!entry) {
      entry = {
        fingerprint,
        server,
        connection: null,
        tools: null,
        initializing: null,
        activeCalls: 0,
        idleTimer: null,
      }
      this.entries.set(server.id, entry)
    } else {
      this.diagnostic({ kind: 'mcp-lazy-pool-reuse', serverId: server.id, transport: server.transport })
      this.clearIdle(entry)
    }

    if (!entry.connection || !entry.tools) {
      if (!entry.initializing) entry.initializing = this.initialize(entry, signal)
      await entry.initializing
    }
    return entry
  }

  private async initialize(entry: PoolEntry, signal?: AbortSignal): Promise<void> {
    const { server } = entry
    let connection: McpConnection | null = null
    const connectStartedAt = this.now()
    try {
      connection = await this.dependencies.connect(server, requestOptions(signal, MCP_STARTUP_TIMEOUT_MS))
      entry.connection = connection
      this.diagnostic({
        kind: 'mcp-lazy-connect',
        serverId: server.id,
        transport: server.transport,
        outcome: 'success',
        durationMs: Math.max(0, this.now() - connectStartedAt),
      })

      const listStartedAt = this.now()
      const tools = await connection.listTools(requestOptions(signal, MCP_STARTUP_TIMEOUT_MS))
      entry.tools = [...tools]
      this.diagnostic({
        kind: 'mcp-lazy-list',
        serverId: server.id,
        transport: server.transport,
        outcome: 'success',
        durationMs: Math.max(0, this.now() - listStartedAt),
        toolCount: tools.length,
      })
      this.resetCircuit(server.id)
    } catch (error) {
      this.diagnostic({
        kind: connection ? 'mcp-lazy-list' : 'mcp-lazy-connect',
        serverId: server.id,
        transport: server.transport,
        outcome: 'error',
        durationMs: Math.max(0, this.now() - connectStartedAt),
      })
      this.recordFailure(server, entry.fingerprint)
      if (this.entries.get(server.id) === entry) this.entries.delete(server.id)
      if (connection) await connection.close().catch(() => {})
      throw error
    } finally {
      entry.initializing = null
    }
  }

  private assertCircuit(server: McpServer, fingerprint: string): void {
    const circuit = this.circuits.get(server.id)
    if (!circuit) return
    if (circuit.fingerprint !== fingerprint) {
      this.circuits.delete(server.id)
      return
    }
    if (this.now() >= circuit.openUntil) return
    this.diagnostic({
      kind: 'mcp-lazy-circuit-reject',
      serverId: server.id,
      transport: server.transport,
      retryAt: circuit.openUntil,
    })
    throw new McpCircuitOpenError(server.id, circuit.openUntil)
  }

  private recordFailure(server: McpServer, fingerprint: string): void {
    const previous = this.circuits.get(server.id)
    const failures = previous?.fingerprint === fingerprint ? previous.failures + 1 : 1
    const backoffMs = Math.min(
      MCP_CIRCUIT_MAX_BACKOFF_MS,
      MCP_CIRCUIT_INITIAL_BACKOFF_MS * 2 ** Math.max(0, failures - 1)
    )
    const retryAt = this.now() + backoffMs
    this.circuits.set(server.id, { fingerprint, failures, openUntil: retryAt })
    this.diagnostic({
      kind: 'mcp-lazy-circuit-open',
      serverId: server.id,
      transport: server.transport,
      backoffMs,
      retryAt,
    })
  }

  private resetCircuit(serverId: string): void {
    if (!this.circuits.delete(serverId)) return
    this.diagnostic({ kind: 'mcp-lazy-circuit-reset', serverId })
  }

  private clearIdle(entry: PoolEntry): void {
    if (!entry.idleTimer) return
    this.cancel(entry.idleTimer)
    entry.idleTimer = null
  }

  private scheduleIdle(entry: PoolEntry): void {
    this.clearIdle(entry)
    entry.idleTimer = this.schedule(() => {
      entry.idleTimer = null
      if (entry.activeCalls > 0 || this.entries.get(entry.server.id) !== entry) return
      void this.evictEntry(entry.server.id, entry, 'idle')
    }, MCP_IDLE_TTL_MS)
  }

  private async evictEntry(
    serverId: string,
    entry: PoolEntry,
    reason: NonNullable<LazyMcpDiagnostic['reason']>
  ): Promise<void> {
    if (this.entries.get(serverId) === entry) this.entries.delete(serverId)
    await this.closeEntry(serverId, entry, reason)
  }

  private async closeEntry(
    serverId: string,
    entry: PoolEntry,
    reason: NonNullable<LazyMcpDiagnostic['reason']>
  ): Promise<void> {
    this.clearIdle(entry)
    const connection = entry.connection
    entry.connection = null
    entry.tools = null
    if (connection) await connection.close().catch(() => {})
    this.diagnostic({ kind: 'mcp-lazy-pool-evict', serverId, transport: entry.server.transport, reason })
  }
}
