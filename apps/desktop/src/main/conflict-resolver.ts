import { randomUUID } from 'node:crypto'
import { getConversation, getConvUiPrefs } from './store'
import { getReviewData } from './gh-service'
import { executeSubagent, type SubagentExecutionResult } from './chat/subagent-executor'
import { BUILTIN_AGENTS } from './chat/agents'
import { resolveParentSubagentExecutionProfile } from './chat/subagent-execution-profile'
import { getChatQuestionBroker } from './chat/service'
import { PermissionBroker, YOLO_RULESET } from './chat/permission'
import { tryWithCwdExclusive } from './cwd-activity-coordinator'
import {
  isWorkingTreeClean,
  isMergeInProgress,
  hasUnmergedFiles,
  hasConflictMarkers,
  isBranchPushed,
} from './git-service'

/**
 * Resolve PR merge conflicts from Review using a mutable Chat worker with the conversation's
 * provider/model/reasoning selection. The worker merges the PR base, resolves markers, and pushes.
 * Model completion alone is insufficient: require Git postchecks for no unmerged files, no MERGE_HEAD,
 * no conflict markers, and a pushed branch. Return structured results. V1 supports single-repository
 * PR-based merge/push; multi-repository cwd is an aggregator and is rejected.
 */

export type ResolveConflictsStatus =
  | 'resolved' // verified merge, no unmerged files/markers/MERGE_HEAD, and branch pushed
  | 'no-pr' // no open branch PR or missing conversation
  | 'not-conflicting' // PR is not conflicting (MERGEABLE)
  | 'unknown' // GitHub is still calculating mergeability; request refresh
  | 'multi-repo-unsupported' // multi-repository resolution is unsupported in V1
  | 'dirty' // dirty worktree or preexisting merge
  | 'cwd-locked' // another cwd activity blocks resolution
  | 'agent-unavailable' // conversation lacks an executable Chat selection
  | 'unresolved' // postcheck found unmerged files or conflict markers
  | 'merge-incomplete' // postcheck found MERGE_HEAD, an unfinished merge
  | 'not-pushed' // postcheck found local resolution without remote push
  | 'agent-failed' // Chat worker did not complete

export interface ResolveConflictsOpts {
  providerId?: string
  modelId?: string
  reasoning?: string
}

export interface ResolveConflictsResult {
  ok: boolean
  status: ResolveConflictsStatus
  /** Technical message for logs/tooltips; UI provides friendly text per status. */
  reason?: string
}

/**
 * Pure PR mergeability precheck: missing PR gives no-pr, UNKNOWN gives unknown, non-CONFLICTING gives
 * not-conflicting, and CONFLICTING permits resolution. Uses the existing gh-service tri-state signal.
 */
export function precheckPrMergeable(pr: { mergeable: string } | null | undefined): ResolveConflictsStatus | null {
  if (!pr) return 'no-pr'
  if (pr.mergeable === 'UNKNOWN') return 'unknown'
  if (pr.mergeable !== 'CONFLICTING') return 'not-conflicting'
  return null
}

/**
 * Pure worker prompt: fetch base, merge, resolve, commit, then push explicit HEAD:<branch>. App
 * worktree upstreams may point to origin/main, so a bare push can target the wrong ref. Abort cleanly
 * on failure.
 */
export function buildMergePrompt(baseRef: string, branch: string): string {
  const qBaseRef = shQuote(baseRef)
  const qBaseRemoteRef = shQuote(`origin/${baseRef}`)
  const qPushRefspec = shQuote(`HEAD:${branch}`)
  return [
    'Resolve MERGE CONFLICTS between the current branch and the PR base. Work in the current working directory',
    '(already on the PR branch). Execute EXACTLY these Git steps without asking for confirmation:',
    '',
    `1. Update the base from the remote: \`git fetch origin ${qBaseRef}\`.`,
    `2. Merge the base into the current branch: \`git merge --no-edit ${qBaseRemoteRef}\`.`,
    '3. For each conflicting file (see `git status`), open it, understand BOTH sides, and resolve it consistently,',
    '   preserving the intent of both sides. Remove ALL Git conflict markers',
    '   (lines with `<<<<<<<`, `=======`, and `>>>>>>>`). Verify with `git diff --check`.',
    '4. Stage the resolution: `git add -A` and complete the merge with `git commit --no-edit`.',
    `5. Push the branch to the remote with an EXPLICIT refspec: \`git push origin ${qPushRefspec}\`. Never use --force.`,
    '',
    'IF you cannot resolve safely (ambiguous conflict, genuine uncertainty), ABORT cleanly with',
    '`git merge --abort` to restore the previous worktree state, and explain why in your response.',
    'When finished, provide a SUMMARY of the resolution (files changed and decisions made).',
  ].join('\n')
}

/**
 * POSIX-quote refs in worker commands. Branch names can contain shell metacharacters such as $,
 * parentheses, and semicolons.
 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const PRECHECK_REASON: Record<string, string> = {
  'no-pr': 'this branch has no open PR.',
  'not-conflicting': 'the PR has no merge conflicts.',
  unknown: 'GitHub is still calculating merge status; refresh and try again.',
}

export function conflictAgentFailureStatus(
  errorCode: 'agent-unavailable' | 'agent-failed' | undefined
): 'agent-unavailable' | 'agent-failed' {
  return errorCode === 'agent-unavailable' ? 'agent-unavailable' : 'agent-failed'
}

/**
 * Recheck PR conflicts, reject unsupported repositories and unsafe Git state, run the mutable worker,
 * and verify through Git before returning resolved.
 */
