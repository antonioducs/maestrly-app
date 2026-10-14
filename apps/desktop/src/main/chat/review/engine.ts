import {
  compareReviewSeverity,
  type ReviewCandidate,
  type ReviewCheckResult,
  type ReviewDroppedCandidate,
  type ReviewFinding,
  type ReviewLensId,
  type ReviewLensState,
  type ReviewStageStatus,
  type ReviewTarget,
  type ReviewVerdict,
} from '../../../shared/review'
import type { FindingsSubmission, RecordedVerdict, SubmittedFinding } from './findings'
import { checkTask, lensTask, verifierTask, type CheckFinding, type ReviewPromptContext } from './prompts'

/** Findings kept in one report; the reviewers are told to stay well below it. */
export const MAX_REPORT_FINDINGS = 30

export interface ReviewUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  totalInput: number
}

export type ReviewerRunInput =
  | {
      stage: 'lens'
      lens: ReviewLensId
      task: string
      signal: AbortSignal
      /** Each accepted `submit_findings` call, as it happens. */
      onSubmission: (submission: FindingsSubmission) => void
    }
  | {
      stage: 'verifier'
      task: string
      signal: AbortSignal
      candidateIds: string[]
      /** Each batch of verdicts, as it is recorded. */
      onVerdicts: (verdicts: RecordedVerdict[]) => void
    }
  | {
      stage: 'check'
      task: string
      signal: AbortSignal
      findingIds: string[]
      onResults: (results: ReviewCheckResult[]) => void
    }

export interface ReviewerRunResult {
  /** Lenses: the final submission. */
  submission?: FindingsSubmission | null
  /** Verifier: every verdict recorded. */
  verdicts?: RecordedVerdict[]
  /** Checks: every result recorded. */
  results?: ReviewCheckResult[]
  error?: string
  usage?: ReviewUsage
  runtimeEstimatedCostUsd?: number
}

export interface ReviewProgress {
  lenses: ReviewLensState[]
  verification: ReviewStageStatus
  candidates: ReviewCandidate[]
  verdicts: ReviewVerdict[]
}

export interface ReviewEngineInput {
  target: ReviewTarget
  lenses: readonly ReviewLensId[]
  context: ReviewPromptContext
  signal: AbortSignal
  runReviewer: (input: ReviewerRunInput) => Promise<ReviewerRunResult>
  onProgress?: (progress: ReviewProgress) => void
}

export interface ReviewEngineResult {
  /** Confirmed findings first, most severe first; then any the verifier did not rule on. */
  findings: ReviewFinding[]
  dropped: ReviewDroppedCandidate[]
  candidates: ReviewCandidate[]
  verdicts: ReviewVerdict[]
  lenses: ReviewLensState[]
  verification: ReviewStageStatus
  /** Some findings are not confirmed because the verifier failed or skipped them. */
  unverified: boolean
  failedLenses: ReviewLensId[]
  usage: ReviewUsage
  runtimeEstimatedCostUsd: number
}

export class ReviewEngineError extends Error {
  constructor(
    readonly code: 'cancelled' | 'reviewers-failed' | 'checker-failed',
    message?: string
  ) {
    super(message ?? code)
  }
}

interface Candidate extends SubmittedFinding {
  id: string
  lens: ReviewLensId
}

function emptyUsage(): ReviewUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 }
}

function addUsage(total: ReviewUsage, next: ReviewUsage | undefined): void {
  if (!next) return
  for (const key of ['input', 'output', 'cacheRead', 'cacheCreate', 'totalInput'] as const) {
    const value = next[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) total[key] += value
  }
}

/** Runs reviewers while adding up their usage; an error that is not a cancellation becomes the run's error. */
function createRunner(input: Pick<ReviewEngineInput, 'runReviewer' | 'signal'>) {
  const usage = emptyUsage()
  let cost = 0
  const run = async (runInput: ReviewerRunInput): Promise<ReviewerRunResult> => {
    try {
      const result = await input.runReviewer(runInput)
      addUsage(usage, result.usage)
      if (typeof result.runtimeEstimatedCostUsd === 'number' && Number.isFinite(result.runtimeEstimatedCostUsd)) {
        cost += Math.max(0, result.runtimeEstimatedCostUsd)
      }
      return result
    } catch (error) {
      if (input.signal.aborted) throw new ReviewEngineError('cancelled')
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { run, usage, cost: () => cost }
}

function publicCandidate(candidate: Candidate): ReviewCandidate {
  return {
    id: candidate.id,
    lens: candidate.lens,
    severity: candidate.severity,
    title: candidate.title,
    ...(candidate.path ? { path: candidate.path } : {}),
    ...(candidate.line ? { line: candidate.line } : {}),
    ...(candidate.planLine ? { planLine: candidate.planLine } : {}),
  }
}

function candidatePayload(candidates: readonly Candidate[]): unknown[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    lens: candidate.lens,
    severity: candidate.severity,
    title: candidate.title,
    details: candidate.details,
    evidence: candidate.evidence,
    ...(candidate.suggestion ? { suggestion: candidate.suggestion } : {}),
    ...(candidate.path ? { path: candidate.path } : {}),
    ...(candidate.line ? { line: candidate.line } : {}),
    ...(candidate.planLine ? { plan_line: candidate.planLine } : {}),
  }))
}

