import os from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  FLEET_PROTOCOL_VERSION,
  isAllowedFleetUrl,
  normalizePairingCode,
  type FleetActivityEntry,
  type FleetBot,
  type FleetGatewayEvent,
  type FleetHostInfo,
  type FleetInboxItem,
  type FleetPeerMessage,
} from '@maestrly/bot-fleet-protocol'
import { broadcast } from '../../window-ipc'
import { FleetApiClient, FleetClientError } from './api'
import { FleetEvents, type FleetConnectionState } from './events'
import {
  clearFleetCredentials,
  readFleetSettings,
  saveFleetCredentials,
  saveLastActivitySeq,
  saveLastSeenAt,
  type TokenPersistence,
} from './settings'
import { FleetScreenBridge } from './screen-bridge'

export type FleetConnectionView = {
  state: FleetConnectionState
  deviceId: string | null
  url: string | null
  hostname: string | null
  error: string | null
  tokenPersistence: TokenPersistence
}
export type FleetSnapshot = {
  host: FleetHostInfo | null
  bots: FleetBot[]
  inbox: FleetInboxItem[]
  peerMessages: FleetPeerMessage[]
}
export type FleetDigest = {
  entries: FleetActivityEntry[]
  since: number
  awayMs: number
} | null

export class FleetClientService {
  private api: FleetApiClient | null = null
  private events: FleetEvents | null = null
  readonly screens = new FleetScreenBridge(() => this.requireApi())
  private connection: FleetConnectionView = {
    state: 'unconfigured',
    deviceId: null,
    url: null,
    hostname: null,
    error: null,
    tokenPersistence: 'secure',
  }
  private snapshot: FleetSnapshot = {
    host: null,
    bots: [],
    inbox: [],
    peerMessages: [],
  }
  private digest: FleetDigest = null
  private generation = 0

  start(): void {
    if (process.env.MAESTRLY_BOT_MODE === '1') return
    const settings = readFleetSettings()
    if (settings.url && settings.token) {
      const allowed = isAllowedFleetUrl(settings.url)
      if (allowed.ok) this.useCredentials(allowed.origin, settings.token, settings.tokenPersistence)
    } else if (settings.url) {
      const allowed = isAllowedFleetUrl(settings.url)
      if (allowed.ok)
        this.setConnection({
          url: allowed.origin,
          deviceId: settings.deviceId,
          tokenPersistence: settings.tokenPersistence,
        })
    }
  }

  stop(): void {
    if (this.connection.state === 'connected') saveLastSeenAt(Date.now())
    this.generation++
    this.events?.stop()
    this.events = null
    this.screens.closeAll()
  }

  private setConnection(patch: Partial<FleetConnectionView>): void {
    this.connection = { ...this.connection, ...patch }
    broadcast('fleet:connection', this.connection)
  }

  getConnection(): FleetConnectionView {
    return this.connection
  }
  getSnapshot(): FleetSnapshot {
    return this.snapshot
  }
  getDigest(): FleetDigest {
    return this.digest
  }

  private requireApi(): FleetApiClient {
    if (!this.api) throw new FleetClientError('UNAUTHORIZED', 401, 'Fleet is not connected')
    return this.api
  }
  getImage(botId: string, imageId: string) {
    return this.requireApi().getImage(botId, imageId)
  }

  private useCredentials(url: string, token: string, tokenPersistence: TokenPersistence): void {
    this.stop()
    this.api = new FleetApiClient(url, token)
    this.snapshot = { host: null, bots: [], inbox: [], peerMessages: [] }
    this.digest = null
    this.setConnection({
      state: 'connecting',
      deviceId: readFleetSettings().deviceId,
      url,
      hostname: null,
      error: null,
      tokenPersistence,
    })
    const generation = this.generation
    this.events = new FleetEvents(
      this.api,
      (event) => {
        if (generation === this.generation) this.applyEvent(event)
      },
      (state, error) => {
        if (generation === this.generation) this.setConnection({ state, error })
      },
      async () => {
        if (generation === this.generation) await this.refresh()
      }
    )
    this.events.start()
  }

  async connect(input: { url: string; code: string; deviceName?: string }): Promise<FleetConnectionView> {
    const allowed = isAllowedFleetUrl(input.url)
    if (!allowed.ok) throw new FleetClientError('INVALID_REQUEST', 400, allowed.reason)
    const code = normalizePairingCode(input.code)
    if (!code) throw new FleetClientError('INVALID_REQUEST', 400, 'Invalid pairing code')
    const deviceName = input.deviceName?.trim() || os.hostname()
    const unauthenticated = new FleetApiClient(allowed.origin)
    const meta = await unauthenticated.call('meta')
    if (meta.protocol !== FLEET_PROTOCOL_VERSION)
      throw new FleetClientError('PROTOCOL_INCOMPATIBLE', 426, 'Incompatible fleet protocol')
    const paired = await unauthenticated.call('pair', {
      body: { code, deviceName },
    })
    const persistence = saveFleetCredentials(allowed.origin, paired.deviceId, deviceName, paired.token)
    this.useCredentials(allowed.origin, paired.token, persistence)
    return this.connection
  }

