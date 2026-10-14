import {
  compareReviewSeverity,
  type ReviewFinding,
  type ReviewLensId,
  type ReviewLensState,
  type ReviewStageStatus,
  type ReviewTarget,
} from '../../../shared/review'
import type { FindingsSubmission, SubmittedFinding } from './findings'
import { lensTask, verifierTask, type ReviewPromptContext } from './prompts'

/** Findings kept in one report; the reviewers are told to stay well below it. */
export const MAX_REPORT_FINDINGS = 30

export interface ReviewUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  totalInput: number
}

export interface ReviewerRunInput {
  stage: 'lens' | 'verifier'
  lens?: ReviewLensId
  task: string
  signal: AbortSignal
}

export interface ReviewerRunResult {
  submission: FindingsSubmission | null
  error?: string
  usage?: ReviewUsage
  runtimeEstimatedCostUsd?: number
}

export interface ReviewProgress {
  lenses: ReviewLensState[]
  verification: ReviewStageStatus
  candidates?: number
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
  findings: ReviewFinding[]
  candidates: number
  lenses: ReviewLensState[]
  verification: ReviewStageStatus
  /** The verifier failed; the findings are the reviewers' unconfirmed candidates. */
  unverified: boolean
  failedLenses: ReviewLensId[]
  usage: ReviewUsage
  runtimeEstimatedCostUsd: number
}

export class ReviewEngineError extends Error {
  constructor(
    readonly code: 'cancelled' | 'reviewers-failed',
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

function toFinding(candidate: SubmittedFinding, lens: ReviewLensId): Omit<ReviewFinding, 'id'> {
  return {
    severity: candidate.severity,
    title: candidate.title,
    details: candidate.details,
    evidence: candidate.evidence,
    ...(candidate.suggestion ? { suggestion: candidate.suggestion } : {}),
    ...(candidate.path ? { path: candidate.path } : {}),
    ...(candidate.path && candidate.line ? { line: candidate.line } : {}),
    ...(candidate.planLine ? { planLine: candidate.planLine } : {}),
    lens,
  }
}

/** Most severe first, then in lens order, numbered F1…Fn. */
function numbered(findings: Array<Omit<ReviewFinding, 'id'>>, lenses: readonly ReviewLensId[]): ReviewFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        compareReviewSeverity(a.finding.severity, b.finding.severity) ||
        lenses.indexOf(a.finding.lens) - lenses.indexOf(b.finding.lens) ||
        a.index - b.index
    )
    .slice(0, MAX_REPORT_FINDINGS)
    .map(({ finding }, index) => ({ id: `F${index + 1}`, ...finding }))
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

/**
 * One review pass: every lens reviews in parallel, then a verifier keeps only the candidates it confirms. A failed
 * lens does not fail the review; a failed verifier returns the candidates marked as unverified.
 */
export async function runReviewEngine(input: ReviewEngineInput): Promise<ReviewEngineResult> {
  const usage = emptyUsage()
  let runtimeEstimatedCostUsd = 0
  const lenses: ReviewLensState[] = input.lenses.map((id) => ({ id, status: 'pending' }))
  let verification: ReviewStageStatus = 'pending'
  let candidateCount: number | undefined
  const progress = (): void => {
    input.onProgress?.({
      lenses: lenses.map((lens) => ({ ...lens })),
      verification,
      ...(candidateCount !== undefined ? { candidates: candidateCount } : {}),
    })
  }
  const account = (result: ReviewerRunResult): void => {
    addUsage(usage, result.usage)
    if (typeof result.runtimeEstimatedCostUsd === 'number' && Number.isFinite(result.runtimeEstimatedCostUsd)) {
      runtimeEstimatedCostUsd += Math.max(0, result.runtimeEstimatedCostUsd)
    }
  }
  const run = async (runInput: ReviewerRunInput): Promise<ReviewerRunResult> => {
    try {
      const result = await input.runReviewer(runInput)
      account(result)
      return result
    } catch (error) {
      if (input.signal.aborted) throw new ReviewEngineError('cancelled')
      return { submission: null, error: error instanceof Error ? error.message : String(error) }
    }
  }

  if (input.signal.aborted) throw new ReviewEngineError('cancelled')
  for (const lens of lenses) lens.status = 'running'
  progress()
  const lensResults = await Promise.all(
    lenses.map(async (lens) => {
      const result = await run({
        stage: 'lens',
        lens: lens.id,
        task: lensTask(lens.id, input.context),
        signal: input.signal,
      })
      const submission = result.error ? null : result.submission
      lens.status = submission ? 'done' : 'failed'
      if (submission) lens.candidates = submission.findings.length
      if (!input.signal.aborted) progress()
      return { lens: lens.id, submission, error: result.error }
    })
  )
  if (input.signal.aborted) throw new ReviewEngineError('cancelled')

  const failedLenses = lensResults.filter((result) => !result.submission).map((result) => result.lens)
  if (failedLenses.length === lenses.length) {
    const reason = lensResults.find((result) => result.error)?.error ?? 'No reviewer submitted findings.'
    throw new ReviewEngineError('reviewers-failed', reason)
  }

  const candidates: Candidate[] = []
  for (const result of lensResults) {
    for (const finding of result.submission?.findings ?? []) {
      candidates.push({ ...finding, id: `C${candidates.length + 1}`, lens: result.lens })
    }
  }
  candidateCount = candidates.length
  const base = {
    candidates: candidates.length,
    lenses,
    failedLenses,
    usage,
  }
  if (candidates.length === 0) {
    verification = 'skipped'
    progress()
    return { ...base, findings: [], verification, unverified: false, runtimeEstimatedCostUsd }
  }

  verification = 'running'
  progress()
  const verified = await run({
    stage: 'verifier',
    task: verifierTask(candidatePayload(candidates), input.context),
    signal: input.signal,
  })
  if (input.signal.aborted) throw new ReviewEngineError('cancelled')

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  if (verified.error || !verified.submission) {
    verification = 'failed'
    progress()
    return {
      ...base,
      findings: numbered(
        candidates.map((candidate) => toFinding(candidate, candidate.lens)),
        input.lenses
      ),
      verification,
      unverified: true,
      runtimeEstimatedCostUsd,
    }
  }

  const kept: Array<Omit<ReviewFinding, 'id'>> = []
  const confirmed = new Set<string>()
  for (const finding of verified.submission.findings) {
    const source = finding.candidateId ? byId.get(finding.candidateId) : undefined
    if (source) {
      if (confirmed.has(source.id)) continue
      confirmed.add(source.id)
    }
    kept.push(toFinding(finding, source?.lens ?? input.lenses[0]))
  }
  verification = 'done'
  progress()
  return {
    ...base,
    findings: numbered(kept, input.lenses),
    verification,
    unverified: false,
    runtimeEstimatedCostUsd,
  }
}
