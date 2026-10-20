import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { certificateFingerprint } from '../../src/main/peer/identity'
import { beginPairing, completePairing, savePairedHost } from '../../src/main/peer/pairing-client'
import { HostPairings, type PairingPrompt, PeerPairingError } from '../../src/main/peer/pairing-host'
import { createPeerServer } from '../../src/main/peer/server'
import { issueToken, newPeerRecord, PeerStore } from '../../src/main/peer/store'
import type { PeerGrant } from '../../src/shared/peer'
import { memoryPeerStorage, testIdentity } from './peer-helpers'

const A = testIdentity('A')
const B = testIdentity('B')
const clientB = { identity: B, appVersion: '1.2.3', os: 'mac' as const }

let server: ReturnType<typeof createPeerServer>
let port = 0
let storeA: PeerStore
let storeB: PeerStore
let prompts: PairingPrompt[]
let issuedByA = ''

beforeEach(async () => {
  storeA = new PeerStore(memoryPeerStorage())
  storeB = new PeerStore(memoryPeerStorage())
  prompts = []
  issuedByA = issueToken()
  const pairings = new HostPairings({
    identity: () => A,
    appVersion: '1.2.3',
    now: Date.now,
    onPrompt: (prompt) => prompts.push(prompt),
    onPaired: (client, grant, remote) => {
      storeA.save(
        newPeerRecord({
          deviceId: client.deviceId,
          name: client.name,
          os: client.os,
          certPem: client.certificate,
          port: grant.port ?? 7690,
          addresses: [remote, ...grant.addresses],
          issuedToken: issuedByA,
          now: Date.now(),
        }),
        grant.token
      )
      return { token: issuedByA, port, addresses: ['127.0.0.1'] }
    },
  })
  server = createPeerServer({
    identity: A,
    appVersion: '1.2.3',
    os: 'linux',
    store: storeA,
    pairings,
    bridge: { handleUpgrade: (_request, socket) => socket.destroy() },
    hostFiles: null,
    editor: null,
    now: Date.now,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const address = () => ({ host: '127.0.0.1', port })
const grantFromB = (): PeerGrant => ({ token: issueToken(), port: 7691, addresses: ['10.0.0.8'] })

async function failure(run: Promise<unknown>): Promise<string | null> {
  try {
    await run
  } catch (error) {
    return error instanceof PeerPairingError ? error.code : String(error)
  }
  return null
}

describe('pairing with another computer', () => {
  it('pairs with the code shown on the other computer, and each side accepts only what it issued', async () => {
    const started = await beginPairing(clientB, address())
    expect(started.hello.deviceId).toBe(A.deviceId)
    expect(certificateFingerprint(started.hostCertificate)).toBe(A.fingerprint)
    const code = prompts.at(-1)?.code ?? ''
    const grant = grantFromB()
    const hostGrant = await completePairing(clientB, started, code, grant)
    expect(hostGrant).toEqual({ token: issuedByA, port, addresses: ['127.0.0.1'] })
    expect(savePairedHost(storeB, started, hostGrant, grant.token, Date.now())).toBe(true)
    expect(storeB.get(A.deviceId)?.fingerprint).toBe(A.fingerprint)
    expect(storeB.tokenFor(A.deviceId)).toBe(issuedByA)
    expect(storeA.tokenFor(B.deviceId)).toBe(grant.token)
    // B reaches A with the token A issued, and A reaches B with the one B issued: neither accepts the other's.
    expect(storeA.authenticate(`Bearer ${issuedByA}`)?.deviceId).toBe(B.deviceId)
    expect(storeB.authenticate(`Bearer ${grant.token}`)?.deviceId).toBe(A.deviceId)
    expect(storeA.authenticate(`Bearer ${grant.token}`)).toBeNull()
    expect(storeB.authenticate(`Bearer ${issuedByA}`)).toBeNull()
    expect(prompts.at(-1)?.outcome).toBe('paired')
  })

  it('stops when the code is wrong, and nothing is kept', async () => {
    const started = await beginPairing(clientB, address())
    const code = prompts.at(-1)?.code ?? ''
    const wrong = code === '000000' ? '111111' : '000000'
    expect(await failure(completePairing(clientB, started, wrong, grantFromB()))).toBe('mismatch')
    expect(prompts.at(-1)?.outcome).toBe('mismatch')
    expect(storeA.list()).toEqual([])
    expect(storeB.list()).toEqual([])
  })

  it('waits while the other computer pairs with someone else', async () => {
    await beginPairing(clientB, address())
    expect(await failure(beginPairing(clientB, address()))).toBe('busy')
  })

  it('refuses a computer of another version', async () => {
    expect(await failure(beginPairing({ ...clientB, appVersion: '1.2.4' }, address()))).toBe('version')
    expect(prompts).toEqual([])
  })
})
