import type {
  MoveBlocker,
  MoveBranchAction,
  MoveDigest,
  SourceInspection,
  TargetInspection,
} from '../../shared/conversation-move'

export type BranchDecision =
  | { branch: string; action: MoveBranchAction; expectedTipOid?: string; renamed: boolean }
  | { blocker: MoveBlocker }

/**
 * Which branch the conversation lands on at the destination: its own name when it is free, already there, or behind
 * the moved HEAD (fast-forwarded); otherwise a free `<branch>-moved` name, unless the person chose the name.
 */
export function decideTargetBranch(input: {
  source: SourceInspection
  target: TargetInspection
  explicit: boolean
  sourceAncestor: boolean | null
}): BranchDecision {
  const { branch } = input.target
  if (branch.state === 'absent') return { branch: branch.name, action: 'create', renamed: false }
  if (branch.state === 'same') return { branch: branch.name, action: 'reuse', renamed: false }
  const ancestor = branch.ancestor ?? input.sourceAncestor
  if (branch.state === 'exists' && ancestor === true && branch.tipOid)
    return { branch: branch.name, action: 'fast-forward', expectedTipOid: branch.tipOid, renamed: false }
  if (input.explicit)
    return {
      blocker: {
        code: 'target-branch-unavailable',
        message: `Branch ${branch.name} is in use or has diverged on the destination.`,
      },
    }
  return { branch: branch.freeAlternative, action: 'create', renamed: true }
}

export function sameDigest(a: MoveDigest, b: MoveDigest): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.messages === b.messages &&
    a.lastSeq === b.lastSeq &&
    a.messagesSha256 === b.messagesSha256 &&
    a.files === b.files &&
    a.filesSha256 === b.filesSha256 &&
    a.headOid === b.headOid &&
    a.indexTree === b.indexTree &&
    a.worktreeTree === b.worktreeTree
  )
}
