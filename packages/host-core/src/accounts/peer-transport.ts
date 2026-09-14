import { createServer, request, type Server } from 'node:https'
import { randomUUID, sign, verify, X509Certificate } from 'node:crypto'
import { z } from 'zod'
import { accountSchema, delegatedCredentialSchema, modelCatalogEntrySchema } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { AccountLink, StoredGrant } from './repository.js'
import type { PeerKeys } from './peer-identity.js'

const base = { version: z.literal(1), authorityHostId: z.string().uuid(), peerHostId: z.string().uuid(), grantId: z.string().uuid(), nonce: z.string().uuid(), timestamp: z.number().int() }
const packet = <M extends string, S extends z.ZodType>(method: M, params: S) => z.strictObject({ ...base, method: z.literal(method), params })
const shortId = z.string().min(1).max(128)
export const peerRequestSchema = z.discriminatedUnion('method', [
  packet('inspect', z.strictObject({})), packet('models', z.strictObject({})),
  packet('credential', z.strictObject({ forceRefresh: z.boolean(), credentialHash: z.string().regex(/^[a-f0-9]{64}$/).optional() })),
  packet('lease', z.strictObject({ botId: shortId, name: z.string().min(1).max(80), turnId: shortId })),
  packet('release', z.strictObject({ turnId: shortId })),
])
export type PeerRequest = z.infer<typeof peerRequestSchema>
const resultSchemas = { inspect: accountSchema, models: z.array(modelCatalogEntrySchema).max(100), credential: delegatedCredentialSchema,
  lease: z.strictObject({ applied: z.literal(true) }), release: z.strictObject({ applied: z.literal(true) }) }
