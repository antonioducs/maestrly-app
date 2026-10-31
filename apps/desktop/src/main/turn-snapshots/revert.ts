import { randomUUID } from 'node:crypto'
import type {
  TurnFilePatch,
  TurnRevertAction,
  TurnRevertConfirmInput,
  TurnRevertConfirmResult,
  TurnRevertFile,
  TurnRevertPrepareInput,
  TurnRevertPrepareResult,
  TurnRevertPreview,
  TurnSnapshotDetail,
  TurnSnapshotList,
  TurnSnapshotSummary,
} from '../../shared/turn-snapshots'
import { tryAcquireCwdActivity } from '../cwd-activity-coordinator'
import { getConversation } from '../store'
import { captureTree } from './capture'
import { ABSENT, type PathState, rootChanges, sameState, statesAt } from './changes'
import { recordRef } from './gc'
import { conversationsRunningIn, notifyTurnSnapshotsChanged, turnSnapshotsEnabled } from './lifecycle'
import {
  getSnapshotRecord,
  listSnapshotRecords,
  revertKey,
  type RevertFileState,
  type SnapshotRoot,
  snapshotRecordsSince,
  type StoredRevert,
  type TurnSnapshotRecord,
  updateSnapshotRecord,
} from './records'
import { applyTargets, isSafeTreePath } from './restore'
import { reopenSnapshotDir, type SnapshotDir, SnapshotUnavailableError } from './store'
import { diffPatch, readBlobs } from './tree'

/**
 * Undoing and redoing a turn's file changes in two steps. Preparing captures the folders now and plans each file:
 * what it becomes, whether it changed since the turn (a conflict), and whether it can be restored at all. Confirming
 * takes the single-use token, captures again and refuses with a fresh plan if a chosen file moved meanwhile, writes
 * only what the person chose (conflicts only when chosen explicitly), and records what it did so it can be redone.
 */

export const TOKEN_TTL_MS = 5 * 60_000
export const MAX_PATCH_BYTES = 256 * 1024

export interface RevertDeps {
  isRunning: (conversationId: string) => boolean
}

interface PlannedFile extends TurnRevertFile {
  target: PathState
  /** Tree holding `target`, for previews. */
  targetTree: string
  now: PathState
  nowTree: string
}

interface Pending {
  conversationId: string
  recordId: string
  action: TurnRevertAction
  requested: Array<{ root: number; path: string }> | undefined
  files: Map<string, PlannedFile>
  expiresAt: number
}

const pending = new Map<string, Pending>()

function sweepTokens(now = Date.now()): void {
  for (const [token, entry] of pending) if (entry.expiresAt <= now) pending.delete(token)
}

export function forgetRevertTokensForTests(): void {
  pending.clear()
}

function conversationName(id: string): string {
  return getConversation(id)?.name ?? id
}

function summaryOf(record: TurnSnapshotRecord): TurnSnapshotSummary {
  const undone = Object.values(record.revert?.files ?? {}).filter((file) => file.state === 'undone').length
  return {
    id: record.id,
    userMessageId: record.userMessageId,
    assistantMessageId: record.assistantMessageId,
    status: record.status,
    unavailableReason: record.unavailableReason,
    totals: record.summary?.totals ?? null,
    undone,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  }
}

export function listTurnSnapshots(conversationId: string): TurnSnapshotList {
  return { enabled: turnSnapshotsEnabled(), records: listSnapshotRecords(conversationId).map(summaryOf) }
}

export function turnSnapshotDetail(conversationId: string, recordId: string): TurnSnapshotDetail | null {
  const record = getSnapshotRecord(recordId)
  if (!record || record.conversationId !== conversationId) return null
  const files = (record.summary?.files ?? []).map((file) => {
    const state = record.revert?.files[revertKey(file.root, file.path)]?.state
    return state ? { ...file, revert: state } : file
  })
  return {
    ...summaryOf(record),
    roots: record.roots.map((root) => (root.label ? { label: root.label } : {})),
    files,
    truncated: record.summary?.truncated ?? false,
  }
}

