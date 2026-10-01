import { artifactRoute } from './artifact-routes.js'
import { OwnerMemory, ownerMemoryRequestHash } from './owner-memory.js'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { FleetNetwork } from './network.js'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_INTERNAL_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  FLEET_MESSAGE_BODY_MAX,
  FLEET_ARTIFACT_BODY_MAX,
  FLEET_SKILL_BODY_MAX,
  type FleetInternalOwnerMemorySaveRequest,
  type FleetRoutineRunReport,
  type FleetRoute,
  type FleetInternalPeerMessageRequest,
  type FleetCreateRoutineRequest,
  type FleetPatchRoutineRequest,
} from '@maestrly/bot-fleet-protocol'
import { ZodError } from 'zod'
import type { GatewayContext } from './context.js'
import { GatewayError, failure } from './errors.js'
import { publicRoute } from './routes/public.js'
import { Peers } from './peers.js'
import { Routines } from './routines.js'
import { ScreenProxy } from './screen.js'

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
async function readBody(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  if (Number(request.headers['content-length'] ?? 0) > maxBytes)
    throw new GatewayError('INVALID_REQUEST', 'Request body too large')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const part = Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new GatewayError('INVALID_REQUEST', 'Request body too large')
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
  const ownerMemory = ctx.ownerMemory ?? new OwnerMemory(ctx.store, ctx.lifecycle)
  const peers = ctx.peers ?? new Peers(ctx.store, ctx.lifecycle)
  const routines = ctx.routines ?? new Routines(ctx.store, ctx.lifecycle)
  const screen = ctx.screen ?? new ScreenProxy(ctx.lifecycle)
  const network = ctx.network ?? new FleetNetwork(ctx.lifecycle.docker, ctx.config.network)
  let refreshTimer: NodeJS.Timeout | null = null
  let revokeTimer: NodeJS.Timeout | null = null
  const revoking = new Set<string>()
  const revokeDevice = async (deviceId: string) => {
    if (revoking.has(deviceId)) return
    revoking.add(deviceId)
    try {
      screen.closeDevice(deviceId)
      ctx.events.closeDevice(deviceId)
      await Promise.allSettled(
        [...ctx.lifecycle.takeovers]
          .filter(([, state]) => state.deviceId === deviceId && state.state === 'human')
          .map(([id]) => ctx.lifecycle.releaseTakeover(id, deviceId, null, true, 'device_revoked'))
      )
    } finally {
      revoking.delete(deviceId)
    }
  }
  const sweepRevocations = async () => {
    await Promise.allSettled(
      ctx.store
        .listDevices()
        .filter((device) => device.revokedAt)
        .map((device) => revokeDevice(device.id))
    )
  }
  const activeCtx: GatewayContext = { ...ctx, ownerMemory, peers, routines, screen, revokeDevice }
  ctx.lifecycle.onTurnFinished = (id, event) => {
    if (event.inputId) routines.finishRun(id, event.inputId, event.outcome, event.text)
  }
  ctx.lifecycle.onReady = (id) => {
    void peers.retry(id)
  }
  const handler = (internal: boolean) => async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (
        internal
          ? !(network.insideFleet(req.socket.remoteAddress) || network.loopback(req.socket.remoteAddress))
          : network.insideFleet(req.socket.remoteAddress)
      )
        throw new GatewayError('FORBIDDEN', 'Network access forbidden')
      if (req.headers.origin !== undefined) throw new GatewayError('FORBIDDEN', 'Origin requests are forbidden')
      const url = new URL(req.url ?? '/', 'http://gateway')
      const match = matchRoute(internal ? FLEET_INTERNAL_ROUTES : FLEET_GATEWAY_ROUTES, req.method ?? '', url.pathname)
      if (!match) throw new GatewayError('NOT_FOUND', 'Route not found')
      if (
        !(internal === false && (match.key === 'meta' || match.key === 'pair')) &&
        req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== String(FLEET_PROTOCOL_VERSION)
      )
        throw new GatewayError('PROTOCOL_INCOMPATIBLE', 'Fleet protocol version mismatch')
      const caller = internal ? ctx.auth.internalBot(req.headers.authorization) : null
      if (!internal && match.key !== 'meta' && match.key !== 'pair') ctx.auth.device(req.headers.authorization)
      const body = match.route.body
        ? match.route.body.parse(
            await readBody(
              req,
              match.key === 'artifactUpload' || match.key === 'artifactBotUpload'
                ? FLEET_ARTIFACT_BODY_MAX
                : !internal && (match.key === 'botSkillInstall' || match.key === 'environmentSkillInstall')
                  ? FLEET_SKILL_BODY_MAX
                  : !internal && match.key === 'botMessageSend'
                    ? FLEET_MESSAGE_BODY_MAX
                    : 1024 * 1024
            )
          )
        : undefined
      if (match.key.startsWith('artifact')) {
        const identity = internal ? { botId: caller! } : { deviceId: ctx.auth.device(req.headers.authorization).id }
        const result = await artifactRoute(activeCtx, match.key, body, identity)
        return send(res, 200, match.route.response?.parse(result) ?? result)
      }
      if (internal) {
        if (match.key.startsWith('routine')) {
          const bot = ctx.store.getBot(caller!)
          if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
          let result: unknown
          let status = 200
          switch (match.key) {
            case 'routineRunReport':
              result = routines.report(caller!, match.params.rid, match.params.runId, body as FleetRoutineRunReport)
              break
            case 'routinesList':
              result = { routines: routines.list(caller!) }
              break
            case 'routineCreate':
              result = routines.create(caller!, body as FleetCreateRoutineRequest, 'bot')
              status = 201
              break
            case 'routinePatch':
              result = routines.patch(caller!, match.params.rid, body as FleetPatchRoutineRequest, 'bot')
              break
            case 'routineDelete':
              routines.delete(caller!, match.params.rid, 'bot')
              status = 204
          }
          send(res, status, match.route.response?.parse(result) ?? result)
        } else if (match.key.startsWith('ownerMemory')) {
          const bot = ctx.store.getBot(caller!)
          if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
          // A bot sees the global entries and its environment's, and writes only in its environment.
          if (match.key === 'ownerMemoryGet')
            return send(res, 200, match.route.response!.parse(ownerMemory.listFor(caller!)))
          if (match.key === 'ownerMemoryForget') {
            const { reason } = body as { reason: string }
            return send(res, 200, match.route.response!.parse(ownerMemory.forget(caller!, match.params.mid, reason)))
          }
          const request = body as FleetInternalOwnerMemorySaveRequest
          const { response, status } = ctx.store.idempotent(
            'botOwnerMemorySave:' + caller,
            request.idempotencyKey,
            ownerMemoryRequestHash(request),
            () => ({ response: ownerMemory.save({ kind: 'bot', botId: caller! }, request), status: 201 })
          )
          return send(res, status, match.route.response!.parse(response))
        } else {
          const result =
            match.key === 'peers'
              ? peers.list(caller!)
              : await peers.send(caller!, body as FleetInternalPeerMessageRequest)
          send(res, match.key === 'peers' ? 200 : 201, match.route.response?.parse(result) ?? result)
        }
        return
      }
      const result = await publicRoute(match.key, match.params, body, url, res, activeCtx)
      if (result.stream) return
      const response = result.body === undefined ? undefined : (match.route.response?.parse(result.body) ?? result.body)
      send(res, result.status ?? 200, response)
    } catch (error) {
      reject(res, error)
    }
  }
  const publicServer = http.createServer(handler(false))
  const internalServer = http.createServer(handler(true))
  publicServer.on('upgrade', (req, socket, head) => {
    let status = 404
    let error: GatewayError = new GatewayError('NOT_FOUND', 'Route not found')
    try {
      if (network.insideFleet(req.socket.remoteAddress)) throw new GatewayError('FORBIDDEN', 'Network access forbidden')
      if (req.headers.origin !== undefined) throw new GatewayError('FORBIDDEN', 'Origin requests are forbidden')
      if (new URL(req.url ?? '/', 'http://gateway').pathname !== FLEET_GATEWAY_ROUTES.screen.path)
        throw new GatewayError('NOT_FOUND', 'Route not found')
      screen.upgrade(req, socket, head)
      return
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
    routines,
    peers,
    screen,
    sweepRevocations,
    async listen() {
      await network.refresh()
      await ctx.artifacts?.start()
      refreshTimer = setInterval(() => {
        void network.refresh().catch(() => {})
      }, 60000)
      revokeTimer = setInterval(() => {
        void sweepRevocations()
      }, 10000)
      refreshTimer.unref()
      revokeTimer.unref()
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
      if (refreshTimer) clearInterval(refreshTimer)
      if (revokeTimer) clearInterval(revokeTimer)
      await ctx.artifacts?.close()
      routines.stop()
      screen.close()
      ctx.lifecycle.close()
      ctx.events.close()
      await Promise.all(
        [publicServer, internalServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      )
    },
  }
}
