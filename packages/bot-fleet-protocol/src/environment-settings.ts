import { z } from 'zod'
import {
  fleetInstalledPluginSchema,
  fleetMcpOAuthAccountIdSchema,
  fleetMcpOAuthAccountLabelSchema,
  fleetMcpOAuthBundleSchema,
  fleetMcpOAuthClientResultSchema,
  fleetMcpOAuthClientSchema,
  fleetMcpOAuthDescriptorSchema,
  fleetMcpOAuthPatchResultSchema,
  fleetMcpOAuthStatusesSchema,
  fleetMcpOAuthStoreResultSchema,
  fleetMcpOAuthTargetSchema,
  fleetMcpServerIdSchema,
  fleetPluginBringInputSchema,
  fleetPluginCatalogEntrySchema,
  fleetPluginConsentSchema,
  fleetPluginEmptyResultSchema,
  fleetPluginInspectionSchema,
  fleetPluginInstallInputSchema,
  fleetPluginKeySchema,
  fleetPluginLogoSchema,
  fleetPluginMarketplaceIdSchema,
  fleetPluginMarketplaceSchema,
  fleetPluginNameSchema,
  fleetPluginPatchSchema,
  fleetPluginResultSchema,
  fleetPluginSkillNameSchema,
  fleetPluginSkillsSchema,
  fleetPluginSourceInputSchema,
  fleetPluginsStateSchema,
} from './plugins.js'

/** Independent of a bot: even empty environments expose these owner-only settings. */
export { FLEET_ENVIRONMENT_SETTINGS_FEATURE } from './constants.js'
export const fleetSettingsRevisionSchema = z.uuid()
const id = z.string().min(1).max(200)
const name = z.string().trim().min(1).max(100)
const skillName = z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,99}$/)
/**
 * A member of a skill group: a skill of the environment, or a plugin's skill. Only a computer and an environment that
 * both support `environment-plugins-v1` ever send a plugin's skill.
 */
const groupMember = z.union([skillName, fleetPluginSkillNameSchema])
const revision = fleetSettingsRevisionSchema
const expected = { expectedRevision: revision }
const empty = z.object({}).strict()
const removed = z.object({ removed: z.boolean() }).strict()
const usage = z.array(z.object({ id, name }).strict()).max(1000)
const kind = z.enum(['codex', 'claude', 'grok', 'antigravity', 'github-copilot', 'cursor'])
const slot = z
  .string()
  .regex(/^acc_[A-Za-z0-9-]{1,80}$/)
  .nullable()
const keyNames = z.array(z.string().min(1).max(200)).max(100)
const values = z.record(z.string().min(1).max(200), z.string().max(16384)).refine((v) => Object.keys(v).length <= 100)
const secretChanges = z.object({ set: values.optional(), remove: keyNames.optional() }).strict()

export const fleetSettingsAccountsSchema = z
  .object({
    revision,
    apiKeys: z
      .array(
        z
          .object({
            providerId: id,
            name,
            kind: id,
            baseURL: z.string().max(2048).nullable(),
            keyHint: z.string().max(8).nullable(),
            bots: usage,
          })
          .strict()
      )
      .max(500),
    subscriptions: z
      .array(
        z
          .object({
            kind,
            accountId: slot,
            label: name,
            email: z.string().max(320).nullable(),
            plan: z.string().max(200).nullable(),
            state: z.enum(['connected', 'signed-out', 'signing-in']),
            bots: usage,
          })
          .strict()
      )
      .max(500),
  })
  .strict()
export const fleetSettingsModelsSchema = z
  .object({
    providers: z
      .array(
        z
          .object({
            providerId: id,
            name,
            revision,
            models: z
              .array(
                z
                  .object({
                    id,
                    name: z.string().min(1).max(200),
                    contextWindow: z.number().int().nonnegative().nullable(),
                    bots: usage,
                  })
                  .strict()
              )
              .max(10000),
            hiddenModelIds: z.array(id).max(10000),
          })
          .strict()
      )
      .max(500),
  })
  .strict()
