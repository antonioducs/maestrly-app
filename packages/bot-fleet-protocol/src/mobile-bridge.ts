import { z } from 'zod'
import {
  fleetCeilingSchema,
  fleetSelectionOptionSchema,
  fleetTimestampSchema,
  fleetTranscriptItemSchema,
  fleetUserTranscriptItemSchema,
} from './domain.js'

/**
 * The mobile API of a workspaces host: what a phone reaches over the bridge (see `FLEET_GATEWAY_ROUTES.bridge`). A
 * computer's bridge runs the host's own IPC handlers and needs the exact same app version; a phone, released through
 * stores on its own schedule, speaks only these versioned channels instead. Chat messages reach it as the transcript
 * items bots use (`fleetTranscriptItemSchema`), so one conversation view serves both.
 */
export const MOBILE_API_VERSION = 1
/** The bridge's frame protocol, the same for computers and phones. */
export const MOBILE_BRIDGE_PROTOCOL = 1

export const MOBILE_BRIDGE_LIMITS = {
  /** A phone sends attachments as base64 inside one frame. */
  maxFrameBytes: 64 * 1024 * 1024,
  /** The host pings every 15 s; a phone that hears nothing for longer than this reconnects. */
  silenceMs: 45_000,
  welcomeTimeoutMs: 10_000,
  invokeTimeoutMs: 30_000,
  pageSize: 40,
  /** Send requests a host remembers per conversation, so that a phone resending after a reconnect sends once. */
  sendKeysKept: 200,
} as const

/** Why a host closed a bridge socket; 4002 before a welcome also means a host that predates phones. */
export const MOBILE_BRIDGE_CLOSE = { dead: 4001, badFrame: 4002, refused: 4003, slowClient: 4008 } as const

const id = z.string().min(1).max(200)
const name = z.string().max(400)

export const mobileConversationStatusSchema = z.enum(['idle', 'working', 'ready', 'waiting', 'asking', 'error'])
export type MobileConversationStatus = z.infer<typeof mobileConversationStatusSchema>
export const mobileExperienceSchema = z.enum(['standard', 'maestro'])
export type MobileExperience = z.infer<typeof mobileExperienceSchema>

/** A chat of the host: standalone (no workspace) or in one of its workspaces, on its own branch. */
export const mobileConversationSchema = z.object({
  id,
  name,
  workspaceId: id.nullable(),
  workspaceName: name.nullable(),
  branch: z.string().max(300).nullable(),
  status: mobileConversationStatusSchema,
  lastActivityAt: fleetTimestampSchema,
  pinned: z.boolean(),
  experience: mobileExperienceSchema,
})
export type MobileConversation = z.infer<typeof mobileConversationSchema>

export const mobileWorkspaceSchema = z.object({
  id,
  name,
  defaultBranch: z.string().max(300).nullable(),
  conversations: z.array(mobileConversationSchema),
})
export type MobileWorkspace = z.infer<typeof mobileWorkspaceSchema>

/**
 * The branches a new chat of a workspace can work on: local ones, and remote ones not checked out locally. A host that
 * predates it answers `unknown-channel`, and its chats start on a branch of their own from the default branch.
 */
export const mobileBranchesSchema = z.object({
  defaultBranch: z.string().max(300).nullable(),
  local: z.array(z.string().max(300)).max(2000),
  remote: z.array(z.object({ name: z.string().max(300), remote: z.string().max(200) })).max(2000),
})
export type MobileBranches = z.infer<typeof mobileBranchesSchema>

/** Where a new chat of a workspace works: a new branch (from `base`, else the default branch), or an existing one. */
export const mobileNewChatBranchSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('new'),
      /** Omitted: the host names it after the chat. */
      name: z.string().trim().min(1).max(300).optional(),
      base: z.string().trim().min(1).max(300).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('existing'), name: z.string().trim().min(1).max(300) }).strict(),
])
export type MobileNewChatBranch = z.infer<typeof mobileNewChatBranchSchema>

export const mobileListsSchema = z.object({
  workspaces: z.array(mobileWorkspaceSchema),
  chats: z.array(mobileConversationSchema),
})
export type MobileLists = z.infer<typeof mobileListsSchema>

