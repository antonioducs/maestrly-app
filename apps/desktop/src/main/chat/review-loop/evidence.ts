import path from 'node:path'
import {
  MAX_FINDING_DETAILS_CHARS,
  MAX_FINDING_ID_CHARS,
  MAX_FINDING_PATH_CHARS,
  MAX_FINDING_PATHS,
  MAX_FINDING_TITLE_CHARS,
  MAX_FINDINGS,
  MAX_FINDINGS_TOTAL_CHARS,
  MAX_REMAINING_FINDINGS,
  MAX_REMAINING_TOTAL_CHARS,
  type ReviewFindingInput,
  type ReviewFindingSeverity,
  type ReviewLoopEvidence,
  type ReviewLoopSeverityThreshold,
} from './types'

const SEVERITY_RANK: Record<ReviewFindingSeverity, number> = { optional: 0, important: 1, blocking: 2 }

export type ParticipantEvidenceKind = 'diff' | 'search' | 'read' | 'context-search' | 'context-read'
export type ReviewLoopParticipantRole = 'executor' | 'reviewer'

export interface ParticipantEvidenceSnapshot {
  loopId: string
  iteration: number
  participantRole: ReviewLoopParticipantRole
  diff: number
  search: number
  read: number
  contextSearch: number
  contextRead: number
}

/** A fresh recorder is owned by exactly one loop round and participant role; counters never cross rounds. */
export function createReviewEvidenceRecorder(owner: {
  loopId: string
  iteration: number
  participantRole: ReviewLoopParticipantRole
}) {
  const counts = { diff: 0, search: 0, read: 0, contextSearch: 0, contextRead: 0 }
  const record = (kind: ParticipantEvidenceKind): void => {
    if (kind === 'context-search') counts.contextSearch++
    else if (kind === 'context-read') counts.contextRead++
    else counts[kind]++
  }
  const snapshot = (): ParticipantEvidenceSnapshot => ({ ...owner, ...counts })
  return {
    record,
    snapshot,
    hasFreshInvestigation: () => counts.diff > 0 && counts.search > 0 && counts.read > 0,
  }
}

export type ReviewEvidenceRecorder = ReturnType<typeof createReviewEvidenceRecorder>

/** Relative paths without `..` or absolute paths; findings only report paths, the executor never executes them. */
export function isSafeRelativePath(rel: string): boolean {
  if (!rel || rel.length > MAX_FINDING_PATH_CHARS) return false
  if (path.isAbsolute(rel)) return false
  const normalized = path.posix.normalize(rel.split('\\').join('/'))
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.' || normalized.startsWith('./')) {
    return false
  }
  return true
}

/** Validate the complete findings shape before admitting any execution. */
export function validateFindingsShape(
  findings: unknown
): { ok: true; findings: ReviewFindingInput[] } | { ok: false; error: string } {
  if (!Array.isArray(findings) || findings.length === 0)
    return { ok: false, error: 'findings must be a nonempty array.' }
  if (findings.length > MAX_FINDINGS) return { ok: false, error: `Maximum of ${MAX_FINDINGS} findings per round.` }
  let total = 0
  const out: ReviewFindingInput[] = []
  for (const raw of findings) {
    const f = raw as Partial<ReviewFindingInput> | null
    if (!f || typeof f !== 'object') return { ok: false, error: 'Each finding must be an object.' }
    if (typeof f.id !== 'string' || !f.id.trim() || f.id.length > MAX_FINDING_ID_CHARS) {
      return { ok: false, error: `Each finding requires an id of 1 to ${MAX_FINDING_ID_CHARS} characters.` }
    }
    if (f.severity !== 'blocking' && f.severity !== 'important' && f.severity !== 'optional') {
      return { ok: false, error: 'severity must be "blocking", "important" or "optional".' }
    }
    if (typeof f.title !== 'string' || !f.title.trim() || f.title.length > MAX_FINDING_TITLE_CHARS) {
      return { ok: false, error: `Each finding requires a title of 1 to ${MAX_FINDING_TITLE_CHARS} characters.` }
    }
    if (typeof f.details !== 'string' || !f.details.trim() || f.details.length > MAX_FINDING_DETAILS_CHARS) {
      return { ok: false, error: `Each finding requires details of 1 to ${MAX_FINDING_DETAILS_CHARS} characters.` }
    }
    const paths: string[] = []
    if (f.paths !== undefined) {
      if (!Array.isArray(f.paths) || f.paths.length > MAX_FINDING_PATHS) {
        return { ok: false, error: `paths must contain at most ${MAX_FINDING_PATHS} relative paths.` }
      }
      for (const value of f.paths) {
        if (typeof value !== 'string' || !isSafeRelativePath(value)) {
          return { ok: false, error: 'paths must only contain safe relative paths (no ".." or absolute paths).' }
        }
        paths.push(value)
      }
    }
    const item: ReviewFindingInput = {
      id: f.id.trim(),
      severity: f.severity,
      title: f.title.trim(),
      details: f.details.trim(),
      ...(paths.length ? { paths } : {}),
    }
    total += item.id.length + item.title.length + item.details.length + (item.paths?.join('').length ?? 0)
    if (total > MAX_FINDINGS_TOTAL_CHARS) {
      return { ok: false, error: `Findings too large (limit of ${MAX_FINDINGS_TOTAL_CHARS} characters).` }
    }
    out.push(item)
  }
  return { ok: true, findings: out }
}

