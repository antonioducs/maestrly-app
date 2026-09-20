/**
 * Named project checks and their results.
 *
 * A model chooses a check by id; the host resolves the command. A result always records the command that ran,
 * the exit code and the revision it tested, so "the tests pass" is never taken on a model's word.
 */
import {
  checkResultSchema,
  delegationCheckConfigSchema,
  type CheckResult,
  type DelegationCheckConfig,
  type DelegationTask,
} from '@maestrly/protocol'
import { z } from 'zod'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { appendDelegationEvent, delegationFail } from './repository.js'
import type { DelegationScope } from './service.js'

export const checkConfigPatchSchema = delegationCheckConfigSchema.extend({
  expectedVersion: z.number().int().nonnegative().optional(),
})

function mapConfig(row: Record<string, unknown>): DelegationCheckConfig {
  return delegationCheckConfigSchema.parse({
    id: row.check_id,
    label: row.label,
    description: row.description,
    command: row.command,
    args: row.args,
    workingDirectory: row.working_directory,
    timeoutSeconds: Number(row.timeout_seconds),
    required: row.required,
    mutatesWorkspace: row.mutates_workspace,
    environmentAllowlist: row.environment_allowlist,
    setup: row.setup,
    enabled: row.enabled,
  })
}

export async function listCheckConfigs(
  pool: DatabasePool,
  scope: { organizationId: string; projectId: string; userId: string }
): Promise<DelegationCheckConfig[]> {
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, projectId: scope.projectId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'project:read')
      const rows = await client.query(
        'select * from delegation_check_configs where organization_id=$1 and project_id=$2 order by check_id',
        [scope.organizationId, scope.projectId]
      )
      return rows.rows.map(mapConfig)
    }
  )
}

/** Check results recorded for one task, newest revision first. Read-only view for the API and connectors. */
export async function listCheckResults(
  pool: DatabasePool,
  scope: { organizationId: string; projectId: string; userId: string },
  taskId: string,
  codeRevisionDigest?: string
): Promise<CheckResult[]> {
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, projectId: scope.projectId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'project:read')
      return checkResultsFor(client, taskId, codeRevisionDigest)
    }
  )
}

/** Creating or changing a check is an automation management action, not something an execution can do. */
export async function saveCheckConfig(
  pool: DatabasePool,
  scope: { organizationId: string; projectId: string; userId: string },
  raw: z.infer<typeof checkConfigPatchSchema>
): Promise<DelegationCheckConfig> {
  const input = checkConfigPatchSchema.parse(raw)
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, projectId: scope.projectId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'automation:manage')
      if (input.workingDirectory) {
        if (/^(?:[a-zA-Z]:)?[\\/]/.test(input.workingDirectory) || input.workingDirectory.split(/[\\/]/).includes('..'))
          delegationFail('The check working directory must stay inside the workspace.', 400)
      }
      const current = await client.query<{ version: string }>(
        'select version from delegation_check_configs where organization_id=$1 and project_id=$2 and check_id=$3 for update',
        [scope.organizationId, scope.projectId, input.id]
      )
      if (input.expectedVersion !== undefined && Number(current.rows[0]?.version ?? 0) !== input.expectedVersion)
        delegationFail('The check changed after it was loaded.', 409)
      const rows = await client.query(
        `insert into delegation_check_configs(
           organization_id, project_id, check_id, label, description, command, args, working_directory,
           timeout_seconds, required, mutates_workspace, environment_allowlist, setup, enabled
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (organization_id, project_id, check_id) do update set
           label=excluded.label, description=excluded.description, command=excluded.command, args=excluded.args,
           working_directory=excluded.working_directory, timeout_seconds=excluded.timeout_seconds,
           required=excluded.required, mutates_workspace=excluded.mutates_workspace,
           environment_allowlist=excluded.environment_allowlist, setup=excluded.setup, enabled=excluded.enabled,
           version=delegation_check_configs.version+1, updated_at=now()
         returning *`,
        [
          scope.organizationId,
          scope.projectId,
          input.id,
          input.label,
          input.description,
          input.command,
          JSON.stringify(input.args),
          input.workingDirectory,
          input.timeoutSeconds,
          input.required,
          input.mutatesWorkspace,
          JSON.stringify(input.environmentAllowlist),
          JSON.stringify(input.setup),
          input.enabled,
        ]
      )
      return mapConfig(rows.rows[0]!)
    }
  )
}

