import { z } from 'zod'
import type { IgnoredMigrationEntry } from './conversation-migration'
import type { HostId } from './host-key'
import type { LocalChangeSummary } from './local-conversation'

/**
 * Moving a project conversation between hosts (this computer and a remote workspaces host, either way). This
 * computer's main process coordinates the move; each host serves the same source and target endpoint.
 */
export const CONVERSATION_MOVE_PACKAGE_FORMAT = 'maestrly-conversation-move'
export const CONVERSATION_MOVE_PACKAGE_VERSION = 1
export const MOVE_PREPARE_TTL_MS = 15 * 60_000
export const MOVE_BACKUP_RETENTION_MS = 7 * 24 * 60 * 60_000

const nonEmpty = z.string().trim().min(1)
const hostIdSchema = z.string().min(1).max(200)
const uuid = z.string().regex(/^[0-9a-f-]{36}$/i)
const exactPath = z.string().min(1).max(4096)

export const movePrepareSchema = z
  .object({
    sourceHostId: hostIdSchema,
    conversationId: nonEmpty.max(200),
    targetHostId: hostIdSchema,
    targetBranch: nonEmpty.max(240).optional(),
  })
  .strict()
export const moveExecuteSchema = z
  .object({
    operationId: uuid,
    selectedIgnoredPaths: z.array(exactPath).max(1000),
    confirmedSensitivePaths: z.array(exactPath).max(1000).default([]),
  })
  .strict()
export const moveCancelSchema = z.object({ operationId: uuid }).strict()
export const moveResolveSchema = z.object({ operationId: uuid, action: z.enum(['continue', 'rollback']) }).strict()
export type MovePrepareInput = z.infer<typeof movePrepareSchema>
export type MoveExecuteInput = z.input<typeof moveExecuteSchema>

const oid = z.string().regex(/^[0-9a-f]{40,64}$/i)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i)
const absolutePath = z.string().min(1).max(4096)
const operation = { operationId: uuid }
const workspacePlanSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('existing'),
      workspaceId: nonEmpty.max(200),
      name: z.string().max(400),
      path: absolutePath,
    })
    .strict(),
  z.object({ kind: z.literal('adopt'), path: absolutePath, name: z.string().max(400) }).strict(),
  z
    .object({
      kind: z.literal('clone'),
      parentPath: absolutePath,
      name: nonEmpty.max(255),
      remoteUrl: nonEmpty.max(4096),
      defaultBranch: nonEmpty.max(240),
    })
    .strict(),
])
/** What each endpoint method accepts from the computer coordinating a move. */
export const endpointInputSchemas = {
  inspectSource: z.object({ conversationId: nonEmpty.max(200) }).strict(),
  checkAncestry: z.object({ conversationId: nonEmpty.max(200), ancestorOid: oid }).strict(),
  inspectTarget: z
    .object({
      conversationId: nonEmpty.max(200),
      remoteUrl: nonEmpty.max(4096),
      defaultBranch: nonEmpty.max(240),
      branch: nonEmpty.max(240),
      headOid: oid,
    })
    .strict(),
  freezeSource: z
    .object({ ...operation, conversationId: nonEmpty.max(200), fingerprint: z.string().max(200) })
    .strict(),
  exportSource: z
    .object({
      ...operation,
      selectedIgnoredPaths: z.array(exactPath).max(1000),
      confirmedSensitivePaths: z.array(exactPath).max(1000),
    })
    .strict(),
  stagingDirectory: z.object(operation).strict(),
  prepareTargetWorkspace: z
    .object({ ...operation, conversationId: nonEmpty.max(200), workspace: workspacePlanSchema })
    .strict(),
  importTarget: z
    .object({
      ...operation,
      packagePath: absolutePath,
      sha256,
      workspaceId: nonEmpty.max(200),
      plan: z
        .object({
          workspace: workspacePlanSchema,
          branch: nonEmpty.max(240),
          branchAction: z.enum(['create', 'reuse', 'fast-forward']),
          expectedTipOid: oid.optional(),
        })
        .strict(),
    })
    .strict(),
  verifyTarget: z.object(operation).strict(),
  releaseSource: z.object(operation).strict(),
  commitTarget: z.object(operation).strict(),
  discardTarget: z.object(operation).strict(),
  thawSource: z.object(operation).strict(),
  cleanup: z.object(operation).strict(),
} as const
export type MoveEndpointMethod = keyof typeof endpointInputSchemas

export const movePhases = [
  'prepared',
  'freezing',
  'exporting',
  'transferring',
  'preparing-target',
  'importing',
  'verifying',
  'releasing-source',
  'committing',
  'completed',
  'rolling-back',
  'rolled-back',
  'cancelled',
] as const
export type MovePhase = (typeof movePhases)[number]
export type MoveStatus = 'prepared' | 'running' | 'recovery-required' | 'completed' | 'cancelled' | 'rolled-back'
export const MOVE_TERMINAL_STATUSES: ReadonlySet<MoveStatus> = new Set(['completed', 'cancelled', 'rolled-back'])
/** Rollback is offered only before the source is released. */
export const canRollbackMovePhase = (phase: MovePhase): boolean =>
  movePhases.indexOf(phase) < movePhases.indexOf('releasing-source')