export function validateRemainingFindingsShape(
  remaining: unknown
):
  | { ok: true; items: Array<{ severity: ReviewFindingSeverity; title: string; details: string }> }
  | { ok: false; error: string } {
  if (remaining === undefined) return { ok: true, items: [] }
  if (!Array.isArray(remaining) || remaining.length > MAX_REMAINING_FINDINGS) {
    return { ok: false, error: `remaining_findings must contain at most ${MAX_REMAINING_FINDINGS} items.` }
  }
  let total = 0
  const items: Array<{ severity: ReviewFindingSeverity; title: string; details: string }> = []
  for (const raw of remaining) {
    const f = raw as Partial<{ severity: ReviewFindingSeverity; title: string; details: string }> | null
    if (!f || typeof f !== 'object') return { ok: false, error: 'Each remaining finding must be an object.' }
    if (f.severity !== 'blocking' && f.severity !== 'important' && f.severity !== 'optional') {
      return { ok: false, error: 'severity must be "blocking", "important" or "optional".' }
    }
    if (typeof f.title !== 'string' || !f.title.trim() || f.title.length > MAX_FINDING_TITLE_CHARS) {
      return { ok: false, error: 'remaining_findings requires a valid title for each item.' }
    }
    if (typeof f.details !== 'string' || !f.details.trim() || f.details.length > MAX_FINDING_DETAILS_CHARS) {
      return { ok: false, error: 'remaining_findings requires valid details for each item.' }
    }
    const item = { severity: f.severity, title: f.title.trim(), details: f.details.trim() }
    total += item.title.length + item.details.length
    if (total > MAX_REMAINING_TOTAL_CHARS) {
      return {
        ok: false,
        error: `remaining_findings too large (limit of ${MAX_REMAINING_TOTAL_CHARS} characters).`,
      }
    }
    items.push(item)
  }
  return { ok: true, items }
}

export function hasFindingAtOrAboveThreshold(
  findings: ReviewFindingInput[],
  threshold: ReviewLoopSeverityThreshold
): boolean {
  const thresholdRank = threshold === 'blocking' ? 2 : 1
  return findings.some((finding) => SEVERITY_RANK[finding.severity] >= thresholdRank)
}

/** Returns the existing stable controller error code when an iteration lacks required fresh evidence. */
export function reviewEvidenceError(input: {
  evidence: ReviewLoopEvidence
  iteration: number
  reviewScope: 'code' | 'frontend'
  requireContextLoaded: boolean
}): string | null {
  const checkpoint = input.evidence.byIteration[input.iteration]
  if (
    (input.requireContextLoaded && !input.evidence.contextLoaded) ||
    !checkpoint ||
    checkpoint.diff < 1 ||
    checkpoint.search < 1 ||
    checkpoint.read < 1
  ) {
    return 'insufficient-investigation'
  }
  if (input.reviewScope === 'frontend' && (checkpoint.browserSnapshot ?? 0) < 1) {
    return 'insufficient-browser-snapshot'
  }
  if (input.reviewScope === 'frontend' && (checkpoint.browserScreenshot ?? 0) < 1) {
    return 'insufficient-browser-screenshot'
  }
  return null
}
