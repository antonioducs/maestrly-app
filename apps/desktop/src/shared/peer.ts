import type { HostId } from './host-key'
import type { RemoteOs } from './remote-bridge'

/** The port a computer's peer server tries first. */
export const PEER_DEFAULT_PORT = 7690
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
/** Why a paired computer cannot be used now, beyond being out of reach. */
export type PeerProblem = 'not-hosting' | 'removed' | 'identity-changed' | null
export interface PeerHostView {
  deviceId: string
  problem: PeerProblem
}
