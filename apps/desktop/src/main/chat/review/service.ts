import { randomUUID } from 'node:crypto'
import type { ToolSet } from 'ai'
import {
  CODE_REVIEW_LENSES,
  PLAN_REVIEW_LENSES,
  isReviewDecision,
  parseReviewModelChoice,
  reviewActedFindings,
  reviewDecisionsFor,
  reviewLocksConversation,
  type ChatReviewReport,
  type ReviewActivity,
  type ReviewDraft,
  type ReviewDroppedCandidate,
  type ReviewFinding,
  type ReviewHandoffAction,
  type ReviewHandoffResult,
  type ReviewJobInfo,
  type ReviewLane,
  type ReviewModelInfo,
  type ReviewPrepareResult,
  type ReviewReviewerOptions,
  type ReviewSendReportResult,
  type ReviewStartResult,
  type ReviewTarget,
} from '../../../shared/review'
import type { SubagentExecutionSnapshotV1 } from '../../../shared/subagent-profiles'
import type { ChatAgent } from '../agents'
import type { SubagentSessionRecorder } from '../subagent-session'
import { createReviewActivityRecorder } from './activity'
import {
  ReviewEngineError,
  runReviewCheck,
  runReviewEngine,
  type ReviewUsage,
  type ReviewerRunInput,
  type ReviewerRunResult,
} from './engine'
import {
  createCheckCollector,
  createFindingsCollector,
  createVerdictCollector,
  parseSubmissionFromText,
} from './findings'
import { gitDiffTool, readDiffStats } from './git-diff'
import { REVIEWER_SYSTEM_PROMPT, reviewLanguage, type CheckFinding, type ReviewPromptContext } from './prompts'
import { codeScope, planScope, withSnippets } from './scope'

/** Read-only reviewer: core read tools plus the host tools each review supplies. */
export const REVIEWER_AGENT: ChatAgent = {
  name: 'reviewer',
  description: 'Independent read-only reviewer used by Maestrly code and plan reviews.',
  tools: ['read', 'grep', 'glob', 'git_diff', 'submit_findings', 'record_verdicts', 'record_checks'],
  prompt: REVIEWER_SYSTEM_PROMPT,
  source: 'built-in',
}

/** Conversation the review belongs to, as the service needs it. */
export interface ReviewConversation {
  id: string
  cwd: string
  projectId: string | null
  archived: boolean
}

export interface ReviewSelection {
  providerId: string
  modelId: string
  reasoning?: string
  fastMode: boolean
}

export interface ReviewSpend {
  usage: ReviewUsage
  runtimeEstimatedCostUsd: number
}

export interface ReviewServiceDeps {
  getConversation(conversationId: string): ReviewConversation | null
  /** A turn or operation is running in the conversation. */
  isBusy(conversationId: string): boolean
  pendingPlan(conversationId: string): { plan: string; version: number } | null
  /** The conversation's own model, effort and Fast setting, used when no reviewer model is chosen. */
  selection(conversationId: string): ReviewSelection | null
  /** The models the first stage offers. */
  reviewerOptions(conversationId: string): ReviewReviewerOptions
  /**
   * `chosen` marks a model the person picked for the review: its Fast setting is validated against the model like
   * any explicit subagent profile, instead of being inherited from the conversation.
   */
  resolveProfile(selection: ReviewSelection, options: { chosen: boolean }): Promise<SubagentExecutionSnapshotV1>
  /** Whether a provider can run reviewers at all; ChatGPT Web, for one, cannot. */
  reviewerProviderSupported?(providerId: string): boolean
  /** User-visible conversation excerpt used to understand intent. */
  conversationContext(conversationId: string): string
  locale(): string
  runReviewer(input: {
    conversation: ReviewConversation
    profile: SubagentExecutionSnapshotV1
    task: string
    tools: ToolSet
    signal: AbortSignal
    recorder: SubagentSessionRecorder
  }): Promise<{ text: string; error?: string; usage?: ReviewUsage; runtimeEstimatedCostUsd?: number }>
  /** Stores the review receipt in the conversation, with the review's usage, and returns the message id. */
  persistReport(input: { conversationId: string; report: ChatReviewReport; spend: ReviewSpend }): string
  getReport(conversationId: string, messageId: string): ChatReviewReport | null
  /** Rewrites a stored receipt (delivery, check results), keeping its usage. */
  updateReport(conversationId: string, messageId: string, report: ChatReviewReport): void
  /** Bills what a review spent when it ends without a receipt, and what a check spent. */
  persistSpend(input: { conversationId: string; spend: ReviewSpend; model?: ReviewModelInfo }): void
  onChange(info: ReviewJobInfo): void
  readStats?: typeof readDiffStats
  now?: () => number
  /** Minimum interval between progress events of one review; terminal changes are sent at once. */
  publishIntervalMs?: number
}

