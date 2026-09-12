import { createHash, randomUUID } from 'node:crypto'
import type {
  FrozenChatSelection,
  InternalTurnHandle,
  InternalTurnOutcome,
  MessagePart,
  ReviewLoopInfo,
  ReviewLoopParticipantInfo,
  ReviewLoopSeverityThreshold,
  StartPairedReviewLoopInput,
  StartPairedReviewLoopResult,
} from '../../../shared/chat'
import type { Conversation } from '../../store/conversations'
import type { LongCwdLease } from '../../cwd-activity-coordinator'
import type { ReviewFindingInput, WorkspaceSnapshot } from './types'
import { DEFAULT_MAX_ITERATIONS, HARD_MAX_ITERATIONS } from './types'
import { createReviewLoopGitRunner, fingerprintOf, snapshotWorkspace, type ReviewLoopGitRunner } from './workspace'
import { createReviewerRoundRecorder, type ReviewerRoundRecorder } from './reviewer-runtime'

export type PairedReviewLoopFinishReason =
  | 'clean'
  | 'max_iterations'
  | 'no_progress'
  | 'failed'
  | 'cancelled'
  | 'executor_unavailable'
  | 'reviewer_unavailable'
  | 'workspace_changed_externally'
  | 'review-decision-missing'
  | 'interrupted'

export interface ReviewLoopReservation {
  loopId: string
  driver: 'maestrly-pair'
  cwd: string
  participants: { executor: string; reviewer: string }
}

export interface PairedReviewLoopRegistry {
  reserve(reservation: ReviewLoopReservation): { ok: true } | { ok: false; error: string }
  release(loopId: string): void
  lockFor(conversationId: string): unknown | null
}

export interface PairedReviewTurnInput {
  conversationId: string
  prompt: string
  hiddenParts: MessagePart[]
  selection: FrozenChatSelection
  source: 'maestrly-review-loop'
  role: 'executor' | 'reviewer'
  turnPolicy: 'executor-agent' | 'reviewer-readonly'
  cwdActivityOwner: string
  loopId: string
  iteration: number
  maxIterations: number
  signal: AbortSignal
  reviewerRuntime?: ReviewerRoundRecorder
  executorConversationId: string
  reviewerConversationId: string
}

export interface ConversationReviewLoopDeps {
  getConversation(conversationId: string): Conversation | undefined
  listConversations(): Conversation[]
  canonicalCwd(cwd: string): string
  validateStart(conversationId: string): Promise<{ ok: true } | { ok: false; error: string }>
  resolveSelection(
    conversationId: string
  ): Promise<{ ok: true; selection: FrozenChatSelection } | { ok: false; error: string }>
  revalidateSelection(
    conversationId: string,
    selection: FrozenChatSelection
  ): Promise<{ ok: true } | { ok: false; error: string }>
  startTurn(
    input: PairedReviewTurnInput
  ): Promise<{ ok: true; handle: InternalTurnHandle } | { ok: false; error: string }>
  acquireLease(cwd: string, owner: string, allowedOwners: string[]): LongCwdLease | null
  registry: PairedReviewLoopRegistry
  searchExecutionContext(conversationId: string, input: { query: string; limit?: number }): unknown | Promise<unknown>
  readExecutionContext(
    conversationId: string,
    input: { around_seq: number; limit?: number }
  ): unknown | Promise<unknown>
  getExecutionBrief(conversationId: string): unknown | Promise<unknown>
  persistSummary(input: {
    conversationId: string
    loopId: string
    role: 'executor' | 'reviewer'
    executorConversationId: string
    reviewerConversationId: string
    markdown: string
  }): Promise<{ ok: true; messageId: string } | { ok: false; error: string }>
  runGit?: (cwd: string) => ReviewLoopGitRunner
  now?: () => number
  onChange?: (snapshots: ReviewLoopInfo[]) => void
  reviewerPrompt?: (input: { iteration: number; maxIterations: number }) => string
  executorPrompt?: (input: { iteration: number; maxIterations: number }) => string
}

