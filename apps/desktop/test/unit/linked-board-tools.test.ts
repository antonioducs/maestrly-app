import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import { insertConversation, patchConvUiPrefs } from '../../src/main/store'
import { platformProjectBindings } from '../../src/main/platform/project-bindings'
import { createLinkedBoardAccess, linkedConversationBinding } from '../../src/main/platform/linked-board'
import { registerBoardTools } from '../../src/main/mcp/tools/board'
import { createChatGptWebBridge } from '../../src/main/chat/chatgpt-web/bridge-server'
import { createBridgeRouter } from '../../src/main/chat/chatgpt-web/bridge-router'
import { bindChatConversation } from '../../src/main/platform/project-chat-store'
import { buildProjectContext } from '../../src/main/chat/project-context'
import type { McpToolContext } from '../../src/main/mcp/tools/context'

const h = vi.hoisted(() => ({
  userId: 'operator',
  token: vi.fn(async () => 'renewed-token'),
}))
vi.mock('../../src/main/platform/connection-service', () => ({
  platformConnections: {
    list: () => [{ id: 'connection', url: 'https://kanban.test', state: 'connected', identity: { userId: h.userId } }],
    authenticatedToken: h.token,
  },
}))
beforeEach(() => {
  freshDb()
  h.userId = 'operator'
  h.token.mockReset().mockResolvedValue('renewed-token')
})
afterEach(() => {
  vi.unstubAllGlobals()
  closeDb()
})
function fixture() {
  const workspace = makeWorkspace(),
    conversation = makeConversation(workspace.id)
  const binding = {
    workspaceId: workspace.id,
    connectionId: 'connection',
    organizationId: randomUUID(),
    projectId: randomUUID(),
    boardId: randomUUID(),
    projectName: 'Linked project',
  }
  platformProjectBindings.set(binding)
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
  )
  vi.stubGlobal('fetch', fetch)
  return { workspace, conversation, binding, fetch }
}

it('does not inherit a project binding in a standalone chat', async () => {
  const f = fixture()
  const id = randomUUID()
  insertConversation({
    id,
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    name: 'Chat',
    cwd: '/private/chat',
    status: 'idle',
    createdAt: 1,
    lastActivityAt: 1,
    archived: 0,
    pinnedAt: null,
  })
  expect(linkedConversationBinding(id)).toBeNull()
  await expect(createLinkedBoardAccess(id).call('board_list_cards', {})).rejects.toThrow('project-required')
  expect(f.fetch).not.toHaveBeenCalled()
  expect(h.token).not.toHaveBeenCalled()
})

it('exposes complete typed tools through real MCP for every workspace worktree', async () => {
  const f = fixture(),
    other = makeConversation(f.workspace.id, { cwd: '/elsewhere/worktree' })
  const access = createLinkedBoardAccess(other.id)
  expect(access.context()).toMatchObject({ projectId: f.binding.projectId, boardId: f.binding.boardId })
  expect(await buildProjectContext(f.workspace.id, other.cwd)).toContain(f.binding.projectId)
  const server = new McpServer({ name: 'linked-board-test', version: '1' })
  registerBoardTools({ server, convId: other.id } as McpToolContext)
  const client = new Client({ name: 'test', version: '1' }),
    [left, right] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(left)
    await client.connect(right)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_linked_kanban', 'board_create_card', 'board_manage_columns', 'board_card_lifecycle'])
    )
    const cardId = randomUUID()
    await client.callTool({
      name: 'board_update_card',
      arguments: { cardId, expectedVersion: 7, priority: 'high', idempotencyKey: 'stable-call' },
    })
    expect(f.fetch).toHaveBeenCalledOnce()
    const [url, options] = f.fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain(`/projects/${f.binding.projectId}/board-tools`)
    expect(options.headers).toMatchObject({
      authorization: 'Bearer renewed-token',
      'idempotency-key': 'stable-call',
      'x-maestrly-conversation-id': other.id,
    })
    expect(JSON.parse(options.body as string)).toEqual({
      name: 'board_update_card',
      input: { cardId, expectedVersion: 7, priority: 'high' },
    })
    expect(
      (await client.callTool({ name: 'board_update_card', arguments: { cardId, title: 'missing version' } })).isError
    ).toBe(true)
    expect(f.fetch).toHaveBeenCalledOnce()
  } finally {
    await client.close()
    await server.close()
  }
})

