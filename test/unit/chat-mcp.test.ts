import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  addMcpServer,
  buildMcpTools,
  disposeMcpRuntime,
  sanitizeMcpToolName,
  toolsFromClient,
  type ListedMcpTool,
} from '../../src/main/chat/mcp'
import { EXTERNAL_MCP_RESTRICTED_METADATA, externalMcpToolAllowed } from '../../src/main/chat/tool-policy'
import { writeMcpCatalog } from '../../src/main/chat/mcp-catalog'
import { toolOutputImages } from '../../src/shared/chat'
import { modelOutputToChatToolOutput, MAX_EPHEMERAL_IMAGE_BYTES } from '../../src/main/chat/tool-output'
import { freshDb, closeDb } from '../helpers/db'

/**
 * Proves the GENERIC chat MCP PATH end to end with an in-memory MCP server (the same
 * Third-party and native app tools share toolsFromClient; only the
 * transport). Ensures listTools, inputSchema wrapping, execute, callTool, text, and gate invocation.
 */
async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Returns the received text.',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] })
  )
  server.registerTool(
    'sum',
    { title: 'Sum', description: 'Add two numbers.', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
  )
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await server.connect(serverT)
  await client.connect(clientT)
  return client
}

async function connectedImageClient(): Promise<Client> {
  const server = new McpServer({ name: 'image-test', version: '1.0.0' })
  server.registerTool(
    'browser_screenshot',
    {
      title: 'Browser screenshot',
      description: 'Returns a screenshot.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        { type: 'text', text: 'Screenshot captured.' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
      structuredContent: { source: 'browser' },
    })
  )
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'image-test-client', version: '1.0.0' })
  await server.connect(serverT)
  await client.connect(clientT)
  return client
}

