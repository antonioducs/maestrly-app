import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrationGitAdapter } from '../../src/main/conversation-migration/git-adapter'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function directoryFingerprint(root: string): string {
  const hash = createHash('sha256')
  const framed = (value: string | Buffer) => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value
    const length = Buffer.allocUnsafe(8)
    length.writeBigUInt64BE(BigInt(bytes.length))
    hash.update(length).update(bytes)
  }
  const visit = (absolute: string, relative: string): void => {
    const stat = lstatSync(absolute)
    const type = stat.isSymbolicLink() ? 'l' : stat.isFile() ? 'f' : stat.isDirectory() ? 'd' : 'o'
    framed(type)
    framed(relative)
    framed(String(stat.mode & 0o7777))
    if (type === 'l') {
      framed(readlinkSync(absolute))
    } else if (type === 'f') {
      framed(createHash('sha256').update(readFileSync(absolute)).digest())
    } else if (type === 'd') {
      for (const entry of readdirSync(absolute).sort()) {
        visit(path.join(absolute, entry), relative ? `${relative}/${entry}` : entry)
      }
    } else {
      framed(String(stat.size))
    }
  }
  visit(root, '')
  return hash.digest('hex')
}

function simulateWorktreeRemovalBoundary(plan: Awaited<ReturnType<typeof migrationGitAdapter.prepare>>): void {
  renameSync(destination, plan.rollbackQuarantine)
  writeFileSync(`${plan.rollbackQuarantine}.fingerprint`, directoryFingerprint(plan.rollbackQuarantine), {
    mode: 0o600,
  })
  git(repo, ['worktree', 'remove', '--force', destination])
}

