import {
  buildPath,
  FLEET_GATEWAY_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  FLEET_RUNNER_HEADERS,
  FLEET_RUNNER_LOG_OFFSET_QUERY,
  type FleetRunnerJobFinishRequest,
  type FleetRunnerJobUsageRequest,
  type FleetRunnerManifest,
  type FleetRunnerOutputCommit,
  type FleetRunnerStateRequest,
  type FleetRunnerStateResponse,
  fleetErrorEnvelopeSchema,
  fleetRunnerManifestSchema,
  fleetRunnerOutputStatusSchema,
} from '@maestrly/bot-fleet-protocol'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/**
 * A refusal or failure of a runner route. `transient` says that asking again later may work: the gateway or the
 * network did not answer, or the bot's environment was unavailable. A 409 on a chunk or log offset is not transient;
 * its callers read where the other side stands and go on from there.
 */
export class RunnerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly transient: boolean
  ) {
    super(message)
    this.name = 'RunnerApiError'
  }
}

/** Whether an error is a failure of the gateway or the network that a later attempt may get past. */
export const isTransientApiError = (error: unknown): boolean => error instanceof RunnerApiError && error.transient

/** The routes a runner calls on one paired gateway, with the device token already applied. */
export interface RunnerJobApi {
  /** Reports whether this computer takes jobs, what it is, and the jobs it holds; answers the jobs to stop. */
  report(state: FleetRunnerStateRequest): Promise<FleetRunnerStateResponse>
  accept(jobId: string): Promise<void>
  /** The command ended and the outputs are being sent. */
  progress(jobId: string): Promise<void>
  finish(jobId: string, result: FleetRunnerJobFinishRequest): Promise<void>
  /** What the running job uses now. The gateway keeps the last sample; a caller sends one now and then and does not retry. */
  usage(jobId: string, sample: FleetRunnerJobUsageRequest, signal?: AbortSignal): Promise<void>
  manifest(jobId: string, signal?: AbortSignal): Promise<FleetRunnerManifest>
  /** The raw answer: a zstd tar of the blobs asked for, in the order asked. The caller reads it to its end. */
  blobs(jobId: string, digests: readonly string[], signal?: AbortSignal): Promise<Readable>
  /** Sends log bytes that start at `offset` of the job's log; the same batch sent again lands where it did before. */
  log(jobId: string, offset: number, bytes: Buffer, signal?: AbortSignal): Promise<void>
  /** How many bytes of the output archive the environment holds. */
  outputsStatus(jobId: string, signal?: AbortSignal): Promise<{ received: number }>
  outputChunk(jobId: string, offset: number, bytes: Buffer, sha256: string, signal?: AbortSignal): Promise<void>
  outputCommit(jobId: string, commit: FleetRunnerOutputCommit, signal?: AbortSignal): Promise<void>
}

const CALL_TIMEOUT_MS = 30_000
// The manifest of a large folder takes the environment a while to build.
const MANIFEST_TIMEOUT_MS = 5 * 60_000
// One chunk; slow links and sleep are handled by sending it again, not by waiting longer.
const CHUNK_TIMEOUT_MS = 30 * 60_000
// A blob stream lives as long as its caller's signal once it started: only its start is timed.
const STREAM_START_TIMEOUT_MS = 5 * 60_000
const TRANSIENT_STATUSES = new Set([408, 425, 429])
const JSON_HEADERS = { 'content-type': 'application/json' }

type RouteKey = keyof typeof FLEET_GATEWAY_ROUTES
type Call = {
  key: RouteKey
  params?: Record<string, string | number>
  query?: Record<string, string | number>
  headers?: Record<string, string>
  body?: Uint8Array | string
  signal?: AbortSignal
  timeoutMs: number
  /** The timeout covers only the wait for the answer to start; its body then lives as long as `signal`. */
  streaming?: boolean
}

