import https from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { PeerCertificate, TLSSocket } from 'node:tls'
import { certificateFingerprint, derToPem, normalizeFingerprint } from './identity'

export interface PeerAddress {
  host: string
  port: number
}
export interface PinnedTls {
  ca: string
  checkServerIdentity: (host: string, cert: PeerCertificate) => Error | undefined
}
export interface PeerResponse<T> {
  status: number
  body: T
  /** The certificate the computer showed, as PEM. */
  certificate: string
  fingerprint: string
}

const ANSWER_MAX = 64 * 1024
export const urlHost = (host: string): string => (host.includes(':') ? `[${host}]` : host)
const servername = (host: string): string | undefined => (isIP(host) ? undefined : host)

const IDENTITY_CHANGED = 'The computer identity changed.'
/** What Node says when a pinned computer shows another certificate. */
const IDENTITY_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

/** Accepts only the certificate the owner's computer showed when it paired: its common name is not a host name. */
export function pinnedTls(certPem: string): PinnedTls {
  const expected = certificateFingerprint(certPem)
  return {
    ca: certPem,
    checkServerIdentity: (_host, cert) =>
      normalizeFingerprint(cert.fingerprint256 ?? '') === expected ? undefined : new Error(IDENTITY_CHANGED),
  }
}

/** Whether a connection with `pinnedTls` failed because the computer showed another certificate. */
export function isIdentityChange(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return (
    (typeof code === 'string' && IDENTITY_ERRORS.has(code)) ||
    (error instanceof Error && error.message === IDENTITY_CHANGED)
  )
}

/**
 * A JSON request to another computer's peer server. With `pin`, only that certificate is accepted. Without it, the
 * first contact of a pairing, which reads a certificate nobody knows yet and so cannot verify it: only the public
 * `hello` travels that way. Every later request pins the certificate read there, and SPAKE2 binds both computers'
 * fingerprints into its confirmations, so a certificate swapped on the way fails the pairing.
 */
export function peerRequest<T>(
  address: PeerAddress,
  method: string,
  path: string,
  options: { body?: unknown; pin?: string; headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<PeerResponse<T>> {
  const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body))
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: address.host,
      port: address.port,
      method,
      path,
      agent: false,
      servername: servername(address.host),
      timeout: options.timeoutMs ?? 10_000,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...options.headers,
      },
      ...(options.pin ? pinnedTls(options.pin) : { rejectUnauthorized: false }),
    })
    request.on('timeout', () => request.destroy(new Error('The computer did not answer.')))
    request.on('error', reject)
    request.on('response', (response) => {
      const cert = (response.socket as TLSSocket).getPeerCertificate()
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > ANSWER_MAX) request.destroy(new Error('The answer is too large.'))
        else chunks.push(chunk)
      })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = null
        try {
          body = text ? JSON.parse(text) : null
        } catch {
          reject(new Error('Invalid answer.'))
          return
        }
        resolve({
          status: response.statusCode ?? 0,
          body: body as T,
          certificate: derToPem(cert.raw),
          fingerprint: normalizeFingerprint(cert.fingerprint256),
        })
      })
      response.on('error', reject)
    })
    request.end(payload ?? undefined)
  })
}

/** A `fetch` for the transfers of one paired computer: the same requests, over its pinned certificate. */
export function pinnedFetch(certPem: string): typeof fetch {
  const tls = pinnedTls(certPem)
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const method = init.method ?? 'GET'
    return await new Promise<Response>((resolve, reject) => {
      const request = https.request(url, {
        method,
        agent: false,
        servername: servername(url.hostname.replace(/^\[|\]$/g, '')),
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        signal: init.signal ?? undefined,
        ...tls,
      })
      request.on('error', reject)
      request.on('response', (response) => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          for (const item of [value ?? []].flat()) headers.append(name, String(item))
        }
        const status = response.statusCode ?? 0
        const empty = status === 204 || status === 304 || method === 'HEAD'
        if (empty) response.resume()
        resolve(
          new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
            status,
            statusText: response.statusMessage,
            headers,
          })
        )
      })
      const body = init.body
      if (body === undefined || body === null) request.end()
      else if (typeof body === 'string' || body instanceof Uint8Array) request.end(body)
      else {
        request.destroy()
        reject(new Error('Unsupported request body'))
      }
    })
  }) as typeof fetch
}
