/** MCP contract shared by the multi-session router and the isolated single-session bridge. */
export const LEGACY_MCP_PROTOCOL_VERSION = '2025-06-18'
export const STATELESS_MCP_PROTOCOL_VERSION = '2026-07-28'

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = [STATELESS_MCP_PROTOCOL_VERSION, LEGACY_MCP_PROTOCOL_VERSION] as const

/** Static tool catalog version that ChatGPT may cache in the app. */
export const CHATGPT_WEB_TOOL_CATALOG_VERSION = '11'
export const CHATGPT_WEB_TOOL_CATALOG_META_KEY = 'com.maestrly/toolCatalogVersion'

export const CHATGPT_WEB_SERVER_INFO = { name: 'maestrly-bridge', version: CHATGPT_WEB_TOOL_CATALOG_VERSION } as const
export const CHATGPT_WEB_SERVER_CAPABILITIES = { tools: {} } as const

const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo'
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion'

type RequestParams = Record<string, unknown> | undefined

/**
 * `initialize` belongs to the legacy lifecycle. Never echo a stateless version in this handshake: modern
 * clients use `server/discover`; older clients still receive the revision implemented by the bridge.
 */
export function negotiateLegacyProtocolVersion(_requestedVersion: unknown): string {
  return LEGACY_MCP_PROTOCOL_VERSION
}

export function isStatelessMcpRequest(params: RequestParams): boolean {
  const meta = params?._meta
  return (
    !!meta &&
    typeof meta === 'object' &&
    (meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY] === STATELESS_MCP_PROTOCOL_VERSION
  )
}

/** Add the common fields required by stateless-revision results without changing legacy responses. */
export function completeMcpResult(result: unknown, options: { stateless: boolean; cacheable?: boolean }): unknown {
  if (!options.stateless || !result || typeof result !== 'object' || Array.isArray(result)) return result
  const value = result as Record<string, unknown>
  const existingMeta =
    value._meta && typeof value._meta === 'object' && !Array.isArray(value._meta)
      ? (value._meta as Record<string, unknown>)
      : {}
  return {
    ...value,
    resultType: typeof value.resultType === 'string' ? value.resultType : 'complete',
    ...(options.cacheable ? { ttlMs: 0, cacheScope: 'private' } : {}),
    _meta: { ...existingMeta, [SERVER_INFO_META_KEY]: CHATGPT_WEB_SERVER_INFO },
  }
}

export function createMcpDiscoverResult(instructions: string): unknown {
  return completeMcpResult(
    {
      supportedVersions: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
      capabilities: CHATGPT_WEB_SERVER_CAPABILITIES,
      instructions,
    },
    { stateless: true, cacheable: true }
  )
}

export function createLegacyInitializeResult(requestedVersion: unknown, instructions: string) {
  return {
    protocolVersion: negotiateLegacyProtocolVersion(requestedVersion),
    capabilities: CHATGPT_WEB_SERVER_CAPABILITIES,
    serverInfo: CHATGPT_WEB_SERVER_INFO,
    instructions,
  }
}
