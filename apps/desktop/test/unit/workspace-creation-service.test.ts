import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getConversation, getDb, getWorkspace, getWorkspaceByPath, insertWorkspace } from '../../src/main/store'
import { createProjectSetupService } from '../../src/main/project-setup/service'
import {
  createdWorkspaceIdsForTurn,
  createWorkspaceCreationService,
  readRepositoryOrigin,
  type WorkspaceCreationServiceDeps,
} from '../../src/main/workspace-creation-service'
import {
  beginWorkspaceCreation,
  completeWorkspaceCreation,
  findWorkspaceCreation,
} from '../../src/main/workspace-creation-store'
import type { HumanTurnGrant } from '../../src/main/chat/conversation-dispatch-authorization'
import type { ProjectConversation } from '../../src/shared/conversation'
import type { WorkspaceCreationProgress } from '../../src/shared/workspace-creation'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

let root: string
let projects: string
let remote: string
let remoteUrl: string
let source: ProjectConversation
let progress: WorkspaceCreationProgress[]

/** A bare repository with one commit on main, reachable through a file:// URL. */
function bareRemote(name: string): string {
  const work = path.join(root, `${name}-work`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work)
  git(work, ['init', '-q', '-b', 'main'])
  writeFileSync(path.join(work, 'README.md'), `# ${name}\n`)
  git(work, ['add', '-A'])
  git(work, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'])
  const bare = path.join(root, `${name}.git`)
  git(root, ['clone', '-q', '--bare', work, bare])
  return bare
}

function harness(overrides: Partial<WorkspaceCreationServiceDeps> = {}) {
  const setup = createProjectSetupService({
    // Register straight into the test database, as the production addWorkspace does.
    addWorkspace: async (dir, options = {}) => {
      const top = options.validated?.top ?? dir
      options.beforeInsert?.()
      const existing = getWorkspaceByPath(top)
      if (existing) return existing
      insertWorkspace({
        id: randomUUID(),
        path: top,
        name: path.basename(top),
        defaultBranch: options.validated?.defaultBranch ?? 'main',
        addedAt: Date.now(),
      })
      return getWorkspaceByPath(top)!
    },
    getWorkspaceByPath,
  })
  const github = {
    cloneUrl: vi.fn(async (_repo: string) => remoteUrl),
    preflight: vi.fn(async () => undefined),
    create: vi.fn(async (input: { name: string }) => ({ url: `https://github.com/octo/${input.name}` })),
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  }
  const deps: WorkspaceCreationServiceDeps = {
    getConversation: (id) => getConversation(id),
    isWebManaged: () => false,
    getProjectsDirectory: () => projects,
    getWorkspace,
    getWorkspaceByPath,
    executeSetup: vi.fn((request, ctx) => setup.execute(request, ctx)),
    readRepositoryOrigin,
    github,
    emitProgress: (event) => progress.push(event),
    notifyWorkspacesChanged: vi.fn(),
    ...overrides,
  }
  return { deps, github, service: createWorkspaceCreationService(deps) }
}

function grant(): HumanTurnGrant {
  return {
    conversationId: source.id,
    messageId: 'msg-1',
    originKey: 'message:msg-1',
    token: {},
    signal: new AbortController().signal,
  }
}

type ConfirmPublic = (repo: string) => Promise<'public' | 'private' | 'cancel'>

function create(service: ReturnType<typeof harness>['service'], input: unknown, confirmPublic?: ConfirmPublic) {
  return service.create({
    grant: grant(),
    input,
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
    ...(confirmPublic ? { confirmPublic } : {}),
  })
}

const cloneInput = (extra: Record<string, unknown> = {}) => ({
  requestKey: 'acme/api',
  source: { kind: 'git', url: remoteUrl },
  name: 'api',
  ...extra,
})

beforeEach(() => {
  freshDb()
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'workspace-creation-')))
  projects = path.join(root, 'Projects')
  mkdirSync(projects)
  remote = bareRemote('api')
  remoteUrl = `file://${remote}`
  source = makeConversation(makeWorkspace().id, { name: 'Planning' })
  progress = []
})