export const fleetSettingsSkillSchema = z
  .object({
    name,
    description: z.string().max(4096),
    enabled: z.boolean(),
    source: z.enum(['fleet', 'registry', 'local']),
    revision,
    editable: z.boolean(),
    resources: z
      .object({
        scripts: z.number().int().nonnegative(),
        references: z.number().int().nonnegative(),
        assets: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    modelInvocable: z.boolean().optional(),
    userInvocable: z.boolean().optional(),
    editableReason: z.enum(['managed', 'read-only', 'not-found']).nullable(),
  })
  .strict()
export const fleetSettingsSkillDocumentSchema = fleetSettingsSkillSchema.extend({
  markdown: z.string().max(262144),
  files: z.array(z.string().max(240)).max(400).optional(),
})
export const fleetSettingsSkillsSchema = z.object({ skills: z.array(fleetSettingsSkillSchema).max(2000) }).strict()
export const fleetSettingsSkillGroupSchema = z
  .object({
    id,
    name,
    description: z.string().max(1000).optional(),
    // A stored member is listed as it is; a plugin's skill name may be longer than a group name.
    skills: z.array(z.union([name, fleetPluginSkillNameSchema])).max(2000),
  })
  .strict()
export const fleetSettingsSkillGroupsSchema = z
  .object({ revision, groups: z.array(fleetSettingsSkillGroupSchema).max(200) })
  .strict()
export const fleetSettingsSkillSearchSchema = z
  .object({
    results: z
      .array(z.object({ id, name, description: z.string().max(4096), source: z.string().max(500) }).strict())
      .max(100),
  })
  .strict()
/** Never expose transport values: command, args and URL can all contain credentials. */
export const fleetSettingsMcpServerSchema = z
  .object({
    id,
    name,
    revision,
    transport: z.enum(['http', 'stdio']),
    enabled: z.boolean(),
    hasCommand: z.boolean(),
    hasArgs: z.boolean(),
    hasUrl: z.boolean(),
    host: z.string().max(255).nullable().optional(),
    envKeys: keyNames,
    headerKeys: keyNames,
    unavailable: z.boolean(),
  })
  .strict()
export const fleetSettingsMcpServersSchema = z
  .object({ revision, servers: z.array(fleetSettingsMcpServerSchema).max(500) })
  .strict()
const transportReplacement = {
  command: z.string().min(1).max(4096).optional(),
  args: z.array(z.string().max(4096)).max(100).optional(),
  url: z
    .url()
    .max(8192)
    .refine((v) => /^https?:\/\//i.test(v))
    .optional(),
}
export const fleetSettingsMcpCreateSchema = z
  .object({
    name,
    transport: z.enum(['http', 'stdio']),
    enabled: z.boolean(),
    ...transportReplacement,
    env: values.optional(),
    headers: values.optional(),
  })
  .strict()
  .refine((v) => (v.transport === 'http' ? Boolean(v.url) : Boolean(v.command)), 'Transport configuration is required')
export const fleetSettingsMcpPatchSchema = z
  .object({
    id,
    ...expected,
    name: name.optional(),
    enabled: z.boolean().optional(),
    transport: z.enum(['http', 'stdio']).optional(),
    replace: z.object(transportReplacement).strict().optional(),
    env: secretChanges.optional(),
    headers: secretChanges.optional(),
  })
  .strict()
export const fleetSettingsMcpTestSchema = z
  .object({
    code: z.enum(['ok', 'unavailable', 'connection-failed', 'timeout', 'invalid-config']),
    toolCount: z.number().int().nonnegative().max(100000),
    /**
     * Why a failed connection failed, when the server said so (a stdio server's error output), with its environment
     * values masked. Sent only to a request that asks for it.
     */
    detail: z.string().min(1).max(1000).optional(),
  })
  .strict()
export const fleetSettingsRuntimeIdSchema = z.enum(['claude-code', 'codex', 'antigravity-acp'])
export const fleetSettingsRuntimeActionSchema = z.enum(['check', 'update', 'rollback', 'cancel', 'install'])
export const fleetSettingsRuntimeSchema = z
  .object({
    id: fleetSettingsRuntimeIdSchema,
    revision,
    currentVersion: z.string().max(100).nullable(),
    pendingVersion: z.string().max(100).nullable(),
    availableVersion: z.string().max(100).nullable().optional(),
    source: z.enum(['image', 'managed']).optional(),
    automatic: z.boolean(),
    allowedActions: z.array(fleetSettingsRuntimeActionSchema).max(5),
    state: z.enum(['idle', 'checking', 'installing', 'ready', 'error']),
    progress: z.number().min(0).max(100).nullable(),
    error: z.enum(['check-failed', 'install-failed', 'rollback-failed', 'unavailable']).nullable(),
    rollbackVersion: z.string().max(100).nullable(),
  })
  .strict()
export const fleetSettingsRuntimesSchema = z.object({ runtimes: z.array(fleetSettingsRuntimeSchema).max(3) }).strict()
/** `generatedInterfacesEnabled` is absent from environments that predate it; send it only to one that reported it. */
export const fleetSettingsPreferencesSchema = z
  .object({ revision, imageGenEnabled: z.boolean(), generatedInterfacesEnabled: z.boolean().optional() })
  .strict()
/** Subscription kinds whose accounts can take over from one another when one reaches its usage limit. */
export const FLEET_FAILOVER_KINDS = ['claude', 'codex'] as const
const failoverKind = z.enum(FLEET_FAILOVER_KINDS)
const fallbacks = z.array(slot).max(50)
/** A primary account (`slot`, null for the kind's default account) and the accounts tried after it, in order. */
export const fleetSettingsFailoverRouteSchema = z
  .object({ kind: failoverKind, slot, enabled: z.boolean(), fallbacks })
  .strict()
export const fleetSettingsFailoverSchema = z
  .object({ revision, routes: z.array(fleetSettingsFailoverRouteSchema).max(200) })
  .strict()

function operation<I extends z.ZodType, O extends z.ZodType>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  path: string,
  input: I,
  response: O
) {
  return { method, path, input, response }
}
/** Explicit allowlist; input objects include path identifiers. No IPC method forwarding is permitted. */
export const FLEET_SETTINGS_OPERATIONS = {
  accounts: operation('GET', '/accounts', empty, fleetSettingsAccountsSchema),
  patchAccount: operation(
    'PATCH',
    '/accounts/:providerId',
    z
      .object({
        providerId: id,
        ...expected,
        name: name.optional(),
        apiKey: z.string().min(1).max(16384).optional(),
        baseURL: z.url().max(2048).nullable().optional(),
      })
      .strict(),
    fleetSettingsAccountsSchema
  ),
  renameSubscription: operation(
    'PATCH',
    '/subscriptions/:kind/:slot',
    z.object({ kind, slot, ...expected, label: name }).strict(),
    fleetSettingsAccountsSchema
  ),
  removeAccount: operation(
    'DELETE',
    '/accounts/:providerId',
    z.object({ providerId: id, ...expected }).strict(),
    removed
  ),
  removeSubscription: operation(
    'DELETE',
    '/subscriptions/:kind/:slot',
    z.object({ kind, slot, ...expected }).strict(),
    removed
  ),
  models: operation('GET', '/models', empty, fleetSettingsModelsSchema),
  setModelFilter: operation(
    'PUT',
    '/models/:providerId/filter',
    z.object({ providerId: id, ...expected, hiddenModelIds: z.array(id).max(10000) }).strict(),
    fleetSettingsModelsSchema
  ),
  skills: operation('GET', '/skills', empty, fleetSettingsSkillsSchema),
  skill: operation('GET', '/skills/:name', z.object({ name: skillName }).strict(), fleetSettingsSkillDocumentSchema),
  createSkill: operation(
    'POST',
    '/skills',
    z.object({ name: skillName, markdown: z.string().max(262144) }).strict(),
    fleetSettingsSkillDocumentSchema
  ),
  writeSkill: operation(
    'PUT',
    '/skills/:name',
    z.object({ name: skillName, ...expected, markdown: z.string().max(262144) }).strict(),
    fleetSettingsSkillDocumentSchema
  ),
  setSkillEnabled: operation(
    'PATCH',
    '/skills/:name',
    z.object({ name: skillName, ...expected, enabled: z.boolean() }).strict(),
    fleetSettingsSkillSchema
  ),
  removeSkill: operation('DELETE', '/skills/:name', z.object({ name: skillName, ...expected }).strict(), removed),
  searchSkills: operation(
    'POST',
    '/skill-library/search',
    z.object({ query: z.string().trim().min(1).max(200) }).strict(),
    fleetSettingsSkillSearchSchema
  ),
  installSkill: operation(
    'POST',
    '/skill-library/install',
    z
      .object({
        source: z.string().min(1).max(500),
        id,
        overwrite: z.boolean().optional(),
        expectedRevision: revision.optional(),
      })
      .strict()
      .refine((value) => !value.overwrite || !!value.expectedRevision, 'Replacing a skill needs its current revision'),
    fleetSettingsSkillsSchema
  ),
  skillGroups: operation('GET', '/skill-groups', empty, fleetSettingsSkillGroupsSchema),
  createSkillGroup: operation(
    'POST',
    '/skill-groups',
    z
      .object({
        ...expected,
        name,
        description: z.string().max(1000).optional(),
        skills: z.array(groupMember).max(2000),
      })
      .strict(),
    fleetSettingsSkillGroupsSchema
  ),
  updateSkillGroup: operation(
    'PUT',
    '/skill-groups/:id',
    z
      .object({
        id,
        ...expected,
        name,
        description: z.string().max(1000).optional(),
        skills: z.array(groupMember).max(2000),
      })
      .strict(),
    fleetSettingsSkillGroupsSchema
  ),
  removeSkillGroup: operation(
    'DELETE',
    '/skill-groups/:id',
    z.object({ id, ...expected }).strict(),
    fleetSettingsSkillGroupsSchema
  ),
  mcpServers: operation('GET', '/mcp-servers', empty, fleetSettingsMcpServersSchema),
  mcpServer: operation('GET', '/mcp-servers/:id', z.object({ id }).strict(), fleetSettingsMcpServerSchema),
  createMcpServer: operation('POST', '/mcp-servers', fleetSettingsMcpCreateSchema, fleetSettingsMcpServerSchema),
  patchMcpServer: operation('PATCH', '/mcp-servers/:id', fleetSettingsMcpPatchSchema, fleetSettingsMcpServerSchema),
  removeMcpServer: operation('DELETE', '/mcp-servers/:id', z.object({ id, ...expected }).strict(), removed),
  testMcpServer: operation(
    'POST',
    '/mcp-servers/:id/test',
    // `detail` only with `FLEET_MCP_TEST_DETAIL_FEATURE`: an older gateway or environment refuses unknown fields.
    z.object({ id, detail: z.literal(true).optional() }).strict(),
    fleetSettingsMcpTestSchema
  ),
  runtimes: operation('GET', '/runtimes', empty, fleetSettingsRuntimesSchema),
  runtimeAction: operation(
    'POST',
    '/runtimes/:id/actions',
    z.object({ id: fleetSettingsRuntimeIdSchema, ...expected, action: fleetSettingsRuntimeActionSchema }).strict(),
    fleetSettingsRuntimeSchema
  ),
  setRuntimeAutomatic: operation(
    'PUT',
    '/runtimes/:id/automatic',
    z.object({ id: fleetSettingsRuntimeIdSchema, ...expected, automatic: z.boolean() }).strict(),
    fleetSettingsRuntimeSchema
  ),
  preferences: operation('GET', '/preferences', empty, fleetSettingsPreferencesSchema),
  setPreferences: operation(
    'PUT',
    '/preferences',
    z
      .object({ ...expected, imageGenEnabled: z.boolean(), generatedInterfacesEnabled: z.boolean().optional() })
      .strict(),
    fleetSettingsPreferencesSchema
  ),
  // Plugins and MCP sign-in: only for environments with `FLEET_ENVIRONMENT_PLUGINS_FEATURE`.
  plugins: operation('GET', '/plugins', empty, fleetPluginsStateSchema),
  pluginCatalog: operation(
    'GET',
    '/plugin-sources/:marketplaceId/plugins',
    z.object({ marketplaceId: fleetPluginMarketplaceIdSchema }).strict(),
    fleetPluginResultSchema(z.array(fleetPluginCatalogEntrySchema).max(2000))
  ),
  pluginInspect: operation(
    'GET',
    '/plugin-sources/:marketplaceId/plugins/:name',
    z.object({ marketplaceId: fleetPluginMarketplaceIdSchema, name: fleetPluginNameSchema }).strict(),
    fleetPluginResultSchema(fleetPluginInspectionSchema)
  ),
  pluginLogo: operation(
    'GET',
    '/plugin-sources/:marketplaceId/plugins/:name/logo',
    z.object({ marketplaceId: fleetPluginMarketplaceIdSchema, name: fleetPluginNameSchema }).strict(),
    fleetPluginLogoSchema
  ),
  addPluginSource: operation(
    'POST',
    '/plugin-sources',
    fleetPluginSourceInputSchema,
    fleetPluginResultSchema(fleetPluginMarketplaceSchema)
  ),
  refreshPluginSource: operation(
    'POST',
    '/plugin-sources/:marketplaceId/refresh',
    z.object({ marketplaceId: fleetPluginMarketplaceIdSchema }).strict(),
    fleetPluginResultSchema(fleetPluginMarketplaceSchema)
  ),
  removePluginSource: operation(
    'DELETE',
    '/plugin-sources/:marketplaceId',
    z.object({ marketplaceId: fleetPluginMarketplaceIdSchema, uninstall: z.boolean() }).strict(),
    fleetPluginEmptyResultSchema
  ),
  installPlugin: operation(
    'POST',
    '/plugins',
    fleetPluginInstallInputSchema,
    fleetPluginResultSchema(fleetInstalledPluginSchema)
  ),
  bringPlugin: operation(
    'POST',
    '/plugins/bring',
    fleetPluginBringInputSchema,
    fleetPluginResultSchema(fleetInstalledPluginSchema)
  ),
  updatePlugin: operation(
    'POST',
    '/plugins/:key/update',
    z
      .object({
        key: fleetPluginKeySchema,
        consent: fleetPluginConsentSchema.optional(),
      })
      .strict(),
    fleetPluginResultSchema(fleetInstalledPluginSchema)
  ),
  patchPlugin: operation('PATCH', '/plugins/:key', fleetPluginPatchSchema, fleetPluginEmptyResultSchema),
  uninstallPlugin: operation(
    'DELETE',
    '/plugins/:key',
    z.object({ key: fleetPluginKeySchema, deleteData: z.boolean() }).strict(),
    fleetPluginEmptyResultSchema
  ),
  pluginSkills: operation('GET', '/plugin-skills', empty, fleetPluginSkillsSchema),
  setPluginSkillEnabled: operation(
    'PATCH',
    '/plugin-skills/:name',
    z.object({ name: fleetPluginSkillNameSchema, enabled: z.boolean() }).strict(),
    fleetPluginEmptyResultSchema
  ),
  mcpOAuthStatuses: operation('GET', '/mcp-oauth', empty, fleetMcpOAuthStatusesSchema),
  mcpOAuthDescriptor: operation(
    'POST',
    '/mcp-oauth/:id/descriptor',
    z.object({ id: fleetMcpServerIdSchema, accountId: fleetMcpOAuthAccountIdSchema.optional() }).strict(),
    z.object({ descriptor: fleetMcpOAuthDescriptorSchema.nullable() }).strict()
  ),
  setMcpOAuth: operation(
    'PUT',
    '/mcp-oauth/:id',
    z
      .object({ id: fleetMcpServerIdSchema, bundle: fleetMcpOAuthBundleSchema, target: fleetMcpOAuthTargetSchema })
      .strict(),
    fleetMcpOAuthStoreResultSchema
  ),
  removeMcpOAuth: operation(
    'DELETE',
    '/mcp-oauth/:id',
    z.object({ id: fleetMcpServerIdSchema, accountId: fleetMcpOAuthAccountIdSchema.optional() }).strict(),
    removed
  ),
  patchMcpOAuthAccount: operation(
    'PATCH',
    '/mcp-oauth/:id/accounts/:accountId',
    z
      .object({
        id: fleetMcpServerIdSchema,
        accountId: fleetMcpOAuthAccountIdSchema,
        label: fleetMcpOAuthAccountLabelSchema,
      })
      .strict(),
    fleetMcpOAuthPatchResultSchema
  ),
  setMcpOAuthClient: operation(
    'PUT',
    '/mcp-oauth/:id/client',
    z.object({ id: fleetMcpServerIdSchema, client: fleetMcpOAuthClientSchema.nullable() }).strict(),
    fleetMcpOAuthClientResultSchema
  ),
  /** Needs `FLEET_ACCOUNT_FAILOVER_FEATURE` from both the gateway and the environment. */
  failover: operation('GET', '/failover', empty, fleetSettingsFailoverSchema),
  setFailoverRoute: operation(
    'PUT',
    '/failover/:kind/:slot',
    z
      .object({ kind: failoverKind, slot, ...expected, enabled: z.boolean(), fallbacks })
      .strict()
      .refine(
        (value) => !value.fallbacks.includes(value.slot) && new Set(value.fallbacks).size === value.fallbacks.length,
        'Each account appears once in a route'
      ),
    fleetSettingsFailoverSchema
  ),
} as const
export type FleetSettingsOperation = keyof typeof FLEET_SETTINGS_OPERATIONS
/** Operations an environment serves only with `FLEET_ENVIRONMENT_PLUGINS_FEATURE`. */
export const FLEET_PLUGIN_SETTINGS_OPERATIONS = [
  'plugins',
  'pluginCatalog',
  'pluginInspect',
  'pluginLogo',
  'addPluginSource',
  'refreshPluginSource',
  'removePluginSource',
  'installPlugin',
  'bringPlugin',
  'updatePlugin',
  'patchPlugin',
  'uninstallPlugin',
  'pluginSkills',
  'setPluginSkillEnabled',
  'mcpOAuthStatuses',
  'mcpOAuthDescriptor',
  'setMcpOAuth',
  'removeMcpOAuth',
  'patchMcpOAuthAccount',
  'setMcpOAuthClient',
] as const satisfies readonly FleetSettingsOperation[]
export type FleetPluginSettingsOperation = (typeof FLEET_PLUGIN_SETTINGS_OPERATIONS)[number]
export const isFleetPluginSettingsOperation = (value: string): value is FleetPluginSettingsOperation =>
  (FLEET_PLUGIN_SETTINGS_OPERATIONS as readonly string[]).includes(value)
/** The route key of a settings operation, e.g. `settingsInstallPlugin`. */
export const fleetSettingsRouteKey = <K extends FleetSettingsOperation>(operation: K): `settings${Capitalize<K>}` =>
  `settings${operation[0].toUpperCase()}${operation.slice(1)}` as `settings${Capitalize<K>}`
/** Plugin operations that reach Git: they fetch, check out and copy, each step bounded by the engine's Git timeout. */
const PLUGIN_GIT_OPERATIONS: ReadonlySet<FleetPluginSettingsOperation> = new Set([
  'pluginCatalog',
  'pluginInspect',
  'addPluginSource',
  'refreshPluginSource',
  'removePluginSource',
  'installPlugin',
  'bringPlugin',
  'updatePlugin',
])
/** How long the gateway waits for the environment; a computer waits a little longer for the gateway. */
export const fleetPluginSettingsTimeoutMs = (operation: FleetPluginSettingsOperation): number =>
  PLUGIN_GIT_OPERATIONS.has(operation) ? 300_000 : 30_000
export type FleetSettingsInput<K extends FleetSettingsOperation> = z.infer<
  (typeof FLEET_SETTINGS_OPERATIONS)[K]['input']
>
export type FleetSettingsOutput<K extends FleetSettingsOperation> = z.infer<
  (typeof FLEET_SETTINGS_OPERATIONS)[K]['response']
>
/** All methods accept one validated object; reads with no parameters accept {}. */
export type FleetEnvironmentSettingsService = {
  [K in FleetSettingsOperation]: (input: FleetSettingsInput<K>) => Promise<FleetSettingsOutput<K>>
}
/**
 * Operations only the owner's computer's main process calls: their inputs carry a plugin's saved values or OAuth tokens,
 * and the sign-in descriptor carries the own OAuth client's secret; none of them passes through a renderer.
 */
export type FleetSettingsMainOnlyOperation = 'bringPlugin' | 'setMcpOAuth' | 'mcpOAuthDescriptor'
export type FleetSettingsRendererOperation = Exclude<FleetSettingsOperation, FleetSettingsMainOnlyOperation>
/** What a renderer reaches of one environment's settings. */
export type FleetEnvironmentSettingsClient = Pick<FleetEnvironmentSettingsService, FleetSettingsRendererOperation>
/** Every renderer call explicitly identifies its target environment. */
export type FleetEnvironmentSettingsApi = {
  [K in FleetSettingsRendererOperation]: (
    environmentId: string,
    input: FleetSettingsInput<K>
  ) => Promise<FleetSettingsOutput<K>>
}
