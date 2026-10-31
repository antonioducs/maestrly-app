import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Conversation } from '../../shared/conversation'
import type { TurnSnapshotUnavailableReason } from '../../shared/turn-snapshots'
import { canonicalCwd, tryAcquireCwdActivity } from '../cwd-activity-coordinator'
import { isBotMode } from '../fleet/instance/config'
import { getAppFlag, setAppFlag } from '../store'
import { captureTree, type CaptureResult } from './capture'
import { rootChanges, summarize, toFileChange } from './changes'
import { recordRef } from './gc'
import { snapshotGitAvailable } from './git'
import { insertSnapshotRecord, updateSnapshotRecord, type SnapshotRoot } from './records'
import { resolveSnapshotDir, SnapshotUnavailableError, type SnapshotDir } from './store'

/**
 * Turn boundaries. A turn's folders are captured when it is admitted, in parallel with the rest of admission, and
 * the turn waits for that capture only briefly before its runtime starts. The end capture is queued when the turn
 * finishes and never delays it; each store's queue keeps it ahead of the next turn's start capture.
 */

export const TURN_SNAPSHOTS_FLAG = 'chat.turnSnapshots'
/** How long a turn waits for its start capture; a slower folder makes the turn run without a snapshot. */
export const START_CAPTURE_BUDGET_MS = 4_000

let initialized = false
let notify: (conversationId: string) => void = () => undefined

export function configureTurnSnapshotLifecycle(opts: { notify: (conversationId: string) => void }): void {
  initialized = true
  notify = opts.notify
}

export function resetTurnSnapshotLifecycleForTests(): void {
  initialized = false
  notify = () => undefined
  activeByFolder.clear()
  warmed.clear()
}

export function turnSnapshotsEnabled(): boolean {
  return getAppFlag(TURN_SNAPSHOTS_FLAG, true)
}

export function setTurnSnapshotsEnabled(enabled: boolean): void {
  setAppFlag(TURN_SNAPSHOTS_FLAG, enabled)
}

export function notifyTurnSnapshotsChanged(conversationId: string): void {
  try {
    notify(conversationId)
  } catch {
    // A closed window must not fail the operation that changed the snapshots.
  }
}

export interface TurnFolder {
  path: string
  label?: string
}

/** The folders a conversation's tools can write: its own, plus each repository worktree of a multi-repository one. */
export function turnFolders(conversation: Conversation): TurnFolder[] {
  const folders: TurnFolder[] = [{ path: conversation.cwd }]
  if (conversation.scope === 'project' && conversation.isMulti && conversation.repos?.length) {
    for (const repo of conversation.repos) folders.push({ path: repo.worktreePath, label: repo.linkName })
  }
  return folders
}

interface ActiveTurn {
  conversationId: string
  folders: string[]
  overlap: Set<string>
}

/** Turns running now, by canonical folder, so a turn records which other conversations shared its folders. */
const activeByFolder = new Map<string, Set<ActiveTurn>>()

function registerActive(turn: ActiveTurn): void {
  for (const folder of turn.folders) {
    const turns = activeByFolder.get(folder) ?? new Set<ActiveTurn>()
    for (const other of turns) {
      if (other.conversationId === turn.conversationId) continue
      other.overlap.add(turn.conversationId)
      turn.overlap.add(other.conversationId)
    }
    turns.add(turn)
    activeByFolder.set(folder, turns)
  }
}

function unregisterActive(turn: ActiveTurn): void {
  for (const folder of turn.folders) {
    const turns = activeByFolder.get(folder)
    turns?.delete(turn)
    if (turns && !turns.size) activeByFolder.delete(folder)
  }
}

/** Other conversations with a turn running in any of these folders now. */
export function conversationsRunningIn(folders: readonly string[], except: string): string[] {
  const ids = new Set<string>()
  for (const folder of folders) {
    for (const turn of activeByFolder.get(canonicalCwd(folder)) ?? []) {
      if (turn.conversationId !== except) ids.add(turn.conversationId)
    }
  }
  return [...ids]
}

