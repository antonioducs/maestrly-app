import { z } from 'zod'

/**
 * Snapshots of a conversation's folders at the start and end of each turn, and undoing (or redoing) the file changes
 * a turn made. Shared by the main process, which owns the snapshots, and the renderer, which shows them.
 */

export type TurnSnapshotStatus = 'capturing' | 'ready' | 'unavailable' | 'expired'

export type TurnSnapshotUnavailableReason =
  | 'disabled'
  | 'git-missing'
  | 'contains-profile'
  | 'not-a-directory'
  | 'too-many-files'
  | 'slow'
  | 'failed'

export type TurnFileStatus = 'added' | 'modified' | 'deleted'

/** A changed file of a turn. `root` indexes the conversation's folders (one per repository in multi-repository). */
export interface TurnFileChange {
  root: number
  path: string
  status: TurnFileStatus
  additions: number
  deletions: number
  binary: boolean
  /** Above the size limit at the start or end of the turn: its content there was not saved. */
  large?: boolean
}

export interface TurnChangeTotals {
  files: number
  additions: number
  deletions: number
}

/** A file's undo state: undone (redo available) or redone after an undo. */
export type TurnFileRevertState = 'undone' | 'redone'

/** Compact view of one turn, as the transcript lists them. */
export interface TurnSnapshotSummary {
  id: string
  userMessageId: string
  assistantMessageId: string | null
  status: TurnSnapshotStatus
  unavailableReason: TurnSnapshotUnavailableReason | null
  totals: TurnChangeTotals | null
  /** Files currently undone. */
  undone: number
  startedAt: number
  endedAt: number | null
}

export interface TurnSnapshotRoot {
  /** Repository link name in a multi-repository conversation; absent for the conversation's own folder. */
  label?: string
}

/** One turn with its files, loaded when the person opens its changes. */
export interface TurnSnapshotDetail extends TurnSnapshotSummary {
  roots: TurnSnapshotRoot[]
  files: Array<TurnFileChange & { revert?: TurnFileRevertState }>
  /** More files changed than are listed. */
  truncated: boolean
}

export interface TurnSnapshotList {
  enabled: boolean
  records: TurnSnapshotSummary[]
}

export type TurnRevertAction = 'undo' | 'redo'

/** What confirming does to a file on disk. */
export type TurnRevertEffect = 'restore' | 'delete' | 'recreate'

export type TurnRevertConflict = 'later-turn' | 'outside'

export type TurnRevertBlocker = 'large' | 'unavailable' | 'parent-link' | 'submodule'

export interface TurnRevertFile {
  root: number
  path: string
  effect: TurnRevertEffect
  /** The file changed after the turn; confirming overwrites that change only when the person selects it. */
  conflict?: TurnRevertConflict
  /** Other conversations working in the same folder during the turn that changed this file too. */
  maybeFrom?: Array<{ conversationId: string; name: string }>
  /** Why the file cannot be restored; it is listed but never selectable. */
  blocked?: TurnRevertBlocker
}

export interface TurnRevertPreview {
  action: TurnRevertAction
  files: TurnRevertFile[]
  /** Other conversations that worked in the same folder while this turn ran. */
  overlap: Array<{ conversationId: string; name: string }>
  /** Another conversation is running in this folder now. */
  othersRunning: Array<{ conversationId: string; name: string }>
}

export type TurnRevertPrepareResult =
  | { status: 'ready'; token: string; preview: TurnRevertPreview }
  | { status: 'unavailable'; reason: TurnSnapshotUnavailableReason | 'expired' | 'not-found' | 'nothing' }
  | { status: 'busy' }

export type TurnRestoreFailure =
  | 'invalid-path'
  | 'parent-link'
  | 'blocked'
  | 'is-directory'
  | 'unavailable'
  | 'submodule'
  | 'symlink'
  | 'io'

export type TurnRevertConfirmResult =
  | {
      status: 'reverted'
      action: TurnRevertAction
      files: Array<{ root: number; path: string }>
      failed: Array<{ root: number; path: string; reason: TurnRestoreFailure }>
    }
  | { status: 'stale'; token: string; preview: TurnRevertPreview }
  | { status: 'busy' }
  | { status: 'invalid-token' }
  | { status: 'expired-token' }

export interface TurnFilePatch {
  patch: string
  /** Larger than what one file may show. */
  truncated: boolean
  binary: boolean
}

export interface TurnSnapshotUsage {
  enabled: boolean
  gitAvailable: boolean
  bytes: number
  records: number
}

const id = z.string().trim().min(1).max(200)
const filePath = z.string().min(1).max(4096)
const fileRef = z.object({ root: z.number().int().min(0).max(64), path: filePath }).strict()

export const turnSnapshotListInputSchema = z.object({ conversationId: id, recordId: id.optional() }).strict()

export const turnSnapshotDiffInputSchema = z
  .object({
    conversationId: id,
    recordId: id,
    root: z.number().int().min(0).max(64),
    path: filePath,
    /** The turn's own change, or what confirming a prepared revert would do. */
    token: z.string().min(1).max(200).optional(),
  })
  .strict()

export const turnRevertPrepareInputSchema = z
  .object({
    conversationId: id,
    recordId: id,
    action: z.enum(['undo', 'redo']),
    /** Only these files; all of the turn's files when omitted. */
    files: z.array(fileRef).max(5000).optional(),
  })
  .strict()

export const turnRevertConfirmInputSchema = z
  .object({
    token: z.string().min(1).max(200),
    files: z.array(fileRef).max(5000),
    /** Conflicting files the person chose to overwrite. */
    overwrite: z.array(fileRef).max(5000),
  })
  .strict()

export const turnSnapshotEnabledInputSchema = z.object({ enabled: z.boolean() }).strict()

export type TurnSnapshotListInput = z.infer<typeof turnSnapshotListInputSchema>
export type TurnSnapshotDiffInput = z.infer<typeof turnSnapshotDiffInputSchema>
export type TurnRevertPrepareInput = z.infer<typeof turnRevertPrepareInputSchema>
export type TurnRevertConfirmInput = z.infer<typeof turnRevertConfirmInputSchema>

export const turnSnapshotsChangedChannel = (conversationId: string): string => `turnSnapshots:changed:${conversationId}`

/** Joins a file's folder label and path for display. */
export function turnFileDisplayPath(roots: readonly TurnSnapshotRoot[], file: { root: number; path: string }): string {
  const label = roots[file.root]?.label
  return label ? `${label}/${file.path}` : file.path
}
