import { FLEET_INSTANCE_ROUTES } from '@maestrly/bot-fleet-protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { z } from 'zod'

/** What the control servers of this app share: their errors, JSON bodies, and the routes of the instance API. */
export class InstanceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export const errorStatus = (status: number): string =>
  (
    ({
      400: 'INVALID_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      426: 'PROTOCOL_INCOMPATIBLE',
    }) as Record<number, string>
  )[status] ?? 'INTERNAL'

export function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

/** Answers a failed request with its error, or drops a response that already started. */
export function sendInstanceError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) {
    response.destroy()
    return
  }
  const known =
    error instanceof InstanceHttpError ? error : new InstanceHttpError(500, 'INTERNAL', 'Instance request failed.')
  writeJson(response, known.status, { code: known.code || errorStatus(known.status), message: known.message })
}

/** Refuses an upgrade with a JSON error, on a socket nothing answered yet. */
export function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
  if (socket.destroyed) return
  const text = JSON.stringify({ code, message })
  socket.end(
    `HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`
  )
}

export const DEFAULT_BODY_MAX = 1_048_576
export async function body(request: IncomingMessage, schema: z.ZodType | null, maxBytes: number): Promise<unknown> {
  if (schema && !request.headers['content-type']?.startsWith('application/json'))
    throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Expected a JSON request body.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Request body too large.')
    chunks.push(bytes)
  }
  if (!schema) return undefined
  try {
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch (error) {
    if (error instanceof InstanceHttpError) throw error
    throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid request body.')
  }
}

export type RouteKey = keyof typeof FLEET_INSTANCE_ROUTES
const COMPILED_ROUTES = (Object.keys(FLEET_INSTANCE_ROUTES) as RouteKey[]).map((key) => {
  const route = FLEET_INSTANCE_ROUTES[key]
  const names: string[] = []
  const pattern = route.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name: string) => {
    names.push(name)
    return '([^/]+)'
  })
  return { key, method: route.method as string, pattern: new RegExp('^' + pattern + '$'), names }
})
/** The route of a request with its decoded parameters, or null when none matches or a parameter is malformed. */
export function routeFor(method: string, pathname: string): { key: RouteKey; params: Record<string, string> } | null {
  for (const route of COMPILED_ROUTES) {
    if (route.method !== method) continue
    const match = route.pattern.exec(pathname)
    if (!match) continue
    const params: Record<string, string> = {}
    try {
      route.names.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1])
      })
    } catch {
      return null
    }
    return { key: route.key, params }
  }
  return null
}
