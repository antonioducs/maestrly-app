import path from 'node:path'
import type {
  ReviewEvidenceKind,
  ReviewerToolRuntime,
  StructuredReviewDecision,
  StructuredReviewFinding,
  SubmitReviewResult,
} from '../tools/util'
import { createReviewEvidenceRecorder } from './evidence'

const MAX_FINDINGS = 50
const MAX_TOTAL_CHARS = 80_000

export interface ReviewRoundEvidenceSnapshot {
  diff: number
  search: number
  read: number
  contextSearch: number
  contextRead: number
}

export interface ReviewerRoundRecorder extends ReviewerToolRuntime {
  decision(): StructuredReviewDecision | null
  evidence(): ReviewRoundEvidenceSnapshot
}

function safePath(value: string): boolean {
  if (!value || value.length > 300 || path.isAbsolute(value)) return false
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('./') && !normalized.startsWith('../')
}

function validateFinding(raw: StructuredReviewFinding): string | null {
  if (!raw || typeof raw !== 'object') return 'Each finding must be an object.'
  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 128) return 'Each finding requires a valid id.'
  if (raw.severity !== 'blocking' && raw.severity !== 'important' && raw.severity !== 'optional') {
    return 'Each finding requires a valid severity.'
  }
  if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 200) {
    return 'Each finding requires a valid title.'
  }
  if (typeof raw.details !== 'string' || !raw.details.trim() || raw.details.length > 4_000) {
    return 'Each finding requires valid details.'
  }
  if (raw.paths !== undefined && (!Array.isArray(raw.paths) || raw.paths.length > 20 || raw.paths.some((p) => !safePath(p)))) {
    return 'Finding paths must be safe relative paths.'
  }
  return null
}

export function validateStructuredReviewDecision(raw: unknown):
  | { ok: true; decision: StructuredReviewDecision }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Review decision must be an object.' }
  const input = raw as Partial<StructuredReviewDecision>
  if (input.result !== 'clean' && input.result !== 'findings') {
    return { ok: false, error: 'result must be clean or findings.' }
  }
  if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 8_000) {
    return { ok: false, error: 'summary must contain 1-8000 characters.' }
  }
  const findings = input.findings ?? []
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) {
    return { ok: false, error: `At most ${MAX_FINDINGS} findings are accepted.` }
  }
  if (input.result === 'findings' && findings.length === 0) {
    return { ok: false, error: 'findings requires a non-empty findings array.' }
  }
  if (
    input.result === 'clean' &&
    findings.some((finding) => finding.severity === 'blocking' || finding.severity === 'important')
  ) {
    return { ok: false, error: 'clean cannot include blocking or important findings.' }
  }
  let total = input.summary.length
  const normalized: StructuredReviewFinding[] = []
  for (const finding of findings) {
    const error = validateFinding(finding)
    if (error) return { ok: false, error }
    const next: StructuredReviewFinding = {
      id: finding.id.trim(),
      severity: finding.severity,
      title: finding.title.trim(),
      details: finding.details.trim(),
      ...(finding.paths?.length ? { paths: [...finding.paths] } : {}),
    }
    total += next.id.length + next.title.length + next.details.length + (next.paths?.join('').length ?? 0)
    if (total > MAX_TOTAL_CHARS) return { ok: false, error: 'Review decision is too large.' }
    normalized.push(next)
  }
  return {
    ok: true,
    decision: {
      result: input.result,
      summary: input.summary.trim(),
      ...(normalized.length ? { findings: normalized } : {}),
    },
  }
}

function fingerprint(value: StructuredReviewDecision): string {
  return JSON.stringify(value)
}

/** Fresh, single-use evidence/decision recorder. Create a new instance for every reviewer round. */
export function createReviewerRoundRecorder(input: {
  searchExecutionContext: ReviewerToolRuntime['searchExecutionContext']
  readExecutionContext: ReviewerToolRuntime['readExecutionContext']
  onAccepted?: (decision: StructuredReviewDecision) => void
  owner?: { loopId: string; iteration: number; participantRole: 'reviewer' }
}): ReviewerRoundRecorder {
  const evidenceRecorder = createReviewEvidenceRecorder(
    input.owner ?? { loopId: 'unscoped', iteration: 1, participantRole: 'reviewer' }
  )
  let accepted: StructuredReviewDecision | null = null
  let acceptedFingerprint = ''

  const recordEvidence = (kind: ReviewEvidenceKind): void => {
    evidenceRecorder.record(kind)
  }

  const submitReview = (raw: StructuredReviewDecision): SubmitReviewResult => {
    const validated = validateStructuredReviewDecision(raw)
    if (!validated.ok) return validated
    const nextFingerprint = fingerprint(validated.decision)
    if (accepted) {
      return nextFingerprint === acceptedFingerprint
        ? { ok: true, idempotent: true }
        : { ok: false, error: 'review-decision-conflict' }
    }
    if (!evidenceRecorder.hasFreshInvestigation()) {
      return { ok: false, error: 'insufficient-investigation' }
    }
    accepted = validated.decision
    acceptedFingerprint = nextFingerprint
    input.onAccepted?.(validated.decision)
    return { ok: true }
  }

  return {
    recordEvidence,
    submitReview,
    searchExecutionContext: input.searchExecutionContext,
    readExecutionContext: input.readExecutionContext,
    decision: () => accepted,
    evidence: () => {
      const current = evidenceRecorder.snapshot()
      return {
        diff: current.diff,
        search: current.search,
        read: current.read,
        contextSearch: current.contextSearch,
        contextRead: current.contextRead,
      }
    },
  }
}
