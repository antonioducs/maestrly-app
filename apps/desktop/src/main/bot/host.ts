import { z } from 'zod'
import { BOT_ACTIONS, BOT_MCP_PATH } from '@maestrly/protocol'
import { DEFAULT_BOT_PERMISSION_CEILING } from '../../shared/bot'
import type {
  BotConnectionView,
  BotPermissionCeiling,
  BotServerInput,
  BotServerView,
  BotSettingsView,
  BotSetupInput,
} from '../../shared/bot'
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
import { BotHttpServer } from './http-server'
import { BOT_OAUTH_SCOPES, LocalBotOAuth, normalizeBotPublicUrl } from './oauth'

/**
 * Personal bots, hosted by this computer.
 *
 * The embedded server answers the bot, the local service keeps the chats and their commands, and the
 * existing conversation worker runs them against the native chat runtime. There is no account, bridge
 * or remote instance in this path: a bot is authorized here, by the person sitting at this computer.
 */
const LEGACY_KEY = 'bot.connections.v1'
const SERVER_KEY = 'bot.server.v1'
const PENDING_PAUSES_KEY = 'bot.pending-pauses.v1'

/** Records written before the server was embedded. They are preserved and must be reconnected here. */
const legacySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    clientId: z.string().default(''),
    desktopId: z.string().default(''),
    workspaceIds: z.array(z.string()).default([]),
    revokedAt: z.string().nullable().default(null),
    mcpConfig: z.string().default(''),
    actions: z.array(z.enum(['chats:read', 'chats:write', 'chats:control', 'chats:answer'])).default([...BOT_ACTIONS]),
  })
  .passthrough()

const serverSchema = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().trim().min(1).max(191).default('127.0.0.1'),
    port: z.number().int().min(0).max(65_535).default(14_310),
    publicUrl: z.string().trim().max(2_048).default(''),
  })
  .strict()
type BotServerConfig = z.infer<typeof serverSchema>

/** The published address is configuration, never a request header: it is the whole bot audience. */
function addressOf(config: BotServerConfig): string {
  try {
    return normalizeBotPublicUrl(config.publicUrl)
  } catch {
    return ''
  }
}

/** Clients register through OAuth discovery before requesting consent for a local bot connection. */
function configText(address: string): string {
  // Until an address is published there is nothing truthful to hand a bot.
  if (!address) return ''
  return JSON.stringify(
    {
      mcpServers: {
        maestrly: {
          type: 'http',
          url: `${address}${BOT_MCP_PATH}`,
          oauth: { scopes: [...BOT_OAUTH_SCOPES], resource: `${address}${BOT_MCP_PATH}` },
        },
      },
    },
    null,
    2
  )
}

interface RunningBot {
  worker: BotConversationWorker
  timer: ReturnType<typeof setInterval>
  loop: Promise<void>
}