function openRoot(root: SnapshotRoot): Promise<SnapshotDir> {
  return reopenSnapshotDir(root.storeKey, root.path)
}

/** Which later turns of this conversation, and which overlapping conversations, changed `file` in this folder. */
function laterChanges(record: TurnSnapshotRecord) {
  const later = snapshotRecordsSince([record.conversationId, ...record.overlap], record.startedAt).filter(
    (other) => other.id !== record.id
  )
  return (folder: string, file: string) => {
    let laterTurn = false
    const others = new Set<string>()
    for (const other of later) {
      const index = other.roots.findIndex((root) => root.path === folder)
      if (index < 0 || !other.summary?.files.some((change) => change.root === index && change.path === file)) continue
      if (other.conversationId === record.conversationId) laterTurn = true
      else others.add(other.conversationId)
    }
    return { laterTurn, others: [...others] }
  }
}

function blobOf(state: PathState): string | null {
  return state.kind === 'entry' && state.mode !== '160000' ? state.oid : null
}

async function plan(
  record: TurnSnapshotRecord,
  action: TurnRevertAction,
  requested: Array<{ root: number; path: string }> | undefined
): Promise<{ files: Map<string, PlannedFile>; preview: TurnRevertPreview } | { reason: 'nothing' }> {
  const wanted = requested ? new Set(requested.map((file) => revertKey(file.root, file.path))) : null
  const revert = record.revert?.files ?? {}
  const changed = laterChanges(record)
  const files = new Map<string, PlannedFile>()
  for (const [index, root] of record.roots.entries()) {
    if (!root.startTree || !root.endTree) continue
    const dir = await openRoot(root)
    const changes = (await rootChanges(dir.store, root)).filter(
      (change) => isSafeTreePath(change.path) && (!wanted || wanted.has(revertKey(index, change.path)))
    )
    const candidates = changes.filter((change) => {
      const state = revert[revertKey(index, change.path)]?.state
      return action === 'undo' ? state !== 'undone' : state === 'undone'
    })
    if (!candidates.length) continue
    const paths = candidates.map((change) => change.path)
    const now = await captureTree(dir, { ref: recordRef(record.id, `now-${index}`) })
    const nowStates = await statesAt(dir.store, now.tree, now.skipped, paths)
    const targets = new Map<string, { state: PathState; tree: string; expected: PathState }>()
    for (const change of candidates) {
      const previous: RevertFileState | undefined = revert[revertKey(index, change.path)]
      if (action === 'undo')
        targets.set(change.path, {
          state: change.start,
          tree: root.startTree,
          expected: previous?.state === 'redone' ? previous.pre : change.end,
        })
      else if (previous)
        targets.set(change.path, { state: previous.pre, tree: previous.preTree, expected: previous.post })
    }
    const readable = new Set(
      (
        await readBlobs(
          dir.store,
          [...targets.values()].flatMap((target) => blobOf(target.state) ?? [])
        ).catch(() => new Map<string, Buffer>())
      ).keys()
    )
    for (const change of candidates) {
      const target = targets.get(change.path)
      if (!target) continue
      const current = nowStates.get(change.path) ?? ABSENT
      // Already as it should be (the person restored it by hand): nothing to do.
      if (sameState(current, target.state)) continue
      const file: PlannedFile = {
        root: index,
        path: change.path,
        effect: target.state.kind === 'absent' ? 'delete' : current.kind === 'absent' ? 'recreate' : 'restore',
        target: target.state,
        targetTree: target.tree,
        now: current,
        nowTree: now.tree,
      }
      if (target.state.kind === 'large') file.blocked = 'large'
      else if (target.state.kind === 'entry' && target.state.mode === '160000') file.blocked = 'submodule'
      else if (target.state.kind === 'entry' && !readable.has(target.state.oid)) file.blocked = 'unavailable'
      if (!sameState(current, target.expected)) {
        const later = changed(root.path, change.path)
        file.conflict = later.laterTurn ? 'later-turn' : 'outside'
        if (later.others.length)
          file.maybeFrom = later.others.map((id) => ({ conversationId: id, name: conversationName(id) }))
      }
      files.set(revertKey(index, change.path), file)
    }
  }
  if (!files.size) return { reason: 'nothing' }
  const preview: TurnRevertPreview = {
    action,
    files: [...files.values()].map(({ target: _t, targetTree: _tt, now: _n, nowTree: _nt, ...file }) => file),
    overlap: record.overlap.map((id) => ({ conversationId: id, name: conversationName(id) })),
    othersRunning: conversationsRunningIn(
      record.roots.map((root) => root.path),
      record.conversationId
    ).map((id) => ({ conversationId: id, name: conversationName(id) })),
  }
  return { files, preview }
}

