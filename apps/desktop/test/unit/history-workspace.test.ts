import { randomUUID } from 'node:crypto'
import { FLEET_BOT_ENV } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeStandaloneConversation, makeWorkspace } from '../helpers/factories'
import { getDb } from '../../src/main/store'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { forgetHistoryIndexState } from '../../src/main/chat/history-index/store'
import { registerHistoryTools } from '../../src/main/mcp/tools/history'
import type { McpToolContext } from '../../src/main/mcp/tools/context'
import type { MaestroWorkerScope } from '../../src/main/maestro-worker-scope'

beforeEach(() => {
  forgetHistoryIndexState()
  freshDb()
})
afterEach(() => {
  vi.unstubAllEnvs()
  closeDb()
})

function say(conversationId: string, text: string, extra: object = {}): void {
  upsertChatMessage({
    id: randomUUID(),
    conversationId,
    role: 'user',
    createdAt: Date.now(),
    parts: [{ type: 'text', id: randomUUID(), text }],
    ...extra,
  })
}

function tools(conversationId: string, workerScope?: MaestroWorkerScope) {
  const handlers = new Map<
    string,
    (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  >()
  registerHistoryTools({
    convId: conversationId,
    locale: 'en',
    t: (key: string) => key,
    workerScope,
    server: { registerTool: (name: string, _schema: unknown, handler: never) => handlers.set(name, handler) },
  } as unknown as McpToolContext)
  const call = async (name: string, args: Record<string, unknown>) => {
    const out = await handlers.get(name)!(args)
    return { error: out.isError === true, text: out.content[0].text }
  }
  return {
    search: async (args: Record<string, unknown>) => {
      const out = await call('history_search', args)
      return out.error ? { error: out.text } : JSON.parse(out.text)
    },
    read: (args: Record<string, unknown>) => call('history_read', args),
  }
}

function fixture() {
  const workspace = makeWorkspace()
  const caller = makeConversation(workspace.id, { name: 'caller', lastActivityAt: 3 })
  const sibling = makeConversation(workspace.id, { name: 'sibling', lastActivityAt: 2, archived: 1 })
  const bot = makeConversation(workspace.id, { name: 'bot', lastActivityAt: 1 })
  getDb()
    .prepare('UPDATE conversations SET bot_origin = ? WHERE id = ?')
    .run(JSON.stringify({ kind: 'bot', connectionId: 'c', botName: 'Bot' }), bot.id)
  const elsewhere = makeConversation(makeWorkspace().id, { name: 'elsewhere' })
  const standalone = makeStandaloneConversation({ name: 'standalone' })
  for (const conversation of [caller, sibling, bot, elsewhere, standalone])
    say(conversation.id, `migration plan from ${conversation.name}`)
  say(sibling.id, 'isolated migration round', {
    executionScope: { kind: 'review-loop', executionId: 'e', loopId: 'l', iteration: 1, maxIterations: 2 },
  })
  return { workspace, caller, sibling, bot, elsewhere, standalone }
}

describe('workspace history scope', () => {
  it('searches the project conversations of the workspace, archived included, and names them', async () => {
    const { caller, sibling } = fixture()
    const out = await tools(caller.id).search({ query: 'migration plan', scope: 'workspace' })
    expect(out.scope).toBe('workspace')
    expect(out.results.map((hit: { conversation: string }) => hit.conversation).sort()).toEqual(['caller', 'sibling'])
    const fromSibling = out.results.find((hit: { conversationId: string }) => hit.conversationId === sibling.id)
    expect(fromSibling.snippet).toBe('migration plan from sibling')
    expect(JSON.stringify(out)).not.toContain('isolated')
  })

  it('keeps the default scope to the calling conversation', async () => {
    const { caller } = fixture()
    const out = await tools(caller.id).search({ query: 'migration plan' })
    expect(out.results).toHaveLength(1)
    expect(out.results[0].conversationId).toBeUndefined()
  })

  it('lists the workspace conversations when browsing without a query', async () => {
    const { caller } = fixture()
    const out = await tools(caller.id).search({ scope: 'workspace' })
    expect(out.mode).toBe('browse')
    expect(out.results.map((row: { conversation: string }) => row.conversation)).toEqual(['caller', 'sibling'])
    expect(out.results[1]).toMatchObject({ archived: true, snippet: 'migration plan from sibling' })
  })

  it('limits each conversation to three hits', async () => {
    const workspace = makeWorkspace()
    const caller = makeConversation(workspace.id)
    const busy = makeConversation(workspace.id)
    for (let index = 0; index < 6; index++) {
      say(busy.id, `deploy note ${index}`)
      say(busy.id, 'filler')
    }
    say(caller.id, 'deploy note here')
    const out = await tools(caller.id).search({ query: 'deploy note', scope: 'workspace', limit: 10 })
    const counts = new Map<string, number>()
    for (const hit of out.results) counts.set(hit.conversationId, (counts.get(hit.conversationId) ?? 0) + 1)
    expect(counts.get(busy.id)).toBe(3)
    expect(counts.get(caller.id)).toBe(1)
  })

  it('refuses the workspace scope to standalone chats, bot conversations, delegated workers and bot runtimes', async () => {
    const { caller, bot, standalone } = fixture()
    for (const denied of [tools(standalone.id), tools(bot.id), tools(caller.id, { id: 'w' } as MaestroWorkerScope)]) {
      expect(await denied.search({ query: 'migration', scope: 'workspace' })).toEqual({
        error: 'returns.history.workspaceDenied',
      })
    }
    vi.stubEnv(FLEET_BOT_ENV.mode, '1')
    expect(await tools(caller.id).search({ query: 'migration', scope: 'workspace' })).toEqual({
      error: 'returns.history.workspaceDenied',
    })
  })

  it('reads another conversation only when the workspace scope would reach it', async () => {
    const { caller, sibling, bot, elsewhere, standalone } = fixture()
    const [hit] = (await tools(caller.id).search({ query: 'from sibling', scope: 'workspace' })).results
    const read = await tools(caller.id).read({ seq: hit.seq, conversationId: sibling.id })
    expect(read.error).toBe(false)
    expect(read.text).toContain('migration plan from sibling')
    for (const target of [bot, elsewhere, standalone]) {
      expect(await tools(caller.id).read({ seq: 0, conversationId: target.id })).toEqual({
        error: true,
        text: 'returns.history.conversationDenied',
      })
    }
    expect((await tools(standalone.id).read({ seq: 0, conversationId: caller.id })).error).toBe(true)
    expect(
      (await tools(caller.id, { id: 'w' } as MaestroWorkerScope).read({ seq: 0, conversationId: sibling.id })).error
    ).toBe(true)
    expect((await tools(standalone.id).read({ seq: 0, conversationId: standalone.id })).error).toBe(false)
  })
})
