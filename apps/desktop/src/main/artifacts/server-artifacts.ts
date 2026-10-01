import {
  FLEET_ARTIFACTS_FEATURE,
  fleetArtifactHostSchema,
  type FleetArtifactHost,
  type FleetArtifactSettingsPatch,
} from '@maestrly/bot-fleet-protocol'
import type { ArtifactServerStatus } from '../../shared/artifacts'
import type { FleetClientService } from '../fleet/client/service'
import { createFleetAdmin, serverUnavailable, type ArtifactSource } from './sources'

/** The paired server's settings and transport; a reconnect never reuses a previous device's authority. */
export class ServerArtifacts {
  private cached: FleetArtifactHost | null = null
  private identity: string | null = null
  private pending: Promise<ArtifactServerStatus> | null = null
  private failed = false
  constructor(
    private readonly deps: {
      fleet: Pick<FleetClientService, 'call' | 'hasFeature' | 'getConnection'>
      viewerPort: () => number | null
    }
  ) {}
  private currentIdentity(): string | null {
    const c = this.deps.fleet.getConnection()
    return c.url && c.deviceId ? `${c.url}\n${c.deviceId}` : null
  }
  private base(): string | null {
    const port = this.deps.viewerPort()
    return port ? `http://127.0.0.1:${port}` : this.cached?.settings.publicAddress || null
  }
  status(): ArtifactServerStatus {
    const c = this.deps.fleet.getConnection()
    if (!c.url || !c.deviceId) return { state: 'absent' }
    if (c.state !== 'connected') return { state: 'unreachable' }
    if (!this.deps.fleet.hasFeature(FLEET_ARTIFACTS_FEATURE)) return { state: 'unsupported' }
    if (this.failed || !this.cached || this.identity !== this.currentIdentity()) return { state: 'unreachable' }
    if (!this.cached.settings.enabled) return { state: 'off' }
    return {
      state: 'ready',
      canOpen: this.cached.status.state === 'running' && !!this.base(),
      artifactCount: this.cached.status.artifactCount,
      storageBytes: this.cached.status.storageBytes,
      quotaBytes: this.cached.status.quotaBytes,
      problem: this.cached.status.problem,
    }
  }
  host(): FleetArtifactHost | null {
    return this.identity === this.currentIdentity() ? this.cached : null
  }
  refresh(): Promise<ArtifactServerStatus> {
    if (this.pending) return this.pending
    this.pending = this.load().finally(() => {
      this.pending = null
    })
    return this.pending
  }
  private async load(): Promise<ArtifactServerStatus> {
    const identity = this.currentIdentity()
    if (identity !== this.identity) {
      this.cached = null
      this.identity = identity
    }
    if (
      !identity ||
      this.deps.fleet.getConnection().state !== 'connected' ||
      !this.deps.fleet.hasFeature(FLEET_ARTIFACTS_FEATURE)
    )
      return this.status()
    try {
      const host = fleetArtifactHostSchema.parse(await this.deps.fleet.call('artifactHost'))
      if (identity === this.currentIdentity()) {
        this.cached = host
        this.failed = false
      }
    } catch {
      if (identity === this.currentIdentity()) this.failed = true
    }
    return this.status()
  }
  async update(patch: FleetArtifactSettingsPatch): Promise<FleetArtifactHost> {
    const identity = this.currentIdentity()
    if (!identity || !this.deps.fleet.hasFeature(FLEET_ARTIFACTS_FEATURE)) throw serverUnavailable()
    try {
      const host = fleetArtifactHostSchema.parse(await this.deps.fleet.call('artifactHostPatch', { body: patch }))
      if (identity !== this.currentIdentity()) throw serverUnavailable()
      this.identity = identity
      this.cached = host
      this.failed = false
      return host
    } catch {
      throw serverUnavailable()
    }
  }
  unavailable() {
    const status = this.status()
    if (status.state === 'absent' || status.state === 'unsupported') return null
    if (status.state === 'ready' && !status.problem) return null
    return serverUnavailable(status.state === 'off' ? 'server_off' : 'server_unreachable')
  }
  source(): ArtifactSource | null {
    const status = this.status()
    if (status.state !== 'ready' || status.problem) return null
    const identity = this.currentIdentity()
    const owner = { kind: 'device' as const, id: this.deps.fleet.getConnection().deviceId! }
    return {
      key: 'server',
      owner,
      admin: async () => {
        if (identity !== this.currentIdentity() || this.unavailable()) throw this.unavailable() ?? serverUnavailable()
        return createFleetAdmin(this.deps.fleet)
      },
      ready: () => identity === this.currentIdentity() && this.status().state === 'ready' && !this.unavailable(),
      viewerBase: () => (identity === this.currentIdentity() ? this.base() : null),
      publicBase: () => (identity === this.currentIdentity() ? this.cached?.settings.publicAddress || null : null),
      linkExpiryDays: () => this.cached?.settings.linkExpiryDays ?? null,
    }
  }
}
