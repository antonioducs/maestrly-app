import { z } from 'zod'
import { agentStageSettingsSchema, agentStageSettingsPatchSchema } from './delegation-models.js'
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
