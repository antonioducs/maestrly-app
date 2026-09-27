import { randomUUID } from 'node:crypto'
import {
  FLEET_OWNER_MEMORY_LIMITS,
  type FleetInputSource,
  type FleetOwnerMemory,
  type FleetOwnerMemoryEntry,
} from '@maestrly/bot-fleet-protocol'
import type { MemoryCoreExtraSection } from '../../memory/core'
import type { OwnerMemoryWriter } from '../../memory/extraction/owner-writer'
import { gatewayRequest, type GatewayConfig } from './gateway-client'

const INTRO =
  'Facts and preferences about your owner, shared by all of the owner’s bots. Follow them. Save a stable new preference or fact with owner_memory_save (replace an outdated entry with replaces_id); remove a wrong one with owner_memory_forget. Never store secrets.'

/** A bot's gateway access, or a function that returns it at each request (a bot's token can arrive later). */
export type GatewaySource = GatewayConfig | null | (() => GatewayConfig | null)

export class OwnerMemoryClient {
  private cache: FleetOwnerMemory | null = null
  constructor(
    private readonly source: GatewaySource,
    private readonly timeoutMs = 1_000
  ) {}
  private get gateway(): GatewayConfig | null {
    return typeof this.source === 'function' ? this.source() : this.source
  }

  async get(signal?: AbortSignal): Promise<FleetOwnerMemory | null> {
    if (!this.gateway) return null
    try {
      this.cache = await gatewayRequest(
        this.gateway,
        'ownerMemoryGet',
        undefined,
        {},
        AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])])
      )
    } catch {
      // Keep the last good copy: a transient gateway error must not read as "every entry was removed".
    }
    return this.cache
  }

  async coreSections(signal: AbortSignal): Promise<MemoryCoreExtraSection[] | null> {
    if (!this.gateway) return []
    const memory = await this.get(signal)
    if (!memory) return null
    return [
      {
        key: 'owner',
        heading: 'About your owner',
        intro: INTRO,
        budgetChars: FLEET_OWNER_MEMORY_LIMITS.activeCharsMax + 2_000,
        entries: memory.entries
          .filter((entry) => entry.status === 'active')
          .map((entry: FleetOwnerMemoryEntry) => ({
            id: entry.id,
            text: entry.content,
            meta: `${entry.author.kind === 'bot' ? entry.author.name : 'you'} · ${entry.createdAt.slice(0, 10)}`,
          })),
      },
    ]
  }

  async save(input: {
    content: string
    replacesId?: string
    origin: FleetInputSource | 'auto'
    idempotencyKey?: string
  }): Promise<FleetOwnerMemoryEntry> {
    if (!this.gateway) throw new Error('Owner memory needs the gateway.')
    const entry = await gatewayRequest(this.gateway, 'ownerMemorySave', {
      content: input.content,
      ...(input.replacesId ? { replacesId: input.replacesId } : {}),
      origin: input.origin,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
    })
    this.cache = null
    return entry
  }

  async forget(id: string, reason: string): Promise<FleetOwnerMemoryEntry> {
    if (!this.gateway) throw new Error('Owner memory needs the gateway.')
    const entry = await gatewayRequest(this.gateway, 'ownerMemoryForget', { reason }, { mid: id })
    this.cache = null
    return entry
  }

  writer(): OwnerMemoryWriter {
    return {
      list: async () =>
        ((await this.get())?.entries ?? [])
          .filter((entry) => entry.status === 'active')
          .map((entry) => ({ id: entry.id, content: entry.content })),
      save: async (input) => {
        await this.save({ ...input, origin: 'auto' })
      },
    }
  }
}
