import {
  FLEET_ENVIRONMENT_UPDATES_FEATURE,
  fleetBotBlocksUpdate,
  type FleetBot,
  type FleetEnvironment,
  type FleetHostInfo,
} from '@maestrly/bot-fleet-protocol'
import type { FleetConnectionView, FleetSnapshot } from '../../../preload/api-fleet'
import {
  fleetUpdateState,
  knownServerVersion,
  type FleetInstallerStatus,
  type FleetInstallRecord,
} from '../../../shared/fleet-installer'
import type { FleetServerId } from '../../../shared/fleet-servers'
import { compareSemver, parseSemver } from '../../../shared/update'
import { environmentBots, environmentUpdateAvailable } from './environments'

/**
 * The bot server against this app: `update` when this app installed it and can move it to its version, `behind` when
 * it is older but this app did not install it (the owner updates its images), `newer` when the app is the older one.
 */
export type ServerUpdate = 'update' | 'behind' | 'newer' | 'current'
/** `next-start`: a stopped or failed environment moves to the server's image when it starts again. */
export type EnvironmentUpdateState = 'available' | 'pending' | 'next-start' | 'current'

/**
 * The install record when it is this server's: this app installed it. A record of an earlier version names no server
 * until main links it, and is taken as this server's meanwhile.
 */
export function installedRecord(installer: FleetInstallerStatus, serverId: FleetServerId): FleetInstallRecord | null {
  const record = installer.record
  return record && (!record.serverId || record.serverId === serverId) ? record : null
}

export function serverUpdate(
  installer: FleetInstallerStatus | null,
  host: FleetHostInfo | null,
  serverId: FleetServerId
): ServerUpdate {
  if (!installer) return 'current'
  const reported = host?.gatewayVersion ?? null
  const record = installedRecord(installer, serverId)
  if (record) {
    const state = fleetUpdateState(knownServerVersion(record.version, reported), installer.appVersion)
    return state === 'available' ? 'update' : state === 'server-newer' ? 'newer' : 'current'
  }
  return reported && parseSemver(reported) && compareSemver(reported, installer.appVersion) < 0 ? 'behind' : 'current'
}

export function environmentUpdateState(
  environment: FleetEnvironment,
  host: Pick<FleetHostInfo, 'botImageVersion'> | null
): EnvironmentUpdateState {
  const update = environment.update
  // A gateway that predates updates only tells the version its bot image is labelled with.
  const available = update ? update.available : environmentUpdateAvailable(environment, host)
  if (update?.pendingSince) return 'pending'
  if (!available) return 'current'
  if (environment.lifecycle === 'running') return 'available'
  return environment.lifecycle === 'stopped' || environment.lifecycle === 'failed' ? 'next-start' : 'current'
}

/** The environment's bots a waiting update waits for, by name. */
export function updateBlockers(environment: Pick<FleetEnvironment, 'id'>, bots: FleetBot[]): FleetBot[] {
  return environmentBots(environment, bots).filter(fleetBotBlocksUpdate)
}

export interface BotUpdateSummary {
  server: ServerUpdate
  environments: Record<string, EnvironmentUpdateState>
  /** Something can be updated: the Bots tab shows it. */
  available: boolean
  /** The server is being updated, or an environment waits for its bots. */
  pending: boolean
  /** Updating bots in one click can act now. */
  canUpdate: boolean
  /** The version the bots move to, when known. */
  targetVersion: string | null
}

export function botUpdateSummary(input: {
  installer: FleetInstallerStatus | null
  connection: FleetConnectionView
  snapshot: FleetSnapshot
  serverId: FleetServerId
}): BotUpdateSummary {
  const { installer, connection, snapshot, serverId } = input
  const server = serverUpdate(installer, snapshot.host, serverId)
  const environments = Object.fromEntries(
    snapshot.environments.map((environment) => [environment.id, environmentUpdateState(environment, snapshot.host)])
  )
  const states = Object.values(environments)
  const busy = installer?.job?.state === 'running'
  const record = installer ? installedRecord(installer, serverId) : null
  const reachable = !!record && (record.mode !== 'remote' || installer?.tunnel === 'connected')
  // Environments of a gateway that predates updates keep their own Update button: the one click leaves them alone.
  const schedulable =
    connection.features.includes(FLEET_ENVIRONMENT_UPDATES_FEATURE) &&
    snapshot.environments.some(
      (environment) => environment.update !== null && environments[environment.id] === 'available'
    )
  return {
    server,
    environments,
    available: server === 'update' || server === 'behind' || states.includes('available'),
    pending: (busy && installer?.job?.kind === 'update') || states.includes('pending'),
    canUpdate: connection.state === 'connected' && !busy && ((server === 'update' && reachable) || schedulable),
    targetVersion: server === 'update' ? (installer?.appVersion ?? null) : (snapshot.host?.botImageVersion ?? null),
  }
}
