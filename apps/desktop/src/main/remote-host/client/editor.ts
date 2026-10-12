import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  FLEET_GATEWAY_EDITOR_PREFIX,
  FLEET_HOST_EDITOR_FEATURE,
  FLEET_INSTANCE_EDITOR_PREFIX,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
} from '@maestrly/bot-fleet-protocol'
import { type HostId, isRemoteHostId } from '../../../shared/host-key'
import type { HostView } from '../../../shared/hosts'
import { EditorProxy, EditorUnavailable, type EditorUnavailableReason, type EditorUpstream } from './editor-proxy'
import type { HostConnection } from './host-connection'
import { DIRECT_HOST_ID, type DirectHost } from './host-registry'

export interface EditorRegistry {
  list(): HostView[]
  directHost(): DirectHost | null
  use(hostId: HostId, origin: number, role: () => { role: 'main' }): Pick<HostConnection, 'invoke'>
}

export interface EditorFleet {
  /** The paired gateway's origin and this device's headers: null while unpaired. */
  hostFilesAccess(): { origin: string; headers: Record<string, string> } | null
  hasFeature(feature: string): boolean
}

/**
 * Where a host's editor is reached: a server's workspaces environment through its paired gateway, with this device's
 * credentials, or the development host straight at its control server. Throws EditorUnavailable when it cannot be.
 */
export function resolveEditorUpstream(
  hostId: HostId,
  deps: { registry: Pick<EditorRegistry, 'list' | 'directHost'> | null; fleet: EditorFleet }
): EditorUpstream {
  if (!deps.registry || !isRemoteHostId(hostId)) throw new EditorUnavailable('unknown-host')
  const host = deps.registry.list().find((item) => item.id === hostId)
  if (!host) throw new EditorUnavailable('unknown-host')
  if (hostId === DIRECT_HOST_ID) {
    const direct = deps.registry.directHost()
    if (!direct) throw new EditorUnavailable('unknown-host')
    return {
      origin: direct.origin,
      prefix: FLEET_INSTANCE_EDITOR_PREFIX,
      headers: () => ({
        [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
        Authorization: `Bearer ${direct.token}`,
      }),
    }
  }
  const environment = host.environment
  if (environment?.lifecycle !== 'running') throw new EditorUnavailable('offline')
  if (!deps.fleet.hasFeature(FLEET_HOST_EDITOR_FEATURE)) throw new EditorUnavailable('gateway-update-required')
  const access = deps.fleet.hostFilesAccess()
  if (!access) throw new EditorUnavailable('unauthorized')
  return {
    origin: access.origin,
    prefix: FLEET_GATEWAY_EDITOR_PREFIX.replace(':eid', encodeURIComponent(environment.id)),
    // Read on each request: the device token may be replaced while the editor is open.
    headers: () => deps.fleet.hostFilesAccess()?.headers ?? access.headers,
  }
}

/** Why a call to a host's editor failed, as the drawer explains it. */
export function editorFailureReason(error: unknown): EditorUnavailableReason {
  if (error instanceof EditorUnavailable) return error.reason
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'not-connected' || code === 'connection-lost') return 'offline'
  // A host of the same version always serves these channels; one that does not predates the editor.
  if (code === 'unknown-channel' || code === 'remote-unsupported') return 'host-update-required'
  return 'failed'
}

/**
 * The session of a remote host's editor views: one per host, apart from this computer's editor and from other hosts,
 * so their cookies and storage never mix.
 */
export function remoteEditorPartition(hostId: HostId): string {
  return `persist:remote-editor-${createHash('sha256').update(hostId).digest('hex').slice(0, 16)}`
}

export interface RemoteEditorsDeps {
  registry(): EditorRegistry | null
  fleet: EditorFleet
  /** Where the port of each host's editor is remembered between runs. */
  portsFile: string
  /** The renderer of this computer the editors belong to (the main window): the host's origin for these calls. */
  origin(): number | null
}

/**
 * The editors of remote hosts on this computer: one loopback proxy per host (see EditorProxy), and the calls that
 * open, follow and restart each host's editor over its bridge.
 */
export class RemoteEditors {
  private readonly proxies = new Map<HostId, EditorProxy>()
  private ports: Record<string, number> | null = null

  constructor(private readonly deps: RemoteEditorsDeps) {}

  /** Checks that the host's editor can be reached now; throws EditorUnavailable otherwise. */
  upstream(hostId: HostId): EditorUpstream {
    return resolveEditorUpstream(hostId, { registry: this.deps.registry(), fleet: this.deps.fleet })
  }

  /** The proxy of the host's editor, listening. */
  async proxy(hostId: HostId): Promise<EditorProxy> {
    this.upstream(hostId)
    let proxy = this.proxies.get(hostId)
    if (!proxy) {
      proxy = new EditorProxy({
        upstream: () => this.upstream(hostId),
        preferredPort: this.savedPorts()[hostId] ?? null,
        onPort: (port) => void this.savePort(hostId, port),
      })
      this.proxies.set(hostId, proxy)
    }
    await proxy.start()
    return proxy
  }

  /** Invokes an editor channel on the host, as this computer's main window. */
  async call<T>(hostId: HostId, channel: string, ...args: unknown[]): Promise<T> {
    const registry = this.deps.registry()
    const origin = this.deps.origin()
    if (!registry || origin === null) throw new EditorUnavailable('offline')
    let connection: Pick<HostConnection, 'invoke'>
    try {
      connection = registry.use(hostId, origin, () => ({ role: 'main' }))
    } catch {
      throw new EditorUnavailable('unknown-host')
    }
    return (await connection.invoke(origin, channel, args)) as T
  }

  close(): void {
    for (const proxy of this.proxies.values()) proxy.close()
    this.proxies.clear()
  }

  private savedPorts(): Record<string, number> {
    if (this.ports) return this.ports
    try {
      const value: unknown = JSON.parse(readFileSync(this.deps.portsFile, 'utf8'))
      this.ports = {}
      if (value && typeof value === 'object')
        for (const [hostId, port] of Object.entries(value))
          if (Number.isInteger(port) && (port as number) > 0 && (port as number) < 65_536)
            this.ports[hostId] = port as number
    } catch {
      this.ports = {}
    }
    return this.ports
  }

  private async savePort(hostId: HostId, port: number): Promise<void> {
    const ports = { ...this.savedPorts(), [hostId]: port }
    this.ports = ports
    try {
      await mkdir(path.dirname(this.deps.portsFile), { recursive: true })
      await writeFile(this.deps.portsFile, JSON.stringify(ports) + '\n', { mode: 0o600 })
    } catch {
      /* The editor gets another origin next time, and loads its state again. */
    }
  }
}