function publicVerdict(verdict: RecordedVerdict, candidate: Candidate | undefined): ReviewVerdict {
  return {
    candidateId: verdict.candidateId,
    verdict: verdict.verdict,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(verdict.into ? { into: verdict.into } : {}),
    ...(verdict.verdict === 'confirmed' ? { severity: verdict.severity ?? candidate?.severity ?? 'minor' } : {}),
  }
}

type DraftFinding = Omit<ReviewFinding, 'id'> & { order: number }

function draftFinding(candidate: Candidate, verdict: RecordedVerdict | undefined, order: number): DraftFinding {
  const severity = verdict?.severity ?? candidate.severity
  const path = verdict?.path ?? candidate.path
  const line = verdict?.path ? verdict.line : (verdict?.line ?? candidate.line)
  const planLine = verdict?.planLine ?? candidate.planLine
  const suggestion = verdict?.suggestion ?? candidate.suggestion
  return {
    order,
    severity,
    title: verdict?.title ?? candidate.title,
    details: verdict?.details ?? candidate.details,
    evidence: verdict?.evidence ?? candidate.evidence,
    ...(suggestion ? { suggestion } : {}),
    ...(path ? { path } : {}),
    ...(path && line ? { line } : {}),
    ...(planLine ? { planLine } : {}),
    lens: candidate.lens,
    candidateId: candidate.id,
    ...(verdict && severity !== candidate.severity ? { fromSeverity: candidate.severity } : {}),
    ...(verdict ? {} : { unverified: true }),
  }
}

/** Confirmed before unconfirmed, then most severe, then lens order; numbered F1…Fn. */
function numbered(findings: DraftFinding[], lenses: readonly ReviewLensId[]): ReviewFinding[] {
  return findings
    .sort(
      (a, b) =>
        Number(!!a.unverified) - Number(!!b.unverified) ||
        compareReviewSeverity(a.severity, b.severity) ||
        lenses.indexOf(a.lens) - lenses.indexOf(b.lens) ||
        a.order - b.order
    )
    .slice(0, MAX_REPORT_FINDINGS)
    .map(({ order: _order, ...finding }, index) => ({ id: `F${index + 1}`, ...finding }))
}

/**
 * One review pass: every lens reviews in parallel, then a verifier rules on every candidate. Candidates and verdicts
 * are published as they happen. A failed lens does not fail the review; candidates the verifier never ruled on (it
 * failed or skipped them) come back marked as unverified.
 */
