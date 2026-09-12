import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Workspace } from '../../src/main/store'
import { createProjectSetupService, type ProjectSetupContext } from '../../src/main/project-setup/service'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function workspaceFor(dir: string, branch = 'main'): Workspace {
  return { id: path.basename(dir), path: dir, name: path.basename(dir), defaultBranch: branch, addedAt: 1 }
}

let root: string
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'project-setup-service-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function context(decision: 'initialize-local' | 'cancel' = 'cancel') {
  const controller = new AbortController()
  const phases: string[] = []
  const ctx: ProjectSetupContext = {
    signal: controller.signal,
    emit: (progress) => phases.push(progress.phase),
    markCommitted: vi.fn(),
    waitForEmptyRemoteDecision: vi.fn().mockResolvedValue(decision),
  }
  return { controller, phases, ctx }
}

function serviceFixture(existing = new Map<string, Workspace>()) {
  const addWorkspace = vi.fn(async (dir: string, options: { beforeInsert?: () => void } = {}) => {
    const real = await import('node:fs/promises').then(({ realpath }) => realpath(dir))
    const current = existing.get(real)
    if (current) return current
    const branch = git(real, ['branch', '--show-current'])
    const workspace = workspaceFor(real, branch)
    options.beforeInsert?.()
    existing.set(real, workspace)
    return workspace
  })
  const service = createProjectSetupService({
    addWorkspace,
    getWorkspaceByPath: (dir) => existing.get(dir),
  })
  return { service, addWorkspace, existing }
}