/** Conversations an agent started from this one (`start_conversations`), each to open from the card. */
export const mobileDispatchItemSchema = z.object({
  kind: z.literal('dispatch'),
  id,
  at: fleetTimestampSchema,
  state: z.enum(['running', 'done', 'error']),
  conversations: z
    .array(
      z.object({
        conversationId: id.nullable(),
        title: name,
        status: z.enum(['started', 'start-failed', 'failed', 'skipped']),
        workspaceName: name.nullable(),
        error: z.string().max(1000).nullable(),
      })
    )
    .max(50),
})
export type MobileDispatchItem = z.infer<typeof mobileDispatchItemSchema>

/**
 * What the agent of another conversation sent this chat: a message, a report on the work it was given, or the result
 * of work it was asked for. It shows as a message of the person's, named after the conversation it came from.
 */
export const mobilePeerUserItemSchema = fleetUserTranscriptItemSchema.extend({
  fromConversation: z.object({
    conversationId: id,
    name,
    purpose: z.enum(['message', 'report', 'result']),
  }),
})
export type MobilePeerUserItem = z.infer<typeof mobilePeerUserItemSchema>

// A user item that names another conversation matches the first schema; any other, the transcript's.
export const mobileChatItemSchema = z.union([
  mobilePeerUserItemSchema,
  fleetTranscriptItemSchema,
  mobileDispatchItemSchema,
])
export type MobileChatItem = z.infer<typeof mobileChatItemSchema>

/** Items oldest first; `before` asks for the page before them, null at the start of the conversation. */
export const mobileChatPageSchema = z.object({ items: z.array(mobileChatItemSchema), before: z.string().nullable() })
export type MobileChatPage = z.infer<typeof mobileChatPageSchema>

/** A plan the agent wrote in Plan mode, waiting for a decision. */
export const mobilePlanSchema = z.object({
  version: z.number().int(),
  title: z.string().nullable(),
  text: z.string(),
  /** The version this one revises, to show what changed; null for a first version, absent from older hosts. */
  previousText: z.string().nullable().optional(),
})
export type MobilePlan = z.infer<typeof mobilePlanSchema>

/** A comment on one line of the plan (1-based), as the desktop's Plan tab leaves them. */
export const mobilePlanLineCommentSchema = z
  .object({ line: z.number().int().positive().max(100_000), text: z.string().trim().min(1).max(4000) })
  .strict()
export type MobilePlanLineComment = z.infer<typeof mobilePlanLineCommentSchema>

/** Where an approved plan is built when not in its own chat: a new Maestro chat, or a new standard one. */
export const mobilePlanImplementationSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('maestro'), profileId: z.string().trim().min(1).max(120) }).strict(),
  z
    .object({
      target: z.literal('standard'),
      settings: z
        .object({
          providerId: z.string().trim().min(1).max(300),
          modelId: z.string().trim().min(1).max(300),
          /** `off` uses the model's own default. */
          reasoning: z.string().trim().min(1).max(40),
          fastMode: z.boolean(),
        })
        .strict(),
      /** `shared` works in this chat's checkout; `worktree` on a branch of its own from the current commit. */
      placement: z.enum(['shared', 'worktree']),
    })
    .strict(),
])
export type MobilePlanImplementation = z.infer<typeof mobilePlanImplementationSchema>

/** A Maestro strategy the host offers to build a plan with. */
export const mobileMaestroProfileSchema = z.object({
  id: z.string().min(1).max(200),
  /** The app names `global` and `builtin` strategies itself (`strategy`); `custom` ones go by `name`. */
  source: z.enum(['global', 'builtin', 'custom']).catch('custom'),
  name,
  strategy: z.string().max(60),
  /** The model that orchestrates; null when the strategy has none, and then it cannot start. */
  orchestrator: z.object({ modelId: z.string().max(300), reasoning: z.string().max(40) }).nullable(),
  /** The labels of the Pool's enabled agents. */
  agents: z.array(name).max(100),
})
export type MobileMaestroProfile = z.infer<typeof mobileMaestroProfileSchema>

