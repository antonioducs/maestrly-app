import { describe, expect, it, vi } from 'vitest'
import { GhCommandError } from '../../src/main/gh-command'
import { createGithubRepositories, githubErrorMessage } from '../../src/main/github-repositories'

const repo = (nameWithOwner: string, extra: Record<string, unknown> = {}) => ({
  nameWithOwner,
  url: `https://github.com/${nameWithOwner}`,
  defaultBranchRef: { name: 'main' },
  visibility: 'PRIVATE',
  description: null,
  ...extra,
})

const notFound = (args: string[]) => new GhCommandError('failed', args, 'Could not resolve to a Repository', 1)

/** A fake gh: `routes` answers by the joined subcommand prefix. */
function fakeGh(routes: Record<string, (args: string[]) => unknown>) {
  return vi.fn(async (_cwd: string, args: string[]) => {
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((prefix) => args.join(' ').startsWith(prefix))
    if (!key) throw new Error(`unexpected gh ${args.join(' ')}`)
    const value = routes[key](args)
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

describe('GitHub repositories through gh', () => {
  it('finds an exact owner/name with gh repo view and reports none when it does not exist', async () => {
    const run = fakeGh({
      'repo view acme/api': () => repo('acme/api', { description: 'API', sshUrl: 'git@github.com:acme/api.git' }),
      'repo view acme/missing': (args) => {
        throw notFound(args)
      },
    })
    const github = createGithubRepositories(run)
    expect(await github.find({ query: 'acme/api' })).toEqual([
      { nameWithOwner: 'acme/api', url: 'https://github.com/acme/api', defaultBranch: 'main', visibility: 'private', description: 'API' },
    ])
    expect(await github.find({ query: 'acme/missing' })).toEqual([])
  })

  it('searches the repositories of an owner by name, best matches first', async () => {
    const run = fakeGh({
      'repo list acme': () => [
        repo('acme/web-api-docs'),
        repo('acme/legacy', { description: 'Old api gateway' }),
        repo('acme/api'),
        repo('acme/billing'),
      ],
    })
    const github = createGithubRepositories(run)
    const found = await github.find({ query: 'API', owner: 'acme' })
    expect(found.map((item) => item.nameWithOwner)).toEqual(['acme/api', 'acme/web-api-docs', 'acme/legacy'])
    expect(run.mock.calls[0][1]).toEqual([
      'repo',
      'list',
      'acme',
      '--limit',
      '200',
      '--json',
      'nameWithOwner,url,defaultBranchRef,visibility,description',
    ])
  })

  it('clones with the protocol the person configured in gh', async () => {
    const view = () => repo('acme/api', { sshUrl: 'git@github.com:acme/api.git' })
    const ssh = createGithubRepositories(fakeGh({ 'repo view': view, 'config get git_protocol': () => 'ssh\n' }))
    expect(await ssh.cloneUrl('acme/api')).toBe('git@github.com:acme/api.git')
    const https = createGithubRepositories(
      fakeGh({
        'repo view': view,
        'config get git_protocol': () => {
          throw new Error('not set')
        },
      })
    )
    expect(await https.cloneUrl('acme/api')).toBe('https://github.com/acme/api.git')
  })

  it('creates a private repository for the signed-in account and pushes the local project', async () => {
    const run = fakeGh({
      'api user': () => 'octo\n',
      'repo view octo/My-App': (args) => {
        throw notFound(args)
      },
      'repo create': () => 'https://github.com/octo/My-App\n',
    })
    const github = createGithubRepositories(run)
    expect(await github.create({ dir: '/projects/My App', name: 'My App', visibility: 'private' })).toEqual({
      url: 'https://github.com/octo/My-App',
      nameWithOwner: 'octo/My-App',
    })
    const create = run.mock.calls.find(([, args]) => args[1] === 'create')!
    expect(create[0]).toBe('/projects/My App')
    expect(create[1]).toEqual([
      'repo',
      'create',
      'octo/My-App',
      '--private',
      '--source',
      '/projects/My App',
      '--remote',
      'origin',
      '--push',
    ])
  })

  it('never reuses or overwrites an existing GitHub repository', async () => {
    const run = fakeGh({ 'repo view acme/api': () => repo('acme/api'), 'repo create': () => '' })
    const github = createGithubRepositories(run)
    await expect(
      github.create({ dir: '/projects/api', name: 'api', owner: 'acme', visibility: 'public' })
    ).rejects.toThrow(/acme\/api already exists; it was not modified/)
    expect(run.mock.calls.some(([, args]) => args[1] === 'create')).toBe(false)
  })

  it('explains a missing or signed-out gh in terms the agent can relay', () => {
    expect(githubErrorMessage(new GhCommandError('no-gh', [], 'missing'))).toMatch(/not installed/)
    expect(githubErrorMessage(new GhCommandError('not-logged-in', [], 'login'))).toMatch(/gh auth login/)
    expect(githubErrorMessage(new GhCommandError('failed', [], 'boom', 1))).toBe('GitHub CLI failed: boom')
  })
})
