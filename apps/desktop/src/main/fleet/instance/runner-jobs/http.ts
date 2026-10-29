import {
  FLEET_INSTANCE_ROUTES,
  FLEET_RUNNER_HEADERS,
  FLEET_RUNNER_LIMITS,
  FLEET_RUNNER_LOG_OFFSET_QUERY,
  type FleetInstanceRunnerJobState,
  type FleetRunnerBlobsRequest,
  type FleetRunnerOutputCommit,
} from '@maestrly/bot-fleet-protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { body, DEFAULT_BODY_MAX, type RouteKey, writeJson } from '../http'
import type { RunnerJobFiles } from './files'
import { invalid } from './shared'

/** The routes under `/v1/bots/:botId/runner-jobs/:jobId`, where the gateway tells a bot's environment of its jobs. */
export type RunnerJobsRouteKey = Extract<RouteKey, `botRunnerJob${string}`>
export const isRunnerJobsRoute = (key: RouteKey): key is RunnerJobsRouteKey => key.startsWith('botRunnerJob')

const DIGITS = /^\d{1,15}$/
const SHA256 = /^[a-f0-9]{64}$/

const offsetOf = (value: string | null | undefined): number => {
  if (value === null || value === undefined || !DIGITS.test(value)) throw invalid('Invalid offset.')
  return Number(value)
}

/** Aborts when the client goes away before the answer is complete. */
function abortWhenClosed(response: ServerResponse): AbortSignal {
  const controller = new AbortController()
  response.once('close', () => {
    if (!response.writableFinished) controller.abort()
  })
  return controller.signal
}

/** The declared length of a raw body, which must be there and no more than `max`. */
function declaredLength(request: IncomingMessage, max: number): number {
  const raw = request.headers['content-length']
  if (raw === undefined || !DIGITS.test(raw)) throw invalid('Content-Length is required.')
  const length = Number(raw)
  if (length > max) throw invalid('Request body too large.')
  return length
}

/**
 * Serves one authenticated request about a bot's runner job. State and commit take JSON; the manifest and the output
 * status answer JSON; blobs stream a compressed tar (a refusal comes before its status line, as JSON); the log and an
 * output chunk take their bytes as the body. Work stops when the client disconnects.
 */
export async function serveRunnerJobsRoute(
  files: RunnerJobFiles,
  match: { key: RunnerJobsRouteKey; params: Record<string, string> },
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  const route = FLEET_INSTANCE_ROUTES[match.key]
  const { jobId } = match.params
  const done = (): void => {
    response.writeHead(204)
    response.end()
  }
  switch (match.key) {
    case 'botRunnerJobState': {
      const input = (await body(request, route.body, DEFAULT_BODY_MAX)) as FleetInstanceRunnerJobState
      await files.state(jobId, input.job)
      return done()
    }
    case 'botRunnerJobOutputCommit': {
      const input = (await body(request, route.body, DEFAULT_BODY_MAX)) as FleetRunnerOutputCommit
      await files.outputCommit(jobId, input)
      return done()
    }
    case 'botRunnerJobManifest':
      return writeJson(response, 200, await files.manifest(jobId, abortWhenClosed(response)))
    case 'botRunnerJobBlobs': {
      const input = (await body(
        request,
        route.body,
        FLEET_RUNNER_LIMITS.blobRequestBytesMax
      )) as FleetRunnerBlobsRequest
      // Nothing is sent before the request is found good: a refusal is a JSON error, not a broken stream.
      response.setHeader('content-type', 'application/octet-stream')
      response.setHeader('cache-control', 'no-store')
      await files.blobs(jobId, input.digests, response, abortWhenClosed(response))
      return
    }
    case 'botRunnerJobLog': {
      if (request.headers['content-length'] !== undefined) declaredLength(request, FLEET_RUNNER_LIMITS.logBatchBytesMax)
      await files.log(jobId, offsetOf(url.searchParams.get(FLEET_RUNNER_LOG_OFFSET_QUERY)), request)
      return done()
    }
    case 'botRunnerJobOutputs':
      return writeJson(response, 200, await files.outputs(jobId))
    case 'botRunnerJobOutputChunk': {
      const offset = offsetOf(match.params.offset)
      const length = declaredLength(
        request,
        FLEET_RUNNER_LIMITS.outputChunkBytes + FLEET_RUNNER_LIMITS.chunkBodySlackBytes
      )
      const sha256 = request.headers[FLEET_RUNNER_HEADERS.sha256]
      if (typeof sha256 !== 'string' || !SHA256.test(sha256)) throw invalid('Invalid chunk digest.')
      await files.outputChunk(jobId, offset, request, sha256, length)
      return done()
    }
  }
}
