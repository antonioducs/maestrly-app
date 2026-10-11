import {
  buildPath,
  FLEET_GATEWAY_ROUTES,
  FLEET_HOST_FILE_GATEWAY_ERRORS,
  FLEET_HOST_FILES_FEATURE,
  FLEET_INSTANCE_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  type FleetHostFileErrorReason,
  type FleetHostFileRouteKey,
  fleetErrorEnvelopeSchema,
  fleetHostFileErrorReason,
} from '@maestrly/bot-fleet-protocol'
import type { z } from 'zod'
import { type HostId, isRemoteHostId } from '../../shared/host-key'
import type { HostTransferError } from '../../shared/host-transfers'
import type { HostView } from '../../shared/hosts'
import type { DirectHost } from '../remote-host/client/host-registry'

const CALL_TIMEOUT_MS = 30_000
// One range or chunk; slow links and sleep are handled by retrying it, not by waiting longer.
const RAW_TIMEOUT_MS = 30 * 60 * 1_000
// The development host of unpackaged builds and tests (see host-registry).
const DIRECT_HOST_ID: HostId = 'direct/host'

type Routes = typeof FLEET_INSTANCE_ROUTES
type RawKey = 'hostFileContent' | 'hostFileUploadChunk'
type JsonKey = Exclude<FleetHostFileRouteKey, RawKey>
type BodyOf<K extends JsonKey> = Routes[K]['body'] extends z.ZodType ? z.input<Routes[K]['body']> : never
type ResultOf<K extends JsonKey> = Routes[K]['response'] extends z.ZodType ? z.output<Routes[K]['response']> : void

/** The host-file routes of one host, wherever it is reached. */
export interface HostFilesEndpoint {
  json<K extends JsonKey>(
    key: K,
    init: { params?: Record<string, string>; body?: BodyOf<K>; signal?: AbortSignal; timeoutMs?: number }
  ): Promise<ResultOf<K>>
  /** A request whose body or answer carries raw bytes; its answer is returned only when it succeeded. */
  raw(
    key: RawKey,
    init: {
      params?: Record<string, string>
      query?: Record<string, string | number>
      headers: Record<string, string>
      body?: Uint8Array
      signal?: AbortSignal
    }
  ): Promise<Response>
}

/** A refusal from the host or the gateway; `reason` names the host's refusals. */
export class HostFilesHttpError extends Error {
  readonly reason: FleetHostFileErrorReason | null
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.reason = fleetHostFileErrorReason(message)
  }
}
/** A transfer cannot go on as it is: the person decides what to do. */
export class TransferFailure extends Error {
  constructor(
    readonly reason: HostTransferError,
    message = ''
  ) {
    super(message)
  }
}
/** The host cannot be reached now: the transfer waits and tries again. */
export class TransientFailure extends Error {}

type SendInit = {
  params?: Record<string, string>
  query?: Record<string, string | number>
  headers: Record<string, string>
  body?: Uint8Array | string
  signal?: AbortSignal
  timeoutMs: number
}

export function httpHostFilesEndpoint(target: {
  origin: string
  headers: () => Record<string, string>
  path: (key: FleetHostFileRouteKey, params: Record<string, string>) => string
}): HostFilesEndpoint {
  const send = async (key: FleetHostFileRouteKey, init: SendInit): Promise<Response> => {
    const query = init.query
      ? '?' +
        new URLSearchParams(
          Object.fromEntries(Object.entries(init.query).map(([name, value]) => [name, String(value)]))
        )
      : ''
    let response: Response
    try {
      response = await fetch(target.origin + target.path(key, init.params ?? {}) + query, {
        method: FLEET_INSTANCE_ROUTES[key].method,
        headers: { ...target.headers(), ...init.headers },
        body: init.body as RequestInit['body'],
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(init.timeoutMs), ...(init.signal ? [init.signal] : [])]),
      })
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new TransientFailure(error instanceof Error ? error.message : String(error))
    }
    if (response.ok) return response
    const parsed = fleetErrorEnvelopeSchema.safeParse(await response.json().catch(() => null))
    throw new HostFilesHttpError(
      response.status,
      parsed.success ? parsed.data.code : 'INTERNAL',
      parsed.success ? parsed.data.message : `HTTP ${response.status}`
    )
  }
  return {
    async json(key, init) {
      const route = FLEET_INSTANCE_ROUTES[key]
      const body = init.body === undefined || !route.body ? undefined : JSON.stringify(route.body.parse(init.body))
      const response = await send(key, {
        params: init.params,
        signal: init.signal,
        timeoutMs: init.timeoutMs ?? CALL_TIMEOUT_MS,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body,
      })
      return (route.response ? route.response.parse(await response.json()) : undefined) as never
    },
    raw: (key, init) => send(key, { ...init, timeoutMs: RAW_TIMEOUT_MS }),
  }
}

