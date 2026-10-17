import { z } from 'zod'
import { pluginTokenInputId } from '../../shared/plugins'
import { PLUGIN_LIMITS } from './limits'
import { parsePluginRelativePath } from './paths'

/**
 * Converts the MCP configuration of the three plugin formats into one model. Values keep two kinds of placeholders the
 * runtime expands once, non-recursively: `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`, and `${input:<id>}` for a value the user
 * supplies (a Claude `${user_config.KEY}` or `${VAR}`, a Codex `env_vars` entry). Each invalid entry is skipped with an
 * issue; the others still load.
 */

/**
 * `placeholderClient`: the plugin names an OAuth client only its publisher fills in (`<GMAIL_PUBLIC_CLIENT_ID>`). The
 * server still signs in like any other: by dynamic registration when it offers it, otherwise with the person's own client.
 * `manual`: the plugin names its publisher's real client, which is never used; the server takes the person's access token.
 */
export type PluginMcpAuth =
  | { kind: 'none' }
  | { kind: 'oauth'; resource?: string; scopes?: string[]; placeholderClient?: true }
  | { kind: 'manual'; reason: 'publisher-client' }
interface Common {
  key: string
  startupTimeoutMs?: number
  toolTimeoutMs?: number
  enabledByDefault: boolean
  toolFilter?: { allow?: string[]; deny?: string[] }
}
export type PluginStdioServerSpec = Common & {
  transport: 'stdio'
  command: string
  commandKind: 'bare' | 'plugin-relative'
  args: string[]
  env: Record<string, string>
  /** `./…` (plugin root), `${PLUGIN_ROOT}…`, or `${PLUGIN_DATA}…`. */
  cwd: string
  auth: { kind: 'none' }
}
export type PluginRemoteServerSpec = Common & {
  transport: 'http' | 'sse'
  url: string
  headers: Record<string, string>
  auth: PluginMcpAuth
}
export type PluginMcpServerSpec = PluginStdioServerSpec | PluginRemoteServerSpec
export interface PluginInputSpec {
  id: string
  label: string
  description: string | null
  sensitive: boolean
  required: boolean
  defaultValue: string | null
  target:
    | { kind: 'env'; serverKey: string; name: string }
    | { kind: 'header'; serverKey: string; name: string; prefix: string }
    | { kind: 'config'; key: string }
}
export interface McpIssue {
  code: 'entry-invalid' | 'transport-unsupported' | 'mcp-config-invalid' | 'mcp-bundle'
  subject: string
  detail: string
}
export interface NormalizedMcp {
  servers: PluginMcpServerSpec[]
  inputs: PluginInputSpec[]
  issues: McpIssue[]
}
export interface ClaudeUserConfigOption {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  title: string
  description: string
  required?: boolean
  default?: unknown
  sensitive?: boolean
}

export const AGENT_PLUGINS_SCHEMA_PREFIX = 'https://agent-plugins.org/schemas/'
export const AGENT_PLUGINS_SUPPORTED_VERSION = '1.0.0'
const MAX_SERVERS = 100
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const SERVER_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PLACEHOLDER_CLIENT = /^<[A-Z0-9_]+>$/
const INPUT_TOKEN = '${input:'
const PLUGIN_VARS = ['${PLUGIN_ROOT}', '${PLUGIN_DATA}'] as const

class EntryError extends Error {
  constructor(
    readonly code: McpIssue['code'],
    detail: string
  ) {
    super(detail)
  }
}
const invalid = (detail: string): never => {
  throw new EntryError('entry-invalid', detail)
}

/** Version of an Agent Plugins schema URI (`…/schemas/<v>/<kind>.schema.json`), or null. */
export function agentPluginsSchemaVersion(uri: unknown, kind: 'plugin' | 'mcp'): string | null {
  if (typeof uri !== 'string' || !uri.startsWith(AGENT_PLUGINS_SCHEMA_PREFIX)) return null
  const match = /^([^/]+)\/(plugin|mcp)\.schema\.json$/.exec(uri.slice(AGENT_PLUGINS_SCHEMA_PREFIX.length))
  return match && match[2] === kind ? match[1] : null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) invalid(`${field} must be strings`)
  return value as string[]
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string'))
    invalid(`${field} must map names to strings`)
  return { ...(value as Record<string, string>) }
}

