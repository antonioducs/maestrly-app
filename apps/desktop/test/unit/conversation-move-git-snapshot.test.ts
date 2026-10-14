import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyGitSnapshot,
  createGitSnapshot,
  inspectGitSource,
  keepMovedBackupRef,
  rollbackAppliedSnapshot,
  verifyAppliedSnapshot,
  worktreeTreeOid,
} from '../../src/main/conversation-move/git-snapshot'
import { ensureAppOwnedExcludes } from '../../src/main/git-service'
import { dirty, git, type MoveRepo, makeRemoteRepo, status } from '../helpers/move-repo'

const OP = '0b7c9a1e-3a5c-4d2e-9f00-112233445566'
let repo: MoveRepo
let bundle: string

beforeEach(async () => {
  repo = makeRemoteRepo()
  dirty(repo.work)
  await ensureAppOwnedExcludes(repo.work)
  await mkdir(path.join(repo.work, '.agents/notes'), { recursive: true })
  await writeFile(path.join(repo.work, '.agents/notes/p.md'), '# page\n')
  bundle = path.join(repo.root, 'branch.bundle')
})
afterEach(() => repo.cleanup())

describe('conversation move git snapshot', () => {
  it('inspects branch, commits ahead and changes without blockers', async () => {
    const result = await inspectGitSource(repo.work)
    expect(result).toMatchObject({ branch: 'feat', commitsAhead: 1, defaultBranch: 'main', blockers: [], warnings: [] })
    expect(result.remoteUrl).toBe(repo.remote)
    expect(result.changes.untracked).toEqual(['e.txt'])
    expect(result.changes.staged).toEqual(expect.arrayContaining(['a.txt', 'c.txt']))
  })

  it('blocks a detached HEAD and a repository without origin', async () => {
    git(repo.work, 'checkout', '-q', '--detach')
    expect((await inspectGitSource(repo.work)).blockers.map((blocker) => blocker.code)).toEqual(['detached-head'])
    git(repo.work, 'checkout', '-q', 'feat')
    git(repo.work, 'remote', 'remove', 'origin')
    expect((await inspectGitSource(repo.work)).blockers.map((blocker) => blocker.code)).toEqual(['no-origin'])
  })

  it('snapshots without touching the working tree, the index or the stash', async () => {
    const before = status(repo.work)
    const indexBefore = await readFile(path.join(repo.work, '.git/index'))
    const snapshot = await createGitSnapshot(repo.work, OP, bundle)
    expect(status(repo.work)).toBe(before)
    expect(await readFile(path.join(repo.work, '.git/index'))).toEqual(indexBefore)
    expect(git(repo.work, 'stash', 'list')).toBe('')
    expect(git(repo.work, 'rev-parse', `refs/maestrly/move/${OP}/worktree`)).toBe(snapshot.worktreeCommit)
    expect(git(repo.work, 'rev-parse', `${snapshot.worktreeCommit}^1`)).toBe(snapshot.headOid)
    // Notes and ignored files never enter the working-tree snapshot.
    const files = git(repo.work, 'ls-tree', '-r', '--name-only', snapshot.worktreeTree).split('\n')
    expect(files).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'e.txt', 'f.sh']))
    expect(files).not.toContain('.env.local')
    expect(files).not.toContain('.agents/notes/p.md')
    expect(files).not.toContain('c.txt')
    expect(files).not.toContain('d.txt')
  })

  it('recreates the same branch, commits, index and working tree in another clone', async () => {
    const snapshot = await createGitSnapshot(repo.work, OP, bundle)
    const other = repo.clone('other')
    const dest = path.join(repo.root, 'dest')
    await expect(
      applyGitSnapshot({
        top: other,
        destination: dest,
        operationId: OP,
        bundlePath: bundle,
        snapshot,
        branch: 'feat',
        branchAction: 'create',
      })
    ).resolves.toEqual({ branchCreated: true, previousTipOid: null })
    expect(status(dest)).toBe(status(repo.work))
    expect(await readFile(path.join(dest, 'b.txt'), 'utf8')).toBe(await readFile(path.join(repo.work, 'b.txt'), 'utf8'))
    expect((await stat(path.join(dest, 'f.sh'))).mode & 0o111).not.toBe(0)
    await expect(access(path.join(dest, '.env.local'))).rejects.toThrow()
    await expect(access(path.join(dest, '.agents/notes/p.md'))).rejects.toThrow()
    expect(git(dest, 'log', '-1', '--format=%s', 'HEAD')).toBe('feat work')
    expect(await verifyAppliedSnapshot(dest, snapshot, 'feat')).toBe(true)
    await writeFile(path.join(dest, 'b.txt'), 'changed after import\n')
    expect(await verifyAppliedSnapshot(dest, snapshot, 'feat')).toBe(false)
  })

  it('moves a checkout whose HEAD is already on the remote', async () => {
    git(repo.work, 'push', '-q', 'origin', 'feat')
    git(repo.work, 'fetch', '-q', 'origin')
    const snapshot = await createGitSnapshot(repo.work, OP, bundle)
    const other = repo.clone('other')
    const dest = path.join(repo.root, 'dest')
    await applyGitSnapshot({
      top: other,
      destination: dest,
      operationId: OP,
      bundlePath: bundle,
      snapshot,
      branch: 'feat-moved',
      branchAction: 'create',
    })
    expect(await verifyAppliedSnapshot(dest, snapshot, 'feat-moved')).toBe(true)
  })

  it('fails with base-unavailable when the destination cannot reach the bundle prerequisites', async () => {
    // A fake origin ref at the unpushed commit makes the bundle exclude it; the other clone lacks it.
    git(repo.work, 'update-ref', 'refs/remotes/origin/ghost', 'HEAD')
    const snapshot = await createGitSnapshot(repo.work, OP, bundle)
    const other = repo.clone('other')
    await expect(
      applyGitSnapshot({
        top: other,
        destination: path.join(repo.root, 'dest'),
        operationId: OP,
        bundlePath: bundle,
        snapshot,
        branch: 'feat',
        branchAction: 'create',
      })
    ).rejects.toMatchObject({ code: 'base-unavailable' })
    expect(git(other, 'branch', '--list', 'feat')).toBe('')
  })

  it('fast-forwards an existing ancestor branch and refuses a moved one', async () => {
    const snapshot = await createGitSnapshot(repo.work, OP, bundle)
    const other = repo.clone('other')
    git(other, 'branch', 'feat', 'origin/main')
    const tip = git(other, 'rev-parse', 'feat')
    const args = {
      top: other,
      destination: path.join(repo.root, 'dest'),
      operationId: OP,
      bundlePath: bundle,
      snapshot,
      branch: 'feat',
      branchAction: 'fast-forward' as const,
    }
    await expect(applyGitSnapshot({ ...args, expectedTipOid: 'f'.repeat(40) })).rejects.toMatchObject({
      code: 'branch-changed',
    })
    expect(git(other, 'rev-parse', 'feat')).toBe(tip)
    await expect(applyGitSnapshot({ ...args, expectedTipOid: tip })).resolves.toEqual({
      branchCreated: false,
      previousTipOid: tip,
    })
    expect(git(args.destination, 'rev-parse', 'HEAD')).toBe(snapshot.headOid)
    expect(await verifyAppliedSnapshot(args.destination, snapshot, 'feat')).toBe(true)
  })

  it('refuses a branch checked out elsewhere and leaves nothing behind', async () => {
    const snapshot = await createGitSnapshot(repo.work, OP, bundle)
    const other = repo.clone('other')
    git(other, 'branch', 'feat', 'origin/main')
    const tip = git(other, 'rev-parse', 'feat')
    git(other, 'worktree', 'add', '-q', path.join(repo.root, 'busy'), 'feat')
    await expect(
      applyGitSnapshot({
        top: other,
        destination: path.join(repo.root, 'dest'),
        operationId: OP,
        bundlePath: bundle,
        snapshot,
        branch: 'feat',
        branchAction: 'fast-forward',
        expectedTipOid: tip,
      })
    ).rejects.toMatchObject({ code: 'branch-changed' })
    expect(git(other, 'rev-parse', 'feat')).toBe(tip)
    await expect(access(path.join(repo.root, 'dest'))).rejects.toThrow()
    expect(git(other, 'for-each-ref', `refs/maestrly/incoming/${OP}`)).toBe('')
  })

  it('rolls back the destination worktree, branch and incoming refs', async () => {
    const snapshot = await createGitSnapshot(repo.work, OP, bundle)
    const other = repo.clone('other')
    const dest = path.join(repo.root, 'dest')
    const base = { top: other, destination: dest, operationId: OP, bundlePath: bundle, snapshot, branch: 'feat' }
    const created = await applyGitSnapshot({ ...base, branchAction: 'create' })
    await rollbackAppliedSnapshot({ ...base, ...created, headOid: snapshot.headOid })
    await expect(access(dest)).rejects.toThrow()
    expect(git(other, 'branch', '--list', 'feat')).toBe('')
    expect(git(other, 'for-each-ref', 'refs/maestrly/incoming')).toBe('')

    git(other, 'branch', 'feat', 'origin/main')
    const tip = git(other, 'rev-parse', 'feat')
    const forwarded = await applyGitSnapshot({ ...base, branchAction: 'fast-forward', expectedTipOid: tip })
    await rollbackAppliedSnapshot({ ...base, ...forwarded, headOid: snapshot.headOid })
    expect(git(other, 'rev-parse', 'feat')).toBe(tip)
    await expect(access(dest)).rejects.toThrow()
  })

  it('keeps a backup ref and drops the transfer refs on the source', async () => {
    const snapshot = await createGitSnapshot(repo.work, OP, bundle)
    await keepMovedBackupRef(repo.work, OP)
    expect(git(repo.work, 'rev-parse', `refs/maestrly/moved/${OP}`)).toBe(snapshot.worktreeCommit)
    expect(git(repo.work, 'for-each-ref', `refs/maestrly/move/${OP}`)).toBe('')
  })

  it('computes the working-tree tree without the real index', async () => {
    const before = status(repo.work)
    const tree = await worktreeTreeOid(repo.work)
    expect(tree).toMatch(/^[0-9a-f]{40}$/)
    expect(status(repo.work)).toBe(before)
  })
})
