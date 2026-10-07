/**
 * Lifecycle of the bots a bot server runs in this computer's projects, driven through the host the desktop bridge calls.
 *
 * The local relay and the SQLite store are the real ones. Only the native chat runtime and the model catalog are
 * stubbed: starting a turn needs an account and a repository, and none of that is what this suite is about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  broadcast: vi.fn(),
  capabilities: [
    { providerId: 'grok', providerLabel: 'Grok', modelId: 'grok-4', reasoningEfforts: [], fastMode: false },
  ],
}))

vi.mock('../../src/main/window-ipc', () => ({ broadcast: h.broadcast }))
vi.mock('../../src/main/workspace-service', () => ({ renameConversation: vi.fn() }))
vi.mock('../../src/main/chat/service', () => ({
  listChatRunnerCapabilities: async () => h.capabilities,
  stopChatAndWait: async () => true,
}))
vi.mock('../../src/main/git-service', () => ({
  listBranches: async () => ({ local: ['main'], remoteRefs: [] }),
  createWorktree: async () => ({}),
  listWorktrees: async () => [],
}))
// The native runtime is never reached here; a bot turn has its own suites.
vi.mock('../../src/main/bot/native-host', () => ({
  NativeBotChatHost: class {
    async configure(): Promise<void> {}
    async start(): Promise<never> {
      throw new Error('The native chat runtime is not part of this suite.')
    }
  },
}))

import { BotHost } from '../../src/main/bot/host'
import { BotModelCatalog } from '../../src/main/bot/catalog'
import { localBotService } from '../../src/main/bot/local-service'
import { deleteWorkspace, getConversation, getDb } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

let host: BotHost

beforeEach(() => {
  vi.clearAllMocks()
  freshDb()
  host = new BotHost()
})

afterEach(async () => {
  await host.dispose()
  closeDb()
})

/** The approval modes this desktop actually published to a bot, read back from its saved inventory. */
const published = (connectionId: string): string[] => {
  const row = getDb()
    .prepare('SELECT payload FROM bot_local_inventory WHERE connection_id=?')
    .get(connectionId) as unknown as { payload: string } | undefined
  const inventory = JSON.parse(row?.payload ?? '{"selections":[]}') as {
    selections: Array<{ permissionModes: string[] }>
  }
  return [...new Set(inventory.selections.flatMap((selection) => selection.permissionModes))]
}

/** Marks a conversation as one a bot created through this connection. */
function ownedByBot(conversationId: string, connectionId: string, botName: string): void {
  getDb()
    .prepare("UPDATE conversations SET bot_origin=?,bot_management_state='active' WHERE id=?")
    .run(JSON.stringify({ kind: 'bot', connectionId, botName }), conversationId)
}

