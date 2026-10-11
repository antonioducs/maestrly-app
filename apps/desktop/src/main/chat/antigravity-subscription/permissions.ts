import type { AcpPermissionOption, AcpPermissionOutcome, AcpPermissionRequest } from '../acp/protocol'

/** Name of the loopback MCP server that hosts Maestrly's tools for Antigravity sessions. */
export const ANTIGRAVITY_HOST_MCP_SERVER_NAME = 'maestrly'

const CANCELLED: AcpPermissionOutcome = { outcome: { outcome: 'cancelled' } }

function select(options: readonly AcpPermissionOption[], kinds: readonly AcpPermissionOption['kind'][]) {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate?.kind === kind)
    if (option) return { outcome: { outcome: 'selected' as const, optionId: option.optionId } }
  }
  return CANCELLED
}

/**
 * Answers `session/request_permission`. Only calls to Maestrly's own MCP server run, and only once: the real
 * permission decision happens inside each Maestrly tool through the permission broker. Native Antigravity tools
 * (resource reads, file viewers, shells) are always rejected, and `allow_always` is never granted.
 */
export function decideAntigravityPermission(request: unknown): AcpPermissionOutcome {
  const value = request as Partial<AcpPermissionRequest> | null | undefined
  const options = Array.isArray(value?.options) ? value.options : []
  if (!value?.toolCall || options.length === 0) return CANCELLED
  if (value.toolCall._meta?.mcp?.server === ANTIGRAVITY_HOST_MCP_SERVER_NAME) return select(options, ['allow_once'])
  return select(options, ['reject_once', 'reject_always'])
}
