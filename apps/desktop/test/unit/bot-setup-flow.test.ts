import { describe, expect, it, vi } from 'vitest'
import { approveRequestWithNewBot, type BotSetupDraft } from '../../src/renderer/components/bot/setup-flow'
import type { BotConnectionView, BotSettingsView } from '../../src/shared/bot'

/**
 * Setting a bot up from the request that asked for it (#bots).
 *
 * The connection is minted for one waiting request and the approval names it. These suites hold the two
 * steps together: an expired request is never approved with someone else's setup, and a failed approval
 * is retried with the bot that already exists instead of connecting a second one.
 */
const messages = { requestGone: 'That request is no longer waiting.', createFailed: 'The bot was not identified.' }

const draft: BotSetupDraft = {
  requestId: 'request-1',
  name: '  Research bot  ',
  workspaceIds: ['workspace-1'],
  selections: [
    { providerId: 'provider-1', modelId: 'model-a' },
    { providerId: 'provider-1', modelId: 'model-b' },
  ],
  actions: ['chats:read', 'chats:write'],
  permissionCeiling: 'auto',
}

function connection(id: string, legacy = false): BotConnectionView {
  return {
    id,
    name: id,
    clientId: `${id}-client`,
    desktopId: 'desktop-1',
    workspaceIds: ['workspace-1'],
    revokedAt: null,
    mcpConfig: '{}',
    actions: ['chats:read'],
    permissionCeiling: 'ask',
    legacy,
  }
}

function view(connections: BotConnectionView[], waiting: string[]): BotSettingsView {
  return {
    connections,
    server: { enabled: true, host: '127.0.0.1', port: 14_310, publicUrl: 'https://bot.example', state: 'listening' },
    pendingAuthorizations: waiting.map((id) => ({
      id,
      clientName: 'Research bot',
      redirectUri: 'https://bot.example/callback',
    })),
    state: 'connected',
  }
}

describe('bot setup from an incoming request', () => {
  it('creates the bot the request asked for and approves that same request', async () => {
    const existing = connection('relay-era', true)
    const api = {
      settings: vi.fn(async () => view([existing], ['request-1', 'request-2'])),
      connect: vi.fn(async () => view([existing, connection('bot-1'), connection('relay-era-2', true)], ['request-1'])),
      authorize: vi.fn(async () => view([existing, connection('bot-1')], [])),
    }
    const created: string[] = []
    const outcome = await approveRequestWithNewBot({
      api,
      draft,
      messages,
      onCreated: (id) => created.push(id),
    })

    expect(api.connect).toHaveBeenCalledTimes(1)
    expect(api.connect).toHaveBeenCalledWith({
      name: 'Research bot',
      workspaceIds: ['workspace-1'],
      providerIds: ['provider-1'],
      selections: draft.selections,
      actions: ['chats:read', 'chats:write'],
      // How far the bot may go is decided with the rest of its access, in the same approval.
      permissionCeiling: 'auto',
    })
    expect(api.authorize).toHaveBeenCalledWith('request-1', true, 'bot-1')
    expect(created).toEqual(['bot-1'])
    expect(outcome.connectionId).toBe('bot-1')
    expect(outcome.view.pendingAuthorizations).toEqual([])
  })

  it('retries a failed approval with the bot already created, never connecting a second one', async () => {
    const api = {
      settings: vi.fn(async () => view([], ['request-1'])),
      connect: vi.fn(async () => view([connection('bot-1')], ['request-1'])),
      authorize: vi.fn(async (): Promise<BotSettingsView> => {
        throw new Error('This authorization request is no longer waiting for an answer.')
      }),
    }
    const created: string[] = []
    await expect(
      approveRequestWithNewBot({ api, draft, messages, onCreated: (id) => created.push(id) })
    ).rejects.toThrow(/no longer waiting for an answer/)
    expect(created).toEqual(['bot-1'])

    api.authorize.mockImplementation(async () => view([connection('bot-1')], []))
    const retry = await approveRequestWithNewBot({ api, draft, messages, createdConnectionId: created[0] })

    expect(api.connect).toHaveBeenCalledTimes(1)
    expect(api.authorize).toHaveBeenNthCalledWith(2, 'request-1', true, 'bot-1')
    expect(retry.connectionId).toBe('bot-1')
  })

  it('approves nothing, and creates nothing, once the request stopped waiting', async () => {
    const api = {
      settings: vi.fn(async () => view([connection('bot-1')], ['request-2'])),
      connect: vi.fn(async () => view([], [])),
      authorize: vi.fn(async () => view([], [])),
    }
    await expect(approveRequestWithNewBot({ api, draft, messages })).rejects.toThrow(messages.requestGone)
    expect(api.connect).not.toHaveBeenCalled()
    expect(api.authorize).not.toHaveBeenCalled()
  })

  it('refuses to approve a connection it cannot identify', async () => {
    const api = {
      settings: vi.fn(async () => view([connection('bot-1')], ['request-1'])),
      // A view that grew no new connection: approving would have to guess which bot was meant.
      connect: vi.fn(async () => view([connection('bot-1'), connection('relay-era', true)], ['request-1'])),
      authorize: vi.fn(async () => view([], [])),
    }
    await expect(approveRequestWithNewBot({ api, draft, messages })).rejects.toThrow(messages.createFailed)
    expect(api.authorize).not.toHaveBeenCalled()
  })
})
