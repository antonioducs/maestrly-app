import { memorySpaceForConversation } from '../memory/spaces'
import { isDeepStrictEqual } from 'node:util'
/**
 * MCP server support for BYOK chat. Users configure streamable HTTP or stdio MCP servers;
 * their tools join the chat toolset alongside built-ins (read/bash/edit/…). Uses
 * `@modelcontextprotocol/sdk`, not AI SDK (v6 exposes no
 * MCP client). Each MCP tool becomes AI SDK `tool()` via `jsonSchema(inputSchema)`; execute requests
 * permission ('mcp' action) and calls `client.callTool`.
 *
 * Config persisted in `app_settings` (`chat.mcpServers`, JSON). Per-turn connections: connect at
 * turn start, serve all calls, close at end (see runner). Pooling is a follow-up (PORT-PLAN).
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ToolResultOutput } from '@ai-sdk/provider-utils'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { tool, jsonSchema, type Tool, type ToolSet } from 'ai'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { getAppSetting, getConvUiPrefs, setAppSetting } from '../store'
import { transaction } from '../store/db'
import { writeSettingsRevision } from '../store/app-settings'
import { isSecureStorageAvailable, secureGet, secureSet, secureRemove } from '../secure-store'
import { gateInstanceAppTool } from '../fleet/instance/gate'
import type { ChatToolImage, McpOAuthAccountDto, ToolOutput } from '../../shared/chat'
import type { ChatBehavior } from '../../shared/conversation-experience'
import { capabilityBehaviorFor } from '../../shared/chat-mode'
import { toolOutputImages } from '../../shared/chat'
import { appToolGroupOf, type AppToolGroup } from '../../shared/app-tool-groups'
import type { MaestroWorkerScope } from '../maestro-worker-scope'
import {
  chatToolOutputToAiSdkOutput,
  describeToolOutputImages,
  mcpResultToChatToolOutput,
  modelOutputToChatToolOutput,
} from './tool-output'
import {
  DEFERRED_LOADING_METADATA,
  EXTERNAL_MCP_WRAPPER_METADATA,
  EXTERNAL_MCP_RESTRICTED_METADATA,
  appToolAllowed,
  appToolDeferrable,
  appToolMetadata,
  externalMcpToolAllowed,
  externalMcpToolReadOnly,
} from './tool-policy'
import { chatDiag } from './diag-log'
import {
  mcpServerFingerprint,
  readMcpCatalog,
  readMcpCatalogEntry,
  removeMcpCatalog,
  sanitizeMcpCatalogTools,
  writeMcpCatalog,
} from './mcp-catalog'
import {
  MCP_LIST_DEFAULT_LIMIT,
  MCP_LIST_MAX_LIMIT,
  MCP_SEARCH_DEFAULT_LIMIT,
  MCP_SEARCH_MAX_LIMIT,
  MCP_SEARCH_RESULT_MAX_CHARS,
  clampInteger,
  rankMcpTools,
  mcpServerTitle,
  renderMcpDirectory,
  schemaHint,
  takeWithinChars,
  type McpDirectoryServer,
} from './mcp-discovery'
import { LazyMcpRuntime, type LazyMcpDiagnostic } from './mcp-lazy-runtime'
import { isMcpNeedsAuthError, McpNeedsAuthError } from './mcp-auth-errors'
import { collectMcpStdioOutput, mcpStdioSecrets, withMcpStdioOutput } from './mcp-stdio-output'
import {
  activeMcpOAuthAccounts,
  forgetMcpOAuth,
  hostMcpOAuthProvider,
  markMcpNeedsAuth,
  mcpOAuthSummary,
} from './mcp-oauth'
import { listPluginMcpServers } from '../plugins/runtime'
import {
  type ListedMcpTool,
  type McpCallToolResult,
  type McpConnection,
  type McpRequestOptions,
  type McpServer,
  mcpConnectionKey,
  type UserMcpServer,
} from './mcp-types'
export type {
  ListedMcpTool,
  McpCallToolResult,
  McpConnection,
  McpRequestOptions,
  McpServer,
  McpTransport,
  UserMcpServer,
} from './mcp-types'
// Import the registry dynamically so native tools load only when app tools are built.

const MCP_KEY = 'chat.mcpServers'

const DETAILS_PREFIX = 'chat.mcpServer.'
const DETAIL_KEYS = ['url', 'headers', 'command', 'args', 'env'] as const

function readStored(): McpServer[] {
  const raw = getAppSetting(MCP_KEY)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as McpServer[]).filter((s) => s && typeof s.id === 'string') : []
  } catch {
    return []
  }
}

function storedOnly(server: McpServer): McpServer {
  return { id: server.id, name: server.name, transport: server.transport, enabled: server.enabled }
}

function detailsOnly(server: Partial<McpServer>): Pick<McpServer, (typeof DETAIL_KEYS)[number]> {
  return Object.fromEntries(DETAIL_KEYS.filter((key) => server[key] !== undefined).map((key) => [key, server[key]]))
}

function hasInlineDetails(server: Partial<McpServer>): boolean {
  return DETAIL_KEYS.some((key) => server[key] !== undefined)
}

interface McpSaveOptions {
  requireSecure?: boolean
}
function atomicMcpWrite<T>(write: () => T): T {
  let result!: T
  transaction(() => {
    result = write()
  })
  return result
}

function migrateInlineDetails(): McpServer[] {
  return atomicMcpWrite(() => {
    const list = readStored()
    if (!isSecureStorageAvailable()) return list
    let changed = false
    const migrated = list.map((server) => {
      if (!hasInlineDetails(server) || !secureSet(DETAILS_PREFIX + server.id, JSON.stringify(detailsOnly(server))))
        return server
      changed = true
      return storedOnly(server)
    })
    if (changed) setAppSetting(MCP_KEY, JSON.stringify(migrated))
    return migrated
  })
}

export function listMcpServers(): UserMcpServer[] {
  // Stored servers are user servers; `chat:mcp-add` only accepts the `http` and `stdio` transports.
  return migrateInlineDetails().map((server): UserMcpServer => {
    if (hasInlineDetails(server)) return server as UserMcpServer
    const raw = secureGet(DETAILS_PREFIX + server.id)
    if (raw) {
      try {
        const details = JSON.parse(raw)
        if (details && typeof details === 'object' && !Array.isArray(details)) {
          return { ...storedOnly(server), ...detailsOnly(details) } as UserMcpServer
        }
      } catch {
        // Keep the configured identity visible when its keyring entry cannot be read.
      }
    }
    invalidateMcpRuntime(server.id)
    return { ...storedOnly(server), unavailable: true } as UserMcpServer
  })
}

function saveMcpServers(list: McpServer[], changedId: string, options: McpSaveOptions = {}): void {
  return atomicMcpWrite(() => {
    const stored = list.map((server) => {
      const identity = storedOnly(server)
      if (server.unavailable) return identity
      const details = detailsOnly(server)
      const serialized = JSON.stringify(details)
      // Preserve other servers' encrypted records (and revisions). The target still requires a successful write.
      if (isSecureStorageAvailable()) {
        if (server.id !== changedId && secureGet(DETAILS_PREFIX + server.id) === serialized) return identity
        if (secureSet(DETAILS_PREFIX + server.id, serialized)) return identity
      }
      if (options.requireSecure) throw new Error('Secure credential storage is unavailable.')
      return { ...identity, ...details }
    })
    setAppSetting(MCP_KEY, JSON.stringify(stored))
  })
}

export function addMcpServer(
  input: Omit<UserMcpServer, 'id' | 'enabled'> & { enabled?: boolean },
  options: McpSaveOptions = {}
): UserMcpServer {
  return atomicMcpWrite(() => {
    const name = input.name?.trim()
    if (!name) throw new Error('Enter an MCP server name.')
    if (input.transport === 'http') {
      if (!input.url || !/^https?:\/\//i.test(input.url)) throw new Error('Enter the MCP server HTTP(S) URL.')
    } else if (input.transport === 'stdio') {
      if (!input.command?.trim()) throw new Error('Enter the MCP server command (stdio).')
    } else {
      throw new Error('Invalid MCP transport.')
    }
    const server: UserMcpServer = {
      id: 'mcp_' + randomUUID(),
      name,
      transport: input.transport,
      enabled: input.enabled ?? true,
      url: input.url?.trim(),
      headers: input.headers,
      command: input.command?.trim(),
      args: input.args,
      env: input.env,
    }
    saveMcpServers([...listMcpServers(), server], server.id, options)
    return server
  })
}

/** Plugin servers (`plg_…`) live in the plugin's install record; only Settings → Plugins changes them. */
function refusePluginServer(id: string): void {
  if (id.startsWith('plg_')) throw new Error('managed-by-plugin')
}

