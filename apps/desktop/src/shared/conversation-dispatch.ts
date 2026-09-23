import { z } from 'zod'

/**
 * Conversation dispatch: persistent Standard conversations started from another conversation, either by
 * handing off an approved plan or by an explicit natural-language request. Shared by main, preload and the
 * renderer; privileged validation stays in main.
 */

/** Hard bound per call. Larger explicit requests are dispatched in several batches. */
export const CONVERSATION_DISPATCH_MAX_BATCH = 20
export const CONVERSATION_DISPATCH_MAX_TITLE = 120
export const CONVERSATION_DISPATCH_MAX_PROMPT = 60_000
export const CONVERSATION_DISPATCH_MAX_REQUEST_KEY = 120

/** `shared` attaches to the source checkout; `worktree` allocates a new branch/worktree for the task. */
export type ConversationDispatchPlacement = 'shared' | 'worktree'

export const conversationDispatchPlacementSchema = z.enum(['shared', 'worktree'])

/** Fully resolved execution settings applied to a destination before its first turn. */
export interface ConversationDispatchSettings {
  providerId: string
  modelId: string
  /** 'off' means provider default; any other value must be supported by the model. */
  reasoning: string
  fastMode: boolean
}

const identifier = z.string().trim().min(1).max(300)
const effort = z.string().trim().min(1).max(40)

export const conversationDispatchSettingsSchema = z
  .object({
    providerId: identifier,
    modelId: identifier,
    reasoning: effort,
    fastMode: z.boolean(),
  })
  .strict()

/** Requested settings; omitted fields inherit compatible source settings. */
export const conversationDispatchSettingsRequestSchema = z
  .object({
    providerId: identifier
      .optional()
      .describe('Canonical provider/account id from list_conversation_models. Required when a model is ambiguous.'),
    modelId: identifier.optional().describe('Canonical model id from list_conversation_models.'),
    reasoning: effort
      .optional()
      .describe('Effort exactly as stated by the person ("off" = provider default). Must be supported by the model.'),
    fastMode: z.boolean().optional().describe('Fast/priority mode on or off. Only when the person asked for it.'),
  })
  .strict()

export type ConversationDispatchSettingsRequest = z.infer<typeof conversationDispatchSettingsRequestSchema>

export const conversationDispatchSourceRefSchema = z
  .object({
    label: z.string().trim().min(1).max(200).describe('Short reference such as the card key and title.'),
    url: z.string().trim().url().max(2000).optional().describe('Link to the source item, when known.'),
  })
  .strict()

export type ConversationDispatchSourceRef = z.infer<typeof conversationDispatchSourceRefSchema>

