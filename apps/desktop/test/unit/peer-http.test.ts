import { generateKeyPairSync, X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import forge from 'node-forge'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isIdentityChange, pinnedFetch, peerRequest, urlHost } from '../../src/main/peer/http'
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

  it('refuses another certificate that the pinned one signed: the fingerprint is the pin', async () => {
    // A certificate that anchors itself may sign others; one signed by A's key for another key is not A.
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    })
    const issued = forge.pki.createCertificate()
    issued.publicKey = forge.pki.publicKeyFromPem(publicKey)
    issued.serialNumber = '02'
    issued.validity.notBefore = new Date(Date.now() - 86_400_000)
    issued.validity.notAfter = new Date(Date.now() + 86_400_000)
    issued.setSubject([{ name: 'commonName', value: 'impostor' }])
    issued.setIssuer(forge.pki.certificateFromPem(identityA.certPem).subject.attributes)
    issued.setExtensions([{ name: 'extKeyUsage', serverAuth: true }])
    issued.sign(forge.pki.privateKeyFromPem(identityA.keyPem), forge.md.sha256.create())
    const certPem = forge.pki.certificateToPem(issued)
    expect(new X509Certificate(certPem).checkIssued(new X509Certificate(identityA.certPem))).toBe(true)
    const impostor = https.createServer({ key: privateKey, cert: certPem }, (_request, response) => response.end('{}'))
    impostor.listen(0, '127.0.0.1')
    await once(impostor, 'listening')
    try {
      const at = { host: '127.0.0.1', port: (impostor.address() as AddressInfo).port }
      const refused = await peerRequest(at, 'GET', '/json', { pin: identityA.certPem }).catch((error) => error)
      expect(isIdentityChange(refused)).toBe(true)
    } finally {
      impostor.closeAllConnections()
      await new Promise((resolve) => impostor.close(resolve))
    }
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
