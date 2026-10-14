import { randomUUID } from 'node:crypto'
import type { ToolSet } from 'ai'
import {
  CODE_REVIEW_LENSES,
  PLAN_REVIEW_LENSES,
  parseReviewModelChoice,
  type ChatReviewReport,
  type ReviewFinding,
  type ReviewJobInfo,
  type ReviewModelInfo,
  type ReviewStartResult,
  type ReviewTarget,
} from '../../../shared/review'
import type { SubagentExecutionSnapshotV1 } from '../../../shared/subagent-profiles'
import type { ChatAgent } from '../agents'
import { ReviewEngineError, runReviewEngine, type ReviewUsage, type ReviewerRunResult } from './engine'
import { createFindingsCollector, parseSubmissionFromText } from './findings'
import { gitDiffTool, readGitSnapshot, snapshotHasChanges } from './git-diff'
import { REVIEWER_SYSTEM_PROMPT, reviewLanguage } from './prompts'

/** Read-only reviewer: core read tools plus the host tools each review supplies. */
export const REVIEWER_AGENT: ChatAgent = {
  name: 'reviewer',
  description: 'Independent read-only reviewer used by Maestrly code and plan reviews.',
  tools: ['read', 'grep', 'glob', 'git_diff', 'submit_findings'],
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

export interface ReviewServiceDeps {
  getConversation(conversationId: string): ReviewConversation | null
  /** A turn or operation is running in the conversation. */
  isBusy(conversationId: string): boolean
  pendingPlan(conversationId: string): { plan: string; version: number } | null
  /** The conversation's own model, effort and Fast setting, used when no reviewer model is chosen. */
  selection(conversationId: string): ReviewSelection | null
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
  }): Promise<{ text: string; error?: string; usage?: ReviewUsage; runtimeEstimatedCostUsd?: number }>
  /** Stores the code review report in the conversation and returns the message id. */
  persistReport(input: {
    conversationId: string
    report: ChatReviewReport
    usage: ReviewUsage
    runtimeEstimatedCostUsd: number
  }): string
  onChange(info: ReviewJobInfo): void
  readSnapshot?: typeof readGitSnapshot
  now?: () => number
}

interface Job {
  info: ReviewJobInfo
  controller: AbortController
  done: Promise<void>
}

const CONTEXT_LIMIT = 24_000

function boundedContext(text: string): string {
  if (text.length <= CONTEXT_LIMIT) return text
  return `… [earlier context omitted] …\n${text.slice(-CONTEXT_LIMIT)}`
}

function isActive(info: ReviewJobInfo | undefined): boolean {
  return info?.status === 'running' || info?.status === 'verifying'
}