describe('fleet bot connections', () => {
  const prefix = 'fleet:device-a:scout:'
  const grant = (workspaceIds: string[], patch: Record<string, unknown> = {}) => ({
    name: 'Scout',
    workspaceIds,
    actions: ['chats:read' as const, 'chats:write' as const],
    providerIds: ['grok'],
    selections: [{ providerId: 'grok', modelId: 'grok-4' }],
    permissionCeiling: 'auto' as const,
    ...patch,
  })

  it('gives a fleet bot the grants and catalog the person chose, and only its own', async () => {
    const workspace = makeWorkspace()
    const { connection, created } = await host.saveFleetConnection(prefix, grant([workspace.id]))
    expect(created).toBe(true)
    expect(connection).toMatchObject({ name: 'Scout', workspaceIds: [workspace.id], permissionCeiling: 'auto' })
    expect(connection.clientId.startsWith(prefix)).toBe(true)
    expect(published(connection.id)).toEqual(['ask', 'auto'])
    expect(
      await host.callFleetTool(connection.id, 'bot_list_workspaces', {}, new AbortController().signal)
    ).toMatchObject({ workspaces: [expect.objectContaining({ workspaceId: workspace.id })] })
    await expect(
      host.callFleetTool(
        connection.id,
        'bot_create_chat',
        {
          workspaceId: 'not-granted',
          name: 'x',
          baseBranch: 'main',
          selection: { selectionId: 'x' },
          idempotencyKey: 'k',
        },
        new AbortController().signal
      )
    ).rejects.toThrow(/grant/)
  })

  it('changes the same connection, pauses its chats in projects it lost, and revokes it', async () => {
    const kept = makeWorkspace()
    const lost = makeWorkspace()
    const { connection } = await host.saveFleetConnection(prefix, grant([kept.id, lost.id]))
    const conversation = makeConversation(lost.id)
    ownedByBot(conversation.id, connection.id, 'Scout')

    const changed = await host.saveFleetConnection(
      prefix,
      grant([kept.id], { permissionCeiling: 'ask', name: 'Scout 2' })
    )
    expect(changed.created).toBe(false)
    expect(changed.connection).toMatchObject({ id: connection.id, name: 'Scout 2', workspaceIds: [kept.id] })
    expect(published(connection.id)).toEqual(['ask'])
    expect(getConversation(conversation.id)?.botManagementState).toBe('paused')
    await expect(host.saveFleetConnection(prefix, grant(['missing']))).rejects.toThrow(/unavailable/)

    await host.revokeFleetConnection(connection.id)
    expect(host.fleetConnections(prefix)[0].revokedAt).not.toBeNull()
    expect(getConversation(conversation.id)?.botManagementState).toBe('revoked')
    expect(() => host.fleetConnections('grok')).toThrow(/prefix/)
  })

  it('offers a bot only the approval modes the person allowed it, and refuses anything past them', async () => {
    const workspace = makeWorkspace()
    const { connection } = await host.saveFleetConnection(prefix, grant([workspace.id]))
    expect(published(connection.id)).toEqual(['ask', 'auto'])

    // Up to the ceiling is the bot's to ask for; anything past it is refused with the owner's gate.
    const catalog = new BotModelCatalog(['grok'], undefined, 'auto')
    const selectionId = (await catalog.selections())[0]!.selectionId
    expect(await catalog.resolve({ selectionId, permissionMode: 'auto' })).toMatchObject({ permissionMode: 'auto' })
    // Asking for nothing runs at the ceiling: what the person allowed is what applies.
    expect(await catalog.resolve({ selectionId })).toMatchObject({ permissionMode: 'auto' })
    await expect(catalog.resolve({ selectionId, permissionMode: 'full' })).rejects.toThrow(/owner approval/i)

    // Moving the ceiling republishes what a bot may ask for; a bot never moves it itself.
    await host.saveFleetConnection(prefix, grant([workspace.id], { permissionCeiling: 'full' }))
    expect(published(connection.id)).toEqual(['ask', 'auto', 'full'])
  })

  it('refuses a connection that does not belong to a bot server', async () => {
    const workspace = makeWorkspace()
    const own = localBotService.createConnection({ name: 'Own', workspaceIds: [workspace.id], providerIds: ['grok'] })
    await expect(host.revokeFleetConnection(own.id)).rejects.toThrow(/fleet bot/)
    await expect(host.callFleetTool(own.id, 'bot_list_workspaces', {}, new AbortController().signal)).rejects.toThrow(
      /fleet bot/
    )
  })
})

describe('restoring at startup', () => {
  const prefix = 'fleet:device-a:scout:'
  const grant = (workspaceIds: string[]) => ({
    name: 'Scout',
    workspaceIds,
    actions: ['chats:read' as const],
    providerIds: ['grok'],
    selections: [{ providerId: 'grok', modelId: 'grok-4' }],
    permissionCeiling: 'ask' as const,
  })

  it('keeps the access of a fleet bot and stops offering a project that left this computer', async () => {
    const kept = makeWorkspace()
    const gone = makeWorkspace()
    const { connection } = await host.saveFleetConnection(prefix, grant([kept.id, gone.id]))
    await host.stop()
    deleteWorkspace(gone.id)

    const restarted = new BotHost()
    try {
      await restarted.restore()
      expect(restarted.fleetConnections(prefix)).toEqual([
        expect.objectContaining({ id: connection.id, workspaceIds: [kept.id], revokedAt: null }),
      ])
    } finally {
      await restarted.dispose()
    }
  })

  it('revokes a connection left from the endpoint personal bots used to reach, and gives its chats back', async () => {
    const workspace = makeWorkspace()
    const left = localBotService.createConnection({
      name: 'Personal bot',
      workspaceIds: [workspace.id],
      providerIds: ['grok'],
    })
    const conversation = makeConversation(workspace.id)
    ownedByBot(conversation.id, left.id, 'Personal bot')

    await host.restore()

    expect(localBotService.connection(left.id)?.revokedAt).not.toBeNull()
    expect(getConversation(conversation.id)?.botManagementState).toBe('revoked')
  })
})
