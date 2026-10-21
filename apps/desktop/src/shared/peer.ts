import type { HostId } from './host-key'
import type { RemoteOs } from './remote-bridge'

/** The port a computer's peer server tries first. */
export const PEER_DEFAULT_PORT = 7690
/** The lowest port the owner may choose: lower ones need administrator rights on macOS and Linux. */
export const PEER_PORT_MIN = 1024
export const isPeerPort = (port: unknown): port is number =>
  Number.isInteger(port) && (port as number) >= PEER_PORT_MIN && (port as number) <= 65535
/** How long a pairing code stays valid on the computer that shows it. */
export const PEER_CODE_TTL_MS = 120_000
const PEER_HOST_PREFIX = 'peer/'
/** The host id of another computer of the owner: `peer/<deviceId>`. */
export const peerHostId = (deviceId: string): HostId => `${PEER_HOST_PREFIX}${deviceId}`
export const peerDeviceId = (hostId: HostId): string | null =>
  hostId.startsWith(PEER_HOST_PREFIX) ? hostId.slice(PEER_HOST_PREFIX.length) : null

export const PEER_PATHS = { hello: '/v1/peer/hello', pairings: '/v1/peer/pairings', self: '/v1/peer/self' } as const
export type PeerPairingStep = 'exchange' | 'confirm' | 'abort'
export const peerPairingPath = (pairingId: string, step: PeerPairingStep): string =>
  `${PEER_PATHS.pairings}/${pairingId}/${step}`

/** What a peer server says about itself before anyone authenticates. */
export interface PeerHello {
  deviceId: string
  name: string
  os: RemoteOs
  appVersion: string
  fingerprint: string
  /** Whether it takes a pairing request now. */
  pairing: boolean
}
export interface PeerPairingRequest {
  deviceId: string
  name: string
  os: RemoteOs
  appVersion: string
  /** The asking computer's certificate (PEM): the host pins it to reach that computer back. */
  certificate: string
}
export interface PeerPairingStarted {
  pairingId: string
  expiresAt: number
}
export interface PeerExchangeRequest {
  x: string
}
export interface PeerExchangeResponse {
  y: string
  confirm: string
}
export interface PeerConfirmRequest {
  confirm: string
  sealed: string
}
export interface PeerConfirmResponse {
  sealed: string
}
export interface PeerAbortRequest {
  reason: 'mismatch' | 'cancelled'
}
/** What each computer gives the other when they pair: the token it accepts, and where it can be reached. */
export interface PeerGrant {
  token: string
  port: number | null
  addresses: string[]
}
export type PeerPairingErrorCode =
  | 'busy'
  | 'cooldown'
  | 'version'
  | 'rate-limited'
  | 'expired'
  | 'mismatch'
  | 'used'
  | 'unavailable'
  | 'invalid'
  | 'self'
/**
 * Why a paired computer cannot be used now, beyond being out of reach: it does not share itself, it removed this
 * computer, its owner disconnected this one for now, or it shows another certificate than the one paired.
 */
export type PeerProblem = 'not-hosting' | 'removed' | 'disconnected' | 'identity-changed' | null
export interface PeerHostView {
  deviceId: string
  problem: PeerProblem
}

/** A computer this one paired with, as Settings → Computers shows it. */
export interface PeerComputerView {
  deviceId: string
  name: string
  os: RemoteOs
  pairedAt: number
  lastSeenAt: number | null
  /** Since when it uses this computer, while it does. */
  connectedSince: number | null
  /** Where it was last reached, as the owner would type it; null when it never gave an address. */
  address: string | null
}

/** Another computer asking to pair with this one, and how that ended: the owner reads the code here. */
export interface PeerPairingPromptView {
  pairingId: string
  name: string
  os: RemoteOs
  code: string
  expiresAt: number
  outcome: 'waiting' | 'paired' | 'mismatch' | 'expired' | 'cancelled'
}

/** This computer among the owner's computers: whether it shares itself, and the ones it paired with. */
export interface PeerOverview {
  /** False without a keyring: this computer has nowhere to keep its key, so it can neither share itself nor pair. */
  available: boolean
  name: string
  hosting: boolean
  /** The port the peer server listens on, while it does. */
  port: number | null
  /** The port the owner chose for it; null for the default, which moves to a next one when another program holds it. */
  chosenPort: number | null
  /** Why sharing is on and the peer server does not listen. */
  hostingError: string | null
  /** Where the owner's other computers may reach this one. */
  addresses: string[]
  /** Until when this computer refuses new pairings, after too many wrong codes. */
  pairingPausedUntil: number | null
  computers: PeerComputerView[]
  /** The pairing another computer asked for, while the owner may still see it. */
  prompt: PeerPairingPromptView | null
}

/** Why the port the owner chose was not kept: out of range, held by another program, or refused by the system. */
export type PeerPortError = 'invalid' | 'in-use' | 'failed'
export interface PeerSetPortResult {
  overview: PeerOverview
  error: PeerPortError | null
}

export type PeerConnectError = PeerPairingErrorCode | 'unreachable' | 'address'
/** Another computer agreed to pair and shows a code; the owner types it here. */
export type PeerConnectStart =
  | { ok: true; pairingId: string; name: string; os: RemoteOs; expiresAt: number }
  | { ok: false; error: PeerConnectError }
export type PeerConnectFinish = { ok: true; deviceId: string; name: string } | { ok: false; error: PeerConnectError }

/** `host:port` as the owner would type it, with an IPv6 address in brackets; the default port is left out. */
export function formatPeerAddress(host: string, port: number): string {
  const shown = host.includes(':') ? `[${host}]` : host
  return port === PEER_DEFAULT_PORT ? shown : `${shown}:${port}`
}

const NAME_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i
const IPV6 = /^[0-9a-f:.]+$/i

/**
 * Where the owner says another computer is: `host`, `host:port`, `[ipv6]:port`, or a bare IPv6 address, with an
 * optional `https://` in front. The host is a LAN or Tailscale IP, a `.local` name, or a MagicDNS name.
 */
export function parsePeerAddress(text: string): { host: string; port: number } | null {
  const value = text
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
  if (!value) return null
  let host: string
  let portText: string | undefined
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  if (bracketed) {
    host = bracketed[1]
    portText = bracketed[2]
    if (!host.includes(':') || !IPV6.test(host)) return null
  } else if ((value.match(/:/g) ?? []).length > 1) {
    if (!IPV6.test(value)) return null
    host = value
  } else {
    const [name, port, ...rest] = value.split(':')
    if (rest.length || port === '') return null
    host = name.replace(/\.$/, '')
    portText = port
    if (!NAME_HOST.test(host)) return null
  }
  const port = portText === undefined ? PEER_DEFAULT_PORT : Number(portText)
  if (!/^\d*$/.test(portText ?? '') || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: host.toLowerCase(), port }
}
