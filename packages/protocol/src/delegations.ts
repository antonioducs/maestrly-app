import { z } from 'zod'
import { agentStageSettingsSchema, agentStageSettingsPatchSchema } from './delegation-models.js'
/* Timer cadence helpers keep the next occurrence deterministic for a given timezone. */
import { opaqueIdSchema, utcDateTimeSchema } from './identity.js'

/**
 * A delegation task is the durable unit an external agent, the web app and the desktop all operate on.
 * It owns an ordered pipeline of stages; each stage keeps its own agent configuration and each attempt
 * freezes the configuration it actually ran with.
 */
export const delegationStageTypeSchema = z.enum([
  'plan',
  'implement',
  'review',
  'fix',
  'qa',
  /** Host action: run named project checks against a captured revision. */
  'verify',
  /** Host action: commit, push, open or update a pull request, or merge. */
  'deliver',
  /** Host action: read-only inspection requested by a follow-up. */
  'inspect',
])

export const DELEGATION_AGENT_STAGE_TYPES = ['plan', 'implement', 'review', 'fix', 'qa'] as const
export const DELEGATION_HOST_STAGE_TYPES = ['verify', 'deliver', 'inspect'] as const

export const deliveryModeSchema = z.enum(['patch', 'commit', 'push', 'draft_pr', 'ready_pr', 'merge'])

export const delegationHostActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checks'), checkIds: z.array(z.string().min(1).max(120)).min(1).max(50) }).strict(),
  z
    .object({
      kind: z.literal('deliver'),
      mode: deliveryModeSchema,
      title: z.string().max(200).optional(),
      expectedCodeRevision: z.string().min(1).max(191).nullable().default(null),
    })
    .strict(),
  z.object({ kind: z.literal('pull_request_status') }).strict(),
])

/**
 * Identity of a complete code version. `contentDigest` covers the captured content in full; a truncated
 * fingerprint is never accepted as proof of identity.
 */
export const codeRevisionSchema = z
  .object({
    id: opaqueIdSchema,
    baseCommit: z.string().min(1).max(64).nullable(),
    headCommit: z.string().min(1).max(64).nullable(),
    contentDigest: z.string().min(16).max(191),
    snapshotArtifactId: opaqueIdSchema.nullable(),
    capturedAt: utcDateTimeSchema,
  })
  .strict()

export const delegationCompletionTargetSchema = z.enum(['patch_ready', 'pr_ready', 'merged'])

export const reviewFindingSeveritySchema = z.enum(['blocking', 'important', 'optional'])
export const reviewFindingStateSchema = z.enum(['open', 'fixed', 'accepted', 'reopened'])

/** Structured finding. A fix stage and its re-review keep the same identifier, so progress is measurable. */
export const reviewFindingSchema = z
  .object({
    id: z.string().min(1).max(128),
    severity: reviewFindingSeveritySchema,
    title: z.string().min(1).max(200),
    details: z.string().max(4_000),
    paths: z.array(z.string().min(1).max(300)).max(20).default([]),
    recommendation: z.string().max(2_000).default(''),
    state: reviewFindingStateSchema.default('open'),
  })
  .strict()

export const criterionCoverageSchema = z
  .object({
    criterion: z.string().min(1).max(4_000),
    satisfied: z.boolean(),
    evidence: z.string().max(2_000).default(''),
  })
  .strict()

/**
 * Verdict of one review, bound to the exact revision it read. A verdict that does not echo the reviewed
 * digest is refused: an approval can never float free of the code it approved.
 */
export const reviewResultSchema = z
  .object({
    verdict: z.enum(['approved', 'changes_requested', 'blocked']),
    codeRevisionDigest: z.string().min(16).max(191),
    findings: z.array(reviewFindingSchema).max(50).default([]),
    criteriaCoverage: z.array(criterionCoverageSchema).max(100).default([]),
    notes: z.string().max(4_000).default(''),
  })
  .strict()

export const completionDecisionSchema = z
  .object({
    satisfied: z.boolean(),
    target: delegationCompletionTargetSchema,
    /** Concrete reasons the target is not met; empty only when `satisfied` is true. */
    missing: z
      .array(
        z.object({
          reason: z.enum([
            'stage_incomplete',
            'criteria_unresolved',
            'required_check_missing',
            'required_check_failed',
            'review_missing',
            'review_findings_open',
            'evidence_stale',
            'pull_request_missing',
            'pull_request_not_ready',
            'merge_missing',
          ]),
          detail: z.string().max(1_000).default(''),
        })
      )
      .max(50)
      .default([]),
  })
  .strict()