function refuseInputTokens(values: readonly string[]): void {
  if (values.some((value) => value.includes(INPUT_TOKEN))) invalid('uses a reserved ${input:…} placeholder')
}

/** A single executable token: a bare name resolved through PATH, or a `./` path inside the plugin. */
function parseCommand(command: unknown): { command: string; commandKind: 'bare' | 'plugin-relative' } {
  if (typeof command !== 'string' || !command || /\s/.test(command) || command.includes('\0'))
    return invalid('command must be one executable token')
  if (command.startsWith('./')) {
    const parsed = parsePluginRelativePath(command)
    if (!parsed.ok || !parsed.segments.length) return invalid('command escapes the plugin')
    return { command: `./${parsed.segments.join('/')}`, commandKind: 'plugin-relative' }
  }
  if (/[/\\$]/.test(command) || command === '.' || command === '..')
    return invalid('command must be a bare name or a ./ path inside the plugin')
  return { command, commandKind: 'bare' }
}

/** `./…`, `${PLUGIN_ROOT}…` or `${PLUGIN_DATA}…`, normalized; anything else is invalid. */
function parseCwd(value: unknown): string {
  if (value === undefined) return './'
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0'))
    return invalid('cwd must be a plugin path')
  const relative = (rest: string, prefix: string): string => {
    const parsed = parsePluginRelativePath(rest)
    if (!parsed.ok) return invalid('cwd escapes the plugin')
    return parsed.segments.length ? `${prefix}${parsed.segments.join('/')}` : prefix
  }
  if (value === '.' || value.startsWith('./')) return relative(value, './')
  for (const variable of PLUGIN_VARS) {
    if (value === variable) return variable
    if (value.startsWith(`${variable}/`)) {
      const rest = relative(`./${value.slice(variable.length + 1)}`, `${variable}/`)
      return rest === `${variable}/` ? variable : rest
    }
  }
  return invalid('cwd must start with ./, ${PLUGIN_ROOT} or ${PLUGIN_DATA}')
}

const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)

/** Absolute http(s) URL without user information or fragment; plain HTTP only to a loopback host. */
export function checkMcpUrl(url: unknown): string {
  if (typeof url !== 'string' || !url || url.length > 2048 || url.includes('#')) return invalid('invalid URL')
  let parsed: URL
  try {
    // Placeholders expand at runtime; validate the URL's shape with them stood in for a plain label.
    parsed = new URL(url.replace(/\$\{[^}]*\}/g, 'placeholder'))
  } catch {
    return invalid('invalid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') invalid('URL must use https')
  if (parsed.username || parsed.password) invalid('URL must not contain user information')
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) invalid('plain HTTP is only allowed to loopback')
  return url
}

function checkHeaders(headers: Record<string, string>): Record<string, string> {
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) invalid(`invalid header name ${name}`)
    if (/[\r\n\0]/.test(value)) invalid(`invalid value for header ${name}`)
    const lower = name.toLowerCase()
    if (seen.has(lower)) invalid(`duplicate header ${name}`)
    seen.add(lower)
  }
  return headers
}

function capTimeout(value: unknown, unit: 'sec' | 'ms', max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Math.round(unit === 'sec' ? value * 1000 : value), max)
}

function serverEntries(map: unknown, issues: McpIssue[]): [string, unknown][] {
  if (!isRecord(map)) {
    issues.push({ code: 'mcp-config-invalid', subject: 'mcpServers', detail: 'mcpServers must be an object' })
    return []
  }
  const entries = Object.entries(map)
  if (entries.length > MAX_SERVERS)
    issues.push({ code: 'mcp-config-invalid', subject: 'mcpServers', detail: `only ${MAX_SERVERS} servers are read` })
  return entries.slice(0, MAX_SERVERS)
}

