/**
 * Completion and review-loop policy.
 *
 * Finishing a turn is not finishing a task. The configured target must be satisfied by the current code
 * revision: required stages succeeded, required checks valid for that revision, the required review approved
 * for that revision, and acceptance criteria resolved.
 */
import {
  completionDecisionSchema,
  type CompletionDecision,
  type DelegationTask,
  type ReviewFinding,
  type StageAttempt,
  type StageDefinition,
} from '@maestrly/protocol'
import type { DatabaseClient } from '../../db/pool.js'
import { appendDelegationEvent, mapStage } from './repository.js'
import { findingsSignature, latestReview, openFindings, type StoredReview } from './findings.js'

export interface CompletionInput {
  task: DelegationTask
  stages: StageDefinition[]
  attempts: StageAttempt[]
  findings: ReviewFinding[]
  review: StoredReview | null
  /** Digest of the current code revision, from the newest attempt that captured one. */
  currentRevisionDigest: string | null
  /** Delivery facts, supplied by the delivery module. */
  pullRequest?: { number: number; state: string; ready: boolean; mergedAt: string | null } | null
}

const terminalStageStates = ['succeeded', 'superseded', 'cancelled']

/** Digest of the newest attempt that captured a revision; null when nothing has been captured yet. */
export function currentRevisionDigest(attempts: StageAttempt[]): string | null {
  const captured = attempts
    .filter((attempt) => attempt.codeRevision)
    .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
  return captured[0]?.codeRevision?.contentDigest ?? null
}

export function evaluateCompletion(input: CompletionInput): CompletionDecision {
  const missing: CompletionDecision['missing'] = []
  for (const stage of input.stages)
    if (stage.requiredForCompletion && !terminalStageStates.includes(stage.state))
      missing.push({ reason: 'stage_incomplete', detail: `${stage.title} is ${stage.state}.` })

  const blocking = input.findings.filter(
    (finding) => ['open', 'reopened'].includes(finding.state) && finding.severity !== 'optional'
  )
  if (blocking.length)
    missing.push({
      reason: 'review_findings_open',
      detail: `${blocking.length} review finding(s) remain open.`,
    })

  if (input.task.policy.requireReview) {
    if (!input.review) missing.push({ reason: 'review_missing', detail: 'No review has been recorded.' })
    else if (input.review.verdict !== 'approved')
      missing.push({ reason: 'review_missing', detail: `The latest review verdict is ${input.review.verdict}.` })
    else if (input.currentRevisionDigest && input.review.codeRevisionDigest !== input.currentRevisionDigest)
      // An approval never carries over to code the reviewer did not read.
      missing.push({
        reason: 'evidence_stale',
        detail: 'The code changed after the approving review. Review the current revision again.',
      })
  }

  const unresolved = (input.review?.criteriaCoverage ?? []).filter((item) => !item.satisfied)
  if (unresolved.length)
    missing.push({
      reason: 'criteria_unresolved',
      detail: `${unresolved.length} acceptance criterion(s) are not satisfied.`,
    })
  if (input.task.acceptanceCriteria.length && input.task.policy.requireReview && !input.review)
    missing.push({ reason: 'criteria_unresolved', detail: 'Acceptance criteria were never evaluated.' })

  if (input.task.policy.completionTarget !== 'patch_ready') {
    const pullRequest = input.pullRequest ?? null
    if (!pullRequest) missing.push({ reason: 'pull_request_missing', detail: 'No pull request is linked yet.' })
    else if (!pullRequest.ready)
      missing.push({ reason: 'pull_request_not_ready', detail: 'The pull request is still a draft or blocked.' })
    if (input.task.policy.completionTarget === 'merged' && !pullRequest?.mergedAt)
      missing.push({ reason: 'merge_missing', detail: 'The pull request is not merged.' })
  }

  return completionDecisionSchema.parse({
    satisfied: missing.length === 0,
    target: input.task.policy.completionTarget,
    missing,
  })
}

export interface FixPlan {
  /** Stage to create, or null when no fix round is allowed or needed. */
  create: { title: string; instructions: string; settings: StageDefinition['settings'] } | null
  reason: 'no_findings' | 'limit_reached' | 'no_progress' | 'ready'
}

/**
 * Decide the next fix round from the open findings. A round that produced the same findings as the previous
 * one is not retried; the task stops and reports what remains.
 */
export function planFixRound(input: {
  task: DelegationTask
  stages: StageDefinition[]
  findings: ReviewFinding[]
  previousSignature: string | null
}): FixPlan {
  const actionable = input.findings.filter(
    (finding) => ['open', 'reopened'].includes(finding.state) && finding.severity !== 'optional'
  )
  if (!actionable.length) return { create: null, reason: 'no_findings' }
  const rounds = input.stages.filter((stage) => stage.type === 'fix').length
  if (rounds >= input.task.policy.limits.maxFixAttempts) return { create: null, reason: 'limit_reached' }
  const signature = findingsSignature(actionable)
  if (input.previousSignature && input.previousSignature === signature)
    return { create: null, reason: 'no_progress' }
  const implementation = [...input.stages]
    .reverse()
    .find((stage) => ['implement', 'fix'].includes(stage.type) && stage.settings)
  return {
    create: {
      title: `Resolve review findings (round ${rounds + 1})`,
      instructions: [
        'Resolve the review findings below and verify the correction. Do not widen the change beyond them.',
        '',
        ...actionable.map(
          (finding) =>
            `- [${finding.severity}] ${finding.id} — ${finding.title}\n  ${finding.details}${
              finding.recommendation ? `\n  Recommendation: ${finding.recommendation}` : ''
            }${finding.paths.length ? `\n  Files: ${finding.paths.join(', ')}` : ''}`
        ),
      ].join('\n'),
      settings: implementation?.settings ?? null,
    },
    reason: 'ready',
  }
}

/** Load everything the completion decision needs for one task. */
export async function qualityContext(
  client: DatabaseClient,
  task: DelegationTask,
  stages: StageDefinition[],
  attempts: StageAttempt[]
) {
  return {
    findings: await openFindings(client, task.id),
    review: await latestReview(client, task.id),
    currentRevisionDigest: currentRevisionDigest(attempts),
    stages,
    attempts,
    task,
  }
}

/** Append the fix stage produced by a review round, reusing the implementation profile by default. */
export async function appendFixStage(
  client: DatabaseClient,
  task: DelegationTask,
  plan: NonNullable<FixPlan['create']>
): Promise<StageDefinition> {
  const position = Number(
    (
      await client.query<{ position: string }>(
        'select coalesce(max(position)+1,0)::text as position from delegation_stages where task_id=$1',
        [task.id]
      )
    ).rows[0]!.position
  )
  const inserted = await client.query(
    `insert into delegation_stages(
       organization_id, project_id, task_id, type, title, instructions, position, depends_on, settings, action,
       required_for_completion, settings_revision
     ) values ($1,$2,$3,'fix',$4,$5,$6,'[]'::jsonb,$7,null,true,$8) returning *`,
    [
      task.organizationId,
      task.projectId,
      task.id,
      plan.title,
      plan.instructions,
      position,
      plan.settings,
      task.settingsRevision,
    ]
  )
  const stage = mapStage(inserted.rows[0]!)
  await appendDelegationEvent(client, task, 'review.fix_planned', { stageId: stage.id, title: stage.title })
  return stage
}
