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
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { tool, jsonSchema, type Tool, type ToolSet } from 'ai'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { getAppSetting, setAppSetting } from '../store'
import type { ChatToolImage, ToolOutput } from '../../shared/chat'
import type { ChatBehavior } from '../../shared/conversation-experience'
import { capabilityBehaviorFor } from '../../shared/chat-mode'
import { toolOutputImages } from '../../shared/chat'
import type { MaestroWorkerScope } from '../maestro-worker-scope'
import {
  chatToolOutputToAiSdkOutput,
  describeToolOutputImages,
  mcpResultToChatToolOutput,
  modelOutputToChatToolOutput,
} from './tool-output'
import {
  EXTERNAL_MCP_RESTRICTED_METADATA,
  appToolAllowed,
  appToolMetadata,
  externalMcpToolAllowed,
  externalMcpToolReadOnly,
} from './tool-policy'
import { chatDiag } from './diag-log'
import {
  mcpServerFingerprint,
  readMcpCatalog,
  removeMcpCatalog,
  sanitizeMcpCatalogTools,
  writeMcpCatalog,
} from './mcp-catalog'
import { LazyMcpRuntime, type LazyMcpDiagnostic } from './mcp-lazy-runtime'
import type {
  ListedMcpTool,
  McpCallToolResult,
  McpConnection,
  McpRequestOptions,
  McpServer,
} from './mcp-types'
export type {
  ListedMcpTool,
  McpCallToolResult,
  McpConnection,
  McpRequestOptions,
  McpServer,
  McpTransport,
} from './mcp-types'
// Import the registry dynamically so native tools load only when app tools are built.

const MCP_KEY = 'chat.mcpServers'

export function listMcpServers(): McpServer[] {
  const raw = getAppSetting(MCP_KEY)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as McpServer[]).filter((s) => s && typeof s.id === 'string') : []
  } catch {
    return []
  }
}

function saveMcpServers(list: McpServer[]): void {
  setAppSetting(MCP_KEY, JSON.stringify(list))
}

