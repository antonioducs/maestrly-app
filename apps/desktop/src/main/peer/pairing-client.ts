import { timingSafeEqual } from 'node:crypto'
import type { z } from 'zod'
import {
  PEER_PATHS,
  type PeerGrant,
  type PeerHello,
  type PeerPairingErrorCode,
  peerPairingPath,
} from '../../shared/peer'
import type { RemoteOs } from '../../shared/remote-bridge'
import { isIdentityChange, type PeerAddress, peerRequest } from './http'
import type { PeerIdentity } from './identity'
import { b64u, fromB64u, openGrant, pairingAad, passwordScalar, sealGrant } from './pairing-crypto'
import { PeerPairingError } from './pairing-host'
import {
  peerConfirmResponseSchema,
  peerExchangeResponseSchema,
  peerHelloSchema,
  peerPairingStartedSchema,
} from './schemas'
import { spake2Finish, spake2Start } from './spake2'
import { newPeerRecord, type PeerStore } from './store'

export interface ClientPairingDeps {
  identity: PeerIdentity
  appVersion: string
  os: RemoteOs
}

/** A pairing the other computer started: it shows the code, which the owner types here. */
export interface StartedClientPairing {
  address: PeerAddress
  hello: PeerHello
  /** The certificate the other computer showed (PEM): every later request pins it. */
  hostCertificate: string
  pairingId: string
  expiresAt: number
}

const CODES: ReadonlySet<string> = new Set<PeerPairingErrorCode>([
  'busy',
  'cooldown',
  'version',
  'rate-limited',
  'expired',
  'mismatch',
  'used',
  'unavailable',
  'invalid',
])

/** One request of the pairing: a refusal of the other computer becomes a PeerPairingError with its code. */
async function call<T extends z.ZodType>(
  address: PeerAddress,
  method: string,
  path: string,
  schema: T | null,
  options: { body?: unknown; pin?: string }
): Promise<{ value: z.infer<T>; certificate: string; fingerprint: string }> {
  let response: Awaited<ReturnType<typeof peerRequest<unknown>>>
  try {
    response = await peerRequest<unknown>(address, method, path, options)
  } catch (error) {
    if (isIdentityChange(error)) throw new PeerPairingError('invalid', 'The other computer identity changed.')
    throw error
  }
  if (response.status === 409) {
    const code = (response.body as { code?: unknown } | null)?.code
    throw new PeerPairingError(typeof code === 'string' && CODES.has(code) ? (code as PeerPairingErrorCode) : 'invalid')
  }
  if (response.status < 200 || response.status >= 300) throw new PeerPairingError('invalid')
  if (!schema)
    return { value: undefined as z.infer<T>, certificate: response.certificate, fingerprint: response.fingerprint }
  const parsed = schema.safeParse(response.body)
  if (!parsed.success) throw new PeerPairingError('invalid')
  return { value: parsed.data, certificate: response.certificate, fingerprint: response.fingerprint }
}

/**
 * Asks another computer to pair: it answers who it is, then shows a code. The first request reads its certificate;
 * the asking computer's own certificate travels in the request so the other one can reach it back later.
 */
export async function beginPairing(deps: ClientPairingDeps, address: PeerAddress): Promise<StartedClientPairing> {
  const met = await call(address, 'GET', PEER_PATHS.hello, peerHelloSchema, {})
  const hello = met.value
  if (hello.fingerprint !== met.fingerprint) throw new PeerPairingError('invalid')
  if (hello.appVersion !== deps.appVersion) throw new PeerPairingError('version')
  if (!hello.pairing) throw new PeerPairingError('busy')
  const started = await call(address, 'POST', PEER_PATHS.pairings, peerPairingStartedSchema, {
    pin: met.certificate,
    body: {
      deviceId: deps.identity.deviceId,
      name: deps.identity.name,
      os: deps.os,
      appVersion: deps.appVersion,
      certificate: deps.identity.certPem,
    },
  })
  return {
    address,
    hello,
    hostCertificate: met.certificate,
    pairingId: started.value.pairingId,
    expiresAt: started.value.expiresAt,
  }
}

/**
 * Runs SPAKE2 with the code the owner typed and, when both sides prove they know it, trades grants under its key.
 * Returns what the other computer gives this one. A wrong code tells the other computer and throws `mismatch`.
 */
export async function completePairing(
  deps: ClientPairingDeps,
  started: StartedClientPairing,
  code: string,
  grant: PeerGrant
): Promise<PeerGrant> {
  const pin = started.hostCertificate
  const start = spake2Start('A', passwordScalar(code, started.pairingId))
  const exchanged = await call(
    started.address,
    'POST',
    peerPairingPath(started.pairingId, 'exchange'),
    peerExchangeResponseSchema,
    { pin, body: { x: b64u(start.message) } }
  )
  let keys: ReturnType<typeof spake2Finish>
  try {
    keys = spake2Finish(
      start,
      fromB64u(exchanged.value.y),
      { a: Buffer.from(deps.identity.deviceId), b: Buffer.from(started.hello.deviceId) },
      pairingAad(started.hello.fingerprint, deps.identity.fingerprint)
    )
  } catch {
    throw new PeerPairingError('invalid')
  }
  const presented = fromB64u(exchanged.value.confirm)
  if (presented.length !== keys.confirmB.length || !timingSafeEqual(presented, keys.confirmB)) {
    await call(started.address, 'POST', peerPairingPath(started.pairingId, 'abort'), null, {
      pin,
      body: { reason: 'mismatch' },
    }).catch(() => undefined)
    throw new PeerPairingError('mismatch')
  }
  const confirmed = await call(
    started.address,
    'POST',
    peerPairingPath(started.pairingId, 'confirm'),
    peerConfirmResponseSchema,
    { pin, body: { confirm: b64u(keys.confirmA), sealed: sealGrant(keys.ke, 'client', grant) } }
  )
  try {
    return openGrant(keys.ke, 'host', confirmed.value.sealed)
  } catch {
    throw new PeerPairingError('invalid')
  }
}

/** Keeps the computer this one just paired with; false when the keyring cannot keep its token. */
export function savePairedHost(
  store: Pick<PeerStore, 'save'>,
  started: StartedClientPairing,
  hostGrant: PeerGrant,
  issuedToken: string,
  now: number
): boolean {
  return store.save(
    newPeerRecord({
      deviceId: started.hello.deviceId,
      name: started.hello.name,
      os: started.hello.os,
      certPem: started.hostCertificate,
      port: hostGrant.port ?? started.address.port,
      addresses: [started.address.host, ...hostGrant.addresses],
      issuedToken,
      now,
    }),
    hostGrant.token
  )
}