export async function resolveReviewConflicts(
  convId: string,
  opts: ResolveConflictsOpts = {}
): Promise<ResolveConflictsResult> {
  const conv = getConversation(convId)
  if (!conv) return { ok: false, status: 'no-pr', reason: 'conversation not found.' }

  // Reject multi-repository conversations in V1 because their aggregator cwd would resolve in the wrong
  // directory.
  if (conv.isMulti) {
    return {
      ok: false,
      status: 'multi-repo-unsupported',
      reason: 'multi-repository conversation (per-repository resolution is not yet supported).',
    }
  }

  // Recheck through the Review PR pipeline rather than trusting stale UI state.
  const review = await getReviewData(convId)
  const repo = review.repos[0]
  const pr = repo?.pr ?? null
  const pre = precheckPrMergeable(pr)
  if (pre) return { ok: false, status: pre, reason: PRECHECK_REASON[pre] }

  const cwd = conv.cwd
  const baseRef = pr!.baseRef
  const branch = repo!.branch || conv.branch
  const prompt = buildMergePrompt(baseRef, branch)

  const chat = getConvUiPrefs(convId).chat
  const providerId = opts.providerId || chat?.providerId
  const modelId = opts.modelId || chat?.modelId
  if (!providerId || !modelId) {
    return { ok: false, status: 'agent-unavailable', reason: 'the conversation has no Chat provider/model selected.' }
  }
  const definition = BUILTIN_AGENTS.find((agent) => agent.name === 'general-purpose')
  if (!definition) {
    return { ok: false, status: 'agent-unavailable', reason: 'the general-purpose agent is unavailable.' }
  }
  const reasoning = opts.reasoning ?? chat?.reasoning ?? 'off'
  const profile = await resolveParentSubagentExecutionProfile({
    agent: definition,
    parent: { providerId, modelId, effort: reasoning },
    parentFastMode: chat?.fastMode === true,
  })
  if (!profile.effective) {
    const diagnostic = profile.attempts
      .flatMap((attempt) => attempt.diagnostics)
      .find((item) => item.severity === 'error')
    return {
      ok: false,
      status: 'agent-unavailable',
      reason: diagnostic?.message ?? 'the current provider/model selection is unavailable.',
    }
  }

  // This explicit Review action has no permission UI round trip. A dedicated broker with authorized rules
  // avoids leaving the worker waiting on a question only ChatView could display.
  const workflowBroker = new PermissionBroker({ rulesetFor: () => YOLO_RULESET })
  const exclusive = await tryWithCwdExclusive(cwd, async (): Promise<ResolveConflictsResult> => {
    // Reject uncommitted changes or a merge already in progress before resolution.
    if (!(await isWorkingTreeClean(cwd))) {
      return { ok: false, status: 'dirty', reason: 'the worktree has uncommitted changes; commit or stash them first.' }
    }
    if (await isMergeInProgress(cwd)) {
      return { ok: false, status: 'dirty', reason: 'a merge is already in progress in the worktree.' }
    }

    let run: SubagentExecutionResult
    try {
      run = await executeSubagent({
        conversationId: convId,
        projectId: conv.workspaceId,
        cwd,
        parentMessageId: randomUUID(),
        parentMessageOwnership: { kind: 'host-managed', cleanup: 'delete' },
        toolCallId: randomUUID(),
        mode: 'agent',
        permMode: 'full',
        profile,
        definition,
        agentName: definition.name,
        task: prompt,
        readOnly: false,
        broker: workflowBroker,
        questionBroker: getChatQuestionBroker(),
        signal: new AbortController().signal,
      })
    } catch (error) {
      return { ok: false, status: 'agent-failed', reason: error instanceof Error ? error.message : String(error) }
    }

    // Return worker failures before postverification.
    if (run.error) return { ok: false, status: conflictAgentFailureStatus(run.errorCode), reason: run.error }

    // Mandatory Git postverification: textual success does not prove conflict resolution.
    if (await hasUnmergedFiles(cwd)) {
      return { ok: false, status: 'unresolved', reason: 'there are still unmerged files.' }
    }
    if (await isMergeInProgress(cwd)) {
      return { ok: false, status: 'merge-incomplete', reason: 'the merge was not completed (MERGE_HEAD exists).' }
    }
    if (await hasConflictMarkers(cwd)) {
      return { ok: false, status: 'unresolved', reason: 'conflict markers remain in files.' }
    }
    if (!(await isBranchPushed(cwd, branch))) {
      return {
        ok: false,
        status: 'not-pushed',
        reason: 'the merge completed, but the branch was not pushed to the remote.',
      }
    }

    return { ok: true, status: 'resolved' }
  })

  if (!exclusive.ok) {
    return {
      ok: false,
      status: 'cwd-locked',
      reason:
        exclusive.reason === 'active'
          ? 'the worktree is in use by another activity.'
          : 'the worktree is reserved by another operation.',
    }
  }
  return exclusive.value
}
