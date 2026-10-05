import { z } from 'zod'
import type { ProjectSetupPhase } from './project-setup'

/**
 * Workspace creation from a chat: clone a remote (GitHub or any git URL) or create a new local project in the
 * configured projects directory, register it as a workspace and hand its id to start_conversations. Shared by
 * main, preload and the renderer card; privileged validation stays in main.
 */

export const WORKSPACE_CREATION_MAX_REQUEST_KEY = 120
/** Hard bound per message, against a runaway agent; the person can always ask again. */
export const WORKSPACE_CREATION_MAX_PER_TURN = 10

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/

export function isGithubRepositorySlug(value: string): boolean {
  return GITHUB_REPOSITORY.test(value.trim())
}

export type WorkspaceCreationSourceKind = 'github' | 'git' | 'new'
export type GithubRepositoryVisibility = 'private' | 'public'

export const workspaceCreationSourceSchema = z
  .object({
    kind: z
      .enum(['github', 'git', 'new'])
      .describe('"github": clone owner/name from GitHub. "git": clone any git URL. "new": create an empty local project.'),
    repo: z
      .string()
      .trim()
      .regex(GITHUB_REPOSITORY, 'Use the GitHub owner/name form.')
      .optional()
      .describe('kind "github" only: canonical owner/name, e.g. from find_github_repositories.'),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe('kind "git" only: clone URL exactly as the person gave it, without embedded credentials.'),
    github: z
      .object({
        create: z.boolean().describe('true to create the GitHub repository and push the new project to it.'),
        owner: z
          .string()
          .trim()
          .regex(GITHUB_OWNER, 'Invalid GitHub owner.')
          .optional()
          .describe('User or organization; defaults to the signed-in gh account.'),
        visibility: z
          .enum(['private', 'public'])
          .optional()
          .describe('Defaults to private. Public only when the person wants it; the app asks them to confirm.'),
      })
      .strict()
      .optional()
      .describe('kind "new" only, and only when the person asked for a GitHub repository for the new project.'),
  })
  .strict()

export type WorkspaceCreationSource = z.infer<typeof workspaceCreationSourceSchema>

/** The GitHub repository requested for a new project, if any. */
export function requestedGithubRepository(source: WorkspaceCreationSource): WorkspaceCreationSource['github'] {
  return source.kind === 'new' && source.github?.create ? source.github : undefined
}

export const createWorkspaceInputSchema = z
  .object({
    requestKey: z
      .string()
      .trim()
      .min(1)
      .max(WORKSPACE_CREATION_MAX_REQUEST_KEY)
      .regex(/^[\w.:/#@-]+$/, 'Use letters, digits and . : / # @ - _ only.')
      .describe('Stable key for this project (e.g. owner/name). Reusing it replays instead of creating again.'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('Folder and workspace name. Required for "new"; defaults to the repository name when cloning.'),
    source: workspaceCreationSourceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const { source } = value
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message })
    if (source.kind === 'github' && !source.repo) issue(['source', 'repo'], 'kind "github" requires repo (owner/name).')
    if (source.kind === 'git' && !source.url) issue(['source', 'url'], 'kind "git" requires url.')
    if (source.kind === 'new' && !value.name) issue(['name'], 'kind "new" requires a project name.')
    if (source.kind !== 'github' && source.repo) issue(['source', 'repo'], 'repo is only valid with kind "github".')
    if (source.kind !== 'git' && source.url) issue(['source', 'url'], 'url is only valid with kind "git".')
    if (source.kind !== 'new' && source.github)
      issue(['source', 'github'], 'github.create is only valid with kind "new".')
  })

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>

export const findGithubRepositoriesInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Repository name, part of it, or an exact owner/name.'),
    owner: z
      .string()
      .trim()
      .regex(GITHUB_OWNER, 'Invalid GitHub owner.')
      .optional()
      .describe('User or organization to list; defaults to the signed-in gh account.'),
  })
  .strict()

export type FindGithubRepositoriesInput = z.infer<typeof findGithubRepositoriesInputSchema>

export interface GithubRepositoryOption {
  nameWithOwner: string
  url: string
  defaultBranch: string | null
  visibility: string
  description: string | null
}

