import { once } from 'node:events'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pinnedFetch, peerRequest, urlHost } from '../../src/main/peer/http'
import { certificateFingerprint } from '../../src/main/peer/identity'
import { testIdentity } from './peer-helpers'

const identityA = testIdentity('A')
const identityB = testIdentity('B')
let server: https.Server
let port = 0

beforeAll(async () => {
  server = https.createServer({ key: identityA.keyPem, cert: identityA.certPem }, (request, response) => {
    if (request.method === 'GET' && request.url === '/json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (request.method === 'POST' && request.url === '/echo') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(Buffer.concat(chunks))
      })
      return
    }
    if (request.method === 'DELETE' && request.url === '/empty') {
      response.writeHead(204)
      response.end()
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

describe('peerRequest', () => {
  it('reads the certificate of a computer it meets for the first time', async () => {
    const response = await peerRequest<{ ok: boolean }>({ host: '127.0.0.1', port }, 'GET', '/json')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(response.fingerprint).toBe(identityA.fingerprint)
    expect(certificateFingerprint(response.certificate)).toBe(identityA.fingerprint)
  })

  it('reaches a paired computer only with the certificate it pinned', async () => {
    const pinned = await peerRequest({ host: '127.0.0.1', port }, 'GET', '/json', { pin: identityA.certPem })
    expect(pinned.status).toBe(200)
    await expect(peerRequest({ host: '127.0.0.1', port }, 'GET', '/json', { pin: identityB.certPem })).rejects.toThrow()
  })
})

describe('pinnedFetch', () => {
  it('sends requests over the pinned certificate', async () => {
    const fetchA = pinnedFetch(identityA.certPem)
    const echoed = await fetchA(`https://127.0.0.1:${port}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })
    expect(await echoed.json()).toEqual({ a: 1 })
    const empty = await fetchA(`https://127.0.0.1:${port}/empty`, { method: 'DELETE' })
    expect(empty.status).toBe(204)
    expect(empty.body).toBeNull()
    await expect(pinnedFetch(identityB.certPem)(`https://127.0.0.1:${port}/json`)).rejects.toThrow()
  })
})

describe('urlHost', () => {
  it('brackets IPv6 addresses', () => {
    expect(urlHost('::1')).toBe('[::1]')
    expect(urlHost('10.0.0.5')).toBe('10.0.0.5')
  })
})