describe('generic MCP tools for third-party and app servers', () => {
  it('wraps MCP tools with input schemas', async () => {
    const client = await connectedClient()
    const tools = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async () => {}
    )
    expect(Object.keys(tools).sort()).toEqual(['echo', 'sum'])
    await client.close()
  })

  it('returns MCP content text from execution', async () => {
    const client = await connectedClient()
    const tools = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async () => {}
    )
    const echo = tools.echo as unknown as { execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown> }
    const out = await echo.execute({ text: 'hi' }, { toolCallId: 'k1' })
    expect(out).toBe('echo: hi')
    const sum = tools.sum as unknown as { execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown> }
    expect(await sum.execute({ a: 2, b: 3 }, { toolCallId: 'k2' })).toBe('5')
    await client.close()
  })

  it('preserves MCP images and structured content until provider projection', async () => {
    const client = await connectedImageClient()
    const describeImage = vi.fn(async () => ({ text: 'unnecessary description', model: 'interpreter' }))
    const tools = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async () => {},
      undefined,
      undefined,
      undefined,
      {
        supportsImages: true,
        describeImage,
      }
    )
    const screenshot = tools.browser_screenshot as unknown as {
      execute: (input: unknown, options: { toolCallId: string }) => Promise<unknown>
    }
    const output = await screenshot.execute({}, { toolCallId: 'screenshot-1' })
    const safe = modelOutputToChatToolOutput(output)
    expect(toolOutputImages(safe)).toHaveLength(1)
    expect(safe).toMatchObject({
      text: expect.stringContaining('Screenshot captured.'),
      structuredContent: { source: 'browser' },
    })
    expect(JSON.stringify(safe)).not.toContain('aGVsbG8=')
    expect(describeImage).not.toHaveBeenCalled()
    await client.close()
  })

  it('describes MCP images for consumers without vision', async () => {
    const client = await connectedImageClient()
    const describeImage = vi.fn(async () => ({ text: 'A browser screenshot.', model: 'vision-helper' }))
    const tools = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async () => {},
      undefined,
      undefined,
      undefined,
      { supportsImages: false, describeImage }
    )
    const screenshot = tools.browser_screenshot as unknown as {
      execute: (input: unknown, options: { toolCallId: string }) => Promise<unknown>
    }

    const output = modelOutputToChatToolOutput(await screenshot.execute({}, { toolCallId: 'screenshot-no-vision' }))

    expect(describeImage).toHaveBeenCalledOnce()
    expect(toolOutputImages(output)).toEqual([
      expect.objectContaining({ description: 'A browser screenshot.', descriptionModel: 'vision-helper' }),
    ])
    await client.close()
  })

  it('prefixes tool names to avoid server collisions', async () => {
    const client = await connectedClient()
    const tools = await toolsFromClient(
      client,
      (n) => `srv__${n}`,
      () => '',
      async () => {}
    )
    expect(Object.keys(tools).sort()).toEqual(['srv__echo', 'srv__sum'])
    await client.close()
  })

  it('omits images above 16 MiB with a defensive-limit note', async () => {
    // Browser screenshots apply their own limits; the global 16 MiB boundary
    // still protects all other MCP servers.
    const server = new McpServer({ name: 'big-image', version: '1.0.0' })
    server.registerTool(
      'browser_screenshot',
      { title: 'Screenshot', description: 'Returns a screenshot.', inputSchema: {} },
      async () => ({
        content: [
          {
            type: 'image',
            data: Buffer.alloc(MAX_EPHEMERAL_IMAGE_BYTES + 1024, 4).toString('base64'),
            mimeType: 'image/png',
          },
          { type: 'text', text: 'captured' },
        ],
      })
    )
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'big-image-client', version: '1.0.0' })
    await server.connect(serverT)
    await client.connect(clientT)
    const tools = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async () => {}
    )
    const shot = tools.browser_screenshot as unknown as {
      execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown>
    }
    const out = await shot.execute({}, { toolCallId: 'big-1' })
    const safe = modelOutputToChatToolOutput(out)

    expect(toolOutputImages(safe)).toHaveLength(0)
    expect(safe).toBe('captured\n[1 tool image omitted: per-result image limit or cache budget]')
    await client.close()
  })

  it('checks permission before executing tools', async () => {
    const client = await connectedClient()
    const calls: Array<{ name: string; id: string }> = []
    const tools = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async (name, id) => {
        calls.push({ name, id })
      }
    )
    const echo = tools.echo as unknown as { execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown> }
    await echo.execute({ text: 'x' }, { toolCallId: 'kid' })
    expect(calls).toEqual([{ name: 'echo', id: 'kid' }])
    await client.close()
  })

  it('filters complete tool definitions by annotation', async () => {
    const client = await connectedClient()
    const seen: ListedMcpTool[] = []
    const tools = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async () => {},
      (listedTool) => {
        seen.push(listedTool)
        return externalMcpToolAllowed('plan', listedTool.annotations)
      }
    )
    expect(Object.keys(tools)).toEqual(['echo']) // sum did not declare readOnlyHint.
    expect(seen.map(({ name, annotations }) => ({ name, annotations }))).toEqual([
      { name: 'echo', annotations: { readOnlyHint: true } },
      { name: 'sum', annotations: undefined },
    ])
    await client.close()
  })

  it('adds read-only and serial metadata only to restricted catalogs', async () => {
    const client = await connectedClient()
    const restricted = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async () => {},
      (listedTool) => externalMcpToolAllowed('ask', listedTool.annotations),
      undefined,
      () => EXTERNAL_MCP_RESTRICTED_METADATA
    )
    expect(restricted.echo.metadata).toEqual({ readOnly: true, parallelSafe: false })

    const agent = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async () => {}
    )
    expect(Object.keys(agent).sort()).toEqual(['echo', 'sum'])
    expect(agent.echo.metadata).toBeUndefined()
    await client.close()
  })

  it('forwards request timeouts for blocking app tools', async () => {
    const client = await connectedClient()
    const spy = vi.spyOn(client, 'callTool')
    // WITH callTimeoutMs: third argument is { timeout } (review_plan may wait minutes or hours).
    const withTo = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async () => {},
      undefined,
      999_999
    )
    const e1 = withTo.echo as unknown as { execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown> }
    await e1.execute({ text: 'x' }, { toolCallId: 'k' })
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: 'echo' }), undefined, { timeout: 999_999 })
    // WITHOUT callTimeoutMs: third argument is undefined (SDK default for external servers).
    spy.mockClear()
    const noTo = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async () => {}
    )
    const e2 = noTo.echo as unknown as { execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown> }
    await e2.execute({ text: 'y' }, { toolCallId: 'k2' })
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: 'echo' }), undefined, undefined)
    await client.close()
  })

  it('forwards abort signals to pending MCP requests', async () => {
    const client = await connectedClient()
    const spy = vi.spyOn(client, 'callTool')
    const gate = vi.fn(async () => {})
    const tools = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      gate
    )
    const echo = tools.echo as unknown as {
      execute: (i: unknown, o: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>
    }
    const controller = new AbortController()

    await echo.execute({ text: 'x' }, { toolCallId: 'k', abortSignal: controller.signal })

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: 'echo' }), undefined, {
      signal: controller.signal,
    })
    expect(gate).toHaveBeenCalledWith('echo', 'k', controller.signal)
    await client.close()
  })

  it('prevents execution when the permission gate throws', async () => {
    const client = await connectedClient()
    const callTool = vi.spyOn(client, 'callTool')
    const tools = await toolsFromClient(
      client,
      (n) => n,
      () => '',
      async () => {
        throw new Error('denied')
      }
    )
    const echo = tools.echo as unknown as { execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown> }
    await expect(echo.execute({ text: 'x' }, { toolCallId: 'k' })).rejects.toThrow('denied')
    expect(callTool).not.toHaveBeenCalled()
    await client.close()
  })
})