/** What a plan can be decided with on the host, beyond approving, revising and discarding it in its chat. */
export const mobilePlanOptionsSchema = z.object({
  /** A new standard chat of the workspace can build it; false for a chat with no workspace. */
  newConversation: z.boolean(),
  /** The strategies a new Maestro chat can build it with; null where Maestro cannot (no workspace, a Maestro chat). */
  maestro: z
    .object({ profiles: z.array(mobileMaestroProfileSchema).max(200), lastUsedId: z.string().max(200).nullable() })
    .nullable(),
  /**
   * A review on the computer holds the chat: the plan is decided there, once the review is handed off or discarded.
   * `ready`: it waits for the person's decisions; `checking`: the verifier checks what a review sent.
   */
  review: z
    .object({
      target: z.enum(['plan', 'code']).catch('code'),
      stage: z.enum(['running', 'ready', 'checking']).catch('running'),
    })
    .nullable(),
})
export type MobilePlanOptions = z.infer<typeof mobilePlanOptionsSchema>

export const mobileRuntimeSchema = z.object({
  streaming: z.boolean(),
  compacting: z.boolean(),
  plan: mobilePlanSchema.nullable(),
  context: z
    .object({
      usedTokens: z.number().int().nonnegative(),
      windowTokens: z.number().int().positive().nullable(),
      quality: z.enum(['measured', 'estimated']),
    })
    .nullable(),
})
export type MobileRuntime = z.infer<typeof mobileRuntimeSchema>

export const mobileChatModeSchema = z.enum(['agent', 'design', 'plan', 'ask'])
export type MobileChatMode = z.infer<typeof mobileChatModeSchema>
/** Same values and meaning as a bot's ceiling: ask, approve for me, full access. */
export const mobilePermModeSchema = fleetCeilingSchema
export type MobilePermMode = z.infer<typeof mobilePermModeSchema>
const modelRef = z.object({ providerId: id, modelId: id })

export const mobileChatSetupSchema = z.object({
  /** Null: the host's default model. */
  selection: modelRef.nullable(),
  /** `off` uses the model's own default. */
  reasoning: z.string().max(40),
  fastMode: z.boolean(),
  mode: mobileChatModeSchema,
  permMode: mobilePermModeSchema,
  experience: mobileExperienceSchema,
  /** What Ultra means for the selected model: the provider's own (`ultra`), or Maestrly's (`maestrly-ultra`). */
  ultra: z.enum(['native', 'maestrly']),
  tools: z.object({ app: z.boolean(), imageGen: z.boolean(), subagents: z.boolean() }),
  /** The selected model's context limit (set per model, for every chat that uses it); null with the default model. */
  contextLimit: z
    .object({
      limit: z.number().int().positive().nullable(),
      window: z.number().int().positive().nullable(),
      editable: z.boolean(),
    })
    .nullable(),
  mcp: z.array(z.object({ id, name, enabled: z.boolean() })),
  skills: z.array(
    z.object({
      name: z.string().max(200),
      description: z.string().max(2000),
      enabled: z.boolean(),
      override: z.enum(['on', 'off']).nullable(),
    })
  ),
})
export type MobileChatSetup = z.infer<typeof mobileChatSetupSchema>

export const mobileChatSetupPatchSchema = z
  .object({
    selection: modelRef.optional(),
    reasoning: z.string().min(1).max(40).optional(),
    fastMode: z.boolean().optional(),
    mode: mobileChatModeSchema.optional(),
    permMode: mobilePermModeSchema.optional(),
    mcp: z.object({ id, enabled: z.boolean() }).strict().optional(),
    skill: z
      .object({ name: z.string().min(1).max(200), state: z.enum(['on', 'off', 'inherit']) })
      .strict()
      .optional(),
    /** Every skill back to what the host enables by default. */
    skillsReset: z.literal(true).optional(),
    tools: z
      .object({ app: z.boolean().optional(), imageGen: z.boolean().optional(), subagents: z.boolean().optional() })
      .strict()
      .optional(),
    /** Tokens, or null for the model's whole window. */
    contextLimit: z.number().int().min(20_000).max(100_000_000).nullable().optional(),
  })
  .strict()
export type MobileChatSetupPatch = z.infer<typeof mobileChatSetupPatchSchema>

/** What new chats of the host start with; each chat can change it. */
export const mobileChatDefaultsSchema = z.object({
  selection: modelRef.nullable(),
  reasoning: z.string().max(40),
  fastMode: z.boolean(),
})
export type MobileChatDefaults = z.infer<typeof mobileChatDefaultsSchema>

