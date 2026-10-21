import {
  PEER_CODE_TTL_MS,
  PEER_PATHS,
  formatPeerAddress,
  parsePeerAddress,
  type PeerConnectError,
  type PeerConnectFinish,
  type PeerConnectStart,
  type PeerOverview,
  type PeerPairingPromptView,
} from '../../shared/peer'
import type { RemoteOs } from '../../shared/remote-bridge'
import type { PeerHosting } from './hosting'
import { peerRequest } from './http'
import type { PeerIdentity } from './identity'
import {
  abortPairing,
  beginPairing,
  completePairing,
  savePairedHost,
  type StartedClientPairing,
} from './pairing-client'
import { type PairingPrompt, PeerPairingError } from './pairing-host'
import type { PeerRecord } from './schemas'
import { issueToken, type PeerStore } from './store'

const CODE = /^\d{6}$/
const FORGET_TIMEOUT_MS = 5_000

export type PeerHostingControls = Pick<
  PeerHosting,
  'enabled' | 'setEnabled' | 'listeningPort' | 'error' | 'connected' | 'connectedSince' | 'disconnect'
> & { pairings: Pick<PeerHosting['pairings'], 'pausedUntil' | 'cancel'> }

export interface PeerControllerDeps {
  /** Whether the keyring can hold this computer's key and its peers' tokens. */
  available(): boolean
  /** This computer's name: its identity's, or the one it would get. */
  name(): string
  /** This profile's identity, created on first use; null without a keyring. */
  identity(): PeerIdentity | null
  /** Renames this computer, creating its identity first when needed; false for a blank name or without a keyring. */
  rename(name: string): boolean
  store: Pick<PeerStore, 'list' | 'get' | 'tokenFor' | 'remove' | 'save' | 'onChange'>
  /** The sharing of this desktop; null on a computer that never shares itself (a headless instance). */
  hosting(): PeerHostingControls | null
  appVersion: string
  os: RemoteOs
  /** Where the owner's other computers may reach this one. */
  localAddresses(): string[]
  /** Asks a removed computer to forget this one too (best effort). */
  forget?(record: PeerRecord, token: string): Promise<void>
  begin?: typeof beginPairing
  complete?: typeof completePairing
  abort?: typeof abortPairing
  /** What Settings shows changed. */
  onChange(): void
  /** Another computer asks to pair: the owner may be looking elsewhere. */
  onPrompt?(prompt: PeerPairingPromptView): void
  now?(): number
}

/** What to tell the owner when a pairing step fails: the other computer's refusal, or that it did not answer. */
function connectError(error: unknown): PeerConnectError {
  return error instanceof PeerPairingError ? error.code : 'unreachable'
}

/** Asks the computer at its last address to forget this one, over its pinned certificate and with its token. */
async function forgetOnPeer(record: PeerRecord, token: string): Promise<void> {
  const host = record.addresses[0]
  if (!host) return
  await peerRequest({ host, port: record.port }, 'DELETE', PEER_PATHS.self, {
    pin: record.certPem,
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: FORGET_TIMEOUT_MS,
  })
}

/**
 * Settings → Computers and the pairing dialogs: sharing this computer, its name, the computers it paired with, and
 * pairing in both roles. Pairing with another computer keeps one pending pairing at a time, whose code the owner types
 * once; the pairing another computer asks for shows its code here until the owner dismisses how it ended.
 */
export class PeerController {
  private pending: StartedClientPairing | null = null
  private prompt: PeerPairingPromptView | null = null
  private readonly now: () => number

  constructor(private readonly deps: PeerControllerDeps) {
    this.now = deps.now ?? Date.now
    deps.store.onChange(() => deps.onChange())
  }

  overview(): PeerOverview {
    const hosting = this.deps.hosting()
    const enabled = hosting?.enabled() ?? false
    const port = hosting?.listeningPort() ?? null
    return {
      available: this.deps.available(),
      name: this.deps.name(),
      hosting: enabled,
      port,
      hostingError: enabled ? (hosting?.error() ?? null) : null,
      addresses: port === null ? [] : this.deps.localAddresses(),
      pairingPausedUntil: hosting?.pairings.pausedUntil() ?? null,
      computers: this.deps.store.list().map((record) => ({
        deviceId: record.deviceId,
        name: record.name,
        os: record.os,
        pairedAt: record.pairedAt,
        lastSeenAt: record.lastSeenAt,
        connectedSince: hosting?.connectedSince(record.deviceId) ?? null,
        address: record.addresses[0] ? formatPeerAddress(record.addresses[0], record.port) : null,
      })),
      prompt: this.prompt,
    }
  }

