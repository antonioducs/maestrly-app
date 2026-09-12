import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SINGLE_REPOSITORY_SELECTOR, type RepositoryScope } from '../../src/main/repository-scope'

const { runGhCommand } = vi.hoisted(() => ({ runGhCommand: vi.fn() }))
vi.mock('../../src/main/gh-command', () => ({ runGhCommand }))
import { ghRead } from '../../src/main/gh-read'

const scope = {
  repositories: [],
  isMulti: false,
  resolveRepository: (linkName?: string) => ({
    linkName: linkName ?? '',
    worktreePath: '/repo',
    realWorktreePath: '/repo',
    branch: 'main',
    base: 'origin/main',
  }),
  resolvePath: vi.fn(),
  resolveBridgePath: vi.fn(),
} satisfies RepositoryScope

const singleRepositoryScope = {
  ...scope,
  resolveRepository: (linkName?: string) => {
    if (linkName && linkName !== SINGLE_REPOSITORY_SELECTOR) throw new Error('repo_not_found')
    return scope.resolveRepository()
  },
} satisfies RepositoryScope

const multiRepositories = [
  {
    linkName: 'backend',
    worktreePath: '/backend',
    realWorktreePath: '/backend',
    branch: 'main',
    base: 'origin/main',
  },
  {
    linkName: 'frontend',
    worktreePath: '/frontend',
    realWorktreePath: '/frontend',
    branch: 'main',
    base: 'origin/main',
  },
] as const

const multiRepositoryScope = {
  ...scope,
  repositories: multiRepositories,
  isMulti: true,
  resolveRepository: (linkName?: string) => {
    if (!linkName) throw new Error('repo_required')
    const repository = multiRepositories.find((candidate) => candidate.linkName === linkName)
    if (!repository) throw new Error('repo_not_found')
    return repository
  },
} satisfies RepositoryScope

beforeEach(() => runGhCommand.mockReset())

describe('ghRead', () => {
  it('accepts the single-repository identifier advertised by capabilities', async () => {
    const capabilityPayload = {
      repositories: [{ id: SINGLE_REPOSITORY_SELECTOR, name: SINGLE_REPOSITORY_SELECTOR }],
    }
    runGhCommand.mockResolvedValueOnce('').mockResolvedValueOnce('{}')

    const result = await ghRead(singleRepositoryScope, {
      operation: 'repo-view',
      repo: capabilityPayload.repositories[0].id,
    })

    expect(result.repo).toBe('')
  })

  it('emits fixed read-only argv and parses JSON', async () => {
    runGhCommand.mockResolvedValueOnce('').mockResolvedValueOnce('[{"number":7}]')
    const result = await ghRead(scope, { operation: 'pr-list', repo: 'backend', limit: 5 })
    expect(runGhCommand).toHaveBeenLastCalledWith(
      '/repo',
      ['pr', 'list', '--limit', '5', '--json', expect.any(String)],
      { signal: undefined }
    )
    expect(result).toMatchObject({ repo: 'backend', data: [{ number: 7 }] })
  })

  it('parses oversized valid JSON before bounding the structured result', async () => {
    runGhCommand.mockResolvedValueOnce('').mockResolvedValueOnce(JSON.stringify({ body: 'x'.repeat(1_000_001) }))

    const result = await ghRead(scope, { operation: 'pr-view', number: 7 })

    expect(result.truncated).toBe(true)
    expect(result.data).toMatchObject({ body: expect.stringContaining('JSON truncado') })
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(1_000_000)
  })

  it('forces API GET and rejects endpoint injection', async () => {
    runGhCommand.mockResolvedValueOnce('').mockResolvedValueOnce('{"ok":true}')
    await ghRead(scope, { operation: 'api-get', endpoint: 'repos/acme/project' })
    expect(runGhCommand).toHaveBeenLastCalledWith('/repo', ['api', '--method', 'GET', 'repos/acme/project'], {
      signal: undefined,
    })
    await expect(ghRead(scope, { operation: 'api-get', endpoint: '--method DELETE' })).rejects.toThrow(/endpoint/)
    await expect(ghRead(scope, { operation: 'api-get', endpoint: 'https://example.test' })).rejects.toThrow(/endpoint/)
  })

  it('runs global operations without repo in multi-repo but validates an explicitly supplied repo', async () => {
    runGhCommand.mockResolvedValueOnce('').mockResolvedValueOnce('[]')

    const result = await ghRead(multiRepositoryScope, { operation: 'search-repos', query: 'desktop' })

    expect(result.repo).toBe('backend')
    expect(runGhCommand).toHaveBeenLastCalledWith(
      '/backend',
      ['search', 'repos', 'desktop', '--limit', '30', '--json', expect.any(String)],
      { signal: undefined }
    )
    runGhCommand.mockResolvedValueOnce('').mockResolvedValueOnce('{"login":"octocat"}')
    await expect(ghRead(multiRepositoryScope, { operation: 'api-get', endpoint: 'user' })).resolves.toMatchObject({
      repo: 'backend',
      data: { login: 'octocat' },
    })
    expect(runGhCommand).toHaveBeenLastCalledWith('/backend', ['api', '--method', 'GET', 'user'], {
      signal: undefined,
    })
    await expect(
      ghRead(multiRepositoryScope, { operation: 'api-get', repo: 'owner/repo', endpoint: 'user' })
    ).rejects.toThrow('repo_not_found')
  })

  it('still requires an authorized repo for local operations in multi-repo', async () => {
    await expect(ghRead(multiRepositoryScope, { operation: 'repo-view' })).rejects.toThrow('repo_required')
    expect(runGhCommand).not.toHaveBeenCalled()
  })

  it('rejects passthrough operations and option-shaped ids', async () => {
    await expect(ghRead(scope, { operation: 'pr-merge' as never, number: 1 })).rejects.toThrow(/Unauthorized/)
    await expect(ghRead(scope, { operation: 'run-view', id: '--help' })).rejects.toThrow(/Invalid id/)
    await expect(ghRead(scope, { operation: 'search-code', query: '--web' })).rejects.toThrow(/query/)
    expect(runGhCommand).not.toHaveBeenCalled()
  })
})
