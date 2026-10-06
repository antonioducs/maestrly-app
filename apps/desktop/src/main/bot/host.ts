import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { BotActionName, BotPermissionCeiling } from '../../shared/bot'
import { getAppSetting, setAppSetting, getConversation, getWorkspace, listAllConversations } from '../store'
import { broadcast } from '../window-ipc'
import { renameConversation } from '../workspace-service'
import { BotModelCatalog } from './catalog'
import { NativeBotChatHost } from './native-host'
import { BotConversationWorker } from './worker'
import { createBotConversation, resumeBotConversation } from './conversation-service'
import { findBotConversation, getBotConversationBinding, setBotManagementState, setBotManualChatEnabled } from './store'
import { observeBotPauses, pauseBotForHuman } from './control'
import { BOT_LOCAL_INSTANCE_ID, localBotService, type BotLocalConnection } from './local-service'
import { LocalBotTransport } from './local-transport'

/**
 * The bots of a bot server that work in this computer's projects.
 *
 * The local service keeps the chats and their commands, and the existing conversation worker runs them against the
 * native chat runtime. Nothing here listens on a port: a bot's calls arrive through the desktop bridge, on the event
 * stream this computer opened to its bot server, and a bot gets access only from the person at this computer.
 */
const PENDING_PAUSES_KEY = 'bot.pending-pauses.v1'
/**
 * Client ids of the connections a fleet bot holds here start with this. They reach this computer through the bot
 * server this computer paired with, and are managed from that bot's settings.
 */
export const FLEET_BOT_CLIENT_PREFIX = 'fleet:'
const isFleetConnection = (connection: { clientId: string }) => connection.clientId.startsWith(FLEET_BOT_CLIENT_PREFIX)

/** What a person grants a fleet bot on this computer: projects, models, actions and an approval ceiling. */
export interface FleetBotGrantInput {
  name: string
  workspaceIds: string[]
  actions: BotActionName[]
  providerIds: string[]
  selections: Array<{ providerId: string; modelId: string }>
  permissionCeiling: BotPermissionCeiling
}

interface RunningBot {
  worker: BotConversationWorker
  timer: ReturnType<typeof setInterval>
  loop: Promise<void>
}

export class BotHost {
  private readonly service = localBotService
  private readonly running = new Map<string, RunningBot>()
  private readonly starting = new Map<string, Promise<void>>()
  private restoring = false
  private stopped = false
  private flushingPauses: Promise<void> | null = null
  private readonly pauseUnsubscribe: () => void

  constructor() {
    this.pauseUnsubscribe = observeBotPauses((conversationId) => {
      for (const active of this.running.values()) active.worker.interrupt(conversationId)
      const pending = this.pendingPauses()
      if (!pending.includes(conversationId))
        setAppSetting(PENDING_PAUSES_KEY, JSON.stringify([...pending, conversationId]))
      void this.flushPauses().catch((error) => this.report(error))
    })
  }

  /** The connections fleet bots hold here under a client id prefix (one bot server pairing, one bot), revoked included. */
  fleetConnections(prefix: string): BotLocalConnection[] {
    if (!prefix.startsWith(FLEET_BOT_CLIENT_PREFIX)) throw new Error('Not a fleet bot connection prefix.')
    return this.service.connectionsByClientPrefix(prefix)
  }

  /**
   * Gives a fleet bot access to projects on this computer, or changes what it has. Only the person at this computer
   * calls it, from that bot's settings. A narrowed grant pauses the bot's chats in the projects it lost.
   */
  async saveFleetConnection(
    prefix: string,
    input: FleetBotGrantInput
  ): Promise<{ connection: BotLocalConnection; created: boolean }> {
    if (!prefix.startsWith(FLEET_BOT_CLIENT_PREFIX)) throw new Error('Not a fleet bot connection prefix.')
    for (const workspaceId of input.workspaceIds)
      if (!getWorkspace(workspaceId)) throw new Error('A selected local project is unavailable.')
    const catalog = new BotModelCatalog(input.providerIds, input.selections, input.permissionCeiling)
    const inventory = await catalog.inventory(input.workspaceIds)
    if (!inventory.selections.length) throw new Error('Connect and select an available model account for this bot.')
    if (inventory.selections.length !== input.selections.length)
      throw new Error('One of the selected account/model pairs is no longer available.')
    if (inventory.workspaces.length !== input.workspaceIds.length)
      throw new Error('A selected local repository is unavailable.')
    this.stopped = false
    const active = this.fleetConnections(prefix).find((connection) => !connection.revokedAt)
    if (!active) {
      const connection = this.service.createConnection({
        name: input.name,
        clientId: prefix + randomUUID(),
        workspaceIds: input.workspaceIds,
        providerIds: input.providerIds,
        actions: input.actions,
        selections: input.selections,
        permissionCeiling: input.permissionCeiling,
      })
      this.service.saveInventory(connection.id, inventory)
      try {
        await this.start(connection)
      } catch (error) {
        // The connection is saved: only its worker failed to start, and the next start retries it.
        this.report(error)
      }
      return { connection, created: true }
    }
    await this.stopBot(active.id)
    try {
      this.service.setGrants(active.id, input.workspaceIds, input.actions)
      this.service.setPermissionCeiling(active.id, input.permissionCeiling)
      const next = this.service.updateConnection(active.id, {
        name: input.name,
        providerIds: input.providerIds,
        selections: input.selections,
      })
      this.service.saveInventory(next.id, inventory)
      this.pauseChatsOutside(next.id, input.workspaceIds)
      await this.flushPauses()
      return { connection: next, created: false }
    } finally {
      const current = this.service.connection(active.id)
      if (current && !current.revokedAt) await this.start(current)
    }
  }

