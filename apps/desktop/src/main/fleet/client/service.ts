import type { ArtifactHostEvent } from '@maestrly/artifact-host'
import { disposeBotLogins } from './provisioning/logins'
import os from 'node:os'
import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_FILES_FEATURE,
  FLEET_PROTOCOL_VERSION,
  isAllowedFleetUrl,
  normalizePairingCode,
  type FleetBot,
  type FleetEnvironment,
  type FleetGatewayEvent,
  type FleetHostInfo,
  type FleetInboxItem,
  type FleetPeerMessage,
} from '@maestrly/bot-fleet-protocol'
import { broadcast } from '../../window-ipc'
import { fleetAlertFor, type FleetAlert } from './alerts'
import { FleetApiClient, FleetClientError } from './api'
import { FleetEvents, type FleetConnectionState } from './events'
import {
  clearFleetCredentials,
  readFleetSettings,
  saveFleetCredentials,
  saveFleetUrl,
  type TokenPersistence,
} from './settings'
import { FleetScreenBridge } from './screen-bridge'
import { saveFleetFile } from './downloads'
import { findFleetDownload, fleetDownloadPath, rememberFleetDownload } from './download-history'

export type FleetConnectionView = {
  features: string[]
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
  /** Empty for gateways without environments; archived ones are listed on demand. */
  environments: FleetEnvironment[]
  inbox: FleetInboxItem[]
  peerMessages: FleetPeerMessage[]
}
const emptySnapshot = (): FleetSnapshot => ({ host: null, bots: [], environments: [], inbox: [], peerMessages: [] })

