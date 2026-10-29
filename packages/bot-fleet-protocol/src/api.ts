import { FLEET_SETTINGS_OPERATIONS } from './environment-settings.js'
import {
  fleetDictationKeyRequestSchema,
  fleetDictationKeyResponseSchema,
  fleetDictationStatusSchema,
  fleetDictationTranscribeRequestSchema,
  fleetDictationTranscribeResponseSchema,
} from './dictation.js'
import { fleetBridgeOrigin } from './helpers.js'
import {
  fleetChatAttentionKindSchema,
  fleetPushRegistrationRequestSchema,
  fleetPushRegistrationSchema,
} from './push.js'
import {
  fleetHostFileArchiveBeginSchema,
  fleetHostFileArchiveRequestSchema,
  fleetHostFileArchiveSchema,
  fleetHostFileDigestRequestSchema,
  fleetHostFileDigestSchema,
  fleetHostFileStatRequestSchema,
  fleetHostFileStatSchema,
  fleetHostFileUploadBeginSchema,
  fleetHostFileUploadCommitSchema,
  fleetHostFileUploadResultSchema,
  fleetHostFileUploadSchema,
} from './host-files.js'
import { z } from 'zod'
import {
  FLEET_BOT_SIDE_TURNS_MAX,
  FLEET_PEER_THREAD_LIMITS,
  FLEET_ENVIRONMENT_LIMITS,
  FLEET_PROVISIONING_LIMITS,
  FLEET_OWNER_MEMORY_LIMITS,
  FLEET_ROUTINE_RUN_LIMITS,
  FLEET_IMAGE_LIMITS,
  FLEET_FILE_LIMITS,
  FLEET_MESSAGE_TEXT_MAX,
  FLEET_PROTOCOL_VERSION,
  FLEET_QUEUE_PREVIEW_MAX,
  FLEET_ROUTINE_PROMPT_MAX,
  FLEET_ROUTINE_TITLE_MAX,
  FLEET_RUNNER_LIMITS,
} from './constants.js'
import {
  fleetOwnerMemoryOriginSchema,
  fleetOwnerMemorySchema,
  fleetOwnerMemoryEntrySchema,
  fleetRoutineRunSchema,
  fleetRoutineRunReportSchema,
  fleetRoutinePreviousRunSchema,
  fleetRoutineRunCitationSchema,
  fleetRoutineRunKeptSchema,
  fleetPeerThreadSchema,
  fleetPeerThreadSettingsSchema,
  fleetBotDelegationSchema,
  fleetRoutineRunMediaSchema,
  fleetRoutineRunSettingsSchema,
  fleetBotMemorySchema,
  fleetActivityEntrySchema,
  fleetArchivedBotSchema,
  fleetArchivedEnvironmentSchema,
  fleetBotIdSchema,
  fleetBotMoveSchema,
  fleetBotSchema,
  fleetBotStatusSchema,
  fleetCeilingSchema,
  fleetEnvironmentIdSchema,
  fleetEnvironmentKindSchema,
  fleetEnvironmentSchema,
  fleetCpuLimitSchema,
  fleetHostFolderModeSchema,
  fleetIdleStopMinutesSchema,
  fleetTintSchema,
  fleetRuntimesSchema,
  fleetHostInfoSchema,
  fleetIdSchema,
  fleetIdempotencyKeySchema,
  fleetInboxItemSchema,
  fleetInstructionsSchema,
  fleetInteractionResolutionSchema,
  fleetNameSchema,
  fleetNonNegativeIntSchema,
  fleetNoteSchema,
  fleetPeerMessageSchema,
  fleetPeerTextSchema,
  fleetRoleSchema,
  fleetRoutineScheduleSchema,
  fleetRoutineSchema,
  fleetScreenSurfaceSchema,
  fleetSelectionOptionSchema,
  fleetSelectionSchema,
  fleetTakeoverStateSchema,
  fleetTimestampSchema,
  fleetTranscriptItemSchema,
  fleetTranscriptPageSchema,
  fleetActivitySchema,
  fleetPendingInteractionSchema,
  fleetImageMediaTypeSchema,
  fleetFileIdSchema,
  fleetFileRefSchema,
  fleetFileNameSchema,
  fleetFileSettingsSchema,
  fleetFilesUsageSchema,
  fleetPublishedFileSchema,
  fleetRemovedFileSchema,
  fleetUsageSchema,
  fleetCompactionConfigSchema,
  fleetCompactionStateSchema,
  fleetDesktopIdSchema,
  fleetDesktopInputSchema,
  fleetDesktopLinkSchema,
  fleetDesktopLinkViewSchema,
  fleetDesktopNameSchema,
  fleetDesktopOpSchema,
  fleetDesktopCallSchema,
  fleetRunnerCapabilitiesSchema,
  fleetRunnerErrorSchema,
  fleetRunnerIdSchema,
  fleetRunnerJobIdSchema,
  fleetRunnerJobSchema,
  fleetRunnerJobSpecSchema,
  fleetRunnerJobUsageSchema,
  fleetRunnerLinkSchema,
  fleetRunnerLinkViewSchema,
  fleetRunnerNameSchema,
  fleetRunnerRequirementsSchema,
} from './domain.js'

export const fleetOwnerMemoryCreateRequestSchema = z.object({
  content: z.string().min(1).max(FLEET_OWNER_MEMORY_LIMITS.entryMax),
  replacesId: fleetIdSchema.optional(),
  /** The owner's entries are global (null) unless the owner scopes them to an environment. */
  environmentId: fleetEnvironmentIdSchema.nullable().default(null),
  idempotencyKey: fleetIdempotencyKeySchema,
})
export type FleetOwnerMemoryCreateRequest = z.infer<typeof fleetOwnerMemoryCreateRequestSchema>
export const fleetOwnerMemoryPatchRequestSchema = z
  .object({
    content: z.string().min(1).max(FLEET_OWNER_MEMORY_LIMITS.entryMax).optional(),
    status: z.enum(['active', 'archived']).optional(),
    /** Null makes the entry global; an id scopes it to that environment. */
    environmentId: fleetEnvironmentIdSchema.nullable().optional(),
  })
  .refine(
    (value) => value.content !== undefined || value.status !== undefined || value.environmentId !== undefined,
    'nothing to change'
  )
export type FleetOwnerMemoryPatchRequest = z.infer<typeof fleetOwnerMemoryPatchRequestSchema>
/** A bot's entries belong to its environment, which the gateway derives from the bot's token, never from the body. */
export const fleetInternalOwnerMemorySaveRequestSchema = fleetOwnerMemoryCreateRequestSchema
  .omit({ environmentId: true })
  .extend({ origin: fleetOwnerMemoryOriginSchema })
export type FleetInternalOwnerMemorySaveRequest = z.infer<typeof fleetInternalOwnerMemorySaveRequestSchema>
export const fleetInternalOwnerMemoryForgetRequestSchema = z.object({
  reason: z.string().trim().min(1).max(FLEET_OWNER_MEMORY_LIMITS.reasonMax),
})
export const fleetRoutineRunsResponseSchema = z.object({ runs: z.array(fleetRoutineRunSchema) })
/**
 * A page of a bot's routine runs (`routine-conversations`), newest first: `before` names the oldest run of the page,
 * to read the runs before it, or is null when there are none.
 */
export const fleetRoutineRunPageSchema = z.object({
  runs: z.array(fleetRoutineRunSchema).max(FLEET_ROUTINE_RUN_LIMITS.pageMax),
  before: fleetIdSchema.nullable(),
})
export type FleetRoutineRunPage = z.infer<typeof fleetRoutineRunPageSchema>
/** The owner keeps a run (`pinned`), or opened it (`seen`, from gateways with `owner-seen`). */
export const fleetRoutineRunPatchRequestSchema = z
  .object({ pinned: z.boolean().optional(), seen: z.literal(true).optional() })
  .strict()
  .refine((value) => value.pinned !== undefined || value.seen !== undefined, 'nothing to change')
export type FleetRoutineRunPatchRequest = z.infer<typeof fleetRoutineRunPatchRequestSchema>
/** What a bot kept of a run whose conversation it deleted. */
export const fleetInstanceRunDeletedSchema = z.object({ kept: fleetRoutineRunKeptSchema })
export type FleetInstanceRunDeleted = z.infer<typeof fleetInstanceRunDeletedSchema>
/** What a bot shared, its space, and the files deleted lately (`files-manage`). */
export const fleetFilesListSchema = z.object({
  files: z.array(fleetPublishedFileSchema).max(FLEET_FILE_LIMITS.publishedCountMax),
  removed: z.array(fleetRemovedFileSchema).max(FLEET_FILE_LIMITS.removedKeptMax),
  usage: fleetFilesUsageSchema,
  /** Free space on the disk that holds the files; null when it cannot be measured. */
  diskFreeBytes: fleetNonNegativeIntSchema.nullable(),
})
export type FleetFilesList = z.infer<typeof fleetFilesListSchema>
export const fleetFilesDeleteRequestSchema = z
  .object({ ids: z.array(fleetFileIdSchema).min(1).max(FLEET_FILE_LIMITS.publishedCountMax) })
  .strict()
export type FleetFilesDeleteRequest = z.infer<typeof fleetFilesDeleteRequestSchema>
/** The files actually deleted (unknown ids are skipped), the bytes they took, and the space after. */
export const fleetFilesDeletedSchema = z.object({
  deleted: z.array(fleetFileIdSchema),
  freedBytes: fleetNonNegativeIntSchema,
  usage: fleetFilesUsageSchema,
})
export type FleetFilesDeleted = z.infer<typeof fleetFilesDeletedSchema>
export const fleetRoutineRunReportRequestSchema = fleetRoutineRunReportSchema
export const fleetBotMemoriesResponseSchema = z.object({ memories: z.array(fleetBotMemorySchema) })
export const fleetBotMemoryPatchRequestSchema = z
  .object({ pinned: z.boolean().optional(), status: z.enum(['active', 'archived']).optional() })
  .refine((value) => value.pinned !== undefined || value.status !== undefined, 'nothing to change')
export type FleetBotMemoryPatchRequest = z.infer<typeof fleetBotMemoryPatchRequestSchema>

export const fleetArtifactCallSchema = z.object({
  method: z.string().min(1).max(40),
  args: z.array(z.unknown()).max(3),
})
export type FleetArtifactCall = z.infer<typeof fleetArtifactCallSchema>
export const fleetArtifactResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().max(40),
      message: z.string().max(500),
      details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
  }),
])
export type FleetArtifactResult = z.infer<typeof fleetArtifactResultSchema>
/** Exact normalized HTTP(S) origin, without credentials, path, query or fragment. */
export const fleetHttpOriginSchema = z
  .string()
  .max(300)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
    } catch {
      return false
    }
  }, 'Expected a normalized HTTP(S) origin')
export type FleetHttpOrigin = z.infer<typeof fleetHttpOriginSchema>
export const fleetArtifactSettingsSchema = z.object({
  enabled: z.boolean(),
  publicAddress: z.union([z.literal(''), fleetHttpOriginSchema]),
  ownerName: z.string().trim().max(60),
  linkExpiryDays: z.number().int().min(1).max(365).nullable(),
  quotaGb: z.number().int().min(1).max(100),
})
export type FleetArtifactSettings = z.infer<typeof fleetArtifactSettingsSchema>
export const fleetArtifactSettingsPatchSchema = fleetArtifactSettingsSchema.partial()
export type FleetArtifactSettingsPatch = z.infer<typeof fleetArtifactSettingsPatchSchema>
export const fleetArtifactHostSchema = z.object({
  settings: fleetArtifactSettingsSchema,
  status: z.object({
    state: z.enum(['off', 'running', 'error']),
    problem: z.enum(['port_in_use', 'storage', 'internal']).nullable(),
    artifactCount: fleetNonNegativeIntSchema,
    storageBytes: fleetNonNegativeIntSchema,
    quotaBytes: fleetNonNegativeIntSchema,
  }),
})
export type FleetArtifactHost = z.infer<typeof fleetArtifactHostSchema>

/** Decoded size of a base64 string, without allocating. */
export function base64DecodedBytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.floor((value.length * 3) / 4) - padding
}

/** Original attachment bytes. Older clients omit kind for images; text uses UTF-8 and text/plain. */
export const fleetAttachmentInputSchema = z
  .object({
    name: fleetFileNameSchema,
    kind: z.enum(['image', 'pdf', 'text']).default('image'),
    mediaType: z.union([fleetImageMediaTypeSchema, z.literal('application/pdf'), z.literal('text/plain')]),
    dataBase64: z
      .string()
      .max(Math.ceil(FLEET_FILE_LIMITS.pdfMaxBytes / 3) * 4)
      // Repeated capture groups overflow the regexp stack on multi-megabyte documents.
      .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'Invalid base64'),
  })
  .superRefine((value, ctx) => {
    const bytes = base64DecodedBytes(value.dataBase64)
    const max =
      value.kind === 'pdf'
        ? FLEET_FILE_LIMITS.pdfMaxBytes
        : value.kind === 'text'
          ? FLEET_FILE_LIMITS.textMaxBytes
          : FLEET_IMAGE_LIMITS.attachmentMaxBytes
    if (bytes > max || (bytes === 0 && value.kind !== 'text'))
      ctx.addIssue({ code: 'custom', message: 'Invalid attachment size', path: ['dataBase64'] })
    const validType =
      value.kind === 'image'
        ? fleetImageMediaTypeSchema.safeParse(value.mediaType).success
        : value.mediaType === (value.kind === 'pdf' ? 'application/pdf' : 'text/plain')
    if (!validType)
      ctx.addIssue({ code: 'custom', message: 'Attachment kind does not match media type', path: ['mediaType'] })
  })
export type FleetAttachmentInput = z.infer<typeof fleetAttachmentInputSchema>

const fleetAttachmentListSchema = z
  .array(fleetAttachmentInputSchema)
  .max(FLEET_FILE_LIMITS.attachmentsMax)
  .refine(
    (items) =>
      items.reduce((sum, item) => sum + base64DecodedBytes(item.dataBase64), 0) <=
      FLEET_FILE_LIMITS.attachmentsTotalMaxBytes,
    'attachments exceed the total size limit'
  )
  .refine(
    (items) => items.filter((item) => item.kind === 'pdf').length <= FLEET_FILE_LIMITS.pdfsMax,
    'too many PDF attachments'
  )
const fleetAttachmentsSchema = fleetAttachmentListSchema.default([])

/** A message needs text or at least one image. */
const hasContent = (value: { text: string; attachments: unknown[] }) =>
  value.text.trim().length > 0 || value.attachments.length > 0

export const fleetFeaturesSchema = z.array(z.string().max(40)).max(40).default([])

/** How many `features` desktops up to 0.18 accept in `/v1/meta`; they refuse the whole answer past it. */
export const FLEET_META_FEATURES_LEGACY_MAX = 20
export const fleetMetaResponseSchema = z.object({
  protocol: z.literal(FLEET_PROTOCOL_VERSION),
  gatewayVersion: z.string(),
  botImage: z.string(),
  botImageVersion: z.string().nullable(),
  /** At most `FLEET_META_FEATURES_LEGACY_MAX`, so that every desktop can read the answer. */
  features: fleetFeaturesSchema,
  /** The features past those: desktops up to 0.18 drop this field. Read both lists with `fleetMetaFeatures`. */
  moreFeatures: fleetFeaturesSchema,
  /**
   * This installation's stable id, whatever address it is reached at, so a computer does not pair one server twice.
   * Gateways before it omit it; desktops before it drop it.
   */
  serverId: z.string().uuid().optional(),
})
export type FleetMetaResponse = z.infer<typeof fleetMetaResponseSchema>
/** Every feature a gateway announces, from both lists of `/v1/meta`. */
export function fleetMetaFeatures(meta: { features?: string[]; moreFeatures?: string[] }): string[] {
  return [...new Set([...(meta.features ?? []), ...(meta.moreFeatures ?? [])])]
}

/** What a device says it is when it pairs, so the list of devices can tell a phone from a computer. */
export const fleetDeviceClientSchema = z.object({
  kind: z.enum(['computer', 'phone']),
  platform: z.enum(['macos', 'windows', 'linux', 'ios', 'android']),
})
export type FleetDeviceClient = z.infer<typeof fleetDeviceClientSchema>
export const fleetPairRequestSchema = z.object({
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/),
  deviceName: z.string().min(1),
  // Absent from devices that predate it; gateways that predate it drop it.
  client: fleetDeviceClientSchema.optional(),
})
export type FleetPairRequest = z.infer<typeof fleetPairRequestSchema>
/** A device paired with the server. Kind and platform are null for devices paired before they were recorded. */
export const fleetDeviceSchema = z.object({
  id: fleetIdSchema,
  name: z.string(),
  kind: fleetDeviceClientSchema.shape.kind.nullable(),
  platform: fleetDeviceClientSchema.shape.platform.nullable(),
  pairedAt: fleetTimestampSchema,
  lastSeenAt: fleetTimestampSchema.nullable(),
  /** The device that asked for the list. */
  current: z.boolean(),
  /** Whether the device registered for push notifications. */
  notifications: z.boolean(),
})
export type FleetDevice = z.infer<typeof fleetDeviceSchema>
export const fleetDevicesResponseSchema = z.object({ devices: z.array(fleetDeviceSchema) })
export type FleetDevicesResponse = z.infer<typeof fleetDevicesResponseSchema>
export const fleetPairResponseSchema = z.object({ deviceId: fleetIdSchema, token: fleetIdSchema })
export type FleetPairResponse = z.infer<typeof fleetPairResponseSchema>
export const fleetPairingCodeResponseSchema = z.object({
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
  expiresAt: fleetTimestampSchema,
})
export type FleetPairingCodeResponse = z.infer<typeof fleetPairingCodeResponseSchema>

