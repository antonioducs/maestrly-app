import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeerIdentity } from '../../src/main/peer/identity'
import { b64u, fromB64u, openGrant, pairingAad, passwordScalar, sealGrant } from '../../src/main/peer/pairing-crypto'
import { HostPairings, type PairingPrompt, PeerPairingError } from '../../src/main/peer/pairing-host'
import { spake2Finish, spake2Start } from '../../src/main/peer/spake2'
import type { PeerGrant, PeerPairingRequest } from '../../src/shared/peer'
import { testIdentity } from './peer-helpers'

const PAIRING_ID = '0d4a6c2e-5b1f-4c3d-9e8a-7f6b5a4c3d2e'
const REMOTE = '10.0.0.7'

function clientRun(
  host: PeerIdentity,
  client: PeerIdentity,
  pairingId: string,
  code: string,
  hostFingerprint?: string
) {
  const start = spake2Start('A', passwordScalar(code, pairingId))
  return {
    x: b64u(start.message),
    finish(y: string) {
      return spake2Finish(
        start,
        fromB64u(y),
        { a: Buffer.from(client.deviceId), b: Buffer.from(host.deviceId) },
        pairingAad(hostFingerprint ?? host.fingerprint, client.fingerprint)
      )
    },
  }
}

function codeOf(error: unknown): string | null {
  return error instanceof PeerPairingError ? error.code : null
}

function thrown(run: () => unknown): string | null {
  try {
    run()
  } catch (error) {
    return codeOf(error)
  }
  return null
}