describe('project setup service', () => {
  it('deduplicates an already registered repository or subdirectory without effects or inserts', async () => {
    const repo = path.join(root, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init'])
    const sub = path.join(repo, 'nested')
    mkdirSync(sub)
    const current = workspaceFor(repo)
    const { service, addWorkspace } = serviceFixture(new Map([[repo, current]]))

    const result = await service.execute({ operationId: crypto.randomUUID(), kind: 'open', path: sub }, context().ctx)
    expect(result).toEqual({ status: 'success', workspace: current, reused: true })
    expect(addWorkspace).not.toHaveBeenCalled()
  })

  it('opening a non-Git folder leaves it unchanged; confirmation creates an empty commit and preserves files', async () => {
    const dir = path.join(root, 'customer')
    mkdirSync(dir)
    writeFileSync(path.join(dir, 'source.txt'), 'user data')
    const { service, addWorkspace } = serviceFixture()

    const inspection = await service.execute(
      { operationId: crypto.randomUUID(), kind: 'open', path: dir },
      context().ctx
    )
    expect(inspection).toEqual({ status: 'needs-initialization', path: dir })
    expect(existsSync(path.join(dir, '.git'))).toBe(false)
    expect(addWorkspace).not.toHaveBeenCalled()

    const initialized = await service.execute(
      { operationId: crypto.randomUUID(), kind: 'initialize-existing', path: dir },
      context().ctx
    )
    expect(initialized.status).toBe('success')
    expect(git(dir, ['branch', '--show-current'])).toBe('main')
    expect(git(dir, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('')
    expect(git(dir, ['status', '--porcelain'])).toBe('?? source.txt')
    expect(readFileSync(path.join(dir, 'source.txt'), 'utf8')).toBe('user data')
  })

  it('persists the project last and provides an immediately usable worktree', async () => {
    const { service, addWorkspace } = serviceFixture()
    addWorkspace.mockImplementationOnce(async (dir) => {
      expect(git(dir, ['rev-parse', '--verify', 'HEAD'])).toMatch(/^[0-9a-f]{40}$/)
      return workspaceFor(dir, git(dir, ['branch', '--show-current']))
    })
    const result = await service.execute(
      { operationId: crypto.randomUUID(), kind: 'create', parentPath: root, name: 'fresh' },
      context().ctx
    )
    expect(result.status).toBe('success')
    const repo = path.join(root, 'fresh')
    expect(git(repo, ['branch', '--show-current'])).toBe('main')
    const wt = path.join(root, 'fresh-worktree')
    git(repo, ['worktree', 'add', '-q', '-b', 'card/test', wt, 'main'])
    expect(readFileSync(path.join(wt, 'README.md'), 'utf8')).toBe('# fresh\n')
  })

  it('rejects an existing destination without removing it', async () => {
    const destination = path.join(root, 'existing')
    mkdirSync(destination)
    writeFileSync(path.join(destination, 'keep.txt'), 'keep')
    const { service, addWorkspace } = serviceFixture()
    const result = await service.execute(
      { operationId: crypto.randomUUID(), kind: 'create', parentPath: root, name: 'existing' },
      context().ctx
    )
    expect(result).toEqual({ status: 'error', error: { code: 'destination-exists' } })
    expect(readFileSync(path.join(destination, 'keep.txt'), 'utf8')).toBe('keep')
    expect(addWorkspace).not.toHaveBeenCalled()
  })

  it('rejecting an empty remote cleans the destination without registration; confirming creates local history', async () => {
    const bare = path.join(root, 'empty.git')
    git(root, ['init', '-q', '--bare', '--initial-branch=main', bare])

    const refusedFixture = serviceFixture()
    const refusedDest = path.join(root, 'refused')
    const refused = await refusedFixture.service.execute(
      {
        operationId: crypto.randomUUID(),
        kind: 'clone',
        parentPath: root,
        name: 'refused',
        remoteUrl: bare,
      },
      context('cancel').ctx
    )
    expect(refused).toEqual({ status: 'canceled' })
    expect(existsSync(refusedDest)).toBe(false)
    expect(refusedFixture.addWorkspace).not.toHaveBeenCalled()

    const acceptedFixture = serviceFixture()
    const acceptedDest = path.join(root, 'accepted')
    const accepted = await acceptedFixture.service.execute(
      {
        operationId: crypto.randomUUID(),
        kind: 'clone',
        parentPath: root,
        name: 'accepted',
        remoteUrl: bare,
        defaultBranch: 'main',
      },
      context('initialize-local').ctx
    )
    expect(accepted.status).toBe('success')
    expect(git(acceptedDest, ['branch', '--show-current'])).toBe('main')
    expect(git(acceptedDest, ['log', '-1', '--pretty=%s'])).toBe('Initial commit')
    expect(git(root, ['ls-remote', bare])).toBe('')
  })

  it('a prefilled clone respects and records the canonical default branch', async () => {
    const source = path.join(root, 'source')
    const remote = path.join(root, 'canonical.git')
    mkdirSync(source)
    git(source, ['init', '-q', '-b', 'main'])
    git(source, ['config', 'user.name', 'Test'])
    git(source, ['config', 'user.email', 'test@example.com'])
    git(source, ['commit', '-q', '--allow-empty', '-m', 'main'])
    git(source, ['checkout', '-q', '-b', 'release'])
    git(source, ['commit', '-q', '--allow-empty', '-m', 'release'])
    git(source, ['checkout', '-q', 'main'])
    git(root, ['clone', '-q', '--bare', source, remote])
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    const { service } = serviceFixture()

    const result = await service.execute(
      {
        operationId: crypto.randomUUID(),
        kind: 'clone',
        parentPath: root,
        name: 'canonical-clone',
        remoteUrl: remote,
        defaultBranch: 'release',
      },
      context().ctx
    )

    expect(result).toMatchObject({ status: 'success', workspace: { defaultBranch: 'release' } })
    expect(git(path.join(root, 'canonical-clone'), ['branch', '--show-current'])).toBe('release')
  })

  it('insert failure preserves a ready repository and existing-folder initialization retains .git', async () => {
    const createService = createProjectSetupService({
      addWorkspace: vi.fn().mockRejectedValue(new Error('db unavailable')),
      getWorkspaceByPath: () => undefined,
    })
    const created = path.join(root, 'remove-me')
    const createResult = await createService.execute(
      { operationId: crypto.randomUUID(), kind: 'create', parentPath: root, name: 'remove-me' },
      context().ctx
    )
    expect(createResult).toEqual({ status: 'error', error: { code: 'registration-failed' } })
    // After the commit point, insert failure preserves the ready repository for recovery.
    // Never delete that destination through a predictable path.
    expect(existsSync(created)).toBe(true)
    expect(git(created, ['rev-parse', '--verify', 'HEAD'])).toMatch(/^[0-9a-f]{40}$/)

    const userDir = path.join(root, 'preserve-me')
    mkdirSync(userDir)
    writeFileSync(path.join(userDir, 'keep.txt'), 'keep')
    const initResult = await createService.execute(
      { operationId: crypto.randomUUID(), kind: 'initialize-existing', path: userDir },
      context().ctx
    )
    expect(initResult).toEqual({ status: 'error', error: { code: 'registration-failed' } })
    expect(existsSync(path.join(userDir, '.git'))).toBe(true)
    expect(readFileSync(path.join(userDir, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('after the first mutation, cancellation does not prevent registering an initialized folder', async () => {
    const existing = new Map<string, Workspace>()
    const { controller, ctx } = context()
    const addWorkspace = vi.fn(async (dir: string) => {
      const real = realpathSync(dir)
      controller.abort()
      const workspace = workspaceFor(real)
      existing.set(real, workspace)
      return workspace
    })
    const guardedService = createProjectSetupService({
      addWorkspace,
      getWorkspaceByPath: (dir) => existing.get(dir),
    })
    const dir = path.join(root, 'canceled-at-insert')
    mkdirSync(dir)

    const result = await guardedService.execute(
      { operationId: crypto.randomUUID(), kind: 'initialize-existing', path: dir },
      ctx
    )

    expect(result.status).toBe('success')
    expect(existing.has(dir)).toBe(true)
    expect(existsSync(path.join(dir, '.git'))).toBe(true)
    expect(ctx.markCommitted).toHaveBeenCalledOnce()
  })

  it('after the commit point, cancellation neither prevents registration nor returns canceled', async () => {
    const existing = new Map<string, Workspace>()
    const { controller, ctx } = context()
    const addWorkspace = vi.fn(async (dir: string) => {
      const real = realpathSync(dir)
      controller.abort()
      const workspace = workspaceFor(real, git(real, ['branch', '--show-current']))
      existing.set(real, workspace)
      return workspace
    })
    const committedService = createProjectSetupService({
      addWorkspace,
      getWorkspaceByPath: (dir) => existing.get(dir),
    })

    const result = await committedService.execute(
      { operationId: crypto.randomUUID(), kind: 'create', parentPath: root, name: 'committed' },
      ctx
    )

    expect(result.status).toBe('success')
    expect(existing.has(path.join(root, 'committed'))).toBe(true)
    expect(ctx.markCommitted).toHaveBeenCalledOnce()
  })

  it('rejects credential-bearing URLs before creating the destination', async () => {
    const { service } = serviceFixture()
    const result = await service.execute(
      {
        operationId: crypto.randomUUID(),
        kind: 'clone',
        parentPath: root,
        name: 'secret',
        remoteUrl: 'https://user:token@host/repo.git',
        defaultBranch: 'main',
      },
      context().ctx
    )
    expect(result).toEqual({ status: 'error', error: { code: 'embedded-credentials' } })
    expect(existsSync(path.join(root, 'secret'))).toBe(false)
  })

  it('cancels before the first mutation without initializing an existing folder', async () => {
    const dir = path.join(root, 'cancel-before-mutation')
    mkdirSync(dir)
    const { service, addWorkspace } = serviceFixture()
    const { controller, ctx } = context()
    controller.abort()

    const result = await service.execute(
      { operationId: crypto.randomUUID(), kind: 'initialize-existing', path: dir },
      ctx
    )

    expect(result).toEqual({ status: 'canceled' })
    expect(existsSync(path.join(dir, '.git'))).toBe(false)
    expect(addWorkspace).not.toHaveBeenCalled()
    expect(ctx.markCommitted).not.toHaveBeenCalled()
  })

  it('serializes operations on one destination so the second cannot overwrite the first', async () => {
    let release!: () => void
    let entered = false
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const addWorkspace = vi.fn(async (dir: string) => {
      entered = true
      await blocker
      return workspaceFor(realpathSync(dir))
    })
    const service = createProjectSetupService({ addWorkspace, getWorkspaceByPath: () => undefined })
    const request = { operationId: crypto.randomUUID(), kind: 'create' as const, parentPath: root, name: 'same' }
    const first = service.execute(request, context().ctx)
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 15_000 })

    const second = await service.execute({ ...request, operationId: crypto.randomUUID() }, context().ctx)
    expect(second).toEqual({ status: 'error', error: { code: 'operation-conflict' } })

    release()
    expect((await first).status).toBe('success')
    expect(git(path.join(root, 'same'), ['rev-parse', '--verify', 'HEAD'])).toMatch(/^[0-9a-f]{40}$/)
  })

  it('rejected clone cleanup removes a symlink without following or modifying its target', async () => {
    const target = path.join(root, 'outside')
    const bare = path.join(root, 'empty.git')
    mkdirSync(target)
    writeFileSync(path.join(target, 'keep.txt'), 'keep')
    git(root, ['init', '-q', '--bare', '--initial-branch=main', bare])
    const { service } = serviceFixture()
    const { ctx } = context('cancel')
    const originalWait = ctx.waitForEmptyRemoteDecision
    ctx.waitForEmptyRemoteDecision = vi.fn(async () => {
      symlinkSync(target, path.join(root, 'linked', 'outside-link'))
      return originalWait()
    })

    const result = await service.execute(
      {
        operationId: crypto.randomUUID(),
        kind: 'clone',
        parentPath: root,
        name: 'linked',
        remoteUrl: bare,
      },
      ctx
    )

    expect(result).toEqual({ status: 'canceled' })
    expect(existsSync(path.join(root, 'linked'))).toBe(false)
    expect(readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(root).some((name) => name.startsWith('.maestrly-cleanup-'))).toBe(false)
  })

  it('reports incomplete cleanup if the destination was moved', async () => {
    const bare = path.join(root, 'empty-move.git')
    const destination = path.join(root, 'move-before-cleanup')
    const moved = path.join(root, 'moved-partial')
    git(root, ['init', '-q', '--bare', '--initial-branch=main', bare])
    const { service } = serviceFixture()
    const { ctx } = context('cancel')
    ctx.waitForEmptyRemoteDecision = vi.fn(async () => {
      renameSync(destination, moved)
      return 'cancel' as const
    })

    const result = await service.execute(
      {
        operationId: crypto.randomUUID(),
        kind: 'clone',
        parentPath: root,
        name: 'move-before-cleanup',
        remoteUrl: bare,
      },
      ctx
    )

    expect(result).toEqual({
      status: 'error',
      error: { code: 'cleanup-incomplete', cleanupIncomplete: true },
    })
    expect(existsSync(moved)).toBe(true)
  })

  it('rejects a folder swap before insert without registering the substituted path', async () => {
    const original = path.join(root, 'identity')
    const moved = path.join(root, 'identity-original')
    mkdirSync(original)
    git(original, ['init', '-q', '-b', 'main'])
    git(original, ['config', 'user.name', 'Test'])
    git(original, ['config', 'user.email', 'test@example.com'])
    git(original, ['commit', '-q', '--allow-empty', '-m', 'init'])
    const addWorkspace = vi.fn(async (dir: string, options: { beforeInsert?: () => void } = {}) => {
      renameSync(dir, moved)
      mkdirSync(dir)
      options.beforeInsert?.()
      return workspaceFor(dir)
    })
    const service = createProjectSetupService({ addWorkspace, getWorkspaceByPath: () => undefined })

    const result = await service.execute(
      { operationId: crypto.randomUUID(), kind: 'open', path: original },
      context().ctx
    )

    expect(result).toEqual({ status: 'error', error: { code: 'invalid-path' } })
    expect(addWorkspace).toHaveBeenCalledOnce()
    expect(git(moved, ['rev-parse', '--verify', 'HEAD'])).toMatch(/^[0-9a-f]{40}$/)
    expect(existsSync(path.join(original, '.git'))).toBe(false)
  })

  it('anchors the repository root when opening a subfolder even if the selected inode is replaced', async () => {
    const repo = path.join(root, 'repo-root')
    const moved = path.join(root, 'repo-root-original')
    const selected = path.join(repo, 'nested')
    mkdirSync(repo)
    mkdirSync(selected)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init'])
    const addWorkspace = vi.fn(async (_dir: string, options: { beforeInsert?: () => void } = {}) => {
      renameSync(repo, moved)
      mkdirSync(repo)
      renameSync(path.join(moved, 'nested'), selected)
      options.beforeInsert?.()
      return workspaceFor(repo)
    })
    const service = createProjectSetupService({ addWorkspace, getWorkspaceByPath: () => undefined })

    const result = await service.execute(
      { operationId: crypto.randomUUID(), kind: 'open', path: selected },
      context().ctx
    )

    expect(result).toEqual({ status: 'error', error: { code: 'invalid-path' } })
    expect(addWorkspace).toHaveBeenCalledOnce()
    expect(existsSync(path.join(repo, '.git'))).toBe(false)
    expect(git(moved, ['rev-parse', '--verify', 'HEAD'])).toMatch(/^[0-9a-f]{40}$/)
  })
})
