import { randomUUID } from 'node:crypto'
import type {
  LocalConversationConfirmResult,
  LocalConversationPrepareInput,
  LocalConversationPrepareResult,
  LocalConversationRecord,
} from '../../shared/local-conversation'
import { inspectCwdActivity, tryWithCwdExclusive } from '../cwd-activity-coordinator'
import { getWorkspace, insertConversation, type Conversation } from '../store'
import {
  dropOperationStash,
  executePreparedLocalGit,
  isAttachTargetCurrentBranch,
  isLocalConversationAttachOnly,
  prepareLocalGitOperation,
  type LocalGitExecutionResult,
  type PreparedLocalGitOperation,
} from './git'

const TOKEN_TTL_MS = 5 * 60_000

interface PendingOperation {
  token: string
  expiresAt: number
  input: LocalConversationPrepareInput
  git: PreparedLocalGitOperation
}

const pending = new Map<string, PendingOperation>()

function pruneExpired(now = Date.now()): void {
  for (const [token, value] of pending) if (value.expiresAt <= now) pending.delete(token)
}

function blockersResult(git: PreparedLocalGitOperation): LocalConversationPrepareResult {
  return { status: 'blocked', preview: git.preview, blockers: git.blockers }
}

async function prepare(
  input: LocalConversationPrepareInput
): Promise<{ result: LocalConversationPrepareResult; operation?: PendingOperation }> {
  const workspace = getWorkspace(input.workspaceId)
  if (!workspace) return { result: { status: 'invalid', message: 'Workspace not found.' } }
  const git = await prepareLocalGitOperation(workspace.path, input.intent, inspectCwdActivity(workspace.path))
  if (git.blockers.length > 0) return { result: blockersResult(git) }
  const token = randomUUID()
  const operation: PendingOperation = {
    token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
    input,
    git,
  }
  return {
    operation,
    result: {
      status: 'ready',
      token,
      preview: git.preview,
      requiresConfirmation: git.preview.requiresConfirmation,
    },
  }
}

export async function prepareLocalConversation(
  input: LocalConversationPrepareInput
): Promise<LocalConversationPrepareResult> {
  pruneExpired()
  const prepared = await prepare(input)
  if (prepared.operation) pending.set(prepared.operation.token, prepared.operation)
  return prepared.result
}

function makeConversation(operation: PendingOperation): Conversation & LocalConversationRecord {
  const now = Date.now()
  return {
    id: randomUUID(),
    workspaceId: operation.input.workspaceId,
    name: operation.input.name || operation.git.target.branch,
    branch: operation.git.target.branch,
    mode: 'local',
    experience: operation.input.experience ?? 'standard',
    cwd: operation.git.cwd,
    status: 'idle',
    createdAt: now,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: now,
    isMulti: 0,
  }
}

export async function confirmLocalConversation(token: string): Promise<LocalConversationConfirmResult> {
  const now = Date.now()
  const operation = pending.get(token)
  pending.delete(token) // token is single-use, including on error
  if (!operation) return { status: 'invalid-token', message: 'Invalid preview. Prepare the operation again.' }
  if (operation.expiresAt <= now) {
    pruneExpired(now)
    return { status: 'expired-token', message: 'The preview expired. Prepare the operation again.' }
  }

  const attachOnly = isLocalConversationAttachOnly(operation.git)
  // Reprepare with a fresh token and stale result when fingerprints, execution state, or attach branch
  // changed since preview.
  const refreshAsStale = async () => {
    const refreshed = await prepare(operation.input)
    if (refreshed.operation) pending.set(refreshed.operation.token, refreshed.operation)
    if (refreshed.result.status === 'ready') {
      return {
        status: 'stale',
        token: refreshed.result.token,
        preview: refreshed.result.preview,
        message: 'Repository state changed since the preview. Review and confirm again.',
      } as const
    }
    if (refreshed.result.status === 'blocked') return refreshed.result
    return { status: 'invalid-token', message: refreshed.result.message } as const
  }
  const exclusive = await tryWithCwdExclusive(
    operation.git.cwd,
    async () => {
      if (attachOnly) {
        // A five-minute preview token can outlive a branch switch. Reprepare rather than label the
        // conversation with an outdated branch; the operation may now require mutation.
        if (!(await isAttachTargetCurrentBranch(operation.git))) return refreshAsStale()
      } else {
        const current = await prepareLocalGitOperation(operation.git.cwd, operation.input.intent, [])
        if (current.blockers.length > 0) {
          return { status: 'blocked', preview: current.preview, blockers: current.blockers } as const
        }
        if (current.fingerprint !== operation.git.fingerprint) return refreshAsStale()
      }

      const applied: LocalGitExecutionResult = attachOnly
        ? { status: 'applied' }
        : await executePreparedLocalGit(operation.git)
      if (applied.status === 'stale') return refreshAsStale()
      if (applied.status === 'blocked') {
        return { status: 'blocked', preview: applied.current.preview, blockers: applied.current.blockers } as const
      }
      if (applied.status === 'recovery-required') {
        return {
          status: 'recovery-required',
          preview: operation.git.preview,
          recovery: applied.recovery,
        } as const
      }

      const conversation = makeConversation(operation)
      try {
        insertConversation(conversation)
      } catch (error) {
        const recovery = {
          stashOid: applied.stashOid,
          marker: applied.marker,
          currentBranch: operation.git.target.branch,
          headOid: operation.git.target.oid,
          status: operation.git.preview.changes.staged.concat(
            operation.git.preview.changes.unstaged,
            operation.git.preview.changes.untracked
          ),
          commands: ['git status', ...(applied.stashOid ? [`git stash show --stat ${applied.stashOid}`] : [])],
          message: `The branch was prepared, but the conversation could not be persisted. ${error instanceof Error ? error.message : String(error)}`,
        }
        return { status: 'recovery-required', preview: operation.git.preview, recovery } as const
      }

      let warning: string | undefined
      if (applied.stashOid && applied.marker) {
        try {
          if (!(await dropOperationStash(operation.git.cwd, applied.stashOid, applied.marker))) {
            warning = `The conversation was created, but stash ${applied.stashOid} was preserved because its entry could not be confirmed.`
          }
        } catch (error) {
          warning = `The conversation was created, but stash ${applied.stashOid} could not be removed: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      return {
        status: 'created',
        conversation,
        ...(warning ? { warning, stashOid: applied.stashOid } : {}),
      } as const
    },
    { allowActivity: attachOnly }
  )

  if (!exclusive.ok) {
    const current = await prepareLocalGitOperation(operation.git.cwd, operation.input.intent, exclusive.activity)
    const blockers =
      current.blockers.length > 0
        ? current.blockers
        : [
            {
              code: 'activity' as const,
              message: 'Another Git transition is in progress in this directory.',
            },
          ]
    return {
      status: 'blocked',
      preview: { ...current.preview, blockers },
      blockers,
    }
  }
  return exclusive.value
}

export function __resetLocalConversationTokensForTests(): void {
  pending.clear()
}