export const fleetBotsResponseSchema = z.object({ bots: z.array(fleetBotSchema) })
export type FleetBotsResponse = z.infer<typeof fleetBotsResponseSchema>
export const fleetArchivedBotsResponseSchema = z.object({ bots: z.array(fleetArchivedBotSchema) })
export type FleetArchivedBotsResponse = z.infer<typeof fleetArchivedBotsResponseSchema>
/** The container memory limit the owner may set for an environment, in whole bytes. */
export const fleetMemoryLimitSchema = z
  .number()
  .int()
  .min(FLEET_ENVIRONMENT_LIMITS.memoryLimitMinBytes)
  .max(FLEET_ENVIRONMENT_LIMITS.memoryLimitMaxBytes)
export type FleetMemoryLimit = z.infer<typeof fleetMemoryLimitSchema>
export const fleetEnvironmentsResponseSchema = z.object({ environments: z.array(fleetEnvironmentSchema) })
export type FleetEnvironmentsResponse = z.infer<typeof fleetEnvironmentsResponseSchema>
export const fleetArchivedEnvironmentsResponseSchema = z.object({
  environments: z.array(fleetArchivedEnvironmentSchema),
})
export type FleetArchivedEnvironmentsResponse = z.infer<typeof fleetArchivedEnvironmentsResponseSchema>
export const fleetCreateEnvironmentRequestSchema = z.object({
  name: fleetNameSchema,
  /** Null uses the gateway's default limit. */
  memoryLimitBytes: fleetMemoryLimitSchema.nullable().default(null),
  kind: fleetEnvironmentKindSchema.default('bots'),
  /** Gateways with `workspaces-environments` only; older ones drop these. Null: no CPU limit. */
  cpuLimit: fleetCpuLimitSchema.nullable().default(null),
  /** Workspaces environments only. Null: it never stops by itself. */
  idleStopMinutes: fleetIdleStopMinutesSchema.nullable().default(null),
  tint: fleetTintSchema.nullable().default(null),
  idempotencyKey: fleetIdempotencyKeySchema,
})
export type FleetCreateEnvironmentRequest = z.infer<typeof fleetCreateEnvironmentRequestSchema>
export const fleetPatchEnvironmentRequestSchema = z
  .object({
    name: fleetNameSchema.optional(),
    /** Null goes back to the gateway's default limit. */
    memoryLimitBytes: fleetMemoryLimitSchema.nullable().optional(),
    /** Null removes the CPU limit. Gateways with `workspaces-environments` only, as are the fields below. */
    cpuLimit: fleetCpuLimitSchema.nullable().optional(),
    /** Workspaces environments only; null: it never stops by itself. */
    idleStopMinutes: fleetIdleStopMinutesSchema.nullable().optional(),
    tint: fleetTintSchema.nullable().optional(),
    /** Workspaces environments only; it applies when the environment next starts or restarts. */
    hostFolder: fleetHostFolderModeSchema.optional(),
    /** The default compaction model of its bots; null removes it. */
    compaction: fleetCompactionConfigSchema.nullable().optional(),
    /** Optional compare-and-set values for the shared settings editor; legacy callers omit them. */
    expected: z
      .object({
        name: fleetNameSchema.optional(),
        compaction: fleetCompactionConfigSchema.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.memoryLimitBytes !== undefined ||
      value.cpuLimit !== undefined ||
      value.idleStopMinutes !== undefined ||
      value.tint !== undefined ||
      value.hostFolder !== undefined ||
      value.compaction !== undefined,
    'nothing to change'
  )
export type FleetPatchEnvironmentRequest = z.infer<typeof fleetPatchEnvironmentRequestSchema>
/**
 * Moves an environment to the configured bot image: `idle` schedules it for when none of its bots is busy and answers
 * at once; `now` restarts it at once, interrupting its bots.
 */
export const fleetEnvironmentUpdateRequestSchema = z.object({ when: z.enum(['idle', 'now']) })
export type FleetEnvironmentUpdateRequest = z.infer<typeof fleetEnvironmentUpdateRequestSchema>
/**
 * A new bot joins an existing environment (`environmentId`) or gets a new one (`environment`), never both. With
 * neither, as older Macs send it, the gateway creates a new environment named after the bot.
 */
export const fleetCreateBotRequestSchema = z
  .object({
    name: fleetNameSchema,
    instructions: fleetInstructionsSchema,
    ceiling: fleetCeilingSchema,
    talksTo: z.array(fleetBotIdSchema),
    publishArtifacts: z.boolean().optional(),
    idempotencyKey: fleetIdempotencyKeySchema,
    environmentId: fleetEnvironmentIdSchema.optional(),
    environment: z
      .object({ name: fleetNameSchema, memoryLimitBytes: fleetMemoryLimitSchema.nullable().default(null) })
      .optional(),
  })
  .refine((value) => value.environmentId === undefined || value.environment === undefined, {
    message: 'Choose an existing environment or a new one, not both',
    path: ['environment'],
  })
export type FleetCreateBotRequest = z.infer<typeof fleetCreateBotRequestSchema>
/**
 * Moves a bot to another bots environment of its server (`environmentId`) or to a new one (`newEnvironment`), never
 * both (`bot-move`). The gateway answers at once with the move, which then runs on the server.
 */
export const fleetBotMoveRequestSchema = z
  .object({
    environmentId: fleetEnvironmentIdSchema.optional(),
    newEnvironment: z.object({ name: fleetNameSchema }).strict().optional(),
    idempotencyKey: fleetIdempotencyKeySchema,
  })
  .strict()
  .refine((value) => (value.environmentId === undefined) !== (value.newEnvironment === undefined), {
    message: 'Choose an existing environment or a new one',
    path: ['environmentId'],
  })
export type FleetBotMoveRequest = z.infer<typeof fleetBotMoveRequestSchema>
export const fleetPatchBotRequestSchema = z.object({
  name: fleetNameSchema.optional(),
  instructions: fleetInstructionsSchema.optional(),
  role: fleetRoleSchema.optional(),
  ceiling: fleetCeilingSchema.optional(),
  talksTo: z.array(fleetBotIdSchema).optional(),
  publishArtifacts: z.boolean().optional(),
  selection: fleetSelectionSchema.nullable().optional(),
  /**
   * The bot's own compaction model. Null makes it use its environment's default. In an environment without a default,
   * a model becomes that default, used by the bot and its siblings without one.
   */
  compaction: fleetCompactionConfigSchema.nullable().optional(),
  /** How the bot splits its work into tasks (`bot-delegation`); replaced whole. */
  delegation: fleetBotDelegationSchema.optional(),
})
export type FleetPatchBotRequest = z.infer<typeof fleetPatchBotRequestSchema>
export const fleetSelectionsResponseSchema = z.object({
  options: z.array(fleetSelectionOptionSchema),
  current: fleetSelectionSchema.nullable(),
})
export type FleetSelectionsResponse = z.infer<typeof fleetSelectionsResponseSchema>
export const fleetApiKeyProviderKindSchema = z.enum(['anthropic', 'openai', 'openai-responses'])
export type FleetApiKeyProviderKind = z.infer<typeof fleetApiKeyProviderKindSchema>
export const fleetAddApiKeyAccountRequestSchema = z
  .object({
    kind: fleetApiKeyProviderKindSchema,
    name: fleetNameSchema,
    key: z.string().min(1).max(512),
    baseURL: z
      .url()
      .max(300)
      .refine((value) => /^https?:\/\//i.test(value))
      .nullable(),
  })
  .strict()
export type FleetAddApiKeyAccountRequest = z.infer<typeof fleetAddApiKeyAccountRequestSchema>
export const fleetAddApiKeyAccountResponseSchema = z.object({ providerId: fleetIdSchema })
export type FleetAddApiKeyAccountResponse = z.infer<typeof fleetAddApiKeyAccountResponseSchema>
export const fleetSubscriptionKindSchema = z.enum([
  'codex',
  'claude',
  'grok',
  'antigravity',
  'github-copilot',
  'cursor',
])
export type FleetSubscriptionKind = z.infer<typeof fleetSubscriptionKindSchema>
export const fleetLoginKindSchema = z.enum(['codex', 'claude', 'grok', 'antigravity'])
export type FleetLoginKind = z.infer<typeof fleetLoginKindSchema>
export const fleetAccountSlotIdSchema = z.string().regex(/^acc_[A-Za-z0-9-]{1,80}$/)

export const fleetBotAccountsSchema = z.object({
  apiKeys: z.array(
    z.object({
      providerId: fleetIdSchema,
      name: z.string(),
      kind: fleetApiKeyProviderKindSchema,
      baseURL: z.string().nullable(),
      keyHint: z.string().max(8).nullable(),
    })
  ),
  subscriptions: z.array(
    z.object({
      kind: fleetSubscriptionKindSchema,
      accountId: fleetAccountSlotIdSchema.nullable(),
      label: z.string(),
      email: z.string().nullable(),
      plan: z.string().nullable(),
      state: z.enum(['connected', 'signed-out', 'signing-in']),
    })
  ),
})
export type FleetBotAccounts = z.infer<typeof fleetBotAccountsSchema>

export const fleetAccountImportItemSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('api-key'),
      kind: fleetApiKeyProviderKindSchema,
      name: fleetNameSchema,
      key: z.string().min(1).max(512),
      baseURL: fleetAddApiKeyAccountRequestSchema.shape.baseURL,
    })
    .strict(),
  z.object({ type: z.literal('github-copilot'), label: fleetNameSchema, token: z.string().min(1).max(512) }).strict(),
  z
    .object({
      type: z.literal('cursor'),
      label: fleetNameSchema,
      apiKey: z.string().min(1).max(512),
      expiresAt: fleetTimestampSchema.nullable(),
    })
    .strict(),
])
export type FleetAccountImportItem = z.infer<typeof fleetAccountImportItemSchema>
export const fleetAccountImportRequestSchema = z.object({
  items: z.array(fleetAccountImportItemSchema).min(1).max(FLEET_PROVISIONING_LIMITS.importItemsMax),
})
export type FleetAccountImportRequest = z.infer<typeof fleetAccountImportRequestSchema>
export const fleetImportOutcomeSchema = z.enum(['added', 'updated', 'unchanged', 'failed'])
export type FleetImportOutcome = z.infer<typeof fleetImportOutcomeSchema>
export const fleetImportResultsSchema = z.object({
  results: z.array(
    z.object({
      index: fleetNonNegativeIntSchema,
      target: z.string().max(200).nullable(),
      outcome: fleetImportOutcomeSchema,
      error: z.string().max(300).nullable(),
    })
  ),
})
export type FleetImportResults = z.infer<typeof fleetImportResultsSchema>

const fleetCallbackPathSchema = z.string().regex(/^\/[A-Za-z0-9/_-]{0,100}$/)
export const fleetLoginStartRequestSchema = z
  .object({
    kind: fleetLoginKindSchema,
    method: z.enum(['browser', 'device']),
    slot: z.union([z.literal('auto'), z.literal('default'), fleetAccountSlotIdSchema]).default('auto'),
  })
  .refine((value) => value.kind !== 'grok' || value.method === 'device', {
    message: 'Grok signs in with the device flow',
    path: ['method'],
  })
  .refine((value) => value.kind !== 'antigravity' || value.method === 'browser', {
    message: 'Google AI signs in with the browser flow',
    path: ['method'],
  })
export type FleetLoginStartRequest = z.infer<typeof fleetLoginStartRequestSchema>
export const fleetLoginAttemptSchema = z.object({
  loginId: z.string().min(1).max(200),
  kind: fleetLoginKindSchema,
  accountId: fleetAccountSlotIdSchema.nullable(),
  method: z.enum(['browser', 'device']),
  state: z.enum(['pending', 'completed', 'failed', 'cancelled', 'expired']),
  expiresAt: fleetTimestampSchema,
  browser: z
    .object({
      authUrl: z.url().max(4096),
      callback: z.object({ port: z.number().int().min(1024).max(65535), path: fleetCallbackPathSchema }),
    })
    .nullable(),
  device: z.object({ verificationUrl: z.url().max(2048), userCode: z.string().min(1).max(64) }).nullable(),
  manual: z.object({ url: z.url().max(4096) }).nullable(),
  account: z.object({ label: z.string(), email: z.string().nullable(), plan: z.string().nullable() }).nullable(),
  error: z.string().max(300).nullable(),
})
export type FleetLoginAttempt = z.infer<typeof fleetLoginAttemptSchema>
export const fleetLoginCallbackRequestSchema = z.object({ path: fleetCallbackPathSchema, query: z.string().max(8192) })
export type FleetLoginCallbackRequest = z.infer<typeof fleetLoginCallbackRequestSchema>
export const fleetLoginCallbackResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  location: z.string().max(4096).nullable(),
  contentType: z.string().max(200).nullable(),
  body: z.string().max(FLEET_PROVISIONING_LIMITS.callbackBodyMax),
})
export type FleetLoginCallbackResponse = z.infer<typeof fleetLoginCallbackResponseSchema>
export const fleetLoginCodeRequestSchema = z.object({ code: z.string().trim().min(1).max(2048) })

export const fleetSkillNameSchema = z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,63}$/)
export const fleetSkillInstallRequestSchema = z.object({
  name: fleetSkillNameSchema,
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(FLEET_PROVISIONING_LIMITS.skillPathMax),
        data: z.string().max(Math.ceil(FLEET_PROVISIONING_LIMITS.skillFileBytesMax / 3) * 4),
        executable: z.boolean(),
      })
    )
    .min(1)
    .max(FLEET_PROVISIONING_LIMITS.skillFilesMax),
})
export type FleetSkillInstallRequest = z.infer<typeof fleetSkillInstallRequestSchema>
export const fleetSkillInstallResponseSchema = z.object({
  name: fleetSkillNameSchema,
  outcome: z.enum(['added', 'updated', 'unchanged']),
})
export type FleetSkillInstallResponse = z.infer<typeof fleetSkillInstallResponseSchema>
export const fleetBotSkillsSchema = z.object({
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string().max(1024),
      files: fleetNonNegativeIntSchema,
      bytes: fleetNonNegativeIntSchema,
      source: z.enum(['fleet', 'registry', 'local']),
    })
  ),
})
export type FleetBotSkills = z.infer<typeof fleetBotSkillsSchema>

export const fleetMcpServerImportSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    transport: z.enum(['http', 'stdio']),
    enabled: z.boolean(),
    url: z
      .url()
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value))
      .optional(),
    headers: z.record(z.string().min(1).max(200), z.string().max(8192)).optional(),
    command: z.string().trim().min(1).max(500).optional(),
    args: z.array(z.string().max(4096)).max(100).optional(),
    env: z.record(z.string().min(1).max(200), z.string().max(16_384)).optional(),
  })
  .strict()
  .refine((value) => (value.transport === 'http' ? Boolean(value.url) : Boolean(value.command)), {
    message: 'An http server needs a URL; a stdio server needs a command',
  })
export type FleetMcpServerImport = z.infer<typeof fleetMcpServerImportSchema>
export const fleetMcpImportRequestSchema = z.object({
  servers: z.array(fleetMcpServerImportSchema).min(1).max(FLEET_PROVISIONING_LIMITS.importItemsMax),
})
export type FleetMcpImportRequest = z.infer<typeof fleetMcpImportRequestSchema>
export const fleetBotMcpServersSchema = z.object({
  servers: z.array(
    z.object({
      id: fleetIdSchema,
      name: z.string(),
      transport: z.enum(['http', 'stdio']),
      enabled: z.boolean(),
      command: z.string().nullable(),
      host: z.string().nullable(),
      envKeys: z.array(z.string()),
      headerKeys: z.array(z.string()),
      unavailable: z.boolean(),
    })
  ),
})
export type FleetBotMcpServers = z.infer<typeof fleetBotMcpServersSchema>

export const fleetSendMessageRequestSchema = z
  .object({
    text: z.string().max(FLEET_MESSAGE_TEXT_MAX),
    idempotencyKey: fleetIdempotencyKeySchema,
    attachments: fleetAttachmentsSchema,
    /** A routine run of this bot the message refers to (`routine-conversations`): the bot reads it to answer. */
    citation: z.object({ runId: fleetIdSchema }).optional(),
  })
  .refine(hasContent, 'a message needs text or an image')
export type FleetSendMessageRequest = z.infer<typeof fleetSendMessageRequestSchema>
/**
 * The owner's last message, edited (`message-edit`): the bot's conversation is cut from that message and the new text
 * runs as a new turn. Without `attachments` the message keeps the ones it had; with them, they replace those.
 */
export const fleetEditMessageRequestSchema = z.object({
  text: z.string().max(FLEET_MESSAGE_TEXT_MAX),
  idempotencyKey: fleetIdempotencyKeySchema,
  attachments: fleetAttachmentListSchema.optional(),
})
export type FleetEditMessageRequest = z.infer<typeof fleetEditMessageRequestSchema>
export const fleetInputReceiptSchema = z.object({ inputId: fleetIdSchema, itemId: fleetIdSchema, queued: z.boolean() })
export type FleetInputReceipt = z.infer<typeof fleetInputReceiptSchema>
export const fleetTakeoverReleaseRequestSchema = z.object({ note: fleetNoteSchema.nullable(), continue: z.boolean() })
export type FleetTakeoverReleaseRequest = z.infer<typeof fleetTakeoverReleaseRequestSchema>
export const fleetScreenTicketRequestSchema = z.object({
  mode: z.enum(['view', 'control']),
  /** Older Macs only know the browser area. */
  surface: fleetScreenSurfaceSchema.default('browser'),
  /**
   * The Origin a phone's WebSocket sends (React Native always sends one), which the gateway then accepts on this
   * ticket's upgrade (`phone-screens`), as with a bridge ticket. Computers send no Origin and leave it out.
   */
  origin: z
    .string()
    .max(300)
    .refine((value) => fleetBridgeOrigin(value) === value, 'Invalid origin')
    .optional(),
})
export type FleetScreenTicketRequest = z.infer<typeof fleetScreenTicketRequestSchema>
/** The environment screen shows only Maestrly's settings: control needs no takeover. */
export const fleetEnvironmentScreenTicketRequestSchema = z.object({ mode: z.enum(['view', 'control']) })
export type FleetEnvironmentScreenTicketRequest = z.infer<typeof fleetEnvironmentScreenTicketRequestSchema>
/**
 * A workspaces conversation's screens: its computer (`apps`), or its browser's tile (`browser`), which is only watched:
 * the Browser tab sends its input over the bridge.
 */