describe('HostPairings', () => {
  const host = testIdentity('A')
  const client = testIdentity('B')
  const request: PeerPairingRequest = {
    deviceId: client.deviceId,
    name: 'B',
    os: 'mac',
    appVersion: '1.2.3',
    certificate: client.certPem,
  }
  const grantB: PeerGrant = { token: 'b'.repeat(43), port: 7690, addresses: ['10.0.0.7'] }
  const grantA: PeerGrant = { token: 'a'.repeat(43), port: 7690, addresses: ['10.0.0.2'] }
  let prompts: PairingPrompt[]
  let onPaired: ReturnType<typeof vi.fn>
  let ids: string[]

  function pairings() {
    return new HostPairings({
      identity: () => host,
      appVersion: '1.2.3',
      now: () => Date.now(),
      onPrompt: (prompt) => prompts.push(prompt),
      onPaired: onPaired as unknown as (client: PeerPairingRequest, grant: PeerGrant, remote: string) => PeerGrant,
      code: () => '123456',
      pairingId: () => ids.shift() ?? PAIRING_ID,
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    prompts = []
    ids = []
    onPaired = vi.fn(() => grantA)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pairs a computer that knows the code', () => {
    const p = pairings()
    expect(p.request(request, REMOTE).pairingId).toBe(PAIRING_ID)
    expect(prompts.at(-1)).toMatchObject({ outcome: 'waiting', code: '123456', name: 'B', os: 'mac' })
    expect(p.accepting()).toBe(false)
    const run = clientRun(host, client, PAIRING_ID, '123456')
    const answer = p.exchange(PAIRING_ID, { x: run.x })
    const keys = run.finish(answer.y)
    expect(answer.confirm).toBe(b64u(keys.confirmB))
    const confirmed = p.confirm(PAIRING_ID, {
      confirm: b64u(keys.confirmA),
      sealed: sealGrant(keys.ke, 'client', grantB),
    })
    expect(onPaired).toHaveBeenCalledWith(request, grantB, REMOTE)
    expect(openGrant(keys.ke, 'host', confirmed.sealed)).toEqual(grantA)
    expect(prompts.at(-1)?.outcome).toBe('paired')
    expect(p.accepting()).toBe(true)
  })

  it('ends when the code typed on the other computer is wrong', () => {
    const p = pairings()
    p.request(request, REMOTE)
    const run = clientRun(host, client, PAIRING_ID, '654321')
    const answer = p.exchange(PAIRING_ID, { x: run.x })
    expect(b64u(run.finish(answer.y).confirmB)).not.toBe(answer.confirm)
    p.abort(PAIRING_ID, { reason: 'mismatch' })
    expect(prompts.at(-1)?.outcome).toBe('mismatch')
    expect(onPaired).not.toHaveBeenCalled()
  })

  it('refuses a confirmation it did not compute', () => {
    const p = pairings()
    p.request(request, REMOTE)
    const run = clientRun(host, client, PAIRING_ID, '123456')
    const keys = run.finish(p.exchange(PAIRING_ID, { x: run.x }).y)
    const forged = { confirm: b64u(Buffer.alloc(32)), sealed: sealGrant(keys.ke, 'client', grantB) }
    expect(thrown(() => p.confirm(PAIRING_ID, forged))).toBe('mismatch')
    expect(prompts.at(-1)?.outcome).toBe('mismatch')
    expect(onPaired).not.toHaveBeenCalled()
  })

  it('takes a single exchange per code', () => {
    const p = pairings()
    p.request(request, REMOTE)
    const run = clientRun(host, client, PAIRING_ID, '123456')
    p.exchange(PAIRING_ID, { x: run.x })
    expect(thrown(() => p.exchange(PAIRING_ID, { x: run.x }))).toBe('used')
    expect(prompts.at(-1)?.outcome).toBe('mismatch')
    expect(thrown(() => p.exchange(PAIRING_ID, { x: run.x }))).toBe('expired')
  })

  it('lets the code expire after two minutes', () => {
    const p = pairings()
    p.request(request, REMOTE)
    vi.advanceTimersByTime(120_001)
    expect(prompts.at(-1)?.outcome).toBe('expired')
    const run = clientRun(host, client, PAIRING_ID, '123456')
    expect(thrown(() => p.exchange(PAIRING_ID, { x: run.x }))).toBe('expired')
  })

  it('refuses requests while busy, from another version, from itself, and too many from one address', () => {
    const p = pairings()
    p.request(request, REMOTE)
    expect(thrown(() => p.request(request, '10.0.0.8'))).toBe('busy')
    p.cancel(PAIRING_ID)
    expect(thrown(() => p.request({ ...request, appVersion: '1.2.4' }, '10.0.0.8'))).toBe('version')
    expect(thrown(() => p.request({ ...request, deviceId: host.deviceId }, '10.0.0.8'))).toBe('invalid')
    expect(thrown(() => p.request({ ...request, certificate: 'not a certificate' }, '10.0.0.8'))).toBe('invalid')
    const limited = pairings()
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(thrown(() => limited.request({ ...request, appVersion: 'old' }, '10.0.0.9'))).toBe('version')
    }
    expect(thrown(() => limited.request(request, '10.0.0.9'))).toBe('rate-limited')
    vi.advanceTimersByTime(60_001)
    expect(thrown(() => limited.request(request, '10.0.0.9'))).toBeNull()
  })

  it('cools down after three failed pairings', () => {
    const p = pairings()
    for (let attempt = 0; attempt < 3; attempt++) {
      vi.advanceTimersByTime(20_000)
      p.request(request, REMOTE)
      p.abort(PAIRING_ID, { reason: 'mismatch' })
    }
    expect(p.accepting()).toBe(false)
    expect(thrown(() => p.request(request, REMOTE))).toBe('cooldown')
    vi.advanceTimersByTime(600_001)
    expect(p.accepting()).toBe(true)
    expect(thrown(() => p.request(request, REMOTE))).toBeNull()
  })

  it('ends when the owner cancels on this computer', () => {
    const p = pairings()
    p.request(request, REMOTE)
    p.cancel(PAIRING_ID)
    expect(prompts.at(-1)?.outcome).toBe('cancelled')
    const run = clientRun(host, client, PAIRING_ID, '123456')
    expect(thrown(() => p.exchange(PAIRING_ID, { x: run.x }))).toBe('expired')
  })

  it('fails the confirmations when a relay shows another certificate', () => {
    const p = pairings()
    p.request(request, REMOTE)
    const run = clientRun(host, client, PAIRING_ID, '123456', testIdentity('M').fingerprint)
    const answer = p.exchange(PAIRING_ID, { x: run.x })
    expect(b64u(run.finish(answer.y).confirmB)).not.toBe(answer.confirm)
  })
})