/** A quota window of a subscription account: the share used, and when it starts over. */
export const mobileSubscriptionUsageWindowSchema = z.object({
  id: z.string().min(1).max(200),
  /** A kind this app does not know reads as `other`. */
  kind: z.enum(['five-hour', 'weekly', 'weekly-model', 'other']).catch('other'),
  usedPercent: z.number().min(0).max(100),
  /** Epoch milliseconds; null when the provider does not say. */
  resetsAt: z.number().nonnegative().nullable(),
  durationMins: z.number().nonnegative().nullable(),
  /** The model or group a window counts, as the provider names it. */
  label: z.string().max(200).optional(),
})
export type MobileSubscriptionUsageWindow = z.infer<typeof mobileSubscriptionUsageWindowSchema>

export const mobileSubscriptionProviderKindSchema = z.enum(['claude', 'codex', 'google'])
export type MobileSubscriptionProviderKind = z.infer<typeof mobileSubscriptionProviderKindSchema>

/**
 * The quota usage of one subscription account connected on the host. It names the account as the host's models do,
 * and never carries its email, plan or credentials; an error is only a code.
 */
export const mobileSubscriptionUsageEntrySchema = z.object({
  /** The host's provider id of the account: one entry per account. */
  providerId: id,
  providerKind: mobileSubscriptionProviderKindSchema,
  providerLabel: name,
  /** Absent for a default account that was never named. */
  accountLabel: name.optional(),
  state: z.enum(['ready', 'error']),
  /** When the host read it (epoch milliseconds); ready entries only. */
  fetchedAt: z.number().nonnegative().optional(),
  windows: z.array(mobileSubscriptionUsageWindowSchema).max(50),
  /** `unavailable`: the provider reports no limits for this account right now. */
  error: z.enum(['unavailable', 'unknown-account', 'failed']).catch('failed').optional(),
})
export type MobileSubscriptionUsageEntry = z.infer<typeof mobileSubscriptionUsageEntrySchema>

export const mobileSubscriptionUsageSchema = z.object({
  /** Entries this app cannot read, such as those of a provider added later, are left out rather than failing all. */
  entries: z
    .array(z.unknown())
    .max(200)
    .transform((items) =>
      items.flatMap((item) => {
        const entry = mobileSubscriptionUsageEntrySchema.safeParse(item)
        return entry.success ? [entry.data] : []
      })
    ),
})
export type MobileSubscriptionUsage = z.output<typeof mobileSubscriptionUsageSchema>

export const mobileAttachmentSchema = z
  .object({
    name: z.string().min(1).max(200),
    kind: z.enum(['image', 'pdf', 'text']),
    mediaType: z.string().min(1).max(100),
    dataBase64: z.string().max(Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4),
  })
  .strict()
export type MobileAttachment = z.infer<typeof mobileAttachmentSchema>

const conversationArgs = z.object({ conversationId: id }).strict()
const ok = z.object({ ok: z.boolean(), error: z.string().max(500).optional() })