export const fleetConversationScreenTicketRequestSchema = z
  .object({ mode: z.enum(['view', 'control']), surface: fleetScreenSurfaceSchema })
  .strict()
  .refine((value) => value.surface !== 'browser' || value.mode === 'view', {
    message: "A conversation's browser is view only",
  })
export type FleetConversationScreenTicketRequest = z.infer<typeof fleetConversationScreenTicketRequestSchema>
export const fleetScreenTicketResponseSchema = z.object({
  ticket: fleetIdSchema,
  path: z.string().startsWith('/v1/screen?ticket='),
  expiresAt: fleetTimestampSchema,
})
export type FleetScreenTicketResponse = z.infer<typeof fleetScreenTicketResponseSchema>
/**
 * A bridge ticket request. A phone names the `origin` its WebSocket sends (React Native always sends one); the gateway
 * then accepts that one Origin on the upgrade (`phones`). Computers send no Origin and leave it out.
 */
export const fleetBridgeTicketRequestSchema = z
  .object({
    origin: z
      .string()
      .max(300)
      .refine((value) => fleetBridgeOrigin(value) === value, 'Invalid origin')
      .optional(),
  })
  .strict()
export type FleetBridgeTicketRequest = z.infer<typeof fleetBridgeTicketRequestSchema>
/** A one-use ticket to open the bridge of a workspaces environment. */
export const fleetBridgeTicketResponseSchema = z.object({
  ticket: fleetIdSchema,
  path: z.string().regex(/^\/v1\/bridge\?ticket=[A-Za-z0-9_-]+$/),
  expiresAt: fleetTimestampSchema,
})
export type FleetBridgeTicketResponse = z.infer<typeof fleetBridgeTicketResponseSchema>
export const fleetUiOpenRequestSchema = z.object({ target: z.enum(['accounts', 'main', 'skills', 'mcp']) })

/**
 * Conversation-scoped chat settings of the bot's primary conversation, mirroring the desktop's own chat API so the
 * Mac renders the same composer menus. The instance always targets its primary conversation (a conversation id is
 * never accepted) and validates each op's arguments with the desktop's own rules. Results are desktop types of the
 * same app version; the instance projects them so no secret or credential ever leaves the bot.
 */
export const FLEET_CONVERSATION_OPS = [
  'chatConfig',
  'chatGetConvTools',
  'chatSetConvTools',
  'chatSubagentProfilesGetConversation',
  'chatSubagentProfilesSetConversationEnabled',
  'chatSubagentsSetConversationEnabled',
  'chatSkillsState',
  'chatSkillSetOverride',
  'chatSkillResetOverrides',
  'chatSkillSetSelection',
  'chatCommands',
  // Compaction with the bot's compaction model. Both start the work and answer at once (the gateway gives an
  // instance call 15 s); progress arrives in `FleetBot.compactionState` and the result in the transcript.
  'chatCompact',
  'chatBackgroundCompactionRetry',
] as const
export const fleetConversationOpSchema = z.enum(FLEET_CONVERSATION_OPS)
export type FleetConversationOp = z.infer<typeof fleetConversationOpSchema>
export const fleetConversationCallRequestSchema = z
  .object({ op: fleetConversationOpSchema, args: z.array(z.unknown()).max(4) })
  .strict()
export type FleetConversationCallRequest = z.infer<typeof fleetConversationCallRequestSchema>
export const fleetConversationCallResponseSchema = z.object({ result: z.unknown() })
export type FleetConversationCallResponse = z.infer<typeof fleetConversationCallResponseSchema>
export type FleetUiOpenRequest = z.infer<typeof fleetUiOpenRequestSchema>
export const fleetRoutinesResponseSchema = z.object({ routines: z.array(fleetRoutineSchema) })
export type FleetRoutinesResponse = z.infer<typeof fleetRoutinesResponseSchema>
export const fleetCreateRoutineRequestSchema = z.object({
  title: z.string().min(1).max(FLEET_ROUTINE_TITLE_MAX),
  prompt: z.string().min(1).max(FLEET_ROUTINE_PROMPT_MAX),
  schedule: fleetRoutineScheduleSchema,
  enabled: z.boolean(),
  idempotencyKey: fleetIdempotencyKeySchema,
})
export type FleetCreateRoutineRequest = z.infer<typeof fleetCreateRoutineRequestSchema>
export const fleetPatchRoutineRequestSchema = fleetCreateRoutineRequestSchema.omit({ idempotencyKey: true }).partial()
export type FleetPatchRoutineRequest = z.infer<typeof fleetPatchRoutineRequestSchema>
export const fleetInboxResponseSchema = z.object({ items: z.array(fleetInboxItemSchema) })
export type FleetInboxResponse = z.infer<typeof fleetInboxResponseSchema>
export const fleetPeerMessagesResponseSchema = z.object({ messages: z.array(fleetPeerMessageSchema) })
export type FleetPeerMessagesResponse = z.infer<typeof fleetPeerMessagesResponseSchema>
export const fleetActivityResponseSchema = z.object({
  entries: z.array(fleetActivityEntrySchema),
  lastSeq: fleetNonNegativeIntSchema,
})
export type FleetActivityResponse = z.infer<typeof fleetActivityResponseSchema>

export const fleetInternalPeersResponseSchema = z.object({
  peers: z.array(
    z.object({ botId: fleetBotIdSchema, name: fleetNameSchema, role: fleetRoleSchema, status: fleetBotStatusSchema })
  ),
})
export type FleetInternalPeersResponse = z.infer<typeof fleetInternalPeersResponseSchema>
export const fleetInternalPeerMessageRequestSchema = z.object({
  to: fleetBotIdSchema,
  text: fleetPeerTextSchema,
  idempotencyKey: fleetIdempotencyKeySchema,
  /** The thread the message continues (`peer-conversations`); without it the message opens a thread. */
  thread: fleetIdSchema.optional(),
  /** The subject of the thread it opens. */
  topic: z.string().trim().min(1).max(FLEET_PEER_THREAD_LIMITS.topicMax).optional(),
  /** Where the sender opens it from: its conversation with its owner, or another side conversation. */
  origin: z.enum(['primary', 'side']).optional(),
})
export type FleetInternalPeerMessageRequest = z.infer<typeof fleetInternalPeerMessageRequestSchema>
export const fleetInternalPeerMessageResponseSchema = z.object({
  messageId: fleetIdSchema,
  delivered: z.boolean(),
  /** The thread the message went to, from a gateway with `peer-conversations`. */
  thread: fleetIdSchema.optional(),
})
/** What a bot brings back to its owner's conversation from a thread it opened there. */
export const fleetInternalPeerThreadReportRequestSchema = z.object({
  text: z.string().trim().min(1).max(FLEET_PEER_THREAD_LIMITS.reportMax),
})
export const fleetInternalPeerThreadReportResponseSchema = z.object({ ok: z.literal(true) })
/** A bot's threads with other bots, the most recent first. */
export const fleetPeerThreadListSchema = z.object({
  threads: z.array(fleetPeerThreadSchema).max(FLEET_PEER_THREAD_LIMITS.listMax),
})
export type FleetPeerThreadList = z.infer<typeof fleetPeerThreadListSchema>
/**
 * The owner keeps a thread (`pinned`), lets a paused one go on for `hopLimit` more messages (`resume`), or saw its
 * activity so far (`seen`, from gateways with `owner-seen`).
 */
export const fleetPeerThreadPatchRequestSchema = z
  .object({ pinned: z.boolean().optional(), resume: z.literal(true).optional(), seen: z.literal(true).optional() })
  .strict()
  .refine(
    (value) => value.pinned !== undefined || value.resume !== undefined || value.seen !== undefined,
    'nothing to change'
  )
export type FleetPeerThreadPatchRequest = z.infer<typeof fleetPeerThreadPatchRequestSchema>
export type FleetInternalPeerMessageResponse = z.infer<typeof fleetInternalPeerMessageResponseSchema>
/**
 * A bot's own routines, through the internal API. The caller is the bot the gateway token identifies: it lists all of
 * its routines, creates routines marked `createdBy: 'bot'` (up to `FLEET_ROUTINE_LIMITS.botCreatedMax`), and changes
 * or deletes only those; routines the owner created are refused with FORBIDDEN.
 */
export const fleetInternalRoutineCreateRequestSchema = fleetCreateRoutineRequestSchema
export type FleetInternalRoutineCreateRequest = FleetCreateRoutineRequest
export const fleetInternalRoutinePatchRequestSchema = fleetPatchRoutineRequestSchema
export type FleetInternalRoutinePatchRequest = FleetPatchRoutineRequest

/**
 * Why a desktop call did not run. `desktop_not_linked`: no Mac with that id gave this bot access (or it took it back);
 * `desktop_offline`: that Mac's Maestrly is not connected to this server now; `desktop_timeout`: it did not answer in
 * time; `desktop_busy`: too many calls of this bot are waiting; `desktop_refused`: the Mac refused it (a grant, a paused
 * conversation, an unknown id or an invalid input); `desktop_unavailable`: the Mac could not run it.
 */
export const fleetDesktopErrorCodeSchema = z.enum([
  'desktop_not_linked',
  'desktop_offline',
  'desktop_timeout',
  'desktop_busy',
  'desktop_refused',
  'desktop_unavailable',
])
export type FleetDesktopErrorCode = z.infer<typeof fleetDesktopErrorCodeSchema>
/** What a Mac answers to one call, and what the bot receives back, failures included. */
export const fleetDesktopCallResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: fleetDesktopErrorCodeSchema, message: z.string().max(1_000) }).strict(),
    })
    .strict(),
])
export type FleetDesktopCallResult = z.infer<typeof fleetDesktopCallResultSchema>
/** A bot's call for one Mac; the gateway takes the bot from its token and the Mac from `desktopId`. */
export const fleetInternalDesktopCallRequestSchema = z
  .object({ desktopId: fleetDesktopIdSchema, op: fleetDesktopOpSchema, input: fleetDesktopInputSchema.default({}) })
  .strict()
export type FleetInternalDesktopCallRequest = z.infer<typeof fleetInternalDesktopCallRequestSchema>
export const fleetInternalDesktopsResponseSchema = z.object({ desktops: z.array(fleetDesktopLinkSchema) })
export type FleetInternalDesktopsResponse = z.infer<typeof fleetInternalDesktopsResponseSchema>
/** A Mac links a bot under the name it shows to that bot, or renames its link. */
export const fleetDesktopLinkRequestSchema = z.object({ name: fleetDesktopNameSchema }).strict()
export type FleetDesktopLinkRequest = z.infer<typeof fleetDesktopLinkRequestSchema>
export const fleetDesktopLinksResponseSchema = z.object({ links: z.array(fleetDesktopLinkViewSchema) })
export type FleetDesktopLinksResponse = z.infer<typeof fleetDesktopLinksResponseSchema>
/** A workspaces host's own link to one bot, as its host token reads it (`hostDesktopLinks`). */
export const fleetHostDesktopLinkSchema = fleetDesktopLinkViewSchema.extend({ botId: fleetBotIdSchema })
export type FleetHostDesktopLink = z.infer<typeof fleetHostDesktopLinkSchema>
/** Every link of the workspaces host asking, one per bot it gave access to; never another computer's. */
export const fleetHostDesktopLinksResponseSchema = z.object({ links: z.array(fleetHostDesktopLinkSchema) })
export type FleetHostDesktopLinksResponse = z.infer<typeof fleetHostDesktopLinksResponseSchema>
/** One bot's call, posted by the gateway to the workspaces host its link names (`hostDesktopCall`). */
export const fleetHostDesktopCallRequestSchema = fleetDesktopCallSchema.strict()
export type FleetHostDesktopCallRequest = z.infer<typeof fleetHostDesktopCallRequestSchema>
/** The gateway changed a bot's link to a workspaces host without it (removed from a computer, or the bot deleted). */
export const fleetHostDesktopLinksChangedSchema = z.object({ botId: fleetBotIdSchema }).strict()
export type FleetHostDesktopLinksChanged = z.infer<typeof fleetHostDesktopLinksChangedSchema>

/** A computer links a bot as its runner under the name the bot sees, or renames its link. */
export const fleetRunnerLinkRequestSchema = z.object({ name: fleetRunnerNameSchema }).strict()
export type FleetRunnerLinkRequest = z.infer<typeof fleetRunnerLinkRequestSchema>
export const fleetRunnerLinksResponseSchema = z.object({ links: z.array(fleetRunnerLinkViewSchema) })
export type FleetRunnerLinksResponse = z.infer<typeof fleetRunnerLinksResponseSchema>
export const fleetRunnerJobsResponseSchema = z.object({ jobs: z.array(fleetRunnerJobSchema) })
export type FleetRunnerJobsResponse = z.infer<typeof fleetRunnerJobsResponseSchema>
/** What a runner reports on connecting and whenever it changes: whether it takes jobs, what it is, the jobs it holds. */
export const fleetRunnerStateRequestSchema = z
  .object({
    accepting: z.boolean(),
    capabilities: fleetRunnerCapabilitiesSchema.nullable(),
    jobs: z.array(fleetRunnerJobIdSchema).max(FLEET_RUNNER_LIMITS.slotsMax * 4),
  })
  .strict()
  .refine((state) => !state.accepting || state.capabilities !== null, 'A runner that accepts jobs reports what it is')
export type FleetRunnerStateRequest = z.infer<typeof fleetRunnerStateRequestSchema>
/** The jobs the runner holds that ended or are unknown on the gateway: it stops them. */
export const fleetRunnerStateResponseSchema = z.object({ stop: z.array(fleetRunnerJobIdSchema) })
export type FleetRunnerStateResponse = z.infer<typeof fleetRunnerStateResponseSchema>
/** A runner's command ended and it is sending the job's outputs. */
export const fleetRunnerJobProgressRequestSchema = z.object({ state: z.literal('finishing') }).strict()
export type FleetRunnerJobProgressRequest = z.infer<typeof fleetRunnerJobProgressRequestSchema>
/** A job ended on its runner: the command's exit code (null when it never ran or was stopped) and why it failed. */
export const fleetRunnerJobFinishRequestSchema = z
  .object({ exitCode: z.number().int().nullable(), error: fleetRunnerErrorSchema.nullable() })
  .strict()
export type FleetRunnerJobFinishRequest = z.infer<typeof fleetRunnerJobFinishRequestSchema>
/** A runner tells what one of its running jobs uses now; the gateway stamps it and keeps the last one in memory. */
export const fleetRunnerJobUsageRequestSchema = fleetRunnerJobUsageSchema.omit({ at: true }).strict()
export type FleetRunnerJobUsageRequest = z.infer<typeof fleetRunnerJobUsageRequestSchema>
/**
 * A piece of a job's log as its bot's environment holds it: bytes `start` up to `next` of the `size` it has, as text.
 * Asked with `?offset=<n>`, it starts there (the `next` of the piece before); without, it is the end of the log, from the
 * start of a line. `next` never splits a character, so reading on from it loses nothing. `limit` bounds the bytes.
 */
export const fleetRunnerJobLogPageSchema = z
  .object({
    start: z.number().int().nonnegative(),
    next: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict()
export type FleetRunnerJobLogPage = z.infer<typeof fleetRunnerJobLogPageSchema>
/** A bot's job: the id its environment minted, what to run, what it needs, and the runner (any linked one if none). */
export const fleetInternalRunnerJobRequestSchema = z
  .object({
    jobId: fleetRunnerJobIdSchema,
    spec: fleetRunnerJobSpecSchema,
    requires: fleetRunnerRequirementsSchema.default({}),
    runnerId: fleetRunnerIdSchema.optional(),
  })
  .strict()
export type FleetInternalRunnerJobRequest = z.infer<typeof fleetInternalRunnerJobRequestSchema>
/** A job the gateway queued, with how many queued jobs go before it, or why it refused it. */
export const fleetRunnerSubmitResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), job: fleetRunnerJobSchema, queuedAhead: z.number().int().nonnegative() }).strict(),
  z.object({ ok: z.literal(false), error: fleetRunnerErrorSchema }).strict(),
])
export type FleetRunnerSubmitResult = z.infer<typeof fleetRunnerSubmitResultSchema>
export const fleetInternalRunnersResponseSchema = z.object({ runners: z.array(fleetRunnerLinkSchema) })
export type FleetInternalRunnersResponse = z.infer<typeof fleetInternalRunnersResponseSchema>
/** The gateway tells a bot's environment where one of its jobs stands now. */
export const fleetInstanceRunnerJobStateSchema = z.object({ job: fleetRunnerJobSchema }).strict()
export type FleetInstanceRunnerJobState = z.infer<typeof fleetInstanceRunnerJobStateSchema>
const fleetSha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
/** The blobs a runner asks a job's environment for, by digest. */
export const fleetRunnerBlobsRequestSchema = z
  .object({ digests: z.array(fleetSha256Schema).min(1).max(10_000) })
  .strict()
export type FleetRunnerBlobsRequest = z.infer<typeof fleetRunnerBlobsRequestSchema>
/** A runner commits the output archive it uploaded. */
export const fleetRunnerOutputCommitSchema = z
  .object({ bytes: z.number().int().nonnegative().max(FLEET_RUNNER_LIMITS.outputBytesMax), sha256: fleetSha256Schema })
  .strict()
export type FleetRunnerOutputCommit = z.infer<typeof fleetRunnerOutputCommitSchema>
/** How much of a job's output archive its environment holds, so an interrupted upload resumes there. */
export const fleetRunnerOutputStatusSchema = z.object({ received: z.number().int().nonnegative() }).strict()
export type FleetRunnerOutputStatus = z.infer<typeof fleetRunnerOutputStatusSchema>
/** The gateway routes that stream a job's files between its runner and its bot's environment. */
export const FLEET_RUNNER_TRANSFER_ROUTE_KEYS = [
  'runnerJobManifest',
  'runnerJobBlobs',
  'runnerJobLog',
  'runnerJobOutputs',
  'runnerJobOutputChunk',
  'runnerJobOutputCommit',
] as const
export type FleetRunnerTransferRouteKey = (typeof FLEET_RUNNER_TRANSFER_ROUTE_KEYS)[number]