/** The runner routes of one paired gateway. `headers` carries the device token (and may set the protocol version). */
export function httpRunnerJobApi(options: {
  origin: string
  headers: () => Record<string, string>
  fetch?: typeof fetch
}): RunnerJobApi {
  const request = options.fetch ?? fetch

  /** Sends one request and reads its answer with `read`; every failure comes out as a `RunnerApiError` or the signal's. */
  const call = async <T>(init: Call, read: (response: Response) => Promise<T>): Promise<T> => {
    const route = FLEET_GATEWAY_ROUTES[init.key]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('The request timed out')), init.timeoutMs)
    const forward = () => controller.abort(init.signal?.reason)
    if (init.signal?.aborted) forward()
    init.signal?.addEventListener('abort', forward, { once: true })
    try {
      const response = await request(options.origin + buildPath(route.path, init.params ?? {}, init.query), {
        method: route.method,
        headers: { [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION), ...options.headers(), ...init.headers },
        body: init.body as RequestInit['body'],
        redirect: 'error',
        signal: controller.signal,
      })
      if (response.ok) return await read(response)
      const parsed = fleetErrorEnvelopeSchema.safeParse(await response.json().catch(() => null))
      const { status } = response
      throw new RunnerApiError(
        status,
        parsed.success ? parsed.data.code : 'INTERNAL',
        parsed.success ? parsed.data.message : `HTTP ${status}`,
        status >= 500 || TRANSIENT_STATUSES.has(status)
      )
    } catch (error) {
      if (error instanceof RunnerApiError) throw error
      if (init.signal?.aborted) throw init.signal.reason ?? error
      throw new RunnerApiError(0, 'NETWORK', error instanceof Error ? error.message : String(error), true)
    } finally {
      clearTimeout(timer)
      if (!init.streaming) init.signal?.removeEventListener('abort', forward)
    }
  }
  const ignoreBody = async (response: Response): Promise<void> => {
    await response.arrayBuffer()
  }
  const jsonBody = (value: unknown) => ({ headers: JSON_HEADERS, body: JSON.stringify(value) })
  const invalid = (what: string, transient: boolean) =>
    new RunnerApiError(200, 'INTERNAL', `${what} is not valid`, transient)

  return {
    report(state) {
      const route = FLEET_GATEWAY_ROUTES.runnerState
      return call(
        { key: 'runnerState', ...jsonBody(route.body.parse(state)), timeoutMs: CALL_TIMEOUT_MS },
        async (response) => {
          const parsed = route.response.safeParse(await response.json())
          if (!parsed.success) throw invalid('The state answer', false)
          return parsed.data
        }
      )
    },
    accept(jobId) {
      return call({ key: 'runnerJobAccept', params: { jobId }, timeoutMs: CALL_TIMEOUT_MS }, ignoreBody)
    },
    progress(jobId) {
      const body = FLEET_GATEWAY_ROUTES.runnerJobProgress.body.parse({ state: 'finishing' })
      return call(
        { key: 'runnerJobProgress', params: { jobId }, ...jsonBody(body), timeoutMs: CALL_TIMEOUT_MS },
        ignoreBody
      )
    },
    finish(jobId, result) {
      const body = FLEET_GATEWAY_ROUTES.runnerJobFinish.body.parse(result)
      return call(
        { key: 'runnerJobFinish', params: { jobId }, ...jsonBody(body), timeoutMs: CALL_TIMEOUT_MS },
        ignoreBody
      )
    },
    async usage(jobId, sample, signal) {
      const body = FLEET_GATEWAY_ROUTES.runnerJobUsage.body.parse(sample)
      return call(
        { key: 'runnerJobUsage', params: { jobId }, ...jsonBody(body), signal, timeoutMs: CALL_TIMEOUT_MS },
        ignoreBody
      )
    },
    manifest(jobId, signal) {
      return call(
        { key: 'runnerJobManifest', params: { jobId }, signal, timeoutMs: MANIFEST_TIMEOUT_MS },
        async (response) => {
          const parsed = fleetRunnerManifestSchema.safeParse(await response.json())
          if (!parsed.success) throw invalid('The job manifest', false)
          return parsed.data
        }
      )
    },
    blobs(jobId, digests, signal) {
      return call(
        {
          key: 'runnerJobBlobs',
          params: { jobId },
          ...jsonBody({ digests }),
          signal,
          timeoutMs: STREAM_START_TIMEOUT_MS,
          streaming: true,
        },
        async (response) => {
          if (!response.body) throw invalid('The blob stream', true)
          return Readable.fromWeb(response.body as WebReadableStream)
        }
      )
    },
    log(jobId, offset, bytes, signal) {
      return call(
        {
          key: 'runnerJobLog',
          params: { jobId },
          query: { [FLEET_RUNNER_LOG_OFFSET_QUERY]: offset },
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes,
          signal,
          timeoutMs: CALL_TIMEOUT_MS,
        },
        ignoreBody
      )
    },
    outputsStatus(jobId, signal) {
      return call(
        { key: 'runnerJobOutputs', params: { jobId }, signal, timeoutMs: CALL_TIMEOUT_MS },
        async (response) => {
          const parsed = fleetRunnerOutputStatusSchema.safeParse(await response.json())
          if (!parsed.success) throw invalid('The outputs status', true)
          return { received: parsed.data.received }
        }
      )
    },
    outputChunk(jobId, offset, bytes, sha256, signal) {
      return call(
        {
          key: 'runnerJobOutputChunk',
          params: { jobId, offset },
          headers: { 'content-type': 'application/octet-stream', [FLEET_RUNNER_HEADERS.sha256]: sha256 },
          body: bytes,
          signal,
          timeoutMs: CHUNK_TIMEOUT_MS,
        },
        ignoreBody
      )
    },
    outputCommit(jobId, commit, signal) {
      return call(
        { key: 'runnerJobOutputCommit', params: { jobId }, ...jsonBody(commit), signal, timeoutMs: CALL_TIMEOUT_MS },
        ignoreBody
      )
    },
  }
}
