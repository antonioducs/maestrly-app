import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Tool } from 'ai'
import { addMcpServer, buildMcpTools, disposeMcpRuntime, listMcpServers } from '../../src/main/chat/mcp'
import { writeMcpCatalog } from '../../src/main/chat/mcp-catalog'
import { patchMcpOAuthAccount, resetMcpOAuthStatusForTests } from '../../src/main/chat/mcp-oauth'
import { connectMcpOAuth, localMcpOAuthHostCalls } from '../../src/main/chat/mcp-oauth-ipc'
import { fleetChatGetConvTools, fleetChatSetConvTools } from '../../src/main/chat/service'
import { closeDb, freshDb } from '../helpers/db'
import { browser, fakeOAuthServer } from '../helpers/fake-oauth-mcp'
import { makeConversation, makeStandaloneConversation, makeWorkspace } from '../helpers/factories'

let fake: Awaited<ReturnType<typeof fakeOAuthServer>>
beforeEach(() => {
  freshDb()
  resetMcpOAuthStatusForTests()
})
afterEach(async () => {
  await disposeMcpRuntime()
  await fake?.close()
  closeDb()
})

/** A user server with two signed-in accounts, alice then bob, and its catalog cached. */
async function twoAccounts() {
  fake = await fakeOAuthServer({ users: ['alice', 'bob'] })
  addMcpServer({ name: 'Protected', transport: 'http', url: fake.url }, { requireSecure: true })
  const [server] = listMcpServers()
  fake.state.nextUser.push('alice', 'bob')
  const alice = await connectMcpOAuth(localMcpOAuthHostCalls, 'local', server.id, {}, { openExternal: browser })
  const bob = await connectMcpOAuth(localMcpOAuthHostCalls, 'local', server.id, {}, { openExternal: browser })
  if (!alice.ok || !bob.ok) throw new Error('sign-in failed')
  writeMcpCatalog(server, [{ name: 'whoami', description: 'Who is signed in', inputSchema: { type: 'object' } }])
  return { server, alice: alice.accountId, bob: bob.accountId }
}

async function surface(conversationId: string | null) {
  const { tools } = await buildMcpTools({
    conversationId,
    mode: 'agent',
    gate: async () => {},
    signal: new AbortController().signal,
  })
  const name = Object.keys(tools).find((key) => key.endsWith('whoami'))
  if (!name) throw new Error('no whoami wrapper')
  return { tools, whoami: tools[name] as Tool & { inputSchema: { jsonSchema: Record<string, any> } } }
}

const run = (tool: Tool, input: unknown) =>
  (tool.execute as unknown as (input: unknown, options: { toolCallId: string; messages: [] }) => Promise<unknown>)(
    input,
    {
      toolCallId: 'call_1',
      messages: [],
    }
  )

describe('choosing the signed-in account of an MCP call', () => {
  it('asks every model to name the account when a server has several, and routes each call to it', async () => {
    await twoAccounts()
    const { tools, whoami } = await surface(null)
    expect(whoami.inputSchema.jsonSchema.properties.mcp_account).toMatchObject({
      type: 'string',
      enum: ['alice@example.test', 'bob@example.test'],
    })
    expect(whoami.inputSchema.jsonSchema.required).toContain('mcp_account')
    expect(JSON.stringify(await run(whoami, { mcp_account: 'bob@example.test' }))).toContain('token:at-bob')
    expect(JSON.stringify(await run(whoami, { mcp_account: 'alice@example.test' }))).toContain('token:at-alice')
    await expect(run(whoami, {})).rejects.toThrow(
      'Choose an account of "Protected": alice@example.test, bob@example.test.'
    )
    await expect(run(whoami, { mcp_account: 'carol@example.test' })).rejects.toThrow('Choose an account of')

    const call = tools.mcp_call
    expect(call.description).toContain('Protected: alice@example.test, bob@example.test')
    await expect(run(call, { server: 'Protected', tool: 'whoami' })).rejects.toThrow('Choose an account of')
    expect(
      JSON.stringify(await run(call, { server: 'Protected', tool: 'whoami', account: 'bob@example.test' }))
    ).toContain('token:at-bob')
  })

  it('uses the only account a conversation has without asking, by scope or by turning one off', async () => {
    const { server, alice, bob } = await twoAccounts()
    const w1 = makeWorkspace()
    const project = makeConversation(w1.id)
    const standalone = makeStandaloneConversation()
    expect(patchMcpOAuthAccount(server.id, bob, { scope: { kind: 'projects', workspaceIds: [w1.id] } })).toEqual({
      ok: true,
    })

    // Bob serves only the project: a standalone chat sees Alice alone, with no account to choose.
    const lone = await surface(standalone.id)
    expect(lone.whoami.inputSchema.jsonSchema.properties?.mcp_account).toBeUndefined()
    expect(JSON.stringify(await run(lone.whoami, {}))).toContain('token:at-alice')
    expect(fleetChatGetConvTools(standalone.id).mcpAccounts).toEqual([])

    // The project chat has both, and lists them for the + menu.
    expect(fleetChatGetConvTools(project.id).mcpAccounts).toEqual([
      {
        serverId: server.id,
        serverName: 'Protected',
        accounts: [
          { id: alice, label: 'alice@example.test', enabled: true },
          { id: bob, label: 'bob@example.test', enabled: true },
        ],
      },
    ])
    expect((await surface(project.id)).whoami.inputSchema.jsonSchema.properties.mcp_account).toBeDefined()

    // Turning Bob off in the project chat leaves Alice alone again.
    fleetChatSetConvTools(project.id, { mcpAccountsDisabled: [`${server.id}#${bob}`, 'not-an-account'] })
    expect(fleetChatGetConvTools(project.id).mcpAccounts?.[0].accounts).toEqual([
      { id: alice, label: 'alice@example.test', enabled: true },
      { id: bob, label: 'bob@example.test', enabled: false },
    ])
    const narrowed = await surface(project.id)
    expect(narrowed.whoami.inputSchema.jsonSchema.properties?.mcp_account).toBeUndefined()
    expect(JSON.stringify(await run(narrowed.whoami, {}))).toContain('token:at-alice')
  })
})
