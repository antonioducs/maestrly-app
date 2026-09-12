/**
 * Generic automatic review-loop controller (reviewer → conversation executor).
 *
 * ISOLATED, testable domain: review intelligence belongs to the reviewer; this module governs lifecycle,
 * authorization, state, concurrency, idempotency, limits, and auditing. Each `submit_review_fix` starts
 * EXACTLY one internal execution (via `startTurn`); the reviewer decides convergence.
 *
 * State machine (v1, in memory; restart never resumes execution automatically):
 *
 *   idle → reviewing → executing → reviewing (next iteration) → finished
 *   reviewing/executing → cancelling → cancelled (Stop during an active job: release the slot only when
 *     the runner confirms termination; never two agents in the same workspace)
 *   reviewing/finishing → cancelled (Stop without an active job: immediately terminal)
 *   any active state → finished (automatic termination: max_iterations, no_progress, failed,
 *     executor_unavailable, workspace_changed_externally)
 *
 * MULTIPLE sequential loops per session: the active slot holds only the current loop; terminal loops
 * enter a bounded history (loopsById) and remain queryable by loop_id (late wait/finish calls).
 * Finalization is CANONICAL per loop: the auditable summary persists at most once, regardless of the
 * idempotency_key used by repeated finish_review_loop calls.
 *
 * Every transition validates loop_id/conversation/iteration/current job; late responses from old jobs
 * never alter the current loop. No findings/prompt/key leaves this module, only hashes and metadata.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { InternalTurnOutcome, MessagePart } from '../../../shared/chat'
import { getLocale } from '../../store'
import { tFor } from '../../i18n'
import { hasFindingAtOrAboveThreshold, reviewEvidenceError, validateFindingsShape } from './evidence'
import {
  MAX_EXECUTOR_SUMMARY_CHARS,
  MAX_FINISH_SUMMARY_CHARS,
  MAX_REMAINING_FINDINGS,
  MAX_REVIEWER_NOTES_CHARS,
  type FinishReviewLoopInput,
  type FinishReviewLoopResult,
  type ResultOrError,
  type ReviewFindingInput,
  type ReviewFixJob,
  type ReviewFixWaitResult,
  type ReviewLoopControllerDeps,
  type ReviewLoopEvidence,
  type ReviewLoopFinishReason,
  type ReviewLoopControllerInfo,
  type ReviewLoopState as ReviewLoopStateBase,
  type ReviewLoopVisualBrowser,
  type ReviewLoopVisualInfo,
  type ReviewLoopVisualPreview,
  type StartReviewLoopInput,
  type StartReviewLoopResult,
  type SubmitReviewFixInput,
  type SubmitReviewFixResult,
  type WorkspaceSnapshot,
} from './types'
import { createReviewLoopGitRunner, fingerprintOf, snapshotWorkspace } from './workspace'

const IDEMPOTENCY_CACHE_LIMIT = 64
const FINISHED_JOB_KEEP = 8
/** Number of terminal loops that remain queryable by loop_id (late wait/finish calls). */
const HISTORY_KEEP = 8
const WAIT_POLL_MS = 200
const DEFAULT_FRONTEND_STARTUP_TIMEOUT_MS = 40_000
const MAX_FRONTEND_STARTUP_TIMEOUT_MS = 55_000

function boundedFrontendStartupTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_FRONTEND_STARTUP_TIMEOUT_MS, Math.max(1, Math.floor(value)))
    : DEFAULT_FRONTEND_STARTUP_TIMEOUT_MS
}

function prepareFrontendWithin<T>(
  operation: Promise<T>,
  abort: AbortController,
  timeoutMs: number,
  disposeLateResult: (value: T) => Promise<void>
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      callback()
      return true
    }
    const timer = setTimeout(() => {
      abort.abort()
      finish(() => reject(new Error(`Visual review bootstrap timed out after ${timeoutMs}ms.`)))
    }, timeoutMs)
    timer.unref?.()
    operation.then(
      (value) => {
        if (!finish(() => resolve(value))) void disposeLateResult(value).catch(() => undefined)
      },
      (error) => finish(() => reject(error))
    )
  })
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** Accepted `finish` outcome when the loop has already terminated automatically (contract consistency). */
function expectedResultFor(
  reason: ReviewLoopFinishReason | undefined
): 'clean' | 'max_iterations' | 'no_progress' | 'failed' | 'cancelled' | null {
  switch (reason) {
    case 'clean':
      return 'clean'
    case 'max_iterations':
      return 'max_iterations'
    case 'no_progress':
      return 'no_progress'
    case 'failed':
    case 'executor_unavailable':
    case 'reviewer_unavailable':
    case 'review-decision-missing':
    case 'workspace_changed_externally':
      return 'failed'
    case 'cancelled':
    case 'session_ended':
    case 'interrupted':
      return 'cancelled'
    default:
      return null
  }
}

function isExecutorUnavailableError(error: string): boolean {
  return error === 'no-model' || error === 'no-key' || error === 'executor-unavailable'
}

/** Stable codes returned when the loop has ALREADY ended (the bridge maps them to readable messages). */
const REVIEW_LOOP_END_CODES: Record<string, string> = {
  max_iterations: 'max-iterations-reached',
  no_progress: 'no-progress-limit',
  executor_unavailable: 'executor-unavailable',
  reviewer_unavailable: 'reviewer-unavailable',
  'review-decision-missing': 'review-decision-missing',
  failed: 'review-loop-failed',
  workspace_changed_externally: 'workspace-changed-externally',
  cancelled: 'review-loop-cancelled',
  session_ended: 'review-loop-cancelled',
  interrupted: 'review-loop-cancelled',
}

export function createReviewLoopController<
  TVisualInfo extends ReviewLoopVisualInfo = ReviewLoopVisualInfo,
  TVisualBrowser extends ReviewLoopVisualBrowser<TVisualInfo> = ReviewLoopVisualBrowser<TVisualInfo>,
  TVisualPreview extends ReviewLoopVisualPreview = ReviewLoopVisualPreview,
  TVisualTarget = unknown,
