import { z } from 'zod'

/**
 * Plugins of a bot environment: the same data the desktop's plugin center shows for this computer, bounded for the
 * gateway. Secret values never appear here, except the inputs of an install or of `setPluginInputs`, which only flow
 * from the owner's computer to the environment.
 */

const text = (max: number) => z.string().max(max)
const optionalText = (max: number) => text(max).nullable()
const list = <T extends z.ZodType>(item: T, max: number) => z.array(item).max(max)

export const fleetPluginKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
export const fleetPluginNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
export const fleetPluginMarketplaceIdSchema = z.string().regex(/^mkt_[0-9a-f]{16}$/)
/** A plugin's skill or command, namespaced by its plugin: `<plugin>:<skill>`, normalized as slash commands are. */
export const fleetPluginSkillNameSchema = z.string().regex(/^[a-z0-9_-]{1,64}:[a-z0-9_-]{1,64}$/)
/** A plugin's MCP server (`plg_…`) or an MCP server of the environment's own settings (`mcp_<uuid>`). */
export const fleetMcpServerIdSchema = z.string().regex(/^(mcp_[0-9a-f-]{36}|plg_[0-9a-f]{20})$/)
const commit = z.string().regex(/^[0-9a-f]{40}$/)
const sparsePath = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => !value.split('/').some((part) => part === '..' || part === '.'), 'Unsafe path')
  .refine((value) => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0'), 'Unsafe path')

const componentKind = z.enum([
  'skill',
  'command',
  'agent',
  'mcp-server',
  'app-connector',
  'hooks',
  'lsp',
  'monitor',
  'output-style',
  'theme',
  'workflow',
  'bin',
  'settings',
  'channel',
  'extension',
  'mcp-bundle',
  'symlink',
  'submodule',
])
const componentStatus = z.enum(['supported', 'adapted', 'not-run', 'unavailable', 'invalid'])
const reasonCode = z.enum([
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
])
const sourceError = z.enum([
  'git-unavailable',
  'network',
  'not-found',
  'auth-required',
  'too-large',
  'invalid-repository',
  'timeout',
  'invalid-url',
  'no-marketplace',
])
export const fleetPluginErrorSchema = z.enum([
  ...sourceError.options,
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
])

const reason = z
  .object({
    code: reasonCode,
    component: componentKind.optional(),
    subject: text(400).optional(),
    detail: text(2000).optional(),
  })
  .strict()
const compatibility = z.object({ level: z.enum(['portable', 'unavailable']), reasons: list(reason, 500) }).strict()
const component = z
  .object({
    kind: componentKind,
    name: text(400),
    status: componentStatus,
    reason: reasonCode.optional(),
    detail: text(2000).optional(),
  })
  .strict()
export const fleetPluginScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('projects'), workspaceIds: list(z.uuid(), 200) }).strict(),
])
const input = z
  .object({
    id: text(300),
    label: text(400),
    description: optionalText(2000),
    sensitive: z.boolean(),
    required: z.boolean(),
    set: z.boolean(),
    target: z.enum(['env', 'header', 'config']),
    serverKey: optionalText(64),
  })
  .strict()
const skill = z
  .object({ name: text(200), description: text(4096), kind: z.enum(['skill', 'command']), hasScripts: z.boolean() })
  .strict()
/** One signed-in account of a remote MCP server; never a token. */
export const fleetMcpOAuthAccountSchema = z
  .object({
    id: z.string().regex(/^acc_[0-9a-f]{12}$/),
    label: text(40),
    email: optionalText(320),
    scope: fleetPluginScopeSchema,
    status: z.enum(['connected', 'needs-auth']),
  })
  .strict()
/** Sign-in of a remote MCP server: its accounts and the own client's id, never a token or a secret. */
export const fleetMcpOAuthSummarySchema = z
  .object({
    needsAuth: z.boolean(),
    accounts: list(fleetMcpOAuthAccountSchema, 50),
    client: z
      .object({ clientId: text(4096) })
      .strict()
      .nullable(),
  })
  .strict()
const mcpServer = z
  .object({
    key: text(64),
    id: optionalText(64),
    transport: z.enum(['stdio', 'http', 'sse']),
    endpoint: text(8192),
    launch: optionalText(8192),
    auth: z.enum(['none', 'oauth', 'manual']),
    status: componentStatus,
    enabled: z.boolean().optional(),
    consented: z.boolean().optional(),
    oauth: fleetMcpOAuthSummarySchema.optional(),
  })
  .strict()