export type MoveBlockerCode =
  | 'not-eligible'
  | 'running'
  | 'cwd-active'
  | 'incomplete-operation'
  | 'detached-head'
  | 'no-origin'
  | 'git-operation'
  | 'unmerged'
  | 'submodule-dirty'
  | 'host-unavailable'
  | 'same-host'
  | 'target-has-conversation'
  | 'projects-directory-missing'
  | 'clone-destination-exists'
  | 'target-branch-invalid'
  | 'target-branch-unavailable'
export interface MoveBlocker {
  code: MoveBlockerCode
  message: string
  paths?: string[]
}
export type MoveWarningCode =
  | 'provider-session-restarts'
  | 'runtime-not-moved'
  | 'project-memory-stays'
  | 'source-checkout-kept'
  | 'branch-renamed'
  | 'clone-required'
  | 'submodules'
  | 'git-lfs'

export type MoveTargetWorkspacePlan =
  | { kind: 'existing'; workspaceId: string; name: string; path: string }
  | { kind: 'adopt'; path: string; name: string }
  | { kind: 'clone'; parentPath: string; name: string; remoteUrl: string; defaultBranch: string }
export type MoveBranchAction = 'create' | 'reuse' | 'fast-forward'
export interface MoveTargetPlan {
  workspace: MoveTargetWorkspacePlan
  branch: string
  branchAction: MoveBranchAction
  expectedTipOid?: string
}
export interface MoveTranscriptStats {
  messages: number
  files: number
  fileBytes: number
}
/** What both ends compute independently to prove the destination holds what the source exported. */
export interface MoveDigest {
  conversationId: string
  messages: number
  lastSeq: number
  messagesSha256: string
  files: number
  filesSha256: string
  headOid: string
  indexTree: string
  worktreeTree: string
}
export interface SourceInspection {
  conversationId: string
  conversationName: string
  cwd: string
  mode: 'local' | 'worktree'
  branch: string | null
  headOid: string
  remoteUrl: string | null
  defaultBranch: string
  commitsAhead: number
  changes: LocalChangeSummary
  ignored: IgnoredMigrationEntry[]
  transcript: MoveTranscriptStats
  fingerprint: string
  blockers: MoveBlocker[]
  warnings: MoveWarningCode[]
}
export interface TargetInspectionInput {
  conversationId: string
  remoteUrl: string
  defaultBranch: string
  branch: string
  headOid: string
}
export interface TargetInspection {
  workspace: MoveTargetWorkspacePlan | null
  branch: {
    name: string
    state: 'absent' | 'same' | 'exists' | 'checked-out'
    tipOid?: string
    /** null when the target lacks the source head and cannot tell. */
    ancestor: boolean | null
    freeAlternative: string
  }
  blockers: MoveBlocker[]
}
export interface ExportedPackage {
  path: string
  name: string
  size: number
  sha256: string
  digest: MoveDigest
}
export interface ImportTargetInput {
  operationId: string
  packagePath: string
  sha256: string
  workspaceId: string
  plan: MoveTargetPlan
}
export interface ImportedConversation {
  conversationId: string
  workspaceId: string
  cwd: string
  branch: string
}
export interface MoveEndpointProgress {
  operationId: string
  step: 'clone' | 'import'
  phase?: string
  percent?: number
}
export interface MovePreview {
  /** null: the move is blocked and nothing was journaled. */
  operationId: string | null
  expiresAt: number
  conversationId: string
  conversationName: string
  sourceHostId: HostId
  targetHostId: HostId
  source: {
    cwd: string
    branch: string | null
    headOid: string
    mode: 'local' | 'worktree'
    commitsAhead: number
    changes: LocalChangeSummary
  }
  target: MoveTargetPlan | null
  ignored: IgnoredMigrationEntry[]
  transcript: MoveTranscriptStats
  warnings: MoveWarningCode[]
  blockers: MoveBlocker[]
  /** The source's fingerprint at preview time; freezing refuses a conversation that changed since. */
  fingerprint: string
}
export interface MoveChangedEvent {
  operationId: string
  conversationId: string
  sourceHostId: HostId
  targetHostId: HostId
  phase: MovePhase
  status: MoveStatus
  transfer?: { doneBytes: number; size: number }
  clone?: { phase: string; percent?: number }
  error?: string
  errorCode?: string
}
export interface MoveRecovery {
  operationId: string
  conversationId: string
  conversationName: string
  sourceHostId: HostId
  targetHostId: HostId
  phase: MovePhase
  status: MoveStatus
  canContinue: boolean
  canRollback: boolean
  message?: string
  errorCode?: string
}
export interface MoveResult {
  operationId: string
  status: 'completed' | 'recovery-required' | 'cancelled' | 'rolled-back'
  target?: { hostId: HostId; conversationId: string }
  recovery?: MoveRecovery
}
