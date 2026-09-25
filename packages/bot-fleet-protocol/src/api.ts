import { z } from 'zod'
import {
  FLEET_IMAGE_LIMITS,
  FLEET_MESSAGE_TEXT_MAX,
  FLEET_PROTOCOL_VERSION,
  FLEET_QUEUE_PREVIEW_MAX,
  FLEET_ROUTINE_PROMPT_MAX,
  FLEET_ROUTINE_TITLE_MAX,
} from './constants.js'
import {
  fleetActivityEntrySchema,
  fleetArchivedBotSchema,
  fleetBotIdSchema,
  fleetBotSchema,
  fleetBotStatusSchema,
  fleetCeilingSchema,
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

export const fleetMetaResponseSchema = z.object({
  protocol: z.literal(FLEET_PROTOCOL_VERSION),
  gatewayVersion: z.string(),
  botImage: z.string(),
  botImageVersion: z.string().nullable(),
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
export const fleetCreateBotRequestSchema = z.object({
  name: fleetNameSchema,
  instructions: fleetInstructionsSchema,
  ceiling: fleetCeilingSchema,
  talksTo: z.array(fleetBotIdSchema),
  idempotencyKey: fleetIdempotencyKeySchema,
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
export const fleetScreenTicketRequestSchema = z.object({ mode: z.enum(['view', 'control']) })
export type FleetScreenTicketRequest = z.infer<typeof fleetScreenTicketRequestSchema>
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
export const fleetInstanceHoldSchema = z.object({
  state: z.enum(['none', 'holding', 'held']),
  reason: z.enum(['takeover', 'paused']).nullable(),
  since: fleetTimestampSchema.nullable(),
  interruptedTurn: z.boolean(),
})
export type FleetInstanceHold = z.infer<typeof fleetInstanceHoldSchema>
export const fleetInstanceStatusSchema = z.object({
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
export const fleetInstanceInputSchema = z
  .object({
    idempotencyKey: fleetIdempotencyKeySchema,
    text: z.string().max(FLEET_MESSAGE_TEXT_MAX),
    source: fleetInputSourceSchema,
    routine: z.object({ id: fleetIdSchema, title: z.string() }).optional(),
    peer: z.object({ botId: fleetBotIdSchema, name: fleetNameSchema }).optional(),
    // Only owner messages carry images.
    attachments: fleetAttachmentsSchema,
  })
  .refine(hasContent, 'an input needs text or an image')
  .refine((value) => value.source === 'owner' || value.attachments.length === 0, 'only owner inputs carry images')
export type FleetInstanceInput = z.infer<typeof fleetInstanceInputSchema>
export const fleetInstanceEventSchema = z.discriminatedUnion('type', [
  z.object({
    seq: fleetNonNegativeIntSchema,
    at: fleetTimestampSchema,
    type: z.literal('status'),
    status: fleetInstanceStatusSchema,
  }),
  z.object({
    seq: fleetNonNegativeIntSchema,
    at: fleetTimestampSchema,
    type: z.literal('transcript.upsert'),
    item: fleetTranscriptItemSchema,
  }),
  z.object({
    seq: fleetNonNegativeIntSchema,
    at: fleetTimestampSchema,
    type: z.literal('turn.finished'),
    outcome: z.enum(['completed', 'cancelled', 'failed']),
    summary: z.string().nullable(),
  }),
  z.object({ seq: fleetNonNegativeIntSchema, at: fleetTimestampSchema, type: z.literal('reset') }),
])
export type FleetInstanceEvent = z.infer<typeof fleetInstanceEventSchema>
export const fleetInstanceHealthSchema = z.object({
  ok: z.literal(true),
  appVersion: z.string(),
  protocol: z.literal(FLEET_PROTOCOL_VERSION),
  ready: z.boolean(),
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
  botAccountRemove: { method: 'DELETE', path: '/v1/bots/:id/accounts/:providerId', body: null, response: null },
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
