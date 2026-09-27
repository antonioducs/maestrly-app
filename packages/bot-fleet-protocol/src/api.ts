import { z } from 'zod'
import {
  FLEET_ENVIRONMENT_LIMITS,
  FLEET_PROVISIONING_LIMITS,
  FLEET_OWNER_MEMORY_LIMITS,
  FLEET_ROUTINE_RUN_LIMITS,
  FLEET_IMAGE_LIMITS,
  FLEET_MESSAGE_TEXT_MAX,
  FLEET_PROTOCOL_VERSION,
  FLEET_QUEUE_PREVIEW_MAX,
  FLEET_ROUTINE_PROMPT_MAX,
  FLEET_ROUTINE_TITLE_MAX,
} from './constants.js'
import {
  fleetOwnerMemoryOriginSchema,
  fleetOwnerMemorySchema,
  fleetOwnerMemoryEntrySchema,
  fleetRoutineRunSchema,
  fleetRoutineRunReportSchema,
  fleetRoutinePreviousRunSchema,
  fleetBotMemorySchema,
  fleetActivityEntrySchema,
  fleetArchivedBotSchema,
  fleetArchivedEnvironmentSchema,
  fleetBotIdSchema,
  fleetBotSchema,
  fleetBotStatusSchema,
  fleetCeilingSchema,
  fleetEnvironmentIdSchema,
  fleetEnvironmentSchema,
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
  fleetUsageSchema,
  fleetCompactionConfigSchema,
  fleetCompactionStateSchema,
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
export const fleetRoutineRunReportRequestSchema = fleetRoutineRunReportSchema
export const fleetBotMemoriesResponseSchema = z.object({ memories: z.array(fleetBotMemorySchema) })
export const fleetBotMemoryPatchRequestSchema = z
  .object({ pinned: z.boolean().optional(), status: z.enum(['active', 'archived']).optional() })
  .refine((value) => value.pinned !== undefined || value.status !== undefined, 'nothing to change')
export type FleetBotMemoryPatchRequest = z.infer<typeof fleetBotMemoryPatchRequestSchema>

/** Decoded size of a base64 string, without allocating. */
export function base64DecodedBytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.floor((value.length * 3) / 4) - padding
}

/** An image the owner attaches to a message, base64-encoded (the desktop composer's formats and limits). */
export const fleetAttachmentInputSchema = z.object({
  name: z.string().min(1).max(200),
  mediaType: fleetImageMediaTypeSchema,
  dataBase64: z
    .string()
    .min(4)
    .max(Math.ceil(FLEET_IMAGE_LIMITS.attachmentMaxBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
})
export type FleetAttachmentInput = z.infer<typeof fleetAttachmentInputSchema>

const fleetAttachmentsSchema = z
  .array(fleetAttachmentInputSchema)
  .max(FLEET_IMAGE_LIMITS.attachmentsMax)
  .default([])
  .refine(
    (items) =>
      items.reduce((sum, item) => sum + base64DecodedBytes(item.dataBase64), 0) <=
      FLEET_IMAGE_LIMITS.attachmentsTotalMaxBytes,
    'attachments exceed the total size limit'
  )
  .refine(
    (items) => items.every((item) => base64DecodedBytes(item.dataBase64) <= FLEET_IMAGE_LIMITS.attachmentMaxBytes),
    'an attachment exceeds the per-image size limit'
  )

/** A message needs text or at least one image. */
const hasContent = (value: { text: string; attachments: unknown[] }) =>
  value.text.trim().length > 0 || value.attachments.length > 0

export const fleetFeaturesSchema = z.array(z.string().max(40)).max(20).default([])

export const fleetMetaResponseSchema = z.object({
  protocol: z.literal(FLEET_PROTOCOL_VERSION),
  gatewayVersion: z.string(),
  botImage: z.string(),
  botImageVersion: z.string().nullable(),
  features: fleetFeaturesSchema,
})
export type FleetMetaResponse = z.infer<typeof fleetMetaResponseSchema>

export const fleetPairRequestSchema = z.object({
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/),
  deviceName: z.string().min(1),
})
export type FleetPairRequest = z.infer<typeof fleetPairRequestSchema>
export const fleetPairResponseSchema = z.object({ deviceId: fleetIdSchema, token: fleetIdSchema })
export type FleetPairResponse = z.infer<typeof fleetPairResponseSchema>

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
  idempotencyKey: fleetIdempotencyKeySchema,
})
export type FleetCreateEnvironmentRequest = z.infer<typeof fleetCreateEnvironmentRequestSchema>
export const fleetPatchEnvironmentRequestSchema = z
  .object({
    name: fleetNameSchema.optional(),
    /** Null goes back to the gateway's default limit. */
    memoryLimitBytes: fleetMemoryLimitSchema.nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.memoryLimitBytes !== undefined, 'nothing to change')
export type FleetPatchEnvironmentRequest = z.infer<typeof fleetPatchEnvironmentRequestSchema>
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
export const fleetPatchBotRequestSchema = z.object({
  name: fleetNameSchema.optional(),
  instructions: fleetInstructionsSchema.optional(),
  role: fleetRoleSchema.optional(),
  ceiling: fleetCeilingSchema.optional(),
  talksTo: z.array(fleetBotIdSchema).optional(),
  selection: fleetSelectionSchema.nullable().optional(),
  compaction: fleetCompactionConfigSchema.nullable().optional(),
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
export const fleetSubscriptionKindSchema = z.enum(['codex', 'claude', 'grok', 'github-copilot', 'cursor'])
export type FleetSubscriptionKind = z.infer<typeof fleetSubscriptionKindSchema>
export const fleetLoginKindSchema = z.enum(['codex', 'claude', 'grok'])
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
  })
  .refine(hasContent, 'a message needs text or an image')
export type FleetSendMessageRequest = z.infer<typeof fleetSendMessageRequestSchema>
export const fleetInputReceiptSchema = z.object({ inputId: fleetIdSchema, itemId: fleetIdSchema, queued: z.boolean() })
export type FleetInputReceipt = z.infer<typeof fleetInputReceiptSchema>
export const fleetTakeoverReleaseRequestSchema = z.object({ note: fleetNoteSchema.nullable(), continue: z.boolean() })
export type FleetTakeoverReleaseRequest = z.infer<typeof fleetTakeoverReleaseRequestSchema>
export const fleetScreenTicketRequestSchema = z.object({
  mode: z.enum(['view', 'control']),
  /** Older Macs only know the browser area. */
  surface: fleetScreenSurfaceSchema.default('browser'),
})
export type FleetScreenTicketRequest = z.infer<typeof fleetScreenTicketRequestSchema>
/** The environment screen shows only Maestrly's settings: control needs no takeover. */
export const fleetEnvironmentScreenTicketRequestSchema = z.object({ mode: z.enum(['view', 'control']) })
export type FleetEnvironmentScreenTicketRequest = z.infer<typeof fleetEnvironmentScreenTicketRequestSchema>
export const fleetScreenTicketResponseSchema = z.object({
  ticket: fleetIdSchema,
  path: z.string().startsWith('/v1/screen?ticket='),
  expiresAt: fleetTimestampSchema,
})
export type FleetScreenTicketResponse = z.infer<typeof fleetScreenTicketResponseSchema>
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
})
export type FleetInternalPeerMessageRequest = z.infer<typeof fleetInternalPeerMessageRequestSchema>
export const fleetInternalPeerMessageResponseSchema = z.object({ messageId: fleetIdSchema, delivered: z.boolean() })
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

