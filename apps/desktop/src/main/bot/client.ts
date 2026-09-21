import { randomUUID } from 'node:crypto'
import { HttpTransport } from '@maestrly/client-sdk'
import {
  botClaimSchema,
  botConnectionRegistrationSchema,
  botConnectionSchema,
  botConversationSchema,
  botControlsSchema,
  botDesktopRegistrationSchema,
  type BotClaim,
  type BotCompletion,
  type BotConnectionCreate,
  type BotConnectionPatch,
  type BotEventUpload,
  type BotInventory,
} from '@maestrly/protocol'
import type { BotWorkerClient } from './worker'

/** Main-process owner transport. Tokens are refreshed here and never included in renderer responses. */
export class BotOwnerClient {
  private readonly transport: HttpTransport
  constructor(url: string, token: () => Promise<string | null>) {
    this.transport = new HttpTransport({
      baseUrl: url,
      authentication: {
        headers: async () => {
          const value = await token()
          if (!value) throw new Error('Sign in to the bridge before connecting a bot.')
          return { authorization: `Bearer ${value}` }
        },
      },
    })
  }

  async registerDesktop(name: string, requestId = randomUUID()) {
    return botDesktopRegistrationSchema.parse(
      await this.transport.request('POST', '/api/v1/bots/desktops', {
        body: { name },
        idempotencyKey: requestId,
        signal: AbortSignal.timeout(15_000),
      })
    )
  }

  async revokeDesktop(desktopId: string) {
    await this.transport.request('POST', `/api/v1/bots/desktops/${encodeURIComponent(desktopId)}/revoke`, {
      body: {},
      idempotencyKey: randomUUID(),
      signal: AbortSignal.timeout(15_000),
    })
  }

  async connect(input: BotConnectionCreate, requestId = randomUUID()) {
    return botConnectionRegistrationSchema.parse(
      await this.transport.request('POST', '/api/v1/bots/connections', {
        body: input,
        idempotencyKey: requestId,
        signal: AbortSignal.timeout(15_000),
      })
    )
  }

  async connections() {
    return botConnectionSchema
      .array()
      .parse(await this.transport.request('GET', '/api/v1/bots/connections', { signal: AbortSignal.timeout(15_000) }))
  }

  async patch(connectionId: string, input: BotConnectionPatch, requestId = randomUUID()) {
    return botConnectionSchema.parse(
      await this.transport.request('PATCH', `/api/v1/bots/connections/${encodeURIComponent(connectionId)}`, {
        body: input,
        idempotencyKey: requestId,
        signal: AbortSignal.timeout(15_000),
      })
    )
  }

  async conversations() {
    return botConversationSchema
      .array()
      .parse(await this.transport.request('GET', '/api/v1/bots/conversations', { signal: AbortSignal.timeout(15_000) }))
  }

  async management(
    conversationId: string,
    expectedVersion: number,
    state: 'active' | 'paused' | 'revoked',
    requestId = randomUUID()
  ) {
    return botConversationSchema.parse(
      await this.transport.request(
        'POST',
        `/api/v1/bots/conversations/${encodeURIComponent(conversationId)}/management`,
        {
          body: { expectedVersion, state },
          idempotencyKey: requestId,
          signal: AbortSignal.timeout(15_000),
        }
      )
    )
  }
}

/** Device-only transport cannot mutate owner grants or borrow a token from another desktop. */
export class BotDesktopClient implements BotWorkerClient {
  private readonly transport: HttpTransport
  constructor(url: string, desktopId: string, credential: string) {
    this.transport = new HttpTransport({
      baseUrl: url,
      authentication: {
        headers: () => ({
          authorization: `BotDesktop ${credential}`,
          'x-maestrly-bot-desktop-id': desktopId,
        }),
      },
    })
  }

  async claim(signal?: AbortSignal) {
    const value = await this.transport.request('POST', '/api/v1/bot-desktops/claim', {
      body: {},
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    })
    return value === null ? null : botClaimSchema.parse(value)
  }

  async lease(claim: BotClaim) {
    return botControlsSchema.parse(
      await this.transport.request('POST', this.path(claim, 'lease'), {
        body: this.hold(claim),
        signal: AbortSignal.timeout(10_000),
      })
    )
  }

  async controls(claim: BotClaim) {
    const query = new URLSearchParams({ leaseToken: claim.command.leaseToken!, fence: String(claim.fence) })
    return botControlsSchema.parse(
      await this.transport.request('GET', `${this.path(claim, 'controls')}?${query}`, {
        signal: AbortSignal.timeout(10_000),
      })
    )
  }

  async upload(claim: BotClaim, events: BotEventUpload[]) {
    await this.transport.request('POST', this.path(claim, 'events'), {
      body: { ...this.hold(claim), events },
      signal: AbortSignal.timeout(10_000),
    })
  }

  async complete(claim: BotClaim, result: BotCompletion) {
    await this.transport.request('POST', this.path(claim, 'complete'), {
      body: result,
      signal: AbortSignal.timeout(10_000),
    })
  }

  async inventory(inventory: BotInventory) {
    await this.transport.request('POST', '/api/v1/bot-desktops/inventory', {
      body: inventory,
      signal: AbortSignal.timeout(15_000),
    })
  }

  private hold(claim: BotClaim) {
    return { leaseToken: claim.command.leaseToken, fence: claim.fence }
  }
  private path(claim: BotClaim, action: string) {
    return `/api/v1/bot-desktops/commands/${encodeURIComponent(claim.command.id)}/${action}`
  }
}
