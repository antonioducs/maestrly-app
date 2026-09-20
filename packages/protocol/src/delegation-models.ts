import { z } from 'zod'
import { opaqueIdSchema, utcDateTimeSchema } from './identity.js'

/**
 * Additive capability advertised by executors that can run delegation stages. A server without it keeps
 * serving column automation and interactive chat; an executor without it never receives a stage claim.
 */
export const DELEGATION_STAGE_CAPABILITY = 'delegation:stages:v1' as const

export const delegationExecutionModeSchema = z.enum(['standard', 'maestro'])

/**
 * One exact account/model combination available on a specific executor. `selectionId` is opaque: only the
 * executor maps it back to a provider account and model id, so the server and the connector never invent
 * or translate a model name.
 */
export const delegationModelEntrySchema = z
  .object({
    selectionId: z.string().min(1).max(191),
    modelLabel: z.string().min(1).max(200),
    accountLabel: z.string().min(1).max(200),
    /** Reasoning efforts the account actually offers; an empty list means the provider default only. */
    efforts: z.array(z.string().min(1).max(80)).max(20).default([]),
    fastMode: z.boolean().default(false),
    executionModes: z.array(delegationExecutionModeSchema).min(1).max(2).default(['standard']),
    /** Subagent profiles this selection may delegate to; frozen with the stage. */
    delegationProfiles: z.array(z.string().min(1).max(120)).max(50).default([]),
    /** Harness identity, when the executor resolves one, so a silent prompt/profile change is visible. */
    harnessProfileId: z.string().min(1).max(191).nullable().default(null),
    harnessHash: z.string().min(1).max(191).nullable().default(null),
  })
  .strict()

export const delegationCheckDescriptorSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    required: z.boolean().default(false),
    /** A check that writes to disk runs in a disposable copy of the reviewed revision. */
    mutatesWorkspace: z.boolean().default(false),
  })
  .strict()

export const delegationFeatureSchema = z
  .object({
    checks: z.array(delegationCheckDescriptorSchema).max(100).default([]),
    github: z
      .object({
        available: z.boolean(),
        login: z.string().max(191).nullable().default(null),
        issue: z.string().max(500).nullable().default(null),
      })
      .strict(),
    preview: z.object({ available: z.boolean(), issue: z.string().max(500).nullable().default(null) }).strict(),
    maestro: z.boolean(),
    subagents: z.boolean(),
    /** Read-only browser inspection and, separately, authorized interaction. */
    browserInspect: z.boolean(),
    browserInteract: z.boolean(),
  })
  .strict()

export const delegationWorkspaceSchema = z
  .object({
    projectId: opaqueIdSchema,
    key: z.string().min(1).max(191),
    label: z.string().max(160),
    branches: z.array(z.string().max(240)).max(500),
    repositoryBindingId: opaqueIdSchema.nullable().default(null),
  })
  .strict()

export const delegationModelCatalogSchema = z
  .object({
    capability: z.literal(DELEGATION_STAGE_CAPABILITY),
    enabled: z.boolean(),
    /** Deterministic digest of models plus features; a stage snapshot records it and the claim revalidates. */
    revision: z.string().min(1).max(64),
    generatedAt: utcDateTimeSchema,
    workspaces: z.array(delegationWorkspaceSchema).max(100).default([]),
    models: z.array(delegationModelEntrySchema).max(1000).default([]),
    features: delegationFeatureSchema,
    issues: z.array(z.string().max(500)).max(20).default([]),
  })
  .strict()

export const delegationExecutorSchema = z
  .object({
    executorId: opaqueIdSchema,
    name: z.string().min(1).max(160),
    online: z.boolean(),
    personal: z.boolean(),
    catalog: delegationModelCatalogSchema,
  })
  .strict()

/** Effective agent configuration for one stage. Every field is explicit once resolved. */
export const agentStageSettingsSchema = z
  .object({
    selectionId: z.string().min(1).max(191),
    reasoning: z.string().min(1).max(80).nullable(),
    fastMode: z.boolean(),
    executionMode: delegationExecutionModeSchema,
    delegationProfiles: z.array(z.string().min(1).max(120)).max(50),
  })
  .strict()

/**
 * Patch semantics are presence-based: an omitted field inherits, `reasoning: null` clears the effort and
 * `fastMode: false` turns Fast off. "Fast if available" is resolved against the catalog before queueing.
 */
