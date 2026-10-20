import {
  FLEET_INSTANCE_ROUTES,
  type FleetHostFileArchiveRequest,
  type FleetHostFileDigestRequest,
  type FleetHostFileStatRequest,
  type FleetHostFileUploadBegin,
  type FleetHostFileUploadCommit,
} from '@maestrly/bot-fleet-protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostFiles } from '../../remote-host/server/host-files'
import { body, DEFAULT_BODY_MAX, type RouteKey, writeJson } from './http'

/** What a control server needs of a host's files: a workspaces host's, or a desktop's shared with paired computers. */
export type HostFilesRoutes = Pick<
  HostFiles,
  | 'stat'
  | 'digest'
  | 'content'
  | 'beginUpload'
  | 'uploadChunk'
  | 'commitUpload'
  | 'abortUpload'
  | 'beginArchive'
  | 'archiveStatus'
  | 'releaseArchive'
>

export type HostFilesRouteKey = Extract<RouteKey, `hostFile${string}`>
export const isHostFilesRoute = (key: RouteKey): key is HostFilesRouteKey => key.startsWith('hostFile')

type JsonKey = Exclude<HostFilesRouteKey, 'hostFileContent' | 'hostFileUploadChunk'>
const JSON_ROUTES: Record<
  JsonKey,
  (routes: HostFilesRoutes, params: Record<string, string>, input: unknown) => unknown
> = {
  hostFileStat: (routes, _params, input) => routes.stat(input as FleetHostFileStatRequest),
  hostFileDigest: (routes, _params, input) => routes.digest(input as FleetHostFileDigestRequest),
  hostFileUploadBegin: (routes, _params, input) => routes.beginUpload(input as FleetHostFileUploadBegin),
  hostFileUploadCommit: (routes, params, input) =>
    routes.commitUpload(params.uploadId, input as FleetHostFileUploadCommit),
  hostFileUploadAbort: (routes, params) => routes.abortUpload(params.uploadId),
  hostFileArchiveBegin: (routes, _params, input) => routes.beginArchive(input as FleetHostFileArchiveRequest),
  hostFileArchiveStatus: (routes, params) => routes.archiveStatus(params.archiveId),
  hostFileArchiveRelease: (routes, params) => routes.releaseArchive(params.archiveId),
}

/** Serves one authenticated host-files request: content and chunks stream their bytes, the others are JSON. */
export async function serveHostFilesRoute(
  routes: HostFilesRoutes,
  match: { key: HostFilesRouteKey; params: Record<string, string> },
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  if (match.key === 'hostFileContent') return await routes.content(request, response, url)
  if (match.key === 'hostFileUploadChunk')
    return await routes.uploadChunk(request, response, match.params.uploadId, url)
  const route = FLEET_INSTANCE_ROUTES[match.key]
  const input = await body(request, route.body, DEFAULT_BODY_MAX)
  const output = await JSON_ROUTES[match.key](routes, match.params, input)
  if (route.response) writeJson(response, 200, route.response.parse(output))
  else {
    response.writeHead(204)
    response.end()
  }
}