/**
 * Where a host's files are reached: a server's workspaces through its paired gateway, with this device's
 * credentials, or the development host straight at its control server.
 */
export function resolveHostFilesEndpoint(
  hostId: HostId,
  deps: {
    registry: { list(): HostView[]; directHost(): DirectHost | null } | null
    fleet: {
      hostFilesAccess(): { origin: string; headers: Record<string, string> } | null
      hasFeature(feature: string): boolean
    }
  }
): HostFilesEndpoint {
  if (!deps.registry || !isRemoteHostId(hostId)) throw new TransferFailure('unknown-host')
  if (hostId === DIRECT_HOST_ID) {
    const direct = deps.registry.directHost()
    if (!direct) throw new TransferFailure('unknown-host')
    return httpHostFilesEndpoint({
      origin: direct.origin,
      headers: () => ({
        [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
        Authorization: `Bearer ${direct.token}`,
      }),
      path: (key, params) => buildPath(FLEET_INSTANCE_ROUTES[key].path, params),
    })
  }
  const environment = deps.registry.list().find((host) => host.id === hostId)?.environment
  if (!environment) throw new TransferFailure('unknown-host')
  if (environment.lifecycle !== 'running') throw new TransientFailure(FLEET_HOST_FILE_GATEWAY_ERRORS.notRunning)
  if (!deps.fleet.hasFeature(FLEET_HOST_FILES_FEATURE)) throw new TransferFailure('gateway-update-required')
  const access = deps.fleet.hostFilesAccess()
  if (!access) throw new TransferFailure('unauthorized')
  return httpHostFilesEndpoint({
    origin: access.origin,
    // Read on each request: the device token may be replaced while a transfer runs.
    headers: () => deps.fleet.hostFilesAccess()?.headers ?? access.headers,
    path: (key, params) => buildPath(FLEET_GATEWAY_ROUTES[key].path, { eid: environment.id, ...params }),
  })
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'ERR_STREAM_PREMATURE_CLOSE',
])
const HOST_REASONS: Partial<Record<FleetHostFileErrorReason, HostTransferError>> = {
  changed: 'changed',
  exists: 'exists',
  'not-found': 'not-found',
  'outside-roots': 'outside-roots',
  'not-a-file': 'not-a-file',
  'not-a-directory': 'not-a-directory',
  'invalid-name': 'invalid-name',
  'digest-mismatch': 'verification-failed',
  'chunk-mismatch': 'verification-failed',
  'unknown-upload': 'verification-failed',
}

const codeOf = (error: unknown): string | undefined => {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null
  const code = value?.code ?? value?.cause?.code
  return typeof code === 'string' ? code : undefined
}

/** Whether a transfer stopped by `error` waits for the host to come back, or fails with a reason to show. */
export function classifyTransferError(error: unknown): {
  transient: boolean
  reason: HostTransferError
  message: string | null
} {
  const message = error instanceof Error && error.message ? error.message : null
  const transient = { transient: true, reason: 'unknown' as const, message }
  const failed = (reason: HostTransferError) => ({ transient: false, reason, message })
  if (error instanceof TransferFailure) return failed(error.reason)
  if (error instanceof TransientFailure) return transient
  if (error instanceof HostFilesHttpError) {
    if (error.reason) return failed(HOST_REASONS[error.reason] ?? 'unknown')
    if (error.message === FLEET_HOST_FILE_GATEWAY_ERRORS.updateHost) return failed('host-update-required')
    if (error.message === FLEET_HOST_FILE_GATEWAY_ERRORS.notRunning) return transient
    if (error.code === 'BOT_NOT_RUNNING' || error.code === 'INSTANCE_UNAVAILABLE' || error.status >= 500)
      return transient
    if (error.status === 401) return failed('unauthorized')
    // The instance's answer to a route it lacks: an image from before host files.
    if (error.status === 404 && error.message === 'Route not found.') return failed('host-update-required')
    if (error.status === 404 && error.message === 'Route not found') return failed('gateway-update-required')
    return failed('unknown')
  }
  const code = codeOf(error)
  if (code === 'ENOSPC') return failed('disk-full')
  if (code && NETWORK_CODES.has(code)) return transient
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'AbortError' || name === 'TimeoutError' || error instanceof TypeError) return transient
  return failed('unknown')
}