class InputCollector {
  readonly inputs = new Map<string, PluginInputSpec>()
  add(input: PluginInputSpec): string {
    const existing = this.inputs.get(input.id)
    if (!existing) this.inputs.set(input.id, input)
    else if (input.required) existing.required = true
    return input.id
  }
  list(): PluginInputSpec[] {
    return [...this.inputs.values()]
  }
}

function run(
  subject: string,
  issues: McpIssue[],
  servers: PluginMcpServerSpec[],
  build: () => PluginMcpServerSpec | null,
  inputs: InputCollector
): void {
  const snapshot = new Map(inputs.inputs)
  try {
    if (!SERVER_KEY.test(subject)) invalid('server names use letters, digits, dots, dashes and underscores')
    const server = build()
    if (server) servers.push(server)
  } catch (error) {
    inputs.inputs.clear()
    for (const [id, input] of snapshot) inputs.inputs.set(id, input)
    if (error instanceof EntryError) issues.push({ code: error.code, subject, detail: error.message })
    else throw error
  }
}

// ---------------------------------------------------------------- Agent Plugins

const apStdio = z
  .object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict()
const apRemote = z
  .object({
    type: z.enum(['streamable-http', 'sse']),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict()

export function normalizeAgentPluginsMcp(json: unknown, manifestSchema: string): NormalizedMcp {
  const issues: McpIssue[] = []
  const servers: PluginMcpServerSpec[] = []
  const inputs = new InputCollector()
  const config = (detail: string): NormalizedMcp => ({
    servers: [],
    inputs: [],
    issues: [{ code: 'mcp-config-invalid', subject: 'mcp.json', detail }],
  })
  if (!isRecord(json)) return config('mcp.json must contain an object')
  const extra = Object.keys(json).filter((key) => key !== '$schema' && key !== 'mcpServers')
  if (extra.length) return config(`unknown top-level fields: ${extra.join(', ')}`)
  const version = agentPluginsSchemaVersion(json.$schema, 'mcp')
  if (version !== AGENT_PLUGINS_SUPPORTED_VERSION) return config('unsupported MCP configuration version')
  if (agentPluginsSchemaVersion(manifestSchema, 'plugin') !== version)
    return config('MCP configuration version differs from plugin.json')
  for (const [key, raw] of serverEntries(json.mcpServers, issues)) {
    run(
      key,
      issues,
      servers,
      () => {
        if (!isRecord(raw)) return invalid('server must be an object')
        if (raw.type === 'stdio') {
          const parsed = apStdio.safeParse(raw)
          if (!parsed.success) return invalid('invalid stdio server fields')
          const env = parsed.data.env ?? {}
          if (Object.keys(env).some((name) => /^PLUGIN_(ROOT|DATA)$/i.test(name)))
            invalid('env must not set PLUGIN_ROOT or PLUGIN_DATA')
          const args = parsed.data.args ?? []
          refuseInputTokens([...args, ...Object.values(env), parsed.data.cwd ?? ''])
          return {
            key,
            transport: 'stdio',
            ...parseCommand(parsed.data.command),
            args,
            env,
            cwd: parseCwd(parsed.data.cwd),
            enabledByDefault: true,
            auth: { kind: 'none' },
          }
        }
        if (raw.type === 'streamable-http' || raw.type === 'sse') {
          const parsed = apRemote.safeParse(raw)
          if (!parsed.success) return invalid('invalid remote server fields')
          if (/\$\{/.test(parsed.data.url)) invalid('URLs are not expanded')
          const headers = checkHeaders({ ...(parsed.data.headers ?? {}) })
          refuseInputTokens(Object.values(headers))
          return {
            key,
            transport: parsed.data.type === 'sse' ? 'sse' : 'http',
            url: checkMcpUrl(parsed.data.url),
            headers,
            enabledByDefault: true,
            auth: { kind: 'none' },
          }
        }
        return invalid('unknown server type')
      },
      inputs
    )
  }
  return { servers, inputs: inputs.list(), issues }
}

// ---------------------------------------------------------------- Codex

function codexAuth(raw: Record<string, unknown>): PluginMcpAuth {
  const oauth = isRecord(raw.oauth) ? raw.oauth : null
  const clientId = typeof oauth?.client_id === 'string' ? oauth.client_id.trim() : ''
  const resource = typeof raw.oauth_resource === 'string' ? raw.oauth_resource : undefined
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.filter((s): s is string => typeof s === 'string') : undefined
  const hints = { ...(resource ? { resource } : {}), ...(scopes?.length ? { scopes } : {}) }
  // A placeholder is never sent anywhere, and neither is its secret.
  if (clientId && PLACEHOLDER_CLIENT.test(clientId)) return { kind: 'oauth', ...hints, placeholderClient: true }
  if (clientId || (oauth && typeof oauth.client_secret === 'string'))
    return { kind: 'manual', reason: 'publisher-client' }
  if (resource || scopes?.length || oauth) return { kind: 'oauth', ...hints }
  return { kind: 'none' }
}

/**
 * A server whose plugin signs in only with its publisher's client takes the person's token instead, as a bearer
 * `Authorization` header, unless its configuration already sets that header or asks for it.
 */
function addTokenInput(inputs: InputCollector, key: string, headers: Record<string, string>): void {
  const isAuthorization = (name: string) => name.toLowerCase() === 'authorization'
  if (Object.keys(headers).some(isAuthorization)) return
  for (const input of inputs.inputs.values())
    if (input.target.kind === 'header' && input.target.serverKey === key && isAuthorization(input.target.name)) return
  inputs.add({
    id: pluginTokenInputId(key),
    label: `${key} access token`,
    description: null,
    sensitive: true,
    required: true,
    defaultValue: null,
    target: { kind: 'header', serverKey: key, name: 'Authorization', prefix: 'Bearer ' },
  })
}

function codexCommon(key: string, raw: Record<string, unknown>): Common {
  const startup =
    capTimeout(raw.startup_timeout_sec, 'sec', PLUGIN_LIMITS.startupTimeoutMaxMs) ??
    capTimeout(raw.startup_timeout_ms, 'ms', PLUGIN_LIMITS.startupTimeoutMaxMs)
  const tool =
    capTimeout(raw.tool_timeout_sec, 'sec', PLUGIN_LIMITS.toolTimeoutMaxMs) ??
    capTimeout(raw.tool_timeout_ms, 'ms', PLUGIN_LIMITS.toolTimeoutMaxMs)
  const allow = raw.enabled_tools !== undefined ? stringArray(raw.enabled_tools, 'enabled_tools') : undefined
  const deny = raw.disabled_tools !== undefined ? stringArray(raw.disabled_tools, 'disabled_tools') : undefined
  return {
    key,
    ...(startup ? { startupTimeoutMs: startup } : {}),
    ...(tool ? { toolTimeoutMs: tool } : {}),
    enabledByDefault: raw.enabled !== false,
    ...(allow || deny ? { toolFilter: { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } } : {}),
  }
}

export function normalizeCodexMcp(json: unknown): NormalizedMcp {
  const issues: McpIssue[] = []
  const servers: PluginMcpServerSpec[] = []
  const inputs = new InputCollector()
  if (!isRecord(json))
    return {
      servers,
      inputs: [],
      issues: [{ code: 'mcp-config-invalid', subject: '.mcp.json', detail: 'not an object' }],
    }
  const map = isRecord(json.mcpServers) ? json.mcpServers : json
  for (const [key, raw] of serverEntries(map, issues)) {
    if (key === '$schema') continue
    run(
      key,
      issues,
      servers,
      () => {
        if (!isRecord(raw)) return invalid('server must be an object')
        const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined
        const remoteType = type === 'http' || type === 'streamable_http' || type === 'streamable-http'
        if (type !== undefined && !remoteType && type !== 'sse' && type !== 'stdio')
          throw new EntryError('transport-unsupported', `transport ${type} is not supported`)
        const common = codexCommon(key, raw)
        if (type === 'sse' || remoteType || (type === undefined && raw.url !== undefined)) {
          const headers = checkHeaders(stringRecord(raw.http_headers ?? raw.headers, 'http_headers'))
          refuseInputTokens(Object.values(headers))
          for (const [header, variable] of Object.entries(stringRecord(raw.env_http_headers, 'env_http_headers'))) {
            if (!HEADER_NAME.test(header) || !ENV_NAME.test(variable)) invalid('invalid env_http_headers entry')
            inputs.add({
              id: `header:${key}:${header}`,
              label: variable,
              description: null,
              sensitive: true,
              required: false,
              defaultValue: null,
              target: { kind: 'header', serverKey: key, name: header, prefix: '' },
            })
          }
          if (raw.bearer_token_env_var !== undefined) {
            if (typeof raw.bearer_token_env_var !== 'string' || !ENV_NAME.test(raw.bearer_token_env_var))
              invalid('invalid bearer_token_env_var')
            inputs.add({
              id: `header:${key}:Authorization`,
              label: raw.bearer_token_env_var as string,
              description: null,
              sensitive: true,
              required: true,
              defaultValue: null,
              target: { kind: 'header', serverKey: key, name: 'Authorization', prefix: 'Bearer ' },
            })
          }
          const auth = codexAuth(raw)
          if (auth.kind === 'manual') addTokenInput(inputs, key, headers)
          return {
            ...common,
            transport: type === 'sse' ? 'sse' : 'http',
            url: checkMcpUrl(raw.url),
            headers,
            auth,
          }
        }
        if (raw.command === undefined) return invalid('a server needs a url or a command')
        const args = stringArray(raw.args, 'args')
        const env = stringRecord(raw.env, 'env')
        refuseInputTokens([...args, ...Object.values(env), typeof raw.cwd === 'string' ? raw.cwd : ''])
        for (const variable of stringArray(raw.env_vars, 'env_vars')) {
          if (!ENV_NAME.test(variable)) invalid(`invalid env_vars entry ${variable}`)
          inputs.add({
            id: `env:${key}:${variable}`,
            label: variable,
            description: null,
            sensitive: true,
            required: false,
            defaultValue: null,
            target: { kind: 'env', serverKey: key, name: variable },
          })
        }
        return {
          ...common,
          transport: 'stdio',
          ...parseCommand(raw.command),
          args,
          env,
          cwd: parseCwd(raw.cwd),
          auth: { kind: 'none' },
        }
      },
      inputs
    )
  }
  return { servers, inputs: inputs.list(), issues }
}

// ---------------------------------------------------------------- Claude

const CLAUDE_VAR = /\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::-([^}]*))?\}/g

