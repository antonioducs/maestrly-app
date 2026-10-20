import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fleetBotIdSchema, fleetFileIdSchema } from '@maestrly/bot-fleet-protocol'
import { FLEET_MEDIA_SCHEME } from '../../../shared/fleet-media'
import { type FleetServerId, isFleetServerId } from '../../../shared/fleet-servers'
import type { FleetMediaEntry } from './media-cache'

export type FleetMediaRequest = { serverId: FleetServerId; botId: string; fileId: string; capability: string }

/**
 * Media URLs name the server and carry an unguessable capability bound to this run, the server, the pairing, the bot
 * and the file: other pages of the app's session cannot name a video the owner did not open, and a URL stops working
 * when the app restarts.
 */
export class FleetMediaUrls {
  private readonly secret = randomBytes(32)

  private capability(serverId: FleetServerId, scope: string, botId: string, fileId: string): Buffer {
    return createHmac('sha256', this.secret)
      .update(`${serverId}\0${scope}\0${botId}\0${fileId}`)
      .digest()
      .subarray(0, 16)
  }

  url(serverId: FleetServerId, scope: string, botId: string, fileId: string): string {
    const capability = this.capability(serverId, scope, botId, fileId).toString('hex')
    return `${FLEET_MEDIA_SCHEME}://fleet/${serverId}/${botId}/${fileId}/${capability}`
  }

  verify(serverId: FleetServerId, scope: string, request: FleetMediaRequest): boolean {
    if (request.serverId !== serverId) return false
    const given = Buffer.from(request.capability, 'hex')
    const expected = this.capability(serverId, scope, request.botId, request.fileId)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
}

export function parseFleetMediaUrl(value: string): FleetMediaRequest | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== `${FLEET_MEDIA_SCHEME}:` || url.hostname !== 'fleet' || url.search || url.username) return null
  const parts = url.pathname.split('/')
  if (parts.length !== 5 || parts[0] !== '') return null
  const [, serverId, botId, fileId, capability] = parts as [string, string, string, string, string]
  if (
    !isFleetServerId(serverId) ||
    !fleetBotIdSchema.safeParse(botId).success ||
    !fleetFileIdSchema.safeParse(fileId).success ||
    !/^[0-9a-f]{32}$/.test(capability)
  )
    return null
  return { serverId, botId, fileId, capability }
}

/**
 * One byte range of a `Range` header (RFC 9110 §14), `null` to send the whole file, or `unsatisfiable`. Several
 * ranges and malformed headers are ignored, which the RFC allows: media elements ask for one range at a time.
 */
export function parseByteRange(
  header: string | null,
  size: number
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null
  const first = match[1] ? Number(match[1]) : null
  const last = match[2] ? Number(match[2]) : null
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null
  if (first === null) {
    if (last === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - last!), end: size - 1 }
  }
  if (last !== null && last < first) return null
  if (first >= size) return 'unsatisfiable'
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) }
}

const baseHeaders = {
  'Accept-Ranges': 'bytes',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: code, headers: { ...baseHeaders, ...headers } })
}

/**
 * Answers a `maestrly-media:` request from the cache, with byte ranges so the player seeks without reading the file
 * from the start. `resolve` returns null for an unknown capability or a file the bot no longer has.
 */
export async function serveFleetMedia(
  request: Request,
  resolve: (request: FleetMediaRequest) => Promise<FleetMediaEntry | null>
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return status(405, { Allow: 'GET, HEAD' })
  const target = parseFleetMediaUrl(request.url)
  if (!target) return status(404)
  let entry: FleetMediaEntry | null
  try {
    entry = await resolve(target)
  } catch {
    return status(502)
  }
  if (!entry) return status(404)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(entry.path, 'r')
  } catch {
    return status(404)
  }
  try {
    const size = (await handle.stat()).size
    if (size !== entry.ref.byteSize) {
      await handle.close()
      return status(404)
    }
    const range = parseByteRange(request.headers.get('range'), size)
    if (range === 'unsatisfiable') {
      await handle.close()
      return status(416, { 'Content-Range': `bytes */${size}` })
    }
    const start = range?.start ?? 0
    const end = range?.end ?? size - 1
    const headers: Record<string, string> = {
      ...baseHeaders,
      'Content-Type': entry.mediaType,
      'Content-Length': String(range ? end - start + 1 : size),
    }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    if (request.method === 'HEAD' || size === 0) {
      await handle.close()
      return new Response(null, { status: range ? 206 : 200, headers })
    }
    // The stream owns the handle from here and closes it when the player stops reading.
    const body = Readable.toWeb(handle.createReadStream({ start, end })) as ReadableStream<Uint8Array>
    return new Response(body, { status: range ? 206 : 200, headers })
  } catch {
    await handle.close().catch(() => undefined)
    return status(500)
  }
}