>(deps: ReviewLoopControllerDeps<TVisualInfo, TVisualBrowser, TVisualPreview, TVisualTarget>) {
  type Deps = ReviewLoopControllerDeps<TVisualInfo, TVisualBrowser, TVisualPreview, TVisualTarget>
  type ReviewLoopState = ReviewLoopStateBase<TVisualInfo, TVisualBrowser, TVisualPreview>
  const now = deps.now ?? (() => Date.now())
  const runGitDefault: NonNullable<Deps['runGit']> = createReviewLoopGitRunner(deps.cwd)
  const git = deps.runGit ?? runGitDefault
  const snapshot = () => snapshotWorkspace({ cwd: deps.cwd, runGit: git })

  /** The ONLY loop occupying the conversation slot (reviewing/executing/finishing/cancelling). */
  let activeLoop: ReviewLoopState | null = null
  /** Recent terminal history (finished/cancelled), queryable by loop_id for a bounded window. */
  const loopsById = new Map<string, ReviewLoopState>()
  /** Terminal jobs PER LOOP: `wait` recovers the outcome even after the loop enters history. */
  const jobsByLoop = new Map<string, Map<string, ReviewFixJob>>()
  const startedKeys = new Map<string, { fingerprint: string; result: StartReviewLoopResult }>()
  const submitKeys = new Map<string, { fingerprint: string; result: SubmitReviewFixResult }>()
  const finishKeys = new Map<string, { fingerprint: string; result: FinishReviewLoopResult }>()
  let lastNoProgressFindingsFingerprint: string | null = null
  /** Synchronous barriers preventing concurrent retries from creating duplicate loops/jobs. */
  let starting: { key: string; fingerprint: string; promise: Promise<ResultOrError<StartReviewLoopResult>> } | null =
    null
  let submitting: { key: string; fingerprint: string; promise: Promise<ResultOrError<SubmitReviewFixResult>> } | null =
    null
  /** Teardown barrier: the slot becomes available only after all visual resources finish. */
  let stopping: Promise<void> | null = null

  const notify = () => {
    try {
      deps.onChange?.()
    } catch {
      /* observer failures never terminate the loop */
    }
  }

  const cachePut = <T>(map: Map<string, T>, key: string, value: T) => {
    map.set(key, value)
    if (map.size > IDEMPOTENCY_CACHE_LIMIT) {
      const oldest = map.keys().next().value
      if (typeof oldest === 'string') map.delete(oldest)
    }
  }

  /** Register a TERMINAL job in its OWN loop cache (wait can recover it until expiration). Idempotent. */
  const rememberFinishedJob = (job: ReviewFixJob) => {
    let bucket = jobsByLoop.get(job.loopId)
    if (!bucket) {
      bucket = new Map()
      jobsByLoop.set(job.loopId, bucket)
    }
    bucket.set(job.jobId, job)
    while (bucket.size > FINISHED_JOB_KEEP) {
      const oldest = bucket.keys().next().value
      if (typeof oldest === 'string') bucket.delete(oldest)
      else break
    }
  }

  /** Move a TERMINAL loop to history and release the active slot (never remove a loop with a running job). */
  const archiveLoop = (current: ReviewLoopState) => {
    if (activeLoop?.loopId === current.loopId) activeLoop = null
    deps.releaseParticipants?.(current.loopId)
    // Clear the investigation pointer ONLY if it still belongs to this loop (protect an active loop B).
    deps.clearReviewIteration(current.loopId)
    loopsById.set(current.loopId, current)
    while (loopsById.size > HISTORY_KEEP) {
      const oldest = loopsById.values().next().value
      if (!oldest || oldest.activeJob) break
      jobsByLoop.delete(oldest.loopId)
      // History eviction also removes that loop's evidence.
      deps.forgetReviewLoop(oldest.loopId)
      loopsById.delete(oldest.loopId)
    }
  }

  const teardownVisualEnvironment = (current: ReviewLoopState): Promise<void> => {
    const visual = current.visualEnvironment
    if (!visual) return Promise.resolve()
    if (visual.teardown) return visual.teardown
    if (visual.disposed) return Promise.resolve()
    visual.disposed = true
    visual.info = { ...visual.info, state: 'error' }
    visual.abort.abort()
    visual.teardown = Promise.allSettled([
      Promise.resolve().then(() => visual.browser.dispose()),
      ...(visual.preview ? [Promise.resolve().then(() => visual.preview!.dispose())] : []),
    ]).then(() => undefined)
    return visual.teardown
  }

  /** Archive only after visual teardown; without a visual environment this path remains synchronous. */
  const releaseTerminalSlot = (current: ReviewLoopState): void => {
    if (!current.visualEnvironment) {
      archiveLoop(current)
      return
    }
    const teardown = teardownVisualEnvironment(current)
    let barrier!: Promise<void>
    barrier = teardown.then(() => {
      if (activeLoop?.loopId === current.loopId) archiveLoop(current)
      if (stopping === barrier) stopping = null
      notify()
    })
    stopping = barrier
  }

  /** Remove the active job; if the loop was cancelling, complete termination and release the slot. */
  const detachJob = (current: ReviewLoopState) => {
    current.activeJob = undefined
    if (current.status === 'cancelling') {
      current.status = 'cancelled'
      releaseTerminalSlot(current)
      notify()
    }
  }

  const startFingerprint = (input: StartReviewLoopInput) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          reviewScope: input.reviewScope ?? 'code',
          previewId: input.previewId ?? null,
          browserId: input.browserId ?? null,
          maxIterations: input.maxIterations,
          severityThreshold: input.severityThreshold,
        })
      )
      .digest('hex')

  const submitFingerprint = (input: SubmitReviewFixInput) =>
    createHash('sha256')
      .update(input.loopId)
      .update('\0')
      .update(String(input.iteration))
      .update('\0')
      .update(
        JSON.stringify(
          input.findings.map((f) => ({
            id: f.id,
            severity: f.severity,
            title: f.title,
            details: f.details,
            paths: f.paths ?? [],
          }))
        )
      )
      .update('\0')
      .update(input.reviewerNotes ?? '')
      .digest('hex')

  const finishFingerprint = (input: FinishReviewLoopInput) =>
    createHash('sha256')
      .update(input.loopId)
      .update('\0')
      .update(input.result)
      .update('\0')
      .update(input.summary)
      .update('\0')
      .update(JSON.stringify(input.remainingFindings ?? []))
      .digest('hex')

  /** End the loop with a terminal reason and return the error shown to the reviewer. */
  const terminate = (reason: ReviewLoopFinishReason, message: string): { error: string } => {
    const current = activeLoop
    if (current && current.status !== 'finished' && current.status !== 'cancelled') {
      current.status = reason === 'session_ended' || reason === 'cancelled' ? 'cancelled' : 'finished'
      current.finishReason = reason
      current.finishedAt = now()
      if (current.activeJob) {
        // Immediate abort covers a turn still in preflight (no executionId yet).
        current.activeJob.controller.abort()
        if (current.activeJob.executionId) deps.cancelTurn(current.activeJob.executionId)
      }
      // The slot stays occupied while BrowserWindow and the preview/process tree are still closing.
      releaseTerminalSlot(current)
      notify()
    }
    return { error: message }
  }

  function buildFindingsMarkdown(
    current: ReviewLoopState,
    findings: ReviewFindingInput[],
    reviewerNotes?: string
  ): string {
    const t = tFor(getLocale(), 'prompts')
    const lines = [
      `# ${t('reviewLoop.findingsHeading', { iteration: current.iteration, max: current.maxIterations })}`,
      '',
      `- loop_id: \`${current.loopId}\``,
      `- severity_threshold: ${current.severityThreshold}`,
      `- branch: ${current.expectedWorkspace.branch} @ ${current.expectedWorkspace.head || '(unknown)'}`,
      '',
      `## ${t('reviewLoop.findingsSection', { count: findings.length })}`,
    ]
    for (const f of findings) {
      lines.push('', `### [${f.severity}] ${f.id} — ${f.title}`, '', f.details)
      if (f.paths?.length) lines.push('', `- paths: ${f.paths.map((p) => `\`${p}\``).join(', ')}`)
    }
    if (reviewerNotes?.trim()) {
      lines.push('', `## ${t('reviewLoop.reviewerNotes')}`, '', reviewerNotes.trim())
    }
    return lines.join('\n')
  }

  function buildAuditSummary(
    current: ReviewLoopState,
    input: FinishReviewLoopInput,
    evidence: ReviewLoopEvidence,
    finalFingerprint: string
  ): string {
    const t = tFor(getLocale(), 'prompts')
    const resultLabels: Record<string, string> = {
      clean: t('reviewLoop.resultClean'),
      max_iterations: t('reviewLoop.resultMaxIterations'),
      no_progress: t('reviewLoop.resultNoProgress'),
      failed: t('reviewLoop.resultFailed'),
      cancelled: t('reviewLoop.resultCancelled'),
    }
    const reasonLabels: Record<string, string> = {
      clean: t('reviewLoop.resultClean'),
      max_iterations: t('reviewLoop.resultMaxIterations'),
      no_progress: t('reviewLoop.resultNoProgress'),
      failed: t('reviewLoop.resultFailed'),
      cancelled: t('reviewLoop.resultCancelled'),
      executor_unavailable: t('reviewLoop.reasonExecutorUnavailable'),
      workspace_changed_externally: t('reviewLoop.reasonWorkspaceChanged'),
      session_ended: t('reviewLoop.reasonSessionEnded'),
      interrupted: t('reviewLoop.reasonInterrupted'),
    }
    const seconds = Math.max(0, Math.round((current.finishedAt ?? now()) - current.startedAt) / 1000)
    const remaining = input.remainingFindings ?? []
    const remainingCounts = { blocking: 0, important: 0, optional: 0 }
    for (const f of remaining) remainingCounts[f.severity]++
    const lines = [
      `## ${t('reviewLoop.summaryHeading')}`,
      '',
      `- ${t('reviewLoop.summaryResult')}: **${resultLabels[input.result] ?? input.result}**`,
      `- ${t('reviewLoop.summaryRounds')}: ${current.roundsExecuted}/${current.maxIterations}`,
      `- ${t('reviewLoop.summaryDuration')}: ${seconds}s`,
      `- ${t('reviewLoop.summaryBaseline')}: \`${fingerprintOf(current.baseline)}\``,
      `- ${t('reviewLoop.summaryFinal')}: \`${finalFingerprint}\``,
      current.finishReason
        ? `- ${t('reviewLoop.summaryStopReason')}: ${reasonLabels[current.finishReason] ?? current.finishReason}`
        : null,
      '',
      `## ${t('reviewLoop.summaryReviewer')}`,
      '',
      clip(input.summary.trim(), MAX_FINISH_SUMMARY_CHARS) || '(—)',
      '',
      `## ${t('reviewLoop.summaryRemaining')}`,
      '',
      remaining.length
        ? `- ${t('reviewLoop.summaryRemainingCount', {
            total: remaining.length,
            blocking: remainingCounts.blocking,
            important: remainingCounts.important,
            optional: remainingCounts.optional,
          })}\n${remaining
            .map((f) => `- [${f.severity}] ${f.title}`)
            .slice(0, MAX_REMAINING_FINDINGS)
            .join('\n')}`
        : `- ${t('reviewLoop.summaryRemainingNone')}`,
      '',
      `## ${t('reviewLoop.summaryChecks')}`,
      '',
      evidence.checks.length
        ? evidence.checks.map((c) => `- \`${c}\``).join('\n')
        : `- ${t('reviewLoop.summaryChecksNone')}`,
    ]
    return lines.filter((line): line is string => line !== null).join('\n')
  }

  // ---------------------------------------------------------------- start

  async function doStart(input: StartReviewLoopInput): Promise<ResultOrError<StartReviewLoopResult>> {
    if (activeLoop) {
      const cached = startedKeys.get(input.idempotencyKey)
      if (cached)
        return cached.fingerprint === startFingerprint(input) ? cached.result : { error: 'idempotency-conflict' }
      // The slot remains occupied during cancellation (a runner may still be alive).
      return {
        error:
          activeLoop.status === 'cancelling' || activeLoop.status === 'finished' || activeLoop.status === 'cancelled'
            ? 'review-loop-stopping'
            : 'review-loop-active',
      }
    }
    if (stopping) return { error: 'review-loop-stopping' }
    if (!deps.sessionActive()) return { error: 'session-not-active' }
    if (Object.hasOwn(input, 'targetUrl')) return { error: 'target-url-not-allowed' }
    const validated = await deps.validateStart()
    if (!validated.ok) return { error: validated.error }
    const selection = await deps.resolveSelection()
    if (!selection.ok) return { error: selection.error }
    const fingerprint = startFingerprint(input)
    const cached = startedKeys.get(input.idempotencyKey)
    if (cached) return cached.fingerprint === fingerprint ? cached.result : { error: 'idempotency-conflict' }

    const loopId = `rl_${randomBytes(6).toString('hex')}`
    const reviewScope = input.reviewScope ?? 'code'
    if (reviewScope !== 'code' && reviewScope !== 'frontend') return { error: 'invalid-review-scope' }
    const previewId = typeof input.previewId === 'string' && input.previewId.length > 0 ? input.previewId : null
    const browserId = typeof input.browserId === 'string' && input.browserId.length > 0 ? input.browserId : null
    const hasPreviewId = previewId !== null
    const hasBrowserId = browserId !== null
    if (reviewScope === 'code' && (hasPreviewId || hasBrowserId)) return { error: 'preview-options-require-frontend' }
    if (hasPreviewId && hasBrowserId) return { error: 'frontend-environment-conflict' }

    // Prepare the visual environment before materializing activeLoop: startup failures cannot reserve
    // the conversation. The controller owns both handles from this point onward.
    let visualEnvironment: ReviewLoopState['visualEnvironment']
    if (reviewScope === 'frontend') {
      if (!previewId && !browserId) return { error: 'frontend-environment-required' }
      if (previewId && !deps.prepareFrontendEnvironment) return { error: 'frontend-preview-unavailable' }
      if (browserId && !deps.prepareAttachedFrontendEnvironment) return { error: 'frontend-browser-unavailable' }
      const abort = new AbortController()
      let visualInfo = { state: 'starting' } as TVisualInfo
      try {
        const startup: Promise<{
          browser: TVisualBrowser
          url: string
          ownership: 'managed' | 'attached'
          preview?: TVisualPreview
        }> = previewId
          ? deps.prepareFrontendEnvironment!({
              loopId,
              previewId,
              signal: abort.signal,
              onStateChange: updateVisualInfo,
            }).then((value) => ({
              ...value,
              url: value.preview.url,
              ownership: 'managed' as const,
            }))
          : deps.prepareAttachedFrontendEnvironment!({
              loopId,
              browserId: browserId!,
              signal: abort.signal,
              onStateChange: updateVisualInfo,
            })
        const prepared = await prepareFrontendWithin(
          startup,
          abort,
          boundedFrontendStartupTimeout(deps.frontendStartupTimeoutMs),
          async (late) => {
            await Promise.allSettled([late.browser.dispose(), ...(late.preview ? [late.preview.dispose()] : [])])
          }
        )
        visualEnvironment = {
          ...prepared,
          abort,
          info: visualInfo.state === 'starting' ? prepared.browser.info() : visualInfo,
          disposed: false,
        }
      } catch (error) {
        abort.abort()
        const detail = deps.formatVisualStartupError
          ? deps.formatVisualStartupError(error, deps.cwd)
          : error instanceof Error
            ? error.message
            : String(error)
        return { error: `frontend-preview-start-failed:${detail}` }
      }

      function updateVisualInfo(next: TVisualInfo): void {
        visualInfo = next
        if (activeLoop?.loopId === loopId && activeLoop.visualEnvironment) {
          activeLoop.visualEnvironment.info = next
          notify()
        }
      }
    }

    let baseline: WorkspaceSnapshot
    try {
      baseline = await snapshot()
    } catch (error) {
      if (visualEnvironment)
        await Promise.allSettled([
          visualEnvironment.browser.dispose(),
          ...(visualEnvironment.preview ? [visualEnvironment.preview.dispose()] : []),
        ])
      throw error
    }
    const reserved = deps.reserveParticipants?.(loopId)
    if (reserved && !reserved.ok) {
      if (visualEnvironment)
        await Promise.allSettled([
          visualEnvironment.browser.dispose(),
          ...(visualEnvironment.preview ? [visualEnvironment.preview.dispose()] : []),
        ])
      return { error: reserved.error }
    }
    activeLoop = {
      loopId,
      conversationId: deps.conversationId,
      sessionKeyHash: deps.sessionKeyHash,
      status: 'reviewing',
      iteration: 1,
      maxIterations: input.maxIterations,
      severityThreshold: input.severityThreshold,
      reviewScope,
      selection: selection.selection,
      baseline,
      expectedWorkspace: baseline,
      noProgressCount: 0,
      roundsExecuted: 0,
      roundsCompleted: 0,
      roundsFailed: 0,
      roundsCancelled: 0,
      startedAt: now(),
      ...(visualEnvironment ? { visualEnvironment } : {}),
    }
    const monitoredVisual = visualEnvironment
    const processExit = monitoredVisual?.preview?.waitForExit?.()
    if (monitoredVisual && processExit) {
      void processExit.then(() => {
        const current = activeLoop
        if (
          !current ||
          current.loopId !== loopId ||
          current.visualEnvironment !== monitoredVisual ||
          monitoredVisual.disposed
        )
          return
        monitoredVisual.info = { ...monitoredVisual.info, state: 'error', url: monitoredVisual.url }
        void teardownVisualEnvironment(current).then(notify)
        notify()
      })
    }
    // The conversation lock begins HERE (before returning): concurrent manual sends are now blocked
    // by the service guard; only the turn carrying this loopId can pass.
    // A NEW, empty evidence bucket for this loopId (never reuse investigation from the previous loop).
    deps.setReviewIteration(loopId, 1)
    deps.forceAgentMode()
    const result: StartReviewLoopResult = {
      loopId,
      status: 'reviewing',
      iteration: 1,
      maxIterations: input.maxIterations,
      severityThreshold: input.severityThreshold,
      reviewScope,
      baseline: {
        branch: baseline.branch,
        head: baseline.head,
        workspaceFingerprint: fingerprintOf(baseline),
      },
      executor: {
        providerId: selection.selection.providerId,
        modelId: selection.selection.modelId,
        ...(selection.selection.reasoning ? { reasoning: selection.selection.reasoning } : {}),
      },
      ...(visualEnvironment
        ? { visual: { url: visualEnvironment.url, managedPreview: visualEnvironment.ownership === 'managed' } }
        : {}),
    }
    cachePut(startedKeys, input.idempotencyKey, { fingerprint, result })
    notify()
    return result
  }

  function start(input: StartReviewLoopInput): Promise<ResultOrError<StartReviewLoopResult>> {
    const fingerprint = startFingerprint(input)
    if (starting) {
      if (starting.key === input.idempotencyKey && starting.fingerprint === fingerprint) return starting.promise
      return starting.promise.then(async () => {
        // The concurrent start won; if it did not materialize a loop, this call can still try.
        if (activeLoop) return { error: 'review-loop-active' }
        return doStart(input)
      })
    }
    const promise = doStart(input)
    starting = { key: input.idempotencyKey, fingerprint, promise }
    return promise.finally(() => {
      if (starting?.promise === promise) starting = null
    })
  }

  // ---------------------------------------------------------------- submit

  async function finalizeJob(job: ReviewFixJob, outcome: InternalTurnOutcome): Promise<void> {
    job.status = outcome.status === 'success' ? 'completed' : outcome.status === 'error' ? 'failed' : 'cancelled'
    job.finishedAt = now()
    job.assistantMessageId = outcome.assistantMessageId ?? undefined
    job.executorSummary = clip(
      outcome.status === 'success' ? (outcome.summaryText ?? '') : outcome.status === 'error' ? outcome.error : '',
      MAX_EXECUTOR_SUMMARY_CHARS
    )
    const after = await snapshot()
    job.afterSnapshot = after
    job.afterFingerprint = fingerprintOf(after)
    job.madeProgress = job.afterFingerprint !== job.beforeFingerprint
    job.settleCompletion()
  }

  async function handleJobCompletion(job: ReviewFixJob, outcome: InternalTurnOutcome): Promise<void> {
    await finalizeJob(job, outcome)
    try {
      // Preserve the terminal result BEFORE any transition: `wait` recovers the job on terminal paths
      // (cancel, executor_unavailable, max_iterations, no_progress) and after the loop has ended.
      rememberFinishedJob(job)
      const current = activeLoop
      if (!current || current.loopId !== job.loopId || current.activeJob?.jobId !== job.jobId) {
        // Job from a loop that already left the slot (e.g. dispose during cancelling): guard the history.
        const historical = loopsById.get(job.loopId)
        if (historical?.activeJob?.jobId === job.jobId) historical.activeJob = undefined
        notify()
        return
      }
      current.activeJob = undefined
      if (current.status === 'cancelling') {
        // Cancellation of the running job is complete: the loop is terminal, but visual teardown still holds the slot.
        current.status = 'cancelled'
        releaseTerminalSlot(current)
        notify()
        return
      }
      if (current.status !== 'executing') {
        // Loop already ended (defensive): only clear the job record, without a transition.
        notify()
        return
      }
      current.roundsExecuted = job.iteration
      if (job.status === 'completed') current.roundsCompleted += 1
      else if (job.status === 'failed') current.roundsFailed += 1
      else if (job.status === 'cancelled') current.roundsCancelled += 1
      current.expectedWorkspace = job.afterSnapshot ?? current.expectedWorkspace
      current.iteration = job.iteration + 1
      if (!job.madeProgress) {
        current.noProgressCount += 1
        lastNoProgressFindingsFingerprint = job.findingsFingerprint
      } else {
        current.noProgressCount = 0
        lastNoProgressFindingsFingerprint = null
      }
      deps.setReviewIteration(current.loopId, current.iteration)

      // Automatic termination: never exceed the job hard cap, even if progress continues.
      if (job.status === 'cancelled') {
        terminate('cancelled', 'review-loop-cancelled')
        return
      }
      if (job.status === 'failed') {
        // ANY executor-turn failure is terminal: the loop never returns to reviewing. Unavailability
        // (no-key/no-model/executor-unavailable) retains its specific reason; other errors become 'failed'.
        const unavailable = outcome.status === 'error' && isExecutorUnavailableError(outcome.error)
        terminate(
          unavailable ? 'executor_unavailable' : 'failed',
          unavailable ? 'executor-unavailable' : 'review-loop-failed'
        )
        return
      }
      if (job.iteration >= current.maxIterations) {
        terminate('max_iterations', 'max-iterations-reached')
        return
      }
      if (current.noProgressCount >= 2) {
        terminate('no_progress', 'no-progress-limit')
        return
      }
      current.status = 'reviewing'
      notify()
    } finally {
      // CANONICAL transition complete (or the loop was already historical/terminal): `wait` builds the
      // terminal result only AFTER this, never with pre-transition iteration/status.
      job.settleStateApplied()
    }
  }

  /**
   * A hook (revalidateSelection/startTurn) REJECTED after job creation: the turn will never be admitted,
   * so NOTHING would call handleJobCompletion. Make the job terminal immediately (wait/Stop resolve;
   * never leave 'running' pending), drop the retry cache, and END the loop as failed or executor_unavailable.
   */
  const failJobFromHook = (job: ReviewFixJob, cacheKey: string, error: unknown): { error: string } => {
    const message = error instanceof Error ? error.message : String(error)
    job.status = 'failed'
    job.finishedAt = now()
    job.executorSummary = clip(message, MAX_EXECUTOR_SUMMARY_CHARS)
    job.settleCompletion()
    rememberFinishedJob(job)
    submitKeys.delete(cacheKey)
    const current = activeLoop
    if (current && current.activeJob?.jobId === job.jobId) detachJob(current)
    const result = isExecutorUnavailableError(message)
      ? terminate('executor_unavailable', 'executor-unavailable')
      : terminate('failed', 'review-loop-failed')
    // Canonical state applied (detach/terminate); wait builds its result only after this.
    job.settleStateApplied()
    return result
  }

  /**
   * A hook (revalidateSelection/startTurn) returned ok:false AFTER job creation/caching: the turn will
   * never be admitted, so NOTHING would call handleJobCompletion. Make the job terminal immediately
   * (wait/Stop resolve; never leave 'running' pending), drop the retry cache, and keep outcomes consistent:
   * executor_unavailable → END the loop (preserve the reason); transient error → failed job, loop returns
   * to reviewing (retry allowed). If the loop was cancelling (Stop during preflight), detachJob completes
   * termination; this path never resurrects the loop.
   */
  const failJobFromSubmit = (job: ReviewFixJob, cacheKey: string, message: string): { error: string } => {
    const unavailable = isExecutorUnavailableError(message)
    job.status = 'failed'
    job.finishedAt = now()
    job.executorSummary = clip(message, MAX_EXECUTOR_SUMMARY_CHARS)
    job.settleCompletion()
    rememberFinishedJob(job)
    submitKeys.delete(cacheKey)
    const current = activeLoop
    if (current && current.activeJob?.jobId === job.jobId) {
      const wasExecuting = current.status === 'executing'
      detachJob(current)
      if (wasExecuting && !unavailable) {
        // Transient error (busy/context-overflow/…): return the loop to reviewing for a reviewer retry.
        current.status = 'reviewing'
        notify()
      }
    }
    // Canonical state applied (detach/return to reviewing); wait builds its result only after this.
    job.settleStateApplied()
    return unavailable ? terminate('executor_unavailable', 'executor-unavailable') : { error: message }
  }

  /**
   * Stop during preflight (signal aborted before admission): the job was never admitted; mark it
   * 'cancelled' immediately (wait resolves; never leave 'running' pending) and drop the retry cache.
   * If the loop was cancelling, detachJob completes termination and releases the slot.
   */
  const cancelJobFromPreflight = async (job: ReviewFixJob, cacheKey: string): Promise<{ error: string }> => {
    await finalizeJob(job, { status: 'cancelled', assistantMessageId: null })
    rememberFinishedJob(job)
    submitKeys.delete(cacheKey)
    const current = activeLoop
    if (current && current.activeJob?.jobId === job.jobId) detachJob(current)
    job.settleStateApplied()
    notify()
    return { error: 'review-loop-cancelled' }
  }

  async function doSubmit(input: SubmitReviewFixInput): Promise<ResultOrError<SubmitReviewFixResult>> {
    const fingerprint = submitFingerprint(input)
    // Per-loop retry cache: idempotency applies within the SAME loop (compound key: loop_id + key).
    const cacheKey = `${input.loopId}\0${input.idempotencyKey}`
    const cached = submitKeys.get(cacheKey)
    if (cached) {
      return cached.fingerprint === fingerprint ? cached.result : { error: 'idempotency-conflict' }
    }
    const current = activeLoop
    if (!current || input.loopId !== current.loopId) {
      // Historical loops are terminal: return a code consistent with the stop reason (or loop-not-found).
      const historical = loopsById.get(input.loopId)
      if (historical?.finishReason) {
        return { error: REVIEW_LOOP_END_CODES[historical.finishReason] ?? 'review-loop-ended' }
      }
      return { error: 'loop-not-found' }
    }
    if (current.status === 'executing') return { error: 'job-active' }
    if (current.status !== 'reviewing') {
      return {
        error: current.finishReason
          ? (REVIEW_LOOP_END_CODES[current.finishReason] ?? 'review-loop-ended')
          : 'review-loop-ended',
      }
    }
    if (input.iteration !== current.iteration) return { error: 'wrong-iteration' }
    const shaped = validateFindingsShape(input.findings)
    if (!shaped.ok) return { error: shaped.error }
    const findings = shaped.findings
    if (!hasFindingAtOrAboveThreshold(findings, current.severityThreshold)) {
      return { error: 'below-threshold' }
    }
    if (typeof input.reviewerNotes === 'string' && input.reviewerNotes.length > MAX_REVIEWER_NOTES_CHARS) {
      return { error: `reviewer_notes too large (limit ${MAX_REVIEWER_NOTES_CHARS} characters).` }
    }

    const findingsFp = createHash('sha256')
      .update(
        JSON.stringify(
          findings.map((f) => ({
            id: f.id,
            severity: f.severity,
            title: f.title,
            details: f.details,
            paths: f.paths ?? [],
          }))
        )
      )
      .digest('hex')

    // Progress gate: repeating the SAME round without changes terminates; two unchanged rounds also terminate.
    if (current.noProgressCount >= 2) return terminate('no_progress', 'no-progress-limit')
    if (current.noProgressCount >= 1 && lastNoProgressFindingsFingerprint === findingsFp) {
      return terminate('no_progress', 'no-progress-repeat')
    }
    if (current.iteration > current.maxIterations) return terminate('max_iterations', 'max-iterations-reached')

    // Expected tree: external changes between rounds would give the reviewer a different tree to evaluate.
    const currentSnapshot = await snapshot()
    if (fingerprintOf(currentSnapshot) !== fingerprintOf(current.expectedWorkspace)) {
      return terminate('workspace_changed_externally', 'workspace-changed-externally')
    }

    // Per-iteration investigation gate: require FRESH review (diff + search + read) in this round.
    // Evidence is SCOPED to loopId; never reuse investigation from a previous loop.
    const evidence = deps.getReviewEvidence(current.loopId)
    const evidenceError = reviewEvidenceError({
      evidence,
      iteration: input.iteration,
      reviewScope: current.reviewScope,
      requireContextLoaded: true,
    })
    if (evidenceError) return { error: evidenceError }

    let settleCompletion!: () => void
    const completion = new Promise<void>((resolve) => {
      settleCompletion = resolve
    })
    let settleStateApplied!: () => void
    const stateApplied = new Promise<void>((resolve) => {
      settleStateApplied = resolve
    })
    const job: ReviewFixJob = {
      jobId: `j_${randomBytes(5).toString('hex')}`,
      loopId: current.loopId,
      iteration: input.iteration,
      startedAt: now(),
      executionId: '',
      controller: new AbortController(),
      status: 'running',
      beforeFingerprint: fingerprintOf(current.expectedWorkspace),
      madeProgress: false,
      findingsFingerprint: findingsFp,
      completion,
      settleCompletion,
      stateApplied,
      settleStateApplied,
    }
    // Set state + cache synchronously BEFORE await: concurrent retries see the job and never duplicate a turn.
    current.activeJob = job
    current.status = 'executing'
    const result: SubmitReviewFixResult = {
      loopId: current.loopId,
      jobId: job.jobId,
      iteration: input.iteration,
      status: 'running',
      startedAt: job.startedAt,
    }
    cachePut(submitKeys, cacheKey, { fingerprint, result })
    notify()

    const t = tFor(getLocale(), 'prompts')
    const prompt = t('reviewLoop.implementFindings', {
      iteration: input.iteration,
      max: current.maxIterations,
    })
    const hiddenPart: MessagePart = {
      type: 'file',
      id: randomUUID(),
      name: 'review-loop-findings.md',
      mediaType: 'text/markdown',
      kind: 'text',
      data: buildFindingsMarkdown(current, findings, input.reviewerNotes),
      hidden: true,
    }
    // Revalidate identity between rounds: changed fingerprint/epoch → executor_unavailable (never switch).
    if (deps.revalidateSelection) {
      let revalidated: { ok: true } | { ok: false; error: string }
      try {
        revalidated = await deps.revalidateSelection(current.selection)
      } catch (error) {
        // Unexpected hook rejection: terminal job + ended loop; never leave a 'running' job pending.
        return failJobFromHook(job, cacheKey, error)
      }
      if (!revalidated.ok) {
        // Stop during revalidation preflight: same outcome as aborted startTurn (terminal 'cancelled' job);
        // never return the loop to reviewing over a cancellation.
        if (job.controller.signal.aborted) return await cancelJobFromPreflight(job, cacheKey)
        return failJobFromSubmit(job, cacheKey, revalidated.error)
      }
    }
    let started: Awaited<ReturnType<Deps['startTurn']>>
    try {
      started = await deps.startTurn({
        prompt,
        hiddenParts: [hiddenPart],
        selection: current.selection,
        loopId: current.loopId,
        iteration: current.iteration,
        maxIterations: current.maxIterations,
        signal: job.controller.signal,
      })
    } catch (error) {
      // Unexpected hook rejection: terminal job + ended loop; never leave a 'running' job pending.
      return failJobFromHook(job, cacheKey, error)
    }
    if (job.controller.signal.aborted) {
      // Stop during startTurn preflight: NEVER return to reviewing. Cancel the handle immediately if
      // created; the job remains terminal and recoverable via wait.
      if (started.ok) {
        job.executionId = started.handle.executionId
        started.handle.cancel()
        // Finalization follows the natural path (handle.done → handleJobCompletion): with the loop already
        // cancelled, it only records the terminal job without a transition.
        started.handle.done
          .then((outcome) => handleJobCompletion(job, outcome))
          .catch(() => {
            /* finalizeJob is fail-safe; the job never gets stuck in 'running' */
          })
        // The retry cache must not return a defunct 'running' result; new submissions are already rejected
        // by loop state (cancelling/cancelled).
        submitKeys.delete(cacheKey)
        notify()
        return { error: 'review-loop-cancelled' }
      }
      return await cancelJobFromPreflight(job, cacheKey)
    }
    if (!started.ok) return failJobFromSubmit(job, cacheKey, started.error)
    job.executionId = started.handle.executionId
    started.handle.done
      .then((outcome) => handleJobCompletion(job, outcome))
      .catch(() => {
        /* finalizeJob is fail-safe; the job never remains unsettled in 'running' */
      })
    return result
  }

  function submit(input: SubmitReviewFixInput): Promise<ResultOrError<SubmitReviewFixResult>> {
    const fingerprint = submitFingerprint(input)
    if (submitting) {
      if (submitting.key === input.idempotencyKey && submitting.fingerprint === fingerprint) return submitting.promise
      return submitting.promise.then(async (result) => {
        if ('error' in result) return result
        // The concurrent job won: this call re-evaluates the current state.
        return doSubmit(input)
      })
    }
    const promise = doSubmit(input)
    submitting = { key: input.idempotencyKey, fingerprint, promise }
    return promise.finally(() => {
      if (submitting?.promise === promise) submitting = null
    })
  }

  // ---------------------------------------------------------------- wait

  function buildJobWaitResult(
    current: ReviewLoopState,
    job: ReviewFixJob
  ): Extract<ReviewFixWaitResult, { status: string }> {
    const canContinue = current.status === 'reviewing' && current.iteration <= current.maxIterations
    return {
      status: job.status,
      iteration: job.iteration,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? now(),
      ...(job.assistantMessageId ? { assistantMessageId: job.assistantMessageId } : {}),
      ...(job.executorSummary ? { executorSummary: job.executorSummary } : {}),
      madeProgress: job.madeProgress,
      beforeFingerprint: job.beforeFingerprint,
      afterFingerprint: job.afterFingerprint ?? job.beforeFingerprint,
      nextIteration: current.iteration,
      canContinue,
      ...(canContinue ? {} : { stopReason: current.finishReason ?? 'max_iterations' }),
    }
  }

  async function wait(
    input: { loopId: string; jobId: string; waitSeconds: number },
    signal?: AbortSignal
  ): Promise<ResultOrError<ReviewFixWaitResult>> {
    // Active OR historical loop: late wait calls still work while another loop is active.
    const current = activeLoop?.loopId === input.loopId ? activeLoop : loopsById.get(input.loopId)
    if (!current) return { error: 'loop-not-found' }
    const job =
      current.activeJob?.jobId === input.jobId ? current.activeJob : jobsByLoop.get(input.loopId)?.get(input.jobId)
    if (!job) return { error: 'unknown-job' }
    if (job.status !== 'running') {
      // Has the CANONICAL transition been applied? (finalizeJob sets status BEFORE the controller updates
      // iteration/rounds/status; otherwise the first terminal result could carry pre-transition state).
      await job.stateApplied
      return buildJobWaitResult(current, job)
    }

    const deadline = now() + input.waitSeconds * 1000
    return await new Promise<ResultOrError<ReviewFixWaitResult>>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      const onAbort = () => finish({ error: 'session-ended' })
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      const finish = (value: ResultOrError<ReviewFixWaitResult>) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        cleanup()
        resolve(value)
      }
      const tick = () => {
        // Job finalized (or finalizing after preflight cancellation) → structured terminal result,
        // ALWAYS after the canonical controller transition (stateApplied), never pre-transition state.
        // A terminal loop with a job still 'running' keeps polling until finalization; never return
        // 'running' for a dead loop before recording the job as terminal.
        if (job.status !== 'running') {
          void job.stateApplied.then(() => finish(buildJobWaitResult(current, job)))
          return
        }
        if (now() >= deadline) {
          finish({ status: 'running', iteration: job.iteration, startedAt: job.startedAt })
          return
        }
        timer = setTimeout(tick, WAIT_POLL_MS)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      tick()
    })
  }

  // ---------------------------------------------------------------- finish

  async function finish(input: FinishReviewLoopInput): Promise<ResultOrError<FinishReviewLoopResult>> {
    const fp = finishFingerprint(input)
    const cacheKey = `${input.loopId}\0${input.idempotencyKey}`
    const cached = finishKeys.get(cacheKey)
    if (cached) return cached.fingerprint === fp ? cached.result : { error: 'idempotency-conflict' }

    // Look up by loop_id (active OR historical): a late finish from loop A never touches loop B.
    const current = activeLoop?.loopId === input.loopId ? activeLoop : loopsById.get(input.loopId)
    if (!current) return { error: 'loop-not-found' }

    // Canonical finalization already exists: compatible → retry missing persistence; incompatible → error.
    if (current.finalization) {
      if (input.result !== current.finalization.result.result) return { error: 'inconsistent-result' }
      if (current.finalization.summaryPersisted) {
        cachePut(finishKeys, cacheKey, { fingerprint: fp, result: current.finalization.result })
        return current.finalization.result
      }
      // Previous persistence failed: retry the SAME upsert (stable messageId per loopId).
      const retry = await deps.persistSummary({
        loopId: current.loopId,
        markdown: current.finalization.summaryMarkdown,
      })
      if (!retry.ok) {
        current.finalization.persistenceError = retry.error
        return { error: 'summary-persist-failed' }
      }
      current.finalization.summaryPersisted = true
      current.finalization.summaryMessageId = retry.messageId
      current.finalization.persistenceError = undefined
      cachePut(finishKeys, cacheKey, { fingerprint: fp, result: current.finalization.result })
      return current.finalization.result
    }

    if (current.status === 'executing' || current.status === 'cancelling') return { error: 'job-active' }
    if (current.status === 'finishing' || current.status === 'finished' || current.status === 'cancelled') {
      // Already terminal without finalization: accept only an outcome consistent with the actual reason.
      const expected = expectedResultFor(current.finishReason)
      if (!expected || input.result !== expected) return { error: 'inconsistent-result' }
    } else if (current.status === 'reviewing') {
      // While the controller is still reviewing, only `clean` can finish voluntarily (and requires fresh
      // evidence below). Other outcomes derive from STATE: executor/job, hard cap, no-progress, or explicit
      // cancellation must first make the loop terminal. Without this barrier, the reviewer could use
      // `cancelled` merely to end its current response, publish a zero-round summary, and incorrectly release
      // the lock even though the user never cancelled.
      if (input.result === 'max_iterations') return { error: 'max-not-reached' }
      if (input.result !== 'clean') return { error: 'loop-not-terminal' }
      if (input.result === 'clean') {
        // Evidence is SCOPED to the loop: a late finish from loop A never uses checks/reads from loop B.
        const evidence = deps.getReviewEvidence(current.loopId)
        const evidenceError = reviewEvidenceError({
          evidence,
          iteration: current.iteration,
          reviewScope: current.reviewScope,
          requireContextLoaded: false,
        })
        if (evidenceError) return { error: evidenceError }
        if ((input.remainingFindings ?? []).some((f) => f.severity === 'blocking' || f.severity === 'important')) {
          return { error: 'remaining-blocking-findings' }
        }
      }
    }

    // 1. Canonical outcome + markdown; 2. finalization in state; 3. attempt persistence; 4. only then return ok.
    current.status = 'finishing'
    const finalFingerprint = fingerprintOf(current.expectedWorkspace)
    // Evidence from this loop ONLY (never from a new active loop, if this is a late finish).
    const summaryMarkdown = buildAuditSummary(current, input, deps.getReviewEvidence(current.loopId), finalFingerprint)
    current.status = 'finished'
    current.finishReason = current.finishReason ?? (input.result === 'clean' ? 'clean' : input.result)
    current.finishedAt = now()
    const result: FinishReviewLoopResult = {
      loopId: current.loopId,
      result: input.result,
      iterations: current.roundsExecuted,
      durationMs: Math.max(0, current.finishedAt - current.startedAt),
      startedAt: current.startedAt,
      finishedAt: current.finishedAt,
      baselineFingerprint: fingerprintOf(current.baseline),
      finalFingerprint,
      ...(current.finishReason ? { finishReason: current.finishReason } : {}),
    }
    current.finalization = {
      result,
      fingerprint: fp,
      summaryMarkdown,
      summaryPersisted: false,
    }
    await teardownVisualEnvironment(current)
    // Leave the active slot BEFORE persistence (allow a new loop); history preserves wait/finish.
    // archiveLoop uses compare-and-clear by loopId; it never clears loop B's pointer.
    archiveLoop(current)
    notify()

    const persisted = await deps.persistSummary({ loopId: current.loopId, markdown: summaryMarkdown })
    if (!persisted.ok) {
      current.finalization.persistenceError = persisted.error
      // Do NOT cache the result: the tool returns an error; retries (same or different key) repeat the upsert.
      return { error: 'summary-persist-failed' }
    }
    current.finalization.summaryPersisted = true
    current.finalization.summaryMessageId = persisted.messageId
    cachePut(finishKeys, cacheKey, { fingerprint: fp, result })
    return result
  }

  // ---------------------------------------------------------------- stop / info

  /** Explicit cancellation (Stop button or session end). Cancel the active job and block new rounds. */
  function cancel(reason: 'cancelled' | 'session_ended' = 'cancelled'): void {
    const current = activeLoop
    if (!current || current.status === 'finished' || current.status === 'cancelled' || current.status === 'cancelling')
      return
    current.finishReason = reason
    current.finishedAt = now()
    void teardownVisualEnvironment(current)
    if (current.activeJob) {
      // Running/preflight job: enter CANCELLING and release the slot only after the outcome arrives;
      // never allow concurrency before the runner exits (never two agents in the same workspace).
      current.status = 'cancelling'
      // Immediate abort covers turns still in preflight (no executionId); cancelTurn additionally protects
      // against an already admitted runner (aborts the run and rejects brokers/open questions).
      current.activeJob.controller.abort()
      if (current.activeJob.executionId) deps.cancelTurn(current.activeJob.executionId)
      // Compare-and-clear: clear only if the pointer still belongs to this loop (protect loop B).
      deps.clearReviewIteration(current.loopId)
      notify()
      return
    }
    // No active job (reviewing/finishing): immediately terminal; visual resources still form a barrier.
    current.status = 'cancelled'
    releaseTerminalSlot(current)
    notify()
  }

  function info(): ReviewLoopControllerInfo | null {
    // While activeLoop exists, this loop still owns the conversation lock. Terminal states remain visible
    // during visual teardown so the renderer cannot release the composer before the barrier clears.
    const current = activeLoop
    if (!current) return null
    return {
      loopId: current.loopId,
      status: current.status,
      iteration: current.iteration,
      maxIterations: current.maxIterations,
      startedAt: current.startedAt,
      modelId: current.selection.modelId,
      ...(current.selection.reasoning ? { reasoning: current.selection.reasoning } : {}),
      fastMode: current.selection.fastMode === true,
      contextPolicy: 'isolated',
      roundsCompleted: current.roundsCompleted,
      roundsFailed: current.roundsFailed,
      roundsCancelled: current.roundsCancelled,
      reviewScope: current.reviewScope,
      ...(current.visualEnvironment
        ? {
            visual: {
              state: current.visualEnvironment.info.state,
              ...(current.visualEnvironment.info.url ? { url: current.visualEnvironment.info.url } : {}),
              managedPreview: current.visualEnvironment.ownership === 'managed',
            },
          }
        : {}),
      ...(current.activeJob ? { jobStartedAt: current.activeJob.startedAt } : {}),
      ...(current.finishReason ? { finishReason: current.finishReason } : {}),
    }
  }

  /** Active loop ID (conversation lock in the service); null after teardown or if absent. */
  function activeLoopId(): string | null {
    return activeLoop?.loopId ?? null
  }

  /** Admission barrier for other companion automations, including the pre-lock startup window. */
  function busy(): boolean {
    return starting !== null || activeLoop !== null || stopping !== null
  }

  /** Internal state (tests/diagnostics); never exposed by the bridge. */
  function getState(): ReviewLoopState | null {
    if (activeLoop) return activeLoop
    // Diagnostics: return the last (most recent) historical loop when none is active.
    let last: ReviewLoopState | null = null
    for (const state of loopsById.values()) last = state
    return last
  }

  /** Loop by ID (active or historical), for tests/diagnostics. */
  function getLoop(loopId: string): ReviewLoopState | null {
    if (activeLoop?.loopId === loopId) return activeLoop
    return loopsById.get(loopId) ?? null
  }

  /** Permanent teardown (session end/shutdown): cancel the active loop and clear all state. */
  function dispose(): void {
    const visualTeardowns: Promise<void>[] = []
    if (activeLoop?.visualEnvironment) visualTeardowns.push(teardownVisualEnvironment(activeLoop))
    for (const state of loopsById.values()) {
      if (state.visualEnvironment) visualTeardowns.push(teardownVisualEnvironment(state))
    }
    cancel('session_ended')
    // Evict evidence from ALL known loops before clearing state.
    for (const state of loopsById.values()) deps.forgetReviewLoop(state.loopId)
    if (activeLoop) deps.forgetReviewLoop(activeLoop.loopId)
    if (activeLoop) deps.releaseParticipants?.(activeLoop.loopId)
    activeLoop = null
    loopsById.clear()
    jobsByLoop.clear()
    startedKeys.clear()
    submitKeys.clear()
    finishKeys.clear()
    deps.setReviewIteration(null, null)
    if (visualTeardowns.length > 0) {
      let barrier!: Promise<void>
      barrier = Promise.allSettled(visualTeardowns).then(() => {
        if (stopping === barrier) stopping = null
        notify()
      })
      stopping = barrier
    }
  }

  const discoverFrontendPreviews = async (): Promise<TVisualTarget[]> =>
    deps.discoverFrontendPreviews ? deps.discoverFrontendPreviews() : []

  const visualBrowser = (loopId?: string): TVisualBrowser | null => {
    const current = loopId ? (activeLoop?.loopId === loopId ? activeLoop : loopsById.get(loopId)) : activeLoop
    const environment = current?.visualEnvironment
    return current?.reviewScope === 'frontend' && environment && !environment.disposed ? environment.browser : null
  }

  const showVisualPreview = (): boolean => activeLoop?.visualEnvironment?.browser.show() ?? false

  return {
    start,
    submit,
    wait,
    finish,
    cancel,
    info,
    activeLoopId,
    busy,
    getState,
    getLoop,
    discoverFrontendPreviews,
    visualBrowser,
    showVisualPreview,
    dispose,
  }
}

export type ReviewLoopController<
  TVisualInfo extends ReviewLoopVisualInfo = ReviewLoopVisualInfo,
  TVisualBrowser extends ReviewLoopVisualBrowser<TVisualInfo> = ReviewLoopVisualBrowser<TVisualInfo>,
  TVisualPreview extends ReviewLoopVisualPreview = ReviewLoopVisualPreview,
  TVisualTarget = unknown,
> = ReturnType<typeof createReviewLoopController<TVisualInfo, TVisualBrowser, TVisualPreview, TVisualTarget>>
