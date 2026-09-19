import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getConversation: vi.fn(), listPages: vi.fn(), writePage: vi.fn() }))
vi.mock('../../src/main/store', () => ({ getConversation: h.getConversation }))
vi.mock('../../src/main/notes/notes-service', () => ({
  listPages: h.listPages,
  writePage: h.writePage,
  createPage: vi.fn(),
  readPage: vi.fn(),
  appendPage: vi.fn(),
  deletePage: vi.fn(),
}))

import { registerProjectNotesTools } from '../../src/main/mcp/tools/notes'
import { registerMemoryTools } from '../../src/main/mcp/tools/memory'
import type { McpToolContext } from '../../src/main/mcp/tools/context'

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean }>

function context() {
  const handlers = new Map<string, Handler>()
  const ctx = {
    convId: 'chat',
    locale: 'en',
    t: (key: string) => key,
    server: { registerTool: (name: string, _schema: unknown, handler: Handler) => handlers.set(name, handler) },
  } as unknown as McpToolContext
  return { ctx, handlers }
}

beforeEach(() => vi.clearAllMocks())

describe('standalone project tool admission', () => {
  it('does not register project notes or project memory directly', () => {
    h.getConversation.mockReturnValue({ scope: 'standalone', workspaceId: null })
    const { ctx, handlers } = context()
    registerProjectNotesTools(ctx)
    registerMemoryTools(ctx)
    expect(handlers.size).toBe(0)
  })

  it('rechecks scope when a previously registered project notes handler is called', async () => {
    h.getConversation.mockReturnValue({ scope: 'project', workspaceId: 'workspace' })
    const { ctx, handlers } = context()
    registerProjectNotesTools(ctx)
    h.getConversation.mockReturnValue({ scope: 'standalone', workspaceId: null })
    for (const handler of handlers.values()) {
      expect(await handler({ pageId: 'page', content: 'forged', title: 'forged', text: 'forged' })).toMatchObject({
        isError: true,
      })
    }
    expect(h.listPages).not.toHaveBeenCalled()
    expect(h.writePage).not.toHaveBeenCalled()
  })

  it('rechecks project identity in previously registered memory handlers', async () => {
    h.getConversation.mockReturnValue({ scope: 'project', workspaceId: 'workspace' })
    const { ctx, handlers } = context()
    registerMemoryTools(ctx)
    h.getConversation.mockReturnValue({ scope: 'standalone', workspaceId: null })
    expect(await handlers.get('memory_search')!({ query: 'forged' })).toMatchObject({ isError: true })
  })
})