const policy = z
  .object({
    installation: z.enum(['AVAILABLE', 'NOT_AVAILABLE', 'INSTALLED_BY_DEFAULT']),
    authentication: z.enum(['ON_INSTALL', 'ON_USE']).nullable(),
    products: list(text(100), 50),
  })
  .strict()
export const fleetPluginMarketplaceSchema = z
  .object({
    id: fleetPluginMarketplaceIdSchema,
    url: text(2048),
    ref: optionalText(255),
    sparsePaths: list(text(400), 50),
    preset: z.enum(['openai-plugins', 'openai-community-plugins']).nullable(),
    name: optionalText(200),
    displayName: optionalText(200),
    commit: commit.nullable(),
    fetchedAt: z.number().int().nonnegative().nullable(),
    error: sourceError.nullable(),
    pluginCount: z.number().int().nonnegative().nullable(),
  })
  .strict()
const catalogEntryShape = {
  marketplaceId: fleetPluginMarketplaceIdSchema,
  name: text(64),
  displayName: text(200),
  description: optionalText(4096),
  publisher: optionalText(200),
  category: optionalText(100),
  version: optionalText(100),
  format: z.enum(['agent-plugins', 'codex', 'claude']).nullable(),
  compatibility: compatibility.nullable(),
  installed: z.boolean(),
  updateAvailable: z.boolean(),
  hasLogo: z.boolean(),
  policy,
}
export const fleetPluginCatalogEntrySchema = z.object(catalogEntryShape).strict()
export const fleetPluginInspectionSchema = z
  .object({
    ...catalogEntryShape,
    source: z.object({ url: text(2048), path: optionalText(400), commit }).strict(),
    license: z.object({ spdx: optionalText(200), text: optionalText(65536), truncated: z.boolean() }).strict(),
    homepage: optionalText(2048),
    links: z
      .object({
        privacy: text(2048).optional(),
        terms: text(2048).optional(),
        support: text(2048).optional(),
        repository: text(2048).optional(),
      })
      .strict(),
    capabilities: list(text(200), 100),
    skills: list(skill, 2000),
    mcpServers: list(mcpServer, 100),
    components: list(component, 2000),
    endpoints: list(text(2048), 500),
    inputs: list(input, 200),
    executables: list(text(400), 200),
    executablesTruncated: z.boolean(),
    requirements: list(text(400), 100),
    consentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    issues: list(z.object({ code: text(100), detail: text(2000) }).strict(), 500),
  })
  .strict()
export const fleetInstalledPluginSchema = z
  .object({
    key: fleetPluginKeySchema,
    name: text(64),
    displayName: text(200),
    marketplaceId: fleetPluginMarketplaceIdSchema,
    version: optionalText(100),
    commit,
    enabled: z.boolean(),
    scope: fleetPluginScopeSchema,
    compatibility,
    updateAvailable: z.boolean(),
    setup: z
      .object({
        missingInputs: list(text(300), 200),
        stdioNeedingConsent: list(text(64), 100),
        serversNeedingAuth: list(text(64), 100),
      })
      .strict(),
    skills: list(skill, 2000),
    mcpServers: list(mcpServer, 100),
    inputs: list(input, 200),
    policy,
    installedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
export const fleetPluginsStateSchema = z
  .object({
    git: z.object({ available: z.boolean(), version: optionalText(100) }).strict(),
    secureStorage: z.boolean(),
    marketplaces: list(fleetPluginMarketplaceSchema, 100),
    installed: list(fleetInstalledPluginSchema, 500),
  })
  .strict()

const failure = z
  .object({ ok: z.literal(false), error: fleetPluginErrorSchema, detail: text(2000).optional() })
  .strict()
/** A plugin operation's outcome, as the desktop's plugin center receives it from this computer's own engine. */
export function fleetPluginResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value }).strict(), failure])
}
/** The outcome of an operation that returns nothing on success. */
export const fleetPluginEmptyResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  failure,
])
export const fleetPluginLogoSchema = z
  .object({
    dataUrl: z
      .string()
      .max(360_000)
      .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
      .nullable(),
  })
  .strict()