interface RoundAudit {
  iteration: number
  role: 'reviewer' | 'executor'
  outcome: string
  summary?: string
  evidence?: { diff: number; search: number; read: number }
}

interface PairedReviewLoopState {
  loopId: string
  executorConversationId: string
  reviewerConversationId: string
  cwd: string
  executorSelection: FrozenChatSelection
  reviewerSelection: FrozenChatSelection
  iteration: number
  correctionsExecuted: number
  maxIterations: number
  severityThreshold: ReviewLoopSeverityThreshold
  activeRole: 'executor' | 'reviewer'
  status: ReviewLoopInfo['status']
  baseline: WorkspaceSnapshot
  expectedWorkspace: WorkspaceSnapshot
  startedAt: number
  finishedAt?: number
  finishReason?: PairedReviewLoopFinishReason
  activeHandle?: InternalTurnHandle
  jobStartedAt?: number
  controller: AbortController
  lease: LongCwdLease
  noProgressCount: number
  lastNoProgressFindingsFingerprint?: string
  lastFindings: ReviewFindingInput[]
  optionalFindings: ReviewFindingInput[]
  lastExecutorSummary?: string
  rounds: RoundAudit[]
  summaryPersisted: { executor: boolean; reviewer: boolean }
  teardown?: Promise<void>
  job?: Promise<void>
}

interface PendingStart {
  controller: AbortController
  participants: Set<string>
  done: Promise<void>
  settleDone(): void
}

const SEVERITY_RANK = { optional: 0, important: 1, blocking: 2 } as const
const HISTORY_LIMIT = 16
const BRIEF_LIMIT = 24_000

function boundedJson(value: unknown, limit = BRIEF_LIMIT): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (text.length <= limit) return text
  const half = Math.floor((limit - 40) / 2)
  return `${text.slice(0, half)}\n… [bounded by review loop host] …\n${text.slice(-half)}`
}

function findingsFingerprint(findings: readonly ReviewFindingInput[]): string {
  return createHash('sha256').update(JSON.stringify(findings)).digest('hex')
}

function relevantFindings(
  findings: readonly ReviewFindingInput[],
  threshold: ReviewLoopSeverityThreshold
): ReviewFindingInput[] {
  const minimum = threshold === 'blocking' ? 2 : 1
  return findings.filter((finding) => SEVERITY_RANK[finding.severity] >= minimum)
}

function participantInfo(conversation: Conversation, selection: FrozenChatSelection): ReviewLoopParticipantInfo {
  return {
    conversationId: conversation.id,
    name: conversation.name,
    modelId: selection.modelId,
    ...(selection.reasoning ? { reasoning: selection.reasoning } : {}),
    fastMode: selection.fastMode === true,
  }
}

function unavailableReason(role: 'executor' | 'reviewer', error: string): PairedReviewLoopFinishReason {
  if (/no-key|no-model|unavailable|not-authenticated/i.test(error)) {
    return role === 'executor' ? 'executor_unavailable' : 'reviewer_unavailable'
  }
  return 'failed'
}

function buildFindingsPart(loop: PairedReviewLoopState, findings: readonly ReviewFindingInput[]): MessagePart {
  const lines = [
    '# Structured review findings',
    '',
    `Loop: ${loop.loopId}`,
    `Correction: ${loop.correctionsExecuted + 1} of ${loop.maxIterations}`,
    '',
    ...findings.flatMap((finding) => [
      `## ${finding.id}: ${finding.title}`,
      `Severity: ${finding.severity}`,
      ...(finding.paths?.length ? [`Paths: ${finding.paths.join(', ')}`] : []),
      '',
      finding.details,
      '',
    ]),
  ]
  return {
    type: 'file',
    id: randomUUID(),
    name: 'review-loop-findings.md',
    mediaType: 'text/markdown',
    kind: 'text',
    data: lines.join('\n').slice(0, 80_000),
    hidden: true,
  }
}

