import { resolveReviewConflicts, type ResolveConflictsOpts } from './conflict-resolver'
import { getReviewData } from './gh-service'
import type { IpcRegistrar } from './ipc-registrar'

export function registerReviewIpc(reg: IpcRegistrar): void {
  // Read-only Review data: conversation branch diff, PR, checks, and comments through gh CLI.
  reg.handle('review:get', (_e, convId: string) => getReviewData(convId))
  // AI conflict resolution mutates the worktree through a worker. Register with guarded mhandle and the
  // trusted Review panel allowlist.
  reg.mhandle('review:resolve-conflicts', (_e, convId: string, opts: ResolveConflictsOpts) =>
    resolveReviewConflicts(convId, opts)
  )
}