function issue(
  record: TurnSnapshotRecord,
  action: TurnRevertAction,
  requested: Pending['requested'],
  files: Map<string, PlannedFile>
): string {
  sweepTokens()
  const token = randomUUID()
  pending.set(token, {
    conversationId: record.conversationId,
    recordId: record.id,
    action,
    requested,
    files,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  })
  return token
}

function unavailable(error: unknown): TurnRevertPrepareResult {
  return { status: 'unavailable', reason: error instanceof SnapshotUnavailableError ? error.reason : 'failed' }
}

export async function prepareTurnRevert(
  input: TurnRevertPrepareInput,
  deps: RevertDeps
): Promise<TurnRevertPrepareResult> {
  const record = getSnapshotRecord(input.recordId)
  if (!record || record.conversationId !== input.conversationId) return { status: 'unavailable', reason: 'not-found' }
  if (record.status === 'expired') return { status: 'unavailable', reason: 'expired' }
  if (record.status !== 'ready')
    return {
      status: 'unavailable',
      reason: record.unavailableReason ?? (record.status === 'capturing' ? 'slow' : 'failed'),
    }
  if (deps.isRunning(record.conversationId)) return { status: 'busy' }
  try {
    const planned = await plan(record, input.action, input.files)
    if ('reason' in planned) return { status: 'unavailable', reason: planned.reason }
    return { status: 'ready', token: issue(record, input.action, input.files, planned.files), preview: planned.preview }
  } catch (error) {
    return unavailable(error)
  }
}