function buildReviewerBriefPart(loop: PairedReviewLoopState, context: unknown): MessagePart {
  const payload = {
    iteration: loop.iteration,
    corrections_executed: loop.correctionsExecuted,
    max_corrections: loop.maxIterations,
    severity_threshold: loop.severityThreshold,
    requirement_context: context,
    previous_findings: loop.lastFindings,
    last_executor_summary: loop.lastExecutorSummary,
    instruction:
      'Investigate the current checkout afresh. Prior evidence does not count. Finish only through submit_review.',
  }
  return {
    type: 'file',
    id: randomUUID(),
    name: 'review-loop-brief.md',
    mediaType: 'text/markdown',
    kind: 'text',
    data: `# Review loop brief\n\n\`\`\`json\n${boundedJson(payload)}\n\`\`\``,
    hidden: true,
  }
}

function summaryMarkdown(loop: PairedReviewLoopState, role: 'executor' | 'reviewer'): string {
  const remaining = loop.lastFindings
  const roundLines = loop.rounds.map(
    (round) =>
      `- Round ${round.iteration} · ${round.role}: ${round.outcome}` +
      `${round.evidence ? ` (diff ${round.evidence.diff}, search ${round.evidence.search}, read ${round.evidence.read})` : ''}` +
      `${round.summary ? ` — ${round.summary}` : ''}`
  )
  return [
    '# Maestrly paired review loop',
    '',
    `- Loop: \`${loop.loopId}\``,
    `- This conversation: **${role}**`,
    `- Finish reason: **${loop.finishReason ?? 'failed'}**`,
    `- Corrections executed: ${loop.correctionsExecuted}/${loop.maxIterations}`,
    `- Executor model: \`${loop.executorSelection.providerId}/${loop.executorSelection.modelId}\` (${loop.executorSelection.reasoning ?? 'off'}${loop.executorSelection.fastMode ? ', Fast' : ''})`,
    `- Reviewer model: \`${loop.reviewerSelection.providerId}/${loop.reviewerSelection.modelId}\` (${loop.reviewerSelection.reasoning ?? 'off'}${loop.reviewerSelection.fastMode ? ', Fast' : ''})`,
    '',
    '## Rounds',
    '',
    ...(roundLines.length ? roundLines : ['- No completed rounds.']),
    '',
    '## Remaining findings',
    '',
    ...(remaining.length
      ? remaining.map((finding) => `- **${finding.severity}** ${finding.title}: ${finding.details}`)
      : ['- None.']),
    ...(loop.optionalFindings.length
      ? [
          '',
          '## Optional observations',
          '',
          ...loop.optionalFindings.map((finding) => `- ${finding.title}: ${finding.details}`),
        ]
      : []),
  ].join('\n')
}

