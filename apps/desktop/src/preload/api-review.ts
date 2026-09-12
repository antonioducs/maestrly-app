import { ipcRenderer } from 'electron'

export interface PrInfo {
  number: number
  title: string
  state: string
  isDraft: boolean
  reviewDecision: string
  mergeable: string
  mergeStateStatus: string
  baseRef: string
  url: string
  additions: number
  deletions: number
  changedFiles: number
}

export interface CheckInfo {
  name: string
  bucket: string
  state: string
  link: string
  workflow: string
}

export interface ReviewComment {
  kind: 'review' | 'comment' | 'inline'
  author: string
  body: string
  state?: string
  path?: string
  line?: number
  side?: string
  createdAt?: string
}

export type ReviewError = 'no-gh' | 'not-logged-in' | 'no-repo' | 'no-remote' | 'no-pr'

export interface ReviewData {
  repo: string | null
  branch: string
  pr: PrInfo | null
  diff: string
  diffSource: 'pr' | 'local'
  checks: CheckInfo[]
  comments: ReviewComment[]
  error?: ReviewError
}

export interface RepoReview extends ReviewData {
  linkName: string
  repoTop: string
}

export interface MultiReviewData {
  repos: RepoReview[]
}

export type ResolveConflictsStatus =
  | 'resolved'
  | 'no-pr'
  | 'not-conflicting'
  | 'unknown'
  | 'multi-repo-unsupported'
  | 'dirty'
  | 'cwd-locked'
  | 'agent-unavailable'
  | 'unresolved'
  | 'merge-incomplete'
  | 'not-pushed'
  | 'agent-failed'

export interface ResolveConflictsOpts {
  providerId?: string
  modelId?: string
  reasoning?: string
}

export interface ResolveConflictsResult {
  ok: boolean
  status: ResolveConflictsStatus
  reason?: string
}

export const reviewApi = {
  getReview: (convId: string): Promise<MultiReviewData> => ipcRenderer.invoke('review:get', convId),

  resolveConflicts: (convId: string, opts: ResolveConflictsOpts): Promise<ResolveConflictsResult> =>
    ipcRenderer.invoke('review:resolve-conflicts', convId, opts),
}