  async setHosting(on: boolean): Promise<PeerOverview> {
    await this.deps.hosting()?.setEnabled(on)
    return this.overview()
  }

  rename(name: string): PeerOverview {
    if (this.deps.rename(name)) this.deps.onChange()
    return this.overview()
  }

  /** Ends what a paired computer has open on this one; it stays paired. */
  disconnect(deviceId: string): void {
    this.deps.hosting()?.disconnect(deviceId)
  }

  /**
   * Forgets a paired computer here at once and asks it to forget this one too. Its sessions on this computer close,
   * and this computer's windows stop listing it.
   */
  remove(deviceId: string): PeerOverview {
    const record = this.deps.store.get(deviceId)
    const token = this.deps.store.tokenFor(deviceId)
    if (record && this.deps.store.remove(deviceId) && token)
      void (this.deps.forget ?? forgetOnPeer)(record, token).catch(() => undefined)
    return this.overview()
  }

  /** Asks the computer at `address` to pair: it shows a code, which the owner types here next. */
  async connectStart(address: string): Promise<PeerConnectStart> {
    const parsed = parsePeerAddress(address)
    if (!parsed) return { ok: false, error: 'address' }
    const identity = this.deps.identity()
    if (!identity) return { ok: false, error: 'unavailable' }
    this.cancelPending()
    try {
      const started = await (this.deps.begin ?? beginPairing)(
        { identity, appVersion: this.deps.appVersion, os: this.deps.os },
        parsed
      )
      this.pending = started
      return {
        ok: true,
        pairingId: started.pairingId,
        name: started.hello.name,
        os: started.hello.os,
        // The other computer's clock may differ from this one's: the code's lifetime counts from now here.
        expiresAt: this.now() + PEER_CODE_TTL_MS,
      }
    } catch (error) {
      return { ok: false, error: connectError(error) }
    }
  }

  /** Pairs with the code the owner read on the other computer. A code allows one try: a new one is asked for after. */
  async connectCode(pairingId: string, code: string): Promise<PeerConnectFinish> {
    const started = this.pending
    if (!started || started.pairingId !== pairingId) return { ok: false, error: 'expired' }
    if (!CODE.test(code)) return { ok: false, error: 'invalid' }
    this.pending = null
    const identity = this.deps.identity()
    if (!identity) return { ok: false, error: 'unavailable' }
    const grant = {
      token: issueToken(),
      port: this.deps.hosting()?.listeningPort() ?? null,
      addresses: this.deps.localAddresses(),
    }
    try {
      const hostGrant = await (this.deps.complete ?? completePairing)(
        { identity, appVersion: this.deps.appVersion, os: this.deps.os },
        started,
        code,
        grant
      )
      if (!savePairedHost(this.deps.store, started, hostGrant, grant.token, this.now()))
        return { ok: false, error: 'unavailable' }
      return { ok: true, deviceId: started.hello.deviceId, name: started.hello.name }
    } catch (error) {
      return { ok: false, error: connectError(error) }
    }
  }

  /** The owner closed the dialog before typing the code: the other computer closes its own. */
  connectCancel(pairingId: string): void {
    if (this.pending?.pairingId === pairingId) this.cancelPending()
  }

  /** What the pairing another computer asked for shows now, or how it ended; from the hosting side. */
  receivePrompt(prompt: PairingPrompt): void {
    this.prompt = { ...prompt }
    this.deps.onChange()
    if (prompt.outcome === 'waiting') this.deps.onPrompt?.(this.prompt)
  }

  /** The owner declined the pairing another computer asked for. */
  cancelPrompt(pairingId: string): void {
    if (this.prompt?.pairingId !== pairingId) return
    if (this.prompt.outcome === 'waiting') this.deps.hosting()?.pairings.cancel(pairingId)
    this.dismissPrompt(pairingId)
  }

  /** The owner closed the dialog that said how a pairing ended. */
  dismissPrompt(pairingId: string): void {
    if (this.prompt?.pairingId !== pairingId || this.prompt.outcome === 'waiting') return
    this.prompt = null
    this.deps.onChange()
  }

  private cancelPending(): void {
    const started = this.pending
    this.pending = null
    if (started) void (this.deps.abort ?? abortPairing)(started, 'cancelled').catch(() => undefined)
  }
}