/**
 * Autonomy is decided per capability. An already-authorized action is not confirmed again, and a connector
 * can never widen this policy for itself.
 */
export const delegationAutonomySchema = z
  .object({
    edit: z.boolean().default(true),
    runChecks: z.boolean().default(true),
    previewInteract: z.boolean().default(false),
    commit: z.boolean().default(false),
    push: z.boolean().default(false),
    openPullRequest: z.boolean().default(false),
    comment: z.boolean().default(false),
    merge: z.boolean().default(false),
  })
  .strict()

export const delegationLimitsSchema = z
  .object({
    maxActiveSeconds: z.number().int().min(60).max(86_400).default(3_600),
    watchWindowSeconds: z.number().int().min(0).max(1_209_600).default(86_400),
    maxFixAttempts: z.number().int().min(0).max(20).default(3),
    maxParallelStages: z.number().int().min(1).max(8).default(1),
    /** Unknown stays unknown: a null budget is never presented as a measured value. */
    maxTokens: z.number().int().positive().max(100_000_000).nullable().default(null),
    maxCostUsd: z.number().positive().max(100_000).nullable().default(null),
  })
  .strict()

export const delegationPolicySchema = z
  .object({
    autonomy: delegationAutonomySchema,
    limits: delegationLimitsSchema,
    completionTarget: delegationCompletionTargetSchema.default('patch_ready'),
    requireReview: z.boolean().default(true),
    requiredCheckIds: z.array(z.string().min(1).max(120)).max(50).default([]),
    /** Moving the card to Done is an explicit policy decision, never a side effect of finishing a turn. */
    moveCardOnCompletion: z.boolean().default(false),
  })
  .strict()

/** Deep-partial policy patch: an omitted capability or limit inherits instead of resetting to a default. */
export const delegationPolicyPatchSchema = z
  .object({
    autonomy: delegationAutonomySchema.partial().optional(),
    limits: delegationLimitsSchema.partial().optional(),
    completionTarget: delegationCompletionTargetSchema.optional(),
    requireReview: z.boolean().optional(),
    requiredCheckIds: z.array(z.string().min(1).max(120)).max(50).optional(),
    moveCardOnCompletion: z.boolean().optional(),
  })
  .strict()

/**
 * Named project check. The model selects a check by id; the host resolves the command, so a stage can never
 * run an arbitrary shell line through this path.
 */
export const delegationCheckConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,119}$/, 'Use a lowercase id with letters, digits, :, _ or -.'),
    label: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(''),
    command: z.string().trim().min(1).max(200),
    args: z.array(z.string().max(500)).max(50).default([]),
    /** Directory relative to the workspace root; never absolute and never outside it. */
    workingDirectory: z.string().max(300).default(''),
    timeoutSeconds: z.number().int().min(1).max(7_200).default(900),
    required: z.boolean().default(false),
    /** A check that writes to disk runs in a disposable copy of the reviewed revision. */
    mutatesWorkspace: z.boolean().default(false),
    /** Environment variable names the check may read from the executor; values are never stored here. */
    environmentAllowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)).max(50).default([]),
    /** Commands the executor may run once to install dependencies before the check. */
    setup: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
    enabled: z.boolean().default(true),
  })
  .strict()