export const conversationDispatchTaskSchema = z
  .object({
    requestKey: z
      .string()
      .trim()
      .min(1)
      .max(CONVERSATION_DISPATCH_MAX_REQUEST_KEY)
      .regex(/^[\w.:/#@-]+$/, 'Use letters, digits and . : / # @ - _ only.')
      .describe('Stable key for this task (e.g. the card key). Reusing it replays instead of duplicating.'),
    title: z
      .string()
      .trim()
      .min(1)
      .max(CONVERSATION_DISPATCH_MAX_TITLE)
      .describe('Short conversation name, e.g. "PROJ-12 · Add export button".'),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(CONVERSATION_DISPATCH_MAX_PROMPT)
      .describe('Self-contained task: goal, context already gathered, acceptance criteria, constraints.'),
    source: conversationDispatchSourceRefSchema.optional(),
    settings: conversationDispatchSettingsRequestSchema
      .optional()
      .describe('Per-task overrides of the batch defaults.'),
    placement: conversationDispatchPlacementSchema.optional().describe('Overrides the batch placement.'),
  })
  .strict()

export type ConversationDispatchTask = z.infer<typeof conversationDispatchTaskSchema>

export const conversationDispatchBatchSchema = z
  .object({
    tasks: z
      .array(conversationDispatchTaskSchema)
      .min(1)
      .max(CONVERSATION_DISPATCH_MAX_BATCH)
      .describe(`One entry per conversation (at most ${CONVERSATION_DISPATCH_MAX_BATCH} per call).`),
    defaults: conversationDispatchSettingsRequestSchema
      .optional()
      .describe('Settings shared by every task; omitted fields inherit from this conversation.'),
    placement: conversationDispatchPlacementSchema
      .optional()
      .describe('"worktree" (default): own branch per task from the current commit. "shared": this checkout.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    value.tasks.forEach((task, index) => {
      if (seen.has(task.requestKey))
        ctx.addIssue({ code: 'custom', path: ['tasks', index, 'requestKey'], message: 'Duplicate requestKey.' })
      seen.add(task.requestKey)
    })
  })

export type ConversationDispatchBatch = z.infer<typeof conversationDispatchBatchSchema>

/** Standard destination chosen in the Plan panel. */
export const standardPlanHandoffSchema = z
  .object({
    settings: conversationDispatchSettingsSchema,
    placement: conversationDispatchPlacementSchema,
  })
  .strict()

export type StandardPlanHandoff = z.infer<typeof standardPlanHandoffSchema>

/**
 * Durable lifecycle. `reserved`/`allocating` own no started work; `prepared` owns an unstarted
 * destination; `starting` is uncertain until reconciled against persisted turn state.
 */
export type ConversationDispatchPhase =
  | 'reserved'
  | 'allocating'
  | 'prepared'
  | 'starting'
  | 'started'
  | 'start-failed'
  | 'recovery'
  | 'discarded'
  | 'deleted'

export type ConversationDispatchItemStatus = 'started' | 'start-failed' | 'failed' | 'skipped'

/** Per-task outcome returned to the tool and the renderer card. */
export interface ConversationDispatchItemResult {
  requestKey: string
  title: string
  status: ConversationDispatchItemStatus
  /** Present once a destination exists, including when its first turn could not start. */
  conversationId?: string
  conversationName?: string
  placement?: ConversationDispatchPlacement
  branch?: string
  settings?: ConversationDispatchSettings
  /** Settings the caller did not specify and that were inherited or reset for compatibility. */
  inherited?: string[]
  /** Replay of a destination already recorded for the same request. */
  replayed?: boolean
  error?: string
}

export interface ConversationDispatchBatchResult {
  ok: boolean
  error?: string
  items: ConversationDispatchItemResult[]
  notes?: string[]
}

/** Model catalog entry exposed to the agent for natural-language selection. */
export interface ConversationDispatchModelOption {
  providerId: string
  providerLabel: string
  modelId: string
  reasoningEfforts: string[]
  fastMode: boolean
}

/** Stable fingerprint input for a task: any change in content under the same request key is a conflict. */
export function conversationDispatchFingerprintInput(input: {
  title: string
  prompt: string
  placement: ConversationDispatchPlacement
  settings: ConversationDispatchSettingsRequest | ConversationDispatchSettings
  source?: ConversationDispatchSourceRef
}): string {
  const settings = input.settings
  return JSON.stringify([
    input.title.trim(),
    input.prompt.trim(),
    input.placement,
    settings.providerId ?? null,
    settings.modelId ?? null,
    settings.reasoning ?? null,
    settings.fastMode ?? null,
    input.source?.label ?? null,
    input.source?.url ?? null,
  ])
}

/** Branch-safe slug for isolated task worktrees. */
export function conversationDispatchBranchSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'task'
}

const ITEM_STATUSES = new Set<ConversationDispatchItemStatus>(['started', 'start-failed', 'failed', 'skipped'])

/** Parse the JSON output of start_conversations for display; null when it is not a recognizable result. */
export function parseConversationDispatchBatchResult(text: string): ConversationDispatchBatchResult | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.ok !== 'boolean' || !Array.isArray(record.items)) return null
  const items = record.items.flatMap((raw): ConversationDispatchItemResult[] => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    if (typeof item.requestKey !== 'string' || typeof item.title !== 'string') return []
    if (!ITEM_STATUSES.has(item.status as ConversationDispatchItemStatus)) return []
    const text = (key: string) => (typeof item[key] === 'string' ? (item[key] as string) : undefined)
    return [
      {
        requestKey: item.requestKey,
        title: item.title,
        status: item.status as ConversationDispatchItemStatus,
        ...(text('conversationId') ? { conversationId: text('conversationId') } : {}),
        ...(text('conversationName') ? { conversationName: text('conversationName') } : {}),
        ...(item.placement === 'shared' || item.placement === 'worktree' ? { placement: item.placement } : {}),
        ...(text('branch') ? { branch: text('branch') } : {}),
        ...(text('error') ? { error: text('error') } : {}),
        ...(item.replayed === true ? { replayed: true } : {}),
        ...(item.settings && typeof item.settings === 'object'
          ? { settings: item.settings as ConversationDispatchSettings }
          : {}),
      },
    ]
  })
  return {
    ok: record.ok,
    items,
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(Array.isArray(record.notes)
      ? { notes: record.notes.filter((note): note is string => typeof note === 'string') }
      : {}),
  }
}
