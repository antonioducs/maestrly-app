import { runGhCommand } from './gh-command'
import type { RepositoryScope } from './repository-scope'

export type GhReadOperation =
  | 'repo-view'
  | 'pr-list'
  | 'pr-view'
  | 'pr-diff'
  | 'pr-checks'
  | 'pr-status'
  | 'issue-list'
  | 'issue-view'
  | 'run-list'
  | 'run-view'
  | 'workflow-list'
  | 'workflow-view'
  | 'release-list'
  | 'release-view'
  | 'search-issues'
  | 'search-prs'
  | 'search-code'
  | 'search-commits'
  | 'search-repos'
  | 'api-get'

export interface GhReadInput {
  operation: GhReadOperation
  repo?: string
  number?: number
  id?: string | number
  query?: string
  endpoint?: string
  limit?: number
}

export interface GhReadResult {
  operation: GhReadOperation
  repo: string
  data: unknown
  truncated: boolean
}

const GLOBAL_OPERATIONS = new Set<GhReadOperation>([
  'search-issues',
  'search-prs',
  'search-code',
  'search-commits',
  'search-repos',
  'api-get',
])

const MAX_OUTPUT_CHARS = 1_000_000
const JSON_FIELDS = {
  'repo-view': 'nameWithOwner,description,url,defaultBranchRef,isPrivate,viewerPermission',
  'pr-list': 'number,title,state,isDraft,author,headRefName,baseRefName,url,updatedAt',
  'pr-view':
    'number,title,state,isDraft,author,body,headRefName,baseRefName,url,mergeable,reviewDecision,statusCheckRollup',
  'pr-checks': 'name,state,bucket,link,workflow',
  'issue-list': 'number,title,state,author,labels,assignees,url,updatedAt',
  'issue-view': 'number,title,state,author,body,labels,assignees,comments,url,updatedAt',
  'run-list': 'databaseId,name,workflowName,status,conclusion,event,headBranch,url,createdAt,updatedAt',
  'run-view': 'databaseId,name,workflowName,status,conclusion,event,headBranch,url,jobs,createdAt,updatedAt',
  'workflow-list': 'id,name,state,path',
  'release-list': 'name,tagName,isDraft,isPrerelease,publishedAt,url',
} as const

function limit(value: number | undefined): number {
  return Number.isInteger(value) && value! > 0 && value! <= 100 ? value! : 30
}

function requiredPositive(value: number | undefined, label: string): string {
  if (!Number.isInteger(value) || value! <= 0) throw new Error(`Invalid ${label}.`)
  return String(value)
}

function safeId(value: string | number | undefined, label: string): string {
  const id = String(value ?? '')
  if (!id || id.startsWith('-') || /[\0\r\n]/.test(id)) throw new Error(`Invalid ${label}.`)
  return id
}

function searchArgs(kind: string, input: GhReadInput): string[] {
  if (!input.query?.trim() || input.query.trim().startsWith('-') || /[\0\r\n]/.test(input.query))
    throw new Error('query is required and must be a single line.')
  const fields: Record<string, string> = {
    issues: 'number,title,state,url,repository,updatedAt,isPullRequest',
    prs: 'number,title,state,url,repository,updatedAt,isDraft',
    code: 'path,repository,sha,textMatches,url',
    commits: 'sha,commit,author,committer,repository,url',
    repos: 'name,fullName,owner,description,visibility,updatedAt,url',
  }
  return ['search', kind, input.query, '--limit', String(limit(input.limit)), '--json', fields[kind]]
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value).length
}

function boundedJsonString(value: string, maxChars: number): string {
  const marker = '… [JSON truncado]'
  let low = 0
  let high = value.length
  while (low < high) {
    const length = Math.ceil((low + high) / 2)
    if (jsonSize(`${value.slice(0, length)}${marker}`) <= maxChars) low = length
    else high = length - 1
  }
  const bounded = `${value.slice(0, low)}${marker}`
  return jsonSize(bounded) <= maxChars ? bounded : ''
}

function boundJsonValue(value: unknown, maxChars: number): unknown {
  if (jsonSize(value) <= maxChars) return value
  if (typeof value === 'string') return boundedJsonString(value, maxChars)
  if (Array.isArray(value)) {
    const bounded: unknown[] = []
    let used = 2
    for (const item of value) {
      const separator = bounded.length > 0 ? 1 : 0
      const available = maxChars - used - separator
      if (available <= 0) break
      const boundedItem = boundJsonValue(item, available)
      const itemSize = jsonSize(boundedItem)
      if (separator + itemSize > maxChars - used) break
      bounded.push(boundedItem)
      used += separator + itemSize
    }
    return bounded
  }
  if (value !== null && typeof value === 'object') {
    const bounded: Record<string, unknown> = {}
    let used = 2
    for (const [key, item] of Object.entries(value)) {
      const separator = Object.keys(bounded).length > 0 ? 1 : 0
      const keySize = jsonSize(key)
      const available = maxChars - used - separator - keySize - 1
      if (available <= 0) continue
      const boundedItem = boundJsonValue(item, available)
      const itemSize = jsonSize(boundedItem)
      const entrySize = separator + keySize + 1 + itemSize
      if (entrySize > maxChars - used) continue
      bounded[key] = boundedItem
      used += entrySize
    }
    return bounded
  }
  return value
}

