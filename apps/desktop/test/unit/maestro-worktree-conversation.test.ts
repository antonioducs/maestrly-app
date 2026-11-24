import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeStandaloneConversation, makeWorkspace } from '../helpers/factories'
import { runGit } from '../../src/main/git-command'
import { branchExists, resolveCommit } from '../../src/main/git-service'
import { getConversationDispatchByDestination } from '../../src/main/conversation-dispatch-store'
import { getConversation, getDb } from '../../src/main/store'
import { createMaestroWorktreeConversation, deleteConversation } from '../../src/main/workspace-service'

let root: string
let repo: string
let workspaceId: string

async function gitCommit(cwd: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(cwd, file), content)
  await runGit(cwd, ['add', '.'])
  await runGit(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', message])
  return (await resolveCommit(cwd))!
}

describe('createMaestroWorktreeConversation', () => {
  beforeEach(async () => {
    freshDb()
    root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-maestro-worktree-'))
    repo = path.join(root, 'repo')
    await mkdir(repo)
    vi.spyOn(app, 'getPath').mockReturnValue(path.join(root, 'user-data'))
    await runGit(repo, ['init', '-b', 'main'])
    await gitCommit(repo, 'README.md', 'initial\n', 'initial')
    workspaceId = makeWorkspace({ path: repo, defaultBranch: 'main' }).id
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    closeDb()
    await rm(root, { recursive: true, force: true })
  })

  it('creates feat/pedidos in a new worktree from source HEAD with experience maestro and no dispatch row', async () => {
    await runGit(repo, ['checkout', '-b', 'work/planning'])
    const sourceHead = await gitCommit(repo, 'plan.txt', 'spec\n', 'add planning note')
    const source = makeConversation(workspaceId, {
      name: 'Checkout',
      branch: 'work/planning',
      mode: 'local',
      cwd: repo,
      experience: 'standard',
    })

    const orchestrator = await createMaestroWorktreeConversation(source.id, {
      name: 'Checkout · Maestro',
      branchHint: 'Pedidos',
    })

    expect(orchestrator.scope).toBe('project')
    expect(orchestrator.workspaceId).toBe(workspaceId)
    expect(orchestrator.name).toBe('Checkout · Maestro')
    expect(orchestrator.branch).toBe('feat/pedidos')
    expect(orchestrator.mode).toBe('worktree')
    expect(orchestrator.experience).toBe('maestro')
    expect(orchestrator.cwd).not.toBe(source.cwd)
    expect(existsSync(orchestrator.cwd)).toBe(true)
    expect(await resolveCommit(orchestrator.cwd)).toBe(sourceHead)
    expect(await resolveCommit(repo, 'refs/heads/feat/pedidos')).toBe(sourceHead)
    expect(getConversation(orchestrator.id)).toMatchObject({
      id: orchestrator.id,
      branch: 'feat/pedidos',
      experience: 'maestro',
      mode: 'worktree',
    })

    // Orchestrator conversations must not count as agent-created dispatches.
    expect(getConversationDispatchByDestination(orchestrator.id)).toBeNull()
    const row = getDb()
      .prepare('SELECT COUNT(*) AS count FROM conversation_dispatches WHERE conversation_id = ?')
      .get(orchestrator.id) as { count: number }
    expect(row.count).toBe(0)
  })

  it('carries the source uncommitted changes into one commit on the feature branch without touching the source', async () => {
    const sourceHead = await gitCommit(repo, '.gitignore', 'secret.env\n', 'ignore secrets')
    await writeFile(path.join(repo, 'README.md'), 'edited\n')
    await mkdir(path.join(repo, 'prototypes'))
    await writeFile(path.join(repo, 'prototypes', 'index.html'), '<h1>prototype</h1>\n')
    await writeFile(path.join(repo, 'secret.env'), 'TOKEN=1\n')
    await runGit(repo, ['add', 'README.md'])
    const statusBefore = await runGit(repo, ['status', '--porcelain'])
    const source = makeConversation(workspaceId, {
      name: 'Checkout',
      branch: 'main',
      mode: 'local',
      cwd: repo,
      experience: 'standard',
    })

    const orchestrator = await createMaestroWorktreeConversation(source.id, {
      name: 'Checkout · Maestro',
      branchHint: 'Pedidos',
    })

    const head = (await resolveCommit(orchestrator.cwd))!
    expect(head).not.toBe(sourceHead)
    expect(await runGit(orchestrator.cwd, ['rev-parse', 'HEAD^'])).toBe(sourceHead)
    expect(await runGit(orchestrator.cwd, ['log', '-1', '--format=%s'])).toMatch(/^chore: /)
    expect(await runGit(orchestrator.cwd, ['show', 'HEAD:README.md'])).toBe('edited')
    expect(await runGit(orchestrator.cwd, ['show', 'HEAD:prototypes/index.html'])).toBe('<h1>prototype</h1>')
    expect(existsSync(path.join(orchestrator.cwd, 'prototypes', 'index.html'))).toBe(true)
    expect(existsSync(path.join(orchestrator.cwd, 'secret.env'))).toBe(false)
    expect(await runGit(orchestrator.cwd, ['status', '--porcelain'])).toBe('')

    expect(await resolveCommit(repo)).toBe(sourceHead)
    expect(await runGit(repo, ['status', '--porcelain'])).toBe(statusBefore)
  })

  it('refuses to carry a source with unresolved merge conflicts', async () => {
    await runGit(repo, ['checkout', '-b', 'other'])
    await gitCommit(repo, 'README.md', 'other\n', 'other change')
    await runGit(repo, ['checkout', 'main'])
    await gitCommit(repo, 'README.md', 'main\n', 'main change')
    await runGit(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'merge', 'other']).catch(
      () => undefined
    )
    const source = makeConversation(workspaceId, {
      name: 'Checkout',
      branch: 'main',
      mode: 'local',
      cwd: repo,
      experience: 'standard',
    })

    await expect(
      createMaestroWorktreeConversation(source.id, { name: 'Checkout · Maestro', branchHint: 'Pedidos' })
    ).rejects.toThrow(/conflict/i)
    expect(await branchExists(repo, 'feat/pedidos')).toBe(false)
  })

  it('appends -2 and -3 when feat/<slug> branches already exist', async () => {
    const sourceHead = (await resolveCommit(repo))!
    const source = makeConversation(workspaceId, {
      name: 'Checkout',
      branch: 'main',
      mode: 'local',
      cwd: repo,
      experience: 'standard',
    })

    const first = await createMaestroWorktreeConversation(source.id, {
      name: 'Pedidos · Maestro',
      branchHint: 'Pedidos',
    })
    const second = await createMaestroWorktreeConversation(source.id, {
      name: 'Pedidos · Maestro',
      branchHint: 'Pedidos',
    })
    const third = await createMaestroWorktreeConversation(source.id, {
      name: 'Pedidos · Maestro',
      branchHint: 'Pedidos',
    })

    expect(first.branch).toBe('feat/pedidos')
    expect(second.branch).toBe('feat/pedidos-2')
    expect(third.branch).toBe('feat/pedidos-3')
    expect(new Set([first.cwd, second.cwd, third.cwd]).size).toBe(3)
    expect(await resolveCommit(second.cwd)).toBe(sourceHead)
    expect(await resolveCommit(third.cwd)).toBe(sourceHead)
  })

  it('uses feat/maestro when the branchHint produces an empty slug', async () => {
    const source = makeConversation(workspaceId, {
      name: 'Untitled',
      branch: 'main',
      mode: 'local',
      cwd: repo,
      experience: 'standard',
    })

    const first = await createMaestroWorktreeConversation(source.id, {
      name: 'Untitled · Maestro',
      branchHint: '   !!!   ',
    })
    const second = await createMaestroWorktreeConversation(source.id, {
      name: 'Untitled · Maestro',
      branchHint: '',
    })

    expect(first.branch).toBe('feat/maestro')
    expect(second.branch).toBe('feat/maestro-2')
  })

  it('rejects missing, standalone, missing-workspace, and unresolvable-HEAD sources', async () => {
    await expect(
      createMaestroWorktreeConversation('does-not-exist', { name: 'X · Maestro', branchHint: 'X' })
    ).rejects.toThrow()

    const standalone = makeStandaloneConversation({ name: 'Solo', cwd: repo })
    await expect(
      createMaestroWorktreeConversation(standalone.id, { name: 'Solo · Maestro', branchHint: 'Solo' })
    ).rejects.toThrow('project-required')

    const db = getDb()
    db.exec('PRAGMA foreign_keys = OFF')
    const orphaned = makeConversation('missing-workspace-id', {
      name: 'Orphan',
      cwd: repo,
      branch: 'main',
      mode: 'local',
    })
    db.exec('PRAGMA foreign_keys = ON')
    await expect(
      createMaestroWorktreeConversation(orphaned.id, { name: 'Orphan · Maestro', branchHint: 'Orphan' })
    ).rejects.toThrow(/workspace/i)

    const unbornRepo = path.join(root, 'unborn')
    await mkdir(unbornRepo)
    await runGit(unbornRepo, ['init', '-b', 'main'])
    const unbornWs = makeWorkspace({ path: unbornRepo, defaultBranch: 'main' })
    const unbornSource = makeConversation(unbornWs.id, {
      name: 'Unborn',
      branch: 'main',
      mode: 'local',
      cwd: unbornRepo,
    })
    await expect(
      createMaestroWorktreeConversation(unbornSource.id, { name: 'Unborn · Maestro', branchHint: 'Unborn' })
    ).rejects.toThrow(/HEAD/i)
  })

  it('removes the orchestrator worktree and branch when rolled back with preserveWorktree: false', async () => {
    const source = makeConversation(workspaceId, {
      name: 'Checkout',
      branch: 'main',
      mode: 'local',
      cwd: repo,
      experience: 'standard',
    })
    const orchestrator = await createMaestroWorktreeConversation(source.id, {
      name: 'Checkout · Maestro',
      branchHint: 'Pedidos',
    })
    expect(existsSync(orchestrator.cwd)).toBe(true)
    expect(await branchExists(repo, 'feat/pedidos')).toBe(true)

    await deleteConversation(orchestrator.id, { preserveWorktree: false })

    expect(existsSync(orchestrator.cwd)).toBe(false)
    expect(await branchExists(repo, 'feat/pedidos')).toBe(false)
    expect(getConversation(orchestrator.id)).toBeUndefined()
    expect(existsSync(repo)).toBe(true)
  })

  it('branches from the source conversation worktree HEAD rather than the main repo HEAD', async () => {
    const mainHead = (await resolveCommit(repo))!
    const sourceWorktree = path.join(root, 'source-wt')
    await runGit(repo, ['worktree', 'add', '-b', 'feat/source-work', sourceWorktree, mainHead])
    const sourceWorktreeHead = await gitCommit(sourceWorktree, 'work.txt', 'from source wt\n', 'worktree commit')
    expect(sourceWorktreeHead).not.toBe(mainHead)

    const source = makeConversation(workspaceId, {
      name: 'Source WT',
      branch: 'feat/source-work',
      mode: 'worktree',
      cwd: sourceWorktree,
      experience: 'standard',
    })

    const orchestrator = await createMaestroWorktreeConversation(source.id, {
      name: 'Source WT · Maestro',
      branchHint: 'Pedidos',
    })

    expect(orchestrator.branch).toBe('feat/pedidos')
    expect(await resolveCommit(orchestrator.cwd)).toBe(sourceWorktreeHead)
    expect(await resolveCommit(repo)).toBe(mainHead)
  })
})
