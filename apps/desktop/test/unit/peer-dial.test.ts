import { once } from 'node:events'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PeerUnreachable, reachPeer } from '../../src/main/peer/dial'
import { testIdentity } from './peer-helpers'

const identityA = testIdentity('A')
const identityB = testIdentity('B')
let server: https.Server
let port = 0

async function listen(): Promise<https.Server> {
  const created = https.createServer({ key: identityA.keyPem, cert: identityA.certPem }, (_request, response) =>
    response.end()
  )
  created.listen(0, '127.0.0.1')
  await once(created, 'listening')
  return created
}

beforeAll(async () => {
  server = await listen()
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

async function failure(run: Promise<unknown>): Promise<PeerUnreachable> {
  try {
    await run
  } catch (error) {
    if (error instanceof PeerUnreachable) return error
    throw error
  }
  throw new Error('Expected the computer to be out of reach')
}

describe('reachPeer', () => {
  it('keeps the address that shows the pinned certificate', async () => {
    await expect(reachPeer(['::1', '127.0.0.1'], port, identityA.certPem, { staggerMs: 20 })).resolves.toBe('127.0.0.1')
  })

  it('says when the computer shows another certificate', async () => {
    const error = await failure(reachPeer(['127.0.0.1'], port, identityB.certPem))
    expect(error.identityChanged).toBe(true)
  })

  it('says when the computer refuses the connection', async () => {
    const closed = await listen()
    const closedPort = (closed.address() as AddressInfo).port
    await new Promise((resolve) => closed.close(resolve))
    const error = await failure(reachPeer(['127.0.0.1'], closedPort, identityA.certPem))
    expect(error.refused).toBe(true)
    expect(error.identityChanged).toBe(false)
  })

  it('has nowhere to go without addresses', async () => {
    const error = await failure(reachPeer([], port, identityA.certPem))
    expect(error).toMatchObject({ refused: false, identityChanged: false })
  })
})
