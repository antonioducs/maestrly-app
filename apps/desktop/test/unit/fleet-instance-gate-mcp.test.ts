import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { toolsFromClient } from '../../src/main/chat/mcp'
import { InstanceHoldManager, registerInstanceHoldGate } from '../../src/main/fleet/instance/gate'

afterEach(() => vi.unstubAllEnvs())

it('guards actual app-tool dispatch only for the bot primary conversation', async () => {
  let calls = 0
  const server = new McpServer({ name: 'instance-gate-test', version: '1' })
  server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => {
    calls++
    return { content: [{ type: 'text', text }] }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'instance-gate-client', version: '1' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const manager = new InstanceHoldManager()
  const unregister = registerInstanceHoldGate(manager, 'primary')
  try {
    const tools = await toolsFromClient(
      client,
      (name) => name,
      () => '',
      async () => {},
      undefined,
      undefined,
      undefined,
      {},
      'primary'
    )
    const otherTools = await toolsFromClient(
      client,
      (name) => name,
      () => '',
      async () => {},
      undefined,
      undefined,
      undefined,
      {},
      'other'
    )
    const primary = tools.echo as unknown as { execute(input: unknown, opts: { toolCallId: string }): Promise<unknown> }
    const other = otherTools.echo as unknown as {
      execute(input: unknown, opts: { toolCallId: string }): Promise<unknown>
    }
    expect(await primary.execute({ text: 'normal' }, { toolCallId: 'normal' })).toBe('normal')
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    await manager.hold('takeover', false, async () => {})
    await expect(primary.execute({ text: 'blocked' }, { toolCallId: 'blocked' })).rejects.toThrow('taken over')
    expect(await other.execute({ text: 'other' }, { toolCallId: 'other' })).toBe('other')
    expect(calls).toBe(2)
    vi.stubEnv('MAESTRLY_BOT_MODE', '0')
    expect(await primary.execute({ text: 'inert' }, { toolCallId: 'inert' })).toBe('inert')
  } finally {
    unregister()
    await client.close()
    await server.close()
  }
})
