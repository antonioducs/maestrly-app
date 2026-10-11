import os from 'node:os'
import { GhCommandError, runGhCommand } from './gh-command'
import { isGithubRepositorySlug, type GithubRepositoryOption } from '../shared/workspace-creation'

/**
 * GitHub repository discovery and creation through the person's signed-in `gh` CLI. Used by chats that create
 * workspaces; tokens never pass through the app (see runGhCommand).
 */

const FIELDS = 'nameWithOwner,url,defaultBranchRef,visibility,description'
const LIST_LIMIT = 200
const RESULT_LIMIT = 20

interface GhRepositoryJson {
  nameWithOwner?: unknown
  url?: unknown
  sshUrl?: unknown
  defaultBranchRef?: { name?: unknown } | null
  visibility?: unknown
  description?: unknown
}

type Run = (cwd: string, args: string[], options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>

function toOption(raw: GhRepositoryJson): GithubRepositoryOption | null {
  if (typeof raw.nameWithOwner !== 'string' || typeof raw.url !== 'string') return null
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    defaultBranch: typeof raw.defaultBranchRef?.name === 'string' ? raw.defaultBranchRef.name : null,
    visibility: typeof raw.visibility === 'string' ? raw.visibility.toLowerCase() : 'unknown',
    description: typeof raw.description === 'string' && raw.description ? raw.description : null,
  }
}

/** A message the agent can relay: what failed and what the person can do about it. */
export function githubErrorMessage(error: unknown): string {
  if (error instanceof GhCommandError) {
    if (error.kind === 'no-gh')
      return 'GitHub CLI (gh) is not installed. Ask the person to install it and run "gh auth login", or for the repository URL.'
    if (error.kind === 'not-logged-in')
      return 'GitHub CLI (gh) is not signed in. Ask the person to run "gh auth login", or for the repository URL.'
    if (error.kind === 'aborted') return 'The GitHub request was cancelled.'
    return `GitHub CLI failed: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

function rank(option: GithubRepositoryOption, query: string): number {
  const full = option.nameWithOwner.toLowerCase()
  const name = full.split('/').pop() ?? full
  if (name === query || full === query) return 0
  if (name.startsWith(query)) return 1
  if (full.includes(query)) return 2
  return option.description?.toLowerCase().includes(query) ? 3 : -1
}

export function createGithubRepositories(run: Run = runGhCommand) {
  const home = os.homedir()

  async function view(
    repo: string,
    signal?: AbortSignal
  ): Promise<{ option: GithubRepositoryOption; sshUrl: string | null }> {
    const raw = JSON.parse(
      await run(home, ['repo', 'view', repo, '--json', `${FIELDS},sshUrl`], { signal })
    ) as GhRepositoryJson
    const option = toOption(raw)
    if (!option) throw new Error(`GitHub returned no repository for ${repo}.`)
    return { option, sshUrl: typeof raw.sshUrl === 'string' ? raw.sshUrl : null }
  }

  /** Exact owner/name, or a name search over the repositories of `owner` (default: the signed-in account). */
  async function find(
    input: { query?: string; owner?: string },
    signal?: AbortSignal
  ): Promise<GithubRepositoryOption[]> {
    const query = input.query?.trim().toLowerCase() ?? ''
    if (query && isGithubRepositorySlug(query)) {
      try {
        return [(await view(input.query!.trim(), signal)).option]
      } catch (error) {
        if (error instanceof GhCommandError && error.kind === 'failed') return []
        throw error
      }
    }
    const args = ['repo', 'list', ...(input.owner ? [input.owner] : []), '--limit', String(LIST_LIMIT)]
    const raw = JSON.parse(await run(home, [...args, '--json', FIELDS], { signal, timeoutMs: 30_000 })) as unknown
    const options = (Array.isArray(raw) ? raw : [])
      .map((item) => toOption(item as GhRepositoryJson))
      .filter((option): option is GithubRepositoryOption => option !== null)
    if (!query) return options.slice(0, RESULT_LIMIT)
    return options
      .map((option) => ({ option, score: rank(option, query) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, RESULT_LIMIT)
      .map((entry) => entry.option)
  }

  /** URL to clone owner/name with, honoring the protocol the person chose for gh (https by default). */
  async function cloneUrl(repo: string, signal?: AbortSignal): Promise<string> {
    const repository = await view(repo, signal)
    const protocol = await run(home, ['config', 'get', 'git_protocol', '--host', 'github.com'], { signal }).catch(
      () => 'https'
    )
    if (protocol.trim() === 'ssh' && repository.sshUrl) return repository.sshUrl
    return `${repository.option.url.replace(/\/+$/, '')}.git`
  }

  /** Fails before any local work when gh cannot create repositories for the person. */
  async function preflight(signal?: AbortSignal): Promise<void> {
    await run(home, ['auth', 'status'], { signal })
  }

  /**
   * Create the GitHub repository from an existing local repository and push it. An existing repository with the
   * same name is reported, never reused or overwritten.
   */
  async function create(
    input: { dir: string; name: string; owner?: string; visibility: 'private' | 'public' },
    signal?: AbortSignal
  ): Promise<{ url: string; nameWithOwner: string }> {
    const name = input.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
    const owner =
      input.owner ?? (await run(home, ['api', 'user', '--jq', '.login'], { signal })).trim()
    if (!owner) throw new Error('Could not determine the signed-in GitHub account.')
    const slug = `${owner}/${name}`
    const exists = await view(slug, signal).then(
      () => true,
      (error) => {
        if (error instanceof GhCommandError && error.kind === 'failed') return false
        throw error
      }
    )
    if (exists) throw new Error(`The GitHub repository ${slug} already exists; it was not modified.`)
    const output = await run(
      input.dir,
      [
        'repo',
        'create',
        slug,
        input.visibility === 'public' ? '--public' : '--private',
        '--source',
        input.dir,
        '--remote',
        'origin',
        '--push',
      ],
      { signal, timeoutMs: 180_000 }
    )
    const url = /https:\/\/github\.com\/\S+/.exec(output)?.[0] ?? `https://github.com/${slug}`
    return { url: url.replace(/\.git$/, ''), nameWithOwner: slug }
  }

  return { find, cloneUrl, preflight, create }
}

export type GithubRepositories = ReturnType<typeof createGithubRepositories>