/** Every call a phone makes: its channel, what it sends and what it gets back. Errors carry a `code`. */
export const MOBILE_CHANNELS = {
  lists: { channel: 'mobile:v1:lists', args: z.object({}).strict(), result: mobileListsSchema },
  create: {
    channel: 'mobile:v1:conversation:create',
    args: z
      .object({
        /** Null: a standalone chat. */
        workspaceId: id.nullable(),
        name: z.string().trim().min(1).max(200).optional(),
        experience: mobileExperienceSchema.optional(),
        /**
         * Workspaces only; omitted, the chat works on a new branch of its own. Only sent to hosts that answered
         * `branches`: older ones refuse arguments they do not know.
         */
        branch: mobileNewChatBranchSchema.optional(),
      })
      .strict(),
    result: mobileConversationSchema,
  },
  branches: {
    channel: 'mobile:v1:workspace:branches',
    args: z.object({ workspaceId: id }).strict(),
    result: mobileBranchesSchema,
  },
  open: {
    channel: 'mobile:v1:conversation:open',
    args: conversationArgs,
    result: z.object({
      conversation: mobileConversationSchema,
      /** The conversation this one was started from, when an agent started it. */
      sourceConversationId: id.nullable(),
      page: mobileChatPageSchema,
      runtime: mobileRuntimeSchema,
    }),
  },
  close: { channel: 'mobile:v1:conversation:close', args: conversationArgs, result: z.null() },
  page: {
    channel: 'mobile:v1:conversation:page',
    args: z.object({ conversationId: id, before: z.string().min(1).max(100) }).strict(),
    result: mobileChatPageSchema,
  },
  send: {
    channel: 'mobile:v1:conversation:send',
    args: z
      .object({
        conversationId: id,
        text: z.string().max(100_000),
        attachments: z.array(mobileAttachmentSchema).max(8),
        /** The phone's id for this message: a resend of the same id is not sent twice. */
        clientId: z.uuid(),
      })
      .strict(),
    result: z.object({ status: z.enum(['started', 'duplicate']) }),
  },
  /**
   * The person's last message, edited while no turn runs: the conversation is cut from that message, which keeps its
   * attachments, and the new text runs as a new turn. A host that predates it answers `unknown-channel`.
   */
  edit: {
    channel: 'mobile:v1:conversation:edit',
    args: z.object({ conversationId: id, itemId: id, text: z.string().trim().min(1).max(100_000) }).strict(),
    result: z.null(),
  },
  stop: { channel: 'mobile:v1:conversation:stop', args: conversationArgs, result: z.null() },
  rename: {
    channel: 'mobile:v1:conversation:rename',
    args: z.object({ conversationId: id, name: z.string().trim().min(1).max(200) }).strict(),
    result: z.null(),
  },
  archive: {
    channel: 'mobile:v1:conversation:archive',
    args: z.object({ conversationId: id, archived: z.boolean() }).strict(),
    result: z.null(),
  },
  permission: {
    channel: 'mobile:v1:permission',
    args: z.object({ conversationId: id, requestId: id, reply: z.enum(['once', 'always', 'reject']) }).strict(),
    result: z.null(),
  },
  question: {
    channel: 'mobile:v1:question',
    /** No answers dismisses the question. */
    args: z
      .object({ conversationId: id, toolCallId: id, answers: z.array(z.array(z.string().max(4000)).max(20)).max(20) })
      .strict(),
    result: z.null(),
  },
  plan: {
    channel: 'mobile:v1:plan',
    /**
     * Beyond the action and a general comment, only sent to hosts that answered `planOptions`: older ones refuse
     * arguments they do not know.
     */
    args: z
      .object({
        conversationId: id,
        action: z.enum(['approve', 'revise', 'discard']),
        feedback: z.string().max(10_000).optional(),
        /** The plan as the person edited it: approved as edited, or sent back with the feedback. */
        editedPlan: z.string().trim().min(1).max(500_000).optional(),
        lineComments: z.array(mobilePlanLineCommentSchema).max(500).optional(),
        /** Approval only; omitted, the plan is built in its own chat, which turns to Agent mode. */
        implementation: mobilePlanImplementationSchema.optional(),
      })
      .strict(),
    /** `conversationId`: the chat that builds it, when it is another one. */
    result: ok.extend({ conversationId: id.optional() }),
  },
  /**
   * Where the chat's plan can be built besides the chat itself, and whether a review holds it. A host that predates it
   * answers `unknown-channel`, and its `plan` takes only the action and a general comment.
   */
  planOptions: { channel: 'mobile:v1:plan:options', args: conversationArgs, result: mobilePlanOptionsSchema },
  setup: { channel: 'mobile:v1:setup', args: conversationArgs, result: mobileChatSetupSchema },
  setSetup: {
    channel: 'mobile:v1:setup:set',
    args: z.object({ conversationId: id, patch: mobileChatSetupPatchSchema }).strict(),
    result: mobileChatSetupSchema,
  },
  models: {
    channel: 'mobile:v1:models',
    args: z.object({}).strict(),
    result: z.object({ options: z.array(fleetSelectionOptionSchema), defaultSelection: modelRef.nullable() }),
  },
  defaults: { channel: 'mobile:v1:defaults', args: z.object({}).strict(), result: mobileChatDefaultsSchema },
  setDefaults: {
    channel: 'mobile:v1:defaults:set',
    args: z
      .object({
        selection: modelRef.optional(),
        reasoning: z.string().min(1).max(40).optional(),
        fastMode: z.boolean().optional(),
      })
      .strict(),
    result: mobileChatDefaultsSchema,
  },
  /**
   * The quota usage of the subscriptions connected on the host, read only. `force` reads it from the providers again
   * instead of the host's last minute of cache. A host that predates it answers `unknown-channel`.
   */
  subscriptionUsage: {
    channel: 'mobile:v1:subscription-usage',
    args: z.object({ force: z.boolean().optional() }).strict(),
    result: mobileSubscriptionUsageSchema,
  },
  compact: { channel: 'mobile:v1:compact', args: conversationArgs, result: ok },
  image: {
    channel: 'mobile:v1:image',
    args: z.object({ conversationId: id, imageId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/) }).strict(),
    result: z.object({ mediaType: z.string().max(100), dataBase64: z.string() }),
  },
} as const
export type MobileChannels = typeof MOBILE_CHANNELS
export type MobileChannelKey = keyof MobileChannels
export type MobileArgs<K extends MobileChannelKey> = z.input<MobileChannels[K]['args']>
export type MobileResult<K extends MobileChannelKey> = z.output<MobileChannels[K]['result']>

