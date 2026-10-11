/**
 * The editor of a workspaces host (VS Code's `serve-web`), reached by a paired computer through the gateway. Every
 * path under the gateway prefix is passed, HTTP request or WebSocket upgrade, to the same path under the instance
 * prefix of the environment's control server, which passes it to the editor on its own loopback. The editor's own
 * paths (its workbench, static files and connections) follow the prefix unchanged.
 */

/**
 * Gateway feature (`/v1/meta`): paired computers reach the editor of a workspaces environment through the gateway.
 * As an instance capability: the environment's Maestrly serves its editor on its control server.
 */
export const FLEET_HOST_EDITOR_FEATURE = 'host-editor'

/** Where the control server of a workspaces environment serves its editor. */
export const FLEET_INSTANCE_EDITOR_PREFIX = '/v1/editor'
/** Where the gateway passes a workspaces environment's editor through, `:eid` being the environment. */
export const FLEET_GATEWAY_EDITOR_PREFIX = '/v1/environments/:eid/editor'

export const FLEET_HOST_EDITOR_LIMITS = {
  /** Editor WebSockets one device holds open through the gateway at once (each window holds two or three). */
  socketsPerDevice: 64,
  /** An HTTP request of the editor whose environment says nothing for this long is cut. */
  idleTimeoutMs: 120_000,
} as const

/**
 * The origin the editor runs at on the computer, which the editor puts in its pages and WebSocket addresses. Only a
 * loopback address and port are accepted: the editor is never reached at any other origin.
 */
export const FLEET_HOST_EDITOR_FORWARDED_HOST = 'x-forwarded-host'
export function isFleetHostEditorForwardedHost(value: unknown): value is string {
  const match = typeof value === 'string' ? /^(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(value) : null
  return !!match && Number(match[1]) > 0 && Number(match[1]) <= 65_535
}

/** The gateway's own refusals of an editor request. */
export const FLEET_HOST_EDITOR_GATEWAY_ERRORS = {
  notRunning: 'The workspaces environment is not running.',
  updateHost: 'Update the workspaces environment to open its editor.',
  tooManySockets: 'Too many editor connections are open.',
} as const

/** The gateway path of an editor path (`/` for the workbench) of environment `environmentId`. */
export function fleetGatewayEditorPath(environmentId: string, editorPath = '/'): string {
  const rest = editorPath.startsWith('/') ? editorPath : '/' + editorPath
  return FLEET_GATEWAY_EDITOR_PREFIX.replace(':eid', encodeURIComponent(environmentId)) + rest
}

/**
 * The environment and editor path of a gateway path under the editor prefix, or null for any other path. The editor
 * path keeps the leading slash; the bare prefix is the editor's root.
 */
export function parseFleetGatewayEditorPath(pathname: string): { environmentId: string; editorPath: string } | null {
  const match = /^\/v1\/environments\/([^/]+)\/editor(\/.*)?$/.exec(pathname)
  if (!match) return null
  let environmentId: string
  try {
    environmentId = decodeURIComponent(match[1])
  } catch {
    return null
  }
  if (!environmentId || environmentId.includes('/')) return null
  return { environmentId, editorPath: match[2] ?? '/' }
}

/** The editor path of an instance path under the editor prefix, or null for any other path. */
export function parseFleetInstanceEditorPath(pathname: string): string | null {
  if (pathname === FLEET_INSTANCE_EDITOR_PREFIX) return '/'
  return pathname.startsWith(FLEET_INSTANCE_EDITOR_PREFIX + '/')
    ? pathname.slice(FLEET_INSTANCE_EDITOR_PREFIX.length)
    : null
}