it('uses the effective Maestro behavior for a delegate even when the last standard mode was Ask', async () => {
  const f = fixture()
  const maestro = makeConversation(f.workspace.id, { experience: 'maestro', uiPrefs: { chat: { mode: 'ask' } } })
  const access = createLinkedBoardAccess(maestro.id)
  await expect(
    access.call('board_create_card', {
      boardId: f.binding.boardId,
      title: 'Delegated work',
      idempotencyKey: 'delegate-1',
    })
  ).resolves.toEqual({ ok: true })
  expect(f.fetch).toHaveBeenCalledOnce()
})

it('revokes a captured tool on unlink, relink, account change and read-only modes', async () => {
  const f = fixture(),
    access = createLinkedBoardAccess(f.conversation.id)
  const input = { boardId: f.binding.boardId, title: 'card', idempotencyKey: 'create-once' }
  patchConvUiPrefs(f.conversation.id, { chat: { mode: 'ask' } })
  await expect(access.call('board_create_card', input)).rejects.toThrow(/read-only/)
  patchConvUiPrefs(f.conversation.id, { chat: { mode: 'agent' } })
  h.userId = 'different-account'
  await expect(access.call('board_create_card', input)).rejects.toThrow(/link changed/)
  h.userId = 'operator'
  platformProjectBindings.set({ ...f.binding, projectId: randomUUID() })
  await expect(access.call('board_list_cards', {})).rejects.toThrow(/link changed/)
  platformProjectBindings.remove(f.workspace.id)
  await expect(access.call('board_list_cards', {})).rejects.toThrow(/Link this workspace/)
  platformProjectBindings.set(f.binding)
  await expect(access.call('board_list_cards', {})).rejects.toThrow(/link changed/)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('rechecks the link after asynchronous credential renewal and isolates remote-managed chats', async () => {
  const f = fixture(),
    access = createLinkedBoardAccess(f.conversation.id)
  h.token.mockImplementationOnce(async () => {
    platformProjectBindings.remove(f.workspace.id)
    return 'refreshed'
  })
  await expect(access.call('board_list_cards', {})).rejects.toThrow(/Link this workspace/)
  platformProjectBindings.set(f.binding)
  bindChatConversation('instance', 'session', f.conversation.id)
  await expect(createLinkedBoardAccess(f.conversation.id).call('board_list_cards', {})).rejects.toThrow(
    /Link this workspace/
  )
  expect(f.fetch).not.toHaveBeenCalled()
})

it('routes GPT Web Kanban tools only to the paired session with explicit write access', async () => {
  const f = fixture(),
    router = createBridgeRouter(),
    events: unknown[] = []
  const key = 'a'.repeat(32)
  router.register(
    key,
    createChatGptWebBridge({ cwd: process.cwd(), kanban: createLinkedBoardAccess(f.conversation.id, 'read') })
  )
  const args = { boardId: f.binding.boardId, title: 'Private content', idempotencyKey: 'create-once' }
  const call = (session_key: string) =>
    router.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'board_create_card', arguments: { ...args, session_key } },
    }) as Promise<any>
  expect((await call('wrong-key')).result.isError).toBe(true)
  expect((await call(key)).result.isError).toBe(true)
  expect(f.fetch).not.toHaveBeenCalled()
  router.unregister(key)
  router.register(
    key,
    createChatGptWebBridge({
      cwd: process.cwd(),
      kanban: createLinkedBoardAccess(f.conversation.id, 'write'),
      onEvent: (event) => events.push(event),
    })
  )
  expect((await call(key)).result.isError).not.toBe(true)
  expect(f.fetch).toHaveBeenCalledOnce()
  expect(JSON.stringify(events)).not.toContain('Private content')
  router.unregister(key)
  expect((await call(key)).result.isError).toBe(true)
})