interface Job {
  info: ReviewJobInfo
  conversation: ReviewConversation
  controller: AbortController
  done: Promise<void>
  /** Resolves when the job stops holding the conversation. */
  released: Promise<void>
  release: () => void
  spend: ReviewSpend
  /** The plan text that was reviewed. */
  plan?: string
  dropped: ReviewDroppedCandidate[]
  /** Discarding a running review: it ends as discarded, not cancelled. */
  discarding?: boolean
  publishTimer?: ReturnType<typeof setTimeout>
  lastPublish: number
}

const CONTEXT_LIMIT = 24_000
const ACTIVITY_LIMIT = 40
const NOTE_LIMIT = 1_000
const COMMENT_LIMIT = 4_000
const MESSAGE_LIMIT = 20_000

function boundedContext(text: string): string {
  if (text.length <= CONTEXT_LIMIT) return text
  return `… [earlier context omitted] …\n${text.slice(-CONTEXT_LIMIT)}`
}

function emptySpend(): ReviewSpend {
  return { usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 }, runtimeEstimatedCostUsd: 0 }
}

function addSpend(total: ReviewSpend, usage: ReviewUsage | undefined, cost: number | undefined): void {
  if (usage) {
    for (const key of ['input', 'output', 'cacheRead', 'cacheCreate', 'totalInput'] as const) {
      const value = usage[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) total.usage[key] += value
    }
  }
  if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) total.runtimeEstimatedCostUsd += cost
}

function hasSpend(spend: ReviewSpend): boolean {
  const { usage } = spend
  return (
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheCreate > 0 ||
    spend.runtimeEstimatedCostUsd > 0
  )
}

/** The comment a plan finding starts as; the person edits it before sending. */
export function defaultPlanComment(finding: ReviewFinding): string {
  return [finding.title, finding.suggestion ?? finding.details].filter(Boolean).join('\n\n').slice(0, COMMENT_LIMIT)
}