function unavailableReason(error: unknown): TurnSnapshotUnavailableReason {
  return error instanceof SnapshotUnavailableError ? error.reason : 'failed'
}

function logFailure(stage: string, error: unknown): void {
  if (error instanceof SnapshotUnavailableError) return
  console.warn(`[turn-snapshots] ${stage} capture failed:`, error instanceof Error ? error.message : error)
}

export interface TurnSnapshotHandle {
  readonly recordId: string
  /** Records the snapshot under the turn's user message, waiting briefly for the start capture. */
  attach(userMessageId: string): Promise<void>
  /** Queues the end capture; returns at once. Safe to call more than once. */
  end(assistantMessageId: string | null): void
  /**
   * Called when admission returns: a turn that never stored its message is forgotten without a record. An attached
   * turn is left alone, since it is still running; its end comes from the turn itself.
   */
  abandon(): void
}

export interface BeginTurnSnapshotInput {
  conversation: Conversation
  /** A bot command drives this turn (see the bot turn note in the docs). */
  botTurn?: boolean
}

interface StartedRoot {
  dir: SnapshotDir
  folder: TurnFolder
  capture: CaptureResult
}

/** Starts a turn's snapshot, or returns null when this turn is not snapshotted. Never throws. */
export function beginTurnSnapshot(input: BeginTurnSnapshotInput): TurnSnapshotHandle | null {
  try {
    // Bots run long autonomous routines that no transcript here can undo, and their environment's volume holds the
    // stores; their turns are left out.
    if (!initialized || input.botTurn || isBotMode() || !turnSnapshotsEnabled()) return null
  } catch {
    return null
  }
  const conversation = input.conversation
  const recordId = randomUUID()
  const startedAt = Date.now()
  const folders = turnFolders(conversation)
  const active: ActiveTurn = {
    conversationId: conversation.id,
    folders: folders.map((folder) => canonicalCwd(folder.path)),
    overlap: new Set(),
  }
  registerActive(active)

  const start: Promise<StartedRoot[]> = (async () => {
    if (!(await snapshotGitAvailable())) throw new SnapshotUnavailableError('git-missing')
    return Promise.all(
      folders.map(async (folder, index) => {
        const dir = await resolveSnapshotDir(folder.path)
        const capture = await captureTree(dir, { ref: recordRef(recordId, `start-${index}`) })
        return { dir, folder, capture }
      })
    )
  })()
  start.catch((error) => logFailure('start', error))

  let attached: { roots: StartedRoot[] } | { reason: TurnSnapshotUnavailableReason } | null = null
  let claimed = false
  let ended = false

  const finishUnavailable = (reason: TurnSnapshotUnavailableReason, assistantMessageId: string | null) => {
    updateSnapshotRecord(recordId, {
      status: 'unavailable',
      unavailableReason: reason,
      assistantMessageId,
      overlap: [...active.overlap],
      endedAt: Date.now(),
    })
    notifyTurnSnapshotsChanged(conversation.id)
  }

  return {
    recordId,
    async attach(userMessageId) {
      if (claimed || ended) return
      claimed = true
      let timer: NodeJS.Timeout | undefined
      const budget = new Promise<'slow'>((resolve) => {
        timer = setTimeout(() => resolve('slow'), START_CAPTURE_BUDGET_MS)
        timer.unref?.()
      })
      // A late start capture could already hold the agent's first changes, so it is never used for this turn.
      const outcome = await Promise.race([
        start.then(
          (roots) => ({ roots }),
          (error: unknown) => ({ reason: unavailableReason(error) })
        ),
        budget.then(() => ({ reason: 'slow' as const })),
      ])
      clearTimeout(timer)
      attached = outcome
      const roots: SnapshotRoot[] =
        'roots' in outcome
          ? outcome.roots.map(({ dir, folder, capture }) => ({
              storeKey: dir.store.key,
              dirKey: dir.dirKey,
              path: dir.workTree,
              ...(folder.label ? { label: folder.label } : {}),
              startTree: capture.tree,
              endTree: null,
              startSkipped: capture.skipped,
              endSkipped: [],
            }))
          : []
      try {
        insertSnapshotRecord({
          id: recordId,
          conversationId: conversation.id,
          userMessageId,
          assistantMessageId: null,
          status: 'roots' in outcome ? 'capturing' : 'unavailable',
          unavailableReason: 'roots' in outcome ? null : outcome.reason,
          roots,
          summary: null,
          overlap: [],
          revert: null,
          startedAt,
          endedAt: null,
        })
      } catch (error) {
        console.warn('[turn-snapshots] Could not record the turn:', error instanceof Error ? error.message : error)
        attached = { reason: 'failed' }
      }
    },
    end(assistantMessageId) {
      if (ended) return
      ended = true
      unregisterActive(active)
      const state = attached
      if (!state) return
      if ('reason' in state) return finishUnavailable(state.reason, assistantMessageId)
      // The turn's own lease is released right after this call; this one keeps branch moves and migrations out of
      // the folder until the end capture is done.
      const release = tryAcquireCwdActivity(conversation.cwd, 'chat')
      void (async () => {
        try {
          if (!release) throw new SnapshotUnavailableError('failed', 'The folder is locked')
          const roots: SnapshotRoot[] = []
          const files = []
          for (const [index, started] of state.roots.entries()) {
            if (!existsSync(started.dir.workTree)) throw new SnapshotUnavailableError('not-a-directory')
            const capture = await captureTree(started.dir, { ref: recordRef(recordId, `end-${index}`) })
            const root: SnapshotRoot = {
              storeKey: started.dir.store.key,
              dirKey: started.dir.dirKey,
              path: started.dir.workTree,
              ...(started.folder.label ? { label: started.folder.label } : {}),
              startTree: started.capture.tree,
              endTree: capture.tree,
              startSkipped: started.capture.skipped,
              endSkipped: capture.skipped,
            }
            roots.push(root)
            for (const change of await rootChanges(started.dir.store, root)) files.push(toFileChange(index, change))
          }
          updateSnapshotRecord(recordId, {
            status: 'ready',
            unavailableReason: null,
            roots,
            summary: summarize(files),
            assistantMessageId,
            overlap: [...active.overlap],
            endedAt: Date.now(),
          })
          notifyTurnSnapshotsChanged(conversation.id)
        } catch (error) {
          logFailure('end', error)
          finishUnavailable(unavailableReason(error), assistantMessageId)
        } finally {
          release?.()
        }
      })()
    },
    abandon() {
      if (ended || claimed) return
      ended = true
      unregisterActive(active)
    },
  }
}

const warmed = new Map<string, number>()
const WARM_INTERVAL_MS = 10 * 60_000

/**
 * Builds a folder's index ahead of its first turn, so that turn's start capture is incremental. Runs after the
 * store's queued work, only when snapshots are on and no turn of the conversation runs.
 */
export function warmTurnSnapshots(conversation: Conversation, running: boolean): void {
  if (!initialized || running || isBotMode()) return
  try {
    if (!turnSnapshotsEnabled()) return
  } catch {
    return
  }
  const now = Date.now()
  for (const folder of turnFolders(conversation)) {
    const key = canonicalCwd(folder.path)
    if (now - (warmed.get(key) ?? 0) < WARM_INTERVAL_MS) continue
    warmed.set(key, now)
    const timer = setTimeout(() => {
      void (async () => {
        if (!(await snapshotGitAvailable())) return
        const dir = await resolveSnapshotDir(folder.path)
        if (existsSync(dir.store.indexPath(dir.dirKey))) return
        await captureTree(dir)
      })().catch((error) => logFailure('warm-up', error))
    }, 1_500)
    timer.unref?.()
  }
}
