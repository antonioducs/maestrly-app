export type GitHeadState =
  | { kind: 'branch'; name: string }
  | { kind: 'detached'; commit: string }
  | { kind: 'unavailable' }

export interface ConversationBranchRepoInfo {
  name: string
  assignedBranch: string
  head: GitHeadState
  diverged: boolean
}

export interface ConversationBranchInfo {
  conversationId: string
  isMulti: boolean
  repos: ConversationBranchRepoInfo[]
}