  /** Takes a fleet bot's access back: its chats stay on this computer, revoked, and its worker stops. */
  async revokeFleetConnection(connectionId: string): Promise<void> {
    const connection = this.service.requireConnection(connectionId)
    if (!isFleetConnection(connection)) throw new Error('Not a fleet bot connection.')
    await this.stopBot(connection.id)
    this.markLocal(connection.id, 'revoked')
    this.service.revokeConnection(connection.id)
  }

  /** Runs one conversation tool for a fleet bot, under the grants of its connection here. */
  async callFleetTool(
    connectionId: string,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    const connection = this.service.requireConnection(connectionId)
    if (!isFleetConnection(connection)) throw new Error('Not a fleet bot connection.')
    return this.service.callTool(connection.id, name, input, signal)
  }

  /** The id this computer gives itself in what a bot reads; never sent anywhere else. */
  localDesktopId(): string {
    return this.service.desktopId()
  }

  async setManagement(conversationId: string, state: 'active' | 'paused'): Promise<void> {
    const conversation = getConversation(conversationId)
    if (!conversation?.botOrigin) throw new Error('This conversation is not managed by a bot.')
    const connection = this.service.connection(conversation.botOrigin.connectionId)
    if (state === 'paused') {
      pauseBotForHuman(conversationId)
      const { stopChatAndWait } = await import('../chat/service')
      if (!(await stopChatAndWait(conversationId))) throw new Error('The bot turn is still stopping.')
      await this.flushPauses()
      return
    }
    if (!connection || connection.revokedAt || conversation.botManagementState === 'revoked')
      throw new Error('A revoked bot cannot resume control.')
    if (!conversation.workspaceId || !connection.workspaceIds.includes(conversation.workspaceId))
      throw new Error('This project is not authorized for the bot.')
    const { stopChatAndWait } = await import('../chat/service')
    if (!(await stopChatAndWait(conversationId))) throw new Error('The current turn is still stopping.')
    await this.flushPauses()
    this.relayManagement(conversationId, 'active')
    setBotManagementState(conversationId, 'active')
    broadcast('conversation:open', { conversation: getConversation(conversationId), focus: false })
    await this.start(connection)
  }

  /**
   * Release this bot chat for the person's own messages, or close it again.
   *
   * Nothing about the bot moves: it keeps the chat, its worker stays as it is, and a turn already
   * running is untouched. Only what the person may write here changes.
   */
  setManualChat(conversationId: string, enabled: boolean): void {
    const conversation = getConversation(conversationId)
    if (!conversation?.botOrigin) throw new Error('This conversation is not managed by a bot.')
    setBotManualChatEnabled(conversationId, enabled)
    broadcast('conversation:open', { conversation: getConversation(conversationId), focus: false })
  }