export const agentStageSettingsPatchSchema = z
  .object({
    selectionId: z.string().min(1).max(191).optional(),
    reasoning: z.string().min(1).max(80).nullable().optional(),
    fastMode: z.union([z.boolean(), z.literal('if-available')]).optional(),
    executionMode: delegationExecutionModeSchema.optional(),
    delegationProfiles: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict()

export type DelegationExecutionMode = z.infer<typeof delegationExecutionModeSchema>
export type DelegationModelEntry = z.infer<typeof delegationModelEntrySchema>
export type DelegationCheckDescriptor = z.infer<typeof delegationCheckDescriptorSchema>
export type DelegationFeatures = z.infer<typeof delegationFeatureSchema>
export type DelegationWorkspace = z.infer<typeof delegationWorkspaceSchema>
export type DelegationModelCatalog = z.infer<typeof delegationModelCatalogSchema>
export type DelegationExecutor = z.infer<typeof delegationExecutorSchema>
export type AgentStageSettings = z.infer<typeof agentStageSettingsSchema>
export type AgentStageSettingsPatch = z.infer<typeof agentStageSettingsPatchSchema>

export type DelegationSettingsErrorCode =
  | 'SELECTION_UNAVAILABLE'
  | 'UNSUPPORTED_SETTING'
  | 'CATALOG_CHANGED'
  | 'AMBIGUOUS_SELECTION'

export class DelegationSettingsError extends Error {
  readonly code: DelegationSettingsErrorCode
  readonly statusCode = 409
  readonly details: Record<string, unknown>
  constructor(code: DelegationSettingsErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'DelegationSettingsError'
    this.code = code
    this.details = details
  }
}

/** Stable key ordering so the digest only changes when the advertised capability changes. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    )
  return value
}

/**
 * Change-detection digest, not a security digest: it tells the scheduler that an executor's advertised
 * models or features differ from the snapshot a stage was queued with.
 */
export function delegationCatalogRevision(input: {
  models: DelegationModelEntry[]
  features: DelegationFeatures
  workspaces?: DelegationWorkspace[]
}): string {
  const text = JSON.stringify(
    canonical({ models: input.models, features: input.features, workspaces: input.workspaces ?? [] })
  )
  // 128-bit FNV-1a over four offset basis values; pure TypeScript keeps the protocol bundler-safe.
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]
  return seeds
    .map((seed) => {
      let hash = seed >>> 0
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index) & 0xff
        hash = Math.imul(hash, 0x01000193) >>> 0
        hash ^= text.charCodeAt(index) >>> 8
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16).padStart(8, '0')
    })
    .join('')
}

export interface ResolvedStageSettings {
  settings: AgentStageSettings
  selection: DelegationModelEntry
  catalogRevision: string
}

/**
 * Resolve a requested patch against the executor's live catalog. Nothing is approximated: an effort that
 * the new model does not offer is refused instead of being mapped to a nearby tier, and Fast is only
 * enabled when the selection supports it.
 */
export function resolveStageSettings(
  catalog: DelegationModelCatalog,
  requested: AgentStageSettingsPatch,
  base?: AgentStageSettings
): ResolvedStageSettings {
  const selectionId = requested.selectionId ?? base?.selectionId
  if (!selectionId)
    throw new DelegationSettingsError('SELECTION_UNAVAILABLE', 'A selectionId from the executor catalog is required.')
  const selection = catalog.models.find((entry) => entry.selectionId === selectionId)
  if (!selection)
    throw new DelegationSettingsError(
      'SELECTION_UNAVAILABLE',
      'That account and model combination is no longer available on this executor.',
      { selectionId }
    )
  const changedModel = !!base && base.selectionId !== selection.selectionId

  let reasoning: string | null
  if (requested.reasoning !== undefined) reasoning = requested.reasoning
  else if (!base) reasoning = null
  else if (changedModel) {
    // Switching models never silently keeps an effort the new account does not offer.
    if (base.reasoning && !selection.efforts.includes(base.reasoning))
      throw new DelegationSettingsError(
        'UNSUPPORTED_SETTING',
        'The previous reasoning effort is unavailable for the new model. Choose a supported effort or clear it.',
        { field: 'reasoning', previous: base.reasoning, supported: selection.efforts }
      )
    reasoning = base.reasoning
  } else reasoning = base.reasoning
  if (reasoning !== null && !selection.efforts.includes(reasoning))
    throw new DelegationSettingsError(
      'UNSUPPORTED_SETTING',
      'The selected reasoning effort is unavailable for this model.',
      { field: 'reasoning', requested: reasoning, supported: selection.efforts }
    )

  let fastMode: boolean
  if (requested.fastMode === 'if-available') fastMode = selection.fastMode
  else if (requested.fastMode !== undefined) fastMode = requested.fastMode
  else if (!base) fastMode = false
  else fastMode = changedModel ? base.fastMode && selection.fastMode : base.fastMode
  if (fastMode && !selection.fastMode)
    throw new DelegationSettingsError('UNSUPPORTED_SETTING', 'Fast mode is unavailable for this model.', {
      field: 'fastMode',
    })

  const executionMode = requested.executionMode ?? base?.executionMode ?? selection.executionModes[0]!
  if (!selection.executionModes.includes(executionMode))
    throw new DelegationSettingsError('UNSUPPORTED_SETTING', 'The selected execution mode is unavailable.', {
      field: 'executionMode',
      supported: selection.executionModes,
    })
  if (executionMode === 'maestro' && !catalog.features.maestro)
    throw new DelegationSettingsError('UNSUPPORTED_SETTING', 'This executor does not offer Maestro mode.', {
      field: 'executionMode',
    })

  const delegationProfiles = requested.delegationProfiles ?? base?.delegationProfiles ?? []
  const unknown = delegationProfiles.filter((profile) => !selection.delegationProfiles.includes(profile))
  if (unknown.length)
    throw new DelegationSettingsError('UNSUPPORTED_SETTING', 'Unknown subagent profile for this selection.', {
      field: 'delegationProfiles',
      unknown,
    })
  if (delegationProfiles.length && !catalog.features.subagents)
    throw new DelegationSettingsError('UNSUPPORTED_SETTING', 'This executor does not offer internal delegation.', {
      field: 'delegationProfiles',
    })

  return {
    settings: agentStageSettingsSchema.parse({
      selectionId: selection.selectionId,
      reasoning,
      fastMode,
      executionMode,
      delegationProfiles,
    }),
    selection,
    catalogRevision: catalog.revision,
  }
}