  async disconnect(): Promise<void> {
    const api = this.api
    this.stop()
    this.api = null
    try {
      await api?.call('devicesSelfDelete')
    } catch {
      /* Local disconnect still takes effect. */
    }
    clearFleetCredentials()
    this.snapshot = { host: null, bots: [], inbox: [], peerMessages: [] }
    this.digest = null
    broadcast('fleet:digest', null)
    this.setConnection({
      state: 'unconfigured',
      deviceId: null,
      url: null,
      hostname: null,
      error: null,
      tokenPersistence: 'secure',
    })
  }

  async refresh(): Promise<FleetSnapshot> {
    const api = this.requireApi()
    const generation = this.generation
    const [host, bots, inbox, peers] = await Promise.all([
      api.call('host'),
      api.call('botsList'),
      api.call('inbox'),
      api.call('peerMessages', { query: { limit: 200 } }),
    ])
    if (generation !== this.generation) return this.snapshot
    this.snapshot = {
      host,
      bots: bots.bots,
      inbox: inbox.items,
      peerMessages: peers.messages,
    }
    this.setConnection({ hostname: host.hostname })
    await this.refreshDigest(api, generation)
    return this.snapshot
  }

  private async refreshDigest(api: FleetApiClient, generation: number): Promise<void> {
    const settings = readFleetSettings()
    const baseline = settings.lastActivitySeq
    let after = baseline ?? 0
    let latest = after
    const entries: FleetActivityEntry[] = []
    for (;;) {
      const page = await api.call('activity', { query: { after, limit: 500 } })
      if (generation !== this.generation) return
      entries.push(...page.entries)
      latest = Math.max(latest, page.lastSeq)
      if (page.entries.length < 500) break
      const next = page.entries.at(-1)?.seq ?? after
      if (next <= after) break
      after = next
    }
    if (baseline === null) {
      saveLastActivitySeq(latest)
      this.digest = null
    } else if (entries.length) {
      this.digest = {
        entries,
        since: baseline,
        awayMs: settings.lastSeenAt === null ? 0 : Math.max(0, Date.now() - settings.lastSeenAt),
      }
    }
    saveLastSeenAt(Date.now())
    broadcast('fleet:digest', this.digest)
  }

  ackDigest(lastSeq: number): void {
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) throw new Error('Invalid activity sequence')
    const current = readFleetSettings().lastActivitySeq ?? 0
    const latest = this.digest?.entries.at(-1)?.seq ?? current
    if (lastSeq > latest) throw new Error('Activity sequence is ahead of digest')
    saveLastActivitySeq(Math.max(current, lastSeq))
    if (this.digest) {
      this.digest.entries = this.digest.entries.filter((entry) => entry.seq > lastSeq)
      if (!this.digest.entries.length) this.digest = null
      else this.digest.since = lastSeq
    }
    broadcast('fleet:digest', this.digest)
  }

  private applyEvent(event: FleetGatewayEvent): void {
    saveLastSeenAt(Date.now())
    switch (event.type) {
      case 'bot.updated':
        // Archiving emits the archived bot before `bot.removed`; it must not stay listed whatever the order.
        this.snapshot.bots = [
          ...this.snapshot.bots.filter((bot) => bot.id !== event.bot.id),
          ...(event.bot.lifecycle === 'archived' ? [] : [event.bot]),
        ]
        break
      case 'bot.removed':
        this.snapshot.bots = this.snapshot.bots.filter((bot) => bot.id !== event.botId)
        break
      case 'host.updated':
        this.snapshot.host = event.host
        this.setConnection({ hostname: event.host.hostname })
        break
      case 'inbox.updated':
        this.snapshot.inbox = event.items
        break
      case 'peer.message':
        this.snapshot.peerMessages = [
          event.message,
          ...this.snapshot.peerMessages.filter((message) => message.id !== event.message.id),
        ].slice(0, 200)
        break
    }
    broadcast('fleet:event', event)
  }

  async call<K extends Parameters<FleetApiClient['call']>[0]>(
    key: K,
    options?: Parameters<FleetApiClient['call']>[1]
  ): Promise<Awaited<ReturnType<FleetApiClient['call']>>> {
    return this.requireApi().call(key, options)
  }

  idempotencyKey(): string {
    return randomUUID()
  }
}

export const fleetClientService = new FleetClientService()
