import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureTree,
  forgetCapturedTreesForTests,
  MAX_SNAPSHOT_FILE_BYTES,
} from '../../src/main/turn-snapshots/capture'
import { collectStore, directorySize, recordRef, sweepStores } from '../../src/main/turn-snapshots/gc'
import { applyTargets, isSafeTreePath } from '../../src/main/turn-snapshots/restore'
import {
  resolveSnapshotDir,
  setTurnSnapshotsRoot,
  storesDir,
  type SnapshotDir,
} from '../../src/main/turn-snapshots/store'
import { diffPatch, diffTrees, readBlobs, treeEntries } from '../../src/main/turn-snapshots/tree'

const temps: string[] = []
function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  temps.push(dir)
  return dir
}

/**
 * The fixture's own Git, with background maintenance off: newer Git versions run it after a commit, and it would
 * change the `.git` these tests prove the snapshots never touch.
 */
function git(cwd: string, ...args: string[]): string {
  const config = ['user.name=t', 'user.email=t@t', 'commit.gpgsign=false', 'maintenance.auto=false', 'gc.auto=0']
  return execFileSync('git', [...config.flatMap((entry) => ['-c', entry]), ...args], {
    cwd,
    encoding: 'utf8',
  })
}

function write(root: string, file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), content)
}