/** Structured gh surface: every emitted subcommand is a known read operation. */
export async function ghRead(scope: RepositoryScope, input: GhReadInput, signal?: AbortSignal): Promise<GhReadResult> {
  const globalOperation = GLOBAL_OPERATIONS.has(input.operation)
  // Global searches/API do not derive their GitHub target from the local repository. In multi-repo mode,
  // use the first authorized worktree only as a harmless cwd for `gh`; an explicitly supplied repo is still
  // validated so callers cannot smuggle an arbitrary local path through this branch.
  const repository =
    globalOperation && scope.isMulti && !input.repo ? scope.repositories[0] : scope.resolveRepository(input.repo)
  if (!repository) throw new Error('The conversation has no local repository for running GitHub CLI.')
  const cwd = repository.realWorktreePath
  const n = () => requiredPositive(input.number, 'number')
  const id = () => safeId(input.id, 'id')
  let args: string[]
  let json = true

  switch (input.operation) {
    case 'repo-view':
      args = ['repo', 'view', '--json', JSON_FIELDS['repo-view']]
      break
    case 'pr-list':
      args = ['pr', 'list', '--limit', String(limit(input.limit)), '--json', JSON_FIELDS['pr-list']]
      break
    case 'pr-view':
      args = ['pr', 'view', n(), '--json', JSON_FIELDS['pr-view']]
      break
    case 'pr-diff':
      args = ['pr', 'diff', n(), '--color', 'never']
      json = false
      break
    case 'pr-checks':
      args = ['pr', 'checks', n(), '--json', JSON_FIELDS['pr-checks']]
      break
    case 'pr-status':
      args = ['pr', 'status', '--json', 'currentBranch,createdBy,needsReview']
      break
    case 'issue-list':
      args = ['issue', 'list', '--limit', String(limit(input.limit)), '--json', JSON_FIELDS['issue-list']]
      break
    case 'issue-view':
      args = ['issue', 'view', n(), '--json', JSON_FIELDS['issue-view']]
      break
    case 'run-list':
      args = ['run', 'list', '--limit', String(limit(input.limit)), '--json', JSON_FIELDS['run-list']]
      break
    case 'run-view':
      args = ['run', 'view', id(), '--json', JSON_FIELDS['run-view']]
      break
    case 'workflow-list':
      args = ['workflow', 'list', '--limit', String(limit(input.limit)), '--json', JSON_FIELDS['workflow-list']]
      break
    case 'workflow-view':
      args = ['workflow', 'view', id(), '--yaml']
      json = false
      break
    case 'release-list':
      args = ['release', 'list', '--limit', String(limit(input.limit)), '--json', JSON_FIELDS['release-list']]
      break
    case 'release-view':
      args = ['release', 'view', id(), '--json', 'name,tagName,body,isDraft,isPrerelease,publishedAt,url,assets']
      break
    case 'search-issues':
      args = searchArgs('issues', input)
      break
    case 'search-prs':
      args = searchArgs('prs', input)
      break
    case 'search-code':
      args = searchArgs('code', input)
      break
    case 'search-commits':
      args = searchArgs('commits', input)
      break
    case 'search-repos':
      args = searchArgs('repos', input)
      break
    case 'api-get': {
      const endpoint = input.endpoint?.trim() ?? ''
      if (!endpoint || endpoint.startsWith('-') || endpoint.includes('://') || /[\0\r\n]/.test(endpoint))
        throw new Error('Invalid GitHub API endpoint.')
      args = ['api', '--method', 'GET', endpoint]
      break
    }
    default:
      throw new Error('Unauthorized read-only gh operation.')
  }

  await runGhCommand(cwd, ['auth', 'status'], { signal, timeoutMs: 10_000 })
  const stdout = await runGhCommand(cwd, args, { signal })
  let truncated = stdout.length > MAX_OUTPUT_CHARS
  let data: unknown = stdout
  if (json) {
    try {
      data = JSON.parse(stdout)
    } catch {
      throw new Error(`gh ${input.operation} returned invalid JSON.`)
    }
    if (jsonSize(data) > MAX_OUTPUT_CHARS) {
      data = boundJsonValue(data, MAX_OUTPUT_CHARS)
      truncated = true
    }
  } else if (truncated) {
    data = stdout.slice(0, MAX_OUTPUT_CHARS)
  }
  return { operation: input.operation, repo: repository.linkName, data, truncated }
}
