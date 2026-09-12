import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Conversation } from './store/conversations'

export class RepositoryScopeError extends Error {
  constructor(
    readonly code: 'no_repository' | 'repo_required' | 'repo_not_found' | 'invalid_path' | 'path_escape',
    message: string
  ) {
    super(message)
    this.name = 'RepositoryScopeError'
  }
}

/** Public selector advertised for the single-repository external capability. */
export const SINGLE_REPOSITORY_SELECTOR = 'repository'

export interface ScopedRepository {
  /** Stable selector exposed to callers. Empty only for a single-repository conversation. */
  linkName: string
  worktreePath: string
  realWorktreePath: string
  branch: string
  base: string
}

export interface ResolvedRepositoryPath {
  repository: ScopedRepository
  /** Lexical path relative to the repository, preserved for Git pathspecs. */
  relativePath: string
  /** Canonical target that passed the repository jail validation, used for filesystem reads. */
  absolutePath: string
}

export interface RepositoryScope {
  readonly repositories: readonly ScopedRepository[]
  readonly isMulti: boolean
  resolveRepository(linkName?: string): ScopedRepository
  resolvePath(linkName: string | undefined, relativePath?: string): Promise<ResolvedRepositoryPath>
  resolveBridgePath(relativePath: string): Promise<ResolvedRepositoryPath>
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

async function canonicalTarget(root: string, absolutePath: string): Promise<string> {
  let candidate = absolutePath
  for (;;) {
    try {
      const real = await fs.realpath(candidate)
      const suffix = path.relative(candidate, absolutePath)
      return path.resolve(real, suffix)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = path.dirname(candidate)
      if (parent === candidate || !isInside(root, parent)) throw error
      candidate = parent
    }
  }
}

/** Builds the only repository roots authorized by the persisted conversation record. */
export async function createRepositoryScope(conversation: Conversation): Promise<RepositoryScope> {
  const configured = conversation.isMulti
    ? (conversation.repos ?? []).map((repo) => ({
        linkName: repo.linkName,
        worktreePath: repo.worktreePath,
        branch: repo.branch,
        base: repo.base || 'origin/main',
      }))
    : [{ linkName: '', worktreePath: conversation.cwd, branch: conversation.branch, base: 'origin/main' }]

  if (configured.length === 0 || configured.some((repo) => !repo.worktreePath)) {
    throw new RepositoryScopeError('no_repository', 'The conversation has no valid persisted repository.')
  }
  if (conversation.isMulti) {
    const names = new Set<string>()
    for (const repo of configured) {
      if (!repo.linkName || names.has(repo.linkName)) {
        throw new RepositoryScopeError(
          'no_repository',
          'The multi-repository conversation has a missing or duplicate linkName.'
        )
      }
      names.add(repo.linkName)
    }
  }

  const repositories = await Promise.all(
    configured.map(async (repo) => ({ ...repo, realWorktreePath: await fs.realpath(repo.worktreePath) }))
  )
  const publicRepositoryIds = conversation.isMulti
    ? repositories.map((repo) => repo.linkName)
    : [SINGLE_REPOSITORY_SELECTOR]

  const resolveRepository = (linkName?: string): ScopedRepository => {
    if (conversation.isMulti && !linkName) {
      throw new RepositoryScopeError(
        'repo_required',
        `Specify repo using an ID returned by list_external_capabilities: ${publicRepositoryIds.join(', ')}.`
      )
    }
    const selected = conversation.isMulti
      ? repositories.find((repo) => repo.linkName === linkName)
      : !linkName || linkName === repositories[0].linkName || linkName === SINGLE_REPOSITORY_SELECTOR
        ? repositories[0]
        : undefined
    if (!selected) {
      const singleHint = conversation.isMulti
        ? ''
        : ' For a single-repository conversation, use "repository" or omit repo.'
      throw new RepositoryScopeError(
        'repo_not_found',
        `Unauthorized repository: ${linkName ?? ''}. The repo field only accepts an ID returned by ` +
          `list_external_capabilities (${publicRepositoryIds.join(', ')}), not owner/repo.${singleHint}`
      )
    }
    return selected
  }

  const resolvePath = async (linkName: string | undefined, relativePath = ''): Promise<ResolvedRepositoryPath> => {
    const repository = resolveRepository(linkName)
    if (relativePath.includes('\0') || path.isAbsolute(relativePath)) {
      throw new RepositoryScopeError('invalid_path', 'The path must be relative to the repository.')
    }
    const absolutePath = path.resolve(repository.realWorktreePath, relativePath || '.')
    if (!isInside(repository.realWorktreePath, absolutePath)) {
      throw new RepositoryScopeError('path_escape', 'Path is outside the authorized repository.')
    }
    const realTarget = await canonicalTarget(repository.realWorktreePath, absolutePath)
    if (!isInside(repository.realWorktreePath, realTarget)) {
      throw new RepositoryScopeError(
        'path_escape',
        'Path escapes the authorized repository through a symlink/junction.'
      )
    }
    return {
      repository,
      relativePath: relativePath ? path.relative(repository.realWorktreePath, absolutePath) : '',
      absolutePath: realTarget,
    }
  }

  return {
    repositories,
    isMulti: conversation.isMulti === 1,
    resolveRepository,
    resolvePath,
    async resolveBridgePath(relativePath) {
      if (!conversation.isMulti) return resolvePath(undefined, relativePath)
      const normalized = relativePath.replaceAll('\\', '/')
      const slash = normalized.indexOf('/')
      const linkName = slash < 0 ? normalized : normalized.slice(0, slash)
      const insidePath = slash < 0 ? '' : normalized.slice(slash + 1)
      return resolvePath(linkName, insidePath)
    },
  }
}