export const fleetInputSourceSchema = z.enum(['owner', 'routine', 'peer', 'continuation'])
export type FleetInputSource = z.infer<typeof fleetInputSourceSchema>
export const fleetInstanceProfileSchema = z.object({
  botId: fleetBotIdSchema,
  name: fleetNameSchema,
  instructions: fleetInstructionsSchema,
  ceiling: fleetCeilingSchema,
  selection: fleetSelectionSchema.nullable(),
  compaction: fleetCompactionConfigSchema.nullable().default(null),
  gateway: z.object({ peersEnabled: z.boolean() }),
})
export type FleetInstanceProfile = z.infer<typeof fleetInstanceProfileSchema>
/** Installs or updates a bot in an environment instance: its profile, its display slot and its own gateway token. */
export const fleetInstanceBotInstallSchema = z.object({
  profile: fleetInstanceProfileSchema,
  slot: z.number().int().min(1).max(FLEET_ENVIRONMENT_LIMITS.botsMax),
  gatewayToken: z.string().min(16).max(200),
  /** Applied before queued work starts, including a pause recorded while the environment was stopped. */
  paused: z.boolean().optional(),
})
export type FleetInstanceBotInstall = z.infer<typeof fleetInstanceBotInstallSchema>
export const fleetInstanceHoldSchema = z.object({
  state: z.enum(['none', 'holding', 'held']),
  reason: z.enum(['takeover', 'paused']).nullable(),
  since: fleetTimestampSchema.nullable(),
  interruptedTurn: z.boolean(),
})
export type FleetInstanceHold = z.infer<typeof fleetInstanceHoldSchema>
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
  }),
  hold: fleetInstanceHoldSchema,
  queue: z.array(
    z.object({
      inputId: fleetIdSchema,
      source: fleetInputSourceSchema,
      preview: z.string().max(FLEET_QUEUE_PREVIEW_MAX),
    })
  ),
  activity: fleetActivitySchema.nullable(),
  pending: z.array(fleetPendingInteractionSchema),
  usage: fleetUsageSchema.nullable().default(null),
  /** Null from a bot that predates bot compaction: the gateway does not hold it in setup. */
  compaction: fleetCompactionStateSchema.nullable().default(null),
  lastEventSeq: fleetNonNegativeIntSchema,
})
export type FleetInstanceStatus = z.infer<typeof fleetInstanceStatusSchema>
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
  })
  .refine(hasContent, 'an input needs text or an image')
  .refine((value) => value.source === 'owner' || value.attachments.length === 0, 'only owner inputs carry images')
