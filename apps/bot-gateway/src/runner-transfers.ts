import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import {
  FLEET_INSTANCE_ROUTES,
  FLEET_PORTS,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  FLEET_RUNNER_JOBS_CAPABILITY,
  FLEET_RUNNER_LIMITS,
  FLEET_RUNNER_TRANSFER_ROUTE_KEYS,
  buildPath,
  type FleetRunnerTransferRouteKey,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'
import { endToEnd, upstreamHeaders } from './forward-headers.js'
import type { Lifecycle } from './lifecycle.js'

const INSTANCE_ROUTE: Record<FleetRunnerTransferRouteKey, keyof typeof FLEET_INSTANCE_ROUTES> = {
  runnerJobManifest: 'botRunnerJobManifest',
  runnerJobBlobs: 'botRunnerJobBlobs',
  runnerJobLog: 'botRunnerJobLog',
  runnerJobOutputs: 'botRunnerJobOutputs',
  runnerJobOutputChunk: 'botRunnerJobOutputChunk',
  runnerJobOutputCommit: 'botRunnerJobOutputCommit',
}
const BODY_LIMITS: Record<FleetRunnerTransferRouteKey, number> = {
  runnerJobManifest: 0,
  runnerJobBlobs: FLEET_RUNNER_LIMITS.blobRequestBytesMax,
  runnerJobLog: FLEET_RUNNER_LIMITS.logBatchBytesMax,
  runnerJobOutputs: 0,
  runnerJobOutputChunk: FLEET_RUNNER_LIMITS.outputChunkBytes + FLEET_RUNNER_LIMITS.chunkBodySlackBytes,
  runnerJobOutputCommit: 64 * 1024,
}
// What only the runner and the gateway share: never forwarded to the environment.
const CALLER_HEADERS = ['authorization', 'host', 'cookie', FLEET_PROTOCOL_HEADER.toLowerCase()]

export const isRunnerTransferRoute = (key: string): key is FleetRunnerTransferRouteKey =>
  (FLEET_RUNNER_TRANSFER_ROUTE_KEYS as readonly string[]).includes(key)

export interface RunnerTransfersDeps {
  /** The bot whose job this is, once the asking computer may move these files of it now; throws otherwise. */
  authorize(jobId: string, deviceId: string, key: FleetRunnerTransferRouteKey): string
  /** The address and control token of a bot's environment while it serves runner jobs; null otherwise. */
  target(botId: string): { host: string; secret: string } | null
  instancePort: number
  /** A transfer whose environment says nothing for this long is cut. */
  idleTimeoutMs: number
}

/** Where a gateway's relay reaches a bot's environment: its container, while it runs a Maestrly with `runner-jobs`. */
export function lifecycleRunnerTargets(
  lifecycle: Lifecycle
): Pick<RunnerTransfersDeps, 'target' | 'instancePort' | 'idleTimeoutMs'> {
  return {
    target: (botId) => {
      const bot = lifecycle.get(botId)
      if (!bot?.environmentId || bot.lifecycle !== 'running' || bot.move) return null
      const environment = lifecycle.store.getEnvironment(bot.environmentId)
      if (
        environment?.lifecycle !== 'running' ||
        !lifecycle.environmentCapabilities(environment.id).includes(FLEET_RUNNER_JOBS_CAPABILITY)
      )
        return null
      const secret = lifecycle.store.environmentSecrets(environment.id)?.controlToken
      return secret ? { host: environment.containerName, secret } : null
    },
    instancePort: FLEET_PORTS.instanceControl,
    idleTimeoutMs: 120_000,
  }
}

type Transfer = {
  deviceId: string
  request: IncomingMessage
  response: ServerResponse
  upstream: http.ClientRequest | null
}

/**
 * A runner's requests for a job's files, passed to the job's bot environment as they are: bodies and answers stream
 * through untouched, with the environment's control token in place of the runner's. The gateway checks only that
 * the job is the runner's, that its state allows the transfer, and how much is sent; the environment checks paths and
 * checksums, and nothing is stored here.
 */
export class RunnerTransfers {
  private readonly active = new Set<Transfer>()
  constructor(private readonly deps: RunnerTransfersDeps) {}
  forward(
    key: FleetRunnerTransferRouteKey,
    params: Record<string, string>,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string
  ): Promise<void> {
    const botId = this.deps.authorize(params.jobId, deviceId, key)
    const target = this.deps.target(botId)
    if (!target) throw new GatewayError('INSTANCE_UNAVAILABLE', "The job's bot environment cannot serve it now.")
    const declared = Number(request.headers['content-length'] ?? 0)
    if (
      request.headers['transfer-encoding'] !== undefined ||
      !Number.isSafeInteger(declared) ||
      declared > BODY_LIMITS[key]
    )
      throw new GatewayError('INVALID_REQUEST', 'Request body too large')
    const headers = upstreamHeaders(request)
    for (const name of CALLER_HEADERS) delete headers[name]
    headers[FLEET_PROTOCOL_HEADER] = String(FLEET_PROTOCOL_VERSION)
    headers.authorization = 'Bearer ' + target.secret
    const transfer: Transfer = { deviceId, request, response, upstream: null }
    this.active.add(transfer)
    return new Promise<void>((resolve) => {
      const upstream = http.request({
        host: target.host,
        port: this.deps.instancePort,
        method: request.method,
        path: buildPath(FLEET_INSTANCE_ROUTES[INSTANCE_ROUTE[key]].path, { ...params, botId }) + url.search,
        headers,
        agent: false,
      })
      transfer.upstream = upstream
      upstream.setTimeout(this.deps.idleTimeoutMs, () => upstream.destroy(new Error('Runner transfer went silent')))
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
          JSON.stringify({ code: 'INSTANCE_UNAVAILABLE', message: "The job's bot environment did not answer." })
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
  /** A revoked computer loses its transfers. */
  closeDevice(deviceId: string): void {
    for (const transfer of [...this.active]) if (transfer.deviceId === deviceId) this.cut(transfer)
  }
  count(): number {
    return this.active.size
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