export const checkResultSchema = z
  .object({
    checkId: z.string().min(1).max(120),
    /** Command line the host actually executed, for the record. */
    resolvedCommand: z.string().max(2000),
    passed: z.boolean(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    timedOut: z.boolean().default(false),
    /** True when the captured log was cut at the limit; the truncation itself is reported. */
    truncated: z.boolean().default(false),
    codeRevisionDigest: z.string().min(16).max(191),
    logArtifactId: opaqueIdSchema.nullable().default(null),
    /** Set when the check could not run at all, for example because setup is incomplete. */
    setupIssue: z.string().max(2000).nullable().default(null),
  })
  .strict()

export const delegationArtifactKindSchema = z.enum([
  'patch',
  'log',
  'report',
  'screenshot',
  'recording',
  'snapshot',
  'attachment',
])

export const delegationArtifactSchema = z
  .object({
    id: opaqueIdSchema,
    taskId: opaqueIdSchema,
    attemptId: opaqueIdSchema.nullable(),
    kind: delegationArtifactKindSchema,
    name: z.string().min(1).max(500),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().nonnegative(),
    digest: z.string().min(16).max(191),
    codeRevisionDigest: z.string().max(191).nullable(),
    createdAt: utcDateTimeSchema,
  })
  .strict()

/**
 * Typed inspection operations. There is no arbitrary shell and no path outside the workspace; browser
 * interaction requires its own capability and is refused on a read-only stage.
 */
export const inspectionOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('read_file'),
      path: z.string().min(1).max(500),
      offset: z.number().int().nonnegative().max(1_000_000).default(0),
      limit: z.number().int().min(1).max(2_000).default(400),
    })
    .strict(),
  z
    .object({
      kind: z.literal('search'),
      pattern: z.string().min(1).max(2_000),
      include: z.string().max(300).default(''),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  z.object({ kind: z.literal('glob'), pattern: z.string().min(1).max(300), limit: z.number().int().min(1).max(300).default(100) }).strict(),
  z.object({ kind: z.literal('diff'), base: z.string().max(240).default('') }).strict(),
  z.object({ kind: z.literal('pull_request') }).strict(),
  z.object({ kind: z.literal('preview_start'), checkId: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal('preview_stop'), previewId: z.string().min(1).max(191) }).strict(),
  z.object({ kind: z.literal('browser_snapshot'), previewId: z.string().min(1).max(191) }).strict(),
  z.object({ kind: z.literal('browser_screenshot'), previewId: z.string().min(1).max(191) }).strict(),
  z.object({ kind: z.literal('browser_text'), previewId: z.string().min(1).max(191) }).strict(),
  z.object({ kind: z.literal('browser_console'), previewId: z.string().min(1).max(191), limit: z.number().int().min(1).max(200).default(50) }).strict(),
  z.object({ kind: z.literal('browser_network'), previewId: z.string().min(1).max(191), onlyErrors: z.boolean().default(false) }).strict(),
  z
    .object({ kind: z.literal('browser_navigate'), previewId: z.string().min(1).max(191), url: z.string().url().max(2000) })
    .strict(),
  z.object({ kind: z.literal('browser_click'), previewId: z.string().min(1).max(191), ref: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal('browser_type'),
      previewId: z.string().min(1).max(191),
      ref: z.number().int().nonnegative(),
      text: z.string().max(4_000),
      clear: z.boolean().default(false),
    })
    .strict(),
])

export const INSPECTION_INTERACTIVE_KINDS = [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'preview_start',
  'preview_stop',
] as const

export const inspectionSchema = z
  .object({
    id: opaqueIdSchema,
    taskId: opaqueIdSchema,
    operation: inspectionOperationSchema,
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    /** Bounded structured result; large payloads are delivered as artifacts instead. */
    result: z.record(z.string(), z.unknown()).nullable(),
    artifactId: opaqueIdSchema.nullable(),
    error: z.string().max(4_000).nullable(),
    /** Revision the inspection observed, so a later edit does not silently reinterpret it. */
    codeRevisionDigest: z.string().max(191).nullable(),
    createdAt: utcDateTimeSchema,
    finishedAt: utcDateTimeSchema.nullable(),
  })
  .strict()

export const delegationSubscriptionSourceSchema = z.enum(['github', 'timer', 'dependency'])

/**
 * What to do when a source fires. The stage profile is chosen up front, so a reaction never has to guess which
 * account or model should handle it.
 */
export const delegationSubscriptionRuleSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('refresh_pull_request'),
      /** Seconds between polls while the watch is active. */
      intervalSeconds: z.number().int().min(15).max(3_600).default(60),
    })
    .strict(),
  z
    .object({
      action: z.literal('fix_failing_checks'),
      /** Stage configuration for the diagnosis and fix round the failure triggers. */
      settings: agentStageSettingsPatchSchema,
      instructions: z.string().max(100_000).default(''),
    })
    .strict(),
  z
    .object({
      action: z.literal('address_review_comments'),
      settings: agentStageSettingsPatchSchema,
      instructions: z.string().max(100_000).default(''),
    })
    .strict(),
  z
    .object({
      action: z.literal('create_task_from_preset'),
      presetId: opaqueIdSchema,
      title: z.string().trim().min(1).max(500),
      /**
       * Profile for the pipeline the timer creates. A preset carries no account or model, so without this the
       * profile of the task that owns the subscription is reused; one of the two must resolve.
       */
      settings: agentStageSettingsPatchSchema.nullable().default(null),
      /** Cron-like schedule limited to a daily or hourly cadence with an explicit timezone. */
      cadence: z.enum(['hourly', 'daily', 'weekly']),
      atMinute: z.number().int().min(0).max(59).default(0),
      atHour: z.number().int().min(0).max(23).default(9),
      weekday: z.number().int().min(0).max(6).default(1),
    })
    .strict(),
  z.object({ action: z.literal('notify_only') }).strict(),
])

