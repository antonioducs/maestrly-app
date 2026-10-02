import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { openArtifactHost, type ArtifactAdmin, type ArtifactHost } from '@maestrly/artifact-host'
import {
  fleetArtifactSettingsSchema,
  fleetArtifactSettingsPatchSchema,
  type FleetArtifactSettings,
  type FleetArtifactSettingsPatch,
  type FleetArtifactHost,
  type FleetGatewayEvent,
} from '@maestrly/bot-fleet-protocol'
import type { Store } from './store.js'
import type { GatewayConfig } from './config.js'
import type { FleetNetwork } from './network.js'
import { ArtifactViewerProxy, viewerUnavailable } from './artifact-viewer-proxy.js'

export class ArtifactHosting {
  private host: ArtifactHost | null = null
  /** Forwards viewer requests to `host`; replaced with it, so a restart cuts the old host's requests. */
  private viewer: ArtifactViewerProxy | null = null
  private problem: FleetArtifactHost['status']['problem'] = null
  private queue: Promise<unknown> = Promise.resolve()
  private value: FleetArtifactSettings
  constructor(
    private readonly deps: {
      store: Store
      config: GatewayConfig
      network: FleetNetwork
      emit: (event: FleetGatewayEvent) => void
      onEnabledChange?: () => void | Promise<void>
      clock?: () => number
    }
  ) {
    this.value = fleetArtifactSettingsSchema.parse(
      deps.store.getMetaJson('artifact_settings') ?? {
        enabled: false,
        publicAddress: '',
        ownerName: '',
        linkExpiryDays: 30,
        quotaGb: 2,
      }
    )
  }
  settings(): FleetArtifactSettings {
    return { ...this.value }
  }
  admin(): ArtifactAdmin | null {
    return this.host?.admin ?? null
  }
  /** Admit a complete RPC, including its guard, before a lifecycle change can close the host. */
  withAdmin<T>(action: (admin: ArtifactAdmin | null) => Promise<T>): Promise<T> {
    return this.serial(() => action(this.admin()))
  }
  /**
   * Serves a request for the viewer from the gateway's public port. Browser requests never wait in the admin queue;
   * while hosting is off, failed or restarting, they are answered as unavailable.
   */
  serveViewer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = this.host
    const viewer = this.viewer
    if (!host || !viewer) {
      viewerUnavailable(res)
      return Promise.resolve()
    }
    return viewer.forward(req, res, host.port)
  }
  private detach(): ArtifactHost | null {
    const old = this.host
    this.host = null
    this.viewer?.close()
    this.viewer = null
    return old
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action)
    this.queue = run.catch(() => {})
    return run
  }
  async state(): Promise<FleetArtifactHost> {
    let counts = { artifactCount: 0, storageBytes: 0, quotaBytes: this.value.quotaGb * 1024 ** 3 }
    if (this.host) {
      try {
        counts = await this.host.admin.status()
      } catch {
        this.problem = 'internal'
      }
    }
    return {
      settings: this.settings(),
      status: {
        ...counts,
        state: this.problem ? 'error' : this.host ? 'running' : 'off',
        problem: this.problem,
      },
    }
  }
  start(): Promise<void> {
    return this.serial(() => this.reopen())
  }
  update(patch: FleetArtifactSettingsPatch): Promise<FleetArtifactHost> {
    return this.serial(async () => {
      const next = fleetArtifactSettingsSchema.parse({
        ...this.value,
        ...fleetArtifactSettingsPatchSchema.parse(patch),
      })
      const before = this.value
      this.deps.store.setMetaJson('artifact_settings', next)
      this.value = next
      if (
        ['enabled', 'publicAddress', 'ownerName', 'quotaGb'].some(
          (key) => before[key as keyof FleetArtifactSettings] !== next[key as keyof FleetArtifactSettings]
        ) ||
        this.problem
      )
        await this.reopen()
      if (before.enabled !== next.enabled) await this.deps.onEnabledChange?.()
      return this.state()
    })
  }
  private async reopen() {
    try {
      await this.detach()?.close()
      this.problem = null
      if (!this.value.enabled) return
      const host = await openArtifactHost(
        {
          dataDir: path.join(this.deps.config.dataDir, 'artifacts'),
          host: this.deps.config.artifactsHost,
          port: this.deps.config.artifactsPort,
          anyLoopbackPort: true,
          quotaBytes: this.value.quotaGb * 1024 ** 3,
          publicOrigins: this.value.publicAddress ? [this.value.publicAddress] : [],
          ownerName: this.value.ownerName,
        },
        {
          clock: this.deps.clock,
          allowConnection: (address) => !this.deps.network.insideFleet(address),
          onEvent: (event) =>
            this.deps.emit({
              ...event,
              type: event.type === 'changed' ? 'artifact.changed' : 'artifact.activity',
              at: new Date((this.deps.clock ?? Date.now)()).toISOString(),
            } as FleetGatewayEvent),
        }
      )
      this.host = host
      this.viewer = new ArtifactViewerProxy()
    } catch (error) {
      const code = (error as { code?: string })?.code
      this.problem =
        code === 'port_in_use' || code === 'EADDRINUSE'
          ? 'port_in_use'
          : code === 'storage' || code === 'EACCES' || code === 'ENOSPC' || code === 'EROFS'
            ? 'storage'
            : 'internal'
    }
  }
  close(): Promise<void> {
    return this.serial(async () => {
      await this.detach()?.close()
    })
  }
}