export function updateMcpServer(id: string, patch: Partial<UserMcpServer>, options: McpSaveOptions = {}): void {
  refusePluginServer(id)
  return atomicMcpWrite(() => {
    const list = listMcpServers()
    const idx = list.findIndex((s) => s.id === id)
    if (idx < 0) return
    const previous = list[idx]
    const next = { ...previous, ...patch, id: previous.id, unavailable: previous.unavailable }
    if (hasInlineDetails(patch) && (next.transport === 'stdio' ? next.command : next.url)) {
      delete next.unavailable
    }
    list[idx] = next
    saveMcpServers(list, id, options)
    // Detail-only updates leave the identity JSON unchanged but still invalidate remote editors.
    writeSettingsRevision('mcp:' + id)
    writeSettingsRevision('mcp')
    invalidateMcpRuntime(id)
    if (mcpServerFingerprint(previous) !== mcpServerFingerprint(next)) removeMcpCatalog(id)
  })
}

export function upsertMcpServerByName(
  input: Omit<UserMcpServer, 'id' | 'unavailable'>,
  options: McpSaveOptions = {}
): {
  server: McpServer
  outcome: 'added' | 'updated' | 'unchanged'
} {
  return atomicMcpWrite(() => {
    const name = input.name?.trim()
    if (!name) throw new Error('Enter an MCP server name.')
    if (input.transport === 'http') {
      if (!input.url || !/^https?:\/\//i.test(input.url)) throw new Error('Enter the MCP server HTTP(S) URL.')
      new URL(input.url)
    } else if (input.transport === 'stdio') {
      if (!input.command?.trim()) throw new Error('Enter the MCP server command (stdio).')
    } else throw new Error('Invalid MCP transport.')
    const previous = listMcpServers().find((server) => server.name.toLowerCase() === name.toLowerCase())
    if (!previous) return { server: addMcpServer(input, options), outcome: 'added' }
    const next: UserMcpServer = {
      id: previous.id,
      name: previous.name,
      transport: input.transport,
      enabled: input.enabled,
      url: input.url?.trim(),
      headers: input.headers,
      command: input.command?.trim(),
      args: input.args,
      env: input.env,
    }
    const comparable = { ...previous, ...Object.fromEntries(DETAIL_KEYS.map((key) => [key, previous[key]])) }
    if (isDeepStrictEqual(comparable, next)) return { server: previous, outcome: 'unchanged' }
    updateMcpServer(previous.id, next, options)
    return { server: next, outcome: 'updated' }
  })
}

export function removeMcpServer(id: string): void {
  refusePluginServer(id)
  return atomicMcpWrite(() => {
    saveMcpServers(
      listMcpServers().filter((s) => s.id !== id),
      id
    )
    if (!secureRemove(DETAILS_PREFIX + id)) throw new Error('Secure credential storage is unavailable.')
    forgetMcpOAuth(id)
    invalidateMcpRuntime(id)
    removeMcpCatalog(id)
  })
}

const MCP_TOOL_NAME_MAX_LENGTH = 64
const MCP_TOOL_NAME_PREFIX = 'ext_mcp__'
const MCP_TOOL_NAME_HASH_LENGTH = 12

/**
 * Stable external MCP tool name compatible with Codex app-server's reserved namespace.
 *
 * Codex app-server reserves `mcp` and the entire `mcp__` prefix for MCP tools
 * it manages itself. `ext_mcp__` explicitly identifies tools arriving through
 * Maestrly's bridge without colliding with that reservation. The hash includes
 * server ID and original names to distinguish tools from same-name servers,
 * even when sanitizing/truncating produces identical slugs.
 */
export function sanitizeMcpToolName(serverId: string, serverName: string, toolName: string): string {
  const slug = (value: string, fallback: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || fallback

  const serverSlug = slug(serverName, 'server').slice(0, 16)
  const toolSlug = slug(toolName, 'tool')
  const digest = createHash('sha256')
    .update(serverId)
    .update('\0')
    .update(serverName)
    .update('\0')
    .update(toolName)
    .digest('hex')
    .slice(0, MCP_TOOL_NAME_HASH_LENGTH)
  const fixedLength = MCP_TOOL_NAME_PREFIX.length + serverSlug.length + 2 + 1 + digest.length
  const availableToolLength = Math.max(1, MCP_TOOL_NAME_MAX_LENGTH - fixedLength)

  return `${MCP_TOOL_NAME_PREFIX}${serverSlug}__${toolSlug.slice(0, availableToolLength)}_${digest}`
}

/** Historical AI SDK provider contract; preserved to avoid renaming tools in non-Codex conversations. */
function legacyMcpToolName(serverName: string, toolName: string): string {
  const slug =
    serverName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'mcp'
  return `${slug}__${toolName}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MCP_TOOL_NAME_MAX_LENGTH)
}

function connectionFromClient(client: Client): McpConnection {
  return {
    listTools: async (options) => {
      const result = await client.listTools(undefined, options)
      return (result.tools ?? []) as ListedMcpTool[]
    },
    callTool: async (name, args = {}, options) =>
      (await client.callTool({ name, arguments: args }, undefined, options)) as McpCallToolResult,
    close: () => client.close(),
  }
}

/** Opens one configured server without exposing its transport credentials to consumers. */
export async function connectMcpServer(server: McpServer, options: McpRequestOptions = {}): Promise<McpConnection> {
  if (server.unavailable) throw new Error('MCP connection details are unavailable.')
  const client = new Client({ name: 'maestrly-chat', version: '1.0.0' })
  try {
    if (server.transport === 'http') {
      const transport = new StreamableHTTPClientTransport(new URL(server.url!), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
        authProvider: hostMcpOAuthProvider(server),
      })
      await client.connect(transport, options)
    } else if (server.transport === 'sse') {
      const transport = new SSEClientTransport(new URL(server.url!), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
        authProvider: hostMcpOAuthProvider(server),
      })
      await client.connect(transport, options)
    } else {
      const transport = new StdioClientTransport({
        command: server.command!,
        args: server.args ?? [],
        env: server.env,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        stderr: 'pipe',
      })
      // A server that stops at once says why only there, usually a missing token: "Connection closed" says nothing.
      const output = collectMcpStdioOutput(transport.stderr)
      try {
        await client.connect(transport, options)
      } catch (error) {
        if (options.signal?.aborted) throw error
        throw await withMcpStdioOutput(error, output, mcpStdioSecrets(server))
      }
    }
    return connectionFromClient(client)
  } catch (error) {
    await client.close().catch(() => {})
    // A 401 the stored sign-in cannot answer: the person signs in from Settings; turns never open a browser.
    if (server.transport !== 'stdio' && (error instanceof UnauthorizedError || isMcpNeedsAuthError(error))) {
      // The provider already marked the account it stopped for; a bare 401 marks this connection.
      if (isMcpNeedsAuthError(error)) throw error
      markMcpNeedsAuth(mcpConnectionKey(server))
      throw new McpNeedsAuthError(server)
    }
    throw error
  }
}

let sharedMcpRuntime: LazyMcpRuntime | null = null

function mcpRuntimeDiagnostic(event: LazyMcpDiagnostic): void {
  chatDiag({ ...event })
}

function getMcpRuntime(): LazyMcpRuntime {
  sharedMcpRuntime ??= new LazyMcpRuntime({ connect: connectMcpServer, diagnostic: mcpRuntimeDiagnostic })
  return sharedMcpRuntime
}

export function invalidateMcpRuntime(serverId: string): void {
  sharedMcpRuntime?.invalidate(serverId)
}

/** Closes pooled external MCP transports. Exported for deterministic shutdown/tests. */
export async function disposeMcpRuntime(): Promise<void> {
  const runtime = sharedMcpRuntime
  sharedMcpRuntime = null
  await runtime?.dispose()
}

/**
 * The user's MCP servers plus the servers of installed plugins. `conversationId` undefined = every enabled plugin
 * (Settings); null = no conversation (global plugins only). Inactive plugin servers are listed disabled on request,
 * so callers that switch MCP off by id also cover them.
 */
export function listRuntimeMcpServers(
  opts: { conversationId?: string | null; includeInactivePlugins?: boolean } = {}
): McpServer[] {
  return [
    ...listMcpServers(),
    ...listPluginMcpServers({ conversationId: opts.conversationId }, { includeInactive: opts.includeInactivePlugins }),
  ]
}

/** Every server id a context that forbids MCP must switch off, plugin servers included. */
export function allRuntimeMcpServerIds(): string[] {
  return listRuntimeMcpServers({ conversationId: undefined, includeInactivePlugins: true }).map((server) => server.id)
}

export interface BuildMcpToolsArgs {
  /** Conversation whose plugins apply (null = none: only global plugins). */
  conversationId: string | null
  mode: ChatBehavior
  /** Per-call permission gate (resolves on allow, throws on deny). */
  gate: (toolName: string, toolCallId: string, signal?: AbortSignal) => Promise<void>
  signal: AbortSignal
  /** Server IDs disabled in THIS conversation (conversation override). */
  disabledIds?: Set<string>
  /** App-server reserves `mcp`/`mcp__`; enable only for the official Codex provider. */
  codexSafeNames?: boolean
  /** Effective capability of the model receiving MCP results. */
  supportsImages?: boolean
  /** Host-owned fallback for runtimes without vision. */
  describeImage?: (image: ChatToolImage) => Promise<{ text: string; model?: string } | null>
  /**
   * `typed` (default): cached tools become wrappers with their own schemas, for a runtime that defers them until
   * the model looks them up. `on-demand`: no wrappers; the model reads schemas with `mcp_search` and calls through
   * `mcp_call`, so a catalog of any size adds only the index below to every request.
   */
  surface?: 'typed' | 'on-demand'
  /**
   * What the description of `mcp_search` tells about the tools: `names` (default) lists them, `servers` only the
   * servers. A runtime that already announces the names of the tools it defers needs no list of its own.
   */
  directory?: 'names' | 'servers'
}

/** Connects enabled MCP servers, lists tools, and wraps them as AI SDK tools.
 * Returns toolset + `close()` (closes connections). Skips servers failing to connect. */
/** Lists tools of an already-connected MCP Client and wraps them as gated AI SDK tools.
 * Exported for tests (generic connect→listTools→callTool→wrap→execute path). */
/** Practical MCP SDK "no timeout": largest safe setTimeout delay (~24.8 days). Larger values
 * overflow to 1ms in Node (fire IMMEDIATELY). Used for app-tools where review_plan BLOCKS for human input —
 * the REAL limit comes from plan-broker + turn lifecycle (abort/teardown closes the client). */
const NO_TIMEOUT_MS = 2_147_483_647

export interface McpToolOutputOptions {
  /** false = replace image blocks with an interpreter description before the provider sees the result. */
  supportsImages?: boolean
  /** Best-effort fallback used by models whose catalog/runtime does not accept image content. */
  describeImage?: (image: ChatToolImage) => Promise<{ text: string; model?: string } | null>
}

export async function toolsFromClient(
  client: Client,
  nameFor: (toolName: string) => string,
  describeFallback: (toolName: string) => string,
  gate: (advertised: string, toolCallId: string, signal?: AbortSignal) => Promise<void>,
  filter?: (listedTool: ListedMcpTool) => boolean,
  /** MCP request timeout (ms). Absent = SDK default (60s, suitable for EXTERNAL servers). In-process app-tools
   * pass NO_TIMEOUT_MS because review_plan may block minutes/hours until a user decides. */
  callTimeoutMs?: number,
  metadataFor?: (listedTool: ListedMcpTool) => Record<string, boolean> | undefined,
  outputOptions: McpToolOutputOptions = {},
  appConversationId?: string
): Promise<ToolSet> {
  return toolsFromConnection(
    connectionFromClient(client),
    nameFor,
    describeFallback,
    gate,
    filter,
    callTimeoutMs,
    metadataFor,
    outputOptions,
    appConversationId
  )
}

async function toolsFromConnection(
  connection: McpConnection,
  nameFor: (toolName: string) => string,
  describeFallback: (toolName: string) => string,
  gate: (advertised: string, toolCallId: string, signal?: AbortSignal) => Promise<void>,
  filter?: (listedTool: ListedMcpTool) => boolean,
  callTimeoutMs?: number,
  metadataFor?: (listedTool: ListedMcpTool) => Record<string, boolean> | undefined,
  outputOptions: McpToolOutputOptions = {},
  appConversationId?: string
): Promise<ToolSet> {
  const out: ToolSet = {}
  let listed: ListedMcpTool[]
  try {
    listed = await connection.listTools()
  } catch {
    return out
  }
  for (const t of listed) {
    if (filter && !filter(t)) continue
    const advertised = nameFor(t.name)
    const metadata = metadataFor?.(t)
    const aiTool: Tool = tool({
      description: t.description ?? describeFallback(t.name),
      ...(metadata == null ? {} : { metadata }),
      inputSchema: jsonSchema((t.inputSchema as object) ?? { type: 'object', properties: {} }),
      execute: async (input: unknown, opts: { toolCallId: string; abortSignal?: AbortSignal }) =>
        gateInstanceAppTool(appConversationId ?? '', async () => {
          // Preserve the historical two-argument contract without a signal; the third appears only for cancellable
          // executions (especially Codex adapter), avoiding observable `undefined` in existing gates.
          if (opts.abortSignal) await gate(advertised, opts.toolCallId, opts.abortSignal)
          else await gate(advertised, opts.toolCallId)
          const requestOptions =
            callTimeoutMs != null || opts.abortSignal
              ? {
                  ...(callTimeoutMs != null ? { timeout: callTimeoutMs } : {}),
                  ...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
                }
              : undefined
          const res = await connection.callTool(t.name, (input as Record<string, unknown>) ?? {}, requestOptions)
          // Vision-capable models receive the cached image directly. Running the interpreter here would
          // serialize an unnecessary second model call into the tool latency; non-vision/unknown consumers
          // still get the best-effort description used by their model-facing projection.
          const describeImage = outputOptions.supportsImages === true ? undefined : outputOptions.describeImage
          const output = await describeToolOutputImages(mcpResultToChatToolOutput(res), describeImage)
          if (typeof output === 'string') return output
          if (output.structuredContent === undefined && !output.isError && toolOutputImages(output).length === 0)
            return output.text
          // Return the canonical host output. `toModelOutput` is the model boundary; it must not be used to
          // replace the value that the runtime folds into ChatToolOutput/state.
          return output
        }),
      // AI SDK otherwise serializes every non-string execute result as JSON. This hook is the actual model-facing
      // projection for BYOK streamText; native bridges call their equivalent projection before provider conversion.
      toModelOutput: ({ output }: { output: unknown }) => {
        const normalized = modelOutputToChatToolOutput(output)
        return typeof normalized === 'string'
          ? { type: 'text' as const, value: normalized || '(no output)' }
          : chatToolOutputToAiSdkOutput(normalized, { dropImages: outputOptions.supportsImages === false })
      },
    })
    out[advertised] = aiTool
  }
  return out
}

export const MCP_SEARCH_TOOL_NAME = 'mcp_search'
export const MCP_CALL_TOOL_NAME = 'mcp_call'
export const MCP_READ_TOOL_NAME = 'mcp_read'

interface ExternalMcpBuildContext {
  mode: ChatBehavior
  gate: BuildMcpToolsArgs['gate']
  codexSafeNames: boolean
  outputOptions: McpToolOutputOptions
}

const mcpInputValidator = new AjvJsonSchemaValidator()

/** A plugin's `enabled_tools` / `disabled_tools` filter. */
function mcpToolPermitted(server: McpServer, toolName: string): boolean {
  const filter = server.toolFilter
  if (!filter) return true
  if (filter.allow && !filter.allow.includes(toolName)) return false
  return !filter.deny?.includes(toolName)
}

function externalMcpToolName(context: ExternalMcpBuildContext, server: McpServer, toolName: string): string {
  return context.codexSafeNames
    ? sanitizeMcpToolName(server.id, server.name, toolName)
    : legacyMcpToolName(server.name, toolName)
}

function resolveMcpServer(servers: readonly McpServer[], selector: string): McpServer {
  const requested = selector.trim()
  const byId = servers.find((server) => server.id === requested)
  if (byId) return byId
  const byName = servers.filter((server) => server.name === requested)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(
      `External MCP server name "${requested}" is ambiguous. Use one of these IDs: ${byName.map((server) => server.id).join(', ')}.`
    )
  }
  throw new Error(`External MCP server "${requested}" is not enabled for this conversation.`)
}

async function validateMcpInput(
  declaration: ListedMcpTool,
  input: unknown,
  options: { schemaInError?: boolean } = {}
): Promise<Record<string, unknown>> {
  const candidate = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const schema = (declaration.inputSchema ?? { type: 'object', properties: {} }) as JsonSchemaType
  const validation = mcpInputValidator.getValidator<Record<string, unknown>>(schema)(candidate)
  if (!validation.valid) {
    // A call through `mcp_call` may come from a model that never read the schema: hand it over once, to fix the call.
    throw new Error(
      `Invalid arguments for external MCP tool "${declaration.name}": ${validation.errorMessage}` +
        (options.schemaInError ? `\nInput schema: ${schemaHint(declaration)}` : '')
    )
  }
  return validation.data
}

async function externalMcpOutput(result: McpCallToolResult, outputOptions: McpToolOutputOptions): Promise<ToolOutput> {
  const describeImage = outputOptions.supportsImages === true ? undefined : outputOptions.describeImage
  const output = await describeToolOutputImages(mcpResultToChatToolOutput(result), describeImage)
  if (typeof output === 'string') return output
  if (output.structuredContent === undefined && !output.isError && toolOutputImages(output).length === 0) {
    return output.text
  }
  return output
}

function externalMcpModelOutput(output: unknown, outputOptions: McpToolOutputOptions): ToolResultOutput {
  const normalized = modelOutputToChatToolOutput(output)
  return typeof normalized === 'string'
    ? { type: 'text' as const, value: normalized || '(no output)' }
    : chatToolOutputToAiSdkOutput(normalized, { dropImages: outputOptions.supportsImages === false })
}

async function liveMcpDeclarations(server: McpServer, signal?: AbortSignal): Promise<ListedMcpTool[]> {
  const declarations = await getMcpRuntime().listTools(server, signal)
  try {
    writeMcpCatalog(server, declarations)
  } catch {
    // Cache persistence is best-effort; the live discovery remains authoritative for this call.
  }
  return declarations
}

/** A cached catalog serves searches and calls for this long; after it, the server is listed again. */
const MCP_CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000

/**
 * The tools of a server, from the cached catalog while it is recent and otherwise from the server itself (which also
 * refreshes the cache). Listing a server is a round trip that returns every schema: a call to one tool must not pay it.
 */
async function mcpDeclarations(
  server: McpServer,
  signal?: AbortSignal
): Promise<{ tools: ListedMcpTool[]; live: boolean }> {
  const entry = readMcpCatalogEntry(server)
  if (entry && entry.tools.length > 0 && Date.now() - entry.refreshedAt < MCP_CATALOG_MAX_AGE_MS) {
    return { tools: entry.tools, live: false }
  }
  return { tools: await liveMcpDeclarations(server, signal), live: true }
}

async function executeExternalMcpTool(args: {
  server: McpServer
  listedName: string
  input: unknown
  toolCallId: string
  signal?: AbortSignal
  context: ExternalMcpBuildContext
  /** Advertised name of a cached wrapper (it differs from the default when two tools collide). */
  advertised?: string
  /** The call comes from `mcp_call`: an invalid one gets the tool's schema back in its error. */
  schemaInError?: boolean
  /** The call comes from `mcp_read`, which refuses a tool that is not read-only. */
  readOnlyCall?: boolean
}): Promise<ToolOutput> {
  const find = (declarations: readonly ListedMcpTool[]) => declarations.find((entry) => entry.name === args.listedName)
  // Only a listing made now can tell that a tool turned from read-only to mutating, which Plan and Ask must refuse.
  const restricted = capabilityBehaviorFor(args.context.mode) !== 'agent'
  const listed = restricted
    ? { tools: await liveMcpDeclarations(args.server, args.signal), live: true }
    : await mcpDeclarations(args.server, args.signal)
  let live = listed.live
  let declaration = find(listed.tools)
  if (!declaration && !live) {
    // A tool the cache does not know may be new on the server: list it again before refusing the call.
    declaration = find(await liveMcpDeclarations(args.server, args.signal))
    live = true
  }
  if (!declaration || !mcpToolPermitted(args.server, declaration.name)) {
    throw new Error(`External MCP tool "${args.listedName}" is not available on server "${args.server.name}".`)
  }
  if (!externalMcpToolAllowed(args.context.mode, declaration.annotations)) {
    throw new Error(
      args.readOnlyCall
        ? `External MCP tool "${args.listedName}" is not declared read-only: call it with ${MCP_CALL_TOOL_NAME}.`
        : `External MCP tool "${args.listedName}" is not available in ${args.context.mode} mode.`
    )
  }
  let input: Record<string, unknown>
  try {
    input = await validateMcpInput(declaration, args.input, { schemaInError: args.schemaInError })
  } catch (error) {
    // The cached schema may be older than the server: only a listing made now can say the arguments are wrong.
    if (live) throw error
    const current = find(await liveMcpDeclarations(args.server, args.signal))
    if (!current || isDeepStrictEqual(current.inputSchema, declaration.inputSchema)) throw error
    declaration = current
    input = await validateMcpInput(declaration, args.input, { schemaInError: args.schemaInError })
  }
  const advertised = args.advertised ?? externalMcpToolName(args.context, args.server, declaration.name)
  if (args.signal) await args.context.gate(advertised, args.toolCallId, args.signal)
  else await args.context.gate(advertised, args.toolCallId)
  const requestOptions =
    args.signal || args.server.toolTimeoutMs
      ? {
          ...(args.signal ? { signal: args.signal } : {}),
          ...(args.server.toolTimeoutMs ? { timeout: args.server.toolTimeoutMs } : {}),
        }
      : undefined
  const result = await getMcpRuntime().callTool(args.server, declaration.name, input, requestOptions)
  return externalMcpOutput(result, args.context.outputOptions)
}

/** Signed-in accounts of a server that serve a conversation, without those turned off in it. */
export function conversationMcpAccounts(
  server: McpServer,
  conversationId: string | null | undefined
): McpOAuthAccountDto[] {
  if (server.transport === 'stdio' || server.unavailable) return []
  const disabled = new Set(
    typeof conversationId === 'string' ? (getConvUiPrefs(conversationId).chat?.tools?.mcpAccountsDisabled ?? []) : []
  )
  return activeMcpOAuthAccounts(server, conversationId).filter((account) => !disabled.has(`${server.id}#${account.id}`))
}

/**
 * Whether a conversation can reach a server: always, unless the server has signed-in accounts and none of them serves
 * the conversation (out of its scope, or turned off in it). Such a server is left out rather than reached with an
 * account the conversation may not use.
 */
export function mcpServerReachable(server: McpServer, accounts: readonly McpOAuthAccountDto[]): boolean {
  return accounts.length > 0 || server.transport === 'stdio' || mcpOAuthSummary(server).accounts.length === 0
}

/** The parameter a call names its account with, when the server has several. */
export const MCP_ACCOUNT_PARAMETER = 'mcp_account'

const accountChoices = (accounts: readonly McpOAuthAccountDto[]) => accounts.map((account) => account.label).join(', ')

/**
 * The connection a call uses: the server itself without accounts, its only account, or the account the call names
 * (exactly, or ignoring case). Several accounts and no valid name is an error the model can act on.
 */
function accountConnection(server: McpServer, accounts: readonly McpOAuthAccountDto[], label: unknown): McpServer {
  if (!accounts.length) return server
  if (accounts.length === 1) return { ...server, oauthAccountId: accounts[0].id }
  const name = typeof label === 'string' ? label.trim() : ''
  const chosen =
    accounts.find((account) => account.label === name) ??
    accounts.find((account) => account.label.toLowerCase() === name.toLowerCase())
  if (!name || !chosen) throw new Error(`Choose an account of "${server.name}": ${accountChoices(accounts)}.`)
  return { ...server, oauthAccountId: chosen.id }
}

/** The input schema of a tool whose server has several accounts: its own, plus the required account parameter. */
function withAccountParameter(schema: unknown, server: McpServer, accounts: readonly McpOAuthAccountDto[]): object {
  const base = (schema && typeof schema === 'object' ? schema : { type: 'object' }) as Record<string, unknown>
  const properties = (base.properties && typeof base.properties === 'object' ? base.properties : {}) as Record<
    string,
    unknown
  >
  const required = Array.isArray(base.required) ? base.required : []
  const described = accounts
    .map((account) =>
      account.email && account.email !== account.label ? `${account.label} (${account.email})` : account.label
    )
    .join(', ')
  return {
    ...base,
    type: 'object',
    properties: {
      ...properties,
      [MCP_ACCOUNT_PARAMETER]: {
        type: 'string',
        enum: accounts.map((account) => account.label),
        description: `Signed-in account of ${server.name} to use: ${described}. Ask the person when it is unclear.`,
      },
    },
    required: [...required, MCP_ACCOUNT_PARAMETER],
  }
}

/** True when a remote tool already has a parameter named like the account one; such a tool is reached by `mcp_call`. */
function declaresAccountParameter(declaration: ListedMcpTool): boolean {
  const properties = (declaration.inputSchema as { properties?: unknown } | undefined)?.properties
  return !!properties && typeof properties === 'object' && MCP_ACCOUNT_PARAMETER in properties
}

function cachedExternalMcpTool(
  server: McpServer,
  declaration: ListedMcpTool,
  context: ExternalMcpBuildContext,
  advertised: string,
  accounts: readonly McpOAuthAccountDto[] = []
): Tool {
  const metadata = {
    ...(capabilityBehaviorFor(context.mode) !== 'agent' || externalMcpToolReadOnly(declaration.annotations)
      ? EXTERNAL_MCP_RESTRICTED_METADATA
      : {}),
    ...DEFERRED_LOADING_METADATA,
    ...EXTERNAL_MCP_WRAPPER_METADATA,
  }
  const choose = accounts.length > 1
  const schema = (declaration.inputSchema as object) ?? { type: 'object', properties: {} }
  return tool({
    description: declaration.description ?? `MCP tool "${declaration.name}" from server ${server.name}.`,
    metadata,
    inputSchema: jsonSchema(choose ? withAccountParameter(schema, server, accounts) : schema),
    execute: async (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => {
      let args = input
      let label: unknown
      if (choose && input && typeof input === 'object' && !Array.isArray(input)) {
        const { [MCP_ACCOUNT_PARAMETER]: named, ...rest } = input as Record<string, unknown>
        args = rest
        label = named
      }
      return executeExternalMcpTool({
        server: accountConnection(server, accounts, label),
        listedName: declaration.name,
        input: args,
        toolCallId: options.toolCallId,
        signal: options.abortSignal,
        context,
        advertised,
      })
    },
    toModelOutput: ({ output }: { output: unknown }) => externalMcpModelOutput(output, context.outputOptions),
  })
}

function searchableMcpDeclaration(declaration: ListedMcpTool): Record<string, unknown> {
  return {
    name: declaration.name,
    ...(declaration.title ? { title: declaration.title } : {}),
    ...(declaration.description ? { description: declaration.description } : {}),
    ...(declaration.inputSchema ? { inputSchema: declaration.inputSchema } : {}),
    ...(declaration.annotations ? { annotations: declaration.annotations } : {}),
  }
}

/**
 * Builds the external MCP surface without starting a process or opening a network connection.
 * Cached declarations provide typed wrappers; mcp_search/mcp_call cover a cold catalog in the same turn.
 */
export async function buildMcpTools(args: BuildMcpToolsArgs): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const accountsOf = new Map<string, McpOAuthAccountDto[]>()
  const servers = listRuntimeMcpServers({ conversationId: args.conversationId }).filter((server) => {
    if (!server.enabled || server.unavailable || args.disabledIds?.has(server.id)) return false
    const accounts = conversationMcpAccounts(server, args.conversationId)
    accountsOf.set(server.id, accounts)
    return mcpServerReachable(server, accounts)
  })
  if (!servers.length) return { tools: {}, close: async () => {} }

  const context: ExternalMcpBuildContext = {
    mode: args.mode,
    gate: args.gate,
    codexSafeNames: Boolean(args.codexSafeNames),
    outputOptions: { supportsImages: args.supportsImages, describeImage: args.describeImage },
  }
  const tools: ToolSet = {}
  let cachedCount = 0
  const accountsFor = (server: McpServer) => accountsOf.get(server.id) ?? []
  const wrappers = args.surface !== 'on-demand'
  // How the model names each server: its display name, or its id when two share one.
  const labelOf = (server: McpServer) =>
    servers.filter((other) => other.name === server.name).length > 1 ? server.id : server.name
  const directory: McpDirectoryServer[] = []
  /** Tools a mode and a server's filter leave to the model, by server: what its searches and index may show. */
  const visibleTools = (server: McpServer, declarations: readonly ListedMcpTool[]) =>
    declarations.filter(
      (declaration) =>
        externalMcpToolAllowed(args.mode, declaration.annotations) && mcpToolPermitted(server, declaration.name)
    )
  for (const server of servers) {
    const declarations = readMcpCatalog(server)
    const accounts = accountsFor(server)
    chatDiag({
      kind: declarations.length ? 'mcp-lazy-catalog-hit' : 'mcp-lazy-catalog-miss',
      serverId: server.id,
      transport: server.transport,
      toolCount: declarations.length,
    })
    const visible = visibleTools(server, declarations)
    directory.push({
      label: labelOf(server),
      id: server.id,
      tools: declarations.length ? visible.map((entry) => entry.name) : null,
    })
    if (!wrappers) continue
    for (const declaration of visible) {
      if (accounts.length > 1 && declaresAccountParameter(declaration)) continue
      let advertised = externalMcpToolName(context, server, declaration.name)
      if (tools[advertised]) {
        // Legacy names are not unique (two servers with the same name, or truncation): never overwrite a tool.
        advertised = sanitizeMcpToolName(server.id, server.name, declaration.name)
        chatDiag({ kind: 'mcp-tool-name-collision', serverId: server.id, transport: server.transport })
        if (tools[advertised]) continue
      }
      tools[advertised] = cachedExternalMcpTool(server, declaration, context, advertised, accounts)
      cachedCount += 1
    }
  }

  const index =
    args.directory === 'servers'
      ? `Servers: ${directory.map(mcpServerTitle).join(', ')}.`
      : `Servers and their tools (names only):\n${renderMcpDirectory(directory)}`
  tools[MCP_SEARCH_TOOL_NAME] = tool({
    description:
      `Finds tools of the enabled external MCP servers and returns their schemas, without running them. ${index}\n` +
      `Give "query" (words of what you need), or "names" (exact tool names) to read their schemas; leave both out to ` +
      `list a server's tool names. "server" narrows the search; without it every server with a known catalog is ` +
      `searched. Then run a tool with ${MCP_CALL_TOOL_NAME}.`,
    metadata: EXTERNAL_MCP_RESTRICTED_METADATA,
    inputSchema: jsonSchema<{ server?: string; query?: string; names?: string[]; limit?: number; offset?: number }>({
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Exact server ID or unique configured display name.' },
        query: { type: 'string', description: 'Words that describe the tool you need, such as "datadog metric".' },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact tool names whose schemas you want (up to 25).',
        },
        limit: { type: 'integer', minimum: 1, maximum: MCP_LIST_MAX_LIMIT, description: 'Most results to return.' },
        offset: { type: 'integer', minimum: 0, description: 'First tool name of a listing, to continue it.' },
      },
      additionalProperties: false,
    }),
    execute: async (
      input: { server?: string; query?: string; names?: string[]; limit?: number; offset?: number },
      options: { toolCallId: string; abortSignal?: AbortSignal }
    ) => {
      const query = input.query?.trim() ?? ''
      const names = (Array.isArray(input.names) ? input.names : [])
        .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
        .slice(0, MCP_SEARCH_MAX_LIMIT)
      const scope = input.server?.trim() ? [resolveMcpServer(servers, input.server)] : servers
      const pool: Array<{ server: McpServer; tools: ListedMcpTool[] }> = []
      const unlisted: string[] = []
      for (const server of scope) {
        // Any account lists the same tools: use the first.
        const [first] = accountsFor(server)
        const connection = first ? { ...server, oauthAccountId: first.id } : server
        if (scope.length === 1) {
          const listed = await mcpDeclarations(connection, options.abortSignal)
          // What the cache holds is already sanitized; a listing made now is sanitized the same way before the model sees it.
          pool.push({
            server,
            tools: visibleTools(server, listed.live ? sanitizeMcpCatalogTools(listed.tools) : listed.tools),
          })
          continue
        }
        // Across servers nothing is started: a server never listed is named, to be searched on its own.
        const cached = readMcpCatalog(server)
        if (cached.length) pool.push({ server, tools: visibleTools(server, cached) })
        else unlisted.push(labelOf(server))
      }
      const withServer = pool.flatMap(({ server, tools: list }) => list.map((declaration) => ({ server, declaration })))
      const unlistedNote = unlisted.length
        ? {
            note: `Not searched, tools not listed yet: ${unlisted.join(', ')}. Search them with "server".`,
          }
        : {}
      const shown = (entry: { server: McpServer; declaration: ListedMcpTool }) => ({
        ...(scope.length > 1 ? { server: labelOf(entry.server) } : {}),
        ...searchableMcpDeclaration(entry.declaration),
      })
      const header = scope.length === 1 ? { server: { id: scope[0].id, name: scope[0].name } } : {}
      if (names.length > 0) {
        const wanted = new Set(names.map((name) => name.toLowerCase()))
        const found = withServer.filter((entry) => wanted.has(entry.declaration.name.toLowerCase()))
        const missing = names.filter(
          (name) => !found.some((entry) => entry.declaration.name.toLowerCase() === name.toLowerCase())
        )
        return JSON.stringify({
          ...header,
          tools: found.map(shown),
          ...(missing.length ? { missing } : {}),
          ...unlistedNote,
        })
      }
      if (query) {
        const ranked = rankMcpTools(
          withServer.map((entry) => entry.declaration),
          query
        )
        const byDeclaration = new Map(withServer.map((entry) => [entry.declaration, entry]))
        const limit = clampInteger(input.limit, MCP_SEARCH_DEFAULT_LIMIT, 1, MCP_SEARCH_MAX_LIMIT)
        const { taken, omitted } = takeWithinChars(
          ranked.slice(0, limit).map((declaration) => shown(byDeclaration.get(declaration)!)),
          (entry) => JSON.stringify(entry).length,
          MCP_SEARCH_RESULT_MAX_CHARS
        )
        const unseen = ranked.length - taken.length
        return JSON.stringify({
          ...header,
          tools: taken,
          matches: ranked.length,
          ...(unseen > 0
            ? {
                note: `${unseen} more match${unseen === 1 ? '' : 'es'}: narrow the query, or ask for them with "names".`,
              }
            : {}),
          ...(omitted > 0 && unseen <= 0 ? { omitted } : {}),
          ...unlistedNote,
        })
      }
      // Neither query nor names: only the tool names, a page at a time; a catalog is never returned whole.
      const offset = clampInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = clampInteger(input.limit, MCP_LIST_DEFAULT_LIMIT, 1, MCP_LIST_MAX_LIMIT)
      const page = withServer.slice(offset, offset + limit)
      return JSON.stringify({
        ...header,
        total: withServer.length,
        tools: page.map((entry) =>
          scope.length > 1 ? `${labelOf(entry.server)}:${entry.declaration.name}` : entry.declaration.name
        ),
        ...(offset + limit < withServer.length ? { nextOffset: offset + limit } : {}),
        note: 'Names only. Read schemas with "query" or "names".',
        ...unlistedNote,
      })
    },
  })
  const withAccounts = servers.filter((server) => accountsFor(server).length > 1)
  const accountNote = withAccounts.length
    ? ` These servers have several signed-in accounts; name one in "account" (ask the person when it is unclear): ${withAccounts
        .map((server) => `${server.name}: ${accountChoices(accountsFor(server))}`)
        .join('; ')}.`
    : ''
  const callSchema = jsonSchema<{
    server: string
    tool: string
    arguments?: Record<string, unknown>
    account?: string
  }>({
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Exact server ID or unique configured display name.' },
      tool: { type: 'string', description: 'Exact remote tool name returned by mcp_search.' },
      arguments: { type: 'object', additionalProperties: true },
      account: {
        type: 'string',
        description: 'Signed-in account to use, for a server with several. Its label, as listed in this description.',
      },
    },
    required: ['server', 'tool'],
    additionalProperties: false,
  })
  const callTool = (readOnly: boolean) =>
    tool({
      description: readOnly
        ? 'Calls one read-only tool (declared readOnlyHint) of an enabled external MCP server; any other is refused, ' +
          `use ${MCP_CALL_TOOL_NAME} for it. Use mcp_search first when the remote tool name or schema is unknown.` +
          accountNote
        : 'Calls one tool on an enabled external MCP server. Use mcp_search first when the remote tool name or schema is unknown.' +
          accountNote,
      ...(capabilityBehaviorFor(args.mode) !== 'agent' || readOnly
        ? {
            // `mcp_read` is deferred where the wrappers are, so a read-only subagent can reach it without the main model
            // paying for it; in Plan and Ask `mcp_call` is the way in and stays loaded.
            metadata:
              wrappers && readOnly
                ? { ...EXTERNAL_MCP_RESTRICTED_METADATA, ...DEFERRED_LOADING_METADATA }
                : EXTERNAL_MCP_RESTRICTED_METADATA,
          }
        : {}),
      inputSchema: callSchema,
      execute: async (
        input: { server: string; tool: string; arguments?: Record<string, unknown>; account?: string },
        options: { toolCallId: string; abortSignal?: AbortSignal }
      ) => {
        const server = resolveMcpServer(servers, input.server)
        return executeExternalMcpTool({
          server: accountConnection(server, accountsFor(server), input.account),
          listedName: input.tool,
          input: input.arguments ?? {},
          toolCallId: options.toolCallId,
          signal: options.abortSignal,
          // Read-only calls follow the same rules as Ask: a live listing confirms the tool is still read-only.
          context: readOnly ? { ...context, mode: 'ask' } : context,
          schemaInError: true,
          readOnlyCall: readOnly,
        })
      },
      toModelOutput: ({ output }: { output: unknown }) => externalMcpModelOutput(output, context.outputOptions),
    })
  tools[MCP_CALL_TOOL_NAME] = callTool(false)
  // A subagent limited to read-only tools needs a call tool that proves it cannot mutate: the wrappers it would use
  // instead are not handed to a runtime without tool search. Plan and Ask already restrict `mcp_call` itself.
  if (capabilityBehaviorFor(args.mode) === 'agent') tools[MCP_READ_TOOL_NAME] = callTool(true)
  chatDiag({
    kind: 'mcp-lazy-surface-built',
    serverCount: servers.length,
    cachedToolCount: cachedCount,
    toolCount: Object.keys(tools).length,
  })

  return { tools, close: async () => {} }
}