export const delegationSubscriptionSchema = z
  .object({
    id: opaqueIdSchema,
    taskId: opaqueIdSchema,
    source: delegationSubscriptionSourceSchema,
    rule: delegationSubscriptionRuleSchema,
    enabled: z.boolean(),
    timezone: z.string().min(1).max(80),
    nextFireAt: utcDateTimeSchema.nullable(),
    lastFiredAt: utcDateTimeSchema.nullable(),
    expiresAt: utcDateTimeSchema.nullable(),
    firedCount: z.number().int().nonnegative(),
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
  })
  .strict()

export const delegationSubscriptionInputSchema = z
  .object({
    source: delegationSubscriptionSourceSchema,
    rule: delegationSubscriptionRuleSchema,
    timezone: z.string().min(1).max(80).default('UTC'),
    /** Watch window; the subscription disables itself afterwards and says so. */
    expiresInSeconds: z.number().int().min(60).max(1_209_600).nullable().default(null),
  })
  .strict()

/** Normalized external event. Ordering and duplicates are resolved from these fields, never from arrival time. */
export const delegationSourceEventSchema = z
  .object({
    source: delegationSubscriptionSourceSchema,
    externalId: z.string().min(1).max(300),
    type: z.string().min(1).max(120),
    pullRequestNumber: z.number().int().positive().nullable().default(null),
    headSha: z.string().min(7).max(64).nullable().default(null),
    payload: z.record(z.string(), z.unknown()).default({}),
    occurredAt: utcDateTimeSchema,
  })
  .strict()

export const delegationStageStateSchema = z.enum([
  'pending',
  'queued',
  'running',
  'waiting_input',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'superseded',
])

export const delegationTaskStateSchema = z.enum([
  'draft',
  'queued',
  'running',
  'pausing',
  'paused',
  'waiting_input',
  'waiting_review',
  'watching',
  'needs_attention',
  'completed',
  'cancelling',
  'cancelled',
  'failed',
])

export const DELEGATION_ACTIVE_TASK_STATES = [
  'queued',
  'running',
  'pausing',
  'waiting_input',
  'waiting_review',
  'cancelling',
] as const

/** Structured reason why a task cannot progress; never invented by a client. */
export const delegationBlockerSchema = z
  .object({
    reason: z.enum([
      'executor_offline',
      'selection_unavailable',
      'catalog_changed',
      'workspace_missing',
      'workspace_busy',
      'permission_lost',
      'awaiting_human_decision',
      'awaiting_information',
      'limit_reached',
      'review_findings_open',
      'evidence_stale',
      'delivery_unconfirmed',
      'remote_diverged',
      'check_setup_incomplete',
      'executor_error',
    ]),
    detail: z.string().max(2000).default(''),
    since: utcDateTimeSchema,
  })
  .strict()

export const stageDefinitionSchema = z
  .object({
    id: opaqueIdSchema,
    type: delegationStageTypeSchema,
    title: z.string().min(1).max(200),
    instructions: z.string().max(100_000).default(''),
    position: z.number().int().nonnegative(),
    dependsOn: z.array(opaqueIdSchema).max(20).default([]),
    /** Agent stages carry settings; host stages carry a structured action instead. */
    settings: agentStageSettingsSchema.nullable().default(null),
    action: delegationHostActionSchema.nullable().default(null),
    requiredForCompletion: z.boolean().default(true),
    state: delegationStageStateSchema.default('pending'),
    attempts: z.number().int().nonnegative().default(0),
    settingsRevision: z.number().int().positive().default(1),
    version: z.number().int().positive().default(1),
  })
  .strict()
  .refine((stage) => (DELEGATION_AGENT_STAGE_TYPES as readonly string[]).includes(stage.type) === !!stage.settings, {
    message: 'Agent stages require settings and host stages must not carry them.',
    path: ['settings'],
  })
  .refine((stage) => (DELEGATION_HOST_STAGE_TYPES as readonly string[]).includes(stage.type) === !!stage.action, {
    message: 'Host stages require a structured action and agent stages must not carry one.',
    path: ['action'],
  })

export const stageDefinitionInputSchema = z
  .object({
    type: delegationStageTypeSchema,
    title: z.string().trim().min(1).max(200),
    instructions: z.string().max(100_000).default(''),
    dependsOn: z.array(z.number().int().nonnegative()).max(20).default([]),
    settings: agentStageSettingsPatchSchema.optional(),
    action: delegationHostActionSchema.optional(),
    requiredForCompletion: z.boolean().default(true),
  })
  .strict()

