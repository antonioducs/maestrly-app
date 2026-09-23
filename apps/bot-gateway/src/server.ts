import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_INTERNAL_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  type FleetRoute,
} from '@maestrly/bot-fleet-protocol'
import { ZodError } from 'zod'
import type { GatewayContext } from './context.js'
import { GatewayError, failure } from './errors.js'
import { publicRoute } from './routes/public.js'

type Match = { key: string; params: Record<string, string>; route: FleetRoute }
function matchRoute(routes: Record<string, FleetRoute>, method: string, path: string): Match | null {
  for (const [key, route] of Object.entries(routes)) {
    if (route.method !== method) continue
    const names = [...route.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1])
    const pattern = '^' + route.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, '([^/]+)') + '$'
    const match = new RegExp(pattern).exec(path)
    if (match)
      return {
        key,
        route,
        params: Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])])),
      }
  }
  return null
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers['content-length'] ?? 0) > 1024 * 1024)
    throw new GatewayError('INVALID_REQUEST', 'Request body too large')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const part = Buffer.from(chunk)
    bytes += part.length
    if (bytes > 1024 * 1024) throw new GatewayError('INVALID_REQUEST', 'Request body too large')
    chunks.push(part)
  }
  if (!bytes) throw new GatewayError('INVALID_REQUEST', 'JSON body required')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new GatewayError('INVALID_REQUEST', 'Invalid JSON body')
  }
}
function send(res: ServerResponse, status: number, body?: unknown) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (status === 204) {
    res.writeHead(status)
    res.end()
    return
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.writeHead(status)
  res.end(JSON.stringify(body))
}
function reject(res: ServerResponse, error: unknown) {
  const mapped = error instanceof ZodError ? new GatewayError('INVALID_REQUEST', 'Invalid request') : failure(error)
  send(res, mapped.status, {
    code: mapped.code,
    message: mapped.message,
    ...(mapped.details ? { details: mapped.details } : {}),
  })
}
export function createGatewayServers(ctx: GatewayContext) {
  const handler = (internal: boolean) => async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.headers.origin !== undefined) throw new GatewayError('FORBIDDEN', 'Origin requests are forbidden')
      const url = new URL(req.url ?? '/', 'http://gateway')
      const match = matchRoute(internal ? FLEET_INTERNAL_ROUTES : FLEET_GATEWAY_ROUTES, req.method ?? '', url.pathname)
      if (!match) throw new GatewayError('NOT_FOUND', 'Route not found')
      if (
        !(internal === false && (match.key === 'meta' || match.key === 'pair')) &&
        req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== String(FLEET_PROTOCOL_VERSION)
      )
        throw new GatewayError('PROTOCOL_INCOMPATIBLE', 'Fleet protocol version mismatch')
      if (internal) ctx.auth.internalBot(req.headers.authorization)
      else if (match.key !== 'meta' && match.key !== 'pair') ctx.auth.device(req.headers.authorization)
      const body = match.route.body ? match.route.body.parse(await readBody(req)) : undefined
      if (internal) throw new GatewayError('INTERNAL', 'Not implemented yet')
      const result = await publicRoute(match.key, match.params, body, url, res, ctx)
      if (result.stream) return
      const response = result.body === undefined ? undefined : (match.route.response?.parse(result.body) ?? result.body)
      send(res, result.status ?? 200, response)
    } catch (error) {
      reject(res, error)
    }
  }
  const publicServer = http.createServer(handler(false))
  const internalServer = http.createServer(handler(true))
  publicServer.on('upgrade', (req, socket) => {
    let status = 501
    let error: GatewayError = new GatewayError('INTERNAL', 'Not implemented yet')
    try {
      if (req.headers.origin !== undefined) throw new GatewayError('FORBIDDEN', 'Origin requests are forbidden')
      if (new URL(req.url ?? '/', 'http://gateway').pathname !== FLEET_GATEWAY_ROUTES.screen.path)
        throw new GatewayError('NOT_FOUND', 'Route not found')
      if (req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== String(FLEET_PROTOCOL_VERSION))
        throw new GatewayError('PROTOCOL_INCOMPATIBLE', 'Fleet protocol version mismatch')
      ctx.auth.device(req.headers.authorization)
    } catch (caught) {
      error = failure(caught)
      status = error.status
    }
    const response = JSON.stringify({ code: error.code, message: error.message })
    socket.end(
      'HTTP/1.1 ' +
        status +
        ' Error\r\nContent-Type: application/json\r\nX-Content-Type-Options: nosniff\r\nContent-Length: ' +
        Buffer.byteLength(response) +
        '\r\n\r\n' +
        response
    )
  })
  return {
    publicServer,
    internalServer,
    async listen() {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          publicServer.once('error', reject).listen(ctx.config.publicPort, ctx.config.publicHost, resolve)
        ),
        new Promise<void>((resolve, reject) =>
          internalServer.once('error', reject).listen(ctx.config.internalPort, '0.0.0.0', resolve)
        ),
      ])
    },
    async close() {
      ctx.events.close()
      await Promise.all(
        [publicServer, internalServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      )
    },
  }
}
