/**
 * Review findings. A finding keeps its identity across fix and re-review, and records the revision it was
 * raised against plus the revision that resolved it, so progress is measurable and evidence cannot drift.
 */
import {
  reviewFindingSchema,
  reviewResultSchema,
  type CodeRevision,
  type DelegationTask,
  type ReviewFinding,
  type ReviewResult,
} from '@maestrly/protocol'
import type { DatabaseClient } from '../../db/pool.js'
import { appendDelegationEvent, delegationFail } from './repository.js'

export interface StoredReview {
  id: string
  stageId: string
  attemptId: string
  verdict: ReviewResult['verdict']
  codeRevisionDigest: string
  criteriaCoverage: ReviewResult['criteriaCoverage']
  notes: string
  createdAt: string
}

function mapFinding(row: Record<string, unknown>): ReviewFinding {
  return reviewFindingSchema.parse({
    id: row.finding_id,
    severity: row.severity,
    title: row.title,
    details: row.details,
    paths: row.paths,
    recommendation: row.recommendation,
    state: row.state,
  })
}

export async function listFindings(client: DatabaseClient, taskId: string): Promise<ReviewFinding[]> {
  const rows = await client.query('select * from delegation_findings where task_id=$1 order by severity, finding_id', [
    taskId,
  ])
  return rows.rows.map(mapFinding)
}

export async function openFindings(client: DatabaseClient, taskId: string): Promise<ReviewFinding[]> {
  const rows = await client.query(
    "select * from delegation_findings where task_id=$1 and state in ('open','reopened') order by severity, finding_id",
    [taskId]
  )
  return rows.rows.map(mapFinding)
}

export async function latestReview(client: DatabaseClient, taskId: string): Promise<StoredReview | null> {
  const rows = await client.query(
    'select * from delegation_reviews where task_id=$1 order by created_at desc, id desc limit 1',
    [taskId]
  )
  const row = rows.rows[0]
  if (!row) return null
  return {
    id: row.id,
    stageId: row.stage_id,
    attemptId: row.attempt_id,
    verdict: row.verdict,
    codeRevisionDigest: row.code_revision_digest,
    criteriaCoverage: row.criteria_coverage,
    notes: row.notes,
    createdAt: (row.created_at as Date).toISOString(),
  }
}

/**
 * Persist one review verdict. The verdict must name the revision it read; a mismatch is refused so an
 * approval can never be attributed to code the reviewer did not see.
 */
export async function recordReviewResult(
  client: DatabaseClient,
  input: {
    task: DelegationTask
    stageId: string
    attemptId: string
    reviewedRevision: CodeRevision
    result: unknown
  }
): Promise<ReviewResult> {
  const result = reviewResultSchema.parse(input.result)
  if (result.codeRevisionDigest !== input.reviewedRevision.contentDigest)
    delegationFail(
      'The review verdict does not match the revision that was reviewed. It cannot be recorded.',
      409,
      'EVIDENCE_STALE'
    )
  if (result.verdict === 'approved' && result.criteriaCoverage.some((item) => !item.satisfied))
    delegationFail('A review cannot approve while an acceptance criterion is unresolved.', 409)
  if (result.verdict === 'approved' && result.findings.some((finding) => finding.severity !== 'optional'))
    delegationFail('A review cannot approve while a blocking or important finding is open.', 409)

  await client.query(
    `insert into delegation_reviews(organization_id, project_id, task_id, stage_id, attempt_id, verdict, code_revision_digest, criteria_coverage, notes)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (attempt_id) do update set verdict=excluded.verdict, code_revision_digest=excluded.code_revision_digest,
       criteria_coverage=excluded.criteria_coverage, notes=excluded.notes`,
    [
      input.task.organizationId,
      input.task.projectId,
      input.task.id,
      input.stageId,
      input.attemptId,
      result.verdict,
      result.codeRevisionDigest,
      JSON.stringify(result.criteriaCoverage),
      result.notes,
    ]
  )

  const reported = new Set(result.findings.map((finding) => finding.id))
  for (const finding of result.findings) {
    // A finding already known is reopened rather than duplicated, preserving its history.
    await client.query(
      `insert into delegation_findings(
         organization_id, project_id, task_id, finding_id, severity, title, details, paths, recommendation, state,
         raised_revision, raised_stage_id
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (task_id, finding_id) do update set
         severity=excluded.severity, title=excluded.title, details=excluded.details, paths=excluded.paths,
         recommendation=excluded.recommendation,
         state = case when delegation_findings.state in ('fixed','accepted') then 'reopened' else delegation_findings.state end,
         resolved_revision = null,
         updated_at = now()`,
      [
        input.task.organizationId,
        input.task.projectId,
        input.task.id,
        finding.id,
        finding.severity,
        finding.title,
        finding.details,
        JSON.stringify(finding.paths),
        finding.recommendation,
        finding.state === 'open' || finding.state === 'reopened' ? finding.state : 'open',
        result.codeRevisionDigest,
        input.stageId,
      ]
    )
  }
  // Findings the reviewer no longer reports on this revision are resolved against it.
  const previous = await openFindings(client, input.task.id)
  for (const finding of previous) {
    if (reported.has(finding.id)) continue
    await client.query(
      "update delegation_findings set state='fixed', resolved_revision=$3, updated_at=now() where task_id=$1 and finding_id=$2",
      [input.task.id, finding.id, result.codeRevisionDigest]
    )
  }
  await appendDelegationEvent(client, input.task, 'review.recorded', {
    stageId: input.stageId,
    attemptId: input.attemptId,
    verdict: result.verdict,
    codeRevisionDigest: result.codeRevisionDigest,
    findings: result.findings.length,
    blocking: result.findings.filter((finding) => finding.severity === 'blocking').length,
  })
  return result
}

/** Signature of the open findings, used to detect a fix round that changed nothing. */
export function findingsSignature(findings: ReviewFinding[]): string {
  return findings
    .map((finding) => `${finding.id}:${finding.severity}`)
    .sort()
    .join('|')
}
