import type http from 'node:http'
import type { Access } from '../access.js'
import { MAX_API_BODY_BYTES } from '../limits.js'
import type { SessionRecord } from '../store/artifact-store.js'
import type { SharingFields } from '../store/sharing-store.js'
import { API_HEADERS } from './headers.js'

export const JSON_TYPE = 'application/json; charset=utf-8'
export const TEXT_TYPE = 'text/plain; charset=utf-8'
export const JS_TYPE = 'text/javascript; charset=utf-8'
export const MAX_COOKIE_TOKEN_CHARS = 100
const MAX_DRAIN_BYTES = 1024 * 1024
/** Browsers cap cookie lifetimes around this; the host's own expiry is what actually ends a session. */
export const LONGEST_COOKIE_SECONDS = 400 * 24 * 60 * 60

export type Headers = Record<string, string | string[]>

/** One request to an artifact's API, after admission: the artifact exists and the body was read. */
export interface ApiContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  /** The stored artifact's ID, never text taken from the request path. */
  artifactId: string
  origin: string
  now: number
  body: Record<string, unknown>
  sharing: SharingFields
  /** This browser's session on the artifact, valid or blocked. */
  session: SessionRecord | null
  /** Who the session acts as, when it may view the artifact right now. */
  access: Access | null
  /** The visitor cookie's secret. */
  visitor: string | null
}

export function send(res: http.ServerResponse, status: number, headers: Headers, body?: string | Buffer): void {
  const payload = body === undefined ? undefined : typeof body === 'string' ? Buffer.from(body) : body
  res.writeHead(status, { ...headers, ...(payload ? { 'content-length': String(payload.byteLength) } : {}) })
  res.end(payload)
}

export const json = (res: http.ServerResponse, status: number, body: unknown, extra: Headers = {}) =>
  send(res, status, { ...API_HEADERS, 'content-type': JSON_TYPE, ...extra }, JSON.stringify(body))
export const noContent = (res: http.ServerResponse, extra: Headers = {}) => send(res, 204, { ...API_HEADERS, ...extra })
/** The one answer for an artifact that is missing, private, expired, or not shared with whoever asks. */
export const apiNotFound = (res: http.ServerResponse) => json(res, 404, { error: 'not_found' })
export const apiForbidden = (res: http.ServerResponse) => json(res, 403, { error: 'forbidden' })
export const text = (res: http.ServerResponse, status: number, body: string) =>
  send(res, status, { ...API_HEADERS, 'content-type': TEXT_TYPE }, body)
export const notFound = (res: http.ServerResponse) => text(res, 404, 'Not found')

export function readCookie(req: http.IncomingMessage, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    return value.length > 0 && value.length <= MAX_COOKIE_TOKEN_CHARS ? value : null
  }
  return null
}

/** Scoped to one artifact's API, so it never crosses artifacts and is never sent to content paths. */
export function cookie(name: string, artifactId: string, origin: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/a/${artifactId}/api; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${
    origin.startsWith('https:') ? '; Secure' : ''
  }`
}

export const isJsonContent = (value: string | undefined): boolean => /^application\/json\s*(?:;|$)/i.test(value ?? '')

type Body = { ok: true; value: unknown } | { ok: false; status: 400 | 413 }

export function readJson(req: http.IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_API_BODY_BYTES) tooLarge = true
      if (size > MAX_DRAIN_BYTES) req.destroy()
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return resolve({ ok: false, status: 413 })
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        resolve({ ok: false, status: 400 })
      }
    })
    req.on('error', () => resolve({ ok: false, status: 400 }))
    // A destroyed request emits neither `end` nor `error`; settling twice is a no-op.
    req.on('close', () => resolve({ ok: false, status: tooLarge ? 413 : 400 }))
  })
}
