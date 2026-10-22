import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  PEER_CODE_TTL_MS,
  type PeerAbortRequest,
  type PeerConfirmRequest,
  type PeerConfirmResponse,
  type PeerExchangeRequest,
  type PeerExchangeResponse,
  type PeerGrant,
  type PeerPairingErrorCode,
  type PeerPairingRequest,
  type PeerPairingStarted,
} from '../../shared/peer'
import type { RemoteOs } from '../../shared/remote-bridge'
import { certificateFingerprint, type PeerIdentity } from './identity'
import { b64u, fromB64u, openGrant, pairingAad, passwordScalar, sealGrant } from './pairing-crypto'
import { type Spake2Keys, spake2Finish, spake2Start } from './spake2'

const CODE_TTL_MS = PEER_CODE_TTL_MS
const FAILURE_WINDOW_MS = 600_000
const FAILURE_LIMIT = 3
const COOLDOWN_MS = 600_000
const REQUEST_WINDOW_MS = 60_000
const REQUESTS_PER_WINDOW = 5

const MESSAGES: Record<PeerPairingErrorCode, string> = {
  busy: 'This computer is pairing with another one.',
  cooldown: 'Too many failed pairings: try again in a few minutes.',
  version: 'Both computers must run the same version of Maestrly.',
  'rate-limited': 'Too many pairing requests: wait a minute.',
  expired: 'The pairing code expired.',
  mismatch: 'The code did not match.',
  used: 'This pairing code was already used.',
  unavailable: 'This computer cannot keep the pairing: its keyring is unavailable.',
  invalid: 'Invalid pairing request.',
  self: 'That address is this computer.',
}

/** Why a pairing step was refused; `code` travels to the other computer. */
export class PeerPairingError extends Error {
  constructor(
    readonly code: PeerPairingErrorCode,
    message = MESSAGES[code]
  ) {
    super(message)
  }
}

/** What this computer shows the owner while another one asks to pair, and how that ended. */
export interface PairingPrompt {
  pairingId: string
  name: string
  os: RemoteOs
  code: string
  expiresAt: number
  outcome: 'waiting' | 'paired' | 'mismatch' | 'expired' | 'cancelled'
}

export interface HostPairingsDeps {
  identity(): PeerIdentity
  appVersion: string
  now(): number
  onPrompt(prompt: PairingPrompt): void
  /** Keeps the computer just paired and returns what it gets to reach this one. */
  onPaired(client: PeerPairingRequest, grant: PeerGrant, remote: string): PeerGrant
  code?(): string
  pairingId?(): string
}

interface Pending {
  id: string
  code: string
  client: PeerPairingRequest
  clientFingerprint: string
  remote: string
  expiresAt: number
  keys: Spake2Keys | null
  timer: ReturnType<typeof setTimeout>
}

/**
 * The pairings other computers ask this one for: one at a time, each with a code the owner reads here and types there.
 * The code allows one exchange; failed pairings cool this computer down, and each address may ask only so often.
 */
export class HostPairings {
  private current: Pending | null = null
  private failures: number[] = []
  private cooldownUntil = 0
  private readonly requests = new Map<string, number[]>()

  constructor(private readonly deps: HostPairingsDeps) {}

  accepting(): boolean {
    const now = this.deps.now()
    return now >= this.cooldownUntil && (this.current === null || this.current.expiresAt <= now)
  }

  /** Until when new pairings are refused after too many wrong codes; null when they are not. */
  pausedUntil(): number | null {
    return this.cooldownUntil > this.deps.now() ? this.cooldownUntil : null
  }