let appToolsRegistry: Promise<typeof import('../app-tools-registry')> | undefined

/**
 * The registry reaches this module again through the fleet instance, so it is loaded on first use. Every turn shares the
 * first load: a test runner treats the registry as a circular import and answers a second `import()` made while it is
 * still evaluating with the half-built module, whose tools then run against imports not yet bound.
 */
function loadAppToolsRegistry(): Promise<typeof import('../app-tools-registry')> {
  appToolsRegistry ??= import('../app-tools-registry').catch((error: unknown) => {
    appToolsRegistry = undefined
    throw error
  })
  return appToolsRegistry
}

/**
 * Native app tools connect in-process over an in-memory transport without HTTP or bearer tokens.
 * Reuse conversation-scoped tools from the registry while preserving their stable public names.
 */
export async function buildAppTools(args: {
  conversationId: string
  mode: ChatBehavior
  gate: (toolName: string, toolCallId: string, signal?: AbortSignal) => Promise<void>
  /** If present, expose ONLY these drawer tools (e.g. Plan mode = only review_plan). */
  only?: Set<string>
  /** If present, OMIT these drawer tools in addition to mode policy. */
  exclude?: Set<string>
  /** App-tool groups the user turned off; their tools are omitted even when `only` lists them. */
  disabledGroups?: readonly AppToolGroup[]
  /** Host-only operational scope for a delegated Maestro worker. Never enters a visible tool schema. */
  workerScope?: MaestroWorkerScope
  /** Effective capability of the model receiving app-tool results. */
  supportsImages?: boolean
  /** Host-owned fallback for runtimes without vision. */
  describeImage?: (image: ChatToolImage) => Promise<{ text: string; model?: string } | null>
}): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const { buildAppToolsServer } = await loadAppToolsRegistry()
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const server = buildAppToolsServer(args.conversationId, args.workerScope)
  const client = new Client({ name: 'maestrly-chat-app', version: '1.0.0' })
  try {
    await server.connect(serverT)
    await client.connect(clientT)
  } catch (e) {
    console.error('[chat] buildAppTools: failed to connect to the drawer in process:', e)
    await client.close().catch(() => {})
    await server.close().catch(() => {})
    return { tools: {}, close: async () => {} }
  }
  // Always exclude MCP review_plan: Plan uses the built-in submit-and-release version, not the blocking one.
  const disabledGroups = new Set(args.disabledGroups ?? [])
  const groupEnabled = (name: string) => {
    const group = appToolGroupOf(name)
    return group === null || !disabledGroups.has(group)
  }
  const accept = (listedTool: ListedMcpTool) =>
    appToolAllowed(args.mode, listedTool.name) &&
    groupEnabled(listedTool.name) &&
    (args.only?.has(listedTool.name) ?? true) &&
    !(args.exclude?.has(listedTool.name) ?? false)
  const restricted = capabilityBehaviorFor(args.mode) !== 'agent'
  // NO_TIMEOUT_MS: allow room for blocking drawer tools (plan-broker/gates govern the actual limit).
  const tools = await toolsFromClient(
    client,
    (n) => n,
    (n) => `Maestrly app tool: ${n}.`,
    args.gate,
    accept,
    NO_TIMEOUT_MS,
    (listedTool) => {
      const policy = restricted ? appToolMetadata(listedTool.name) : undefined
      return appToolDeferrable(listedTool.name) ? { ...policy, ...DEFERRED_LOADING_METADATA } : policy
    },
    { supportsImages: args.supportsImages, describeImage: args.describeImage },
    args.conversationId
  )
  if (Object.keys(tools).length === 0) {
    console.warn('[chat] buildAppTools: in-process registry returned no tools.')
  }
  return {
    tools,
    close: async () => {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    },
  }
}

/** The complete local collection surface; repository aliases never enter personal chats. */
export const PERSONAL_MEMORY_TOOLS = new Set([
  'memory_search',
  'memory_list',
  'memory_read',
  'memory_upsert',
  'memory_archive',
  'memory_restore',
  'memory_forget',
])

export function hasPersonalMemoryTools(conversationId: string): boolean {
  return memorySpaceForConversation(conversationId)?.kind === 'personal'
}