/** Revalidate a queued snapshot against the catalog the executor advertises now. */
export function assertStageSettingsStillValid(
  catalog: DelegationModelCatalog,
  settings: AgentStageSettings,
  snapshotRevision: string
): DelegationModelEntry {
  const selection = catalog.models.find((entry) => entry.selectionId === settings.selectionId)
  if (!selection)
    throw new DelegationSettingsError(
      'SELECTION_UNAVAILABLE',
      'The account or model chosen for this stage is no longer available.',
      { selectionId: settings.selectionId, catalogRevision: catalog.revision, snapshotRevision }
    )
  if (settings.reasoning !== null && !selection.efforts.includes(settings.reasoning))
    throw new DelegationSettingsError('CATALOG_CHANGED', 'The reasoning effort chosen for this stage disappeared.', {
      field: 'reasoning',
      snapshotRevision,
      catalogRevision: catalog.revision,
    })
  if (settings.fastMode && !selection.fastMode)
    throw new DelegationSettingsError('CATALOG_CHANGED', 'Fast mode chosen for this stage disappeared.', {
      field: 'fastMode',
      snapshotRevision,
      catalogRevision: catalog.revision,
    })
  if (!selection.executionModes.includes(settings.executionMode))
    throw new DelegationSettingsError('CATALOG_CHANGED', 'The execution mode chosen for this stage disappeared.', {
      field: 'executionMode',
      snapshotRevision,
      catalogRevision: catalog.revision,
    })
  return selection
}

export interface SelectionCandidate {
  selectionId: string
  label: string
}

/**
 * Resolve a human alias ("opus", "astra") against the catalog. A single match may be used directly;
 * several matches return candidates for an explicit choice. An empty catalog never invents a model.
 */
export function matchSelectionAlias(
  catalog: DelegationModelCatalog,
  alias: string,
  savedAliases: Record<string, string> = {}
): { selectionId: string } | { candidates: SelectionCandidate[] } {
  const wanted = alias.trim().toLocaleLowerCase()
  if (!wanted) return { candidates: [] }
  const saved = savedAliases[wanted]
  if (saved && catalog.models.some((entry) => entry.selectionId === saved)) return { selectionId: saved }
  const exact = catalog.models.filter((entry) => entry.selectionId === alias)
  if (exact.length === 1) return { selectionId: exact[0]!.selectionId }
  const describe = (entry: DelegationModelEntry) => `${entry.accountLabel} · ${entry.modelLabel}`
  const matches = catalog.models.filter(
    (entry) =>
      entry.modelLabel.toLocaleLowerCase().includes(wanted) || describe(entry).toLocaleLowerCase().includes(wanted)
  )
  if (matches.length === 1) return { selectionId: matches[0]!.selectionId }
  return {
    candidates: matches.map((entry) => ({ selectionId: entry.selectionId, label: describe(entry) })),
  }
}