function emptyDraft(target: ReviewTarget, findings: readonly ReviewFinding[]): ReviewDraft {
  return {
    decisions: {},
    notes: {},
    comments:
      target === 'plan' ? Object.fromEntries(findings.map((finding) => [finding.id, defaultPlanComment(finding)])) : {},
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function targetOf(value: unknown): ReviewTarget | null {
  return value === 'code' || value === 'plan' ? value : null
}

export function createReviewService(deps: ReviewServiceDeps) {
  const now = deps.now ?? Date.now
  const readStats = deps.readStats ?? readDiffStats
  const publishInterval = deps.publishIntervalMs ?? 120
  const jobs = new Map<string, Job>()
  const starting = new Set<string>()

  const snapshot = (info: ReviewJobInfo): ReviewJobInfo => structuredClone(info)

  const emit = (job: Job): void => {
    if (job.publishTimer) clearTimeout(job.publishTimer)
    job.publishTimer = undefined
    job.lastPublish = now()
    try {
      deps.onChange(snapshot(job.info))
    } catch {
      // Observers never own the review lifecycle.
    }
  }

  /** Progress is coalesced; status changes are sent at once. */
  const publish = (job: Job, immediate = false): void => {
    if (immediate || publishInterval <= 0) return emit(job)
    if (job.publishTimer) return
    const wait = Math.max(0, job.lastPublish + publishInterval - now())
    if (wait === 0) return emit(job)
    job.publishTimer = setTimeout(() => emit(job), wait)
    job.publishTimer.unref?.()
  }

  const recordActivity = (job: Job, lane: ReviewLane, activity: ReviewActivity): void => {
    const list = job.info.activity[lane] ?? []
    const index = list.findIndex((item) => item.id === activity.id)
    if (index >= 0) list[index] = activity
    else list.push(activity)
    if (list.length > ACTIVITY_LIMIT) list.splice(0, list.length - ACTIVITY_LIMIT)
    job.info.activity[lane] = list
    publish(job)
  }

  /** Leaves the conversation free: the job is over, or it now waits only for nothing that holds it. */
  const settle = (job: Job, status: ReviewJobInfo['status'], extra: Partial<ReviewJobInfo> = {}): void => {
    Object.assign(job.info, extra, { status, finishedAt: now() })
    if (!reviewLocksConversation(job.info)) job.release()
    publish(job, true)
  }

  const createJob = (info: ReviewJobInfo, conversation: ReviewConversation, plan?: string): Job => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const job: Job = {
      info,
      conversation,
      controller: new AbortController(),
      done: Promise.resolve(),
      released,
      release,
      spend: emptySpend(),
      ...(plan !== undefined ? { plan } : {}),
      dropped: [],
      lastPublish: 0,
    }
    jobs.set(info.conversationId, job)
    return job
  }

  const billUnreceipted = (job: Job): void => {
    if (!hasSpend(job.spend)) return
    try {
      deps.persistSpend({ conversationId: job.conversation.id, spend: job.spend, model: job.info.model })
    } catch {
      // Billing is best effort; it never keeps a review from ending.
    }
    job.spend = emptySpend()
  }

  const promptContext = (
    conversation: ReviewConversation,
    target: ReviewTarget,
    plan?: string
  ): ReviewPromptContext => ({
    target,
    conversation: boundedContext(deps.conversationContext(conversation.id)),
    ...(plan !== undefined ? { plan } : {}),
    language: reviewLanguage(deps.locale()),
  })

  const runReviewer =
    (job: Job, profile: SubagentExecutionSnapshotV1) =>
    async (input: ReviewerRunInput): Promise<ReviewerRunResult> => {
      const { conversation, info } = job
      const lane: ReviewLane = input.stage === 'lens' ? input.lens : 'verifier'
      const recorder = createReviewActivityRecorder({
        cwd: conversation.cwd,
        emit: (activity) => recordActivity(job, lane, activity),
      })
      const gitTools: ToolSet = info.target === 'code' ? { git_diff: gitDiffTool(conversation.cwd) } : {}
      const finish = (
        run: Awaited<ReturnType<ReviewServiceDeps['runReviewer']>>,
        outcome: Omit<ReviewerRunResult, 'usage' | 'runtimeEstimatedCostUsd'>
      ): ReviewerRunResult => {
        addSpend(job.spend, run.usage, run.runtimeEstimatedCostUsd)
        return {
          ...outcome,
          ...(run.usage ? { usage: run.usage } : {}),
          ...(run.runtimeEstimatedCostUsd !== undefined
            ? { runtimeEstimatedCostUsd: run.runtimeEstimatedCostUsd }
            : {}),
        }
      }
      if (input.stage === 'lens') {
        const collector = createFindingsCollector(conversation.cwd, input.onSubmission)
        const run = await deps.runReviewer({
          conversation,
          profile,
          task: input.task,
          tools: { submit_findings: collector.tool, ...gitTools },
          signal: input.signal,
          recorder,
        })
        const submission = collector.submission() ?? parseSubmissionFromText(run.text, conversation.cwd)
        return finish(run, {
          submission,
          ...(submission ? {} : { error: run.error ?? 'The reviewer finished without submitting findings.' }),
        })
      }
      if (input.stage === 'verifier') {
        const collector = createVerdictCollector(conversation.cwd, input.candidateIds, input.onVerdicts)
        const run = await deps.runReviewer({
          conversation,
          profile,
          task: input.task,
          tools: { record_verdicts: collector.tool, ...gitTools },
          signal: input.signal,
          recorder,
        })
        const verdicts = collector.verdicts()
        return finish(run, {
          verdicts,
          ...(run.error || verdicts.length === 0
            ? { error: run.error ?? 'The verifier finished without recording verdicts.' }
            : {}),
        })
      }
      const collector = createCheckCollector(input.findingIds, input.onResults)
      const run = await deps.runReviewer({
        conversation,
        profile,
        task: input.task,
        tools: { record_checks: collector.tool, ...gitTools },
        signal: input.signal,
        recorder,
      })
      const results = collector.results()
      return finish(run, {
        results,
        ...(run.error || results.length === 0
          ? { error: run.error ?? 'The check finished without recording results.' }
          : {}),
      })
    }

  const runJob = async (job: Job, profile: SubagentExecutionSnapshotV1): Promise<void> => {
    const { info, controller, conversation } = job
    try {
      const result = await runReviewEngine({
        target: info.target,
        lenses: info.target === 'code' ? CODE_REVIEW_LENSES : PLAN_REVIEW_LENSES,
        context: promptContext(conversation, info.target, job.plan),
        signal: controller.signal,
        runReviewer: runReviewer(job, profile),
        onProgress: (progress) => {
          info.lenses = progress.lenses
          info.verification = progress.verification
          info.candidateList = progress.candidates
          info.verdicts = progress.verdicts
          info.candidates = progress.candidates.length
          if (progress.verification === 'running' && info.status === 'running') {
            info.status = 'verifying'
            publish(job, true)
          } else publish(job)
        },
      })
      if (controller.signal.aborted) throw new ReviewEngineError('cancelled')
      if (info.target === 'plan') {
        // The conversation was held, so the plan cannot have changed; refuse to anchor comments if it somehow did.
        const current = deps.pendingPlan(conversation.id)
        if (!current || current.version !== info.planVersion || current.plan !== job.plan) {
          billUnreceipted(job)
          settle(job, 'failed', { error: 'plan-changed' })
          return
        }
      }
      const findings = await withSnippets(result.findings, {
        cwd: conversation.cwd,
        ...(job.plan !== undefined ? { plan: job.plan } : {}),
      })
      job.dropped = result.dropped
      info.lenses = result.lenses
      info.verification = result.verification
      info.candidateList = result.candidates
      info.verdicts = result.verdicts
      info.candidates = result.candidates.length
      info.findings = findings
      info.draft = emptyDraft(info.target, findings)
      if (result.failedLenses.length) info.failedLenses = result.failedLenses
      if (result.unverified) info.unverified = true
      if (controller.signal.aborted) throw new ReviewEngineError('cancelled')
      settle(job, 'ready')
    } catch (error) {
      billUnreceipted(job)
      if (job.discarding) settle(job, 'discarded')
      else if (controller.signal.aborted || (error instanceof ReviewEngineError && error.code === 'cancelled')) {
        settle(job, 'cancelled')
      } else settle(job, 'failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const resolveModel = async (
    selection: ReviewSelection,
    chosen: boolean
  ): Promise<
    { ok: true; profile: SubagentExecutionSnapshotV1; model: ReviewModelInfo } | { ok: false; error: string }
  > => {
    const profile = await deps.resolveProfile(selection, { chosen })
    if (!profile.effective) {
      const diagnostic = profile.attempts
        .flatMap((attempt) => attempt.diagnostics)
        .find((item) => item.severity === 'error')
      return { ok: false, error: diagnostic?.message ?? 'agent-unavailable' }
    }
    return {
      ok: true,
      profile,
      model: {
        providerId: profile.effective.providerId,
        modelId: profile.effective.modelId,
        ...(profile.effective.configuredEffort && profile.effective.configuredEffort !== 'off'
          ? { reasoning: profile.effective.configuredEffort }
          : {}),
        ...(profile.effective.fastMode ? { fastMode: true } : {}),
      },
    }
  }

  /** Why a review cannot start in this conversation right now, or null. */
  const blocker = (conversationId: string, conversation: ReviewConversation | null): string | null => {
    if (!conversation) return 'invalid-conversation'
    if (conversation.archived) return 'conversation-archived'
    if (starting.has(conversationId) || reviewLocksConversation(jobs.get(conversationId)?.info)) return 'review-active'
    if (deps.isBusy(conversationId)) return 'conversation-busy'
    return null
  }

  const readScope = async (
    conversation: ReviewConversation,
    target: ReviewTarget
  ): Promise<
    | { ok: true; scope: ReviewJobInfo['scope'] & object; plan?: { plan: string; version: number } }
    | { ok: false; error: string }
  > => {
    if (target === 'code') {
      const stats = await readStats(conversation.cwd)
      if (!stats.repository) return { ok: false, error: 'not-a-repository' }
      if (stats.files.length === 0) return { ok: false, error: 'nothing-to-review' }
      return { ok: true, scope: codeScope(stats) }
    }
    const plan = deps.pendingPlan(conversation.id)
    if (!plan?.plan.trim()) return { ok: false, error: 'no-pending-plan' }
    return { ok: true, scope: planScope(plan.plan, plan.version), plan }
  }

  /** What the first stage shows: what will be reviewed and who can review it. Nothing runs and nothing is held. */
  const prepare = async (conversationId: unknown, rawTarget: unknown): Promise<ReviewPrepareResult> => {
    if (typeof conversationId !== 'string' || !conversationId) return { ok: false, error: 'invalid-conversation' }
    const target = targetOf(rawTarget)
    if (!target) return { ok: false, error: 'invalid-input' }
    const conversation = deps.getConversation(conversationId)
    const blocked = blocker(conversationId, conversation)
    if (blocked) return { ok: false, error: blocked }
    try {
      const scope = await readScope(conversation!, target)
      if (!scope.ok) return scope
      return {
        ok: true,
        scope: scope.scope,
        reviewer: deps.reviewerOptions(conversationId),
        lenses: [...(target === 'code' ? CODE_REVIEW_LENSES : PLAN_REVIEW_LENSES)],
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const start = async (conversationId: unknown, input: unknown): Promise<ReviewStartResult> => {
    if (typeof conversationId !== 'string' || !conversationId) return { ok: false, error: 'invalid-conversation' }
    const target = targetOf(record(input)?.target)
    if (!target) return { ok: false, error: 'invalid-input' }
    const rawReviewer = record(input)?.reviewer
    const reviewer = rawReviewer === undefined ? null : parseReviewModelChoice(rawReviewer)
    if (rawReviewer !== undefined && !reviewer) return { ok: false, error: 'invalid-reviewer' }
    if (reviewer && deps.reviewerProviderSupported?.(reviewer.providerId) === false) {
      return { ok: false, error: 'reviewer-unsupported' }
    }
    const conversation = deps.getConversation(conversationId)
    const blocked = blocker(conversationId, conversation)
    if (blocked) return { ok: false, error: blocked }
    starting.add(conversationId)
    try {
      const scope = await readScope(conversation!, target)
      if (!scope.ok) return scope
      const selection = reviewer ?? deps.selection(conversationId)
      if (!selection) return { ok: false, error: 'no-model' }
      const resolved = await resolveModel(selection, !!reviewer)
      if (!resolved.ok) return resolved
      // Nothing else may have started while the scope and the model were resolved.
      if (deps.isBusy(conversationId)) return { ok: false, error: 'conversation-busy' }
      const info: ReviewJobInfo = {
        reviewId: randomUUID(),
        conversationId,
        kind: 'review',
        target,
        status: 'running',
        startedAt: now(),
        model: resolved.model,
        lenses: (target === 'code' ? CODE_REVIEW_LENSES : PLAN_REVIEW_LENSES).map((id) => ({ id, status: 'pending' })),
        verification: 'pending',
        activity: {},
        candidateList: [],
        verdicts: [],
        scope: scope.scope,
        ...(scope.plan ? { planVersion: scope.plan.version } : {}),
      }
      const job = createJob(info, conversation!, scope.plan?.plan)
      publish(job, true)
      job.done = runJob(job, resolved.profile)
      return { ok: true, review: snapshot(info) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      starting.delete(conversationId)
    }
  }

  const jobFor = (conversationId: unknown, reviewId?: unknown): Job | null => {
    if (typeof conversationId !== 'string') return null
    const job = jobs.get(conversationId)
    if (!job) return null
    if (reviewId !== undefined && job.info.reviewId !== reviewId) return null
    return job
  }

  /** Stops a running review or check; nothing is handed off. */
  const cancel = (conversationId: unknown): { ok: boolean } => {
    const job = jobFor(conversationId)
    if (!job || (job.info.status !== 'running' && job.info.status !== 'verifying')) return { ok: false }
    job.controller.abort()
    return { ok: true }
  }

  /** Ends a review without handing anything off: a running one stops, a ready one is dropped. */
  const discard = (conversationId: unknown, reviewId: unknown): { ok: boolean } => {
    const job = jobFor(conversationId, reviewId)
    if (job?.info.kind !== 'review' || !reviewLocksConversation(job.info)) return { ok: false }
    if (job.info.status === 'ready') {
      billUnreceipted(job)
      settle(job, 'discarded')
    } else {
      job.discarding = true
      job.controller.abort()
    }
    return { ok: true }
  }

  const status = (conversationId: unknown): ReviewJobInfo | null => {
    const job = jobFor(conversationId)
    return job ? snapshot(job.info) : null
  }

  /** Records decisions, dismissal notes and plan comments while the review is open. */
  const updateDraft = (conversationId: unknown, input: unknown): { ok: boolean; error?: string } => {
    const value = record(input)
    const job = jobFor(conversationId, value?.reviewId)
    if (!value || !job || job.info.status !== 'ready' || !job.info.draft) return { ok: false, error: 'review-not-open' }
    const ids = new Set((job.info.findings ?? []).map((finding) => finding.id))
    const allowed = new Set(reviewDecisionsFor(job.info.target))
    const draft = job.info.draft
    for (const [id, decision] of Object.entries(record(value.decisions) ?? {})) {
      if (!ids.has(id)) continue
      if (decision === null) delete draft.decisions[id]
      else if (isReviewDecision(decision) && allowed.has(decision)) draft.decisions[id] = decision
    }
    for (const [id, note] of Object.entries(record(value.notes) ?? {})) {
      if (!ids.has(id) || typeof note !== 'string') continue
      if (note.trim()) draft.notes[id] = note.slice(0, NOTE_LIMIT)
      else delete draft.notes[id]
    }
    if (job.info.target === 'plan') {
      for (const [id, comment] of Object.entries(record(value.comments) ?? {})) {
        if (ids.has(id) && typeof comment === 'string') draft.comments[id] = comment.slice(0, COMMENT_LIMIT)
      }
    }
    publish(job)
    return { ok: true }
  }

  const receipt = (job: Job, action: ReviewHandoffAction, message?: string): ChatReviewReport => {
    const { info } = job
    const findings = info.findings ?? []
    const draft = info.draft ?? emptyDraft(info.target, findings)
    const comments = Object.fromEntries(
      Object.entries(draft.comments).filter(([id, text]) => draft.decisions[id] === 'comment' && text.trim())
    )
    const at = now()
    const state =
      action === 'send' ? 'sent' : action === 'save' ? 'saved' : action === 'revise' ? 'revised' : 'approved'
    return {
      reviewId: info.reviewId,
      target: info.target,
      findings,
      candidates: info.candidates ?? findings.length,
      ...(info.unverified ? { unverified: true } : {}),
      ...(info.failedLenses?.length ? { failedLenses: info.failedLenses } : {}),
      ...(info.model ? { model: info.model } : {}),
      startedAt: info.startedAt,
      finishedAt: info.finishedAt ?? at,
      ...(info.scope?.kind === 'code' ? { scope: { branch: info.scope.branch, head: info.scope.head } } : {}),
      ...(info.planVersion ? { planVersion: info.planVersion } : {}),
      ...(Object.keys(draft.decisions).length ? { decisions: { ...draft.decisions } } : {}),
      ...(Object.keys(draft.notes).length ? { notes: { ...draft.notes } } : {}),
      ...(Object.keys(comments).length ? { comments } : {}),
      ...(job.dropped.length ? { dropped: job.dropped } : {}),
      handoff: {
        state,
        at,
        ...(message ? { message } : {}),
        ...(info.planVersion && (state === 'revised' || state === 'approved') ? { planVersion: info.planVersion } : {}),
      },
    }
  }

  /**
   * Ends an open review by handing it off: the receipt is stored in the conversation and the conversation is freed.
   * `send` stores the message the report goes with (the renderer sends it); `revise` and `approve` precede the plan
   * decision the renderer makes; `save` only keeps the receipt.
   */
  const handoff = (conversationId: unknown, input: unknown): ReviewHandoffResult => {
    const value = record(input)
    const job = jobFor(conversationId, value?.reviewId)
    if (!value || !job || job.info.kind !== 'review' || job.info.status !== 'ready') {
      return { ok: false, error: 'review-not-open' }
    }
    const action = value.action
    const { info } = job
    const allowed: readonly ReviewHandoffAction[] =
      info.target === 'code' ? ['send', 'save'] : ['revise', 'approve', 'save']
    if (typeof action !== 'string' || !allowed.includes(action as ReviewHandoffAction)) {
      return { ok: false, error: 'invalid-input' }
    }
    const findings = info.findings ?? []
    const decisions = info.draft?.decisions ?? {}
    const undecided = findings.some((finding) => !decisions[finding.id])
    let message: string | undefined
    if (action === 'send') {
      message = typeof value.message === 'string' ? value.message.trim().slice(0, MESSAGE_LIMIT) : ''
      if (!message) return { ok: false, error: 'empty-message' }
      if (undecided) return { ok: false, error: 'findings-undecided' }
      if (!findings.some((finding) => decisions[finding.id] !== 'dismiss'))
        return { ok: false, error: 'nothing-to-send' }
    }
    if (action === 'revise') {
      if (undecided) return { ok: false, error: 'findings-undecided' }
      if (!findings.some((finding) => decisions[finding.id] === 'comment'))
        return { ok: false, error: 'nothing-to-send' }
    }
    if (action === 'revise' || action === 'approve') {
      const current = deps.pendingPlan(job.conversation.id)
      if (!current || current.version !== info.planVersion) return { ok: false, error: 'plan-changed' }
    }
    const report = receipt(job, action as ReviewHandoffAction, message)
    let messageId: string
    try {
      messageId = deps.persistReport({ conversationId: job.conversation.id, report, spend: job.spend })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    job.spend = emptySpend()
    settle(job, 'completed', { messageId })
    return { ok: true, messageId }
  }

  /** A saved code report goes to the agent with the message the person composed. */
  const sendReport = (conversationId: unknown, messageId: unknown, rawMessage: unknown): ReviewSendReportResult => {
    if (typeof conversationId !== 'string' || typeof messageId !== 'string')
      return { ok: false, error: 'invalid-input' }
    if (reviewLocksConversation(jobs.get(conversationId)?.info)) return { ok: false, error: 'review-active' }
    const report = deps.getReport(conversationId, messageId)
    if (report?.target !== 'code' || report.handoff?.state !== 'saved') return { ok: false, error: 'invalid-input' }
    const message = typeof rawMessage === 'string' ? rawMessage.trim().slice(0, MESSAGE_LIMIT) : ''
    if (!message) return { ok: false, error: 'empty-message' }
    deps.updateReport(conversationId, messageId, { ...report, handoff: { state: 'sent', at: now(), message } })
    return { ok: true, message }
  }

  /**
   * Checks whether the fixes (code) or the revision (plan) the person asked for hold up. The conversation is held
   * while it runs, and the results land on the receipt.
   */
  const check = async (conversationId: unknown, messageId: unknown): Promise<ReviewStartResult> => {
    if (typeof conversationId !== 'string' || typeof messageId !== 'string')
      return { ok: false, error: 'invalid-input' }
    const conversation = deps.getConversation(conversationId)
    const blocked = blocker(conversationId, conversation)
    if (blocked) return { ok: false, error: blocked }
    const report = deps.getReport(conversationId, messageId)
    const expected = report?.target === 'code' ? 'sent' : 'revised'
    if (!report || report.handoff?.state !== expected) return { ok: false, error: 'nothing-to-check' }
    const acted = reviewActedFindings(report)
    if (!acted.length) return { ok: false, error: 'nothing-to-check' }
    let plan: { plan: string; version: number } | null = null
    if (report.target === 'plan') {
      plan = deps.pendingPlan(conversationId)
      if (!plan || plan.version <= (report.handoff.planVersion ?? report.planVersion ?? 0)) {
        return { ok: false, error: 'no-revision' }
      }
    }
    const fallback = deps.selection(conversationId)
    const selection: ReviewSelection | null = report.model
      ? {
          providerId: report.model.providerId,
          modelId: report.model.modelId,
          reasoning: report.model.reasoning ?? 'off',
          fastMode: report.model.fastMode === true,
        }
      : fallback
    if (!selection) return { ok: false, error: 'no-model' }
    starting.add(conversationId)
    try {
      const resolved = await resolveModel(selection, !!report.model)
      if (!resolved.ok) return resolved
      if (deps.isBusy(conversationId)) return { ok: false, error: 'conversation-busy' }
      const info: ReviewJobInfo = {
        reviewId: report.reviewId,
        conversationId,
        kind: 'check',
        target: report.target,
        status: 'running',
        startedAt: now(),
        model: resolved.model,
        lenses: [],
        verification: 'running',
        activity: {},
        candidateList: [],
        verdicts: [],
        findings: acted,
        messageId,
        checks: [],
        ...(plan ? { planVersion: plan.version } : {}),
      }
      const job = createJob(info, conversation!, plan?.plan)
      publish(job, true)
      job.done = runCheckJob(job, resolved.profile, report)
      return { ok: true, review: snapshot(info) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      starting.delete(conversationId)
    }
  }

  const runCheckJob = async (
    job: Job,
    profile: SubagentExecutionSnapshotV1,
    report: ChatReviewReport
  ): Promise<void> => {
    const { info, controller, conversation } = job
    const findings: CheckFinding[] = (info.findings ?? []).map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      title: finding.title,
      details: finding.details,
      ...(finding.evidence ? { evidence: finding.evidence } : {}),
      ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
      ...(finding.path ? { path: finding.path } : {}),
      ...(finding.line ? { line: finding.line } : {}),
      ...(finding.planLine ? { planLine: finding.planLine } : {}),
      ...(report.comments?.[finding.id] ? { comment: report.comments[finding.id] } : {}),
    }))
    const store = (check: ChatReviewReport['check']): void => {
      try {
        const current = deps.getReport(conversation.id, info.messageId!) ?? report
        deps.updateReport(conversation.id, info.messageId!, { ...current, ...(check ? { check } : {}) })
      } catch {
        // The receipt may have been deleted with its conversation.
      }
    }
    try {
      const result = await runReviewCheck({
        findings,
        context: promptContext(conversation, info.target, job.plan),
        signal: controller.signal,
        runReviewer: runReviewer(job, profile),
        onResults: (results) => {
          info.checks = results
          publish(job)
        },
      })
      info.checks = result.results
      store({
        status: 'completed',
        startedAt: info.startedAt,
        finishedAt: now(),
        results: result.results,
        ...(info.planVersion ? { planVersion: info.planVersion } : {}),
      })
      billUnreceipted(job)
      settle(job, 'completed')
    } catch (error) {
      billUnreceipted(job)
      if (controller.signal.aborted || (error instanceof ReviewEngineError && error.code === 'cancelled')) {
        settle(job, 'cancelled')
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      store({
        status: 'failed',
        startedAt: info.startedAt,
        finishedAt: now(),
        results: info.checks ?? [],
        error: message,
      })
      settle(job, 'failed', { error: message })
    }
  }

  /** The review or check holding the conversation, with a promise that resolves when it lets go. */
  const lockFor = (conversationId: string): { kind: ReviewJobInfo['kind']; released: Promise<void> } | null => {
    const job = jobs.get(conversationId)
    return job && reviewLocksConversation(job.info) ? { kind: job.info.kind, released: job.released } : null
  }

  /** Forgets a job that ended, so the surfaces stop showing it. */
  const forget = (conversationId: unknown): void => {
    const job = jobFor(conversationId)
    if (job && !reviewLocksConversation(job.info)) jobs.delete(job.info.conversationId)
  }

  /** The conversation is going away: stop and forget whatever review it has. */
  const close = async (conversationId: string): Promise<void> => {
    const job = jobs.get(conversationId)
    if (!job) return
    job.discarding = job.info.kind === 'review'
    job.controller.abort()
    if (job.info.status === 'ready') {
      billUnreceipted(job)
      settle(job, 'discarded')
    }
    await job.done.catch(() => undefined)
    if (jobs.get(conversationId) === job) jobs.delete(conversationId)
  }

  const dispose = async (): Promise<void> => {
    const all = [...jobs.values()]
    for (const job of all) {
      job.controller.abort()
      if (job.publishTimer) clearTimeout(job.publishTimer)
      job.release()
    }
    await Promise.allSettled(all.map((job) => job.done))
  }

  return {
    prepare,
    start,
    cancel,
    discard,
    status,
    updateDraft,
    handoff,
    sendReport,
    check,
    lockFor,
    forget,
    close,
    dispose,
  }
}

export type ReviewService = ReturnType<typeof createReviewService>

export type { ReviewFinding }