/**
 * Rewrites Claude variables in one value: plugin directories become the Agent Plugins placeholders, user_config keys
 * and environment references become `${input:…}` tokens.
 */
function rewriteClaudeValue(
  value: string,
  serverKey: string,
  userConfig: Record<string, ClaudeUserConfigOption>,
  inputs: InputCollector
): string {
  if (value.includes(INPUT_TOKEN)) invalid('uses a reserved ${input:…} placeholder')
  return value.replace(CLAUDE_VAR, (whole, name: string, fallback: string | undefined) => {
    if (name === 'CLAUDE_PLUGIN_ROOT' || name === 'PLUGIN_ROOT') return '${PLUGIN_ROOT}'
    if (name === 'CLAUDE_PLUGIN_DATA' || name === 'PLUGIN_DATA') return '${PLUGIN_DATA}'
    if (name.startsWith('user_config.')) {
      const configKey = name.slice('user_config.'.length)
      const option = Object.hasOwn(userConfig, configKey) ? userConfig[configKey] : undefined
      if (!option) return invalid(`user_config.${configKey} is not declared`)
      const defaultValue =
        option.default === undefined || option.default === null
          ? null
          : Array.isArray(option.default)
            ? option.default.join(',')
            : String(option.default)
      return `\${input:${inputs.add({
        id: `config:${configKey}`,
        label: option.title || configKey,
        description: option.description || null,
        sensitive: option.sensitive === true,
        required: option.required === true,
        defaultValue,
        target: { kind: 'config', key: configKey },
      })}}`
    }
    if (name.includes('.')) return whole
    return `\${input:${inputs.add({
      id: `env:${serverKey}:${name}`,
      label: name,
      description: null,
      sensitive: true,
      required: false,
      defaultValue: fallback ?? null,
      target: { kind: 'env', serverKey, name },
    })}}`
  })
}

