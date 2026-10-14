import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import {
  FLEET_HOST_FILE_GATEWAY_ERRORS,
  FLEET_HOST_FILE_LIMITS,
  FLEET_HOST_FILE_ROUTE_KEYS,
  FLEET_HOST_FILES_FEATURE,
  FLEET_INSTANCE_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  type FleetHostFileRouteKey,
  buildPath,
} from '@maestrly/bot-fleet-protocol'
import { lifecycleBridgeDeps } from './bridge.js'
import { GatewayError } from './errors.js'
import { endToEnd, upstreamHeaders } from './forward-headers.js'
import type { Lifecycle } from './lifecycle.js'

const SLOW: ReadonlySet<FleetHostFileRouteKey> = new Set(['hostFileDigest', 'hostFileUploadCommit'])
const JSON_BODY_MAX = 64 * 1024
const BODY_LIMITS: Record<FleetHostFileRouteKey, number> = {
  hostFileStat: JSON_BODY_MAX,
  hostFileDigest: JSON_BODY_MAX,
  hostFileUploadBegin: JSON_BODY_MAX,
  hostFileUploadCommit: JSON_BODY_MAX,
  hostFileContent: 0,
  hostFileUploadAbort: 0,
  hostFileUploadChunk: FLEET_HOST_FILE_LIMITS.uploadChunkBytes + FLEET_HOST_FILE_LIMITS.chunkBodySlackBytes,
}
// What only the device and the gateway share: never forwarded to the environment.
const CALLER_HEADERS = ['authorization', 'host', 'cookie', FLEET_PROTOCOL_HEADER.toLowerCase()]

export interface HostFilesProxyDeps {
  host: (environmentId: string) => string | null
  secret: (environmentId: string) => string | null
  /** Whether the environment's Maestrly serves host files. */
  supports: (environmentId: string) => boolean
  instancePort: number
  /** A transfer whose environment says nothing for this long is cut. */
  idleTimeoutMs: number
  /** The same for routes that hash a whole file before they answer. */
  slowTimeoutMs: number
}

/** What a gateway's host-file proxy reads from its lifecycle and store: the same container the bridge reaches. */
export function lifecycleHostFilesDeps(lifecycle: Lifecycle): HostFilesProxyDeps {
  const bridge = lifecycleBridgeDeps(lifecycle)
  return {
    host: bridge.host,
    secret: bridge.secret,
    instancePort: bridge.instancePort,
    supports: (id) => lifecycle.environmentCapabilities(id).includes(FLEET_HOST_FILES_FEATURE),
    idleTimeoutMs: 120_000,
    slowTimeoutMs: 6 * 60 * 60 * 1_000,
  }
}

export const isHostFileRoute = (key: string): key is FleetHostFileRouteKey =>
  (FLEET_HOST_FILE_ROUTE_KEYS as readonly string[]).includes(key)

type Transfer = {
  deviceId: string
  environmentId: string
  request: IncomingMessage
  response: ServerResponse
  upstream: http.ClientRequest | null
}

/**
 * Host-file requests of a paired device, passed to its workspaces environment as they are: bodies, ranges and the
 * host's answers stream through untouched, with the environment's control token in place of the device's. The
 * gateway only checks who asks and how much they send; the host checks paths and checksums.
 */
export class HostFilesProxy {
  private readonly active = new Set<Transfer>()

  constructor(private readonly deps: HostFilesProxyDeps) {}

  forward(
    key: FleetHostFileRouteKey,
    params: Record<string, string>,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string
  ): Promise<void> {
    const environmentId = params.eid
    const host = this.deps.host(environmentId)
    const secret = this.deps.secret(environmentId)
    if (!host || !secret) throw new GatewayError('CONFLICT', FLEET_HOST_FILE_GATEWAY_ERRORS.notRunning)
    if (!this.deps.supports(environmentId))
      throw new GatewayError('CONFLICT', FLEET_HOST_FILE_GATEWAY_ERRORS.updateHost)
    const declared = Number(request.headers['content-length'] ?? 0)
    if (
      request.headers['transfer-encoding'] !== undefined ||
      !Number.isSafeInteger(declared) ||
      declared > BODY_LIMITS[key]
    )
      throw new GatewayError('INVALID_REQUEST', 'Request body too large')
    const { eid: _environment, ...routeParams } = params
    const headers = upstreamHeaders(request)
    for (const name of CALLER_HEADERS) delete headers[name]
    headers[FLEET_PROTOCOL_HEADER] = String(FLEET_PROTOCOL_VERSION)
    headers.authorization = 'Bearer ' + secret
    const transfer: Transfer = { deviceId, environmentId, request, response, upstream: null }
    this.active.add(transfer)
    return new Promise<void>((resolve) => {
      const upstream = http.request({
        host,
        port: this.deps.instancePort,
        method: request.method,
        path: buildPath(FLEET_INSTANCE_ROUTES[key].path, routeParams) + url.search,
        headers,
        agent: false,
      })
      transfer.upstream = upstream
      upstream.setTimeout(SLOW.has(key) ? this.deps.slowTimeoutMs : this.deps.idleTimeoutMs, () =>
        upstream.destroy(new Error('Host file transfer went silent'))
      )
      upstream.on('response', (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, endToEnd(incoming.headers))
        incoming.on('error', () => response.destroy())
        incoming.on('aborted', () => response.destroy())
        incoming.pipe(response)
      })
      upstream.on('error', () => {
        if (response.headersSent) return void response.destroy()
        response.writeHead(503, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(
          JSON.stringify({ code: 'INSTANCE_UNAVAILABLE', message: 'The workspaces environment did not answer.' })
        )
      })
      response.on('close', () => {
        if (!response.writableFinished) upstream.destroy()
        this.active.delete(transfer)
        resolve()
      })
      request.on('aborted', () => upstream.destroy())
      request.pipe(upstream)
    })
  }

  /** A revoked device loses its transfers. */
  closeDevice(deviceId: string): void {
    for (const transfer of [...this.active]) if (transfer.deviceId === deviceId) this.cut(transfer)
  }
  /** The environment's container stops or goes away. */
  closeEnvironment(environmentId: string): void {
    for (const transfer of [...this.active]) if (transfer.environmentId === environmentId) this.cut(transfer)
  }
  /** The transfers in progress to or from an environment. */
  count(environmentId: string): number {
    return [...this.active].filter((transfer) => transfer.environmentId === environmentId).length
  }
  close(): void {
    for (const transfer of [...this.active]) this.cut(transfer)
  }
  private cut(transfer: Transfer): void {
    this.active.delete(transfer)
    transfer.upstream?.destroy()
    transfer.request.destroy()
    transfer.response.destroy()
  }
}
