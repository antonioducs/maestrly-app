import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import { bindChatConversation } from '../../src/main/platform/project-chat-store'
import { registerProjectChatBoardTools, registerProjectChatContext } from '../../src/main/platform/project-chat-context'
import type { McpToolContext } from '../../src/main/mcp/tools/context'
beforeEach(freshDb)
afterEach(() => {
  vi.unstubAllGlobals()
  closeDb()
})
it('never falls back to operator credentials after a remote turn ends', async () => {
  const conv = makeConversation(makeWorkspace().id),
    callbacks = new Map<string, (input: unknown, extra: unknown) => Promise<any>>()
  bindChatConversation('instance', 'session', conv.id)
  const ctx = {
    convId: conv.id,
    server: { registerTool: (name: string, _schema: unknown, fn: any) => callbacks.set(name, fn) },
  } as unknown as McpToolContext
  expect(registerProjectChatBoardTools(ctx)).toBe(true)
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ items: [] })))
  vi.stubGlobal('fetch', fetch)
  expect((await callbacks.get('board_search_cards')!({}, {})).isError).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
  const release = registerProjectChatContext(conv.id, {
    url: 'https://fixture.test',
    organizationId: 'org',
    projectId: 'project',
    sessionId: 'session',
    turnId: 'turn',
    token: 'scoped-token',
  })
  await callbacks.get('board_search_cards')!({ done: true }, { requestId: 'tool-call' })
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    headers: expect.objectContaining({ authorization: 'Chat scoped-token' }),
  })
  release()
  expect((await callbacks.get('board_search_cards')!({}, {})).isError).toBe(true)
})