/**
 * Real stdio integration covers security-critical mode wiring with
 * annotation variants. Removing or reversing the restricted branch must fail
 * here; isolated wrapper tests do not cover mode policy application.
 */
describe('buildMcpTools catalogs by mode with real stdio and store', () => {
  const FIXTURE = fileURLToPath(new URL('../fixtures/mcp-stdio-annotated.cjs', import.meta.url))
  type Executable = {
    execute: (i: unknown, o: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<unknown>
  }
  let fixtureDir = ''
  let fixtureStartedFile = ''

  beforeEach(() => {
    freshDb()
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-lazy-fixture-'))
    fixtureStartedFile = path.join(fixtureDir, 'started')
  })
  afterEach(async () => {
    await disposeMcpRuntime()
    closeDb()
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  const registerFixtureServer = () =>
    addMcpServer({
      name: 'fixture',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      env: { MCP_FIXTURE_STARTED_FILE: fixtureStartedFile },
    })

  it('builds cold catalogs without processes and discovers tools on demand', async () => {
    const server = registerFixtureServer()
    const gate = vi.fn(async () => {})
    const built = await buildMcpTools({ mode: 'agent', gate, signal: new AbortController().signal })
    try {
      expect(Object.keys(built.tools).sort()).toEqual(['mcp_call', 'mcp_search'])
      expect(existsSync(fixtureStartedFile)).toBe(false)

      const search = built.tools.mcp_search as unknown as Executable
      const searchOutput = await search.execute({ server: server.id, query: 'lookup' }, { toolCallId: 'search-1' })
      expect(searchOutput).toContain('lookup')
      expect(existsSync(fixtureStartedFile)).toBe(true)
      expect(gate).not.toHaveBeenCalled()

      const call = built.tools.mcp_call as unknown as Executable
      expect(await call.execute({ server: server.id, tool: 'lookup', arguments: {} }, { toolCallId: 'call-1' })).toBe(
        'lookup-ok'
      )
      expect(gate).toHaveBeenCalledExactlyOnceWith('fixture__lookup', 'call-1')
    } finally {
      await built.close()
    }
  })

  it.each([
    'plan',
    'ask',
  ] as const)('%s filters discovery and revalidates policy before generic dispatch', async (mode) => {
    const server = registerFixtureServer()
    const gate = vi.fn(async () => {})
    const built = await buildMcpTools({ mode, gate, signal: new AbortController().signal })
    try {
      expect(Object.keys(built.tools).sort()).toEqual(['mcp_call', 'mcp_search'])
      expect(built.tools.mcp_search.metadata).toEqual({ readOnly: true, parallelSafe: false })
      expect(built.tools.mcp_call.metadata).toEqual({ readOnly: true, parallelSafe: false })
      const search = built.tools.mcp_search as unknown as Executable
      const searchOutput = await search.execute({ server: server.id }, { toolCallId: 'search-2' })
      expect(searchOutput).toContain('lookup')
      expect(searchOutput).not.toContain('mutate')
      expect(searchOutput).not.toContain('declared_false')
      expect(searchOutput).not.toContain('contradictory')

      const call = built.tools.mcp_call as unknown as Executable
      await expect(
        call.execute({ server: server.id, tool: 'mutate', arguments: {} }, { toolCallId: 'call-denied' })
      ).rejects.toThrow(/not available/i)
      expect(gate).not.toHaveBeenCalled()
    } finally {
      await built.close()
    }
  })

  it('reopens warm catalogs without IO and exposes typed wrappers', async () => {
    const server = registerFixtureServer()
    const cold = await buildMcpTools({ mode: 'agent', gate: async () => {}, signal: new AbortController().signal })
    const search = cold.tools.mcp_search as unknown as Executable
    await search.execute({ server: server.id }, { toolCallId: 'seed' })

    const gate = vi.fn(async () => {})
    const built = await buildMcpTools({ mode: 'agent', gate, signal: new AbortController().signal })
    try {
      expect(Object.keys(built.tools).sort()).toEqual([
        'fixture__contradictory',
        'fixture__declared_false',
        'fixture__echo',
        'fixture__lookup',
        'fixture__mutate',
        'fixture__screenshot',
        'mcp_call',
        'mcp_search',
      ])
      expect(built.tools.fixture__lookup.metadata).toEqual({ readOnly: true, parallelSafe: false })
      const mutate = built.tools.fixture__mutate as unknown as Executable
      expect(await mutate.execute({}, { toolCallId: 'c2' })).toBe('mutate-ok')
      expect(gate).toHaveBeenCalledExactlyOnceWith('fixture__mutate', 'c2')
    } finally {
      await built.close()
    }
  })

  it('gives Design the warm mutable catalog and metadata behavior of Agent', async () => {
    const server = registerFixtureServer()
    const cold = await buildMcpTools({ mode: 'design', gate: async () => {}, signal: new AbortController().signal })
    await (cold.tools.mcp_search as unknown as Executable).execute({ server: server.id }, { toolCallId: 'seed-design' })

    const gate = vi.fn(async () => {})
    const built = await buildMcpTools({ mode: 'design', gate, signal: new AbortController().signal })
    try {
      expect(built.tools).toHaveProperty('fixture__mutate')
      expect(built.tools.fixture__mutate.metadata).toBeUndefined()
      expect(built.tools.mcp_call.metadata).toBeUndefined()
      const mutate = built.tools.fixture__mutate as unknown as Executable
      await expect(mutate.execute({}, { toolCallId: 'design-mutate' })).resolves.toBe('mutate-ok')
      expect(gate).toHaveBeenCalledExactlyOnceWith('fixture__mutate', 'design-mutate')
    } finally {
      await built.close()
    }
  })

  it('exposes only read-only wrappers in restricted warm catalogs', async () => {
    const server = registerFixtureServer()
    const cold = await buildMcpTools({ mode: 'agent', gate: async () => {}, signal: new AbortController().signal })
    await (cold.tools.mcp_search as unknown as Executable).execute({ server: server.id }, { toolCallId: 'seed-plan' })

    const built = await buildMcpTools({ mode: 'plan', gate: async () => {}, signal: new AbortController().signal })
    expect(Object.keys(built.tools).sort()).toEqual([
      'fixture__echo',
      'fixture__lookup',
      'fixture__screenshot',
      'mcp_call',
      'mcp_search',
    ])
    expect(built.tools.fixture__lookup.metadata).toEqual({ readOnly: true, parallelSafe: false })
  })

  it('validates live schemas before permission and dispatch', async () => {
    const server = registerFixtureServer()
    const gate = vi.fn(async () => {})
    const built = await buildMcpTools({ mode: 'agent', gate, signal: new AbortController().signal })
    const call = built.tools.mcp_call as unknown as Executable

    await expect(
      call.execute({ server: server.id, tool: 'echo', arguments: {} }, { toolCallId: 'invalid' })
    ).rejects.toThrow()
    expect(gate).not.toHaveBeenCalled()
    expect(
      await call.execute({ server: server.id, tool: 'echo', arguments: { value: 'hello' } }, { toolCallId: 'valid' })
    ).toBe('echo:hello')
    expect(gate).toHaveBeenCalledExactlyOnceWith('fixture__echo', 'valid')
  })

  it('revalidates live annotations against stale cached wrappers', async () => {
    const server = registerFixtureServer()
    writeMcpCatalog(server, [{ name: 'mutate', annotations: { readOnlyHint: true } }])
    const gate = vi.fn(async () => {})
    const built = await buildMcpTools({ mode: 'plan', gate, signal: new AbortController().signal })
    expect(built.tools).toHaveProperty('fixture__mutate')

    const stale = built.tools.fixture__mutate as unknown as Executable
    await expect(stale.execute({}, { toolCallId: 'stale' })).rejects.toThrow(/not available in plan mode/i)
    expect(gate).not.toHaveBeenCalled()
  })

  it('preserves images and structured content in generic dispatch', async () => {
    const server = registerFixtureServer()
    const built = await buildMcpTools({ mode: 'agent', gate: async () => {}, signal: new AbortController().signal })
    const call = built.tools.mcp_call as unknown as Executable

    const output = modelOutputToChatToolOutput(
      await call.execute({ server: server.id, tool: 'screenshot', arguments: {} }, { toolCallId: 'image' })
    )
    expect(output).toMatchObject({
      text: expect.stringContaining('captured'),
      structuredContent: { source: 'fixture' },
    })
    expect(toolOutputImages(output)).toHaveLength(1)
  })

  it('requires IDs for ambiguous server names before starting processes', async () => {
    registerFixtureServer()
    addMcpServer({
      name: 'fixture',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      env: { MCP_FIXTURE_STARTED_FILE: path.join(fixtureDir, 'second-started') },
    })
    const built = await buildMcpTools({ mode: 'agent', gate: async () => {}, signal: new AbortController().signal })
    const search = built.tools.mcp_search as unknown as Executable

    await expect(search.execute({ server: 'fixture' }, { toolCallId: 'ambiguous' })).rejects.toThrow(/ambiguous/i)
    expect(existsSync(fixtureStartedFile)).toBe(false)
    expect(existsSync(path.join(fixtureDir, 'second-started'))).toBe(false)
  })

  it('disables conversation-selected servers in every mode', async () => {
    const server = registerFixtureServer()
    const built = await buildMcpTools({
      mode: 'agent',
      gate: async () => {},
      signal: new AbortController().signal,
      disabledIds: new Set([server.id]),
    })
    try {
      expect(Object.keys(built.tools)).toEqual([])
      expect(existsSync(fixtureStartedFile)).toBe(false)
    } finally {
      await built.close()
    }
  })
})

describe('external MCP tool names', () => {
  it('uses safe Codex namespaces and shared name contracts', () => {
    const name = sanitizeMcpToolName('server-1', 'MCP', 'mcp__dangerous tool')

    expect(name).toMatch(/^ext_mcp__/)
    expect(name).not.toBe('mcp')
    expect(name).not.toMatch(/^mcp__/)
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(name.length).toBeLessThanOrEqual(64)
  })

  it('keeps homonymous server names deterministic and distinct', () => {
    const first = sanitizeMcpToolName('server-1', 'GitHub', 'search')

    expect(sanitizeMcpToolName('server-1', 'GitHub', 'search')).toBe(first)
    expect(sanitizeMcpToolName('server-2', 'GitHub', 'search')).not.toBe(first)
  })

  it('preserves uniqueness after slug sanitization and truncation', () => {
    const punctuationA = sanitizeMcpToolName('server-1', 'Tools', 'read.file')
    const punctuationB = sanitizeMcpToolName('server-1', 'Tools', 'read/file')
    const longPrefix = 'x'.repeat(100)
    const longA = sanitizeMcpToolName('server-1', 'Tools', `${longPrefix}a`)
    const longB = sanitizeMcpToolName('server-1', 'Tools', `${longPrefix}b`)

    expect(punctuationA).not.toBe(punctuationB)
    expect(longA).not.toBe(longB)
    expect(longA.length).toBeLessThanOrEqual(64)
    expect(longB.length).toBeLessThanOrEqual(64)
  })
})