afterEach(() => {
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('workspace creation service', () => {
  it('clones into the projects folder, registers the workspace and replays a repeated request', async () => {
    const { service, deps } = harness()
    const first = await create(service, cloneInput())
    expect(first).toMatchObject({
      ok: true,
      requestKey: 'acme/api',
      source: { kind: 'git', label: remoteUrl },
      name: 'api',
      path: path.join(projects, 'api'),
      defaultBranch: 'main',
      remoteUrl,
      reused: false,
    })
    expect(getWorkspace(first.workspaceId!)?.path).toBe(path.join(projects, 'api'))
    expect(readFileSync(path.join(projects, 'api', 'README.md'), 'utf8')).toBe('# api\n')
    expect(progress.map((event) => event.phase)).toContain('registering')
    expect(progress.every((event) => event.conversationId === source.id && event.requestKey === 'acme/api')).toBe(true)
    expect(deps.notifyWorkspacesChanged).toHaveBeenCalledTimes(1)
    expect(findWorkspaceCreation(source.id, 'message:msg-1', 'acme/api')).toMatchObject({
      phase: 'registered',
      workspaceId: first.workspaceId,
    })

    const replay = await create(service, cloneInput())
    expect(replay).toMatchObject({ ok: true, workspaceId: first.workspaceId, replayed: true })
    expect(deps.executeSetup).toHaveBeenCalledTimes(1)
  })

  it('runs concurrent identical requests once', async () => {
    const { service, deps } = harness()
    const [a, b] = await Promise.all([create(service, cloneInput()), create(service, cloneInput())])
    expect(a.workspaceId).toBe(b.workspaceId)
    expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1)
    expect(deps.executeSetup).toHaveBeenCalledTimes(1)
  })

  it('refuses a changed request under the same key and more projects than the per-message bound', async () => {
    const { service, deps } = harness()
    const first = await create(service, cloneInput())
    expect(first.ok).toBe(true)
    expect(await create(service, cloneInput({ name: 'other' }))).toMatchObject({ ok: false, code: 'request-conflict' })

    // Nine more projects already recorded for this message reach the bound of ten.
    for (let index = 0; index < 9; index++) {
      const begun = beginWorkspaceCreation({
        creationId: randomUUID(),
        sourceConversationId: source.id,
        originKey: 'message:msg-1',
        requestKey: `filler-${index}`,
        fingerprint: 'f',
        source: { kind: 'new' },
        name: `filler-${index}`,
        destination: path.join(projects, `filler-${index}`),
        remoteUrl: null,
      })
      completeWorkspaceCreation(begun.record.creationId, {
        workspaceId: first.workspaceId!,
        destination: first.path!,
        reused: false,
        remoteUrl: null,
        remote: null,
      })
    }
    const over = await create(service, { requestKey: 'acme/web', source: { kind: 'new' }, name: 'web' })
    expect(over).toMatchObject({ ok: false, code: 'count-exceeded' })
    expect(existsSync(path.join(projects, 'web'))).toBe(false)
    expect(deps.executeSetup).toHaveBeenCalledTimes(1)
  })

  it('lists the projects created in this turn for the conversation that works on them', async () => {
    const { service } = harness()
    expect(createdWorkspaceIdsForTurn(source.id, 'message:msg-1')).toEqual([])
    const created = await create(service, cloneInput())
    await create(service, cloneInput())
    expect(createdWorkspaceIdsForTurn(source.id, 'message:msg-1')).toEqual([created.workspaceId])
    expect(createdWorkspaceIdsForTurn(source.id, 'message:other')).toEqual([])
    getDb().prepare('DELETE FROM workspaces WHERE id=?').run(created.workspaceId!)
    expect(createdWorkspaceIdsForTurn(source.id, 'message:msg-1')).toEqual([])
  })

  it('asks for the projects folder when it is not set or no longer exists', async () => {
    const unset = harness({ getProjectsDirectory: () => null })
    expect(await create(unset.service, cloneInput())).toMatchObject({ ok: false, code: 'projects-directory-not-set' })
    const missing = harness({ getProjectsDirectory: () => path.join(root, 'gone') })
    expect(await create(missing.service, cloneInput())).toMatchObject({
      ok: false,
      code: 'projects-directory-missing',
    })
    expect(findWorkspaceCreation(source.id, 'message:msg-1', 'acme/api')).toBeNull()
  })

  it('reuses an existing clone of the same remote and leaves any other folder untouched', async () => {
    git(projects, ['clone', '-q', remoteUrl, 'api'])
    const { service } = harness()
    const reused = await create(service, cloneInput())
    expect(reused).toMatchObject({ ok: true, reused: true, path: path.join(projects, 'api') })
    expect(getWorkspaceByPath(path.join(projects, 'api'))?.id).toBe(reused.workspaceId)

    const other = path.join(projects, 'web')
    mkdirSync(other)
    writeFileSync(path.join(other, 'notes.txt'), 'keep me')
    const conflict = await create(service, { requestKey: 'web', source: { kind: 'git', url: remoteUrl }, name: 'web' })
    expect(conflict).toMatchObject({ ok: false, code: 'destination-exists' })
    expect(readdirSync(other)).toEqual(['notes.txt'])
    expect(getWorkspaceByPath(other)).toBeUndefined()
  })

  it('does not adopt a folder whose origin is only inherited from an enclosing repository', async () => {
    git(projects, ['init', '-q', '-b', 'main'])
    git(projects, ['remote', 'add', 'origin', remoteUrl])
    mkdirSync(path.join(projects, 'api'))
    const { service } = harness()
    expect(await create(service, cloneInput())).toMatchObject({ ok: false, code: 'destination-exists' })
    expect(getWorkspaceByPath(projects)).toBeUndefined()
  })

  it('retries a failed attempt with the same request key', async () => {
    rmSync(remote, { recursive: true, force: true })
    const { service } = harness()
    const failed = await create(service, cloneInput())
    expect(failed).toMatchObject({ ok: false, code: 'setup-failed' })
    expect(existsSync(path.join(projects, 'api'))).toBe(false)
    expect(findWorkspaceCreation(source.id, 'message:msg-1', 'acme/api')?.phase).toBe('failed')

    bareRemote('api')
    const retried = await create(service, cloneInput())
    expect(retried).toMatchObject({ ok: true, path: path.join(projects, 'api') })
  })

  it('clones a GitHub repository through the URL gh resolves', async () => {
    const { service, github } = harness()
    const result = await create(service, { requestKey: 'acme/api', source: { kind: 'github', repo: 'acme/api' } })
    expect(github.cloneUrl).toHaveBeenCalledWith('acme/api', expect.any(AbortSignal))
    expect(result).toMatchObject({ ok: true, name: 'api', source: { kind: 'github', label: 'acme/api' }, remoteUrl })
  })

  it('creates a new local project and its private GitHub repository without asking', async () => {
    const { service, github } = harness()
    const confirmPublic = vi.fn<ConfirmPublic>()
    const input = { requestKey: 'atlas', name: 'Atlas', source: { kind: 'new', github: { create: true } } }
    const result = await create(service, input, confirmPublic)
    expect(confirmPublic).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      name: 'Atlas',
      source: { kind: 'new', label: 'Atlas' },
      remote: { status: 'created', url: 'https://github.com/octo/Atlas' },
      remoteUrl: 'https://github.com/octo/Atlas',
    })
    expect(github.create).toHaveBeenCalledWith(
      { dir: path.join(projects, 'Atlas'), name: 'Atlas', visibility: 'private' },
      expect.any(AbortSignal)
    )
    expect(git(path.join(projects, 'Atlas'), ['log', '--format=%s'])).toBe('Initial commit')
  })

  it('asks the person before a GitHub repository becomes public', async () => {
    const input = (name: string) => ({
      requestKey: name,
      name,
      source: { kind: 'new', github: { create: true, owner: 'octo', visibility: 'public' } },
    })

    // Declined or never asked: nothing is created, locally or on GitHub.
    const declined = harness()
    const cancel = vi.fn<ConfirmPublic>(async () => 'cancel')
    expect(await create(declined.service, input('Atlas'), cancel)).toMatchObject({ ok: false, code: 'not-confirmed' })
    expect(cancel).toHaveBeenCalledWith('octo/Atlas')
    expect(await create(declined.service, input('Atlas'))).toMatchObject({ ok: false, code: 'not-confirmed' })
    expect(existsSync(path.join(projects, 'Atlas'))).toBe(false)
    expect(declined.github.create).not.toHaveBeenCalled()

    // The person may keep it private instead, or confirm it public.
    const chosen = harness()
    expect(await create(chosen.service, input('Hermes'), async () => 'private')).toMatchObject({ ok: true })
    expect(chosen.github.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'Hermes', owner: 'octo', visibility: 'private' }),
      expect.any(AbortSignal)
    )
    expect(await create(chosen.service, input('Iris'), async () => 'public')).toMatchObject({ ok: true })
    expect(chosen.github.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'Iris', visibility: 'public' }),
      expect.any(AbortSignal)
    )
  })

  it('keeps the local project registered when the GitHub repository cannot be created', async () => {
    const { service } = harness({
      github: {
        cloneUrl: async () => remoteUrl,
        preflight: async () => undefined,
        create: async () => {
          throw new Error('The GitHub repository octo/Atlas already exists; it was not modified.')
        },
        errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      },
    })
    const result = await create(
      service,
      { requestKey: 'atlas', name: 'Atlas', source: { kind: 'new', github: { create: true, visibility: 'public' } } },
      async () => 'public'
    )
    expect(result).toMatchObject({
      ok: true,
      remote: { status: 'failed', error: 'The GitHub repository octo/Atlas already exists; it was not modified.' },
    })
    expect(result.remoteUrl).toBeUndefined()
    expect(getWorkspace(result.workspaceId!)).toBeDefined()
  })

  it('stops before creating anything when gh cannot create the requested repository', async () => {
    const { service } = harness({
      github: {
        cloneUrl: async () => remoteUrl,
        preflight: async () => {
          throw new Error('GitHub CLI (gh) is not signed in.')
        },
        create: vi.fn(),
        errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      },
    })
    const result = await create(service, {
      requestKey: 'atlas',
      name: 'Atlas',
      source: { kind: 'new', github: { create: true } },
    })
    expect(result).toMatchObject({ ok: false, code: 'github-unavailable', error: 'GitHub CLI (gh) is not signed in.' })
    expect(existsSync(path.join(projects, 'Atlas'))).toBe(false)
  })

  it('reports a removed workspace instead of recreating it', async () => {
    const { service } = harness()
    const first = await create(service, cloneInput())
    getDb().prepare('DELETE FROM workspaces WHERE id=?').run(first.workspaceId!)
    expect(await create(service, cloneInput())).toMatchObject({ ok: false, code: 'workspace-removed' })
  })

  it('rejects malformed input and credentials in clone URLs before any work', async () => {
    const { service, deps } = harness()
    expect(await create(service, { requestKey: 'x', source: { kind: 'new' } })).toMatchObject({
      ok: false,
      code: 'invalid-request',
    })
    expect(
      await create(service, { requestKey: 'x', source: { kind: 'git', url: 'https://user:token@github.com/a/b.git' } })
    ).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(deps.executeSetup).not.toHaveBeenCalled()
  })
})