  request(input: PeerPairingRequest, remote: string): PeerPairingStarted {
    const now = this.deps.now()
    const recent = (this.requests.get(remote) ?? []).filter((at) => now - at < REQUEST_WINDOW_MS)
    if (recent.length >= REQUESTS_PER_WINDOW) throw new PeerPairingError('rate-limited')
    recent.push(now)
    this.requests.set(remote, recent)
    if (now < this.cooldownUntil) throw new PeerPairingError('cooldown')
    if (this.current && this.current.expiresAt > now) throw new PeerPairingError('busy')
    if (this.current) this.end('expired')
    if (input.appVersion !== this.deps.appVersion) throw new PeerPairingError('version')
    if (input.deviceId === this.deps.identity().deviceId) throw new PeerPairingError('invalid')
    let clientFingerprint: string
    try {
      clientFingerprint = certificateFingerprint(input.certificate)
    } catch {
      throw new PeerPairingError('invalid')
    }
    const id = this.deps.pairingId?.() ?? randomUUID()
    const code = this.deps.code?.() ?? String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = now + CODE_TTL_MS
    const timer = setTimeout(() => {
      if (this.current?.id === id) this.end('expired')
    }, CODE_TTL_MS)
    timer.unref?.()
    this.current = { id, code, client: input, clientFingerprint, remote, expiresAt, keys: null, timer }
    this.prompt('waiting')
    return { pairingId: id, expiresAt }
  }

  exchange(pairingId: string, body: PeerExchangeRequest): PeerExchangeResponse {
    const pending = this.live(pairingId)
    if (pending.keys) {
      this.failed()
      throw new PeerPairingError('used')
    }
    const identity = this.deps.identity()
    const start = spake2Start('B', passwordScalar(pending.code, pending.id))
    try {
      pending.keys = spake2Finish(
        start,
        fromB64u(body.x),
        { a: Buffer.from(pending.client.deviceId), b: Buffer.from(identity.deviceId) },
        pairingAad(identity.fingerprint, pending.clientFingerprint)
      )
    } catch {
      this.failed()
      throw new PeerPairingError('mismatch')
    }
    return { y: b64u(start.message), confirm: b64u(pending.keys.confirmB) }
  }

  confirm(pairingId: string, body: PeerConfirmRequest): PeerConfirmResponse {
    const pending = this.live(pairingId)
    const keys = pending.keys
    if (!keys) throw new PeerPairingError('expired')
    const presented = fromB64u(body.confirm)
    if (presented.length !== keys.confirmA.length || !timingSafeEqual(presented, keys.confirmA)) {
      this.failed()
      throw new PeerPairingError('mismatch')
    }
    let grant: PeerGrant
    try {
      grant = openGrant(keys.ke, 'client', body.sealed)
    } catch {
      this.failed()
      throw new PeerPairingError('mismatch')
    }
    let hostGrant: PeerGrant
    try {
      hostGrant = this.deps.onPaired(pending.client, grant, pending.remote)
    } catch (error) {
      this.end('cancelled')
      throw error
    }
    this.end('paired')
    return { sealed: sealGrant(keys.ke, 'host', hostGrant) }
  }

  /** The other computer ended the pairing: its code did not match, or its owner cancelled. */
  abort(pairingId: string, body: PeerAbortRequest): void {
    if (this.current?.id !== pairingId) return
    if (body.reason === 'mismatch') this.failed()
    else this.end('cancelled')
  }

  /** The owner cancelled on this computer. */
  cancel(pairingId: string): void {
    if (this.current?.id === pairingId) this.end('cancelled')
  }

  /** The current pairing with this id, while its code is valid. */
  private live(pairingId: string): Pending {
    const pending = this.current
    if (!pending || pending.id !== pairingId) throw new PeerPairingError('expired')
    if (pending.expiresAt <= this.deps.now()) {
      this.end('expired')
      throw new PeerPairingError('expired')
    }
    return pending
  }

  /** Ends the current pairing as a mismatch, and cools down after too many of them. */
  private failed(): void {
    this.end('mismatch')
    const now = this.deps.now()
    this.failures = this.failures.filter((at) => now - at < FAILURE_WINDOW_MS)
    this.failures.push(now)
    if (this.failures.length >= FAILURE_LIMIT) {
      this.cooldownUntil = now + COOLDOWN_MS
      this.failures = []
    }
  }

  private end(outcome: Exclude<PairingPrompt['outcome'], 'waiting'>): void {
    if (!this.current) return
    clearTimeout(this.current.timer)
    this.prompt(outcome)
    this.current = null
  }

  private prompt(outcome: PairingPrompt['outcome']): void {
    const pending = this.current
    if (!pending) return
    this.deps.onPrompt({
      pairingId: pending.id,
      name: pending.client.name,
      os: pending.client.os,
      code: pending.code,
      expiresAt: pending.expiresAt,
      outcome,
    })
  }
}
