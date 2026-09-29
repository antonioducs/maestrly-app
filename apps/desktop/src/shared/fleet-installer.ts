/**
 * The bot server installer's state, shared by the main process, the preload and the renderer. Pure module (no Node or
 * Electron imports): the main process owns installs; the renderer only mirrors `FleetInstallerStatus`.
 */
import { compareSemver, parseSemver } from './update'

/** Where Maestrly installed the bot server: this computer's Docker, or a VPS reached over SSH. */
export type FleetInstallMode = 'local' | 'remote'
/** What bots may reach: `public` keeps them off private networks and this computer; `open` does not. */
export type FleetEgress = 'open' | 'public'

export interface FleetRemoteTarget {
  host: string
  port: number
  username: string
}

/** What Maestrly installed and how it reaches it. Kept in app settings; never holds a secret. */
export interface FleetInstallRecord {
  mode: FleetInstallMode
  /** The version of the images the server runs; null when unknown (a tag that is not a version). */
  version: string | null
  /** This computer's port: the gateway's published port, or the local end of the SSH tunnel. */
  port: number
  allowPrivateNetwork: boolean
  remote: (FleetRemoteTarget & { hostKey: string; keyTag: string }) | null
  installedAt: string
}

export type FleetTunnelState =
  | 'off'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'host-key-changed'
  | 'needs-credentials'

export const FLEET_INSTALLER_STEP_IDS = [
  'check',
  'connect',
  'docker',
  'files',
  'images',
  'start',
  'tunnel',
  'pair',
  'key',
  'environments',
  'environment-updates',
  'teardown',
] as const
export type FleetInstallerStepId = (typeof FLEET_INSTALLER_STEP_IDS)[number]
export interface FleetInstallerStep {
  id: FleetInstallerStepId
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  /** Short progress text without secrets, such as the image being downloaded. */
  detail: string | null
}

export const FLEET_INSTALLER_ERROR_CODES = [
  'docker-missing',
  'docker-stopped',
  'docker-permission',
  'compose-missing',
  'dev-fleet-running',
  'images-unavailable',
  'image-pull-failed',
  'image-build-failed',
  'start-failed',
  'gateway-unhealthy',
  'pair-failed',
  'connect-failed',
  'ssh-unreachable',
  'ssh-auth',
  'ssh-host-key',
  'ssh-sudo',
  'ssh-forwarding',
  'os-unsupported',
  'arch-unsupported',
  'docker-install-failed',
  'server-newer',
  'not-connected',
  'job-running',
  'cancelled',
  'unknown',
] as const
export type FleetInstallerErrorCode = (typeof FLEET_INSTALLER_ERROR_CODES)[number]
export interface FleetInstallerError {
  code: FleetInstallerErrorCode
  detail: string | null
}

export type FleetInstallerJobKind = 'install-local' | 'install-remote' | 'update' | 'private-network' | 'remove'
export interface FleetInstallerJob {
  id: string
  kind: FleetInstallerJobKind
  mode: FleetInstallMode
  steps: FleetInstallerStep[]
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  error: FleetInstallerError | null
  startedAt: string
  /** The server's SSH host key fingerprint, shown while installing on a VPS. */
  hostKey: string | null
}

export type FleetUpdateState = 'none' | 'available' | 'server-newer'
export interface FleetInstallerStatus {
  record: FleetInstallRecord | null
  appVersion: string
  update: FleetUpdateState
  tunnel: FleetTunnelState
  /** Where Maestrly keeps its SSH key to a VPS; null without one. */
  keyPersistence: 'secure' | 'memory' | null
  job: FleetInstallerJob | null
}

/** What scheduling the update of every environment that has one did. */
export interface FleetEnvironmentUpdateResult {
  /** False when the gateway does not schedule updates: environments keep their own Update button. */
  supported: boolean
  /** The environments scheduled to update once their bots are idle. */
  scheduled: string[]
  failed: { environmentId: string; name: string; message: string }[]
}
/** Updating bots in one click: the server when this app can, then their environments. */
export interface FleetUpdateBotsResult {
  status: FleetInstallerStatus
  /** Null when no environment was scheduled because the server update failed or was cancelled. */
  environments: FleetEnvironmentUpdateResult | null
}

export type LocalDockerState = 'missing' | 'stopped' | 'no-permission' | 'no-compose' | 'dev-fleet' | 'ready'
export interface LocalDockerCheck {
  state: LocalDockerState
  /** The engine's name, such as Docker Desktop or OrbStack. */
  engine: string | null
  version: string | null
  memoryBytes: number | null
}

export interface FleetInstallLocalInput {
  deviceName: string
  allowPrivateNetwork: boolean
}
/** Used once, by the job that installs; never stored. */
export type FleetSshCredentials =
  | { kind: 'password'; password: string }
  | { kind: 'key'; privateKey: string; passphrase: string | null }
export interface FleetInstallRemoteInput {
  target: FleetRemoteTarget
  credentials: FleetSshCredentials
  deviceName: string
  allowPrivateNetwork: boolean
}

/**
 * The server's version as best known: the release version its connected gateway reports, else the one this computer
 * recorded when it installed or updated it. Another computer may have updated the server since.
 */
export function knownServerVersion(recordVersion: string | null, reportedVersion: string | null): string | null {
  return reportedVersion && parseSemver(reportedVersion) ? reportedVersion : recordVersion
}

/** Whether the server can move to the app's version. An unknown server version can always be updated. */
export function fleetUpdateState(serverVersion: string | null, appVersion: string): FleetUpdateState {
  if (serverVersion === null) return 'available'
  const order = compareSemver(serverVersion, appVersion)
  return order < 0 ? 'available' : order > 0 ? 'server-newer' : 'none'
}