let root: string
let repo: string
let destination: string
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'migration-git-')))
  repo = path.join(root, 'repo')
  destination = path.join(root, 'destination')
  execFileSync('git', ['init', '-q', repo])
  git(repo, ['config', 'user.email', 'test@test'])
  git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  git(repo, ['branch', '-M', 'main'])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('conversation migration git adapter', () => {
  it('transfers the batch to the exact HEAD worktree and preserves the stash until finalize', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'staged\n')
    git(repo, ['add', 'tracked.txt'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'staged\nunstaged\n')
    writeFileSync(path.join(repo, 'new.txt'), 'new\n')

    const plan = await migrationGitAdapter.prepare({
      cwd: repo,
      branch: 'feature/migrated',
      destination,
    })
    expect(plan.source.blockers).toEqual([])
    const result = await migrationGitAdapter.execute(plan)
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') throw new Error('transfer failed')

    expect(git(repo, ['branch', '--show-current'])).toBe('main')
    expect(git(repo, ['status', '--porcelain'])).toBe('')
    expect(git(destination, ['branch', '--show-current'])).toBe('feature/migrated')
    expect(git(destination, ['rev-parse', 'HEAD'])).toBe(plan.source.headOid)
    expect(git(destination, ['diff', '--cached', '--name-only'])).toBe('tracked.txt')
    expect(git(destination, ['diff', '--name-only'])).toBe('tracked.txt')
    expect(readFileSync(path.join(destination, 'new.txt'), 'utf8')).toBe('new\n')
    expect(git(repo, ['stash', 'list'])).toContain(result.marker)
    expect(await migrationGitAdapter.finalize(plan, result.stashOid, result.marker)).toBe(true)
    expect(git(repo, ['stash', 'list'])).toBe('')
  })

  it('adopts new work at the destination without requiring the original snapshot', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'lote migrado\n')
    const plan = await migrationGitAdapter.prepare({ cwd: repo, branch: 'feature/adopt', destination })
    const result = await migrationGitAdapter.execute(plan)
    if (result.status !== 'applied') throw new Error('transfer failed')

    writeFileSync(path.join(destination, 'after-migration.txt'), 'trabalho novo\n')

    expect(await migrationGitAdapter.verify(plan)).toBe(false)
    expect(await migrationGitAdapter.verifyDestination(plan)).toBe(true)
    expect(await migrationGitAdapter.finalize(plan, result.stashOid, result.marker)).toBe(true)
    expect(git(repo, ['stash', 'list'])).toBe('')
  })

  it('blocks a dirty tree with an existing stash to avoid trapping finalization', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'stash preexistente\n')
    git(repo, ['stash', 'push', '-m', 'preexisting'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty from migration\n')

    const plan = await migrationGitAdapter.prepare({
      cwd: repo,
      branch: 'feature/stash-preexisting',
      destination,
    })

    expect(plan.source.blockers).toContainEqual(
      expect.objectContaining({
        code: 'git-operation',
        message: expect.stringContaining('A stash already exists'),
      })
    )
    expect(await migrationGitAdapter.execute(plan)).toMatchObject({ status: 'blocked' })
    expect(git(repo, ['stash', 'list'])).toContain('preexisting')
  })

  it('rollback restores the source batch and removes the worktree and branch', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n')
    const plan = await migrationGitAdapter.prepare({ cwd: repo, branch: 'feature/rollback', destination })
    const result = await migrationGitAdapter.execute(plan)
    if (result.status !== 'applied') throw new Error('transfer failed')

    expect(await migrationGitAdapter.rollback(plan, result.stashOid)).toBe(true)
    expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('dirty\n')
    expect(git(repo, ['branch', '--list', 'feature/rollback'])).toBe('')
  })

  it('safely resumes after a crash immediately following stash creation', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty after stash\n')
    const plan = await migrationGitAdapter.prepare({ cwd: repo, branch: 'feature/stash-crash', destination })
    git(repo, ['stash', 'push', '-u', '-m', plan.stashMarker])
    const stashOid = git(repo, ['rev-parse', 'refs/stash'])

    const resumed = await migrationGitAdapter.continue(plan)
    expect(resumed).toMatchObject({ status: 'applied', stashOid, marker: plan.stashMarker })
    expect(readFileSync(path.join(destination, 'tracked.txt'), 'utf8')).toBe('dirty after stash\n')
    expect(git(repo, ['status', '--porcelain'])).toBe('')
  })

  it('rolls back using the marker after a crash before persisting the stash OID', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'staged before crash\n')
    git(repo, ['add', 'tracked.txt'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'staged before crash\nunstaged before crash\n')
    writeFileSync(path.join(repo, 'new.txt'), 'untracked before crash\n')
    const plan = await migrationGitAdapter.prepare({
      cwd: repo,
      branch: 'feature/stash-oid-crash',
      destination,
    })
    git(repo, ['stash', 'push', '-u', '-m', plan.stashMarker])
    const stashOid = git(repo, ['rev-parse', 'refs/stash'])

    expect(await migrationGitAdapter.rollback(plan)).toBe(true)
    expect(git(repo, ['diff', '--cached', '--name-only'])).toBe('tracked.txt')
    expect(git(repo, ['diff', '--name-only'])).toBe('tracked.txt')
    expect(readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('untracked before crash\n')
    expect(await migrationGitAdapter.discardStash(plan, undefined, plan.stashMarker)).toBe(true)
    expect(git(repo, ['stash', 'list'])).not.toContain(stashOid)
  })

  it('resumes or rolls back after a crash between worktree creation and stash application', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty before apply\n')
    const plan = await migrationGitAdapter.prepare({ cwd: repo, branch: 'feature/apply-crash', destination })
    git(repo, ['stash', 'push', '-u', '-m', plan.stashMarker])
    const stashOid = git(repo, ['rev-parse', 'refs/stash'])
    git(repo, ['worktree', 'add', '--no-track', '-b', plan.source.target.branch, destination, plan.source.headOid])

    const resumed = await migrationGitAdapter.continue(plan)
    expect(resumed).toMatchObject({ status: 'applied', stashOid })
    expect(readFileSync(path.join(destination, 'tracked.txt'), 'utf8')).toBe('dirty before apply\n')

    // Repeat the boundary with another plan to verify compensation without applying at the destination.
    expect(await migrationGitAdapter.rollback(plan, stashOid)).toBe(true)
    expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('dirty before apply\n')
    expect(await migrationGitAdapter.discardStash(plan, stashOid, plan.stashMarker)).toBe(true)

    const pristinePlan = await migrationGitAdapter.prepare({
      cwd: repo,
      branch: 'feature/pristine-rollback',
      destination,
    })
    git(repo, ['stash', 'push', '-u', '-m', pristinePlan.stashMarker])
    const pristineStashOid = git(repo, ['rev-parse', 'refs/stash'])
    git(repo, [
      'worktree',
      'add',
      '--no-track',
      '-b',
      pristinePlan.source.target.branch,
      destination,
      pristinePlan.source.headOid,
    ])
    expect(await migrationGitAdapter.rollback(pristinePlan, pristineStashOid)).toBe(true)
    expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('dirty before apply\n')
  }, 20_000)

  it('resumes rollback after a crash immediately after worktree quarantine', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty before removal\n')
    const plan = await migrationGitAdapter.prepare({
      cwd: repo,
      branch: 'feature/quarantine-before-remove',
      destination,
    })
    const result = await migrationGitAdapter.execute(plan)
    if (result.status !== 'applied') throw new Error('transfer failed')

    renameSync(destination, plan.rollbackQuarantine)

    expect(await migrationGitAdapter.isRolledBack(plan)).toBe(false)
    expect(await migrationGitAdapter.rollback(plan, result.stashOid)).toBe(true)
    expect(existsSync(plan.rollbackQuarantine)).toBe(false)
    expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('dirty before removal\n')
  })

  it('resumes rollback after worktree removal with quarantine remaining', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty em quarentena\n')
    const plan = await migrationGitAdapter.prepare({
      cwd: repo,
      branch: 'feature/quarantine-recovery',
      destination,
    })
    const result = await migrationGitAdapter.execute(plan)
    if (result.status !== 'applied') throw new Error('transfer failed')

    simulateWorktreeRemovalBoundary(plan)

    expect(await migrationGitAdapter.isRolledBack(plan)).toBe(false)
    expect(existsSync(plan.rollbackQuarantine)).toBe(true)
    expect(await migrationGitAdapter.rollback(plan, result.stashOid)).toBe(true)
    expect(existsSync(plan.rollbackQuarantine)).toBe(false)
    expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('dirty em quarentena\n')
  })

  it('resumes rollback after a crash at the deletion tombstone', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty no tombstone\n')
    const plan = await migrationGitAdapter.prepare({
      cwd: repo,
      branch: 'feature/tombstone-recovery',
      destination,
    })
    const result = await migrationGitAdapter.execute(plan)
    if (result.status !== 'applied') throw new Error('transfer failed')

    simulateWorktreeRemovalBoundary(plan)
    renameSync(plan.rollbackQuarantine, `${plan.rollbackQuarantine}.deleting`)

    expect(await migrationGitAdapter.rollback(plan, result.stashOid)).toBe(true)
    expect(existsSync(`${plan.rollbackQuarantine}.deleting`)).toBe(false)
    expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('dirty no tombstone\n')
  })

  it('preserves work recreated at the original path during tombstone deletion', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty concorrente\n')
    const plan = await migrationGitAdapter.prepare({
      cwd: repo,
      branch: 'feature/tombstone-race',
      destination,
    })
    const result = await migrationGitAdapter.execute(plan)
    if (result.status !== 'applied') throw new Error('transfer failed')

    simulateWorktreeRemovalBoundary(plan)
    renameSync(plan.rollbackQuarantine, `${plan.rollbackQuarantine}.deleting`)
    writeFileSync(plan.rollbackQuarantine, 'trabalho novo\n')

    expect(await migrationGitAdapter.rollback(plan, result.stashOid)).toBe(false)
    expect(readFileSync(plan.rollbackQuarantine, 'utf8')).toBe('trabalho novo\n')
    expect(existsSync(`${plan.rollbackQuarantine}.deleting`)).toBe(true)
  })

  it('preserves divergent quarantine after removing the Git registration', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty preservado\n')
    const plan = await migrationGitAdapter.prepare({
      cwd: repo,
      branch: 'feature/quarantine-diverged',
      destination,
    })
    const result = await migrationGitAdapter.execute(plan)
    if (result.status !== 'applied') throw new Error('transfer failed')

    simulateWorktreeRemovalBoundary(plan)
    writeFileSync(path.join(plan.rollbackQuarantine, 'external.txt'), 'do not delete\n')

    expect(await migrationGitAdapter.rollback(plan, result.stashOid)).toBe(false)
    expect(readFileSync(path.join(plan.rollbackQuarantine, 'external.txt'), 'utf8')).toBe('do not delete\n')
    expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('base\n')
  })

  it('rollback refuses to delete a branch that advanced after worktree removal', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty com branch concorrente\n')
    const plan = await migrationGitAdapter.prepare({
      cwd: repo,
      branch: 'feature/branch-race',
      destination,
    })
    const result = await migrationGitAdapter.execute(plan)
    if (result.status !== 'applied') throw new Error('transfer failed')

    simulateWorktreeRemovalBoundary(plan)
    rmSync(plan.rollbackQuarantine, { recursive: true })
    rmSync(`${plan.rollbackQuarantine}.fingerprint`, { force: true })
    git(repo, ['update-ref', `refs/heads/${plan.source.target.branch}`, plan.source.headOid])
    writeFileSync(path.join(repo, 'concurrent.txt'), 'commit externo\n')
    git(repo, ['add', 'concurrent.txt'])
    git(repo, ['commit', '-qm', 'commit concorrente'])
    const concurrentOid = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['update-ref', `refs/heads/${plan.source.target.branch}`, concurrentOid])
    git(repo, ['reset', '--hard', '-q', plan.source.headOid])

    expect(await migrationGitAdapter.rollback(plan, result.stashOid)).toBe(false)
    expect(git(repo, ['rev-parse', `refs/heads/${plan.source.target.branch}`])).toBe(concurrentOid)
  })

  it('rollback refuses to remove a worktree containing new destination work', async () => {
    const plan = await migrationGitAdapter.prepare({ cwd: repo, branch: 'feature/external', destination })
    const result = await migrationGitAdapter.execute(plan)
    if (result.status !== 'applied') throw new Error('transfer failed')
    writeFileSync(path.join(destination, 'external.txt'), 'do not delete\n')

    expect(await migrationGitAdapter.rollback(plan, result.stashOid)).toBe(false)
    expect(readFileSync(path.join(destination, 'external.txt'), 'utf8')).toBe('do not delete\n')
    expect(git(repo, ['branch', '--list', 'feature/external'])).toContain('feature/external')
  })
})