export type WorkspaceCreationErrorCode =
  | 'unavailable'
  | 'not-confirmed'
  | 'count-exceeded'
  | 'source-unsupported'
  | 'invalid-request'
  | 'request-conflict'
  | 'projects-directory-not-set'
  | 'projects-directory-missing'
  | 'destination-exists'
  | 'workspace-removed'
  | 'github-unavailable'
  | 'setup-failed'
  | 'cancelled'
  | 'persistence-failed'

/** Codes the card answers with the "Set projects folder" action. */
export const PROJECTS_DIRECTORY_ERROR_CODES: readonly WorkspaceCreationErrorCode[] = [
  'projects-directory-not-set',
  'projects-directory-missing',
]

export interface WorkspaceCreationRemoteStatus {
  status: 'created' | 'failed'
  url?: string
  error?: string
}

/** Outcome returned to the agent and rendered by the chat card. */
export interface WorkspaceCreationResult {
  ok: boolean
  requestKey?: string
  code?: WorkspaceCreationErrorCode
  error?: string
  source?: { kind: WorkspaceCreationSourceKind; label: string }
  workspaceId?: string
  name?: string
  path?: string
  defaultBranch?: string
  remoteUrl?: string
  /** The project already existed at the destination with the same remote and was registered as is. */
  reused?: boolean
  /** Replay of a result already recorded for the same request. */
  replayed?: boolean
  /** GitHub repository requested for a new project; the local workspace stays registered when it fails. */
  remote?: WorkspaceCreationRemoteStatus
}

/** Live progress of a creation, keyed by the source conversation and the request key of the tool input. */
export interface WorkspaceCreationProgress {
  conversationId: string
  requestKey: string
  phase: ProjectSetupPhase | 'creating-remote'
  percent?: number
  path?: string
}

const SOURCE_KINDS = new Set<WorkspaceCreationSourceKind>(['github', 'git', 'new'])

/** Parse the JSON output of create_workspace for display; null when it is not a recognizable result. */
export function parseWorkspaceCreationResult(text: string): WorkspaceCreationResult | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.ok !== 'boolean') return null
  const string = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : undefined)
  const source = record.source as Record<string, unknown> | undefined
  const remote = record.remote as Record<string, unknown> | undefined
  const result: WorkspaceCreationResult = { ok: record.ok }
  for (const key of ['requestKey', 'error', 'workspaceId', 'name', 'path', 'defaultBranch', 'remoteUrl'] as const) {
    const field = string(key)
    if (field) result[key] = field
  }
  const code = string('code')
  if (code) result.code = code as WorkspaceCreationErrorCode
  if (
    source &&
    typeof source === 'object' &&
    SOURCE_KINDS.has(source.kind as WorkspaceCreationSourceKind) &&
    typeof source.label === 'string'
  )
    result.source = { kind: source.kind as WorkspaceCreationSourceKind, label: source.label }
  if (record.reused === true) result.reused = true
  if (record.replayed === true) result.replayed = true
  if (remote && typeof remote === 'object' && (remote.status === 'created' || remote.status === 'failed')) {
    result.remote = {
      status: remote.status,
      ...(typeof remote.url === 'string' ? { url: remote.url } : {}),
      ...(typeof remote.error === 'string' ? { error: remote.error } : {}),
    }
  }
  return result
}

/**
 * Comparable form of a git remote: `git@github.com:Owner/Repo.git`, `https://github.com/owner/repo` and
 * `ssh://git@github.com/owner/repo.git` are the same repository. GitHub paths are case-insensitive; other
 * hosts and local paths keep their case.
 */
export function comparableGitRemote(remote: string): string {
  const value = remote.trim()
  let host = ''
  let pathname = value
  const scp = /^[^\s/@:]+@([^\s/:]+):(.+)$/.exec(value)
  if (scp) {
    host = scp[1]
    pathname = scp[2]
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (url.protocol === 'file:') pathname = decodeURIComponent(url.pathname)
      else {
        host = url.host
        pathname = url.pathname
      }
    } catch {
      return value
    }
  }
  pathname = pathname
    .replace(/[\\/]+$/, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+/, host ? '' : '/')
  host = host.toLowerCase()
  if (host === 'github.com' || host === 'www.github.com') return `github.com/${pathname.toLowerCase()}`
  return host ? `${host}/${pathname}` : pathname
}

export function sameGitRemote(a: string, b: string): boolean {
  return comparableGitRemote(a) === comparableGitRemote(b)
}
