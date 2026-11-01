import type { TurnChangeTotals, TurnFileChange } from '../../shared/turn-snapshots'
import type { SkippedFile } from './capture'
import type { SnapshotRoot, StoredSummary } from './records'
import type { ShadowStore } from './store'
import { diffTrees, treeEntries } from './tree'

/**
 * What a path held at a snapshot: nothing, a captured entry, or a file too large to capture (known only by its size
 * and time). A turn's changes are the paths whose state differs between its start and end snapshots.
 */
export type PathState =
  | { kind: 'absent' }
  | { kind: 'entry'; mode: string; oid: string }
  | { kind: 'large'; size: number; mtimeMs: number }

export const ABSENT: PathState = { kind: 'absent' }

export function sameState(a: PathState, b: PathState): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'entry' && b.kind === 'entry') return a.mode === b.mode && a.oid === b.oid
  if (a.kind === 'large' && b.kind === 'large') return a.size === b.size && a.mtimeMs === b.mtimeMs
  return true
}

export interface PathChange {
  path: string
  start: PathState
  end: PathState
  additions: number
  deletions: number
  binary: boolean
}

function largeState(file: SkippedFile): PathState {
  return { kind: 'large', size: file.size, mtimeMs: file.mtimeMs }
}

/** The state of each path at a snapshot, from its tree entries and the files it skipped. */
export async function statesAt(
  store: ShadowStore,
  tree: string,
  skipped: readonly SkippedFile[],
  paths: readonly string[]
): Promise<Map<string, PathState>> {
  const large = new Map(skipped.map((file) => [file.path, file]))
  const entries = await treeEntries(store, tree, paths)
  const states = new Map<string, PathState>()
  for (const file of paths) {
    const entry = entries.get(file)
    const skippedFile = large.get(file)
    states.set(
      file,
      entry ? { kind: 'entry', mode: entry.mode, oid: entry.oid } : skippedFile ? largeState(skippedFile) : ABSENT
    )
  }
  return states
}

/** Every path a turn changed in one folder, start against end. */
export async function rootChanges(store: ShadowStore, root: SnapshotRoot): Promise<PathChange[]> {
  if (!root.startTree || !root.endTree) return []
  const byPath = new Map<string, PathChange>()
  for (const change of await diffTrees(store, root.startTree, root.endTree)) {
    byPath.set(change.path, {
      path: change.path,
      start: change.from ? { kind: 'entry', ...change.from } : ABSENT,
      end: change.to ? { kind: 'entry', ...change.to } : ABSENT,
      additions: change.additions,
      deletions: change.deletions,
      binary: change.binary,
    })
  }
  // A path missing from a tree may still have existed, too large to capture.
  const startLarge = new Map(root.startSkipped.map((file) => [file.path, file]))
  const endLarge = new Map(root.endSkipped.map((file) => [file.path, file]))
  for (const [file, skipped] of startLarge) {
    const change = byPath.get(file)
    if (change) change.start = largeState(skipped)
  }
  for (const [file, skipped] of endLarge) {
    const change = byPath.get(file)
    if (change) change.end = largeState(skipped)
  }
  const unknown = [...new Set([...startLarge.keys(), ...endLarge.keys()])].filter((file) => !byPath.has(file))
  if (unknown.length) {
    const [starts, ends] = await Promise.all([
      statesAt(store, root.startTree, root.startSkipped, unknown),
      statesAt(store, root.endTree, root.endSkipped, unknown),
    ])
    for (const file of unknown) {
      const start = starts.get(file) ?? ABSENT
      const end = ends.get(file) ?? ABSENT
      if (!sameState(start, end)) byPath.set(file, { path: file, start, end, additions: 0, deletions: 0, binary: true })
    }
  }
  for (const [file, change] of byPath) if (sameState(change.start, change.end)) byPath.delete(file)
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function toFileChange(root: number, change: PathChange): TurnFileChange {
  return {
    root,
    path: change.path,
    status: change.start.kind === 'absent' ? 'added' : change.end.kind === 'absent' ? 'deleted' : 'modified',
    additions: change.additions,
    deletions: change.deletions,
    binary: change.binary,
    ...(change.start.kind === 'large' || change.end.kind === 'large' ? { large: true } : {}),
  }
}

export const SUMMARY_FILE_LIMIT = 1000

export function summarize(changes: readonly TurnFileChange[]): StoredSummary {
  const totals: TurnChangeTotals = { files: changes.length, additions: 0, deletions: 0 }
  for (const change of changes) {
    totals.additions += change.additions
    totals.deletions += change.deletions
  }
  return { files: changes.slice(0, SUMMARY_FILE_LIMIT), totals, truncated: changes.length > SUMMARY_FILE_LIMIT }
}