export const fleetInputSourceSchema = z.enum(['owner', 'routine', 'peer', 'continuation'])
export type FleetInputSource = z.infer<typeof fleetInputSourceSchema>
export const fleetInstanceProfileSchema = z.object({
  botId: fleetBotIdSchema,
  name: fleetNameSchema,
  instructions: fleetInstructionsSchema,
  ceiling: fleetCeilingSchema,
  selection: fleetSelectionSchema.nullable(),
  compaction: fleetCompactionConfigSchema.nullable().default(null),
  /** An inherited default may already be hidden from new selections; inheritance keeps that existing choice. */
  compactionInherited: z.boolean().optional(),
  gateway: z.object({
    peersEnabled: z.boolean(),
    artifactsEnabled: z.boolean().default(false),
    /** The gateway routes calls to the Macs that link the bot (`desktop-bridge`); older gateways send none. */
    desktopBridgeEnabled: z.boolean().default(false),
    /** The gateway runs the bot's routines in conversations of their own (`routine-conversations`). */
    routineConversations: z.boolean().optional(),
    /** The gateway sends the bot's jobs to the computers that run jobs for it (`runners`); older gateways send none. */
    runnersEnabled: z.boolean().optional(),
  }),
  /** The bot's color, for its desktop. Gateways from before the unified desktop send none. */
  tint: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  /** How the bot splits its work into tasks (`bot-delegation`); absent from gateways that predate it or until set. */
  delegation: fleetBotDelegationSchema.optional(),
})
export type FleetInstanceProfile = z.infer<typeof fleetInstanceProfileSchema>
/** Installs or updates a bot in an environment instance: its profile, its display slot and its own gateway token. */
export const fleetInstanceBotInstallSchema = z.object({
  profile: fleetInstanceProfileSchema,
  slot: z.number().int().min(1).max(FLEET_ENVIRONMENT_LIMITS.botsMax),
  gatewayToken: z.string().min(16).max(200),
  /** Applied before queued work starts, including a pause recorded while the environment was stopped. */
  paused: z.boolean().optional(),
  /** Restores an owner's takeover before dispatch after the environment process restarts. */
  takeover: z.boolean().optional(),
})
export type FleetInstanceBotInstall = z.infer<typeof fleetInstanceBotInstallSchema>
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
/**
 * What a bot moves with, reduced to counts and hashes that the environment it leaves and the one it joins compute on
 * their own (`bot-move`): its conversation's messages in order, its memories, and every file that moves.
 */
export const fleetBotMoveDigestSchema = z
  .object({
    conversationId: fleetIdSchema.nullable(),
    messages: fleetNonNegativeIntSchema,
    lastSeq: z.number().int(),
    messagesSha256: sha256Hex,
    memories: fleetNonNegativeIntSchema,
    memoriesSha256: sha256Hex,
    files: fleetNonNegativeIntSchema,
    filesSha256: sha256Hex,
  })
  .strict()
export type FleetBotMoveDigest = z.infer<typeof fleetBotMoveDigestSchema>
/** A frozen bot: no longer installed, its data kept as it is now, which is what its digest describes. */
export const fleetInstanceBotFreezeSchema = z.object({ digest: fleetBotMoveDigestSchema })
export type FleetInstanceBotFreeze = z.infer<typeof fleetInstanceBotFreezeSchema>
/** A bot's package, imported but not installed: the digest of what the environment now holds of it. */
export const fleetInstanceBotImportSchema = z.object({ digest: fleetBotMoveDigestSchema })
export type FleetInstanceBotImport = z.infer<typeof fleetInstanceBotImportSchema>
export const fleetInstanceHoldSchema = z.object({
  state: z.enum(['none', 'holding', 'held']),
  reason: z.enum(['takeover', 'paused']).nullable(),
  since: fleetTimestampSchema.nullable(),
  interruptedTurn: z.boolean(),
})
export type FleetInstanceHold = z.infer<typeof fleetInstanceHoldSchema>
/** A turn running in one of the bot's conversations (`parallel-turns`). */
export const fleetInstanceTurnSchema = z.object({
  state: z.enum(['running', 'cancelling']),
  startedAt: fleetTimestampSchema,
  inputId: fleetIdSchema,
  /** The side conversation it works in (a routine run or a peer thread); null for the bot's own. */
  runId: fleetIdSchema.nullable(),
  tool: z.object({ tool: z.string(), target: z.string().nullable() }).nullable(),
  /** Its conversation's context is being compacted, before or during the turn; absent from older instances. */
  compacting: z.boolean().optional(),
})
export type FleetInstanceTurn = z.infer<typeof fleetInstanceTurnSchema>
export const fleetInstanceStatusSchema = z.object({
  capabilities: fleetFeaturesSchema,
  appVersion: z.string(),
  protocol: z.literal(FLEET_PROTOCOL_VERSION),
  ready: z.boolean(),
  accounts: z.object({
    connected: z.boolean(),
    providers: z.array(z.object({ id: fleetIdSchema, label: z.string() })),
  }),
  selection: fleetSelectionSchema.nullable(),
  ceiling: fleetCeilingSchema,
  profile: z.object({ botId: fleetBotIdSchema, name: fleetNameSchema }).nullable(),
  conversationId: fleetIdSchema.nullable(),
  turn: z.object({
    state: z.enum(['idle', 'running', 'cancelling']),
    startedAt: fleetTimestampSchema.nullable(),
    /** The queued input the running turn was started from, so the gateway can tell a routine run is still going. */
    inputId: fleetIdSchema.nullable().default(null),
    /** The routine run whose own conversation the turn works in (`routine-conversations`); null for the bot's own. */
    runId: fleetIdSchema.nullable().default(null),
  }),
  /**
   * Every turn running now, one per conversation (`parallel-turns`); `turn` stays the bot's own conversation's, else
   * the oldest, for older readers. Empty from an instance that predates it: read both with `fleetInstanceTurns`.
   */
  turns: z
    .array(fleetInstanceTurnSchema)
    .max(FLEET_BOT_SIDE_TURNS_MAX + 1)
    .default([]),
  hold: fleetInstanceHoldSchema,
  queue: z.array(
    z.object({
      inputId: fleetIdSchema,
      source: fleetInputSourceSchema,
      preview: z.string().max(FLEET_QUEUE_PREVIEW_MAX),
      /** The routine run whose conversation it waits for; null for the bot's own. */
      runId: fleetIdSchema.nullable().default(null),
      /** The owner stopped its conversation: it waits for them to write there, and the bot is not working on it. */
      stopped: z.boolean().optional(),
    })
  ),
  activity: fleetActivitySchema.nullable(),
  pending: z.array(fleetPendingInteractionSchema),
  usage: fleetUsageSchema.nullable().default(null),
  /** Null from a bot that predates bot compaction: the gateway does not hold it in setup. */
  compaction: fleetCompactionStateSchema.nullable().default(null),
  sharedFiles: fleetFilesUsageSchema.nullable().default(null),
  /** The environment's runtimes, the same in every bot's status; null from an image that predates runtime reports. */
  runtimes: fleetRuntimesSchema.nullable().default(null),
  /** Additional runtime IDs, kept separate so older readers can still parse the legacy runtimes. */
  additionalRuntimes: fleetRuntimesSchema.optional(),
  lastEventSeq: fleetNonNegativeIntSchema,
})
export type FleetInstanceStatus = z.infer<typeof fleetInstanceStatusSchema>
/** The instance starts the checks and answers at once; their results arrive in later statuses. */
export const fleetRuntimesCheckResponseSchema = z.object({ ok: z.literal(true) })
/** The aggregate status of an environment instance: one status per installed bot. */
export const fleetInstanceEnvironmentStatusSchema = z.object({
  environmentId: fleetEnvironmentIdSchema.nullable(),
  capabilities: fleetFeaturesSchema,
  appVersion: z.string(),
  protocol: z.literal(FLEET_PROTOCOL_VERSION),
  ready: z.boolean(),
  bots: z.array(
    z.object({ botId: fleetBotIdSchema, slot: z.number().int().min(1), status: fleetInstanceStatusSchema })
  ),
})
export type FleetInstanceEnvironmentStatus = z.infer<typeof fleetInstanceEnvironmentStatusSchema>
export const fleetInstanceInputSchema = z
  .object({
    idempotencyKey: fleetIdempotencyKeySchema,
    text: z.string().max(FLEET_MESSAGE_TEXT_MAX),
    source: fleetInputSourceSchema,
    routine: z
      .object({
        id: fleetIdSchema,
        title: z.string(),
        runId: fleetIdSchema.optional(),
        previousRuns: z.array(fleetRoutinePreviousRunSchema).max(FLEET_ROUTINE_RUN_LIMITS.previousRuns).optional(),
      })
      .optional(),
    peer: z.object({ botId: fleetBotIdSchema, name: fleetNameSchema }).optional(),
    // Only owner messages carry images.
    attachments: fleetAttachmentsSchema,
    /**
     * The routine run whose own conversation this input goes to (`routine-conversations`): a routine's input with it
     * starts the run's conversation, and an owner's continues it. Without it the input goes to the bot's conversation.
     */
    run: z.object({ id: fleetIdSchema }).optional(),
    /** The routine run an owner's message refers to, for the bot to read. */
    citation: fleetRoutineRunCitationSchema.optional(),
    /**
     * The thread between bots whose own conversation this input goes to (`peer-conversations`): another bot's message
     * starts the thread's conversation on this side, and an owner's continues it. `context` is what this bot sent to
     * open it from another conversation, for the thread's first answer.
     */
    thread: z
      .object({
        id: fleetIdSchema,
        title: z.string().max(FLEET_PEER_THREAD_LIMITS.titleMax),
        context: z.string().max(FLEET_PEER_THREAD_LIMITS.contextMax).optional(),
      })
      .optional(),
  })
  .refine(hasContent, 'an input needs text or an image')
  .refine((value) => value.source === 'owner' || value.attachments.length === 0, 'only owner inputs carry images')
  .refine((value) => !value.run || value.source !== 'peer', 'peer messages go to the bot conversation')
  .refine((value) => !(value.run && value.thread), 'an input goes to one conversation')
  .refine(
    (value) => !value.thread || ['peer', 'owner', 'continuation'].includes(value.source),
    'a thread takes messages of bots and of the owner'
  )
  .refine(
    (value) => !value.run || value.source !== 'routine' || value.routine?.runId === value.run.id,
    'a run starts with its own routine input'
  )
export type FleetInstanceInput = z.infer<typeof fleetInstanceInputSchema>
/** Every event names its bot; null from an instance that predates environments (it hosts a single bot). */
const instanceEventBase = {
  seq: fleetNonNegativeIntSchema,
  at: fleetTimestampSchema,
  botId: fleetBotIdSchema.nullable().default(null),
}
export const fleetInstanceEventSchema = z.discriminatedUnion('type', [
  z.object({ ...instanceEventBase, type: z.literal('status'), status: fleetInstanceStatusSchema }),
  z.object({
    ...instanceEventBase,
    type: z.literal('transcript.upsert'),
    item: fleetTranscriptItemSchema,
    /** An item of a routine run's own conversation, sent only to readers that ask (`routineRuns=1`). */
    runId: fleetIdSchema.nullable().default(null),
  }),
  z.object({
    ...instanceEventBase,
    type: z.literal('turn.finished'),
    inputId: z.string().nullable().default(null),
    text: z.string().max(FLEET_ROUTINE_RUN_LIMITS.finalTextMax).nullable().default(null),
    /** Who sent the input the turn answered; null from an instance that predates it. */
    source: fleetInputSourceSchema.nullable().default(null),
    outcome: z.enum(['completed', 'cancelled', 'failed']),
    summary: z.string().nullable(),
    /** The routine run whose own conversation the turn worked in; null for the bot's own. */
    runId: fleetIdSchema.nullable().default(null),
    /** What that run's conversation holds for the owner, once the turn ended. */
    media: fleetRoutineRunMediaSchema.nullable().default(null),
  }),
  /** With `runId`, only that run's transcript changed (sent only to readers that ask for runs). */
  z.object({ ...instanceEventBase, type: z.literal('reset'), runId: fleetIdSchema.nullable().default(null) }),
  /** A workspaces host's chat needs the owner (`chatAttention` readers only); the gateway turns it into a push. */
  z.object({
    ...instanceEventBase,
    type: z.literal('chat.attention'),
    conversationId: z.string().min(1).max(200),
    name: z.string().max(200),
    kind: fleetChatAttentionKindSchema,
  }),
])
export type FleetInstanceEvent = z.infer<typeof fleetInstanceEventSchema>
export const fleetInstanceHealthSchema = z.object({
  ok: z.literal(true),
  appVersion: z.string(),
  protocol: z.literal(FLEET_PROTOCOL_VERSION),
  ready: z.boolean(),
  capabilities: fleetFeaturesSchema,
  /** A workspaces environment with chat turns running; its scheduled update waits. Absent when unknown. */
  busy: z.boolean().optional(),
})
export type FleetInstanceHealth = z.infer<typeof fleetInstanceHealthSchema>
export const fleetInstanceHoldRequestSchema = z.object({ reason: z.enum(['takeover', 'paused']) })
export type FleetInstanceHoldRequest = z.infer<typeof fleetInstanceHoldRequestSchema>
export const fleetInstanceReleaseRequestSchema = z.object({
  note: fleetNoteSchema.nullable(),
  durationMs: z.number().finite().nonnegative().nullable(),
  continue: z.boolean(),
})
export type FleetInstanceReleaseRequest = z.infer<typeof fleetInstanceReleaseRequestSchema>

export type FleetRoute = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body: z.ZodType | null
  response: z.ZodType | null
}