/** What a host pushes to a phone: about the conversations it opened, and about its lists. */
export const MOBILE_EVENTS = {
  items: {
    channel: 'mobile:v1:items',
    payload: z.object({ conversationId: id, items: z.array(mobileChatItemSchema) }),
  },
  runtime: { channel: 'mobile:v1:runtime', payload: z.object({ conversationId: id, runtime: mobileRuntimeSchema }) },
  status: {
    channel: 'mobile:v1:status',
    payload: z.object({ conversationId: id, status: mobileConversationStatusSchema }),
  },
  /** Chats or workspaces were added, renamed, archived or removed: read the lists again. */
  lists: { channel: 'mobile:v1:lists-changed', payload: z.object({}) },
  /** The conversation's setup changed elsewhere: read it again. */
  setup: { channel: 'mobile:v1:setup-changed', payload: z.object({ conversationId: id }) },
  /** The conversation's history changed in a way updates cannot describe: load it again. */
  reset: { channel: 'mobile:v1:reset', payload: z.object({ conversationId: id }) },
} as const
export type MobileEvents = typeof MOBILE_EVENTS
export type MobileEventKey = keyof MobileEvents
export type MobileEventPayload<K extends MobileEventKey> = z.output<MobileEvents[K]['payload']>
export type MobileEvent = { [K in MobileEventKey]: { key: K; payload: MobileEventPayload<K> } }[MobileEventKey]

export const MOBILE_CHANNEL_KEYS = new Map<string, MobileChannelKey>(
  (Object.keys(MOBILE_CHANNELS) as MobileChannelKey[]).map((key) => [MOBILE_CHANNELS[key].channel, key])
)
export const MOBILE_EVENT_KEYS = new Map<string, MobileEventKey>(
  (Object.keys(MOBILE_EVENTS) as MobileEventKey[]).map((key) => [MOBILE_EVENTS[key].channel, key])
)

export const mobileClientOsSchema = z.enum(['ios', 'android'])
/** A phone's first frame. */
export const mobileHelloSchema = z.object({
  t: z.literal('hello'),
  protocol: z.literal(MOBILE_BRIDGE_PROTOCOL),
  appVersion: z.string().max(64),
  client: z.object({
    kind: z.literal('mobile'),
    deviceName: z.string().max(128),
    os: mobileClientOsSchema,
    locale: z.string().max(16),
    mobileApi: z.number().int(),
  }),
})
export type MobileHello = z.infer<typeof mobileHelloSchema>

const errorShape = z.object({ message: z.string(), code: z.string().optional() })
/** What a host sends a phone. Unknown frame types are ignored, so a host may add some. */
export const mobileHostFrameSchema = z.union([
  z.object({
    t: z.literal('welcome'),
    protocol: z.number(),
    appVersion: z.string(),
    mobileApi: z.number().int().optional(),
  }),
  z.object({ t: z.literal('refused'), reason: z.string(), hostVersion: z.string().optional() }),
  z.object({ t: z.literal('result'), id: z.number().int(), ok: z.literal(true), value: z.unknown().optional() }),
  z.object({ t: z.literal('result'), id: z.number().int(), ok: z.literal(false), error: errorShape }),
  z.object({ t: z.literal('event'), origin: z.number().int(), channel: z.string(), args: z.array(z.unknown()) }),
  z.object({ t: z.literal('ping'), n: z.number() }),
  z.object({ t: z.literal('pong'), n: z.number() }),
])
export type MobileHostFrame = z.infer<typeof mobileHostFrameSchema>