export async function runReviewEngine(input: ReviewEngineInput): Promise<ReviewEngineResult> {
  const runner = createRunner(input)
  const lenses: ReviewLensState[] = input.lenses.map((id) => ({ id, status: 'pending' }))
  let verification: ReviewStageStatus = 'pending'
  let nextCandidate = 1
  const byLens = new Map<ReviewLensId, Candidate[]>()
  const verdicts = new Map<string, RecordedVerdict>()
  const allCandidates = (): Candidate[] =>
    input.lenses.flatMap((lens) => byLens.get(lens) ?? []).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
  const progress = (): void => {
    if (input.signal.aborted) return
    const candidates = allCandidates()
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    input.onProgress?.({
      lenses: lenses.map((lens) => ({ ...lens })),
      verification,
      candidates: candidates.map(publicCandidate),
      verdicts: [...verdicts.values()].map((verdict) => publicVerdict(verdict, byId.get(verdict.candidateId))),
    })
  }
  // A lens that submits again replaces its earlier candidates; numbering keeps going so ids are never reused.
  const accept = (lens: ReviewLensId, submission: FindingsSubmission): void => {
    byLens.set(
      lens,
      submission.findings.map((finding) => ({ ...finding, id: `C${nextCandidate++}`, lens }))
    )
    const state = lenses.find((item) => item.id === lens)
    if (state) state.candidates = submission.findings.length
    progress()
  }

  if (input.signal.aborted) throw new ReviewEngineError('cancelled')
  for (const lens of lenses) lens.status = 'running'
  progress()
  const lensResults = await Promise.all(
    lenses.map(async (lens) => {
      let submitted: FindingsSubmission | null = null
      const result = await runner.run({
        stage: 'lens',
        lens: lens.id,
        task: lensTask(lens.id, input.context),
        signal: input.signal,
        onSubmission: (submission) => {
          submitted = submission
          accept(lens.id, submission)
        },
      })
      // What the reviewer submitted counts even when its run failed afterwards.
      const submission = result.submission ?? submitted
      // A submission recovered from the reviewer's text never went through the tool.
      if (submission && submission !== submitted) accept(lens.id, submission)
      if (!submission) {
        byLens.delete(lens.id)
        lens.candidates = undefined
      }
      lens.status = submission ? 'done' : 'failed'
      progress()
      return { lens: lens.id, submission, error: result.error }
    })
  )
  if (input.signal.aborted) throw new ReviewEngineError('cancelled')

  const failedLenses = lensResults.filter((result) => !result.submission).map((result) => result.lens)
  if (failedLenses.length === lenses.length) {
    const reason = lensResults.find((result) => result.error)?.error ?? 'No reviewer submitted findings.'
    throw new ReviewEngineError('reviewers-failed', reason)
  }

  const candidates = allCandidates()
  const finish = (findings: ReviewFinding[], dropped: ReviewDroppedCandidate[]): ReviewEngineResult => {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    return {
      findings,
      dropped,
      candidates: candidates.map(publicCandidate),
      verdicts: [...verdicts.values()].map((verdict) => publicVerdict(verdict, byId.get(verdict.candidateId))),
      lenses,
      verification,
      unverified: findings.some((finding) => finding.unverified),
      failedLenses,
      usage: runner.usage,
      runtimeEstimatedCostUsd: runner.cost(),
    }
  }
  if (candidates.length === 0) {
    verification = 'skipped'
    progress()
    return finish([], [])
  }

  verification = 'running'
  progress()
  const verified = await runner.run({
    stage: 'verifier',
    task: verifierTask(candidatePayload(candidates), input.context),
    signal: input.signal,
    candidateIds: candidates.map((candidate) => candidate.id),
    onVerdicts: (batch) => {
      for (const verdict of batch) verdicts.set(verdict.candidateId, verdict)
      progress()
    },
  })
  if (input.signal.aborted) throw new ReviewEngineError('cancelled')
  for (const verdict of verified.verdicts ?? []) verdicts.set(verdict.candidateId, verdict)
  verification = verified.error && verdicts.size === 0 ? 'failed' : 'done'

  const drafts: DraftFinding[] = []
  const dropped: ReviewDroppedCandidate[] = []
  candidates.forEach((candidate, order) => {
    const verdict = verdicts.get(candidate.id)
    if (verdict && verdict.verdict !== 'confirmed') {
      dropped.push({
        id: candidate.id,
        lens: candidate.lens,
        severity: candidate.severity,
        title: candidate.title,
        verdict: verdict.verdict,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        ...(verdict.into ? { into: verdict.into } : {}),
      })
      return
    }
    drafts.push(draftFinding(candidate, verdict, order))
  })
  for (const draft of drafts) {
    const merged = dropped.filter((item) => item.verdict === 'merged' && item.into === draft.candidateId)
    if (merged.length) draft.merged = merged.map((item) => item.id)
  }
  progress()
  return finish(numbered(drafts, input.lenses), dropped)
}

export interface ReviewCheckEngineResult {
  results: ReviewCheckResult[]
  usage: ReviewUsage
  runtimeEstimatedCostUsd: number
}

/**
 * One verifier pass over the findings the person sent: is each fix (or plan revision) holding up? Findings it did not
 * get to come back as unknown. Fails only when the checker recorded nothing at all.
 */
export async function runReviewCheck(input: {
  findings: readonly CheckFinding[]
  context: ReviewPromptContext
  signal: AbortSignal
  runReviewer: (input: ReviewerRunInput) => Promise<ReviewerRunResult>
  onResults?: (results: ReviewCheckResult[]) => void
}): Promise<ReviewCheckEngineResult> {
  const runner = createRunner(input)
  const results = new Map<string, ReviewCheckResult>()
  const ids = input.findings.map((finding) => finding.id)
  const publish = (): void => {
    if (!input.signal.aborted) input.onResults?.(ids.flatMap((id) => (results.has(id) ? [results.get(id)!] : [])))
  }
  if (input.signal.aborted) throw new ReviewEngineError('cancelled')
  const result = await runner.run({
    stage: 'check',
    task: checkTask(input.findings, input.context),
    signal: input.signal,
    findingIds: ids,
    onResults: (batch) => {
      for (const item of batch) results.set(item.findingId, item)
      publish()
    },
  })
  if (input.signal.aborted) throw new ReviewEngineError('cancelled')
  for (const item of result.results ?? []) results.set(item.findingId, item)
  if (results.size === 0)
    throw new ReviewEngineError('checker-failed', result.error ?? 'The check recorded no results.')
  return {
    results: ids.map((id) => results.get(id) ?? { findingId: id, state: 'unknown' }),
    usage: runner.usage,
    runtimeEstimatedCostUsd: runner.cost(),
  }
}