export class FleetClientService {
  private api: FleetApiClient | null = null
  private events: FleetEvents | null = null
  readonly screens = new FleetScreenBridge(() => this.requireApi())
  private connection: FleetConnectionView = {
    features: [],
    state: 'unconfigured',
    deviceId: null,
    url: null,
    hostname: null,
    error: null,
    tokenPersistence: 'secure',
  }
  private snapshot: FleetSnapshot = emptySnapshot()
  private generation = 0
  private downloads = new AbortController()
  /** Plays a bot's alert; set by the main process, which owns the sound settings. */
  onArtifactEvent: ((event: ArtifactHostEvent | { type: 'changed' }) => void) | null = null
  onAlert: ((botId: string, alert: FleetAlert) => void) | null = null

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
    this.downloads.abort()
    this.downloads = new AbortController()
    void disposeBotLogins()
    this.generation++
    this.events?.stop()
    this.events = null
    this.screens.closeAll()
  }

  private setConnection(patch: Partial<FleetConnectionView>): void {
    if (patch.state === 'unauthorized' || patch.state === 'incompatible') {
      this.downloads.abort()
      this.downloads = new AbortController()
    }
    this.connection = { ...this.connection, ...patch }
    broadcast('fleet:connection', this.connection)
    if (patch.state || patch.features) this.onArtifactEvent?.({ type: 'changed' })
  }

  getConnection(): FleetConnectionView {
    return this.connection
  }
  getSnapshot(): FleetSnapshot {
    return this.snapshot
  }
  /** Whether the connected gateway advertises a feature (`/v1/meta`), refreshed on every reconnect. */
  hasFeature(feature: string): boolean {
    return this.connection.features.includes(feature)
  }

  private requireApi(): FleetApiClient {
    if (!this.api) throw new FleetClientError('UNAUTHORIZED', 401, 'Fleet is not connected')
    return this.api
  }
  getImage(botId: string, imageId: string) {
    return this.requireApi().getImage(botId, imageId)
  }

  async downloadFile(botId: string, fileId: string): Promise<string> {
    const api = this.requireApi()
    const deviceId = this.connection.deviceId
    if (!deviceId) throw new Error('Fleet is not paired')
    const signal = this.downloads.signal
    if (!this.hasFeature(FLEET_FILES_FEATURE)) throw new Error('FLEET_FILES_UNSUPPORTED')
    const bot = await api.call('botGet', { params: { id: botId }, signal })
    signal.throwIfAborted()
    if (!bot.capabilities.includes(FLEET_FILES_FEATURE)) throw new Error('FLEET_FILES_UNSUPPORTED')
    const destination = await saveFleetFile(api, botId, fileId, { signal })
    return rememberFleetDownload(deviceId, botId, fileId, destination)
  }

  getDownload(botId: string, fileId: string): Promise<string | null> {
    const deviceId = this.connection.deviceId
    return deviceId ? findFleetDownload(deviceId, botId, fileId) : Promise.resolve(null)
  }

  async revealDownload(receipt: string): Promise<void> {
    shell.showItemInFolder(await fleetDownloadPath(receipt))
  }

  private useCredentials(url: string, token: string, tokenPersistence: TokenPersistence): void {
    this.stop()
    this.api = new FleetApiClient(url, token)
    this.snapshot = emptySnapshot()
    this.setConnection({
      features: [],
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
        if (generation !== this.generation) return
        const meta = await this.requireApi().call('meta')
        if (generation !== this.generation) return
        this.setConnection({ features: meta.features ?? [] })
        await this.refresh()
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
    this.setConnection({ features: meta.features ?? [] })
    return this.connection
  }

  /**
   * Keeps the pairing but reaches the gateway at another address, as when the local end of the SSH tunnel to a VPS
   * moves to another port. The device, its token and where the token is kept stay the same.
   */
  retarget(url: string): void {
    const allowed = isAllowedFleetUrl(url)
    if (!allowed.ok) throw new FleetClientError('INVALID_REQUEST', 400, allowed.reason)
    saveFleetUrl(allowed.origin)
    const settings = readFleetSettings()
    if (settings.token) this.useCredentials(allowed.origin, settings.token, settings.tokenPersistence)
    else this.setConnection({ url: allowed.origin })
  }

  async disconnect(): Promise<void> {
    await disposeBotLogins()
    const api = this.api
    this.stop()
    this.api = null
    try {
      await api?.call('devicesSelfDelete')
    } catch {
      /* Local disconnect still takes effect. */
    }
    clearFleetCredentials()
    this.snapshot = emptySnapshot()
    this.setConnection({
      features: [],
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
    const [host, bots, environments, inbox, peers] = await Promise.all([
      api.call('host'),
      api.call('botsList'),
      // Older gateways have no environments: their bots stay ungrouped.
      this.hasFeature(FLEET_ENVIRONMENTS_FEATURE)
        ? api.call('environmentsList')
        : Promise.resolve({ environments: [] as FleetEnvironment[] }),
      api.call('inbox'),
      api.call('peerMessages', { query: { limit: 200 } }),
    ])
    if (generation !== this.generation) return this.snapshot
    this.snapshot = {
      host,
      bots: bots.bots,
      environments: environments.environments.filter((environment) => environment.lifecycle !== 'archived'),
      inbox: inbox.items,
      peerMessages: peers.messages,
    }
    this.setConnection({ hostname: host.hostname })
    return this.snapshot
  }

  private applyEvent(event: FleetGatewayEvent): void {
    switch (event.type) {
      case 'hello':
        this.onArtifactEvent?.({ type: 'changed' })
        break
      case 'artifact.changed':
        this.onArtifactEvent?.({ type: 'changed', artifactId: event.artifactId })
        break
      case 'artifact.activity':
        this.onArtifactEvent?.({ type: 'activity', artifactId: event.artifactId, kind: event.kind })
        break
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
      case 'environment.updated':
        // Like bots, an archived environment is never listed whatever the event order, and neither are its bots.
        if (event.environment.lifecycle === 'archived') this.dropEnvironment(event.environment.id)
        else
          this.snapshot.environments = [
            ...this.snapshot.environments.filter((environment) => environment.id !== event.environment.id),
            event.environment,
          ]
        break
      case 'environment.removed':
        this.dropEnvironment(event.environmentId)
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
      case 'activity': {
        // Only live entries arrive here: nothing that happened while the Mac was away is fetched, or sounds.
        const alert = fleetAlertFor(event.entry)
        if (alert && event.entry.botId) {
          try {
            this.onAlert?.(event.entry.botId, alert)
          } catch {
            /* A sound failure must not stop the event from reaching the window. */
          }
        }
        break
      }
    }
    broadcast('fleet:event', event)
  }

  private dropEnvironment(environmentId: string): void {
    const bots = new Set(this.snapshot.bots.filter((bot) => bot.environmentId === environmentId).map((bot) => bot.id))
    this.snapshot.environments = this.snapshot.environments.filter((environment) => environment.id !== environmentId)
    this.snapshot.bots = this.snapshot.bots.filter((bot) => !bots.has(bot.id))
    this.snapshot.inbox = this.snapshot.inbox.filter((item) => !bots.has(item.botId))
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
