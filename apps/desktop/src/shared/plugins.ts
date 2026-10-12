import type { McpOAuthSummaryDto } from './chat'

/**
 * Plugin DTOs shared by the main process and the renderer. A plugin is installed once per host (this computer, a
 * remote workspaces host, or a bot environment); its skills and MCP servers reach every provider through Maestrly's
 * own skill catalog and MCP proxy. No secret value ever appears in these types.
 */

export type PluginFormat = 'agent-plugins' | 'codex' | 'claude'
/**
 * Portable: works the same with every model (its skills, MCP servers and adapted parts). Unavailable: nothing in it
 * works the same with every model, so it is not offered. There is no in-between: parts that only work in one product
 * are listed as not included.
 */
export type PluginCompatibilityLevel = 'portable' | 'unavailable'
export type PluginComponentKind =
  | 'skill'
  | 'command'
  | 'agent'
  | 'mcp-server'
  | 'app-connector'
  | 'hooks'
  | 'lsp'
  | 'monitor'
  | 'output-style'
  | 'theme'
  | 'workflow'
  | 'bin'
  | 'settings'
  | 'channel'
  | 'extension'
  | 'mcp-bundle'
  | 'symlink'
  | 'submodule'
export type PluginComponentStatus = 'supported' | 'adapted' | 'not-run' | 'unavailable' | 'invalid'
export type PluginReasonCode =
  | 'manifest-invalid'
  | 'schema-unsupported'
  | 'source-unsupported'
  | 'install-not-available'
  | 'no-usable-components'
  | 'requires-app-connector'
  | 'app-connector'
  | 'hooks-not-run'
  | 'agent-not-adapted'
  | 'component-unsupported'
  | 'entry-invalid'
  | 'transport-unsupported'
  | 'auth-publisher-client'
  | 'auth-placeholder-client'
  | 'symlink-skipped'
  | 'submodule-skipped'

export const PLUGIN_REASON_CODES: readonly PluginReasonCode[] = [
  'manifest-invalid',
  'schema-unsupported',
  'source-unsupported',
  'install-not-available',
  'no-usable-components',
  'requires-app-connector',
  'app-connector',
  'hooks-not-run',
  'agent-not-adapted',
  'component-unsupported',
  'entry-invalid',
  'transport-unsupported',
  'auth-publisher-client',
  'auth-placeholder-client',
  'symlink-skipped',
  'submodule-skipped',
]

/** Reasons that make a plugin not compatible; every other reason only notes a part that is not included. */
export const BLOCKING_REASON_CODES: readonly PluginReasonCode[] = [
  'manifest-invalid',
  'schema-unsupported',
  'source-unsupported',
  'install-not-available',
  'no-usable-components',
  'requires-app-connector',
]
export const isBlockingReason = (code: PluginReasonCode): boolean => BLOCKING_REASON_CODES.includes(code)

export interface PluginReason {
  code: PluginReasonCode
  component?: PluginComponentKind
  subject?: string
  detail?: string
}
export interface PluginCompatibility {
  level: PluginCompatibilityLevel
  reasons: PluginReason[]
}
export interface PluginComponentDto {
  kind: PluginComponentKind
  name: string
  status: PluginComponentStatus
  reason?: PluginReasonCode
  detail?: string
}
export type PluginScope = { kind: 'global' } | { kind: 'projects'; workspaceIds: string[] }
export interface PluginInputDto {
  id: string
  label: string
  description: string | null
  sensitive: boolean
  required: boolean
  set: boolean
  target: 'env' | 'header' | 'config'
  serverKey: string | null
}
export interface PluginSkillDto {
  name: string
  description: string
  kind: 'skill' | 'command'
  hasScripts: boolean
}
export interface PluginMcpServerDto {
  key: string
  id: string | null
  transport: 'stdio' | 'http' | 'sse'
  /** URL host, or the command line for stdio. */
  endpoint: string
  /** Full launch line of a stdio server (command + arguments), shown for consent. */
  launch: string | null
  auth: 'none' | 'oauth' | 'manual'
  status: PluginComponentStatus
  enabled?: boolean
  consented?: boolean
  /** OAuth sign-in of a remote server on its host: absent when none is known to be needed. */
  oauth?: McpOAuthSummaryDto
}
export type PluginSourceErrorCode =
  | 'git-unavailable'
  | 'network'
  | 'not-found'
  | 'auth-required'
  | 'too-large'
  | 'invalid-repository'
  | 'timeout'
  | 'invalid-url'
  | 'no-marketplace'