/** What the runtime actually did, next to what was requested and what was admitted. */
export const stageExecutionReceiptSchema = z
  .object({
    requested: agentStageSettingsSchema.nullable(),
    admitted: agentStageSettingsSchema.nullable(),
    observed: z
      .object({
        selectionId: z.string().max(191).nullable(),
        modelId: z.string().max(191).nullable(),
        accountLabel: z.string().max(200).nullable(),
        reasoning: z.string().max(80).nullable(),
        fastMode: z.boolean().nullable(),
        harnessProfileId: z.string().max(191).nullable(),
        harnessHash: z.string().max(191).nullable(),
      })
      .strict()
      .nullable(),
    /** True only when the runtime confirmed the admitted selection; a mismatch stays visible. */
    selectionHonored: z.boolean(),
    conversationId: z.string().max(191).nullable(),
    result: z.enum(['succeeded', 'failed', 'cancelled', 'interrupted']),
    summary: z.string().max(20_000).default(''),
    blocker: z.string().max(4_000).nullable().default(null),
    tokensObserved: z.boolean().default(false),
    tokens: z.number().int().nonnegative().nullable().default(null),
    costUsd: z.number().nonnegative().nullable().default(null),
    durationMs: z.number().int().nonnegative().nullable().default(null),
  })
  .strict()

export const stageAttemptSchema = z
  .object({
    id: opaqueIdSchema,
    taskId: opaqueIdSchema,
    stageId: opaqueIdSchema,
    attempt: z.number().int().positive(),
    state: delegationStageStateSchema,
    snapshot: z
      .object({
        stageType: delegationStageTypeSchema,
        title: z.string().max(200),
        prompt: z.string().max(200_000),
        settings: agentStageSettingsSchema.nullable(),
        action: delegationHostActionSchema.nullable(),
        catalogRevision: z.string().max(64),
        executorId: opaqueIdSchema,
        workspaceKey: z.string().max(191),
        baseBranch: z.string().max(240),
        repositoryBindingId: opaqueIdSchema.nullable(),
        autonomy: delegationAutonomySchema,
        limits: delegationLimitsSchema,
      })
      .strict(),
    sessionId: opaqueIdSchema.nullable(),
    turnId: opaqueIdSchema.nullable(),
    receipt: stageExecutionReceiptSchema.nullable(),
    codeRevision: codeRevisionSchema.nullable(),
    startedAt: utcDateTimeSchema.nullable(),
    finishedAt: utcDateTimeSchema.nullable(),
    createdAt: utcDateTimeSchema,
  })
  .strict()

export const delegationTaskSchema = z
  .object({
    id: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    boardId: opaqueIdSchema,
    cardId: opaqueIdSchema,
    ownerUserId: opaqueIdSchema,
    /** Connection that created the task, when it came from an external agent. */
    connectionId: opaqueIdSchema.nullable(),
    title: z.string().min(1).max(500),
    objective: z.string().max(100_000),
    acceptanceCriteria: z.array(z.string().min(1).max(4_000)).max(100),
    executorId: opaqueIdSchema,
    workspaceKey: z.string().min(1).max(191),
    baseBranch: z.string().min(1).max(240),
    repositoryBindingId: opaqueIdSchema.nullable(),
    presetId: opaqueIdSchema.nullable(),
    policy: delegationPolicySchema,
    state: delegationTaskStateSchema,
    blocker: delegationBlockerSchema.nullable(),
    settingsRevision: z.number().int().positive(),
    version: z.number().int().positive(),
    eventSequence: z.number().int().nonnegative(),
    completedAt: utcDateTimeSchema.nullable(),
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
  })
  .strict()

export const delegationEventSchema = z
  .object({
    id: opaqueIdSchema,
    taskId: opaqueIdSchema,
    sequence: z.number().int().positive(),
    type: z.string().min(1).max(120),
    /** Bounded public payload; raw tool input, reasoning and credentials never appear here. */
    data: z.record(z.string(), z.unknown()),
    createdAt: utcDateTimeSchema,
  })
  .strict()

export const delegationTaskViewSchema = z
  .object({
    task: delegationTaskSchema,
    stages: z.array(stageDefinitionSchema).max(100),
    attempts: z.array(stageAttemptSchema).max(200),
    /** Links usable in Maestrly; the connector never receives a fabricated deep link. */
    links: z.object({ task: z.string().url(), card: z.string().url() }).strict(),
  })
  .strict()

