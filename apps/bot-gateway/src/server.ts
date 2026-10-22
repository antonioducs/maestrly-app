import { artifactRoute } from './artifact-routes.js'
import { isArtifactViewerRequest, viewerUnavailable } from './artifact-viewer-proxy.js'
import { OwnerMemory, ownerMemoryRequestHash } from './owner-memory.js'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { FleetNetwork } from './network.js'
import {
  type FleetGatewayEvent,
  FLEET_GATEWAY_ROUTES,
  FLEET_INTERNAL_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  FLEET_MESSAGE_BODY_MAX,
  FLEET_ARTIFACT_BODY_MAX,
  FLEET_SKILL_BODY_MAX,
  FLEET_DESKTOP_BRIDGE_LIMITS,
  FLEET_DICTATION_BODY_MAX,
  parseFleetGatewayEditorPath,
  type FleetInternalDesktopCallRequest,
  type FleetDesktopLinkRequest,
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
import { PeerThreads } from './peer-threads.js'
import { Routines } from './routines.js'
import { ScreenProxy } from './screen.js'
import { BridgeProxy, lifecycleBridgeDeps } from './bridge.js'
import { HostFilesProxy, isHostFileRoute, lifecycleHostFilesDeps } from './host-files.js'
import { disabledPushSender, ExpoPushSender, PushNotifier } from './push.js'
import { DictationService } from './dictation.js'
import { HostEditorProxy, lifecycleHostEditorDeps } from './host-editor.js'
import { DesktopBridge, lifecycleDesktopHosts } from './desktop-bridge.js'

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
  const peerThreads = ctx.peerThreads ?? new PeerThreads(ctx.store, ctx.lifecycle)
  const peers = ctx.peers ?? new Peers(ctx.store, ctx.lifecycle, Date.now, peerThreads)
  const routines = ctx.routines ?? new Routines(ctx.store, ctx.lifecycle)
  const screen = ctx.screen ?? new ScreenProxy(ctx.lifecycle)
  const network =
    ctx.network ?? new FleetNetwork(ctx.lifecycle.docker, ctx.config.network, () => ctx.lifecycle.isolatedNetworks())
  ctx.lifecycle.onNetworksChanged = () => void network.refresh().catch(() => {})
  const desktops =
    ctx.desktops ?? new DesktopBridge(ctx.store, ctx.events, { hosts: lifecycleDesktopHosts(ctx.lifecycle) })
  ctx.events.onBridgeChange = (deviceId) => desktops.deviceChanged(deviceId)
  ctx.lifecycle.onBotPurged = (id) => desktops.botPurged(id)
  ctx.lifecycle.onEnvironmentChanged = (id, formerlyLinked) => desktops.environmentChanged(id, formerlyLinked)
  const bridge = ctx.bridge ?? new BridgeProxy(lifecycleBridgeDeps(ctx.lifecycle))
  const hostFiles = ctx.hostFiles ?? new HostFilesProxy(lifecycleHostFilesDeps(ctx.lifecycle))
  const hostEditor = ctx.hostEditor ?? new HostEditorProxy(lifecycleHostEditorDeps(ctx.lifecycle))
  ctx.lifecycle.onCloseEnvironmentBridges = (id) => {
    bridge.closeEnvironment(id)
    hostFiles.closeEnvironment(id)
    hostEditor.closeEnvironment(id)
  }
  // A workspaces environment that a device uses through any of these, or that runs a bot's call, is not idle.
  ctx.lifecycle.hostConnections = (id) =>
    bridge.count(id) + hostFiles.count(id) + hostEditor.count(id) + desktops.environmentCalls(id)
  // Phones hear of what waits on the owner even while no app streams events.
  const push =
    ctx.push ??
    new PushNotifier({
      store: ctx.store,
      sender:
        ctx.config.push === 'off'
          ? disabledPushSender
          : new ExpoPushSender({ accessToken: ctx.config.expoAccessToken }),
      serverName: () => ctx.config.displayName ?? ctx.config.publicHost,
      log: (message) => console.error(JSON.stringify({ component: 'push', level: 'warn', message })),
    })
  const dictation = ctx.dictation ?? new DictationService(ctx.store)
  const observePush = (event: FleetGatewayEvent) => push.observe(event)
  ctx.events.observers.add(observePush)
  ctx.lifecycle.onChatAttention = (environmentId, conversationId, name, kind) =>
    void push.chat(environmentId, conversationId, name, kind)
  let refreshTimer: NodeJS.Timeout | null = null
  let revokeTimer: NodeJS.Timeout | null = null
  const revoking = new Set<string>()
  const revokeDevice = async (deviceId: string) => {
    if (revoking.has(deviceId)) return
    revoking.add(deviceId)
    try {
      screen.closeDevice(deviceId)
      bridge.closeDevice(deviceId)
      hostFiles.closeDevice(deviceId)
      hostEditor.closeDevice(deviceId)
      ctx.events.closeDevice(deviceId)
      desktops.revokeDevice(deviceId)
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
  const activeCtx: GatewayContext = {
    ...ctx,
    push,
    dictation,
    ownerMemory,
    peers,
    peerThreads,
    routines,
    screen,
    desktops,
    bridge,
    hostFiles,
    hostEditor,
    revokeDevice,
  }
  ctx.lifecycle.onTurnFinished = (id, event) => {
    // A turn of a thread's conversation: the thread was active, and no routine run is about it.
    if (event.runId && ctx.store.peerThreadSide(event.runId, id)) {
      peerThreads.touched(id, event.runId)
      return { threadId: event.runId }
    }
    return event.inputId
      ? routines.finishRun(id, {
          inputId: event.inputId,
          outcome: event.outcome,
          text: event.text,
          runId: event.runId,
          media: event.media,
        })
      : undefined
  }
  ctx.lifecycle.onTurnRunsChanged = (id, runIds) => peerThreads.turnsChanged(id, runIds)
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
      // The artifact viewer shares the public port. Its host checks Host, Origin, sessions and capabilities itself,
      // and its writes must carry the viewer's Origin; the fleet API below still refuses any Origin.
      if (!internal && isArtifactViewerRequest(req.url ?? '/')) {
        if (ctx.artifacts) await ctx.artifacts.serveViewer(req, res)
        else viewerUnavailable(res)
        return
      }
      if (req.headers.origin !== undefined) throw new GatewayError('FORBIDDEN', 'Origin requests are forbidden')
      const url = new URL(req.url ?? '/', 'http://gateway')
      // A workspaces environment's editor: any path under its prefix streams to the environment as it arrives.
      const editor = internal ? null : parseFleetGatewayEditorPath(url.pathname)
      if (editor) {
        if (req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== String(FLEET_PROTOCOL_VERSION))
          throw new GatewayError('PROTOCOL_INCOMPATIBLE', 'Fleet protocol version mismatch')
        const device = ctx.auth.device(req.headers.authorization)
        return await hostEditor.forward(editor.environmentId, editor.editorPath + url.search, req, res, device.id)
      }
      const match = matchRoute(internal ? FLEET_INTERNAL_ROUTES : FLEET_GATEWAY_ROUTES, req.method ?? '', url.pathname)
      if (!match) throw new GatewayError('NOT_FOUND', 'Route not found')
      if (
        !(internal === false && (match.key === 'meta' || match.key === 'pair')) &&
        req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== String(FLEET_PROTOCOL_VERSION)
      )
        throw new GatewayError('PROTOCOL_INCOMPATIBLE', 'Fleet protocol version mismatch')
      const internalCaller = internal ? ctx.auth.internalCaller(req.headers.authorization) : null
      const hostLinkRoute = internal && match.key.startsWith('hostDesktopLink')
      // A workspaces environment's token publishes its chats' artifacts and links the environment itself to bots; it
      // reaches nothing else of the internal API. Only that token links an environment: a bot's never does.
      if (internalCaller && 'environmentId' in internalCaller && !match.key.startsWith('artifact') && !hostLinkRoute)
        throw new GatewayError('FORBIDDEN', 'Host token is limited to artifacts and its own bot links')
      if (internalCaller && 'botId' in internalCaller && hostLinkRoute)
        throw new GatewayError('FORBIDDEN', 'Only a workspaces host links itself to a bot')
      const caller = internalCaller && 'botId' in internalCaller ? internalCaller.botId : null
      if (!internal && match.key !== 'meta' && match.key !== 'pair') ctx.auth.device(req.headers.authorization)
      // Host-file bodies are streamed to the workspaces host as they arrive; the gateway never buffers or parses them.
      if (!internal && isHostFileRoute(match.key))
        return await hostFiles.forward(
          match.key,
          match.params,
          url,
          req,
          res,
          ctx.auth.device(req.headers.authorization).id
        )
      const body = match.route.body
        ? match.route.body.parse(
            await readBody(
              req,
              match.key === 'artifactUpload' || match.key === 'artifactBotUpload'
                ? FLEET_ARTIFACT_BODY_MAX
                : !internal && (match.key === 'botSkillInstall' || match.key === 'environmentSkillInstall')
                  ? FLEET_SKILL_BODY_MAX
                  : !internal &&
                      (match.key === 'botMessageSend' ||
                        match.key === 'botMessageEdit' ||
                        match.key === 'botRunMessageSend')
                    ? FLEET_MESSAGE_BODY_MAX
                    : !internal && match.key === 'desktopCallResult'
                      ? FLEET_DESKTOP_BRIDGE_LIMITS.resultBytesMax
                      : !internal && match.key === 'dictationTranscribe'
                        ? FLEET_DICTATION_BODY_MAX
                        : 1024 * 1024
            )
          )
        : undefined
      if (match.key.startsWith('artifact')) {
        const identity = internal ? internalCaller! : { deviceId: ctx.auth.device(req.headers.authorization).id }
        const result = await artifactRoute(activeCtx, match.key, body, identity)
        return send(res, 200, match.route.response?.parse(result) ?? result)
      }
      if (internal) {
        if (hostLinkRoute) {
          // The environment is the one its token names, never anything in the request.
          const environmentId = (internalCaller as { environmentId: string }).environmentId
          if (match.key === 'hostDesktopLinks')
            return send(res, 200, match.route.response!.parse({ links: desktops.hostLinks(environmentId) }))
          if (match.key === 'hostDesktopLinkDelete') {
            desktops.unlinkEnvironment(match.params.id, environmentId)
            return send(res, 204)
          }
          const bot = ctx.store.getBot(match.params.id)
          if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
          const linked = desktops.linkEnvironment(bot.id, environmentId, (body as FleetDesktopLinkRequest).name)
          return send(res, 200, match.route.response!.parse(linked))
        }
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
              break
            // A bot reads its own runs, as its conversations show them to the owner.
            case 'routineRunsList':
              result = routines.page(caller!, {
                before: url.searchParams.get('before'),
                limit: Number(url.searchParams.get('limit') ?? 10) || 10,
                routineId: url.searchParams.get('routineId'),
              })
              break
            case 'routineRunGet':
              result = routines.get(caller!, match.params.runId)
              break
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
        } else if (match.key === 'desktops' || match.key === 'desktopCall') {
          // The calling bot is the one its token names; the Mac is the one its link names, never the bot's choice.
          const bot = ctx.store.getBot(caller!)
          if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
          if (match.key === 'desktops') return send(res, 200, { desktops: desktops.links(caller!) })
          const result = await desktops.call(caller!, body as FleetInternalDesktopCallRequest)
          return send(res, 200, match.route.response!.parse(result))
        } else if (match.key === 'peerThreadReport') {
          // A bot reports from its own side of a thread, the one its token names.
          const { text } = body as { text: string }
          return send(res, 200, match.route.response!.parse(peerThreads.report(caller!, match.params.threadId, text)))
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
      const { pathname, search } = new URL(req.url ?? '/', 'http://gateway')
      // A bridge ticket says which Origin, if any, its upgrade may carry (`phones`).
      if (pathname === FLEET_GATEWAY_ROUTES.bridge.path) return bridge.upgrade(req, socket, head)
      if (req.headers.origin !== undefined) throw new GatewayError('FORBIDDEN', 'Origin requests are forbidden')
      // The editor's WebSockets authenticate with the device token, as its requests do.
      const editor = parseFleetGatewayEditorPath(pathname)
      if (editor) {
        if (req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== String(FLEET_PROTOCOL_VERSION))
          throw new GatewayError('PROTOCOL_INCOMPATIBLE', 'Fleet protocol version mismatch')
        const device = ctx.auth.device(req.headers.authorization)
        return hostEditor.upgrade(editor.environmentId, editor.editorPath + search, req, socket, head, device.id)
      }
      if (pathname !== FLEET_GATEWAY_ROUTES.screen.path) throw new GatewayError('NOT_FOUND', 'Route not found')
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
    peerThreads,
    screen,
    bridge,
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
      desktops.close()
      await ctx.artifacts?.close()
      routines.stop()
      peerThreads.stop()
      screen.close()
      bridge.close()
      hostFiles.close()
      hostEditor.close()
      ctx.events.observers.delete(observePush)
      ctx.lifecycle.close()
      ctx.events.close()
      await Promise.all(
        [publicServer, internalServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      )
    },
  }
}