export async function confirmTurnRevert(
  input: TurnRevertConfirmInput,
  deps: RevertDeps
): Promise<TurnRevertConfirmResult> {
  const entry = pending.get(input.token)
  // Single use, including when confirming fails.
  pending.delete(input.token)
  sweepTokens()
  if (!entry) return { status: 'invalid-token' }
  if (entry.expiresAt <= Date.now()) return { status: 'expired-token' }
  const record = getSnapshotRecord(entry.recordId)
  const conversation = getConversation(entry.conversationId)
  if (record?.status !== 'ready' || !conversation) return { status: 'invalid-token' }
  if (deps.isRunning(record.conversationId)) return { status: 'busy' }
  const release = tryAcquireCwdActivity(conversation.cwd, 'chat')
  if (!release) return { status: 'busy' }
  try {
    const overwrite = new Set(input.overwrite.map((file) => revertKey(file.root, file.path)))
    const chosen = input.files
      .map((file) => entry.files.get(revertKey(file.root, file.path)))
      .filter((file): file is PlannedFile => !!file && !file.blocked)
      .filter((file) => !file.conflict || overwrite.has(revertKey(file.root, file.path)))
    if (!chosen.length) return { status: 'reverted', action: entry.action, files: [], failed: [] }

    const byRoot = new Map<number, PlannedFile[]>()
    for (const file of chosen) byRoot.set(file.root, [...(byRoot.get(file.root) ?? []), file])
    const dirs = new Map<number, SnapshotDir>()
    const nowTrees = new Map<number, string>()
    for (const [index, files] of byRoot) {
      const root = record.roots[index]!
      const dir = await openRoot(root)
      dirs.set(index, dir)
      const now = await captureTree(dir, { ref: recordRef(record.id, `now-${index}`) })
      nowTrees.set(index, now.tree)
      const states = await statesAt(
        dir.store,
        now.tree,
        now.skipped,
        files.map((file) => file.path)
      )
      // A chosen file changed after the person reviewed it: plan again rather than write over what they did not see.
      if (files.some((file) => !sameState(states.get(file.path) ?? ABSENT, file.now))) {
        const planned = await plan(record, entry.action, entry.requested)
        if ('reason' in planned) return { status: 'reverted', action: entry.action, files: [], failed: [] }
        return {
          status: 'stale',
          token: issue(record, entry.action, entry.requested, planned.files),
          preview: planned.preview,
        }
      }
    }

    const revert: StoredRevert = structuredClone(record.revert ?? { ops: 0, files: {} })
    const op = revert.ops + 1
    revert.ops = op
    const done: Array<{ root: number; path: string }> = []
    const failed: Array<{
      root: number
      path: string
      reason: import('../../shared/turn-snapshots').TurnRestoreFailure
    }> = []
    for (const [index, files] of byRoot) {
      const dir = dirs.get(index)!
      const nowTree = nowTrees.get(index)!
      // The tree before this operation stays alive: it is what a redo writes back.
      await dir.store.write(['update-ref', recordRef(record.id, `op${op}-pre-${index}`), nowTree])
      const outcome = await dir.store.exclusive(() =>
        applyTargets(
          dir.store,
          dir.workTree,
          files.map((file) => ({
            path: file.path,
            entry: file.target.kind === 'entry' ? { mode: file.target.mode, oid: file.target.oid } : null,
          }))
        )
      )
      const post = await captureTree(dir, { ref: recordRef(record.id, `op${op}-post-${index}`) })
      const postStates = await statesAt(dir.store, post.tree, post.skipped, outcome.restored)
      const restored = new Set(outcome.restored)
      for (const file of files) {
        if (!restored.has(file.path)) continue
        const key = revertKey(index, file.path)
        const previous = revert.files[key]
        revert.files[key] =
          entry.action === 'undo'
            ? {
                root: index,
                path: file.path,
                state: 'undone',
                pre: file.now,
                post: postStates.get(file.path) ?? ABSENT,
                preTree: nowTree,
                op,
                at: Date.now(),
              }
            : { ...previous!, state: 'redone', op, at: Date.now() }
        done.push({ root: index, path: file.path })
      }
      for (const failure of outcome.failed) failed.push({ root: index, path: failure.path, reason: failure.reason })
    }
    updateSnapshotRecord(record.id, { revert })
    notifyTurnSnapshotsChanged(record.conversationId)
    return { status: 'reverted', action: entry.action, files: done, failed }
  } finally {
    release()
  }
}

/**
 * Patch of one file: what the turn did, or, with a prepared token, what confirming would do to the file as it is
 * now. Cut at 256 KiB.
 */
export async function turnFilePatch(input: {
  conversationId: string
  recordId: string
  root: number
  path: string
  token?: string
}): Promise<TurnFilePatch | null> {
  const record = getSnapshotRecord(input.recordId)
  if (!record || record.conversationId !== input.conversationId || record.status === 'expired') return null
  const root = record.roots[input.root]
  if (!root?.startTree || !root.endTree || !isSafeTreePath(input.path)) return null
  const dir = await openRoot(root).catch(() => null)
  if (!dir) return null
  let from = root.startTree
  let to = root.endTree
  if (input.token) {
    const entry = pending.get(input.token)
    const file = entry?.recordId === record.id ? entry.files.get(revertKey(input.root, input.path)) : undefined
    if (!file) return null
    from = file.nowTree
    to = file.targetTree
  }
  const { patch, truncated } = await diffPatch(dir.store, from, to, input.path, MAX_PATCH_BYTES)
  return { patch, truncated, binary: !truncated && /^Binary files /m.test(patch) }
}
