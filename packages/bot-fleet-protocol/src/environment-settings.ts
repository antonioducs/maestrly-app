import { z } from 'zod'

/** Independent of a bot: even empty environments expose these owner-only settings. */
export { FLEET_ENVIRONMENT_SETTINGS_FEATURE } from './constants.js'
export const fleetSettingsRevisionSchema = z.uuid()
const id = z.string().min(1).max(200)
const name = z.string().trim().min(1).max(100)
const skillName = z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,99}$/)
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
  .object({ id, name, description: z.string().max(1000).optional(), skills: z.array(name).max(2000) })
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
export const fleetSettingsPreferencesSchema = z.object({ revision, imageGenEnabled: z.boolean() }).strict()

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
      .object({ ...expected, name, description: z.string().max(1000).optional(), skills: z.array(skillName).max(2000) })
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
        skills: z.array(skillName).max(2000),
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
  testMcpServer: operation('POST', '/mcp-servers/:id/test', z.object({ id }).strict(), fleetSettingsMcpTestSchema),
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
    z.object({ ...expected, imageGenEnabled: z.boolean() }).strict(),
    fleetSettingsPreferencesSchema
  ),
} as const
export type FleetSettingsOperation = keyof typeof FLEET_SETTINGS_OPERATIONS
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
/** Every renderer call explicitly identifies its target environment. */
export type FleetEnvironmentSettingsApi = {
  [K in FleetSettingsOperation]: (
    environmentId: string,
    input: FleetSettingsInput<K>
  ) => Promise<FleetSettingsOutput<K>>
}
