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

/** The only built-in tool an image session enables; the server titles its approval "Run generate_image?". */
export const ANTIGRAVITY_IMAGE_TOOL = 'generate_image'
const IMAGE_TOOL_TITLE = /\bgenerate[_ ]image\b/i
/** The only built-in tool a web search session enables; the server titles its approval "Run search_web?". */
export const ANTIGRAVITY_SEARCH_TOOL = 'search_web'
const SEARCH_TOOL_TITLE = /\bsearch[_ ]web\b/i

/**
 * Permission policy of a session that enables one built-in tool: the first call whose approval title matches runs
 * once. Everything else, including a second call, falls back to {@link decideAntigravityPermission}, which rejects
 * built-in tools.
 */
function createSingleBuiltinPermissionPolicy(title: RegExp): (request: unknown) => AcpPermissionOutcome {
  let granted = false
  return (request) => {
    const value = request as Partial<AcpPermissionRequest> | null | undefined
    const toolCall = value?.toolCall
    const options = Array.isArray(value?.options) ? value.options : []
    if (granted || !toolCall || toolCall._meta?.mcp || !title.test(toolCall.title ?? '')) {
      return decideAntigravityPermission(request)
    }
    const outcome = select(options, ['allow_once'])
    if (outcome.outcome.outcome === 'selected') granted = true
    return outcome
  }
}

/** Permission policy of one image session: one built-in `generate_image` call. */
export function createAntigravityImagePermissionPolicy(): (request: unknown) => AcpPermissionOutcome {
  return createSingleBuiltinPermissionPolicy(IMAGE_TOOL_TITLE)
}

/** Permission policy of one web search session: one built-in `search_web` call. */
export function createAntigravitySearchPermissionPolicy(): (request: unknown) => AcpPermissionOutcome {
  return createSingleBuiltinPermissionPolicy(SEARCH_TOOL_TITLE)
}
