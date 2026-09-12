import { z } from 'zod'
import type { ConversationExperience } from './conversation-experience'

const nonEmpty = z.string().trim().min(1)

export const localBranchRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), name: nonEmpty }).strict(),
  z
    .object({
      kind: z.literal('remote'),
      remote: nonEmpty,
      name: nonEmpty,
      ref: nonEmpty,
    })
    .strict(),
])
export type LocalBranchRef = z.infer<typeof localBranchRefSchema>

export const localBranchIntentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create-from-head'), branch: nonEmpty }).strict(),
  z
    .object({
      type: z.literal('create-from-ref'),
      branch: nonEmpty,
      ref: localBranchRefSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('switch-existing'),
      branch: nonEmpty,
      ref: localBranchRefSchema,
    })
    .strict(),
])
export type LocalBranchIntent = z.infer<typeof localBranchIntentSchema>

export const localConversationPrepareInputSchema = z
  .object({
    workspaceId: nonEmpty,
    name: z.string().trim().min(1).max(200).optional(),
    experience: z.enum(['standard', 'maestro']).optional(),
    intent: localBranchIntentSchema,
  })
  .strict()
export type LocalConversationPrepareInput = z.infer<typeof localConversationPrepareInputSchema>

export const localConversationConfirmInputSchema = z.object({ token: nonEmpty }).strict()
export type LocalConversationConfirmInput = z.infer<typeof localConversationConfirmInputSchema>

const createConvRepoSchema = z
  .object({
    workspaceId: nonEmpty,
    branch: nonEmpty,
    isNewBranch: z.boolean(),
    base: nonEmpty.optional(),
  })
  .strict()

export const publicCreateConversationSchema = z
  .object({
    workspaceId: nonEmpty,
    branch: nonEmpty,
    isNewBranch: z.boolean(),
    base: nonEmpty.optional(),
    mode: z.literal('worktree'),
    experience: z.enum(['standard', 'maestro']).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    repos: z.array(createConvRepoSchema).min(1).optional(),
  })
  .strict()
export type PublicCreateConversationInput = z.infer<typeof publicCreateConversationSchema>

export const localConversationStrategySchema = z.enum(['switch-head', 'switch-direct', 'stash-switch-apply'])
export type LocalConversationStrategy = z.infer<typeof localConversationStrategySchema>

export const cwdActivityKindSchema = z.enum(['pty', 'chat', 'terminal'])
export type CwdActivityKind = z.infer<typeof cwdActivityKindSchema>

export interface CwdActivityItem {
  kind: CwdActivityKind
  count: number
  blocking: boolean
}

export interface LocalChangeSummary {
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

export type LocalConversationBlockerCode =
  | 'activity'
  | 'branch-invalid'
  | 'branch-exists'
  | 'ref-not-found'
  | 'remote-ambiguous'
  | 'branch-in-worktree'
  | 'git-operation'
  | 'unmerged'
  | 'submodule-dirty'
  | 'ignored-collision'
  | 'git-error'
  | 'cwd-active'

export interface LocalConversationBlocker {
  code: LocalConversationBlockerCode
  message: string
  paths?: string[]
}

export interface LocalConversationPreview {
  currentBranch: string
  headOid: string
  targetBranch: string
  targetOid: string
  targetLabel: string
  strategy: LocalConversationStrategy
  changes: LocalChangeSummary
  ignoredCollisions: string[]
  blockers: LocalConversationBlocker[]
  activity: CwdActivityItem[]
  dirty: boolean
  requiresConfirmation: boolean
}

export interface LocalConversationRecord {
  id: string
  workspaceId: string
  name: string
  branch: string
  mode: 'local'
  experience: ConversationExperience
  cwd: string
  status: 'idle'
  createdAt: number
  archived: number
  lastActivityAt: number
  isMulti: number
}

export interface LocalConversationRecovery {
  stashOid?: string
  marker?: string
  currentBranch: string
  headOid: string
  status: string[]
  commands: string[]
  message: string
}

export type LocalConversationPrepareResult =
  | {
      status: 'ready'
      token: string
      preview: LocalConversationPreview
      requiresConfirmation: boolean
    }
  | {
      status: 'blocked'
      preview: LocalConversationPreview
      blockers: LocalConversationBlocker[]
    }
  | { status: 'invalid'; message: string }

export type LocalConversationConfirmResult =
  | {
      status: 'created'
      conversation: LocalConversationRecord
      warning?: string
      stashOid?: string
    }
  | {
      status: 'stale'
      token: string
      preview: LocalConversationPreview
      message: string
    }
  | {
      status: 'blocked'
      preview: LocalConversationPreview
      blockers: LocalConversationBlocker[]
    }
  | {
      status: 'recovery-required'
      preview: LocalConversationPreview
      recovery: LocalConversationRecovery
    }
  | { status: 'invalid-token' | 'expired-token'; message: string }
