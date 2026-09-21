import {
  BOT_DESKTOP_ROOT,
  BOT_OWNER_ROOT,
  botClaimSchema,
  botCommandSchema,
  botConnectionRegistrationSchema,
  botConnectionSchema,
  botControlsSchema,
  botConversationSchema,
  botDesktopRegistrationSchema,
  botDesktopSchema,
  type BotAction,
  type BotClaim,
  type BotCommand,
  type BotConnection,
  type BotConnectionCreate,
  type BotConnectionPatch,
  type BotConnectionRegistration,
  type BotControls,
  type BotConversation,
  type BotDesktop,
  type BotDesktopRegistration,
  type BotEventUpload,
  type BotInventory,
  type BotManagementState,
  type BotMcpConfig,
} from '@maestrly/protocol'
import type { HttpTransport } from './transport.js'

export interface BotOverview {
  /** What the owner gives the bot so it can authorize against this instance. */
  mcp: Omit<BotMcpConfig, 'clientId'>
  actions: readonly BotAction[]
  desktops: BotDesktop[]
  connections: BotConnection[]
}

/** Owner-facing client for personal bot connections. No organization, project or runner is involved. */
export class BotOwnerApi {
  constructor(private readonly transport: HttpTransport) {}

  async overview(): Promise<BotOverview> {
    const value = await this.transport.request<BotOverview>('GET', BOT_OWNER_ROOT)
    return {
      ...value,
      desktops: value.desktops.map((desktop) => botDesktopSchema.parse(desktop)),
      connections: value.connections.map((connection) => botConnectionSchema.parse(connection)),
    }
  }

  /** The credential comes back once; store it only in the desktop main process secure storage. */
  async registerDesktop(name: string, idempotencyKey: string): Promise<BotDesktopRegistration> {
    return botDesktopRegistrationSchema.parse(
      await this.transport.request('POST', `${BOT_OWNER_ROOT}/desktops`, { body: { name }, idempotencyKey })
    )
  }

  async revokeDesktop(desktopId: string, idempotencyKey: string): Promise<BotDesktop> {
    return botDesktopSchema.parse(
      await this.transport.request('POST', `${BOT_OWNER_ROOT}/desktops/${encodeURIComponent(desktopId)}/revoke`, {
        body: {},
        idempotencyKey,
      })
    )
  }

  async connections(): Promise<BotConnection[]> {
    const value = await this.transport.request<BotConnection[]>('GET', `${BOT_OWNER_ROOT}/connections`)
    return value.map((connection) => botConnectionSchema.parse(connection))
  }

  /** Registers the bot's OAuth client when `clientId` is omitted, and returns its MCP configuration. */
  async connect(input: BotConnectionCreate, idempotencyKey: string): Promise<BotConnectionRegistration> {
    return botConnectionRegistrationSchema.parse(
      await this.transport.request('POST', `${BOT_OWNER_ROOT}/connections`, { body: input, idempotencyKey })
    )
  }

  async patchConnection(
    connectionId: string,
    input: BotConnectionPatch,
    idempotencyKey: string
  ): Promise<BotConnection> {
    return botConnectionSchema.parse(
      await this.transport.request('PATCH', `${BOT_OWNER_ROOT}/connections/${encodeURIComponent(connectionId)}`, {
        body: input,
        idempotencyKey,
      })
    )
  }

  async conversations(): Promise<BotConversation[]> {
    const value = await this.transport.request<BotConversation[]>('GET', `${BOT_OWNER_ROOT}/conversations`)
    return value.map((conversation) => botConversationSchema.parse(conversation))
  }

  /** Pause, resume or revoke a bot conversation. Only the owner may do this; a bot never can. */
  async setManagement(
    conversationId: string,
    input: { expectedVersion: number; state: BotManagementState },
    idempotencyKey: string
  ): Promise<BotConversation> {
    return botConversationSchema.parse(
      await this.transport.request(
        'POST',
        `${BOT_OWNER_ROOT}/conversations/${encodeURIComponent(conversationId)}/management`,
        { body: input, idempotencyKey }
      )
    )
  }
}

export interface BotDesktopCredentials {
  desktopId: string
  /** Returned once at registration; it lives only in the desktop main process secure storage. */
  credential: string
}

export interface BotLease {
  leaseToken: string
  fence: number
}

/**
 * Desktop transport. Every call is outbound: the desktop claims one command at a time, renews its lease
 * while it works, uploads durable events and reports the outcome. The server never calls the desktop.
 */
export class BotDesktopClient {
  constructor(
    private readonly transport: HttpTransport,
    private readonly credentials: BotDesktopCredentials
  ) {}

  private get headers(): Record<string, string> {
    return {
      authorization: `BotDesktop ${this.credentials.credential}`,
      'x-maestrly-bot-desktop-id': this.credentials.desktopId,
    }
  }

  private command(commandId: string): string {
    return `${BOT_DESKTOP_ROOT}/commands/${encodeURIComponent(commandId)}`
  }

  async publishInventory(inventory: BotInventory): Promise<void> {
    await this.transport.request('POST', `${BOT_DESKTOP_ROOT}/inventory`, {
      body: inventory,
      headers: this.headers,
    })
  }

  async claim(): Promise<BotClaim | null> {
    const value = await this.transport.request<unknown>('POST', `${BOT_DESKTOP_ROOT}/claim`, {
      body: {},
      headers: this.headers,
    })
    return value ? botClaimSchema.parse(value) : null
  }

  async renewLease(commandId: string, lease: BotLease): Promise<BotControls> {
    return botControlsSchema.parse(
      await this.transport.request('POST', `${this.command(commandId)}/lease`, {
        body: lease,
        headers: this.headers,
      })
    )
  }

  async controls(commandId: string, lease: BotLease): Promise<BotControls> {
    const query = `?leaseToken=${encodeURIComponent(lease.leaseToken)}&fence=${lease.fence}`
    return botControlsSchema.parse(
      await this.transport.request('GET', `${this.command(commandId)}/controls${query}`, { headers: this.headers })
    )
  }

  /** Event ids are idempotent per conversation, so a retried batch is accepted and not duplicated. */
  async uploadEvents(commandId: string, lease: BotLease, events: BotEventUpload[]): Promise<string[]> {
    const value = await this.transport.request<{ accepted: string[] }>('POST', `${this.command(commandId)}/events`, {
      body: { ...lease, events },
      headers: this.headers,
    })
    return value.accepted
  }

  async complete(
    commandId: string,
    lease: BotLease,
    outcome: { status: 'succeeded' | 'failed' | 'cancelled'; error?: string | null }
  ): Promise<BotCommand> {
    return botCommandSchema.parse(
      await this.transport.request('POST', `${this.command(commandId)}/complete`, {
        body: { ...lease, status: outcome.status, error: outcome.error ?? null },
        headers: this.headers,
      })
    )
  }
}