/** Checks an executor may run for this project, resolved inside an existing transaction. */
export async function enabledCheckConfigs(
  client: DatabaseClient,
  input: { organizationId: string; projectId: string }
): Promise<DelegationCheckConfig[]> {
  const rows = await client.query(
    'select * from delegation_check_configs where organization_id=$1 and project_id=$2 and enabled order by check_id',
    [input.organizationId, input.projectId]
  )
  return rows.rows.map(mapConfig)
}

function mapResult(row: Record<string, unknown>): CheckResult {
  return checkResultSchema.parse({
    checkId: row.check_id,
    resolvedCommand: row.resolved_command,
    passed: row.passed,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    durationMs: Number(row.duration_ms),
    timedOut: row.timed_out,
    truncated: row.truncated,
    codeRevisionDigest: row.code_revision_digest,
    logArtifactId: row.log_artifact_id ?? null,
    setupIssue: row.setup_issue ?? null,
  })
}

/** Record one check result. A rerun against the same revision replaces the previous record for that revision. */
export async function recordCheckResult(
  client: DatabaseClient,
  input: { task: DelegationTask; attemptId: string | null; result: unknown }
): Promise<CheckResult> {
  const result = checkResultSchema.parse(input.result)
  if (result.passed && result.setupIssue)
    delegationFail('A check cannot pass while reporting an incomplete setup.', 409)
  if (result.passed && result.timedOut) delegationFail('A check that timed out cannot be recorded as passing.', 409)
  await client.query(
    `insert into delegation_check_results(
       organization_id, project_id, task_id, attempt_id, check_id, resolved_command, passed, exit_code, duration_ms,
       timed_out, truncated, code_revision_digest, log_artifact_id, setup_issue
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (task_id, check_id, code_revision_digest) do update set
       attempt_id=excluded.attempt_id, resolved_command=excluded.resolved_command, passed=excluded.passed,
       exit_code=excluded.exit_code, duration_ms=excluded.duration_ms, timed_out=excluded.timed_out,
       truncated=excluded.truncated, log_artifact_id=excluded.log_artifact_id, setup_issue=excluded.setup_issue,
       created_at=now()`,
    [
      input.task.organizationId,
      input.task.projectId,
      input.task.id,
      input.attemptId,
      result.checkId,
      result.resolvedCommand,
      result.passed,
      result.exitCode,
      result.durationMs,
      result.timedOut,
      result.truncated,
      result.codeRevisionDigest,
      result.logArtifactId,
      result.setupIssue,
    ]
  )
  await appendDelegationEvent(client, input.task, 'check.recorded', {
    checkId: result.checkId,
    passed: result.passed,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    truncated: result.truncated,
    codeRevisionDigest: result.codeRevisionDigest,
    setupIssue: result.setupIssue,
  })
  return result
}

export async function checkResultsFor(
  client: DatabaseClient,
  taskId: string,
  codeRevisionDigest?: string
): Promise<CheckResult[]> {
  const rows = await client.query(
    `select * from delegation_check_results where task_id=$1 and ($2::text is null or code_revision_digest=$2)
     order by check_id`,
    [taskId, codeRevisionDigest ?? null]
  )
  return rows.rows.map(mapResult)
}

/**
 * Required checks that are missing or failing for the current revision. A check recorded against an older
 * revision does not count: it did not test this code.
 */
export async function requiredCheckGaps(
  client: DatabaseClient,
  input: { task: DelegationTask; codeRevisionDigest: string | null }
): Promise<Array<{ checkId: string; reason: 'missing' | 'failed' }>> {
  const required = new Set(input.task.policy.requiredCheckIds)
  const configured = await enabledCheckConfigs(client, {
    organizationId: input.task.organizationId,
    projectId: input.task.projectId,
  })
  for (const config of configured) if (config.required) required.add(config.id)
  if (!required.size) return []
  if (!input.codeRevisionDigest)
    return [...required].map((checkId) => ({ checkId, reason: 'missing' as const }))
  const results = await checkResultsFor(client, input.task.id, input.codeRevisionDigest)
  const byId = new Map(results.map((result) => [result.checkId, result]))
  const gaps: Array<{ checkId: string; reason: 'missing' | 'failed' }> = []
  for (const checkId of required) {
    const result = byId.get(checkId)
    if (!result) gaps.push({ checkId, reason: 'missing' })
    else if (!result.passed) gaps.push({ checkId, reason: 'failed' })
  }
  return gaps
}

export type CheckScope = DelegationScope
