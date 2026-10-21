import type { IncomingMessage, ServerResponse } from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import {
  FLEET_INSTANCE_BRIDGE_PATH,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  parseFleetInstanceEditorPath,
} from '@maestrly/bot-fleet-protocol'
import type { z } from 'zod'
import { type HostFilesRoutes, isHostFilesRoute, serveHostFilesRoute } from '../fleet/instance/host-files-http'
import { body, InstanceHttpError, rejectUpgrade, routeFor, sendInstanceError, writeJson } from '../fleet/instance/http'
import type { EditorRoutes } from '../fleet/instance/server'
import { PEER_PATHS, type PeerHello } from '../../shared/peer'
import type { RemoteOs } from '../../shared/remote-bridge'
import type { PeerIdentity } from './identity'
import { type HostPairings, PeerPairingError } from './pairing-host'
import {
  peerAbortRequestSchema,
  peerConfirmRequestSchema,
  peerExchangeRequestSchema,
  peerPairingRequestSchema,
} from './schemas'
import type { PeerStore } from './store'

export interface PeerServerDeps {
  identity: PeerIdentity
  /** The name this computer has now, which the owner may change while the server runs; the identity's by default. */
  name?: () => string
  appVersion: string
  os: RemoteOs
  store: Pick<PeerStore, 'authenticate' | 'touch' | 'remove'>
  pairings: Pick<HostPairings, 'accepting' | 'request' | 'exchange' | 'confirm' | 'abort'>
  /** The remote UI hub: each bridge is tagged with the paired computer it belongs to. */
  bridge: { handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, tag: string): void }
  hostFiles: HostFilesRoutes | null
  editor: EditorRoutes | null
  now(): number
}

const PAIRING_BODY_MAX = 64 * 1024
const PAIRING_STEP = /^\/v1\/peer\/pairings\/([0-9a-f-]{36})\/(exchange|confirm|abort)$/
/** A file range or a request of the editor may take long on a slow link, as on the control server of a host. */
const REQUEST_TIMEOUT_MS = 2 * 60 * 60_000

const remoteOf = (request: IncomingMessage): string => (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
const protocolMatches = (request: IncomingMessage): boolean =>
  request.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] === String(FLEET_PROTOCOL_VERSION)

/**
 * The HTTPS server through which the owner's paired computers use this one: who it is, pairing, and, for a paired
 * computer's token, the bridge to its windows, its editor, and its files. Web pages cannot reach it (`Origin` is refused),
 * and nothing past pairing answers without a token this computer issued.
 */
export function createPeerServer(deps: PeerServerDeps): https.Server {
  const hello = (): PeerHello => ({
    deviceId: deps.identity.deviceId,
    name: deps.name?.() ?? deps.identity.name,
    os: deps.os,
    appVersion: deps.appVersion,
    fingerprint: deps.identity.fingerprint,
    pairing: deps.pairings.accepting(),
  })

  const read = <T extends z.ZodType>(request: IncomingMessage, schema: T): Promise<z.infer<T>> =>
    body(request, schema, PAIRING_BODY_MAX) as Promise<z.infer<T>>

  async function pairing(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== 'POST') throw new InstanceHttpError(404, 'NOT_FOUND', 'Route not found.')
    try {
      if (url.pathname === PEER_PATHS.pairings) {
        const input = await read(request, peerPairingRequestSchema)
        return writeJson(response, 200, deps.pairings.request(input, remoteOf(request)))
      }
      const step = PAIRING_STEP.exec(url.pathname)
      if (!step) throw new InstanceHttpError(404, 'NOT_FOUND', 'Route not found.')
      const [, pairingId, name] = step
      if (name === 'exchange')
        return writeJson(
          response,
          200,
          deps.pairings.exchange(pairingId, await read(request, peerExchangeRequestSchema))
        )
      if (name === 'confirm')
        return writeJson(response, 200, deps.pairings.confirm(pairingId, await read(request, peerConfirmRequestSchema)))
      deps.pairings.abort(pairingId, await read(request, peerAbortRequestSchema))
      response.writeHead(204)
      response.end()
    } catch (error) {
      if (!(error instanceof PeerPairingError)) throw error
      writeJson(response, 409, { code: error.code, message: error.message })
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if ('origin' in request.headers) throw new InstanceHttpError(403, 'FORBIDDEN', 'Origin requests are forbidden.')
      const url = new URL(request.url ?? '/', 'https://peer')
      if (request.method === 'GET' && url.pathname === PEER_PATHS.hello) return writeJson(response, 200, hello())
      if (url.pathname === PEER_PATHS.pairings || url.pathname.startsWith(`${PEER_PATHS.pairings}/`))
        return await pairing(request, response, url)
      const peer = deps.store.authenticate(request.headers.authorization)
      if (!peer) throw new InstanceHttpError(401, 'UNAUTHORIZED', 'This computer is not paired.')
      deps.store.touch(peer.deviceId, deps.now(), remoteOf(request))
      if (request.method === 'DELETE' && url.pathname === PEER_PATHS.self) {
        deps.store.remove(peer.deviceId)
        response.writeHead(204)
        response.end()
        return
      }
      if (!protocolMatches(request))
        throw new InstanceHttpError(426, 'PROTOCOL_INCOMPATIBLE', 'Incompatible fleet protocol.')
      // The editor's requests stream both ways, as the editor sends and answers them.
      const editorPath = deps.editor ? parseFleetInstanceEditorPath(url.pathname) : null
      if (deps.editor && editorPath !== null)
        return await deps.editor.request(request, response, editorPath + url.search)
      const match = routeFor(request.method ?? '', url.pathname)
      if (!match || !isHostFilesRoute(match.key) || !deps.hostFiles)
        throw new InstanceHttpError(404, 'NOT_FOUND', 'Route not found.')
      return await serveHostFilesRoute(deps.hostFiles, { key: match.key, params: match.params }, request, response, url)
    } catch (error) {
      sendInstanceError(response, error)
    }
  }

  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => undefined)
    if ('origin' in request.headers) return rejectUpgrade(socket, 403, 'FORBIDDEN', 'Origin requests are forbidden.')
    const peer = deps.store.authenticate(request.headers.authorization)
    if (!peer) return rejectUpgrade(socket, 401, 'UNAUTHORIZED', 'This computer is not paired.')
    if (!protocolMatches(request))
      return rejectUpgrade(socket, 426, 'PROTOCOL_INCOMPATIBLE', 'Incompatible fleet protocol.')
    const url = new URL(request.url ?? '/', 'https://peer')
    deps.store.touch(peer.deviceId, deps.now(), remoteOf(request))
    if (request.method === 'GET' && url.pathname === FLEET_INSTANCE_BRIDGE_PATH) {
      if (request.headers.upgrade?.toLowerCase() !== 'websocket')
        return rejectUpgrade(socket, 400, 'INVALID_REQUEST', 'WebSocket upgrade required.')
      return deps.bridge.handleUpgrade(request, socket, head, peer.deviceId)
    }
    const editorPath = deps.editor ? parseFleetInstanceEditorPath(url.pathname) : null
    if (deps.editor && editorPath !== null && request.method === 'GET')
      return deps.editor.upgrade(request, socket, head, editorPath + url.search)
    rejectUpgrade(socket, 404, 'NOT_FOUND', 'Route not found.')
  }

  const server = https.createServer(
    { key: deps.identity.keyPem, cert: deps.identity.certPem, minVersion: 'TLSv1.2' },
    (request, response) => void handle(request, response)
  )
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.on('upgrade', upgrade)
  return server
}