export class BotHost {
  private readonly service = localBotService
  private readonly oauth = new LocalBotOAuth()
  private readonly running = new Map<string, RunningBot>()
  private readonly starting = new Map<string, Promise<void>>()
  private server: BotHttpServer | null = null
  private serverTransition: Promise<void> = Promise.resolve()
  private serverState: BotServerView['state'] = 'stopped'
  private serverError: string | undefined
  private error: string | undefined
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
      void this.flushPauses().catch((error) => {
        this.error = this.errorText(error)
      })
    })
  }

  settings(): BotSettingsView {
    const config = this.serverConfig()
    const address = addressOf(config)
    const connections = [
      ...this.service.connections().map((connection) => this.view(connection, address)),
      ...this.legacyConnections(),
    ]
    return {
      connections,
      server: {
        ...config,
        publicUrl: address,
        state: this.serverState,
        ...(this.serverError ? { error: this.serverError } : {}),
      },
      pendingAuthorizations: this.pendingAuthorizations(),
      state: this.restoring
        ? 'connecting'
        : this.error
          ? 'error'
          : this.running.size
            ? 'connected'
            : connections.some((connection) => !connection.revokedAt)
              ? 'offline'
              : 'stopped',
      ...(this.error ? { error: this.error } : {}),
    }
  }

  async connect(input: BotSetupInput): Promise<BotSettingsView> {
    this.stopped = false
    this.error = undefined
    for (const workspaceId of input.workspaceIds)
      if (!getWorkspace(workspaceId)) throw new Error('A selected local project is unavailable.')
    const ceiling = input.permissionCeiling ?? DEFAULT_BOT_PERMISSION_CEILING
    const catalog = new BotModelCatalog(input.providerIds, input.selections, ceiling)
    const inventory = await catalog.inventory(input.workspaceIds)
    if (!inventory.selections.length) throw new Error('Connect and select an available model account for this bot.')
    if (input.selections && inventory.selections.length !== input.selections.length)
      throw new Error('One of the selected account/model pairs is no longer available.')
    if (inventory.workspaces.length !== input.workspaceIds.length)
      throw new Error('A selected local repository is unavailable.')
    const connection = this.service.createConnection({
      name: input.name,
      workspaceIds: input.workspaceIds,
      providerIds: input.providerIds,
      actions: input.actions ?? [...BOT_ACTIONS],
      permissionCeiling: ceiling,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.selections ? { selections: input.selections } : {}),
    })
    this.service.saveInventory(connection.id, inventory)
    await this.ensureServer()
    try {
      await this.start(connection)
    } catch (error) {
      // The connection is saved: only its worker failed to start, and the person can retry it.
      this.error = this.errorText(error)
    }
    return this.settings()
  }

  async revoke(connectionId: string): Promise<BotSettingsView> {
    const legacy = this.legacyRecords().find((record) => record.id === connectionId)
    if (legacy) {
      // The record stays visible; it is only marked revoked, and it was never running here.
      this.markLocal(connectionId, 'revoked')
      const revokedAt = legacy.revokedAt ?? new Date().toISOString()
      setAppSetting(
        LEGACY_KEY,
        JSON.stringify(
          this.legacyRecords().map((record) => (record.id === connectionId ? { ...record, revokedAt } : record))
        )
      )
      return this.settings()
    }
    const connection = this.service.requireConnection(connectionId)
    await this.stopBot(connection.id)
    this.markLocal(connection.id, 'revoked')
    this.service.revokeConnection(connection.id)
    this.oauth.revoke(connection.id)
    return this.settings()
  }

  async updateWorkspaces(connectionId: string, workspaceIds: string[]): Promise<BotSettingsView> {
    if (this.legacyRecords().some((record) => record.id === connectionId))
      throw new Error('Reconnect this bot on this computer before changing its projects.')
    const connection = this.service.requireConnection(connectionId)
    if (connection.revokedAt) throw new Error('This bot connection was revoked.')
    for (const id of workspaceIds) if (!getWorkspace(id)) throw new Error('A selected local project is unavailable.')
    await this.stopBot(connection.id)
    // Admission is narrowed before the new inventory is published, so nothing widens in between.
    const next = this.service.setGrants(connection.id, workspaceIds)
    this.service.saveInventory(
      next.id,
      await new BotModelCatalog(next.providerIds, next.selections ?? undefined, next.permissionCeiling).inventory(
        workspaceIds
      )
    )
    for (const conversation of listAllConversations())
      if (
        conversation.botOrigin?.connectionId === next.id &&
        conversation.workspaceId &&
        !workspaceIds.includes(conversation.workspaceId)
      )
        pauseBotForHuman(conversation.id)
    await this.flushPauses()
    await this.start(next)
    return this.settings()
  }

  /**
   * Move how far this bot's conversations may go on their own. A running turn keeps the ceiling it was
   * admitted under; the worker is stopped and started again so the next one reads the new one.
   */
  async setPermissionCeiling(connectionId: string, ceiling: BotPermissionCeiling): Promise<BotSettingsView> {
    if (this.legacyRecords().some((record) => record.id === connectionId))
      throw new Error('Reconnect this bot on this computer before changing its approvals.')
    const connection = this.service.requireConnection(connectionId)
    if (connection.revokedAt) throw new Error('This bot connection was revoked.')
    await this.stopBot(connection.id)
    const next = this.service.setPermissionCeiling(connection.id, ceiling)
    this.service.saveInventory(
      next.id,
      await new BotModelCatalog(next.providerIds, next.selections ?? undefined, next.permissionCeiling).inventory(
        next.workspaceIds
      )
    )
    await this.start(next)
    return this.settings()
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

  async restore(): Promise<void> {
    if (this.restoring || this.stopped) return
    this.restoring = true
    try {
      await this.ensureServer()
      await this.flushPauses()
      for (const connection of this.service.connections().filter((item) => !item.revokedAt)) {
        try {
          await this.start(connection)
        } catch (error) {
          this.error = this.errorText(error)
        }
      }
    } catch (error) {
      this.error = this.errorText(error)
    } finally {
      this.restoring = false
    }
  }

  async refresh(): Promise<BotSettingsView> {
    this.stopped = false
    this.error = undefined
    for (const connection of this.service.connections().filter((item) => !item.revokedAt)) {
      // A project that left this computer stops being offered and its chats leave bot control.
      const available = connection.workspaceIds.filter((id) => getWorkspace(id))
      if (available.length === connection.workspaceIds.length) continue
      await this.stopBot(connection.id)
      this.service.setGrants(connection.id, available)
      for (const conversation of listAllConversations())
        if (
          conversation.botOrigin?.connectionId === connection.id &&
          conversation.workspaceId &&
          !available.includes(conversation.workspaceId)
        )
          pauseBotForHuman(conversation.id)
    }
    await this.restore()
    return this.settings()
  }

  /** The embedded server is the only address a bot uses; moving it invalidates what it was issued. */
  async configureServer(input: BotServerInput): Promise<BotSettingsView> {
    const current = this.serverConfig()
    const next = serverSchema.parse({
      enabled: input.enabled ?? current.enabled,
      host: input.host ?? current.host,
      port: input.port ?? current.port,
      publicUrl: input.publicUrl ?? current.publicUrl,
    })
    if (next.publicUrl) next.publicUrl = normalizeBotPublicUrl(next.publicUrl)
    const moved = next.publicUrl !== addressOf(current)
    setAppSetting(SERVER_KEY, JSON.stringify(next))
    if (moved) this.oauth.invalidate()
    this.stopped = false
    await this.ensureServer()
    return this.settings()
  }

  /** The person decides here which connection a waiting bot is allowed to act as, or refuses it. */
  authorize(id: string, approved: boolean, connectionId: string): BotSettingsView {
    if (approved) {
      const connection = this.service.requireConnection(connectionId)
      if (connection.revokedAt) throw new Error('That bot connection was revoked.')
    }
    this.oauth.decide(id, approved, connectionId)
    return this.settings()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.serverTransition
    await Promise.allSettled([...this.starting.values()])
    await Promise.allSettled([...this.running.keys()].map((id) => this.stopBot(id)))
    await this.stopServer()
  }

  async dispose(): Promise<void> {
    await this.stop()
    this.pauseUnsubscribe()
  }

  private view(connection: BotLocalConnection, address: string): BotConnectionView {
    return {
      id: connection.id,
      name: connection.name,
      clientId: connection.clientId,
      desktopId: connection.desktopId,
      workspaceIds: connection.workspaceIds,
      revokedAt: connection.revokedAt,
      mcpConfig: configText(address),
      actions: connection.actions,
      permissionCeiling: connection.permissionCeiling,
      legacy: false,
    }
  }

  private legacyConnections(): BotConnectionView[] {
    return this.legacyRecords().map((record) => ({
      id: record.id,
      name: record.name,
      clientId: record.clientId,
      desktopId: record.desktopId,
      workspaceIds: record.workspaceIds,
      revokedAt: record.revokedAt,
      mcpConfig: record.mcpConfig,
      actions: record.actions,
      // It never ran here, so nothing it did was ever governed by a ceiling chosen on this computer.
      permissionCeiling: DEFAULT_BOT_PERMISSION_CEILING,
      legacy: true,
    }))
  }

  private legacyRecords(): Array<z.infer<typeof legacySchema>> {
    const raw = getAppSetting(LEGACY_KEY)
    if (!raw) return []
    try {
      const parsed = legacySchema.array().safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : []
    } catch {
      // An unreadable saved record is still never deleted; it is simply not shown.
      return []
    }
  }

  private pendingAuthorizations() {
    try {
      return this.oauth
        .pending()
        .map((entry) => ({ id: entry.id, clientName: entry.clientName, redirectUri: entry.redirectUri }))
    } catch (error) {
      this.error = this.errorText(error)
      return []
    }
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
        .catch((error) => {
          this.error = this.errorText(error)
        })
        .finally(() => {
          publishing = false
        })
    }, 15_000)
    const loop = worker.run((error) => {
      this.error = this.errorText(error)
    })
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

  /** Brings the embedded server in line with the saved configuration, without ever throwing at it. */
  private ensureServer(): Promise<void> {
    const transition = this.serverTransition.then(() => this.reconcileServer())
    this.serverTransition = transition.catch(() => {})
    return transition
  }

  private async reconcileServer(): Promise<void> {
    await this.stopServer()
    const config = this.serverConfig()
    if (!config.enabled || this.stopped) return
    if (!addressOf(config)) {
      this.serverState = 'error'
      this.serverError = 'Publish an HTTPS address for this computer before enabling the bot endpoint.'
      return
    }
    this.serverState = 'starting'
    this.serverError = undefined
    const server = new BotHttpServer({
      oauth: this.oauth,
      callTool: (connectionId, name, input, signal) => this.service.callTool(connectionId, name, input, signal),
    })
    try {
      await server.start({ host: config.host, port: config.port, publicUrl: addressOf(config) })
      if (this.stopped) {
        await server.stop()
        this.serverState = 'stopped'
        return
      }
      this.server = server
      this.serverState = 'listening'
    } catch (error) {
      this.serverState = 'error'
      this.serverError = this.errorText(error)
      await server.stop().catch(() => {})
    }
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    this.server = null
    this.serverState = 'stopped'
    this.serverError = undefined
    if (server) await server.stop().catch(() => {})
  }

  private serverConfig(): BotServerConfig {
    const raw = getAppSetting(SERVER_KEY)
    if (!raw) return serverSchema.parse({})
    try {
      const parsed = serverSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : serverSchema.parse({})
    } catch {
      return serverSchema.parse({})
    }
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

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

export const botHost = new BotHost()