export type FleetInstanceInput = z.infer<typeof fleetInstanceInputSchema>
/** Every event names its bot; null from an instance that predates environments (it hosts a single bot). */
const instanceEventBase = {
  seq: fleetNonNegativeIntSchema,
  at: fleetTimestampSchema,
  botId: fleetBotIdSchema.nullable().default(null),
}
export const fleetInstanceEventSchema = z.discriminatedUnion('type', [
  z.object({ ...instanceEventBase, type: z.literal('status'), status: fleetInstanceStatusSchema }),
  z.object({ ...instanceEventBase, type: z.literal('transcript.upsert'), item: fleetTranscriptItemSchema }),
  z.object({
    ...instanceEventBase,
    type: z.literal('turn.finished'),
    inputId: z.string().nullable().default(null),
    text: z.string().max(FLEET_ROUTINE_RUN_LIMITS.finalTextMax).nullable().default(null),
    outcome: z.enum(['completed', 'cancelled', 'failed']),
    summary: z.string().nullable(),
  }),
  z.object({ ...instanceEventBase, type: z.literal('reset') }),
])
export type FleetInstanceEvent = z.infer<typeof fleetInstanceEventSchema>
export const fleetInstanceHealthSchema = z.object({
  ok: z.literal(true),
  appVersion: z.string(),
  protocol: z.literal(FLEET_PROTOCOL_VERSION),
  ready: z.boolean(),
  capabilities: fleetFeaturesSchema,
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
  devicesSelfDelete: { method: 'DELETE', path: '/v1/devices/self', body: null, response: null },
  host: { method: 'GET', path: '/v1/host', body: null, response: fleetHostInfoSchema },
  botsList: { method: 'GET', path: '/v1/bots', body: null, response: fleetBotsResponseSchema },
  botsCreate: { method: 'POST', path: '/v1/bots', body: fleetCreateBotRequestSchema, response: fleetBotSchema },
  botGet: { method: 'GET', path: '/v1/bots/:id', body: null, response: fleetBotSchema },
  botPatch: { method: 'PATCH', path: '/v1/bots/:id', body: fleetPatchBotRequestSchema, response: fleetBotSchema },
  botStart: { method: 'POST', path: '/v1/bots/:id/start', body: null, response: fleetBotSchema },
  botStop: { method: 'POST', path: '/v1/bots/:id/stop', body: null, response: fleetBotSchema },
  botRestart: { method: 'POST', path: '/v1/bots/:id/restart', body: null, response: fleetBotSchema },
  botArchive: { method: 'POST', path: '/v1/bots/:id/archive', body: null, response: fleetBotSchema },
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
  // Binary: the image bytes with their Content-Type (a FleetImageRef id from the transcript).
  botImage: { method: 'GET', path: '/v1/bots/:id/images/:imageId', body: null, response: null },
  botMessageSend: {
    method: 'POST',
    path: '/v1/bots/:id/messages',
    body: fleetSendMessageRequestSchema,
    response: fleetInputReceiptSchema,
  },
  botMessageDelete: { method: 'DELETE', path: '/v1/bots/:id/messages/:inputId', body: null, response: null },
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
  inbox: { method: 'GET', path: '/v1/inbox', body: null, response: fleetInboxResponseSchema },
  peerMessages: { method: 'GET', path: '/v1/peer-messages', body: null, response: fleetPeerMessagesResponseSchema },
  activity: { method: 'GET', path: '/v1/activity', body: null, response: fleetActivityResponseSchema },
  events: { method: 'GET', path: '/v1/events', body: null, response: null },
} as const satisfies Record<string, FleetRoute>

export const FLEET_INTERNAL_ROUTES = {
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
} as const satisfies Record<string, FleetRoute>

export const FLEET_INSTANCE_ROUTES = {
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
  screenView: { method: 'GET', path: '/v1/screen/view', body: null, response: null },
  screenControl: { method: 'GET', path: '/v1/screen/control', body: null, response: null },

  // An environment instance (capability `environments`) hosts several bots: their routes live under /v1/bots/:botId,
  // with the bodies and responses of the unprefixed routes above, which keep serving gateways without the capability.
  environmentStatus: {
    method: 'GET',
    path: '/v1/environment/status',
    body: null,
    response: fleetInstanceEnvironmentStatusSchema,
  },
  botInstall: {
    method: 'PUT',
    path: '/v1/bots/:botId',
    body: fleetInstanceBotInstallSchema,
    response: fleetInstanceStatusSchema,
  },
  /** `?purge=1` also deletes the bot's conversation, memory space and folders. */
  botUninstall: { method: 'DELETE', path: '/v1/bots/:botId', body: null, response: null },
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
  // Binary: the image bytes with their Content-Type.
  botImage: { method: 'GET', path: '/v1/bots/:botId/images/:imageId', body: null, response: null },
  botInputSend: {
    method: 'POST',
    path: '/v1/bots/:botId/inputs',
    body: fleetInstanceInputSchema,
    response: fleetInputReceiptSchema,
  },
  botInputDelete: { method: 'DELETE', path: '/v1/bots/:botId/inputs/:inputId', body: null, response: null },
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
} as const satisfies Record<string, FleetRoute>

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