export const FLEET_GATEWAY_ROUTES = {
  settingsAccounts: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/accounts',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.accounts.response,
  },
  settingsPatchAccount: {
    method: 'PATCH',
    path: '/v1/environments/:eid/settings/accounts/:providerId',
    body: FLEET_SETTINGS_OPERATIONS.patchAccount.input,
    response: FLEET_SETTINGS_OPERATIONS.patchAccount.response,
  },
  settingsRenameSubscription: {
    method: 'PATCH',
    path: '/v1/environments/:eid/settings/subscriptions/:kind/:slot',
    body: FLEET_SETTINGS_OPERATIONS.renameSubscription.input,
    response: FLEET_SETTINGS_OPERATIONS.renameSubscription.response,
  },
  settingsRemoveAccount: {
    method: 'DELETE',
    path: '/v1/environments/:eid/settings/accounts/:providerId',
    body: FLEET_SETTINGS_OPERATIONS.removeAccount.input,
    response: FLEET_SETTINGS_OPERATIONS.removeAccount.response,
  },
  settingsRemoveSubscription: {
    method: 'DELETE',
    path: '/v1/environments/:eid/settings/subscriptions/:kind/:slot',
    body: FLEET_SETTINGS_OPERATIONS.removeSubscription.input,
    response: FLEET_SETTINGS_OPERATIONS.removeSubscription.response,
  },
  settingsModels: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/models',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.models.response,
  },
  settingsSetModelFilter: {
    method: 'PUT',
    path: '/v1/environments/:eid/settings/models/:providerId/filter',
    body: FLEET_SETTINGS_OPERATIONS.setModelFilter.input,
    response: FLEET_SETTINGS_OPERATIONS.setModelFilter.response,
  },
  settingsSkills: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/skills',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.skills.response,
  },
  settingsSkill: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/skills/:name',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.skill.response,
  },
  settingsCreateSkill: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/skills',
    body: FLEET_SETTINGS_OPERATIONS.createSkill.input,
    response: FLEET_SETTINGS_OPERATIONS.createSkill.response,
  },
  settingsWriteSkill: {
    method: 'PUT',
    path: '/v1/environments/:eid/settings/skills/:name',
    body: FLEET_SETTINGS_OPERATIONS.writeSkill.input,
    response: FLEET_SETTINGS_OPERATIONS.writeSkill.response,
  },
  settingsSetSkillEnabled: {
    method: 'PATCH',
    path: '/v1/environments/:eid/settings/skills/:name',
    body: FLEET_SETTINGS_OPERATIONS.setSkillEnabled.input,
    response: FLEET_SETTINGS_OPERATIONS.setSkillEnabled.response,
  },
  settingsRemoveSkill: {
    method: 'DELETE',
    path: '/v1/environments/:eid/settings/skills/:name',
    body: FLEET_SETTINGS_OPERATIONS.removeSkill.input,
    response: FLEET_SETTINGS_OPERATIONS.removeSkill.response,
  },
  settingsSearchSkills: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/skill-library/search',
    body: FLEET_SETTINGS_OPERATIONS.searchSkills.input,
    response: FLEET_SETTINGS_OPERATIONS.searchSkills.response,
  },
  settingsInstallSkill: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/skill-library/install',
    body: FLEET_SETTINGS_OPERATIONS.installSkill.input,
    response: FLEET_SETTINGS_OPERATIONS.installSkill.response,
  },
  settingsSkillGroups: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/skill-groups',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.skillGroups.response,
  },
  settingsCreateSkillGroup: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/skill-groups',
    body: FLEET_SETTINGS_OPERATIONS.createSkillGroup.input,
    response: FLEET_SETTINGS_OPERATIONS.createSkillGroup.response,
  },
  settingsUpdateSkillGroup: {
    method: 'PUT',
    path: '/v1/environments/:eid/settings/skill-groups/:id',
    body: FLEET_SETTINGS_OPERATIONS.updateSkillGroup.input,
    response: FLEET_SETTINGS_OPERATIONS.updateSkillGroup.response,
  },
  settingsRemoveSkillGroup: {
    method: 'DELETE',
    path: '/v1/environments/:eid/settings/skill-groups/:id',
    body: FLEET_SETTINGS_OPERATIONS.removeSkillGroup.input,
    response: FLEET_SETTINGS_OPERATIONS.removeSkillGroup.response,
  },
  settingsMcpServers: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/mcp-servers',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.mcpServers.response,
  },
  settingsMcpServer: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/mcp-servers/:id',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.mcpServer.response,
  },
  settingsCreateMcpServer: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/mcp-servers',
    body: FLEET_SETTINGS_OPERATIONS.createMcpServer.input,
    response: FLEET_SETTINGS_OPERATIONS.createMcpServer.response,
  },
  settingsPatchMcpServer: {
    method: 'PATCH',
    path: '/v1/environments/:eid/settings/mcp-servers/:id',
    body: FLEET_SETTINGS_OPERATIONS.patchMcpServer.input,
    response: FLEET_SETTINGS_OPERATIONS.patchMcpServer.response,
  },
  settingsRemoveMcpServer: {
    method: 'DELETE',
    path: '/v1/environments/:eid/settings/mcp-servers/:id',
    body: FLEET_SETTINGS_OPERATIONS.removeMcpServer.input,
    response: FLEET_SETTINGS_OPERATIONS.removeMcpServer.response,
  },
  settingsTestMcpServer: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/mcp-servers/:id/test',
    body: FLEET_SETTINGS_OPERATIONS.testMcpServer.input,
    response: FLEET_SETTINGS_OPERATIONS.testMcpServer.response,
  },
  settingsRuntimes: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/runtimes',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.runtimes.response,
  },
  settingsRuntimeAction: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/runtimes/:id/actions',
    body: FLEET_SETTINGS_OPERATIONS.runtimeAction.input,
    response: FLEET_SETTINGS_OPERATIONS.runtimeAction.response,
  },
  settingsSetRuntimeAutomatic: {
    method: 'PUT',
    path: '/v1/environments/:eid/settings/runtimes/:id/automatic',
    body: FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.input,
    response: FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.response,
  },
  settingsPreferences: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/preferences',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.preferences.response,
  },
  settingsSetPreferences: {
    method: 'PUT',
    path: '/v1/environments/:eid/settings/preferences',
    body: FLEET_SETTINGS_OPERATIONS.setPreferences.input,
    response: FLEET_SETTINGS_OPERATIONS.setPreferences.response,
  },
  settingsPlugins: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/plugins',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.plugins.response,
  },
  settingsPluginCatalog: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/plugin-sources/:marketplaceId/plugins',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.pluginCatalog.response,
  },
  settingsPluginInspect: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/plugin-sources/:marketplaceId/plugins/:name',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.pluginInspect.response,
  },
  settingsPluginLogo: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/plugin-sources/:marketplaceId/plugins/:name/logo',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.pluginLogo.response,
  },
  settingsAddPluginSource: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/plugin-sources',
    body: FLEET_SETTINGS_OPERATIONS.addPluginSource.input,
    response: FLEET_SETTINGS_OPERATIONS.addPluginSource.response,
  },
  settingsRefreshPluginSource: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/plugin-sources/:marketplaceId/refresh',
    body: FLEET_SETTINGS_OPERATIONS.refreshPluginSource.input,
    response: FLEET_SETTINGS_OPERATIONS.refreshPluginSource.response,
  },
  settingsRemovePluginSource: {
    method: 'DELETE',
    path: '/v1/environments/:eid/settings/plugin-sources/:marketplaceId',
    body: FLEET_SETTINGS_OPERATIONS.removePluginSource.input,
    response: FLEET_SETTINGS_OPERATIONS.removePluginSource.response,
  },
  settingsInstallPlugin: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/plugins',
    body: FLEET_SETTINGS_OPERATIONS.installPlugin.input,
    response: FLEET_SETTINGS_OPERATIONS.installPlugin.response,
  },
  settingsBringPlugin: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/plugins/bring',
    body: FLEET_SETTINGS_OPERATIONS.bringPlugin.input,
    response: FLEET_SETTINGS_OPERATIONS.bringPlugin.response,
  },
  settingsUpdatePlugin: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/plugins/:key/update',
    body: FLEET_SETTINGS_OPERATIONS.updatePlugin.input,
    response: FLEET_SETTINGS_OPERATIONS.updatePlugin.response,
  },
  settingsPatchPlugin: {
    method: 'PATCH',
    path: '/v1/environments/:eid/settings/plugins/:key',
    body: FLEET_SETTINGS_OPERATIONS.patchPlugin.input,
    response: FLEET_SETTINGS_OPERATIONS.patchPlugin.response,
  },
  settingsUninstallPlugin: {
    method: 'DELETE',
    path: '/v1/environments/:eid/settings/plugins/:key',
    body: FLEET_SETTINGS_OPERATIONS.uninstallPlugin.input,
    response: FLEET_SETTINGS_OPERATIONS.uninstallPlugin.response,
  },
  settingsPluginSkills: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/plugin-skills',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.pluginSkills.response,
  },
  settingsSetPluginSkillEnabled: {
    method: 'PATCH',
    path: '/v1/environments/:eid/settings/plugin-skills/:name',
    body: FLEET_SETTINGS_OPERATIONS.setPluginSkillEnabled.input,
    response: FLEET_SETTINGS_OPERATIONS.setPluginSkillEnabled.response,
  },
  settingsMcpOAuthStatuses: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/mcp-oauth',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.mcpOAuthStatuses.response,
  },
  settingsMcpOAuthDescriptor: {
    method: 'POST',
    path: '/v1/environments/:eid/settings/mcp-oauth/:id/descriptor',
    body: FLEET_SETTINGS_OPERATIONS.mcpOAuthDescriptor.input,
    response: FLEET_SETTINGS_OPERATIONS.mcpOAuthDescriptor.response,
  },
  settingsSetMcpOAuth: {
    method: 'PUT',
    path: '/v1/environments/:eid/settings/mcp-oauth/:id',
    body: FLEET_SETTINGS_OPERATIONS.setMcpOAuth.input,
    response: FLEET_SETTINGS_OPERATIONS.setMcpOAuth.response,
  },
  settingsRemoveMcpOAuth: {
    method: 'DELETE',
    path: '/v1/environments/:eid/settings/mcp-oauth/:id',
    body: FLEET_SETTINGS_OPERATIONS.removeMcpOAuth.input,
    response: FLEET_SETTINGS_OPERATIONS.removeMcpOAuth.response,
  },
  settingsPatchMcpOAuthAccount: {
    method: 'PATCH',
    path: '/v1/environments/:eid/settings/mcp-oauth/:id/accounts/:accountId',
    body: FLEET_SETTINGS_OPERATIONS.patchMcpOAuthAccount.input,
    response: FLEET_SETTINGS_OPERATIONS.patchMcpOAuthAccount.response,
  },
  settingsSetMcpOAuthClient: {
    method: 'PUT',
    path: '/v1/environments/:eid/settings/mcp-oauth/:id/client',
    body: FLEET_SETTINGS_OPERATIONS.setMcpOAuthClient.input,
    response: FLEET_SETTINGS_OPERATIONS.setMcpOAuthClient.response,
  },
  settingsFailover: {
    method: 'GET',
    path: '/v1/environments/:eid/settings/failover',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.failover.response,
  },
  settingsSetFailoverRoute: {
    method: 'PUT',
    path: '/v1/environments/:eid/settings/failover/:kind/:slot',
    body: FLEET_SETTINGS_OPERATIONS.setFailoverRoute.input,
    response: FLEET_SETTINGS_OPERATIONS.setFailoverRoute.response,
  },
  artifactHost: { method: 'GET', path: '/v1/artifacts/host', body: null, response: fleetArtifactHostSchema },
  artifactHostPatch: {
    method: 'PATCH',
    path: '/v1/artifacts/host',
    body: fleetArtifactSettingsPatchSchema,
    response: fleetArtifactHostSchema,
  },
  artifactAdmin: {
    method: 'POST',
    path: '/v1/artifacts/admin',
    body: fleetArtifactCallSchema,
    response: fleetArtifactResultSchema,
  },
  artifactUpload: {
    method: 'POST',
    path: '/v1/artifacts/upload',
    body: fleetArtifactCallSchema,
    response: fleetArtifactResultSchema,
  },
  ownerMemoryList: { method: 'GET', path: '/v1/owner-memory', body: null, response: fleetOwnerMemorySchema },
  ownerMemoryCreate: {
    method: 'POST',
    path: '/v1/owner-memory',
    body: fleetOwnerMemoryCreateRequestSchema,
    response: fleetOwnerMemoryEntrySchema,
  },
  ownerMemoryPatch: {
    method: 'PATCH',
    path: '/v1/owner-memory/:mid',
    body: fleetOwnerMemoryPatchRequestSchema,
    response: fleetOwnerMemoryEntrySchema,
  },
  ownerMemoryDelete: { method: 'DELETE', path: '/v1/owner-memory/:mid', body: null, response: null },
  botRoutineRuns: {
    method: 'GET',
    path: '/v1/bots/:id/routines/:rid/runs',
    body: null,
    response: fleetRoutineRunsResponseSchema,
  },
  botMemoriesList: {
    method: 'GET',
    path: '/v1/bots/:id/memories',
    body: null,
    response: fleetBotMemoriesResponseSchema,
  },
  botMemoryPatch: {
    method: 'PATCH',
    path: '/v1/bots/:id/memories/:mid',
    body: fleetBotMemoryPatchRequestSchema,
    response: fleetBotMemorySchema,
  },
  botMemoryDelete: { method: 'DELETE', path: '/v1/bots/:id/memories/:mid', body: null, response: null },

  meta: { method: 'GET', path: '/v1/meta', body: null, response: fleetMetaResponseSchema },
  pair: { method: 'POST', path: '/v1/pair', body: fleetPairRequestSchema, response: fleetPairResponseSchema },
  /** A paired device creates a one-use code for another device; the CLI `pair` command is the other way. */
  pairingsCreate: {
    method: 'POST',
    path: '/v1/pairings',
    body: z.object({}).strict(),
    response: fleetPairingCodeResponseSchema,
  },
  devicesSelfDelete: { method: 'DELETE', path: '/v1/devices/self', body: null, response: null },
  /** The devices still paired, oldest first (`devices` feature). */
  devicesList: { method: 'GET', path: '/v1/devices', body: null, response: fleetDevicesResponseSchema },
  /** Removes another paired device, as the CLI's `devices revoke`; a device unpairs itself with `devicesSelfDelete`. */
  deviceRevoke: { method: 'POST', path: '/v1/devices/:deviceId/revoke', body: null, response: null },
  host: { method: 'GET', path: '/v1/host', body: null, response: fleetHostInfoSchema },
  botsList: { method: 'GET', path: '/v1/bots', body: null, response: fleetBotsResponseSchema },
  botsCreate: { method: 'POST', path: '/v1/bots', body: fleetCreateBotRequestSchema, response: fleetBotSchema },
  botGet: { method: 'GET', path: '/v1/bots/:id', body: null, response: fleetBotSchema },
  botPatch: { method: 'PATCH', path: '/v1/bots/:id', body: fleetPatchBotRequestSchema, response: fleetBotSchema },
  botStart: { method: 'POST', path: '/v1/bots/:id/start', body: null, response: fleetBotSchema },
  botStop: { method: 'POST', path: '/v1/bots/:id/stop', body: null, response: fleetBotSchema },
  botRestart: { method: 'POST', path: '/v1/bots/:id/restart', body: null, response: fleetBotSchema },
  botArchive: { method: 'POST', path: '/v1/bots/:id/archive', body: null, response: fleetBotSchema },
  /** `bot-move`: starts the bot's move and answers at once; its progress arrives in the bot's `move`. */
  botMove: { method: 'POST', path: '/v1/bots/:id/move', body: fleetBotMoveRequestSchema, response: fleetBotMoveSchema },
  /** The bot's last move, running or finished. */
  botMoveGet: { method: 'GET', path: '/v1/bots/:id/move', body: null, response: fleetBotMoveSchema },
  // A separate collection: `/v1/bots/archived` would collide with a bot whose id is `archived`.
  // `separateEnvironments=1` lists only individually archived bots. Older clients also see archived environments of one.
  archivedBotsList: {
    method: 'GET',
    path: '/v1/archived-bots',
    body: null,
    response: fleetArchivedBotsResponseSchema,
  },
  /** Recreates the container on the kept home volume; the bot comes back as `creating`. */
  archivedBotRestore: { method: 'POST', path: '/v1/archived-bots/:id/restore', body: null, response: fleetBotSchema },
  /** Irreversible: removes the home volume and every gateway record of the bot. */
  archivedBotDelete: { method: 'DELETE', path: '/v1/archived-bots/:id', body: null, response: null },
  botPause: { method: 'POST', path: '/v1/bots/:id/pause', body: null, response: fleetBotSchema },
  botResume: { method: 'POST', path: '/v1/bots/:id/resume', body: null, response: fleetBotSchema },
  botCancel: { method: 'POST', path: '/v1/bots/:id/cancel', body: null, response: null },
  botSelections: {
    method: 'GET',
    path: '/v1/bots/:id/selections',
    body: null,
    response: fleetSelectionsResponseSchema,
  },
  botApiKeyAccountAdd: {
    method: 'POST',
    path: '/v1/bots/:id/accounts/api-key',
    body: fleetAddApiKeyAccountRequestSchema,
    response: fleetAddApiKeyAccountResponseSchema,
  },
  botAccountsList: { method: 'GET', path: '/v1/bots/:id/accounts', body: null, response: fleetBotAccountsSchema },
  botAccountsImport: {
    method: 'POST',
    path: '/v1/bots/:id/accounts/import',
    body: fleetAccountImportRequestSchema,
    response: fleetImportResultsSchema,
  },
  botSubscriptionRemove: {
    method: 'DELETE',
    path: '/v1/bots/:id/subscriptions/:kind/:slot',
    body: null,
    response: null,
  },
  botLoginStart: {
    method: 'POST',
    path: '/v1/bots/:id/logins',
    body: fleetLoginStartRequestSchema,
    response: fleetLoginAttemptSchema,
  },
  botLoginGet: { method: 'GET', path: '/v1/bots/:id/logins/:lid', body: null, response: fleetLoginAttemptSchema },
  botLoginCallback: {
    method: 'POST',
    path: '/v1/bots/:id/logins/:lid/callback',
    body: fleetLoginCallbackRequestSchema,
    response: fleetLoginCallbackResponseSchema,
  },
  botLoginCode: {
    method: 'POST',
    path: '/v1/bots/:id/logins/:lid/code',
    body: fleetLoginCodeRequestSchema,
    response: fleetLoginAttemptSchema,
  },
  botLoginCancel: { method: 'DELETE', path: '/v1/bots/:id/logins/:lid', body: null, response: null },
  botSkillsList: { method: 'GET', path: '/v1/bots/:id/skills', body: null, response: fleetBotSkillsSchema },
  botSkillInstall: {
    method: 'POST',
    path: '/v1/bots/:id/skills',
    body: fleetSkillInstallRequestSchema,
    response: fleetSkillInstallResponseSchema,
  },
  botSkillRemove: { method: 'DELETE', path: '/v1/bots/:id/skills/:name', body: null, response: null },
  botMcpServersList: {
    method: 'GET',
    path: '/v1/bots/:id/mcp-servers',
    body: null,
    response: fleetBotMcpServersSchema,
  },
  botMcpServersImport: {
    method: 'POST',
    path: '/v1/bots/:id/mcp-servers/import',
    body: fleetMcpImportRequestSchema,
    response: fleetImportResultsSchema,
  },
  botMcpServerRemove: { method: 'DELETE', path: '/v1/bots/:id/mcp-servers/:sid', body: null, response: null },

  botAccountRemove: { method: 'DELETE', path: '/v1/bots/:id/accounts/:providerId', body: null, response: null },

  // Environments: one container whose accounts, skills, MCP servers and site logins its bots share. Archived
  // environments are a separate collection, like archived bots.
  environmentsList: { method: 'GET', path: '/v1/environments', body: null, response: fleetEnvironmentsResponseSchema },
  environmentsCreate: {
    method: 'POST',
    path: '/v1/environments',
    body: fleetCreateEnvironmentRequestSchema,
    response: fleetEnvironmentSchema,
  },
  environmentGet: { method: 'GET', path: '/v1/environments/:eid', body: null, response: fleetEnvironmentSchema },
  environmentPatch: {
    method: 'PATCH',
    path: '/v1/environments/:eid',
    body: fleetPatchEnvironmentRequestSchema,
    response: fleetEnvironmentSchema,
  },
  /** The models of the environment's accounts, for its default compaction model; `current` is always null. */
  environmentSelections: {
    method: 'GET',
    path: '/v1/environments/:eid/selections',
    body: null,
    response: fleetSelectionsResponseSchema,
  },
  environmentStart: {
    method: 'POST',
    path: '/v1/environments/:eid/start',
    body: null,
    response: fleetEnvironmentSchema,
  },
  environmentStop: { method: 'POST', path: '/v1/environments/:eid/stop', body: null, response: fleetEnvironmentSchema },
  environmentRestart: {
    method: 'POST',
    path: '/v1/environments/:eid/restart',
    body: null,
    response: fleetEnvironmentSchema,
  },
  /** Gateways with `environment-updates` only. */
  environmentUpdate: {
    method: 'POST',
    path: '/v1/environments/:eid/update',
    body: fleetEnvironmentUpdateRequestSchema,
    response: fleetEnvironmentSchema,
  },
  /** Cancels an update that waits for the environment's bots; gateways with `environment-updates` only. */
  environmentUpdateCancel: {
    method: 'DELETE',
    path: '/v1/environments/:eid/update',
    body: null,
    response: fleetEnvironmentSchema,
  },
  /** Asks the environment to check for Claude Code and Codex releases now; gateways with `runtime-updates` only. */
  environmentRuntimesCheck: {
    method: 'POST',
    path: '/v1/environments/:eid/runtimes/check',
    body: null,
    response: fleetEnvironmentSchema,
  },
  environmentArchive: {
    method: 'POST',
    path: '/v1/environments/:eid/archive',
    body: null,
    response: fleetEnvironmentSchema,
  },
  archivedEnvironmentsList: {
    method: 'GET',
    path: '/v1/archived-environments',
    body: null,
    response: fleetArchivedEnvironmentsResponseSchema,
  },
  archivedEnvironmentRestore: {
    method: 'POST',
    path: '/v1/archived-environments/:eid/restore',
    body: null,
    response: fleetEnvironmentSchema,
  },
  /** Irreversible: removes the home volume and every gateway record of the environment and its bots. */
  archivedEnvironmentDelete: { method: 'DELETE', path: '/v1/archived-environments/:eid', body: null, response: null },
  conversationScreenTicket: {
    method: 'POST',
    path: '/v1/environments/:eid/conversations/:cid/screen-tickets',
    body: fleetConversationScreenTicketRequestSchema,
    response: fleetScreenTicketResponseSchema,
  },
  environmentScreenTicket: {
    method: 'POST',
    path: '/v1/environments/:eid/screen-tickets',
    body: fleetEnvironmentScreenTicketRequestSchema,
    response: fleetScreenTicketResponseSchema,
  },
  environmentUiOpen: {
    method: 'POST',
    path: '/v1/environments/:eid/ui/open',
    body: fleetUiOpenRequestSchema,
    response: null,
  },
  // The environment's provisioning; the bot provisioning routes above act on the bot's environment.
  environmentApiKeyAccountAdd: {
    method: 'POST',
    path: '/v1/environments/:eid/accounts/api-key',
    body: fleetAddApiKeyAccountRequestSchema,
    response: fleetAddApiKeyAccountResponseSchema,
  },
  environmentAccountRemove: {
    method: 'DELETE',
    path: '/v1/environments/:eid/accounts/:providerId',
    body: null,
    response: null,
  },
  environmentAccountsList: {
    method: 'GET',
    path: '/v1/environments/:eid/accounts',
    body: null,
    response: fleetBotAccountsSchema,
  },
  environmentAccountsImport: {
    method: 'POST',
    path: '/v1/environments/:eid/accounts/import',
    body: fleetAccountImportRequestSchema,
    response: fleetImportResultsSchema,
  },
  environmentSubscriptionRemove: {
    method: 'DELETE',
    path: '/v1/environments/:eid/subscriptions/:kind/:slot',
    body: null,
    response: null,
  },
  environmentLoginStart: {
    method: 'POST',
    path: '/v1/environments/:eid/logins',
    body: fleetLoginStartRequestSchema,
    response: fleetLoginAttemptSchema,
  },
  environmentLoginGet: {
    method: 'GET',
    path: '/v1/environments/:eid/logins/:lid',
    body: null,
    response: fleetLoginAttemptSchema,
  },
  environmentLoginCallback: {
    method: 'POST',
    path: '/v1/environments/:eid/logins/:lid/callback',
    body: fleetLoginCallbackRequestSchema,
    response: fleetLoginCallbackResponseSchema,
  },
  environmentLoginCode: {
    method: 'POST',
    path: '/v1/environments/:eid/logins/:lid/code',
    body: fleetLoginCodeRequestSchema,
    response: fleetLoginAttemptSchema,
  },
  environmentLoginCancel: { method: 'DELETE', path: '/v1/environments/:eid/logins/:lid', body: null, response: null },
  environmentSkillsList: {
    method: 'GET',
    path: '/v1/environments/:eid/skills',
    body: null,
    response: fleetBotSkillsSchema,
  },
  environmentSkillInstall: {
    method: 'POST',
    path: '/v1/environments/:eid/skills',
    body: fleetSkillInstallRequestSchema,
    response: fleetSkillInstallResponseSchema,
  },
  environmentSkillRemove: { method: 'DELETE', path: '/v1/environments/:eid/skills/:name', body: null, response: null },
  environmentMcpServersList: {
    method: 'GET',
    path: '/v1/environments/:eid/mcp-servers',
    body: null,
    response: fleetBotMcpServersSchema,
  },
  environmentMcpServersImport: {
    method: 'POST',
    path: '/v1/environments/:eid/mcp-servers/import',
    body: fleetMcpImportRequestSchema,
    response: fleetImportResultsSchema,
  },
  environmentMcpServerRemove: {
    method: 'DELETE',
    path: '/v1/environments/:eid/mcp-servers/:sid',
    body: null,
    response: null,
  },

  botTranscript: { method: 'GET', path: '/v1/bots/:id/transcript', body: null, response: fleetTranscriptPageSchema },
  // Binary: the image bytes with their Content-Type (a FleetImageRef id from the transcript; `?run=<runId>` for one of
  // a routine run's conversation, `routine-conversations`).
  botImage: { method: 'GET', path: '/v1/bots/:id/images/:imageId', body: null, response: null },
  botFileMeta: { method: 'GET', path: '/v1/bots/:id/files/:fileId', body: null, response: fleetFileRefSchema },
  botFile: { method: 'GET', path: '/v1/bots/:id/files/:fileId/content', body: null, response: null },
  /** Feature `files-manage`. */
  botFilesList: { method: 'GET', path: '/v1/bots/:id/files', body: null, response: fleetFilesListSchema },
  botFilesDelete: {
    method: 'POST',
    path: '/v1/bots/:id/files/delete',
    body: fleetFilesDeleteRequestSchema,
    response: fleetFilesDeletedSchema,
  },
  botFileSettings: {
    method: 'PUT',
    path: '/v1/bots/:id/file-settings',
    body: fleetFileSettingsSchema,
    response: fleetFilesUsageSchema,
  },
  botMessageSend: {
    method: 'POST',
    path: '/v1/bots/:id/messages',
    body: fleetSendMessageRequestSchema,
    response: fleetInputReceiptSchema,
  },
  botMessageDelete: { method: 'DELETE', path: '/v1/bots/:id/messages/:inputId', body: null, response: null },
  /** Feature `message-edit`: the owner's last message only, while the bot is idle with nothing queued. */
  botMessageEdit: {
    method: 'POST',
    path: '/v1/bots/:id/messages/:inputId/edit',
    body: fleetEditMessageRequestSchema,
    response: fleetInputReceiptSchema,
  },
  botInteractionResolve: {
    method: 'POST',
    path: '/v1/bots/:id/interactions/:interactionId',
    body: fleetInteractionResolutionSchema,
    response: null,
  },
  botTakeover: { method: 'POST', path: '/v1/bots/:id/takeover', body: null, response: fleetTakeoverStateSchema },
  botTakeoverRelease: {
    method: 'POST',
    path: '/v1/bots/:id/takeover/release',
    body: fleetTakeoverReleaseRequestSchema,
    response: fleetTakeoverStateSchema,
  },
  botScreenTicket: {
    method: 'POST',
    path: '/v1/bots/:id/screen-tickets',
    body: fleetScreenTicketRequestSchema,
    response: fleetScreenTicketResponseSchema,
  },
  screen: { method: 'GET', path: '/v1/screen', body: null, response: null },
  devicePushGet: {
    method: 'GET',
    path: '/v1/devices/self/push',
    body: null,
    response: z.object({ registration: fleetPushRegistrationSchema.nullable() }),
  },
  devicePushSet: {
    method: 'PUT',
    path: '/v1/devices/self/push',
    body: fleetPushRegistrationRequestSchema,
    response: fleetPushRegistrationSchema,
  },
  devicePushDelete: { method: 'DELETE', path: '/v1/devices/self/push', body: null, response: null },
  /** Sends this phone a test notification. */
  devicePushTest: {
    method: 'POST',
    path: '/v1/devices/self/push/test',
    body: z.object({}).strict(),
    response: z.object({ sent: z.literal(true) }),
  },
  // The server's speech-to-text key and the phones' dictation through it (`dictation`).
  dictationGet: { method: 'GET', path: '/v1/dictation', body: null, response: fleetDictationStatusSchema },
  dictationKeySet: {
    method: 'PUT',
    path: '/v1/dictation',
    body: fleetDictationKeyRequestSchema,
    response: fleetDictationKeyResponseSchema,
  },
  dictationKeyDelete: { method: 'DELETE', path: '/v1/dictation', body: null, response: null },
  dictationTranscribe: {
    method: 'POST',
    path: '/v1/dictation/transcriptions',
    body: fleetDictationTranscribeRequestSchema,
    response: fleetDictationTranscribeResponseSchema,
  },
  environmentBridgeTicket: {
    method: 'POST',
    path: '/v1/environments/:eid/bridge-tickets',
    body: fleetBridgeTicketRequestSchema,
    response: fleetBridgeTicketResponseSchema,
  },
  /** The bridge itself: a WebSocket upgrade with a ticket, passed through to the workspaces environment. */
  bridge: { method: 'GET', path: '/v1/bridge', body: null, response: null },
  // Passed through to the workspaces host untouched: the instance route of the same key defines bodies and answers.
  hostFileStat: { method: 'POST', path: '/v1/environments/:eid/host-files/stat', body: null, response: null },
  hostFileContent: { method: 'GET', path: '/v1/environments/:eid/host-files/content', body: null, response: null },
  hostFileDigest: { method: 'POST', path: '/v1/environments/:eid/host-files/digest', body: null, response: null },
  hostFileUploadBegin: { method: 'POST', path: '/v1/environments/:eid/host-files/uploads', body: null, response: null },
  hostFileUploadChunk: {
    method: 'PUT',
    path: '/v1/environments/:eid/host-files/uploads/:uploadId',
    body: null,
    response: null,
  },
  hostFileUploadCommit: {
    method: 'POST',
    path: '/v1/environments/:eid/host-files/uploads/:uploadId/commit',
    body: null,
    response: null,
  },
  hostFileUploadAbort: {
    method: 'DELETE',
    path: '/v1/environments/:eid/host-files/uploads/:uploadId',
    body: null,
    response: null,
  },
  hostFileArchiveBegin: {
    method: 'POST',
    path: '/v1/environments/:eid/host-files/archives',
    body: null,
    response: null,
  },
  hostFileArchiveStatus: {
    method: 'GET',
    path: '/v1/environments/:eid/host-files/archives/:archiveId',
    body: null,
    response: null,
  },
  hostFileArchiveRelease: {
    method: 'DELETE',
    path: '/v1/environments/:eid/host-files/archives/:archiveId',
    body: null,
    response: null,
  },
  botUiOpen: { method: 'POST', path: '/v1/bots/:id/ui/open', body: fleetUiOpenRequestSchema, response: null },
  botConversationCall: {
    method: 'POST',
    path: '/v1/bots/:id/conversation/call',
    body: fleetConversationCallRequestSchema,
    response: fleetConversationCallResponseSchema,
  },
  botRoutinesList: { method: 'GET', path: '/v1/bots/:id/routines', body: null, response: fleetRoutinesResponseSchema },
  botRoutinesCreate: {
    method: 'POST',
    path: '/v1/bots/:id/routines',
    body: fleetCreateRoutineRequestSchema,
    response: fleetRoutineSchema,
  },
  botRoutinePatch: {
    method: 'PATCH',
    path: '/v1/bots/:id/routines/:rid',
    body: fleetPatchRoutineRequestSchema,
    response: fleetRoutineSchema,
  },
  botRoutineDelete: { method: 'DELETE', path: '/v1/bots/:id/routines/:rid', body: null, response: null },
  botRoutineRun: { method: 'POST', path: '/v1/bots/:id/routines/:rid/run', body: null, response: fleetRoutineSchema },
  // Gateways with `routine-conversations`: every run of a bot, newest first (`?before=<runId>&limit=&routineId=`), and
  // one run's record, conversation, messages and the bot's settings for keeping them.
  botRuns: { method: 'GET', path: '/v1/bots/:id/routine-runs', body: null, response: fleetRoutineRunPageSchema },
  botRunGet: { method: 'GET', path: '/v1/bots/:id/routine-runs/:runId', body: null, response: fleetRoutineRunSchema },
  botRunPatch: {
    method: 'PATCH',
    path: '/v1/bots/:id/routine-runs/:runId',
    body: fleetRoutineRunPatchRequestSchema,
    response: fleetRoutineRunSchema,
  },
  /** Deletes the run's conversation; its report and its files stay. */
  botRunConversationDelete: {
    method: 'DELETE',
    path: '/v1/bots/:id/routine-runs/:runId/conversation',
    body: null,
    response: fleetRoutineRunSchema,
  },
  botRunTranscript: {
    method: 'GET',
    path: '/v1/bots/:id/routine-runs/:runId/transcript',
    body: null,
    response: fleetTranscriptPageSchema,
  },
  /** An owner's message in the run's conversation, which the bot answers there with what the run did. */
  botRunMessageSend: {
    method: 'POST',
    path: '/v1/bots/:id/routine-runs/:runId/messages',
    body: fleetSendMessageRequestSchema,
    response: fleetInputReceiptSchema,
  },
  botRunSettings: {
    method: 'PUT',
    path: '/v1/bots/:id/routine-run-settings',
    body: fleetRoutineRunSettingsSchema,
    response: fleetRoutineRunSettingsSchema,
  },
  // Gateways with `peer-conversations`: a bot's threads with other bots, each one's conversation and messages, and the
  // bot's settings for keeping them.
  botPeerThreads: { method: 'GET', path: '/v1/bots/:id/peer-threads', body: null, response: fleetPeerThreadListSchema },
  botPeerThreadGet: {
    method: 'GET',
    path: '/v1/bots/:id/peer-threads/:threadId',
    body: null,
    response: fleetPeerThreadSchema,
  },
  botPeerThreadPatch: {
    method: 'PATCH',
    path: '/v1/bots/:id/peer-threads/:threadId',
    body: fleetPeerThreadPatchRequestSchema,
    response: fleetPeerThreadSchema,
  },
  /** Deletes the bot's conversation of the thread; its files stay. */
  botPeerThreadConversationDelete: {
    method: 'DELETE',
    path: '/v1/bots/:id/peer-threads/:threadId/conversation',
    body: null,
    response: fleetPeerThreadSchema,
  },
  botPeerThreadTranscript: {
    method: 'GET',
    path: '/v1/bots/:id/peer-threads/:threadId/transcript',
    body: null,
    response: fleetTranscriptPageSchema,
  },
  /** An owner's message in the bot's conversation of the thread: the bots' messages in a row start again from it. */
  botPeerThreadMessageSend: {
    method: 'POST',
    path: '/v1/bots/:id/peer-threads/:threadId/messages',
    body: fleetSendMessageRequestSchema,
    response: fleetInputReceiptSchema,
  },
  botPeerThreadSettings: {
    method: 'PUT',
    path: '/v1/bots/:id/peer-thread-settings',
    body: fleetPeerThreadSettingsSchema,
    response: fleetPeerThreadSettingsSchema,
  },
  // Gateways with `desktop-bridge`: the Mac asking links or unlinks itself, lists every Mac linked to the bot, or
  // removes another Mac's link; and answers a call it received on its event stream.
  botDesktopLinkPut: {
    method: 'PUT',
    path: '/v1/bots/:id/desktop-link',
    body: fleetDesktopLinkRequestSchema,
    response: fleetDesktopLinkViewSchema,
  },
  botDesktopLinkDelete: { method: 'DELETE', path: '/v1/bots/:id/desktop-link', body: null, response: null },
  botDesktopLinks: {
    method: 'GET',
    path: '/v1/bots/:id/desktop-links',
    body: null,
    response: fleetDesktopLinksResponseSchema,
  },
  botDesktopLinkRemove: {
    method: 'DELETE',
    path: '/v1/bots/:id/desktop-links/:desktopId',
    body: null,
    response: null,
  },
  desktopCallResult: {
    method: 'POST',
    path: '/v1/desktop-calls/:callId/result',
    body: fleetDesktopCallResultSchema,
    response: null,
  },
  // Gateways with `runners`: a computer links or unlinks itself as a bot's runner, lists a bot's runners and jobs,
  // removes another computer's link or cancels a job; a runner reports its state and moves its own jobs on.
  botRunnerLinkPut: {
    method: 'PUT',
    path: '/v1/bots/:id/runner-link',
    body: fleetRunnerLinkRequestSchema,
    response: fleetRunnerLinkViewSchema,
  },
  botRunnerLinkDelete: { method: 'DELETE', path: '/v1/bots/:id/runner-link', body: null, response: null },
  botRunnerLinks: {
    method: 'GET',
    path: '/v1/bots/:id/runner-links',
    body: null,
    response: fleetRunnerLinksResponseSchema,
  },
  botRunnerLinkRemove: { method: 'DELETE', path: '/v1/bots/:id/runner-links/:runnerId', body: null, response: null },
  botRunnerJobs: {
    method: 'GET',
    path: '/v1/bots/:id/runner-jobs',
    body: null,
    response: fleetRunnerJobsResponseSchema,
  },
  botRunnerJobCancel: {
    method: 'POST',
    path: '/v1/bots/:id/runner-jobs/:jobId/cancel',
    body: null,
    response: fleetRunnerJobSchema,
  },
  // Read from the bot's environment as it is asked for; the gateway keeps none of it.
  botRunnerJobLogRead: {
    method: 'GET',
    path: '/v1/bots/:id/runner-jobs/:jobId/log',
    body: null,
    response: fleetRunnerJobLogPageSchema,
  },
  runnerState: {
    method: 'PUT',
    path: '/v1/runner/state',
    body: fleetRunnerStateRequestSchema,
    response: fleetRunnerStateResponseSchema,
  },
  runnerJobAccept: { method: 'POST', path: '/v1/runner-jobs/:jobId/accept', body: null, response: null },
  runnerJobProgress: {
    method: 'POST',
    path: '/v1/runner-jobs/:jobId/progress',
    body: fleetRunnerJobProgressRequestSchema,
    response: null,
  },
  runnerJobFinish: {
    method: 'POST',
    path: '/v1/runner-jobs/:jobId/finish',
    body: fleetRunnerJobFinishRequestSchema,
    response: null,
  },
  runnerJobUsage: {
    method: 'POST',
    path: '/v1/runner-jobs/:jobId/usage',
    body: fleetRunnerJobUsageRequestSchema,
    response: null,
  },
  // Streamed through to the job's environment as they are: the gateway checks only who sends and how much.
  runnerJobManifest: { method: 'GET', path: '/v1/runner-jobs/:jobId/manifest', body: null, response: null },
  runnerJobBlobs: { method: 'POST', path: '/v1/runner-jobs/:jobId/blobs', body: null, response: null },
  runnerJobLog: { method: 'POST', path: '/v1/runner-jobs/:jobId/log', body: null, response: null },
  runnerJobOutputs: { method: 'GET', path: '/v1/runner-jobs/:jobId/outputs', body: null, response: null },
  runnerJobOutputChunk: { method: 'PUT', path: '/v1/runner-jobs/:jobId/outputs/:offset', body: null, response: null },
  runnerJobOutputCommit: {
    method: 'POST',
    path: '/v1/runner-jobs/:jobId/outputs/commit',
    body: null,
    response: null,
  },
  inbox: { method: 'GET', path: '/v1/inbox', body: null, response: fleetInboxResponseSchema },
  peerMessages: { method: 'GET', path: '/v1/peer-messages', body: null, response: fleetPeerMessagesResponseSchema },
  activity: { method: 'GET', path: '/v1/activity', body: null, response: fleetActivityResponseSchema },
  events: { method: 'GET', path: '/v1/events', body: null, response: null },
} as const satisfies Record<string, FleetRoute>