  /**
   * Starts the worker of every fleet bot that still has access. A connection that does not belong to a bot server is
   * left over from the endpoint personal bots used to reach: it is revoked, and its chats stay as the person's own. A
   * project that left this computer stops being offered, and the bot's chats in it leave bot control.
   */
  async restore(): Promise<void> {
    if (this.restoring || this.stopped) return
    this.restoring = true
    try {
      await this.flushPauses()
      for (const connection of this.service.connections().filter((item) => !item.revokedAt)) {
        try {
          if (!isFleetConnection(connection)) await this.retire(connection)
          else await this.start(this.withoutMissingProjects(connection))
        } catch (error) {
          this.report(error)
        }
      }
      await this.flushPauses()
    } catch (error) {
      this.report(error)
    } finally {
      this.restoring = false
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.starting.values()])
    await Promise.allSettled([...this.running.keys()].map((id) => this.stopBot(id)))
  }

  async dispose(): Promise<void> {
    await this.stop()
    this.pauseUnsubscribe()
  }

  private async retire(connection: BotLocalConnection): Promise<void> {
    await this.stopBot(connection.id)
    this.markLocal(connection.id, 'revoked')
    this.service.revokeConnection(connection.id)
  }

  private withoutMissingProjects(connection: BotLocalConnection): BotLocalConnection {
    const available = connection.workspaceIds.filter((id) => getWorkspace(id))
    if (available.length === connection.workspaceIds.length) return connection
    const next = this.service.setGrants(connection.id, available)
    this.pauseChatsOutside(connection.id, available)
    return next
  }

  private pauseChatsOutside(connectionId: string, workspaceIds: string[]): void {
    for (const conversation of listAllConversations())
      if (
        conversation.botOrigin?.connectionId === connectionId &&
        conversation.workspaceId &&
        !workspaceIds.includes(conversation.workspaceId)
      )
        pauseBotForHuman(conversation.id)
  }

  private async start(connection: BotLocalConnection): Promise<void> {
    if (this.stopped || connection.revokedAt || this.running.has(connection.id)) return
    const existing = this.starting.get(connection.id)
    if (existing) return existing
    const start = this.startNew(connection).finally(() => this.starting.delete(connection.id))
    this.starting.set(connection.id, start)
    return start
  }

  private async startNew(connection: BotLocalConnection): Promise<void> {
    const client = new LocalBotTransport(this.service, connection.id)
    const catalog = new BotModelCatalog(
      connection.providerIds,
      connection.selections ?? undefined,
      connection.permissionCeiling
    )
    await client.inventory(await catalog.inventory(connection.workspaceIds))
    if (this.stopped) return
    const worker = new BotConversationWorker({
      instanceId: BOT_LOCAL_INSTANCE_ID,
      desktopId: connection.desktopId,
      ownerUserId: connection.ownerUserId,
      connectionId: connection.id,
      workspaceIds: connection.workspaceIds,
      client,
      native: new NativeBotChatHost(catalog),
      conversations: {
        create: createBotConversation,
        resume: resumeBotConversation,
        find: (identity, remoteId) => findBotConversation(identity, remoteId)?.conversationId ?? null,
        management: (id) => getConversation(id)?.botManagementState,
        setManagement: (id, state) => {
          setBotManagementState(id, state)
          broadcast('conversation:open', { conversation: getConversation(id), focus: false })
        },
        rename: renameConversation,
      },
    })
    let publishing = false
    const timer = setInterval(() => {
      const current = this.service.connection(connection.id)
      if (publishing || this.stopped || !current || current.revokedAt) return
      publishing = true
      void catalog
        .inventory(current.workspaceIds)
        .then((value) => client.inventory(value))
        .catch((error) => this.report(error))
        .finally(() => {
          publishing = false
        })
    }, 15_000)
    const loop = worker.run((error) => this.report(error))
    this.running.set(connection.id, { worker, timer, loop })
  }

  private async stopBot(id: string): Promise<void> {
    const starting = this.starting.get(id)
    if (starting) await starting.catch(() => {})
    const running = this.running.get(id)
    if (!running) return
    this.running.delete(id)
    clearInterval(running.timer)
    await running.worker.stop()
    await running.loop
  }

  /** Keeps the relay record of a chat in step with the local one the person just acted on. */
  private relayManagement(conversationId: string, state: 'active' | 'paused'): void {
    const binding = getBotConversationBinding(conversationId)
    if (!binding) throw new Error('The bot conversation binding is missing.')
    this.service.setManagement(binding.requestId, state)
  }

  private markLocal(connectionId: string, state: 'paused' | 'revoked'): void {
    for (const conversation of listAllConversations()) {
      if (conversation.botOrigin?.connectionId !== connectionId) continue
      setBotManagementState(conversation.id, state)
      broadcast('conversation:open', { conversation: getConversation(conversation.id), focus: false })
    }
  }

  private pendingPauses(): string[] {
    return z.array(z.string()).parse(JSON.parse(getAppSetting(PENDING_PAUSES_KEY) ?? '[]'))
  }

  private flushPauses(): Promise<void> {
    if (this.flushingPauses) return this.flushingPauses
    const work = this.flushPendingPauses().finally(() => {
      this.flushingPauses = null
    })
    this.flushingPauses = work
    return work
  }

  /** A pause is durable locally first; the relay record follows, and a missing one never blocks it. */
  private async flushPendingPauses(): Promise<void> {
    for (;;) {
      const conversationId = this.pendingPauses()[0]
      if (!conversationId) return
      const conversation = getConversation(conversationId)
      const binding = conversation?.botOrigin ? getBotConversationBinding(conversationId) : null
      if (binding) this.service.setManagement(binding.requestId, 'paused')
      setAppSetting(PENDING_PAUSES_KEY, JSON.stringify(this.pendingPauses().filter((id) => id !== conversationId)))
    }
  }

  /** No screen shows a worker's failure any more, so it goes to the log instead of being dropped. */
  private report(error: unknown): void {
    console.error('[bot-host]', error instanceof Error ? error.message : String(error))
  }
}

export const botHost = new BotHost()