export const fleetPluginConsentSchema = z
  .object({
    consentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    stdio: list(z.string().min(1).max(64), 100),
    executables: z.boolean(),
  })
  .strict()
const inputValues = z
  .record(z.string().min(1).max(300), z.string().max(16384))
  .refine((value) => Object.keys(value).length <= 100, 'Too many inputs')
const sourceInput = {
  url: z.string().min(1).max(2048),
  ref: z.string().min(1).max(255).nullable().optional(),
  sparsePaths: list(sparsePath, 50).optional(),
}
export const fleetPluginSourceInputSchema = z.object(sourceInput).strict()
export const fleetPluginInstallInputSchema = z
  .object({
    marketplaceId: fleetPluginMarketplaceIdSchema,
    name: fleetPluginNameSchema,
    consent: fleetPluginConsentSchema,
    scope: fleetPluginScopeSchema,
    inputs: inputValues.optional(),
  })
  .strict()
/**
 * Installs a plugin the owner's computer has, from its own source at its exact commit: the environment fetches and
 * checks it itself. The consent is the one given on the computer for that commit, so it matches only the same version.
 */
export const fleetPluginBringInputSchema = z
  .object({
    source: fleetPluginSourceInputSchema,
    name: fleetPluginNameSchema,
    commit,
    consent: fleetPluginConsentSchema,
    enabled: z.boolean(),
    inputs: inputValues.optional(),
  })
  .strict()
/** One change to an installed plugin; exactly one of the fields is set. */
export const fleetPluginPatchSchema = z
  .object({
    key: fleetPluginKeySchema,
    enabled: z.boolean().optional(),
    scope: fleetPluginScopeSchema.optional(),
    server: z
      .object({ serverKey: z.string().min(1).max(64), enabled: z.boolean(), consent: z.boolean().optional() })
      .strict()
      .optional(),
    inputs: z
      .record(z.string().min(1).max(300), z.string().max(16384).nullable())
      .refine((value) => Object.keys(value).length <= 100, 'Too many inputs')
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.enabled, value.scope, value.server, value.inputs].filter((field) => field !== undefined).length === 1,
    'Change one thing at a time'
  )

/** The skills and commands of the environment's plugins, as its Skills settings list them. */
export const fleetPluginSkillSchema = z
  .object({
    name: fleetPluginSkillNameSchema,
    description: text(4096),
    kind: z.enum(['skill', 'command']),
    plugin: z.object({ key: fleetPluginKeySchema, displayName: text(200) }).strict(),
    enabled: z.boolean(),
    modelInvocable: z.boolean(),
    userInvocable: z.boolean(),
    resources: z
      .object({
        scripts: z.number().int().nonnegative(),
        references: z.number().int().nonnegative(),
        assets: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
export const fleetPluginSkillsSchema = z.object({ skills: list(fleetPluginSkillSchema, 4000) }).strict()

/** Sign-in status of the environment's remote MCP servers, user and plugin servers alike. */
export const fleetMcpOAuthStatusesSchema = z
  .object({
    servers: list(z.object({ id: fleetMcpServerIdSchema, status: z.enum(['connected', 'needs-auth']) }).strict(), 600),
  })
  .strict()
/** Credential-free description of a server, for the owner's computer to run the sign-in. */
export const fleetMcpOAuthDescriptorSchema = z
  .object({
    serverId: fleetMcpServerIdSchema,
    name: text(200),
    url: text(8192),
    scopes: list(text(200), 50).optional(),
    resource: text(2048).optional(),
  })
  .strict()
const jsonObject = z.record(z.string(), z.unknown())
/** A finished sign-in, as the owner's computer hands it to the environment. Bounded by the gateway's body limit. */
export const fleetMcpOAuthBundleSchema = z
  .object({
    url: text(8192),
    redirectUri: z
      .string()
      .max(200)
      .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}\/callback$/),
    clientInformation: jsonObject.and(z.object({ client_id: z.string().min(1).max(4096) })),
    tokens: jsonObject.and(z.object({ access_token: z.string().min(1).max(65536), token_type: z.string().max(64) })),
    discoveryState: jsonObject.optional(),
    scopes: list(z.string().min(1).max(200), 50).optional(),
  })
  .strict()
export const fleetMcpOAuthStoreResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(['invalid-input', 'server-changed', 'storage']) }).strict(),
])