const errorCodes = ['ACCOUNT_UNAVAILABLE', 'ACCOUNT_REQUIRED', 'ACCOUNT_REVOKED', 'ACCOUNT_BUSY'] as const
const responseSchema = z.strictObject({ result: z.unknown().optional(), error: z.enum(errorCodes).optional() })
export function accountEndpoint(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.port || Number(url.port) < 1024)
    throw new HostError('ACCOUNT_LINK_INVALID', 'O endereço do serviço de contas é inválido')
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!hostname || hostname === '0.0.0.0' || hostname === '::' || hostname === 'metadata.google.internal' || /^169\.254\./.test(hostname) || /^fe[89ab][0-9a-f]:/.test(hostname) || /^(?:22[4-9]|23\d)\./.test(hostname))
    throw new HostError('ACCOUNT_LINK_INVALID', 'O endereço do serviço de contas é inválido')
  return url
}
export class AccountPeerServer {
  private server?: Server
  private starting?: Promise<number>
  private nonces = new Map<string, number>()
  private rates = new Map<string, { minute: number; count: number }>()
  private active = 0
  constructor(private hostId: string, private keys: PeerKeys, private grants: (id: string) => StoredGrant | undefined,
    private handle: (request: PeerRequest, grant: StoredGrant) => Promise<unknown>) {}
  listen(host: string, port: number) {
    if (this.starting) return this.starting
    this.starting = new Promise<number>((resolve, reject) => {
      this.server = createServer({ key: this.keys.tlsKey, cert: this.keys.certificate, minVersion: 'TLSv1.3', requestTimeout: 10000, headersTimeout: 5000 }, (req, res) => {
        const fail = (status: number, code: typeof errorCodes[number] = 'ACCOUNT_UNAVAILABLE') => {
          if (!res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: code })) }
        }
        if (req.method !== 'POST' || req.url !== '/accounts/v1' || req.headers.origin || req.headers['content-type'] !== 'application/json' || this.active >= 16) { req.resume(); fail(403); return }
        this.active++
        let bytes = 0
        const chunks: Buffer[] = []
        let released = false
        const release = () => { if (!released) { released = true; this.active-- } }
        res.on('close', release)
        req.on('error', () => { fail(400); release() })
        req.on('data', chunk => { bytes += chunk.length; if (bytes > 8192) { fail(413); req.destroy() } else chunks.push(chunk) })
        req.on('end', () => {
          void (async () => {
            const body = Buffer.concat(chunks)
            const parsed = peerRequestSchema.safeParse(JSON.parse(body.toString('utf8')))
            const signature = req.headers['x-maestrly-signature']
            if (!parsed.success || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return fail(403)
            const packet = parsed.data
            if (packet.authorityHostId !== this.hostId || Math.abs(Date.now() - packet.timestamp) > 30000) return fail(403)
            const grant = this.grants(packet.grantId)
            if (!grant || grant.peerHostId !== packet.peerHostId || !verify(null, body, grant.publicKey, Buffer.from(signature, 'base64'))) return fail(403)
            if (grant.revoked || Date.parse(grant.expiresAt) <= Date.now()) return fail(403, 'ACCOUNT_REVOKED')
            const time = Date.now()
            for (const [nonce, expiry] of this.nonces) if (expiry <= time) this.nonces.delete(nonce)
            if (this.nonces.has(packet.nonce) || this.nonces.size >= 10000) return fail(403)
            this.nonces.set(packet.nonce, time + 60000)
            const minute = Math.floor(time / 60000)
            const rate = this.rates.get(grant.peerHostId)
            if (rate?.minute === minute && rate.count >= 600) return fail(429)
            this.rates.set(grant.peerHostId, { minute, count: rate?.minute === minute ? rate.count + 1 : 1 })
            const result = resultSchemas[packet.method].parse(await this.handle(packet, grant))
            const current = this.grants(packet.grantId)
            if (!current || current.revoked || Date.parse(current.expiresAt) <= Date.now()) return fail(403, 'ACCOUNT_REVOKED')
            const response = JSON.stringify({ result })
            if (Buffer.byteLength(response) > 96 * 1024) return fail(500)
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(response)
          })().catch(error => fail(503, error instanceof HostError && errorCodes.includes(error.code as any) ? error.code as typeof errorCodes[number] : 'ACCOUNT_UNAVAILABLE')).finally(release)
        })
      })
      this.server.on('error', reject)
      this.server.listen(port, host, () => { const address = this.server!.address(); resolve(typeof address === 'object' && address ? address.port : port) })
    })
    void this.starting.catch(() => { this.starting = undefined })
    return this.starting
  }
  async close() {
    const server = this.server
    this.server = undefined; this.starting = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
export async function callAccountPeer(link: AccountLink, identity: { hostId: string; privateKey: string }, authorityHostId: string,
  method: PeerRequest['method'], params: Record<string, unknown>) {
  if (Date.parse(link.expiresAt) <= Date.now()) throw new HostError('ACCOUNT_REVOKED', 'O vínculo com a conta expirou; renove-o em Contas')
  const url = accountEndpoint(link.endpoint)
  const pinned = new X509Certificate(link.certificate)
  const packet = peerRequestSchema.parse({ version: 1, authorityHostId, peerHostId: identity.hostId, grantId: link.grantId, nonce: randomUUID(), timestamp: Date.now(), method, params })
  const body = Buffer.from(JSON.stringify(packet))
  const signature = sign(null, body, identity.privateKey).toString('base64')
  return new Promise<unknown>((resolve, reject) => {
    const fail = () => reject(new HostError('ACCOUNT_UNAVAILABLE', 'Não foi possível acessar o serviço responsável pela conta'))
    const req = request(url, { method: 'POST', path: '/accounts/v1', ca: link.certificate, minVersion: 'TLSv1.3',
      checkServerIdentity: (_hostname, certificate) => certificate.fingerprint256 === pinned.fingerprint256 ? undefined : new Error('Account identity mismatch'),
      headers: { 'content-type': 'application/json', 'content-length': body.length, 'x-maestrly-signature': signature },
      signal: AbortSignal.timeout(9000) }, res => {
      let bytes = 0
      const chunks: Buffer[] = []
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 96 * 1024) { res.destroy(); fail() } else chunks.push(chunk) })
      res.on('error', fail)
      res.on('end', () => {
        try {
          const response = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          if (response.error) { reject(new HostError(response.error, response.error === 'ACCOUNT_REVOKED' ? 'O vínculo com a conta foi revogado ou expirou' : 'A conta compartilhada não está disponível')); return }
          if (res.statusCode !== 200) { fail(); return }
          resolve(resultSchemas[method].parse(response.result))
        } catch { fail() }
      })
    })
    req.on('error', fail)
    req.end(body)
  })
}