export function addMcpServer(input: Omit<McpServer, 'id' | 'enabled'> & { enabled?: boolean }): McpServer {
  const name = input.name?.trim()
  if (!name) throw new Error('Enter an MCP server name.')
  if (input.transport === 'http') {
    if (!input.url || !/^https?:\/\//i.test(input.url)) throw new Error('Enter the MCP server HTTP(S) URL.')
  } else if (input.transport === 'stdio') {
    if (!input.command?.trim()) throw new Error('Enter the MCP server command (stdio).')
  } else {
    throw new Error('Invalid MCP transport.')
  }
  const server: McpServer = {
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
  saveMcpServers([...listMcpServers(), server])
  return server
}

export function updateMcpServer(id: string, patch: Partial<McpServer>): void {
  const list = listMcpServers()
  const idx = list.findIndex((s) => s.id === id)
  if (idx < 0) return
  const previous = list[idx]
  const next = { ...previous, ...patch, id: previous.id }
  list[idx] = next
  saveMcpServers(list)
  invalidateMcpRuntime(id)
  if (mcpServerFingerprint(previous) !== mcpServerFingerprint(next)) removeMcpCatalog(id)
}

export function removeMcpServer(id: string): void {
  saveMcpServers(listMcpServers().filter((s) => s.id !== id))
  invalidateMcpRuntime(id)
  removeMcpCatalog(id)
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
  const client = new Client({ name: 'maestrly-chat', version: '1.0.0' })
  try {
    if (server.transport === 'http') {
      const transport = new StreamableHTTPClientTransport(new URL(server.url!), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      })
      await client.connect(transport, options)
    } else {
      const transport = new StdioClientTransport({
        command: server.command!,
        args: server.args ?? [],
        env: server.env,
      })
      await client.connect(transport, options)
    }
    return connectionFromClient(client)
  } catch (error) {
    await client.close().catch(() => {})
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

function invalidateMcpRuntime(serverId: string): void {
  sharedMcpRuntime?.invalidate(serverId)
}

/** Closes pooled external MCP transports. Exported for deterministic shutdown/tests. */
export async function disposeMcpRuntime(): Promise<void> {
  const runtime = sharedMcpRuntime
  sharedMcpRuntime = null
  await runtime?.dispose()
}

export interface BuildMcpToolsArgs {
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
  outputOptions: McpToolOutputOptions = {}
): Promise<ToolSet> {
  return toolsFromConnection(
    connectionFromClient(client),
    nameFor,
    describeFallback,
    gate,
    filter,
    callTimeoutMs,
    metadataFor,
    outputOptions
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
  outputOptions: McpToolOutputOptions = {}
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
      execute: async (input: unknown, opts: { toolCallId: string; abortSignal?: AbortSignal }) => {
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
      },
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

interface ExternalMcpBuildContext {
  mode: ChatBehavior
  gate: BuildMcpToolsArgs['gate']
  codexSafeNames: boolean
  outputOptions: McpToolOutputOptions
}

const mcpInputValidator = new AjvJsonSchemaValidator()

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

async function validateMcpInput(declaration: ListedMcpTool, input: unknown): Promise<Record<string, unknown>> {
  const candidate = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const schema = (declaration.inputSchema ?? { type: 'object', properties: {} }) as JsonSchemaType
  const validation = mcpInputValidator.getValidator<Record<string, unknown>>(schema)(candidate)
  if (!validation.valid) {
    throw new Error(`Invalid arguments for external MCP tool "${declaration.name}": ${validation.errorMessage}`)
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

async function executeExternalMcpTool(args: {
  server: McpServer
  listedName: string
  input: unknown
  toolCallId: string
  signal?: AbortSignal
  context: ExternalMcpBuildContext
}): Promise<ToolOutput> {
  const declarations = await liveMcpDeclarations(args.server, args.signal)
  const declaration = declarations.find((entry) => entry.name === args.listedName)
  if (!declaration) {
    throw new Error(`External MCP tool "${args.listedName}" is not available on server "${args.server.name}".`)
  }
  if (!externalMcpToolAllowed(args.context.mode, declaration.annotations)) {
    throw new Error(`External MCP tool "${args.listedName}" is not available in ${args.context.mode} mode.`)
  }
  const input = await validateMcpInput(declaration, args.input)
  const advertised = externalMcpToolName(args.context, args.server, declaration.name)
  if (args.signal) await args.context.gate(advertised, args.toolCallId, args.signal)
  else await args.context.gate(advertised, args.toolCallId)
  const result = await getMcpRuntime().callTool(
    args.server,
    declaration.name,
    input,
    args.signal ? { signal: args.signal } : undefined
  )
  return externalMcpOutput(result, args.context.outputOptions)
}

function cachedExternalMcpTool(server: McpServer, declaration: ListedMcpTool, context: ExternalMcpBuildContext): Tool {
  const metadata =
    capabilityBehaviorFor(context.mode) !== 'agent' || externalMcpToolReadOnly(declaration.annotations)
      ? EXTERNAL_MCP_RESTRICTED_METADATA
      : undefined
  return tool({
    description: declaration.description ?? `MCP tool "${declaration.name}" from server ${server.name}.`,
    ...(metadata ? { metadata } : {}),
    inputSchema: jsonSchema((declaration.inputSchema as object) ?? { type: 'object', properties: {} }),
    execute: (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) =>
      executeExternalMcpTool({
        server,
        listedName: declaration.name,
        input,
        toolCallId: options.toolCallId,
        signal: options.abortSignal,
        context,
      }),
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
  const servers = listMcpServers().filter((server) => server.enabled && !args.disabledIds?.has(server.id))
  if (!servers.length) return { tools: {}, close: async () => {} }

  const context: ExternalMcpBuildContext = {
    mode: args.mode,
    gate: args.gate,
    codexSafeNames: Boolean(args.codexSafeNames),
    outputOptions: { supportsImages: args.supportsImages, describeImage: args.describeImage },
  }
  const tools: ToolSet = {}
  let cachedCount = 0
  for (const server of servers) {
    const declarations = readMcpCatalog(server)
    chatDiag({
      kind: declarations.length ? 'mcp-lazy-catalog-hit' : 'mcp-lazy-catalog-miss',
      serverId: server.id,
      transport: server.transport,
      toolCount: declarations.length,
    })
    for (const declaration of declarations) {
      if (!externalMcpToolAllowed(args.mode, declaration.annotations)) continue
      const advertised = externalMcpToolName(context, server, declaration.name)
      tools[advertised] = cachedExternalMcpTool(server, declaration, context)
      cachedCount += 1
    }
  }

  const serverSummary = servers.map((server) => `${server.name} (${server.id})`).join(', ')
  tools[MCP_SEARCH_TOOL_NAME] = tool({
    description:
      `Discovers tools from one enabled external MCP server without executing them. Servers: ${serverSummary}. ` +
      `Use ${MCP_CALL_TOOL_NAME} to call a discovered tool in the same turn.`,
    metadata: EXTERNAL_MCP_RESTRICTED_METADATA,
    inputSchema: jsonSchema<{ server: string; query?: string }>({
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Exact server ID or unique configured display name.' },
        query: { type: 'string', description: 'Optional case-insensitive name/description filter.' },
      },
      required: ['server'],
      additionalProperties: false,
    }),
    execute: async (
      input: { server: string; query?: string },
      options: { toolCallId: string; abortSignal?: AbortSignal }
    ) => {
      const server = resolveMcpServer(servers, input.server)
      const liveDeclarations = await liveMcpDeclarations(server, options.abortSignal)
      const query = input.query?.trim().toLowerCase() ?? ''
      const declarations = sanitizeMcpCatalogTools(liveDeclarations).filter(
        (declaration) =>
          externalMcpToolAllowed(args.mode, declaration.annotations) &&
          (!query ||
            `${declaration.name}\n${declaration.title ?? ''}\n${declaration.description ?? ''}`
              .toLowerCase()
              .includes(query))
      )
      return JSON.stringify({
        server: { id: server.id, name: server.name },
        tools: declarations.map(searchableMcpDeclaration),
      })
    },
  })
  tools[MCP_CALL_TOOL_NAME] = tool({
    description:
      'Calls one tool on an enabled external MCP server. Use mcp_search first when the remote tool name or schema is unknown.',
    ...(capabilityBehaviorFor(args.mode) !== 'agent' ? { metadata: EXTERNAL_MCP_RESTRICTED_METADATA } : {}),
    inputSchema: jsonSchema<{ server: string; tool: string; arguments?: Record<string, unknown> }>({
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Exact server ID or unique configured display name.' },
        tool: { type: 'string', description: 'Exact remote tool name returned by mcp_search.' },
        arguments: { type: 'object', additionalProperties: true },
      },
      required: ['server', 'tool'],
      additionalProperties: false,
    }),
    execute: (
      input: { server: string; tool: string; arguments?: Record<string, unknown> },
      options: { toolCallId: string; abortSignal?: AbortSignal }
    ) => {
      const server = resolveMcpServer(servers, input.server)
      return executeExternalMcpTool({
        server,
        listedName: input.tool,
        input: input.arguments ?? {},
        toolCallId: options.toolCallId,
        signal: options.abortSignal,
        context,
      })
    },
    toModelOutput: ({ output }: { output: unknown }) => externalMcpModelOutput(output, context.outputOptions),
  })
  chatDiag({
    kind: 'mcp-lazy-surface-built',
    serverCount: servers.length,
    cachedToolCount: cachedCount,
    toolCount: Object.keys(tools).length,
  })

  return { tools, close: async () => {} }
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
  /** Host-only operational scope for a delegated Maestro worker. Never enters a visible tool schema. */
  workerScope?: MaestroWorkerScope
  /** Effective capability of the model receiving app-tool results. */
  supportsImages?: boolean
  /** Host-owned fallback for runtimes without vision. */
  describeImage?: (image: ChatToolImage) => Promise<{ text: string; model?: string } | null>
}): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const { buildAppToolsServer } = await import('../app-tools-registry')
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
  const accept = (listedTool: ListedMcpTool) =>
    appToolAllowed(args.mode, listedTool.name) &&
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
    restricted ? (listedTool) => appToolMetadata(listedTool.name) : undefined,
    { supportsImages: args.supportsImages, describeImage: args.describeImage }
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