export type PluginOpErrorCode =
  | PluginSourceErrorCode
  | 'busy'
  | 'invalid-input'
  | 'unknown-plugin'
  | 'unknown-marketplace'
  | 'already-installed'
  | 'name-conflict'
  | 'consent-required'
  | 'unavailable'
  | 'secure-storage-unavailable'
  | 'limit-exceeded'
  | 'path-unsafe'
  | 'install-failed'
  | 'managed-by-plugin'
export const PLUGIN_SOURCE_ERROR_CODES: readonly PluginSourceErrorCode[] = [
  'git-unavailable',
  'network',
  'not-found',
  'auth-required',
  'too-large',
  'invalid-repository',
  'timeout',
  'invalid-url',
  'no-marketplace',
]
export const PLUGIN_OP_ERROR_CODES: readonly PluginOpErrorCode[] = [
  ...PLUGIN_SOURCE_ERROR_CODES,
  'busy',
  'invalid-input',
  'unknown-plugin',
  'unknown-marketplace',
  'already-installed',
  'name-conflict',
  'consent-required',
  'unavailable',
  'secure-storage-unavailable',
  'limit-exceeded',
  'path-unsafe',
  'install-failed',
  'managed-by-plugin',
]
export type PluginOpResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: PluginOpErrorCode; detail?: string }
export interface PluginPolicyDto {
  installation: 'AVAILABLE' | 'NOT_AVAILABLE' | 'INSTALLED_BY_DEFAULT'
  authentication: 'ON_INSTALL' | 'ON_USE' | null
  products: string[]
}
export type PluginMarketplacePreset = 'openai-plugins' | 'openai-community-plugins'
export interface PluginMarketplaceDto {
  id: string
  url: string
  ref: string | null
  sparsePaths: string[]
  preset: PluginMarketplacePreset | null
  name: string | null
  displayName: string | null
  commit: string | null
  fetchedAt: number | null
  error: PluginSourceErrorCode | null
  pluginCount: number | null
}
export interface PluginCatalogEntryDto {
  marketplaceId: string
  name: string
  displayName: string
  description: string | null
  publisher: string | null
  category: string | null
  version: string | null
  format: PluginFormat | null
  /** null = an external source not inspected yet. */
  compatibility: PluginCompatibility | null
  installed: boolean
  updateAvailable: boolean
  hasLogo: boolean
  policy: PluginPolicyDto
}
export interface PluginInspectionDto extends PluginCatalogEntryDto {
  source: { url: string; path: string | null; commit: string }
  license: { spdx: string | null; text: string | null; truncated: boolean }
  homepage: string | null
  links: { privacy?: string; terms?: string; support?: string; repository?: string }
  capabilities: string[]
  skills: PluginSkillDto[]
  mcpServers: PluginMcpServerDto[]
  components: PluginComponentDto[]
  endpoints: string[]
  inputs: PluginInputDto[]
  executables: string[]
  executablesTruncated: boolean
  requirements: string[]
  consentFingerprint: string
  issues: { code: string; detail: string }[]
}
export interface InstalledPluginDto {
  key: string
  name: string
  displayName: string
  marketplaceId: string
  version: string | null
  commit: string
  enabled: boolean
  scope: PluginScope
  compatibility: PluginCompatibility
  updateAvailable: boolean
  setup: { missingInputs: string[]; stdioNeedingConsent: string[]; serversNeedingAuth: string[] }
  skills: PluginSkillDto[]
  mcpServers: PluginMcpServerDto[]
  inputs: PluginInputDto[]
  policy: PluginPolicyDto
  installedAt: number
  updatedAt: number
}
export interface PluginsStateDto {
  git: { available: boolean; version: string | null }
  secureStorage: boolean
  marketplaces: PluginMarketplaceDto[]
  installed: InstalledPluginDto[]
}
export interface PluginConsentInput {
  consentFingerprint: string
  stdio: string[]
  executables: boolean
}

/** Origin of a plugin-managed skill or MCP server, as the renderer sees it. */
export interface PluginOriginDto {
  key: string
  displayName: string
}