export function createReviewService(deps: ReviewServiceDeps) {
  const now = deps.now ?? Date.now
  const readSnapshot = deps.readSnapshot ?? readGitSnapshot
  const jobs = new Map<string, Job>()
  const starting = new Set<string>()

  const snapshot = (info: ReviewJobInfo): ReviewJobInfo => ({
    ...info,
    lenses: info.lenses.map((lens) => ({ ...lens })),
    ...(info.findings ? { findings: info.findings.map((finding) => ({ ...finding })) } : {}),
  })

  const publish = (job: Job): void => {
    try {
      deps.onChange(snapshot(job.info))
    } catch {
      // Observers never own the review lifecycle.
    }
  }

  const runJob = async (
    job: Job,
    conversation: ReviewConversation,
    profile: SubagentExecutionSnapshotV1,
    plan: string | undefined,
    scope: ChatReviewReport['scope']
  ): Promise<void> => {
    const { info, controller } = job
    try {
      const result = await runReviewEngine({
        target: info.target,
        lenses: info.target === 'code' ? CODE_REVIEW_LENSES : PLAN_REVIEW_LENSES,
        context: {
          target: info.target,
          conversation: boundedContext(deps.conversationContext(conversation.id)),
          ...(plan !== undefined ? { plan } : {}),
          language: reviewLanguage(deps.locale()),
        },
        signal: controller.signal,
        runReviewer: async ({ task, signal }): Promise<ReviewerRunResult> => {
          const collector = createFindingsCollector(conversation.cwd)
          const tools: ToolSet = {
            submit_findings: collector.tool,
            ...(info.target === 'code' ? { git_diff: gitDiffTool(conversation.cwd) } : {}),
          }
          const run = await deps.runReviewer({ conversation, profile, task, tools, signal })
          const submission = collector.submission() ?? parseSubmissionFromText(run.text, conversation.cwd)
          return {
            submission,
            ...(submission ? {} : { error: run.error ?? 'The reviewer finished without submitting findings.' }),
            ...(run.usage ? { usage: run.usage } : {}),
            ...(run.runtimeEstimatedCostUsd !== undefined
              ? { runtimeEstimatedCostUsd: run.runtimeEstimatedCostUsd }
              : {}),
          }
        },
        onProgress: (progress) => {
          info.lenses = progress.lenses
          info.verification = progress.verification
          if (progress.candidates !== undefined) info.candidates = progress.candidates
          if (progress.verification === 'running') info.status = 'verifying'
          publish(job)
        },
      })
      const finishedAt = now()
      info.candidates = result.candidates
      info.verification = result.verification
      if (result.unverified) info.unverified = true
      if (info.target === 'code') {
        const report: ChatReviewReport = {
          reviewId: info.reviewId,
          target: 'code',
          findings: result.findings,
          candidates: result.candidates,
          ...(result.unverified ? { unverified: true } : {}),
          ...(result.failedLenses.length ? { failedLenses: result.failedLenses } : {}),
          ...(info.model ? { model: info.model } : {}),
          startedAt: info.startedAt,
          finishedAt,
          ...(scope ? { scope } : {}),
        }
        info.messageId = deps.persistReport({
          conversationId: conversation.id,
          report,
          usage: result.usage,
          runtimeEstimatedCostUsd: result.runtimeEstimatedCostUsd,
        })
      } else {
        // Findings about a plan the person already decided, or that the agent replaced, would land on the wrong text.
        const current = deps.pendingPlan(conversation.id)
        if (!current || current.version !== info.planVersion || current.plan !== plan) {
          info.status = 'cancelled'
          info.finishedAt = finishedAt
          publish(job)
          return
        }
        info.findings = result.findings
      }
      info.status = 'completed'
      info.finishedAt = finishedAt
    } catch (error) {
      info.finishedAt = now()
      if (controller.signal.aborted || (error instanceof ReviewEngineError && error.code === 'cancelled')) {
        info.status = 'cancelled'
      } else {
        info.status = 'failed'
        info.error = error instanceof Error ? error.message : String(error)
      }
    }
    publish(job)
  }

  const start = async (conversationId: unknown, input: unknown): Promise<ReviewStartResult> => {
    if (typeof conversationId !== 'string' || !conversationId) return { ok: false, error: 'invalid-conversation' }
    const target: ReviewTarget | null =
      input &&
      typeof input === 'object' &&
      ((input as { target?: unknown }).target === 'code' || (input as { target?: unknown }).target === 'plan')
        ? (input as { target: ReviewTarget }).target
        : null
    if (!target) return { ok: false, error: 'invalid-input' }
    const rawReviewer = (input as { reviewer?: unknown }).reviewer
    const reviewer = rawReviewer === undefined ? null : parseReviewModelChoice(rawReviewer)
    if (rawReviewer !== undefined && !reviewer) return { ok: false, error: 'invalid-reviewer' }
    if (reviewer && deps.reviewerProviderSupported?.(reviewer.providerId) === false) {
      return { ok: false, error: 'reviewer-unsupported' }
    }
    if (starting.has(conversationId) || isActive(jobs.get(conversationId)?.info)) {
      return { ok: false, error: 'review-active' }
    }
    starting.add(conversationId)
    try {
      const conversation = deps.getConversation(conversationId)
      if (!conversation) return { ok: false, error: 'invalid-conversation' }
      if (conversation.archived) return { ok: false, error: 'conversation-archived' }
      let plan: { plan: string; version: number } | null = null
      let scope: ChatReviewReport['scope']
      if (target === 'code') {
        if (deps.isBusy(conversationId)) return { ok: false, error: 'conversation-busy' }
        const checkout = await readSnapshot(conversation.cwd)
        if (!checkout.repository) return { ok: false, error: 'not-a-repository' }
        if (!snapshotHasChanges(checkout)) return { ok: false, error: 'nothing-to-review' }
        scope = { branch: checkout.branch, head: checkout.head }
      } else {
        plan = deps.pendingPlan(conversationId)
        if (!plan?.plan.trim()) return { ok: false, error: 'no-pending-plan' }
      }
      const selection = reviewer ?? deps.selection(conversationId)
      if (!selection) return { ok: false, error: 'no-model' }
      const profile = await deps.resolveProfile(selection, { chosen: !!reviewer })
      if (!profile.effective) {
        const diagnostic = profile.attempts
          .flatMap((attempt) => attempt.diagnostics)
          .find((item) => item.severity === 'error')
        return { ok: false, error: diagnostic?.message ?? 'agent-unavailable' }
      }
      const model: ReviewModelInfo = {
        providerId: profile.effective.providerId,
        modelId: profile.effective.modelId,
        ...(profile.effective.configuredEffort && profile.effective.configuredEffort !== 'off'
          ? { reasoning: profile.effective.configuredEffort }
          : {}),
        ...(profile.effective.fastMode ? { fastMode: true } : {}),
      }
      const lenses = target === 'code' ? CODE_REVIEW_LENSES : PLAN_REVIEW_LENSES
      const info: ReviewJobInfo = {
        reviewId: randomUUID(),
        conversationId,
        target,
        status: 'running',
        startedAt: now(),
        model,
        lenses: lenses.map((id) => ({ id, status: 'pending' })),
        verification: 'pending',
        ...(plan ? { planVersion: plan.version } : {}),
      }
      const job: Job = { info, controller: new AbortController(), done: Promise.resolve() }
      jobs.set(conversationId, job)
      publish(job)
      job.done = runJob(job, conversation, profile, plan?.plan, scope)
      return { ok: true, review: snapshot(info) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      starting.delete(conversationId)
    }
  }

  const cancel = (conversationId: unknown): { ok: boolean } => {
    if (typeof conversationId !== 'string') return { ok: false }
    const job = jobs.get(conversationId)
    if (!job || !isActive(job.info)) return { ok: false }
    job.controller.abort()
    return { ok: true }
  }

  const status = (conversationId: unknown): ReviewJobInfo | null => {
    if (typeof conversationId !== 'string') return null
    const job = jobs.get(conversationId)
    return job ? snapshot(job.info) : null
  }

  /** Plan findings are consumed once the panel shows them; forgetting them keeps a later plan from inheriting them. */
  const forget = (conversationId: string): void => {
    const job = jobs.get(conversationId)
    if (job && !isActive(job.info)) jobs.delete(conversationId)
  }

  const dispose = async (): Promise<void> => {
    const all = [...jobs.values()]
    for (const job of all) job.controller.abort()
    await Promise.allSettled(all.map((job) => job.done))
  }

  return { start, cancel, status, forget, dispose }
}

export type ReviewService = ReturnType<typeof createReviewService>

export type { ReviewFinding }
