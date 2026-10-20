import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { isAllowedFleetUrl } from '@maestrly/bot-fleet-protocol'
import {
  defaultFleetServer,
  FLEET_SERVER_ALREADY_PAIRED,
  FLEET_SERVER_UNKNOWN,
  type FleetServerId,
  type FleetServerView,
} from '../../../shared/fleet-servers'
import { broadcast } from '../../window-ipc'
import { readInstallRecord } from '../installer/store'
import { FleetClientError } from './api'
import { FleetMediaCache } from './media-cache'
import { FleetMediaUrls } from './media-protocol'
import { type PairedGateway, pairWithGateway } from './pairing'
import { type FleetClientDeps, FleetClientService } from './service'
import {
  deleteFleetServerRecord,
  type FleetServerRecord,
  migrateLegacyFleetSettings,
  newFleetServerId,
  readFleetServerRecords,
  readFleetServerToken,
  saveFleetServerToken,
  type TokenPersistence,
  writeFleetServerRecord,
} from './settings'

export interface FleetServersDeps {
  records: {
    migrate(): void
    read(): FleetServerRecord[]
    write(record: FleetServerRecord): void
    delete(id: FleetServerId): void
    token(id: FleetServerId): { token: string | null; persistence: TokenPersistence }
    saveToken(id: FleetServerId, token: string): TokenPersistence
    newId(): FleetServerId
  }
  pair(input: { url: string; code: string; deviceName: string }): Promise<PairedGateway>
  createClient(deps: FleetClientDeps): FleetClientService
  /** The server this app installed, which artifacts and the Bots tab start on. */
  installedServerId(): FleetServerId | null
  emit(channel: string, payload: unknown): void
  hostname(): string
  now(): string
  media: FleetMediaCache
}

/** The bot servers this computer is paired with, one client for each, all connected at once. */
export class FleetServers {
  private readonly clients_ = new Map<FleetServerId, FleetClientService>()
  private readonly setups: Array<(client: FleetClientService) => void> = []
  private readonly listeners = new Set<() => void>()
  private readonly mediaUrls = new FleetMediaUrls()
  private started = false
  private last = ''

  constructor(private readonly deps: FleetServersDeps) {}

  /** Runs `setup` on every client, those of servers paired later too, before the client starts. */
  setupClients(setup: (client: FleetClientService) => void): void {
    this.setups.push(setup)
    for (const client of this.clients_.values()) setup(client)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.deps.records.migrate()
    for (const record of this.deps.records.read()) this.add(record.id).start()
    this.changed()
  }

  stop(): void {
    for (const client of this.clients_.values()) client.stop()
  }

  list(): FleetServerView[] {
    const installed = this.deps.installedServerId()
    return this.clients().map((client) => ({
      id: client.serverId,
      installed: client.serverId === installed,
      connection: client.getConnection(),
    }))
  }

  clients(): FleetClientService[] {
    return [...this.clients_.values()]
  }

  get(id: FleetServerId): FleetClientService | null {
    return this.clients_.get(id) ?? null
  }

  require(id: FleetServerId): FleetClientService {
    const client = this.clients_.get(id)
    if (!client) throw new Error(FLEET_SERVER_UNKNOWN)
    return client
  }

  /** The installed server when it is paired, else the first one paired. */
  default(): FleetClientService | null {
    const view = defaultFleetServer(this.list())
    return view ? this.get(view.id) : null
  }

  /** The server paired at an address, by its origin. */
  findByUrl(url: string): FleetServerId | null {
    const allowed = isAllowedFleetUrl(url)
    if (!allowed.ok) return null
    return this.deps.records.read().find((record) => record.url === allowed.origin)?.id ?? null
  }

