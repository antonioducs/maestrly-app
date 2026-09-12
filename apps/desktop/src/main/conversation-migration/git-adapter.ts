import type { CwdActivityItem } from '../../shared/local-conversation'
import {
  continuePreparedWorktreeTransfer,
  dropOperationStash,
  executePreparedWorktreeTransfer,
  findOperationStash,
  prepareWorktreeTransfer,
  rollbackWorktreeTransfer,
  verifyWorktreeTransferDestination,
  verifyWorktreeTransfer,
  verifyWorktreeTransferRolledBack,
  type PreparedWorktreeTransfer,
  type WorktreeTransferExecutionResult,
} from '../local-conversation/git'

export type MigrationGitPlan = PreparedWorktreeTransfer
export type MigrationGitExecution = WorktreeTransferExecutionResult

export interface MigrationGitAdapter {
  prepare(args: {
    cwd: string
    branch: string
    destination: string
    activity?: CwdActivityItem[]
  }): Promise<MigrationGitPlan>
  execute(plan: MigrationGitPlan): Promise<MigrationGitExecution>
  verify(plan: MigrationGitPlan): Promise<boolean>
  verifyDestination(plan: MigrationGitPlan): Promise<boolean>
  finalize(plan: MigrationGitPlan, stashOid?: string, marker?: string): Promise<boolean>
  discardStash(plan: MigrationGitPlan, stashOid?: string, marker?: string): Promise<boolean>
  continue(plan: MigrationGitPlan): Promise<MigrationGitExecution>
  findStash(plan: MigrationGitPlan): Promise<string | null>
  rollback(plan: MigrationGitPlan, stashOid?: string): Promise<boolean>
  isRolledBack(plan: MigrationGitPlan): Promise<boolean>
}

export const migrationGitAdapter: MigrationGitAdapter = {
  prepare: ({ cwd, branch, destination, activity = [] }) =>
    prepareWorktreeTransfer(cwd, branch, destination, activity),
  execute: executePreparedWorktreeTransfer,
  verify: verifyWorktreeTransfer,
  verifyDestination: verifyWorktreeTransferDestination,
  continue: continuePreparedWorktreeTransfer,
  findStash: (plan) => findOperationStash(plan.source.cwd, plan.stashMarker),
  finalize: async (plan, stashOid, marker) => {
    if (!stashOid || !marker) return true
    const current = await findOperationStash(plan.source.cwd, marker)
    if (!current) return true
    if (current !== stashOid) return false
    return dropOperationStash(plan.source.cwd, stashOid, marker)
  },
  discardStash: async (plan, stashOid, marker) => {
    if (!marker) return plan.source.status.raw.length === 0
    const current = await findOperationStash(plan.source.cwd, marker)
    if (!current) return true
    if (stashOid && current !== stashOid) return false
    return dropOperationStash(plan.source.cwd, current, marker)
  },
  rollback: rollbackWorktreeTransfer,
  isRolledBack: verifyWorktreeTransferRolledBack,
}
