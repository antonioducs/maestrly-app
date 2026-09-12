/** Counts of app-owned local data. Repositories and worktrees are excluded. */
export interface LocalDataSummary {
  workspaces: number
  conversations: number
}

export type ExportResult =
  | { ok: true; path: string; incomplete: boolean; omissions: string[] }
  | { ok: false; canceled?: boolean; error?: string }

export type LocalDataResetResult = { ok: true } | { ok: false; error: string }