  /**
   * Pairs a server. With `id`, pairs that server again (its token was revoked or lost): it keeps its id when the
   * address is the same, and an address of another server replaces it, so a host id never names two servers.
   */
  async pair(input: { url: string; code: string; deviceName?: string }, id?: FleetServerId): Promise<FleetServerView> {
    const allowed = isAllowedFleetUrl(input.url)
    if (!allowed.ok) throw new FleetClientError('INVALID_REQUEST', 400, allowed.reason)
    if (id) this.require(id)
    const previous = id ? this.record(id) : null
    const same = previous?.url === allowed.origin
    const holder = this.findByUrl(allowed.origin)
    if (holder && !(same && holder === id)) throw new Error(FLEET_SERVER_ALREADY_PAIRED)
    const paired = await this.deps.pair({
      url: allowed.origin,
      code: input.code,
      deviceName: input.deviceName?.trim() || this.deps.hostname(),
    })
    if (id && previous && same) {
      const client = this.require(id)
      client.stop()
      if (previous.deviceId !== paired.deviceId) await this.deps.media.purgeScope(previous.deviceId).catch(() => {})
      this.deps.records.saveToken(id, paired.token)
      this.deps.records.write({
        ...previous,
        url: paired.origin,
        deviceId: paired.deviceId,
        deviceName: paired.deviceName,
      })
      client.restart(paired.features)
      this.changed()
      return this.view(client)
    }
    const serverId = this.deps.records.newId()
    this.deps.records.saveToken(serverId, paired.token)
    this.deps.records.write({
      id: serverId,
      url: paired.origin,
      deviceId: paired.deviceId,
      deviceName: paired.deviceName,
      pairedAt: this.deps.now(),
    })
    const client = this.add(serverId)
    client.restart(paired.features)
    if (id) await this.remove(id)
    this.changed()
    return this.view(client)
  }

  /** The same pairing at another address, as when the local end of the SSH tunnel to a VPS moves to another port. */
  retarget(id: FleetServerId, url: string): void {
    const allowed = isAllowedFleetUrl(url)
    if (!allowed.ok) throw new FleetClientError('INVALID_REQUEST', 400, allowed.reason)
    const record = this.record(id)
    const client = this.require(id)
    if (!record) throw new Error(FLEET_SERVER_UNKNOWN)
    this.deps.records.write({ ...record, url: allowed.origin })
    client.restart()
    this.changed()
  }

  /** Disconnects one server: it forgets this device, and this computer forgets it. */
  async remove(id: FleetServerId): Promise<void> {
    const client = this.require(id)
    await client.unpair()
    this.clients_.delete(id)
    this.deps.records.delete(id)
    this.changed()
  }

  /** Calls back after a server was paired, removed, or anything known of one changed; returns its removal. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** The server whose pairing is a device id, as the shared media cache names it. */
  serverOfDevice(deviceId: string): FleetServerId | null {
    return this.clients().find((client) => client.getConnection().deviceId === deviceId)?.serverId ?? null
  }

  private record(id: FleetServerId): FleetServerRecord | null {
    return this.deps.records.read().find((record) => record.id === id) ?? null
  }

  private view(client: FleetClientService): FleetServerView {
    return {
      id: client.serverId,
      installed: client.serverId === this.deps.installedServerId(),
      connection: client.getConnection(),
    }
  }

  private add(id: FleetServerId): FleetClientService {
    const client = this.deps.createClient({
      serverId: id,
      credentials: () => {
        const record = this.record(id)
        if (!record) return null
        const { token, persistence } = this.deps.records.token(id)
        return { url: record.url, deviceId: record.deviceId, deviceName: record.deviceName, token, persistence }
      },
      media: this.deps.media,
      mediaUrls: this.mediaUrls,
    })
    for (const setup of this.setups) setup(client)
    client.onChange(() => this.changed())
    this.clients_.set(id, client)
    return client
  }

  private changed(): void {
    const list = this.list()
    const text = JSON.stringify(list)
    if (text !== this.last) {
      this.last = text
      this.deps.emit('fleet:servers', list)
    }
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        /* A listener's failure must not stop the others. */
      }
    }
  }
}

export const fleetServers: FleetServers = new FleetServers({
  records: {
    migrate: () => migrateLegacyFleetSettings(),
    read: readFleetServerRecords,
    write: writeFleetServerRecord,
    delete: deleteFleetServerRecord,
    token: readFleetServerToken,
    saveToken: saveFleetServerToken,
    newId: newFleetServerId,
  },
  pair: pairWithGateway,
  createClient: (deps) => new FleetClientService(deps),
  installedServerId: () => readInstallRecord()?.serverId ?? null,
  emit: broadcast,
  hostname: () => os.hostname(),
  now: () => new Date().toISOString(),
  media: new FleetMediaCache({
    root: () => path.join(app.getPath('userData'), 'fleet-media-cache'),
    // The cache names a video by the pairing it came through: the server whose bot shared it.
    onProgress: ({ scope, ...progress }) => {
      const serverId = fleetServers.serverOfDevice(scope)
      if (serverId) broadcast('fleet:mediaProgress', { serverId, progress })
    },
  }),
})