export const FLEET_INTERNAL_ROUTES = {
  artifactBotAdmin: {
    method: 'POST',
    path: '/internal/v1/artifacts/admin',
    body: fleetArtifactCallSchema,
    response: fleetArtifactResultSchema,
  },
  artifactBotUpload: {
    method: 'POST',
    path: '/internal/v1/artifacts/upload',
    body: fleetArtifactCallSchema,
    response: fleetArtifactResultSchema,
  },
  ownerMemoryGet: { method: 'GET', path: '/internal/v1/owner-memory', body: null, response: fleetOwnerMemorySchema },
  ownerMemorySave: {
    method: 'POST',
    path: '/internal/v1/owner-memory',
    body: fleetInternalOwnerMemorySaveRequestSchema,
    response: fleetOwnerMemoryEntrySchema,
  },
  ownerMemoryForget: {
    method: 'POST',
    path: '/internal/v1/owner-memory/:mid/forget',
    body: fleetInternalOwnerMemoryForgetRequestSchema,
    response: fleetOwnerMemoryEntrySchema,
  },
  routineRunReport: {
    method: 'POST',
    path: '/internal/v1/routines/:rid/runs/:runId/report',
    body: fleetRoutineRunReportRequestSchema,
    response: fleetRoutineRunSchema,
  },

  peers: { method: 'GET', path: '/internal/v1/peers', body: null, response: fleetInternalPeersResponseSchema },
  peerMessageSend: {
    method: 'POST',
    path: '/internal/v1/peers/messages',
    body: fleetInternalPeerMessageRequestSchema,
    response: fleetInternalPeerMessageResponseSchema,
  },
  /** Gateways with `peer-conversations`: a thread's answer, for the owner's conversation of the bot that opened it. */
  peerThreadReport: {
    method: 'POST',
    path: '/internal/v1/peers/threads/:threadId/report',
    body: fleetInternalPeerThreadReportRequestSchema,
    response: fleetInternalPeerThreadReportResponseSchema,
  },
  routinesList: { method: 'GET', path: '/internal/v1/routines', body: null, response: fleetRoutinesResponseSchema },
  routineCreate: {
    method: 'POST',
    path: '/internal/v1/routines',
    body: fleetInternalRoutineCreateRequestSchema,
    response: fleetRoutineSchema,
  },
  routinePatch: {
    method: 'PATCH',
    path: '/internal/v1/routines/:rid',
    body: fleetInternalRoutinePatchRequestSchema,
    response: fleetRoutineSchema,
  },
  routineDelete: { method: 'DELETE', path: '/internal/v1/routines/:rid', body: null, response: null },
  /** Gateways with `routine-conversations`: the calling bot's runs (`?before=&limit=&routineId=`) and one run. */
  routineRunsList: {
    method: 'GET',
    path: '/internal/v1/routine-runs',
    body: null,
    response: fleetRoutineRunPageSchema,
  },
  routineRunGet: {
    method: 'GET',
    path: '/internal/v1/routine-runs/:runId',
    body: null,
    response: fleetRoutineRunSchema,
  },
  /** The Macs that linked the calling bot, and whether each is online. */
  desktops: { method: 'GET', path: '/internal/v1/desktops', body: null, response: fleetInternalDesktopsResponseSchema },
  /** One call for one of those Macs; answers once the Mac does, or with why it could not. */
  desktopCall: {
    method: 'POST',
    path: '/internal/v1/desktop/calls',
    body: fleetInternalDesktopCallRequestSchema,
    response: fleetDesktopCallResultSchema,
  },
  // Gateways with `host-desktop-calls`, for a workspaces host's own token only: the host lists the bots it linked,
  // and links or unlinks itself for one bot, as a Mac does with its device token.
  hostDesktopLinks: {
    method: 'GET',
    path: '/internal/v1/host/desktop-links',
    body: null,
    response: fleetHostDesktopLinksResponseSchema,
  },
  hostDesktopLinkPut: {
    method: 'PUT',
    path: '/internal/v1/host/bots/:id/desktop-link',
    body: fleetDesktopLinkRequestSchema,
    response: fleetHostDesktopLinkSchema,
  },
  hostDesktopLinkDelete: {
    method: 'DELETE',
    path: '/internal/v1/host/bots/:id/desktop-link',
    body: null,
    response: null,
  },
  // Gateways with `runners`, for a bot's token: the computers that run jobs for it, and its own jobs.
  runners: { method: 'GET', path: '/internal/v1/runners', body: null, response: fleetInternalRunnersResponseSchema },
  runnerJobCreate: {
    method: 'POST',
    path: '/internal/v1/runner-jobs',
    body: fleetInternalRunnerJobRequestSchema,
    response: fleetRunnerSubmitResultSchema,
  },
  runnerJobsList: {
    method: 'GET',
    path: '/internal/v1/runner-jobs',
    body: null,
    response: fleetRunnerJobsResponseSchema,
  },
  runnerJobGet: { method: 'GET', path: '/internal/v1/runner-jobs/:jobId', body: null, response: fleetRunnerJobSchema },
  runnerJobCancelOwn: {
    method: 'POST',
    path: '/internal/v1/runner-jobs/:jobId/cancel',
    body: null,
    response: fleetRunnerJobSchema,
  },
} as const satisfies Record<string, FleetRoute>

