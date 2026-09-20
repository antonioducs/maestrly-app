/**
 * Pull request facts observed for a task. Nothing here contacts GitHub: the executor performs the reads with
 * its own local credentials and reports what it saw, together with when it saw it.
 */
import { z } from 'zod'
import type { DatabaseClient } from '../../db/pool.js'
import { appendDelegationEvent, delegationFail } from './repository.js'
import type { DelegationTask } from '@maestrly/protocol'

export const pullRequestSnapshotSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().url().max(2000),
    branch: z.string().min(1).max(250),
    baseBranch: z.string().min(1).max(250),
    headSha: z.string().min(7).max(64).nullable().default(null),
    state: z.enum(['open', 'closed', 'merged']),
    ready: z.boolean(),
    reviewDecision: z.string().max(60).nullable().default(null),
    mergeable: z.string().max(60).nullable().default(null),
    checks: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            bucket: z.enum(['pass', 'fail', 'pending', 'skipping', 'cancel']),
            url: z.string().max(2000).nullable().default(null),
            workflow: z.string().max(200).default(''),
          })
          .strict()
      )
      .max(200)
      .default([]),
    mergedAt: z.string().datetime({ offset: true }).nullable().default(null),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict()

export type PullRequestSnapshot = z.infer<typeof pullRequestSnapshotSchema>

export interface PullRequestFacts {
  number: number
  state: string
  ready: boolean
  mergedAt: string | null
  headSha: string | null
  reviewDecision: string | null
  checks: PullRequestSnapshot['checks']
  observedAt: string
  url: string
}

export async function pullRequestFacts(client: DatabaseClient, taskId: string): Promise<PullRequestFacts | null> {
  const rows = await client.query<{
    number: string
    url: string
    state: string
    ready: boolean
    merged_at: Date | null
    head_sha: string | null
    review_decision: string | null
    checks: PullRequestSnapshot['checks']
    observed_at: Date
  }>(
    `select number, url, state, ready, merged_at, head_sha, review_decision, checks, observed_at
     from delegation_pull_requests where task_id=$1 order by updated_at desc limit 1`,
    [taskId]
  )
  const row = rows.rows[0]
  if (!row) return null
  return {
    number: Number(row.number),
    url: row.url,
    state: row.state,
    ready: row.ready,
    mergedAt: row.merged_at ? row.merged_at.toISOString() : null,
    headSha: row.head_sha,
    reviewDecision: row.review_decision,
    checks: row.checks,
    observedAt: row.observed_at.toISOString(),
  }
}

/** Record what the executor observed. The snapshot always carries its observation time; no cache is implied. */
export async function recordPullRequestSnapshot(
  client: DatabaseClient,
  input: { task: DelegationTask; snapshot: unknown }
): Promise<PullRequestSnapshot> {
  const snapshot = pullRequestSnapshotSchema.parse(input.snapshot)
  if (snapshot.state === 'merged' && !snapshot.mergedAt)
    delegationFail('A merged pull request must report when it was merged.', 400)
  await client.query(
    `insert into delegation_pull_requests(
       organization_id, project_id, task_id, repository_binding_id, number, url, branch, base_branch, head_sha,
       state, ready, review_decision, mergeable, checks, merged_at, observed_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     on conflict (task_id, number) do update set
       url=excluded.url, branch=excluded.branch, base_branch=excluded.base_branch, head_sha=excluded.head_sha,
       state=excluded.state, ready=excluded.ready, review_decision=excluded.review_decision,
       mergeable=excluded.mergeable, checks=excluded.checks, merged_at=excluded.merged_at,
       observed_at=excluded.observed_at, updated_at=now()`,
    [
      input.task.organizationId,
      input.task.projectId,
      input.task.id,
      input.task.repositoryBindingId,
      snapshot.number,
      snapshot.url,
      snapshot.branch,
      snapshot.baseBranch,
      snapshot.headSha,
      snapshot.state,
      snapshot.ready,
      snapshot.reviewDecision,
      snapshot.mergeable,
      JSON.stringify(snapshot.checks),
      snapshot.mergedAt,
      snapshot.observedAt,
    ]
  )
  await appendDelegationEvent(client, input.task, 'pull_request.observed', {
    number: snapshot.number,
    state: snapshot.state,
    ready: snapshot.ready,
    headSha: snapshot.headSha,
    failingChecks: snapshot.checks.filter((check) => check.bucket === 'fail').map((check) => check.name),
    observedAt: snapshot.observedAt,
  })
  return snapshot
}