/** Every file under `dir` with its SHA-256, to prove a directory is byte-for-byte unchanged. */
function digestTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const rel = path.relative(dir, full).split(path.sep).join('/')
      if (entry.isDirectory()) walk(full)
      else if (entry.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`
      else out[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  }
  walk(dir)
  return out
}

/** Restores every path that changed between `to` and `from` back to `from`, as an undo does. */
async function undo(dir: SnapshotDir, from: string, to: string) {
  const changes = await diffTrees(dir.store, from, to)
  const entries = await treeEntries(
    dir.store,
    from,
    changes.map((change) => change.path)
  )
  return applyTargets(
    dir.store,
    dir.workTree,
    changes.map((change) => ({ path: change.path, entry: entries.get(change.path) ?? null }))
  )
}

let root: string
beforeEach(() => {
  root = tempDir('turn-snapshots-root-')
  setTurnSnapshotsRoot(root)
  forgetCapturedTreesForTests()
})
afterEach(() => {
  setTurnSnapshotsRoot(null)
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('plain folders', { timeout: 30_000 }, () => {
  it('restores modified, created and deleted files, and removes the folders a creation left', async () => {
    const work = tempDir('turn-snapshots-plain-')
    write(work, 'a.txt', 'alpha\n')
    write(work, 'dir/b.txt', 'beta\n')
    const dir = await resolveSnapshotDir(work)
    expect(dir.store.meta.kind).toBe('plain')
    const start = await captureTree(dir)
    const before = digestTree(work)

    // What a turn's bash commands do: plain filesystem changes, no tool involved.
    write(work, 'a.txt', 'alpha changed\n')
    fs.rmSync(path.join(work, 'dir/b.txt'))
    write(work, 'new/deep/c.txt', 'gamma\n')
    const end = await captureTree(dir)

    const changes = await diffTrees(dir.store, start.tree, end.tree)
    expect(changes.map((change) => [change.path, change.status]).sort()).toEqual([
      ['a.txt', 'modified'],
      ['dir/b.txt', 'deleted'],
      ['new/deep/c.txt', 'added'],
    ])
    expect(changes.find((change) => change.path === 'a.txt')).toMatchObject({ additions: 1, deletions: 1 })

    const outcome = await undo(dir, start.tree, end.tree)
    expect(outcome.failed).toEqual([])
    expect(digestTree(work)).toEqual(before)
    expect(fs.existsSync(path.join(work, 'new'))).toBe(false)
  })

  it('honors .gitignore and the default excludes of folders without Git', async () => {
    const work = tempDir('turn-snapshots-ignore-')
    write(work, '.gitignore', 'build/\n')
    write(work, 'src/index.js', 'x\n')
    const dir = await resolveSnapshotDir(work)
    const start = await captureTree(dir)
    write(work, 'build/out.js', 'compiled\n')
    write(work, 'node_modules/pkg/index.js', 'dep\n')
    write(work, '.DS_Store', 'finder\n')
    write(work, 'src/index.js', 'y\n')
    const end = await captureTree(dir)
    const changes = await diffTrees(dir.store, start.tree, end.tree)
    expect(changes.map((change) => change.path)).toEqual(['src/index.js'])
  })

  it('leaves files above the size limit out and reports them', async () => {
    const work = tempDir('turn-snapshots-large-')
    write(work, 'small.txt', 'small\n')
    const dir = await resolveSnapshotDir(work)
    const start = await captureTree(dir)
    write(work, 'big.bin', Buffer.alloc(MAX_SNAPSHOT_FILE_BYTES + 1, 1))
    const end = await captureTree(dir)
    expect(end.skipped.map((file) => file.path)).toEqual(['big.bin'])
    expect(await diffTrees(dir.store, start.tree, end.tree)).toEqual([])
    // A large file created during the turn can still be undone: the start state is its absence.
    const outcome = await applyTargets(dir.store, dir.workTree, [{ path: 'big.bin', entry: null }])
    expect(outcome.restored).toEqual(['big.bin'])
    expect(fs.existsSync(path.join(work, 'big.bin'))).toBe(false)
  })

  it('restores binary content, CRLF, Unicode and spaced names byte for byte', async () => {
    const work = tempDir('turn-snapshots-bytes-')
    const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13])
    write(work, 'data.bin', binary)
    write(work, 'crlf.txt', 'one\r\ntwo\r\n')
    write(work, 'ção e espaço/arquivo ü.txt', 'unicode\n')
    const dir = await resolveSnapshotDir(work)
    const start = await captureTree(dir)
    const before = digestTree(work)
    write(work, 'data.bin', Buffer.from([9, 9, 9]))
    write(work, 'crlf.txt', 'one\ntwo\n')
    fs.rmSync(path.join(work, 'ção e espaço'), { recursive: true })
    const end = await captureTree(dir)
    const binaryChange = (await diffTrees(dir.store, start.tree, end.tree)).find((c) => c.path === 'data.bin')
    expect(binaryChange?.binary).toBe(true)
    const outcome = await undo(dir, start.tree, end.tree)
    expect(outcome.failed).toEqual([])
    expect(digestTree(work)).toEqual(before)
    expect(fs.readFileSync(path.join(work, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n')
  })

  it.skipIf(process.platform === 'win32')('keeps the executable bit and symbolic links', async () => {
    const work = tempDir('turn-snapshots-modes-')
    write(work, 'run.sh', '#!/bin/sh\necho hi\n')
    fs.chmodSync(path.join(work, 'run.sh'), 0o755)
    fs.symlinkSync('run.sh', path.join(work, 'link'))
    const dir = await resolveSnapshotDir(work)
    const start = await captureTree(dir)
    fs.rmSync(path.join(work, 'run.sh'))
    fs.rmSync(path.join(work, 'link'))
    const end = await captureTree(dir)
    const outcome = await undo(dir, start.tree, end.tree)
    expect(outcome.failed).toEqual([])
    expect(fs.statSync(path.join(work, 'run.sh')).mode & 0o111).not.toBe(0)
    expect(fs.readlinkSync(path.join(work, 'link'))).toBe('run.sh')
  })

  it('leaves an embedded repository out of the snapshot', async () => {
    const work = tempDir('turn-snapshots-embedded-')
    write(work, 'top.txt', 'top\n')
    const dir = await resolveSnapshotDir(work)
    const start = await captureTree(dir)
    const nested = path.join(work, 'nested')
    fs.mkdirSync(nested)
    git(nested, 'init', '-q')
    write(nested, 'inner.txt', 'inner\n')
    const end = await captureTree(dir)
    expect(await diffTrees(dir.store, start.tree, end.tree)).toEqual([])
  })

  it('refuses a folder that holds the snapshots themselves', async () => {
    await expect(resolveSnapshotDir(path.dirname(root))).rejects.toMatchObject({ reason: 'contains-profile' })
  })
})

describe('repositories', { timeout: 30_000 }, () => {
  function makeRepo(): string {
    const repo = tempDir('turn-snapshots-repo-')
    git(repo, 'init', '-q', '-b', 'main')
    write(repo, 'tracked.txt', 'one\n')
    write(repo, 'lib/util.ts', 'export {}\n')
    write(repo, '.gitignore', 'dist/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    return repo
  }

  it('never writes inside the user repository and seeds from its index', async () => {
    const repo = makeRepo()
    write(repo, 'untracked.txt', 'u\n')
    const gitBefore = digestTree(path.join(repo, '.git'))
    const statusBefore = git(repo, 'status', '--porcelain=v1', '-uall')

    const dir = await resolveSnapshotDir(repo)
    expect(dir.store.meta.kind).toBe('git')
    const start = await captureTree(dir)
    expect(dir.store.meta.dirs[dir.dirKey]?.seeded).toBe(true)
    write(repo, 'tracked.txt', 'two\n')
    fs.rmSync(path.join(repo, 'lib/util.ts'))
    write(repo, 'added.txt', 'added\n')
    write(repo, 'dist/bundle.js', 'ignored\n')
    const end = await captureTree(dir)
    const changes = await diffTrees(dir.store, start.tree, end.tree)
    expect(changes.map((change) => [change.path, change.status]).sort()).toEqual([
      ['added.txt', 'added'],
      ['lib/util.ts', 'deleted'],
      ['tracked.txt', 'modified'],
    ])
    const outcome = await undo(dir, start.tree, end.tree)
    expect(outcome.failed).toEqual([])
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('one\n')
    expect(fs.readFileSync(path.join(repo, 'lib/util.ts'), 'utf8')).toBe('export {}\n')
    expect(fs.existsSync(path.join(repo, 'added.txt'))).toBe(false)
    fs.rmSync(path.join(repo, 'dist'), { recursive: true })

    expect(digestTree(path.join(repo, '.git'))).toEqual(gitBefore)
    expect(git(repo, 'status', '--porcelain=v1', '-uall')).toBe(statusBefore)
    // The seeded blob of the unchanged tracked file stays in the user's repository, borrowed only for reading.
    const unchanged = (await treeEntries(dir.store, start.tree, ['.gitignore'])).get('.gitignore')!
    expect(
      fs.existsSync(path.join(dir.store.gitDir, 'objects', unchanged.oid.slice(0, 2), unchanged.oid.slice(2)))
    ).toBe(false)
  })

  it('restores the bytes on disk when the repository normalizes line endings', async () => {
    const repo = tempDir('turn-snapshots-eol-')
    git(repo, 'init', '-q', '-b', 'main')
    write(repo, '.gitattributes', '* text=auto\n')
    write(repo, 'windows.txt', 'a\r\nb\r\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    // Git stored LF but the file on disk keeps CRLF, and the user's index calls it clean.
    expect(git(repo, 'status', '--porcelain')).toBe('')
    const dir = await resolveSnapshotDir(repo)
    const start = await captureTree(dir)
    write(repo, 'windows.txt', 'changed\n')
    const end = await captureTree(dir)
    const outcome = await undo(dir, start.tree, end.tree)
    expect(outcome.failed).toEqual([])
    expect(fs.readFileSync(path.join(repo, 'windows.txt'), 'utf8')).toBe('a\r\nb\r\n')
  })

  it('shares one store between the worktrees of a repository', async () => {
    const repo = makeRepo()
    const worktree = path.join(tempDir('turn-snapshots-wt-'), 'feature')
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree)
    const main = await resolveSnapshotDir(repo)
    const other = await resolveSnapshotDir(worktree)
    expect(other.store).toBe(main.store)
    expect(other.dirKey).not.toBe(main.dirKey)
    const start = await captureTree(other)
    write(worktree, 'tracked.txt', 'feature\n')
    const end = await captureTree(other)
    await undo(other, start.tree, end.tree)
    expect(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8')).toBe('one\n')
    expect(git(worktree, 'status', '--porcelain')).toBe('')
  })

  it('keeps a clean checkout alive under a ref, though its trees come from the user index', async () => {
    const repo = makeRepo()
    const worktree = path.join(tempDir('turn-snapshots-clean-'), 'clean')
    git(repo, 'worktree', 'add', '-q', '-b', 'clean', worktree)
    const dir = await resolveSnapshotDir(worktree)
    // Nothing changed: write-tree answers from the seeded cache tree, whose objects only the user's repository has.
    const start = await captureTree(dir, { ref: recordRef('clean', 'start-0') })
    expect(start.tree).toBe(git(repo, 'rev-parse', 'HEAD^{tree}').trim())
    write(worktree, 'lib/util.ts', 'export const changed = 1\n')
    const end = await captureTree(dir, { ref: recordRef('clean', 'end-0') })
    const outcome = await undo(dir, start.tree, end.tree)
    expect(outcome.failed).toEqual([])
    expect(fs.readFileSync(path.join(worktree, 'lib/util.ts'), 'utf8')).toBe('export {}\n')
    await collectStore(dir.store, new Set(['clean']), { indexMaxIdleMs: 60_000, force: true })
    expect((await treeEntries(dir.store, start.tree, ['tracked.txt'])).get('tracked.txt')).toBeTruthy()
  })

  it('reads a patch and blob contents of a captured change', async () => {
    const repo = makeRepo()
    const dir = await resolveSnapshotDir(repo)
    const start = await captureTree(dir)
    write(repo, 'tracked.txt', 'two\n')
    const end = await captureTree(dir)
    const { patch, truncated } = await diffPatch(dir.store, start.tree, end.tree, 'tracked.txt', 256 * 1024)
    expect(truncated).toBe(false)
    expect(patch).toContain('-one')
    expect(patch).toContain('+two')
    const entry = (await treeEntries(dir.store, start.tree, ['tracked.txt'])).get('tracked.txt')!
    expect((await readBlobs(dir.store, [entry.oid])).get(entry.oid)?.toString('utf8')).toBe('one\n')
  })
})

describe('restoring', { timeout: 30_000 }, () => {
  it('rejects paths that could leave the folder', () => {
    expect(isSafeTreePath('a/b.txt')).toBe(true)
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', '.git/config', 'sub/.GIT/hooks/x', 'a\\b'])
      expect(isSafeTreePath(bad)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('refuses to write through a parent that became a link', async () => {
    const work = tempDir('turn-snapshots-contain-')
    const outside = tempDir('turn-snapshots-outside-')
    write(work, 'sub/file.txt', 'inside\n')
    const dir = await resolveSnapshotDir(work)
    const start = await captureTree(dir)
    fs.rmSync(path.join(work, 'sub'), { recursive: true })
    fs.symlinkSync(outside, path.join(work, 'sub'))
    const entry = (await treeEntries(dir.store, start.tree, ['sub/file.txt'])).get('sub/file.txt')!
    const outcome = await applyTargets(dir.store, dir.workTree, [{ path: 'sub/file.txt', entry }])
    expect(outcome.failed).toEqual([{ path: 'sub/file.txt', reason: 'parent-link' }])
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('reports content the store no longer has', async () => {
    const work = tempDir('turn-snapshots-missing-')
    const dir = await resolveSnapshotDir(work)
    const outcome = await applyTargets(dir.store, dir.workTree, [
      {
        path: 'gone.txt',
        entry: { mode: '100644', oid: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'.replace('e', 'f') },
      },
    ])
    expect(outcome.failed).toEqual([{ path: 'gone.txt', reason: 'unavailable' }])
  })
})

describe('collection', { timeout: 30_000 }, () => {
  it('keeps what live records and indexes reach, and prunes the rest', async () => {
    const work = tempDir('turn-snapshots-gc-')
    write(work, 'keep.txt', 'keep\n')
    const dir = await resolveSnapshotDir(work)
    await captureTree(dir, { ref: recordRef('live', 'start') })
    write(work, 'temp.txt', 'only in a dropped record\n')
    const dropped = await captureTree(dir, { ref: recordRef('dropped', 'end') })
    fs.rmSync(path.join(work, 'temp.txt'))
    await captureTree(dir)
    const tempEntry = (await treeEntries(dir.store, dropped.tree, ['temp.txt'])).get('temp.txt')!

    const result = await collectStore(dir.store, new Set(['live']), { indexMaxIdleMs: 60_000 })
    expect(result.removedRefs).toBe(1)
    expect(result.packed).toBe(true)
    expect((await readBlobs(dir.store, [tempEntry.oid])).size).toBe(0)
    // The folder's current files stay readable through the index ref, and the next capture is unchanged.
    const keep = await captureTree(dir)
    const entry = (await treeEntries(dir.store, keep.tree, ['keep.txt'])).get('keep.txt')!
    expect((await readBlobs(dir.store, [entry.oid])).get(entry.oid)?.toString('utf8')).toBe('keep\n')
  })

  it('removes idle stores no record uses', async () => {
    const work = tempDir('turn-snapshots-sweep-')
    write(work, 'x.txt', 'x\n')
    const dir = await resolveSnapshotDir(work)
    await captureTree(dir)
    expect(await directorySize(storesDir())).toBeGreaterThan(0)
    const kept = await sweepStores(new Set([dir.store.key]), { maxIdleMs: 0, now: Date.now() + 1000 })
    expect(kept.removedStores).toEqual([])
    const swept = await sweepStores(new Set(), { maxIdleMs: 0, now: Date.now() + 1000 })
    expect(swept.removedStores).toEqual([dir.store.key])
    expect(fs.existsSync(dir.store.gitDir)).toBe(false)
  })
})