export const FLEET_INSTANCE_ROUTES = {
  settingsAccounts: {
    method: 'GET',
    path: '/v1/settings/accounts',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.accounts.response,
  },
  settingsPatchAccount: {
    method: 'PATCH',
    path: '/v1/settings/accounts/:providerId',
    body: FLEET_SETTINGS_OPERATIONS.patchAccount.input,
    response: FLEET_SETTINGS_OPERATIONS.patchAccount.response,
  },
  settingsRenameSubscription: {
    method: 'PATCH',
    path: '/v1/settings/subscriptions/:kind/:slot',
    body: FLEET_SETTINGS_OPERATIONS.renameSubscription.input,
    response: FLEET_SETTINGS_OPERATIONS.renameSubscription.response,
  },
  settingsRemoveAccount: {
    method: 'DELETE',
    path: '/v1/settings/accounts/:providerId',
    body: FLEET_SETTINGS_OPERATIONS.removeAccount.input,
    response: FLEET_SETTINGS_OPERATIONS.removeAccount.response,
  },
  settingsRemoveSubscription: {
    method: 'DELETE',
    path: '/v1/settings/subscriptions/:kind/:slot',
    body: FLEET_SETTINGS_OPERATIONS.removeSubscription.input,
    response: FLEET_SETTINGS_OPERATIONS.removeSubscription.response,
  },
  settingsModels: {
    method: 'GET',
    path: '/v1/settings/models',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.models.response,
  },
  settingsSetModelFilter: {
    method: 'PUT',
    path: '/v1/settings/models/:providerId/filter',
    body: FLEET_SETTINGS_OPERATIONS.setModelFilter.input,
    response: FLEET_SETTINGS_OPERATIONS.setModelFilter.response,
  },
  settingsSkills: {
    method: 'GET',
    path: '/v1/settings/skills',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.skills.response,
  },
  settingsSkill: {
    method: 'GET',
    path: '/v1/settings/skills/:name',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.skill.response,
  },
  settingsCreateSkill: {
    method: 'POST',
    path: '/v1/settings/skills',
    body: FLEET_SETTINGS_OPERATIONS.createSkill.input,
    response: FLEET_SETTINGS_OPERATIONS.createSkill.response,
  },
  settingsWriteSkill: {
    method: 'PUT',
    path: '/v1/settings/skills/:name',
    body: FLEET_SETTINGS_OPERATIONS.writeSkill.input,
    response: FLEET_SETTINGS_OPERATIONS.writeSkill.response,
  },
  settingsSetSkillEnabled: {
    method: 'PATCH',
    path: '/v1/settings/skills/:name',
    body: FLEET_SETTINGS_OPERATIONS.setSkillEnabled.input,
    response: FLEET_SETTINGS_OPERATIONS.setSkillEnabled.response,
  },
  settingsRemoveSkill: {
    method: 'DELETE',
    path: '/v1/settings/skills/:name',
    body: FLEET_SETTINGS_OPERATIONS.removeSkill.input,
    response: FLEET_SETTINGS_OPERATIONS.removeSkill.response,
  },
  settingsSearchSkills: {
    method: 'POST',
    path: '/v1/settings/skill-library/search',
    body: FLEET_SETTINGS_OPERATIONS.searchSkills.input,
    response: FLEET_SETTINGS_OPERATIONS.searchSkills.response,
  },
  settingsInstallSkill: {
    method: 'POST',
    path: '/v1/settings/skill-library/install',
    body: FLEET_SETTINGS_OPERATIONS.installSkill.input,
    response: FLEET_SETTINGS_OPERATIONS.installSkill.response,
  },
  settingsSkillGroups: {
    method: 'GET',
    path: '/v1/settings/skill-groups',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.skillGroups.response,
  },
  settingsCreateSkillGroup: {
    method: 'POST',
    path: '/v1/settings/skill-groups',
    body: FLEET_SETTINGS_OPERATIONS.createSkillGroup.input,
    response: FLEET_SETTINGS_OPERATIONS.createSkillGroup.response,
  },
  settingsUpdateSkillGroup: {
    method: 'PUT',
    path: '/v1/settings/skill-groups/:id',
    body: FLEET_SETTINGS_OPERATIONS.updateSkillGroup.input,
    response: FLEET_SETTINGS_OPERATIONS.updateSkillGroup.response,
  },
  settingsRemoveSkillGroup: {
    method: 'DELETE',
    path: '/v1/settings/skill-groups/:id',
    body: FLEET_SETTINGS_OPERATIONS.removeSkillGroup.input,
    response: FLEET_SETTINGS_OPERATIONS.removeSkillGroup.response,
  },
  settingsMcpServers: {
    method: 'GET',
    path: '/v1/settings/mcp-servers',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.mcpServers.response,
  },
  settingsMcpServer: {
    method: 'GET',
    path: '/v1/settings/mcp-servers/:id',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.mcpServer.response,
  },
  settingsCreateMcpServer: {
    method: 'POST',
    path: '/v1/settings/mcp-servers',
    body: FLEET_SETTINGS_OPERATIONS.createMcpServer.input,
    response: FLEET_SETTINGS_OPERATIONS.createMcpServer.response,
  },
  settingsPatchMcpServer: {
    method: 'PATCH',
    path: '/v1/settings/mcp-servers/:id',
    body: FLEET_SETTINGS_OPERATIONS.patchMcpServer.input,
    response: FLEET_SETTINGS_OPERATIONS.patchMcpServer.response,
  },
  settingsRemoveMcpServer: {
    method: 'DELETE',
    path: '/v1/settings/mcp-servers/:id',
    body: FLEET_SETTINGS_OPERATIONS.removeMcpServer.input,
    response: FLEET_SETTINGS_OPERATIONS.removeMcpServer.response,
  },
  settingsTestMcpServer: {
    method: 'POST',
    path: '/v1/settings/mcp-servers/:id/test',
    body: FLEET_SETTINGS_OPERATIONS.testMcpServer.input,
    response: FLEET_SETTINGS_OPERATIONS.testMcpServer.response,
  },
  settingsRuntimes: {
    method: 'GET',
    path: '/v1/settings/runtimes',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.runtimes.response,
  },
  settingsRuntimeAction: {
    method: 'POST',
    path: '/v1/settings/runtimes/:id/actions',
    body: FLEET_SETTINGS_OPERATIONS.runtimeAction.input,
    response: FLEET_SETTINGS_OPERATIONS.runtimeAction.response,
  },
  settingsSetRuntimeAutomatic: {
    method: 'PUT',
    path: '/v1/settings/runtimes/:id/automatic',
    body: FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.input,
    response: FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.response,
  },
  settingsPreferences: {
    method: 'GET',
    path: '/v1/settings/preferences',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.preferences.response,
  },
  settingsSetPreferences: {
    method: 'PUT',
    path: '/v1/settings/preferences',
    body: FLEET_SETTINGS_OPERATIONS.setPreferences.input,
    response: FLEET_SETTINGS_OPERATIONS.setPreferences.response,
  },
  settingsPlugins: {
    method: 'GET',
    path: '/v1/settings/plugins',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.plugins.response,
  },
  settingsPluginCatalog: {
    method: 'GET',
    path: '/v1/settings/plugin-sources/:marketplaceId/plugins',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.pluginCatalog.response,
  },
  settingsPluginInspect: {
    method: 'GET',
    path: '/v1/settings/plugin-sources/:marketplaceId/plugins/:name',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.pluginInspect.response,
  },
  settingsPluginLogo: {
    method: 'GET',
    path: '/v1/settings/plugin-sources/:marketplaceId/plugins/:name/logo',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.pluginLogo.response,
  },
  settingsAddPluginSource: {
    method: 'POST',
    path: '/v1/settings/plugin-sources',
    body: FLEET_SETTINGS_OPERATIONS.addPluginSource.input,
    response: FLEET_SETTINGS_OPERATIONS.addPluginSource.response,
  },
  settingsRefreshPluginSource: {
    method: 'POST',
    path: '/v1/settings/plugin-sources/:marketplaceId/refresh',
    body: FLEET_SETTINGS_OPERATIONS.refreshPluginSource.input,
    response: FLEET_SETTINGS_OPERATIONS.refreshPluginSource.response,
  },
  settingsRemovePluginSource: {
    method: 'DELETE',
    path: '/v1/settings/plugin-sources/:marketplaceId',
    body: FLEET_SETTINGS_OPERATIONS.removePluginSource.input,
    response: FLEET_SETTINGS_OPERATIONS.removePluginSource.response,
  },
  settingsInstallPlugin: {
    method: 'POST',
    path: '/v1/settings/plugins',
    body: FLEET_SETTINGS_OPERATIONS.installPlugin.input,
    response: FLEET_SETTINGS_OPERATIONS.installPlugin.response,
  },
  settingsBringPlugin: {
    method: 'POST',
    path: '/v1/settings/plugins/bring',
    body: FLEET_SETTINGS_OPERATIONS.bringPlugin.input,
    response: FLEET_SETTINGS_OPERATIONS.bringPlugin.response,
  },
  settingsUpdatePlugin: {
    method: 'POST',
    path: '/v1/settings/plugins/:key/update',
    body: FLEET_SETTINGS_OPERATIONS.updatePlugin.input,
    response: FLEET_SETTINGS_OPERATIONS.updatePlugin.response,
  },
  settingsPatchPlugin: {
    method: 'PATCH',
    path: '/v1/settings/plugins/:key',
    body: FLEET_SETTINGS_OPERATIONS.patchPlugin.input,
    response: FLEET_SETTINGS_OPERATIONS.patchPlugin.response,
  },
  settingsUninstallPlugin: {
    method: 'DELETE',
    path: '/v1/settings/plugins/:key',
    body: FLEET_SETTINGS_OPERATIONS.uninstallPlugin.input,
    response: FLEET_SETTINGS_OPERATIONS.uninstallPlugin.response,
  },
  settingsPluginSkills: {
    method: 'GET',
    path: '/v1/settings/plugin-skills',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.pluginSkills.response,
  },
  settingsSetPluginSkillEnabled: {
    method: 'PATCH',
    path: '/v1/settings/plugin-skills/:name',
    body: FLEET_SETTINGS_OPERATIONS.setPluginSkillEnabled.input,
    response: FLEET_SETTINGS_OPERATIONS.setPluginSkillEnabled.response,
  },
  settingsMcpOAuthStatuses: {
    method: 'GET',
    path: '/v1/settings/mcp-oauth',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.mcpOAuthStatuses.response,
  },
  settingsMcpOAuthDescriptor: {
    method: 'POST',
    path: '/v1/settings/mcp-oauth/:id/descriptor',
    body: FLEET_SETTINGS_OPERATIONS.mcpOAuthDescriptor.input,
    response: FLEET_SETTINGS_OPERATIONS.mcpOAuthDescriptor.response,
  },
  settingsSetMcpOAuth: {
    method: 'PUT',
    path: '/v1/settings/mcp-oauth/:id',
    body: FLEET_SETTINGS_OPERATIONS.setMcpOAuth.input,
    response: FLEET_SETTINGS_OPERATIONS.setMcpOAuth.response,
  },
  settingsRemoveMcpOAuth: {
    method: 'DELETE',
    path: '/v1/settings/mcp-oauth/:id',
    body: FLEET_SETTINGS_OPERATIONS.removeMcpOAuth.input,
    response: FLEET_SETTINGS_OPERATIONS.removeMcpOAuth.response,
  },
  settingsPatchMcpOAuthAccount: {
    method: 'PATCH',
    path: '/v1/settings/mcp-oauth/:id/accounts/:accountId',
    body: FLEET_SETTINGS_OPERATIONS.patchMcpOAuthAccount.input,
    response: FLEET_SETTINGS_OPERATIONS.patchMcpOAuthAccount.response,
  },
  settingsSetMcpOAuthClient: {
    method: 'PUT',
    path: '/v1/settings/mcp-oauth/:id/client',
    body: FLEET_SETTINGS_OPERATIONS.setMcpOAuthClient.input,
    response: FLEET_SETTINGS_OPERATIONS.setMcpOAuthClient.response,
  },
  settingsFailover: {
    method: 'GET',
    path: '/v1/settings/failover',
    body: null,
    response: FLEET_SETTINGS_OPERATIONS.failover.response,
  },
  settingsSetFailoverRoute: {
    method: 'PUT',
    path: '/v1/settings/failover/:kind/:slot',
    body: FLEET_SETTINGS_OPERATIONS.setFailoverRoute.input,
    response: FLEET_SETTINGS_OPERATIONS.setFailoverRoute.response,
  },
  memoriesList: { method: 'GET', path: '/v1/memories', body: null, response: fleetBotMemoriesResponseSchema },
  memoryPatch: {
    method: 'PATCH',
    path: '/v1/memories/:id',
    body: fleetBotMemoryPatchRequestSchema,
    response: fleetBotMemorySchema,
  },
  memoryDelete: { method: 'DELETE', path: '/v1/memories/:id', body: null, response: null },

  health: { method: 'GET', path: '/v1/health', body: null, response: fleetInstanceHealthSchema },
  status: { method: 'GET', path: '/v1/status', body: null, response: fleetInstanceStatusSchema },
  profile: {
    method: 'PUT',
    path: '/v1/profile',
    body: fleetInstanceProfileSchema,
    response: fleetInstanceStatusSchema,
  },
  selections: { method: 'GET', path: '/v1/selections', body: null, response: fleetSelectionsResponseSchema },
  apiKeyAccountAdd: {
    method: 'POST',
    path: '/v1/accounts/api-key',
    body: fleetAddApiKeyAccountRequestSchema,
    response: fleetAddApiKeyAccountResponseSchema,
  },
  accountsList: { method: 'GET', path: '/v1/accounts', body: null, response: fleetBotAccountsSchema },
  accountsImport: {
    method: 'POST',
    path: '/v1/accounts/import',
    body: fleetAccountImportRequestSchema,
    response: fleetImportResultsSchema,
  },
  subscriptionRemove: { method: 'DELETE', path: '/v1/subscriptions/:kind/:slot', body: null, response: null },
  loginStart: {
    method: 'POST',
    path: '/v1/logins',
    body: fleetLoginStartRequestSchema,
    response: fleetLoginAttemptSchema,
  },
  loginGet: { method: 'GET', path: '/v1/logins/:lid', body: null, response: fleetLoginAttemptSchema },
  loginCallback: {
    method: 'POST',
    path: '/v1/logins/:lid/callback',
    body: fleetLoginCallbackRequestSchema,
    response: fleetLoginCallbackResponseSchema,
  },
  loginCode: {
    method: 'POST',
    path: '/v1/logins/:lid/code',
    body: fleetLoginCodeRequestSchema,
    response: fleetLoginAttemptSchema,
  },
  loginCancel: { method: 'DELETE', path: '/v1/logins/:lid', body: null, response: null },
  skillsList: { method: 'GET', path: '/v1/skills', body: null, response: fleetBotSkillsSchema },
  skillInstall: {
    method: 'POST',
    path: '/v1/skills',
    body: fleetSkillInstallRequestSchema,
    response: fleetSkillInstallResponseSchema,
  },
  skillRemove: { method: 'DELETE', path: '/v1/skills/:name', body: null, response: null },
  mcpServersList: { method: 'GET', path: '/v1/mcp-servers', body: null, response: fleetBotMcpServersSchema },
  mcpServersImport: {
    method: 'POST',
    path: '/v1/mcp-servers/import',
    body: fleetMcpImportRequestSchema,
    response: fleetImportResultsSchema,
  },
  mcpServerRemove: { method: 'DELETE', path: '/v1/mcp-servers/:sid', body: null, response: null },
  accountRemove: { method: 'DELETE', path: '/v1/accounts/:providerId', body: null, response: null },
  transcript: { method: 'GET', path: '/v1/transcript', body: null, response: fleetTranscriptPageSchema },
  // Binary: the image bytes with their Content-Type.
  image: { method: 'GET', path: '/v1/images/:imageId', body: null, response: null },
  inputSend: { method: 'POST', path: '/v1/inputs', body: fleetInstanceInputSchema, response: fleetInputReceiptSchema },
  inputDelete: { method: 'DELETE', path: '/v1/inputs/:inputId', body: null, response: null },
  inputEdit: {
    method: 'POST',
    path: '/v1/inputs/:inputId/edit',
    body: fleetEditMessageRequestSchema,
    response: fleetInputReceiptSchema,
  },
  turnCancel: { method: 'POST', path: '/v1/turn/cancel', body: null, response: null },
  interactionResolve: {
    method: 'POST',
    path: '/v1/interactions/:id/resolve',
    body: fleetInteractionResolutionSchema,
    response: null,
  },
  hold: { method: 'POST', path: '/v1/hold', body: fleetInstanceHoldRequestSchema, response: fleetInstanceHoldSchema },
  holdRelease: {
    method: 'POST',
    path: '/v1/hold/release',
    body: fleetInstanceReleaseRequestSchema,
    response: fleetInstanceHoldSchema,
  },
  uiOpen: { method: 'POST', path: '/v1/ui/open', body: fleetUiOpenRequestSchema, response: null },
  conversationCall: {
    method: 'POST',
    path: '/v1/conversation/call',
    body: fleetConversationCallRequestSchema,
    response: fleetConversationCallResponseSchema,
  },
  events: { method: 'GET', path: '/v1/events', body: null, response: null },

  // An environment instance (capability `environments`) hosts several bots: their routes live under /v1/bots/:botId,
  // with the bodies and responses of the unprefixed routes above, which keep serving gateways without the capability.
  environmentStatus: {
    method: 'GET',
    path: '/v1/environment/status',
    body: null,
    response: fleetInstanceEnvironmentStatusSchema,
  },
  /** Capability `runtime-updates`: checks for Claude Code and Codex releases in the background. */
  runtimesCheck: { method: 'POST', path: '/v1/runtimes/check', body: null, response: fleetRuntimesCheckResponseSchema },
  /** Capability `environment-compaction`: the model options of the environment's accounts; `current` is null. */
  environmentSelections: {
    method: 'GET',
    path: '/v1/environment/selections',
    body: null,
    response: fleetSelectionsResponseSchema,
  },
  botInstall: {
    method: 'PUT',
    path: '/v1/bots/:botId',
    body: fleetInstanceBotInstallSchema,
    response: fleetInstanceStatusSchema,
  },
  /** `?purge=1` also deletes the bot's conversation, memory space and folders. */
  botUninstall: { method: 'DELETE', path: '/v1/bots/:botId', body: null, response: null },
  /**
   * Capability `bot-move`: uninstalls the bot and keeps its data as it is, for it to move; `botInstall` brings a frozen
   * bot back, as it does an archived one. Freezing a frozen bot again changes nothing.
   */
  botFreeze: { method: 'POST', path: '/v1/bots/:botId/freeze', body: null, response: fleetInstanceBotFreezeSchema },
  /**
   * Binary: a frozen bot's package (a zstd-compressed tar), with its SHA-256 in `X-Maestrly-Package-Sha256` and its
   * size in `Content-Length`.
   */
  botExport: { method: 'GET', path: '/v1/bots/:botId/export', body: null, response: null },
  /**
   * Binary body: a bot's package, with the same two headers. Imports the bot without installing it, in place of
   * whatever an earlier move left of it (`?replace=1`); a bot installed here is refused.
   */
  botImport: { method: 'PUT', path: '/v1/bots/:botId/import', body: null, response: fleetInstanceBotImportSchema },
  botStatus: { method: 'GET', path: '/v1/bots/:botId/status', body: null, response: fleetInstanceStatusSchema },
  botSelections: {
    method: 'GET',
    path: '/v1/bots/:botId/selections',
    body: null,
    response: fleetSelectionsResponseSchema,
  },
  botMemoriesList: {
    method: 'GET',
    path: '/v1/bots/:botId/memories',
    body: null,
    response: fleetBotMemoriesResponseSchema,
  },
  botMemoryPatch: {
    method: 'PATCH',
    path: '/v1/bots/:botId/memories/:id',
    body: fleetBotMemoryPatchRequestSchema,
    response: fleetBotMemorySchema,
  },
  botMemoryDelete: { method: 'DELETE', path: '/v1/bots/:botId/memories/:id', body: null, response: null },
  botTranscript: {
    method: 'GET',
    path: '/v1/bots/:botId/transcript',
    body: null,
    response: fleetTranscriptPageSchema,
  },
  /** Capability `routine-conversations`: a page of a routine run's own conversation. */
  botRunTranscript: {
    method: 'GET',
    path: '/v1/bots/:botId/runs/:runId/transcript',
    body: null,
    response: fleetTranscriptPageSchema,
  },
  /** Capability `routine-conversations`: deletes a run's conversation, keeping its images and attachments in files. */
  botRunDelete: {
    method: 'DELETE',
    path: '/v1/bots/:botId/runs/:runId',
    body: null,
    response: fleetInstanceRunDeletedSchema,
  },
  // Binary: the image bytes with their Content-Type (`?run=<runId>` for an image of a run's conversation).
  botImage: { method: 'GET', path: '/v1/bots/:botId/images/:imageId', body: null, response: null },
  botFileMeta: { method: 'GET', path: '/v1/bots/:botId/files/:fileId', body: null, response: fleetFileRefSchema },
  botFile: { method: 'GET', path: '/v1/bots/:botId/files/:fileId/content', body: null, response: null },
  /** Capability `files-manage`. */
  botFilesList: { method: 'GET', path: '/v1/bots/:botId/files', body: null, response: fleetFilesListSchema },
  botFilesDelete: {
    method: 'POST',
    path: '/v1/bots/:botId/files/delete',
    body: fleetFilesDeleteRequestSchema,
    response: fleetFilesDeletedSchema,
  },
  botFileSettings: {
    method: 'PUT',
    path: '/v1/bots/:botId/file-settings',
    body: fleetFileSettingsSchema,
    response: fleetFilesUsageSchema,
  },
  botInputSend: {
    method: 'POST',
    path: '/v1/bots/:botId/inputs',
    body: fleetInstanceInputSchema,
    response: fleetInputReceiptSchema,
  },
  botInputDelete: { method: 'DELETE', path: '/v1/bots/:botId/inputs/:inputId', body: null, response: null },
  /** Capability `message-edit`. */
  botInputEdit: {
    method: 'POST',
    path: '/v1/bots/:botId/inputs/:inputId/edit',
    body: fleetEditMessageRequestSchema,
    response: fleetInputReceiptSchema,
  },
  botTurnCancel: { method: 'POST', path: '/v1/bots/:botId/turn/cancel', body: null, response: null },
  botInteractionResolve: {
    method: 'POST',
    path: '/v1/bots/:botId/interactions/:id/resolve',
    body: fleetInteractionResolutionSchema,
    response: null,
  },
  botHold: {
    method: 'POST',
    path: '/v1/bots/:botId/hold',
    body: fleetInstanceHoldRequestSchema,
    response: fleetInstanceHoldSchema,
  },
  botHoldRelease: {
    method: 'POST',
    path: '/v1/bots/:botId/hold/release',
    body: fleetInstanceReleaseRequestSchema,
    response: fleetInstanceHoldSchema,
  },
  botConversationCall: {
    method: 'POST',
    path: '/v1/bots/:botId/conversation/call',
    body: fleetConversationCallRequestSchema,
    response: fleetConversationCallResponseSchema,
  },
  // Screen upgrades: a bot's browser area (its tile of the environment display) or its apps display (`:surface` is a
  // FleetScreenSurface), and the environment screen (tile 0).
  botScreenView: { method: 'GET', path: '/v1/bots/:botId/screen/:surface/view', body: null, response: null },
  botScreenControl: { method: 'GET', path: '/v1/bots/:botId/screen/:surface/control', body: null, response: null },
  environmentScreenView: { method: 'GET', path: '/v1/screen/environment/view', body: null, response: null },
  environmentScreenControl: { method: 'GET', path: '/v1/screen/environment/control', body: null, response: null },
  // A workspaces conversation's computer (`apps`) and its browser's tile (`browser`, view only).
  conversationScreenView: {
    method: 'GET',
    path: '/v1/conversations/:conversationId/screen/:surface/view',
    body: null,
    response: null,
  },
  conversationScreenControl: {
    method: 'GET',
    path: '/v1/conversations/:conversationId/screen/:surface/control',
    body: null,
    response: null,
  },
  // A workspaces host's files: content and chunks carry raw bytes, so their bodies and answers are not JSON.
  hostFileStat: {
    method: 'POST',
    path: '/v1/host-files/stat',
    body: fleetHostFileStatRequestSchema,
    response: fleetHostFileStatSchema,
  },
  hostFileContent: { method: 'GET', path: '/v1/host-files/content', body: null, response: null },
  hostFileDigest: {
    method: 'POST',
    path: '/v1/host-files/digest',
    body: fleetHostFileDigestRequestSchema,
    response: fleetHostFileDigestSchema,
  },
  hostFileUploadBegin: {
    method: 'POST',
    path: '/v1/host-files/uploads',
    body: fleetHostFileUploadBeginSchema,
    response: fleetHostFileUploadSchema,
  },
  hostFileUploadChunk: { method: 'PUT', path: '/v1/host-files/uploads/:uploadId', body: null, response: null },
  hostFileUploadCommit: {
    method: 'POST',
    path: '/v1/host-files/uploads/:uploadId/commit',
    body: fleetHostFileUploadCommitSchema,
    response: fleetHostFileUploadResultSchema,
  },
  hostFileUploadAbort: { method: 'DELETE', path: '/v1/host-files/uploads/:uploadId', body: null, response: null },
  // A folder moves as one archive: the host packs it here, and the download routes read the archive by its path.
  hostFileArchiveBegin: {
    method: 'POST',
    path: '/v1/host-files/archives',
    body: fleetHostFileArchiveRequestSchema,
    response: fleetHostFileArchiveBeginSchema,
  },
  hostFileArchiveStatus: {
    method: 'GET',
    path: '/v1/host-files/archives/:archiveId',
    body: null,
    response: fleetHostFileArchiveSchema,
  },
  hostFileArchiveRelease: {
    method: 'DELETE',
    path: '/v1/host-files/archives/:archiveId',
    body: null,
    response: null,
  },
  // A workspaces host with `host-desktop-calls`: the gateway posts it a bot's call and waits for its answer, and tells
  // it when the link of one of its bots changed without it, so it checks its own side.
  hostDesktopCall: {
    method: 'POST',
    path: '/v1/host/desktop-calls',
    body: fleetHostDesktopCallRequestSchema,
    response: fleetDesktopCallResultSchema,
  },
  hostDesktopLinksChanged: {
    method: 'POST',
    path: '/v1/host/desktop-links/changed',
    body: fleetHostDesktopLinksChangedSchema,
    response: null,
  },
  // Environments with `runner-jobs`: the gateway tells a bot's environment where its jobs stand, and passes a runner's
  // requests for a job's files to it as they are.
  botRunnerJobState: {
    method: 'POST',
    path: '/v1/bots/:botId/runner-jobs/:jobId/state',
    body: fleetInstanceRunnerJobStateSchema,
    response: null,
  },
  botRunnerJobManifest: {
    method: 'GET',
    path: '/v1/bots/:botId/runner-jobs/:jobId/manifest',
    body: null,
    response: null,
  },
  botRunnerJobBlobs: {
    method: 'POST',
    path: '/v1/bots/:botId/runner-jobs/:jobId/blobs',
    body: fleetRunnerBlobsRequestSchema,
    response: null,
  },
  botRunnerJobLog: { method: 'POST', path: '/v1/bots/:botId/runner-jobs/:jobId/log', body: null, response: null },
  botRunnerJobLogRead: {
    method: 'GET',
    path: '/v1/bots/:botId/runner-jobs/:jobId/log',
    body: null,
    response: fleetRunnerJobLogPageSchema,
  },
  botRunnerJobOutputs: {
    method: 'GET',
    path: '/v1/bots/:botId/runner-jobs/:jobId/outputs',
    body: null,
    response: fleetRunnerOutputStatusSchema,
  },
  botRunnerJobOutputChunk: {
    method: 'PUT',
    path: '/v1/bots/:botId/runner-jobs/:jobId/outputs/:offset',
    body: null,
    response: null,
  },
  botRunnerJobOutputCommit: {
    method: 'POST',
    path: '/v1/bots/:botId/runner-jobs/:jobId/outputs/commit',
    body: fleetRunnerOutputCommitSchema,
    response: null,
  },
} as const satisfies Record<string, FleetRoute>

