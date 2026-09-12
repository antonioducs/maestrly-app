/**
 * MCP bridge router: ONE tunnel + ONE ChatGPT app serving N Maestrly conversations concurrently.
 *
 * ChatGPT does not identify the calling conversation, so identification is explicit: each session gets
 * a `session_key` in its conversation kickoff, and the model repeats it in every tool call.
 * Without a key, no session is selected, even if only one exists; implicit routing is forbidden.
 *
 * The router answers `initialize`/`tools/list` from a STATIC catalog, created once without a session:
 * ChatGPT caches this list when creating/updating the app, so it includes ALL possible capabilities
 * (including the four review-loop tools) and never varies by conversation or by whether sessions
 * exist. Authorization (session_key, review-loop controller) is validated in `tools/call`;
 * hiding schemas is never an authorization mechanism.
 */
import {
  CHATGPT_WEB_SERVER_INSTRUCTIONS,
  createChatGptWebBridge,
  type ChatGptWebBridge,
  type JsonRpcResponse,
} from './bridge-server'
import {
  CHATGPT_WEB_TOOL_CATALOG_META_KEY,
  CHATGPT_WEB_TOOL_CATALOG_VERSION,
  completeMcpResult,
  createLegacyInitializeResult,
  createMcpDiscoverResult,
  isStatelessMcpRequest,
} from './bridge-protocol'

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: Record<string, unknown>
}

export interface BridgeRouterOptions {
  /** Persisted version of the last tool list observed by the router. */
  lastRefreshedToolCatalogVersion?: string | null
  /** Persist the observation after ChatGPT repeats `tools/list`. */
  onToolCatalogRefreshed?: (version: string) => void
}

export function createBridgeRouter(options: BridgeRouterOptions = {}) {
  const bridges = new Map<string, ChatGptWebBridge>()
  /** Static catalog: created once without a session; includes all capabilities regardless of active sessions. */
  const catalog = createChatGptWebBridge({ cwd: process.cwd() })
  /** The local version differs from the last observed list: the cached app needs Refresh. */
  let appRefreshRequired = options.lastRefreshedToolCatalogVersion !== CHATGPT_WEB_TOOL_CATALOG_VERSION

  const observeCurrentToolCatalog = (): void => {
    if (!appRefreshRequired) return
    appRefreshRequired = false
    try {
      options.onToolCatalogRefreshed?.(CHATGPT_WEB_TOOL_CATALOG_VERSION)
    } catch {
      /* persistence/observation must not prevent the tools/list response */
    }
  }

  const resolve = (key: string): { bridge?: ChatGptWebBridge; error?: string } => {
    if (key) {
      const bridge = bridges.get(key)
      if (bridge) return { bridge }
      return {
        error:
          'This session_key is no longer active in Maestrly (the user ended it or the app restarted). ' +
          'Stop calling tools and explain that a new session is required.',
      }
    }
    if (bridges.size === 0) {
      return {
        error:
          'session_key is required for every tool. No active Maestrly session; ask the user ' +
          'to start a session.',
      }
    }
    return {
      error:
        'session_key is required for every tool. Repeat the call with the value supplied at the start ' +
        `of this conversation (${bridges.size} active session(s)).`,
    }
  }

  async function handleMessage(raw: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (Array.isArray(raw)) {
      const out: JsonRpcResponse[] = []
      for (const item of raw) {
        const response = await handleRequest((item ?? {}) as JsonRpcRequest)
        if (response) out.push(response)
      }
      return out.length ? out : undefined
    }
    if (!raw || typeof raw !== 'object') return undefined
    return handleRequest(raw as JsonRpcRequest)
  }

  async function handleRequest(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const { id, method, params } = message
    const stateless = isStatelessMcpRequest(params)
    const respond = (result: unknown, cacheable = false): JsonRpcResponse | undefined =>
      id === undefined ? undefined : { jsonrpc: '2.0', id, result: completeMcpResult(result, { stateless, cacheable }) }

    switch (method) {
      case 'server/discover':
        return id === undefined
          ? undefined
          : { jsonrpc: '2.0', id, result: createMcpDiscoverResult(CHATGPT_WEB_SERVER_INSTRUCTIONS) }
      case 'initialize': {
        for (const bridge of bridges.values()) void bridge.handleMessage(message)
        return respond(createLegacyInitializeResult(params?.protocolVersion, CHATGPT_WEB_SERVER_INSTRUCTIONS))
      }
      case 'tools/list':
        // Only clear the pending flag after responding with this version of the static catalog.
        observeCurrentToolCatalog()
        return respond(
          {
            tools: await catalog.listTools(),
            _meta: { [CHATGPT_WEB_TOOL_CATALOG_META_KEY]: CHATGPT_WEB_TOOL_CATALOG_VERSION },
          },
          true
        )
      case 'tools/call': {
        const name = typeof params?.name === 'string' ? params.name : ''
        const args = { ...((params?.arguments as Record<string, unknown>) ?? {}) }
        const key = typeof args.session_key === 'string' ? args.session_key.trim() : ''
        delete args.session_key
        const target = resolve(key)
        if (!target.bridge) {
          return respond({ content: [{ type: 'text', text: target.error }], isError: true })
        }
        try {
          return respond(await target.bridge.callTool(name, args))
        } catch (error) {
          const code = (error as { code?: number }).code ?? -32000
          return id === undefined
            ? undefined
            : { jsonrpc: '2.0', id, error: { code, message: error instanceof Error ? error.message : String(error) } }
        }
      }
      case 'ping':
        return respond({})
      case 'prompts/list':
        return respond({ prompts: [] }, true)
      case 'resources/list':
        return respond({ resources: [] }, true)
      case 'resources/templates/list':
        return respond({ resourceTemplates: [] }, true)
      default:
        if (id === undefined) return undefined
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } }
    }
  }

  return {
    handleMessage,
    register: (key: string, bridge: ChatGptWebBridge) => bridges.set(key, bridge),
    unregister: (key: string) => {
      const bridge = bridges.get(key)
      const removed = bridges.delete(key)
      // Revoking the routing key also closes the bridge lifecycle. This cancels an in-flight call captured
      // before unregister and makes its eventual response a lifecycle error instead of stale tool output.
      if (removed) bridge?.endSession()
      return removed
    },
    size: () => bridges.size,
    listTools: () => catalog.listTools(),
    catalogVersion: () => CHATGPT_WEB_TOOL_CATALOG_VERSION,
    appRefreshRequired: () => appRefreshRequired,
    catalogStatus: () => ({ version: CHATGPT_WEB_TOOL_CATALOG_VERSION, appRefreshRequired }),
  }
}

export type BridgeRouter = ReturnType<typeof createBridgeRouter>