export const delegationCreateSchema = z
  .object({
    /** Existing card, or the board/title/objective needed to create one atomically with the task. */
    cardId: opaqueIdSchema.optional(),
    boardId: opaqueIdSchema.optional(),
    title: z.string().trim().min(1).max(500).optional(),
    objective: z.string().max(100_000).default(''),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(4_000)).max(100).default([]),
    executorId: opaqueIdSchema,
    workspaceKey: z.string().min(1).max(191),
    baseBranch: z.string().min(1).max(240),
    presetId: opaqueIdSchema.optional(),
    policy: delegationPolicyPatchSchema.optional(),
    stages: z.array(stageDefinitionInputSchema).min(1).max(50),
    dependsOnTaskIds: z.array(opaqueIdSchema).max(20).default([]),
    start: z.boolean().default(false),
  })
  .strict()
  .refine((input) => !!input.cardId || (!!input.boardId && !!input.title), {
    message: 'Provide an existing cardId, or a boardId and title so the card is created with the task.',
  })

export const delegationConfigureTargetSchema = z.enum(['task_defaults', 'stage', 'next_attempt'])
export const delegationConfigureApplySchema = z.enum(['after_current', 'replace_queued', 'interrupt_and_restart'])

export const delegationCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), expectedVersion: z.number().int().positive() }).strict(),
  z
    .object({
      type: z.literal('follow_up'),
      expectedVersion: z.number().int().positive(),
      text: z.string().trim().min(1).max(100_000),
      stage: stageDefinitionInputSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('configure'),
      expectedVersion: z.number().int().positive(),
      target: delegationConfigureTargetSchema,
      stageId: opaqueIdSchema.optional(),
      settingsPatch: agentStageSettingsPatchSchema,
      apply: delegationConfigureApplySchema.default('after_current'),
    })
    .strict(),
  z
    .object({
      type: z.literal('pause'),
      expectedVersion: z.number().int().positive(),
      immediate: z.boolean().default(false),
    })
    .strict(),
  z.object({ type: z.literal('resume'), expectedVersion: z.number().int().positive() }).strict(),
  z
    .object({
      type: z.literal('cancel'),
      expectedVersion: z.number().int().positive(),
      reason: z.string().max(2000).default(''),
    })
    .strict(),
  z
    .object({
      type: z.literal('request_review'),
      expectedVersion: z.number().int().positive(),
      settingsPatch: agentStageSettingsPatchSchema.optional(),
      instructions: z.string().max(100_000).default(''),
    })
    .strict(),
  z
    .object({
      type: z.literal('request_checks'),
      expectedVersion: z.number().int().positive(),
      checkIds: z.array(z.string().min(1).max(120)).min(1).max(50),
    })
    .strict(),
  z
    .object({
      type: z.literal('deliver'),
      expectedVersion: z.number().int().positive(),
      mode: deliveryModeSchema,
      title: z.string().max(200).optional(),
      expectedCodeRevision: z.string().min(1).max(191).nullable().default(null),
    })
    .strict(),
])

export const delegationCommandResultSchema = z
  .object({
    commandId: opaqueIdSchema,
    taskId: opaqueIdSchema,
    accepted: z.boolean(),
    /** Version and revision the command produced, so a client can chain calls without re-reading. */
    version: z.number().int().positive(),
    settingsRevision: z.number().int().positive(),
    appliesFromStageId: opaqueIdSchema.nullable(),
    appliesFromAttempt: z.number().int().positive().nullable(),
    stageIds: z.array(opaqueIdSchema).max(100),
    state: delegationTaskStateSchema,
    pendingInterrupt: z.boolean(),
  })
  .strict()

export const delegationPresetSchema = z
  .object({
    id: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(2000),
    version: z.number().int().positive(),
    policy: delegationPolicySchema,
    stages: z.array(stageDefinitionInputSchema).min(1).max(50),
    builtIn: z.boolean(),
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
  })
  .strict()

export const delegationPresetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(2000).default(''),
    policy: delegationPolicyPatchSchema.optional(),
    stages: z.array(stageDefinitionInputSchema).min(1).max(50),
  })
  .strict()

export const delegationPresetPatchSchema = delegationPresetInputSchema.partial().extend({
  expectedVersion: z.number().int().positive(),
})