/** The routes that move a workspaces host's files; each gateway route passes through to the instance route. */
export const FLEET_HOST_FILE_ROUTE_KEYS = [
  'hostFileStat',
  'hostFileContent',
  'hostFileDigest',
  'hostFileUploadBegin',
  'hostFileUploadChunk',
  'hostFileUploadCommit',
  'hostFileUploadAbort',
  'hostFileArchiveBegin',
  'hostFileArchiveStatus',
  'hostFileArchiveRelease',
] as const
export type FleetHostFileRouteKey = (typeof FLEET_HOST_FILE_ROUTE_KEYS)[number]
/** The host-file routes that only an environment with `FLEET_HOST_FILES_FOLDERS_FEATURE` serves. */
export const FLEET_HOST_FILE_FOLDER_ROUTE_KEYS = [
  'hostFileArchiveBegin',
  'hostFileArchiveStatus',
  'hostFileArchiveRelease',
] as const satisfies readonly FleetHostFileRouteKey[]

export function buildPath(
  pattern: string,
  params: Record<string, string | number> = {},
  query?: Record<string, string | number | boolean | null | undefined>
): string {
  const path = pattern.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, key: string) => {
    const value = params[key]
    if (value === undefined) throw new Error('Missing path parameter: ' + key)
    return encodeURIComponent(String(value))
  })
  if (!query) return path
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) search.set(key, String(value))
  }
  const suffix = search.toString()
  return suffix ? path + '?' + suffix : path
}
