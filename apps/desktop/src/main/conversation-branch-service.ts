import { requireProjectConversation } from '../shared/conversation-scope'
import path from 'node:path'
import type { ConversationBranchInfo, ConversationBranchRepoInfo, GitHeadState } from '../shared/conversation-branch'
import { currentGitHead } from './git-service'
import { getConversation } from './store'

/** Resolve paths only from the persisted conversation ID so the renderer cannot probe arbitrary paths. */
export async function getConversationBranchInfo(conversationId: string): Promise<ConversationBranchInfo | null> {
  const stored = getConversation(conversationId)
  if (!stored) return null
  const conv = requireProjectConversation(stored)

  const targets = conv.isMulti
    ? (conv.repos ?? []).map((repo) => ({
        name: repo.linkName || path.basename(repo.repoTop),
        cwd: repo.worktreePath,
        assignedBranch: repo.branch,
      }))
    : [{ name: '', cwd: conv.cwd, assignedBranch: conv.branch }]

  const repos = await Promise.all(
    targets.map(async ({ name, cwd, assignedBranch }): Promise<ConversationBranchRepoInfo> => {
      const head = await currentGitHead(cwd)
      return {
        name,
        assignedBranch,
        head,
        diverged: head.kind !== 'unavailable' && assignedBranch !== headName(head),
      }
    })
  )

  return { conversationId, isMulti: !!conv.isMulti, repos }
}

function headName(head: GitHeadState): string {
  return head.kind === 'branch' ? head.name : 'detached'
}
