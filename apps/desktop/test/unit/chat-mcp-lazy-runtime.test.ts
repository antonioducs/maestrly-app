import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import {
  LazyMcpRuntime,
  MCP_CIRCUIT_INITIAL_BACKOFF_MS,
  MCP_CIRCUIT_MAX_BACKOFF_MS,
  MCP_IDLE_TTL_MS,
  MCP_STARTUP_TIMEOUT_MS,
  type LazyMcpDiagnostic,
} from '../../src/main/chat/mcp-lazy-runtime'
import type { McpConnection, McpRequestOptions, McpServer } from '../../src/main/chat/mcp-types'

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'mcp_runtime_test',
    name: 'Runtime test',
    transport: 'stdio',
    enabled: true,
    command: 'fixture',
    args: [],
    ...overrides,
  }
}

function connection() {
  return {
    listTools: vi.fn(async () => [
      { name: 'lookup', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    ]),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    close: vi.fn(async () => {}),
  } satisfies McpConnection
}

interface Scheduled {
  callback: () => void
  delay: number
  cancelled: boolean
}

describe('LazyMcpRuntime', () => {
  let now: number
  let scheduled: Scheduled[]
  let diagnostic: ReturnType<typeof vi.fn<(event: LazyMcpDiagnostic) => void>>

  beforeEach(() => {
    now = 1_000
    scheduled = []
    diagnostic = vi.fn()
  })

  const createRuntime = (connect: (server: McpServer, options: McpRequestOptions) => Promise<McpConnection>) =>
    new LazyMcpRuntime({
      connect,
      now: () => now,
      schedule: (callback, delay) => {
        const handle = { callback, delay, cancelled: false }
        scheduled.push(handle)
        return handle
      },
      cancel: (handle) => {
        ;(handle as Scheduled).cancelled = true
      },
      diagnostic,
    })

  it('does no work until first use, then deduplicates concurrent initialization and reuses it', async () => {
    const connected = connection()
    const connect = vi.fn(async () => connected)
    const runtime = createRuntime(connect)
    const signal = new AbortController().signal

    expect(connect).not.toHaveBeenCalled()
    const [first, second] = await Promise.all([
      runtime.listTools(server(), signal),
      runtime.listTools(server(), signal),
    ])
    await runtime.callTool(server(), 'lookup', { id: '1' }, { signal })

    expect(first).toEqual(second)
    expect(connect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledWith(server(), { signal, timeout: MCP_STARTUP_TIMEOUT_MS })
    expect(connected.listTools).toHaveBeenCalledOnce()
    expect(connected.listTools).toHaveBeenCalledWith({ signal, timeout: MCP_STARTUP_TIMEOUT_MS })
    expect(connected.callTool).toHaveBeenCalledWith('lookup', { id: '1' }, { signal })
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mcp-lazy-pool-reuse', serverId: server().id })
    )
  })

  it('closes a healthy connection after the idle TTL but never during an active call', async () => {
    const connected = connection()
    let releaseCall!: () => void
    connected.callTool.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCall = () => resolve({ content: [{ type: 'text', text: 'done' }] })
        })
    )
    const runtime = createRuntime(vi.fn(async () => connected))
    await runtime.listTools(server())
    expect(scheduled.at(-1)?.delay).toBe(MCP_IDLE_TTL_MS)

    const pending = runtime.callTool(server(), 'lookup', {})
    await Promise.resolve()
    await Promise.resolve()
    for (const timer of scheduled) if (!timer.cancelled) timer.callback()
    expect(connected.close).not.toHaveBeenCalled()

    releaseCall()
    await pending
    const idle = scheduled.at(-1)!
    expect(idle.delay).toBe(MCP_IDLE_TTL_MS)
    idle.callback()
    await Promise.resolve()
    expect(connected.close).toHaveBeenCalledOnce()
  })

  it('opens a bounded exponential circuit after failures and resets it after success', async () => {
    const connected = connection()
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline-1'))
      .mockRejectedValueOnce(new Error('offline-2'))
      .mockResolvedValue(connected)
    const runtime = createRuntime(connect)

    await expect(runtime.listTools(server())).rejects.toThrow('offline-1')
    await expect(runtime.listTools(server())).rejects.toThrow(/temporarily unavailable/i)
    expect(connect).toHaveBeenCalledOnce()

    now += MCP_CIRCUIT_INITIAL_BACKOFF_MS
    await expect(runtime.listTools(server())).rejects.toThrow('offline-2')
    now += MCP_CIRCUIT_INITIAL_BACKOFF_MS * 2
    await runtime.listTools(server())
    expect(connect).toHaveBeenCalledTimes(3)
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mcp-lazy-circuit-reset', serverId: server().id })
    )
  })

  it('caps repeated circuit failures at five minutes', async () => {
    const connect = vi.fn(async () => {
      throw new Error('offline')
    })
    const runtime = createRuntime(connect)

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(runtime.listTools(server())).rejects.toThrow('offline')
      const event = diagnostic.mock.calls
        .map(([entry]) => entry)
        .filter((entry) => entry.kind === 'mcp-lazy-circuit-open')
        .at(-1)
      expect(event?.backoffMs).toBeLessThanOrEqual(MCP_CIRCUIT_MAX_BACKOFF_MS)
      now = event?.retryAt ?? now
    }
  })

  it('invalidates and closes the old pool entry when connection configuration changes', async () => {
    const first = connection()
    const second = connection()
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const runtime = createRuntime(connect)
    const initial = server()

    await runtime.listTools(initial)
    await runtime.listTools({ ...initial, args: ['--changed'] })
    await Promise.resolve()

    expect(connect).toHaveBeenCalledTimes(2)
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
  })

  it('evicts a connection and opens the circuit when a call throws', async () => {
    const connected = connection()
    connected.callTool.mockRejectedValueOnce(new Error('transport closed'))
    const connect = vi.fn(async () => connected)
    const runtime = createRuntime(connect)

    await expect(runtime.callTool(server(), 'lookup', {})).rejects.toThrow('transport closed')
    await expect(runtime.listTools(server())).rejects.toThrow(/temporarily unavailable/i)
    expect(connected.close).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledOnce()
  })

  it('does not open the transport circuit for an MCP application error', async () => {
    const connected = connection()
    connected.callTool.mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, 'application rejected input'))
    const connect = vi.fn(async () => connected)
    const runtime = createRuntime(connect)

    await expect(runtime.callTool(server(), 'lookup', {})).rejects.toThrow('application rejected input')
    await expect(runtime.listTools(server())).resolves.toHaveLength(1)
    expect(connect).toHaveBeenCalledOnce()
    expect(connected.close).not.toHaveBeenCalled()
  })

  it('dispose closes every pooled connection and cancels idle timers', async () => {
    const first = connection()
    const second = connection()
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const runtime = createRuntime(connect)
    await runtime.listTools(server({ id: 'one' }))
    await runtime.listTools(server({ id: 'two' }))

    await runtime.dispose()

    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
    expect(scheduled.every((timer) => timer.cancelled)).toBe(true)
  })

  it('never places connection secrets, tool arguments or error messages in diagnostics', async () => {
    const connect = vi.fn(async () => {
      throw new Error('failure-with-secret-value')
    })
    const runtime = createRuntime(connect)
    const sensitive = server({
      transport: 'http',
      command: undefined,
      args: undefined,
      url: 'https://token-value@example.test/mcp',
      headers: { Authorization: 'Bearer secret-value' },
      env: { TOKEN: 'secret-value' },
    })

    await expect(runtime.listTools(sensitive)).rejects.toThrow('failure-with-secret-value')
    const serialized = JSON.stringify(diagnostic.mock.calls)
    expect(serialized).not.toContain('token-value')
    expect(serialized).not.toContain('secret-value')
    expect(serialized).not.toContain('failure-with-secret-value')
  })
})