export type DelegationStageType = z.infer<typeof delegationStageTypeSchema>
export type DeliveryMode = z.infer<typeof deliveryModeSchema>
export type DelegationHostAction = z.infer<typeof delegationHostActionSchema>
export type CodeRevision = z.infer<typeof codeRevisionSchema>
export type DelegationAutonomy = z.infer<typeof delegationAutonomySchema>
export type DelegationLimits = z.infer<typeof delegationLimitsSchema>
export type DelegationPolicy = z.infer<typeof delegationPolicySchema>
export type DelegationSubscriptionSource = z.infer<typeof delegationSubscriptionSourceSchema>
export type DelegationSubscriptionRule = z.infer<typeof delegationSubscriptionRuleSchema>
export type DelegationSubscription = z.infer<typeof delegationSubscriptionSchema>
export type DelegationSubscriptionInput = z.infer<typeof delegationSubscriptionInputSchema>
export type DelegationSourceEvent = z.infer<typeof delegationSourceEventSchema>
export type DelegationCheckConfig = z.infer<typeof delegationCheckConfigSchema>
export type CheckResult = z.infer<typeof checkResultSchema>
export type DelegationArtifactKind = z.infer<typeof delegationArtifactKindSchema>
export type DelegationArtifact = z.infer<typeof delegationArtifactSchema>
export type InspectionOperation = z.infer<typeof inspectionOperationSchema>
export type DelegationInspection = z.infer<typeof inspectionSchema>
export type ReviewFindingSeverity = z.infer<typeof reviewFindingSeveritySchema>
export type ReviewFindingState = z.infer<typeof reviewFindingStateSchema>
export type ReviewFinding = z.infer<typeof reviewFindingSchema>
export type CriterionCoverage = z.infer<typeof criterionCoverageSchema>
export type ReviewResult = z.infer<typeof reviewResultSchema>
export type CompletionDecision = z.infer<typeof completionDecisionSchema>
export type DelegationPolicyPatch = z.infer<typeof delegationPolicyPatchSchema>
export type DelegationCompletionTarget = z.infer<typeof delegationCompletionTargetSchema>
export type DelegationStageState = z.infer<typeof delegationStageStateSchema>
export type DelegationTaskState = z.infer<typeof delegationTaskStateSchema>
export type DelegationBlocker = z.infer<typeof delegationBlockerSchema>
export type StageDefinition = z.infer<typeof stageDefinitionSchema>
export type StageDefinitionInput = z.infer<typeof stageDefinitionInputSchema>
export type StageExecutionReceipt = z.infer<typeof stageExecutionReceiptSchema>
export type StageAttempt = z.infer<typeof stageAttemptSchema>
export type DelegationTask = z.infer<typeof delegationTaskSchema>
export type DelegationEvent = z.infer<typeof delegationEventSchema>
export type DelegationTaskView = z.infer<typeof delegationTaskViewSchema>
export type DelegationCreate = z.infer<typeof delegationCreateSchema>
export type DelegationCommand = z.infer<typeof delegationCommandSchema>
export type DelegationCommandResult = z.infer<typeof delegationCommandResultSchema>
export type DelegationConfigureTarget = z.infer<typeof delegationConfigureTargetSchema>
export type DelegationConfigureApply = z.infer<typeof delegationConfigureApplySchema>
export type DelegationPreset = z.infer<typeof delegationPresetSchema>
export type DelegationPresetInput = z.infer<typeof delegationPresetInputSchema>
export type DelegationPresetPatch = z.infer<typeof delegationPresetPatchSchema>

export const defaultDelegationPolicy = (): DelegationPolicy =>
  delegationPolicySchema.parse({ autonomy: {}, limits: {} })

export function mergeDelegationPolicy(
  base: DelegationPolicy,
  patch: DelegationPolicyPatch | undefined
): DelegationPolicy {
  if (!patch) return base
  return delegationPolicySchema.parse({
    ...base,
    ...patch,
    autonomy: { ...base.autonomy, ...(patch.autonomy ?? {}) },
    limits: { ...base.limits, ...(patch.limits ?? {}) },
  })
}

export function isAgentStageType(type: DelegationStageType): boolean {
  return (DELEGATION_AGENT_STAGE_TYPES as readonly string[]).includes(type)
}

/**
 * Next occurrence for a timer rule in its declared timezone. A missed window schedules the next one instead of
 * firing repeatedly to catch up.
 */
export function nextTimerOccurrence(
  rule: Extract<DelegationSubscriptionRule, { action: 'create_task_from_preset' }>,
  timezone: string,
  from: Date
): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(from)
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '0'
  const localHour = Number(field('hour'))
  const localMinute = Number(field('minute'))
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const localWeekday = weekdays.indexOf(field('weekday'))
  const offsetMs = from.getTime() - Date.UTC(
    Number(field('year')),
    Number(field('month')) - 1,
    Number(field('day')),
    localHour,
    localMinute,
    Number(field('second'))
  )
  const local = (year: number, month: number, day: number, hour: number, minute: number) =>
    new Date(Date.UTC(year, month, day, hour, minute, 0) + offsetMs)
  const year = Number(field('year'))
  const month = Number(field('month')) - 1
  const day = Number(field('day'))
  if (rule.cadence === 'hourly') {
    const candidate = local(year, month, day, localHour, rule.atMinute)
    return candidate > from ? candidate : local(year, month, day, localHour + 1, rule.atMinute)
  }
  if (rule.cadence === 'daily') {
    const candidate = local(year, month, day, rule.atHour, rule.atMinute)
    return candidate > from ? candidate : local(year, month, day + 1, rule.atHour, rule.atMinute)
  }
  const delta = (rule.weekday - localWeekday + 7) % 7
  const candidate = local(year, month, day + delta, rule.atHour, rule.atMinute)
  return candidate > from ? candidate : local(year, month, day + delta + 7, rule.atHour, rule.atMinute)
}

