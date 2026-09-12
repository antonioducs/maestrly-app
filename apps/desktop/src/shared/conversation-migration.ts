import { z } from 'zod'
import type { LocalChangeSummary, LocalConversationBlocker } from './local-conversation'

const nonEmpty = z.string().trim().min(1)
const exactPath = z.string().min(1).max(4096)
export const migrationPrepareSchema = z
  .object({ conversationId: nonEmpty, destinationBranch: nonEmpty.max(240) })
  .strict()
export const migrationExecuteSchema = z
  .object({
    operationId: nonEmpty,
    selectedIgnoredPaths: z.array(exactPath).max(1000),
    confirmedSensitivePaths: z.array(exactPath).max(1000).default([]),
  })
  .strict()
export const migrationCancelSchema = z.object({ operationId: nonEmpty }).strict()
export const migrationResolveSchema = z
  .object({ operationId: nonEmpty, action: z.enum(['continue', 'rollback']) })
  .strict()

export type MigrationPrepareInput = z.infer<typeof migrationPrepareSchema>
export type MigrationExecuteInput = z.infer<typeof migrationExecuteSchema>
export type MigrationCancelInput = z.infer<typeof migrationCancelSchema>
export type MigrationResolveInput = z.infer<typeof migrationResolveSchema>

export const migrationPhases = [
  'prepared',
  'transferring',
  'sidecars',
  'identity',
  'awaiting-validation',
  'finalizing',
  'finalizing-stash',
  'completed',
  'rolling-back',
  'rolled-back',
  'cancelled',
] as const
export type MigrationPhase = (typeof migrationPhases)[number]
export type MigrationStatus =
  | 'prepared'
  | 'running'
  | 'awaiting-validation'
  | 'completed'
  | 'recovery-required'
  | 'cancelled'
  | 'rolled-back'
export interface IgnoredMigrationEntry {
  path: string
  size: number
  kind: 'file' | 'directory' | 'symlink' | 'other'
  sensitive: boolean
  selectable: boolean
  reasonCode?: 'reserved' | 'tracked-collision' | 'unsupported' | 'unsafe'
  reason?: string
}

export interface SidecarMutation {
  path: string
  kind: 'note' | 'ignored' | 'config'
  entry: 'file' | 'directory'
  created: boolean
  beforeContentBase64?: string
  beforeMode?: number
  afterContentBase64?: string
  afterSha256?: string
  afterMode?: number
}

export interface MigrationPreview {
  operationId: string
  conversationId: string
  sourceBranch: string
  sourceHeadOid: string
  sourceCwd: string
  destinationBranch: string
  destinationCwd: string
  changes: LocalChangeSummary
  ignored: IgnoredMigrationEntry[]
  blockers: LocalConversationBlocker[]
  expiresAt: number
}

export interface MigrationRecovery {
  operationId: string
  conversationId: string
  phase: MigrationPhase
  status: MigrationStatus
  sourceCwd: string
  destinationCwd: string
  stashOid?: string
  canContinue: boolean
  canRollback: boolean
  message?: string
}

export interface MigrationResult {
  operationId: string
  status: 'completed' | 'recovery-required' | 'cancelled' | 'rolled-back'
  conversationId: string
  recovery?: MigrationRecovery
}

export interface MigrationChangedEvent {
  operationId: string
  phase: MigrationPhase
  status: MigrationStatus
  conversationId: string
  error?: string
}

export interface ConversationMigrationRecord {
  id: string
  conversationId: string
  /** Only populated while recovering a pre-Chat-only journal that created a successor conversation. */
  legacySuccessorConversationId?: string
  sourceWorkspaceId: string
  sourceBranch: string
  destinationBranch: string
  sourceCwd: string
  destinationCwd: string
  sourceHeadOid: string
  changes: LocalChangeSummary
  ignored: IgnoredMigrationEntry[]
  selectedIgnoredPaths: string[]
  confirmedSensitivePaths: string[]
  gitPlan: unknown
  sidecars: SidecarMutation[]
  phase: MigrationPhase
  status: MigrationStatus
  stashOid?: string
  stashMarker?: string
  baselineAssistants: number
  error?: string
  createdAt: number
  updatedAt: number
}