export function createConversationReviewLoopCoordinator(deps: ConversationReviewLoopDeps) {
  const now = deps.now ?? Date.now
  const active = new Map<string, PairedReviewLoopState>()
  const terminal = new Map<string, PairedReviewLoopState>()
  const pendingByParticipant = new Map<string, PendingStart>()

  const allUnique = (): PairedReviewLoopState[] => {
    const byId = new Map<string, PairedReviewLoopState>()
    for (const state of active.values()) byId.set(state.loopId, state)
    for (const state of terminal.values()) byId.set(state.loopId, state)
    return [...byId.values()]
  }

  const project = (state: PairedReviewLoopState): ReviewLoopInfo => {
    const executor = deps.getConversation(state.executorConversationId)
    const reviewer = deps.getConversation(state.reviewerConversationId)
    return {
      loopId: state.loopId,
      driver: 'maestrly-pair',
      status: state.status,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      activeRole: state.activeRole,
      participants: {
        executor: executor
          ? participantInfo(executor, state.executorSelection)
          : {
              conversationId: state.executorConversationId,
              name: 'Executor',
              modelId: state.executorSelection.modelId,
              ...(state.executorSelection.reasoning ? { reasoning: state.executorSelection.reasoning } : {}),
              fastMode: state.executorSelection.fastMode,
            },
        reviewer: reviewer
          ? participantInfo(reviewer, state.reviewerSelection)
          : {
              conversationId: state.reviewerConversationId,
              name: 'Reviewer',
              modelId: state.reviewerSelection.modelId,
              ...(state.reviewerSelection.reasoning ? { reasoning: state.reviewerSelection.reasoning } : {}),
              fastMode: state.reviewerSelection.fastMode,
            },
      },
      startedAt: state.startedAt,
      ...(state.jobStartedAt ? { jobStartedAt: state.jobStartedAt } : {}),
      ...(state.finishReason ? { finishReason: state.finishReason } : {}),
    }
  }

  const notify = (): void => {
    try {
      deps.onChange?.(allUnique().map(project))
    } catch {
      // Renderer observers never own loop lifecycle.
    }
  }

  const rememberTerminal = (state: PairedReviewLoopState): void => {
    terminal.set(state.executorConversationId, state)
    terminal.set(state.reviewerConversationId, state)
    const unique = [...new Map([...terminal.values()].map((item) => [item.loopId, item])).values()]
    if (unique.length <= HISTORY_LIMIT) return
    const evict = unique.sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt))[0]
    if (!evict) return
    for (const [participant, item] of terminal) if (item.loopId === evict.loopId) terminal.delete(participant)
  }

  const forgetTerminalLoopsForParticipants = (participants: ReadonlySet<string>): void => {
    const loopIds = new Set(
      [...terminal.values()]
        .filter(
          (state) => participants.has(state.executorConversationId) || participants.has(state.reviewerConversationId)
        )
        .map((state) => state.loopId)
    )
    if (loopIds.size === 0) return
    for (const [participant, state] of terminal) {
      if (loopIds.has(state.loopId)) terminal.delete(participant)
    }
  }

  const persistSummaries = async (state: PairedReviewLoopState): Promise<void> => {
    for (const role of ['executor', 'reviewer'] as const) {
      if (state.summaryPersisted[role]) continue
      const conversationId = role === 'executor' ? state.executorConversationId : state.reviewerConversationId
      try {
        const result = await deps.persistSummary({
          conversationId,
          loopId: state.loopId,
          role,
          executorConversationId: state.executorConversationId,
          reviewerConversationId: state.reviewerConversationId,
          markdown: summaryMarkdown(state, role),
        })
        if (result.ok) state.summaryPersisted[role] = true
      } catch {
        // Summary persistence is auditable best-effort; it cannot strand the checkout lease.
      }
    }
  }

  const finish = async (state: PairedReviewLoopState, reason: PairedReviewLoopFinishReason): Promise<void> => {
    if (state.teardown) return state.teardown
    state.finishReason = reason
    const terminalStatus: ReviewLoopInfo['status'] = reason === 'cancelled' ? 'cancelled' : 'finished'
    state.status = reason === 'cancelled' ? 'cancelling' : 'finishing'
    state.finishedAt = now()
    state.activeHandle = undefined
    state.jobStartedAt = undefined
    notify()
    state.teardown = (async () => {
      try {
        await persistSummaries(state)
      } finally {
        active.delete(state.executorConversationId)
        active.delete(state.reviewerConversationId)
        state.lease.release()
        deps.registry.release(state.loopId)
        state.status = terminalStatus
        // Cancel is an explicit dismissal: the durable summaries remain in both conversations, but the
        // ephemeral banner/split projection must disappear instead of reopening whenever either chat is focused.
        if (reason !== 'cancelled' && reason !== 'interrupted') rememberTerminal(state)
        notify()
      }
    })()
    return state.teardown
  }

  const currentSnapshot = (state: PairedReviewLoopState): Promise<WorkspaceSnapshot> =>
    snapshotWorkspace({ cwd: state.cwd, runGit: deps.runGit?.(state.cwd) ?? createReviewLoopGitRunner(state.cwd) })

  const workspaceStillExpected = async (state: PairedReviewLoopState): Promise<boolean> => {
    const snapshot = await currentSnapshot(state)
    return fingerprintOf(snapshot) === fingerprintOf(state.expectedWorkspace)
  }

  const awaitTurn = async (
    state: PairedReviewLoopState,
    role: 'executor' | 'reviewer',
    input: Omit<PairedReviewTurnInput, 'signal'>
  ): Promise<InternalTurnOutcome | { status: 'start-error'; error: string }> => {
    if (state.controller.signal.aborted) return { status: 'cancelled', assistantMessageId: null }
    state.jobStartedAt = now()
    const started = await deps.startTurn({ ...input, signal: state.controller.signal })
    if (!started.ok) {
      state.jobStartedAt = undefined
      return { status: 'start-error', error: started.error }
    }
    state.activeHandle = started.handle
    notify()
    if (state.controller.signal.aborted) started.handle.cancel()
    const outcome = await started.handle.done
    if (state.activeHandle === started.handle) state.activeHandle = undefined
    state.jobStartedAt = undefined
    state.rounds.push({
      iteration: state.iteration,
      role,
      outcome: outcome.status,
      ...(outcome.status === 'success' && outcome.summaryText ? { summary: outcome.summaryText.slice(0, 2_000) } : {}),
      ...(role === 'reviewer' && input.reviewerRuntime
        ? {
            evidence: {
              diff: input.reviewerRuntime.evidence().diff,
              search: input.reviewerRuntime.evidence().search,
              read: input.reviewerRuntime.evidence().read,
            },
          }
        : {}),
    })
    return outcome
  }

  const run = async (state: PairedReviewLoopState): Promise<void> => {
    try {
      for (;;) {
        if (state.controller.signal.aborted) return await finish(state, 'cancelled')
        const workspaceExpected = await workspaceStillExpected(state)
        if (state.controller.signal.aborted) return await finish(state, 'cancelled')
        if (!workspaceExpected) return await finish(state, 'workspace_changed_externally')

        state.status = 'reviewing'
        state.activeRole = 'reviewer'
        notify()
        const reviewerAvailable = await deps.revalidateSelection(state.reviewerConversationId, state.reviewerSelection)
        if (state.controller.signal.aborted) return await finish(state, 'cancelled')
        if (!reviewerAvailable.ok) return await finish(state, 'reviewer_unavailable')

        let acceptedDecision: ReturnType<ReviewerRoundRecorder['decision']> = null
        const recorder = createReviewerRoundRecorder({
          owner: { loopId: state.loopId, iteration: state.iteration, participantRole: 'reviewer' },
          searchExecutionContext: (input) => deps.searchExecutionContext(state.executorConversationId, input),
          readExecutionContext: (input) => deps.readExecutionContext(state.executorConversationId, input),
          onAccepted: (decision) => {
            acceptedDecision = decision
          },
        })
        const brief = await deps.getExecutionBrief(state.executorConversationId)
        const reviewerOutcome = await awaitTurn(state, 'reviewer', {
          conversationId: state.reviewerConversationId,
          prompt:
            deps.reviewerPrompt?.({ iteration: state.iteration, maxIterations: state.maxIterations }) ??
            'Review the current code checkout. Use git_diff, at least one grep or glob, and read before calling submit_review exactly once.',
          hiddenParts: [buildReviewerBriefPart(state, brief)],
          selection: state.reviewerSelection,
          source: 'maestrly-review-loop',
          role: 'reviewer',
          turnPolicy: 'reviewer-readonly',
          cwdActivityOwner: `review-loop:${state.loopId}:reviewer`,
          loopId: state.loopId,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          reviewerRuntime: recorder,
          executorConversationId: state.executorConversationId,
          reviewerConversationId: state.reviewerConversationId,
        })
        if (state.controller.signal.aborted || reviewerOutcome.status === 'cancelled') {
          return await finish(state, 'cancelled')
        }
        if (reviewerOutcome.status === 'start-error') {
          return await finish(state, unavailableReason('reviewer', reviewerOutcome.error))
        }
        if (reviewerOutcome.status === 'error') {
          return await finish(state, unavailableReason('reviewer', reviewerOutcome.error))
        }
        const workspaceExpectedAfterReview = await workspaceStillExpected(state)
        if (state.controller.signal.aborted) return await finish(state, 'cancelled')
        if (!workspaceExpectedAfterReview) return await finish(state, 'workspace_changed_externally')
        const decision = acceptedDecision ?? recorder.decision() ?? reviewerOutcome.reviewDecision ?? null
        if (!decision) return await finish(state, 'review-decision-missing')

        const findings = (decision.findings ?? []) as ReviewFindingInput[]
        const actionable = relevantFindings(findings, state.severityThreshold)
        const actionableIds = new Set(actionable.map((finding) => finding.id))
        state.lastFindings = actionable
        state.optionalFindings = findings.filter((finding) => !actionableIds.has(finding.id))
        if (decision.result === 'clean' || actionable.length === 0) return await finish(state, 'clean')
        if (state.correctionsExecuted >= state.maxIterations) return await finish(state, 'max_iterations')

        const findingHash = findingsFingerprint(actionable)
        if (state.noProgressCount >= 1 && state.lastNoProgressFindingsFingerprint === findingHash) {
          return await finish(state, 'no_progress')
        }
        const workspaceExpectedBeforeFix = await workspaceStillExpected(state)
        if (state.controller.signal.aborted) return await finish(state, 'cancelled')
        if (!workspaceExpectedBeforeFix) return await finish(state, 'workspace_changed_externally')
        const executorAvailable = await deps.revalidateSelection(state.executorConversationId, state.executorSelection)
        if (state.controller.signal.aborted) return await finish(state, 'cancelled')
        if (!executorAvailable.ok) return await finish(state, 'executor_unavailable')

        state.status = 'executing'
        state.activeRole = 'executor'
        notify()
        const before = state.expectedWorkspace
        const executorOutcome = await awaitTurn(state, 'executor', {
          conversationId: state.executorConversationId,
          prompt:
            deps.executorPrompt?.({
              iteration: state.correctionsExecuted + 1,
              maxIterations: state.maxIterations,
            }) ??
            `Implement the structured review findings for correction ${state.correctionsExecuted + 1} of ${state.maxIterations}. Verify the changes before finishing.`,
          hiddenParts: [buildFindingsPart(state, actionable)],
          selection: state.executorSelection,
          source: 'maestrly-review-loop',
          role: 'executor',
          turnPolicy: 'executor-agent',
          cwdActivityOwner: `review-loop:${state.loopId}:executor`,
          loopId: state.loopId,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          executorConversationId: state.executorConversationId,
          reviewerConversationId: state.reviewerConversationId,
        })
        if (executorOutcome.status === 'start-error') {
          return await finish(state, unavailableReason('executor', executorOutcome.error))
        }
        state.correctionsExecuted++
        if (state.controller.signal.aborted || executorOutcome.status === 'cancelled') {
          return await finish(state, 'cancelled')
        }
        if (executorOutcome.status === 'error') {
          return await finish(state, unavailableReason('executor', executorOutcome.error))
        }
        state.lastExecutorSummary = executorOutcome.summaryText?.slice(0, 2_000)
        const after = await currentSnapshot(state)
        const madeProgress = fingerprintOf(before) !== fingerprintOf(after)
        state.expectedWorkspace = after
        if (madeProgress) {
          state.noProgressCount = 0
          state.lastNoProgressFindingsFingerprint = undefined
        } else {
          state.noProgressCount++
          state.lastNoProgressFindingsFingerprint = findingHash
          if (state.noProgressCount >= 2) return await finish(state, 'no_progress')
        }
        state.iteration++
        // Deliberately loop back even after the last allowed correction: the next reviewer turn is the
        // mandatory final read-only audit and can still declare clean.
      }
    } catch {
      await finish(state, state.controller.signal.aborted ? 'cancelled' : 'failed')
    }
  }

  const preflightConversation = (conversation: Conversation | undefined): string | null => {
    if (!conversation) return 'invalid-conversation'
    if (conversation.archived !== 0) return 'conversation-archived'
    return null
  }

  const start = async (input: StartPairedReviewLoopInput): Promise<StartPairedReviewLoopResult> => {
    const executorId = typeof input.executorConversationId === 'string' ? input.executorConversationId : ''
    const reviewerId = typeof input.reviewerConversationId === 'string' ? input.reviewerConversationId : ''
    if (!executorId || !reviewerId) return { ok: false, error: 'invalid-input' }
    if (executorId === reviewerId) return { ok: false, error: 'participants-must-be-distinct' }
    const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > HARD_MAX_ITERATIONS) {
      return { ok: false, error: 'invalid-max-iterations' }
    }
    const severityThreshold = input.severityThreshold ?? 'important'
    if (severityThreshold !== 'blocking' && severityThreshold !== 'important') {
      return { ok: false, error: 'invalid-severity-threshold' }
    }
    if (pendingByParticipant.has(executorId) || pendingByParticipant.has(reviewerId)) {
      return { ok: false, error: 'review-loop-active' }
    }
    let settlePending!: () => void
    const pendingDone = new Promise<void>((resolve) => {
      settlePending = resolve
    })
    const pending: PendingStart = {
      controller: new AbortController(),
      participants: new Set([executorId, reviewerId]),
      done: pendingDone,
      settleDone: settlePending,
    }
    pendingByParticipant.set(executorId, pending)
    pendingByParticipant.set(reviewerId, pending)
    const clearPending = () => {
      for (const participant of pending.participants) {
        if (pendingByParticipant.get(participant) === pending) pendingByParticipant.delete(participant)
      }
    }

    let reservedLoopId: string | null = null
    let lease: LongCwdLease | null = null
    try {
      const executor = deps.getConversation(executorId)
      const reviewer = deps.getConversation(reviewerId)
      const executorError = preflightConversation(executor)
      if (executorError) return { ok: false, error: executorError }
      const reviewerError = preflightConversation(reviewer)
      if (reviewerError) return { ok: false, error: reviewerError }
      if (executor!.workspaceId !== reviewer!.workspaceId) return { ok: false, error: 'project-mismatch' }
      const cwd = deps.canonicalCwd(executor!.cwd)
      if (cwd !== deps.canonicalCwd(reviewer!.cwd)) return { ok: false, error: 'cwd-mismatch' }

      const [executorReady, reviewerReady] = await Promise.all([
        deps.validateStart(executorId),
        deps.validateStart(reviewerId),
      ])
      if (!executorReady.ok) return { ok: false, error: `executor:${executorReady.error}` }
      if (!reviewerReady.ok) return { ok: false, error: `reviewer:${reviewerReady.error}` }
      if (pending.controller.signal.aborted) return { ok: false, error: 'cancelled' }

      const [executorResolved, reviewerResolved] = await Promise.all([
        deps.resolveSelection(executorId),
        deps.resolveSelection(reviewerId),
      ])
      if (!executorResolved.ok) return { ok: false, error: `executor:${executorResolved.error}` }
      if (!reviewerResolved.ok) return { ok: false, error: `reviewer:${reviewerResolved.error}` }
      if (pending.controller.signal.aborted) return { ok: false, error: 'cancelled' }

      const loopId = `rl_pair_${randomUUID()}`
      const reservation: ReviewLoopReservation = {
        loopId,
        driver: 'maestrly-pair',
        cwd,
        participants: { executor: executorId, reviewer: reviewerId },
      }
      const reserved = deps.registry.reserve(reservation)
      if (!reserved.ok) return { ok: false, error: reserved.error }
      reservedLoopId = loopId
      const owner = `review-loop:${loopId}`
      lease = deps.acquireLease(cwd, owner, [`${owner}:reviewer`, `${owner}:executor`])
      if (!lease) return { ok: false, error: 'cwd-locked' }
      if (pending.controller.signal.aborted) return { ok: false, error: 'cancelled' }

      const runGit = deps.runGit?.(cwd) ?? createReviewLoopGitRunner(cwd)
      const baseline = await snapshotWorkspace({ cwd, runGit })
      if (pending.controller.signal.aborted) return { ok: false, error: 'cancelled' }
      const state: PairedReviewLoopState = {
        loopId,
        executorConversationId: executorId,
        reviewerConversationId: reviewerId,
        cwd,
        executorSelection: executorResolved.selection,
        reviewerSelection: reviewerResolved.selection,
        iteration: 1,
        correctionsExecuted: 0,
        maxIterations,
        severityThreshold,
        activeRole: 'reviewer',
        status: 'reviewing',
        baseline,
        expectedWorkspace: baseline,
        startedAt: now(),
        controller: pending.controller,
        lease,
        noProgressCount: 0,
        lastFindings: [],
        optionalFindings: [],
        rounds: [],
        summaryPersisted: { executor: false, reviewer: false },
      }
      forgetTerminalLoopsForParticipants(new Set([executorId, reviewerId]))
      active.set(executorId, state)
      active.set(reviewerId, state)
      clearPending()
      reservedLoopId = null
      lease = null
      notify()
      state.job = run(state)
      void state.job
      return { ok: true, loop: project(state) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearPending()
      lease?.release()
      if (reservedLoopId) deps.registry.release(reservedLoopId)
      pending.settleDone()
    }
  }

  const stop = (conversationId: string): boolean => {
    const pending = pendingByParticipant.get(conversationId)
    if (pending) {
      pending.controller.abort()
      return true
    }
    const state = active.get(conversationId)
    if (!state) return false
    if (
      state.teardown ||
      state.status === 'finished' ||
      state.status === 'cancelled' ||
      state.status === 'interrupted'
    ) {
      return true
    }
    if (state.controller.signal.aborted) return false
    state.status = 'cancelling'
    state.controller.abort()
    state.activeHandle?.cancel()
    notify()
    return true
  }

  const status = (conversationId?: string): ReviewLoopInfo | null => {
    if (conversationId) {
      const state = active.get(conversationId) ?? terminal.get(conversationId)
      return state ? project(state) : null
    }
    const state = active.values().next().value as PairedReviewLoopState | undefined
    return state ? project(state) : null
  }

  const statuses = (): ReviewLoopInfo[] => allUnique().map(project)

  const compatible = async (executorConversationId: string): Promise<ReviewLoopParticipantInfo[]> => {
    const executor = deps.getConversation(executorConversationId)
    if (preflightConversation(executor)) return []
    if (deps.registry.lockFor(executorConversationId) || pendingByParticipant.has(executorConversationId)) return []
    const executorReady = await deps.validateStart(executorConversationId)
    if (!executorReady.ok) return []
    const executorSelection = await deps.resolveSelection(executorConversationId)
    if (!executorSelection.ok) return []
    const cwd = deps.canonicalCwd(executor!.cwd)
    const out: ReviewLoopParticipantInfo[] = []
    for (const candidate of deps.listConversations()) {
      if (candidate.id === executorConversationId || preflightConversation(candidate)) continue
      if (candidate.workspaceId !== executor!.workspaceId) continue
      if (deps.canonicalCwd(candidate.cwd) !== cwd) continue
      if (deps.registry.lockFor(candidate.id) || pendingByParticipant.has(candidate.id)) continue
      const ready = await deps.validateStart(candidate.id)
      if (!ready.ok) continue
      const resolved = await deps.resolveSelection(candidate.id)
      if (!resolved.ok) continue
      out.push(participantInfo(candidate, resolved.selection))
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  const dispose = async (): Promise<void> => {
    const states = [...new Set(active.values())]
    const pendingStarts = [...new Set(pendingByParticipant.values())]
    for (const state of states) {
      state.controller.abort()
      state.activeHandle?.cancel()
    }
    for (const pending of pendingStarts) pending.controller.abort()
    pendingByParticipant.clear()
    await Promise.allSettled([
      ...states.map((state) => state.job ?? state.teardown ?? Promise.resolve()),
      ...pendingStarts.map((pending) => pending.done),
    ])
  }

  return { start, stop, status, statuses, compatible, dispose }
}

export type ConversationReviewLoopCoordinator = ReturnType<typeof createConversationReviewLoopCoordinator>