/** True for operations that change something on the executor, not only read it. */
export function inspectionRequiresInteraction(operation: InspectionOperation): boolean {
  return (INSPECTION_INTERACTIVE_KINDS as readonly string[]).includes(operation.kind)
}

/**
 * A workspace-relative path that stays inside the workspace. Absolute paths, parent traversal and NUL bytes
 * are refused here, before any filesystem call.
 */
export function assertWorkspaceRelativePath(candidate: string): string {
  if (!candidate || candidate.includes('\0')) throw new Error('The path is empty or contains a NUL byte.')
  if (/^(?:[a-zA-Z]:)?[\\/]/.test(candidate)) throw new Error('The path must be relative to the workspace root.')
  const segments = candidate.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) throw new Error('The path must stay inside the workspace.')
  return segments.filter((segment) => segment && segment !== '.').join('/')
}

/**
 * Reject a cycle before anything is persisted. Dependencies are stage positions in the input order, so a
 * stage may only depend on an earlier stage.
 */
export function assertAcyclicStageInputs(stages: StageDefinitionInput[]): void {
  stages.forEach((stage, index) => {
    for (const dependency of stage.dependsOn) {
      if (dependency === index) throw new Error('A stage cannot depend on itself.')
      if (dependency > index) throw new Error('A stage may only depend on an earlier stage in the pipeline.')
      if (dependency >= stages.length) throw new Error('Stage dependency points outside the pipeline.')
    }
  })
}

/** Built-in pipelines. Presets are versioned; changing one never rewrites an existing task. */
export function builtInDelegationPresets(): Array<Omit<DelegationPreset, 'id' | 'organizationId' | 'projectId' | 'createdAt' | 'updatedAt'>> {
  const stage = (input: Partial<StageDefinitionInput> & Pick<StageDefinitionInput, 'type' | 'title'>) =>
    stageDefinitionInputSchema.parse(input)
  return [
    {
      name: 'Implement and review',
      description: 'Implement the card, run the required checks and review the result with a second model.',
      version: 1,
      builtIn: true,
      policy: defaultDelegationPolicy(),
      stages: [
        stage({ type: 'implement', title: 'Implement the card' }),
        stage({ type: 'review', title: 'Independent review', dependsOn: [0] }),
      ],
    },
    {
      name: 'Review an existing pull request',
      description: 'Read the pull request, review the change and report structured findings.',
      version: 1,
      builtIn: true,
      policy: mergeDelegationPolicy(defaultDelegationPolicy(), {
        autonomy: { edit: false, runChecks: true, comment: true },
        completionTarget: 'pr_ready',
        requireReview: true,
      }),
      stages: [
        stage({ type: 'inspect', title: 'Read the pull request', action: { kind: 'pull_request_status' } }),
        stage({ type: 'review', title: 'Review the change', dependsOn: [0] }),
      ],
    },
    {
      name: 'Reproduce and fix a bug',
      description: 'Reproduce the defect, fix it, verify the fix and review the change.',
      version: 1,
      builtIn: true,
      policy: defaultDelegationPolicy(),
      stages: [
        stage({ type: 'plan', title: 'Reproduce the defect' }),
        stage({ type: 'implement', title: 'Fix the defect', dependsOn: [0] }),
        stage({ type: 'review', title: 'Independent review', dependsOn: [1] }),
      ],
    },
    {
      name: 'Follow a pull request',
      description: 'Open the pull request and keep following its checks and reviews.',
      version: 1,
      builtIn: true,
      policy: mergeDelegationPolicy(defaultDelegationPolicy(), {
        autonomy: { commit: true, push: true, openPullRequest: true, comment: true },
        completionTarget: 'pr_ready',
      }),
      stages: [
        stage({ type: 'deliver', title: 'Open the pull request', action: { kind: 'deliver', mode: 'ready_pr', expectedCodeRevision: null } }),
        stage({ type: 'inspect', title: 'Follow checks and reviews', action: { kind: 'pull_request_status' }, dependsOn: [0] }),
      ],
    },
  ]
}