export function normalizeClaudeMcp(json: unknown, userConfig: Record<string, ClaudeUserConfigOption>): NormalizedMcp {
  const issues: McpIssue[] = []
  const servers: PluginMcpServerSpec[] = []
  const inputs = new InputCollector()
  if (typeof json === 'string') {
    const bundle = /\.(mcpb|dxt)$/i.test(json)
    return {
      servers,
      inputs: [],
      issues: [
        bundle
          ? { code: 'mcp-bundle', subject: json, detail: 'MCP bundles are not supported' }
          : { code: 'mcp-config-invalid', subject: json, detail: 'unresolved MCP configuration path' },
      ],
    }
  }
  if (!isRecord(json))
    return {
      servers,
      inputs: [],
      issues: [{ code: 'mcp-config-invalid', subject: '.mcp.json', detail: 'not an object' }],
    }
  const map = isRecord(json.mcpServers) ? json.mcpServers : json
  for (const [key, raw] of serverEntries(map, issues)) {
    run(
      key,
      issues,
      servers,
      () => {
        if (!isRecord(raw)) return invalid('server must be an object')
        if (raw.headersHelper !== undefined) invalid('headersHelper runs a shell command')
        const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : raw.url !== undefined ? 'http' : 'stdio'
        const rewrite = (value: string) => rewriteClaudeValue(value, key, userConfig, inputs)
        if (type === 'http' || type === 'sse' || type === 'streamable-http') {
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(stringRecord(raw.headers, 'headers')))
            headers[name] = rewrite(value)
          checkHeaders(headers)
          if (typeof raw.url !== 'string') return invalid('invalid URL')
          return {
            key,
            transport: type === 'sse' ? 'sse' : 'http',
            url: checkMcpUrl(rewrite(raw.url)),
            headers,
            enabledByDefault: true,
            auth: { kind: 'none' },
          }
        }
        if (type !== 'stdio') throw new EntryError('transport-unsupported', `transport ${type} is not supported`)
        if (typeof raw.command !== 'string') return invalid('command must be one executable token')
        const command = raw.command.startsWith('${CLAUDE_PLUGIN_ROOT}/')
          ? `./${raw.command.slice('${CLAUDE_PLUGIN_ROOT}/'.length)}`
          : raw.command
        const args = stringArray(raw.args, 'args').map(rewrite)
        const env: Record<string, string> = {}
        for (const [name, value] of Object.entries(stringRecord(raw.env, 'env'))) {
          if (!ENV_NAME.test(name)) invalid(`invalid environment variable ${name}`)
          env[name] = rewrite(value)
        }
        return {
          key,
          transport: 'stdio',
          ...parseCommand(command),
          args,
          env,
          cwd: parseCwd(typeof raw.cwd === 'string' ? rewrite(raw.cwd) : raw.cwd),
          enabledByDefault: true,
          auth: { kind: 'none' },
        }
      },
      inputs
    )
  }
  return { servers, inputs: inputs.list(), issues }
}
