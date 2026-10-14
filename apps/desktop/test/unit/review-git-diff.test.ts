import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatGitSnapshot,
  readDiffStats,
  readGitSnapshot,
  snapshotHasChanges,
} from '../../src/main/chat/review/git-diff'

let dir = ''

function git(...args: string[]) {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'review-git-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('review git snapshot', () => {
  it('reports a folder that is not a repository', async () => {
    const snapshot = await readGitSnapshot(dir)
    expect(snapshot.repository).toBe(false)
    expect(snapshotHasChanges(snapshot)).toBe(false)
  })

  it('shows staged, unstaged and untracked changes of a checkout', async () => {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    writeFileSync(path.join(dir, 'a.txt'), 'one\n')
    git('add', 'a.txt')
    git('commit', '-qm', 'init')
    expect(snapshotHasChanges(await readGitSnapshot(dir))).toBe(false)

    writeFileSync(path.join(dir, 'a.txt'), 'two\n')
    writeFileSync(path.join(dir, 'b.txt'), 'staged\n')
    git('add', 'b.txt')
    writeFileSync(path.join(dir, 'c.txt'), 'new\n')
    const snapshot = await readGitSnapshot(dir)
    expect(snapshot).toMatchObject({ repository: true, branch: 'main', untracked: ['c.txt'], truncated: false })
    expect(snapshot.staged).toContain('+staged')
    expect(snapshot.unstaged).toContain('+two')
    expect(snapshotHasChanges(snapshot)).toBe(true)
    const text = formatGitSnapshot(snapshot)
    expect(text).toContain('## Staged')
    expect(text).toContain('## Untracked\nc.txt')
  })

  it('counts the lines of every changed, staged, new and untracked file since the base', async () => {
    expect(await readDiffStats(dir)).toEqual({ repository: false, branch: '', head: '', files: [] })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n')
    writeFileSync(path.join(dir, 'gone.txt'), 'bye\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    expect((await readDiffStats(dir)).files).toEqual([])

    writeFileSync(path.join(dir, 'a.txt'), 'one\nthree\nfour\n')
    rmSync(path.join(dir, 'gone.txt'))
    writeFileSync(path.join(dir, 'staged.txt'), 'a\nb\n')
    git('add', 'staged.txt')
    writeFileSync(path.join(dir, 'new.txt'), 'x\ny\nz\n')
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0]))
    const stats = await readDiffStats(dir)
    expect(stats).toMatchObject({ repository: true, branch: 'main' })
    expect(stats.files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'a.txt', added: 2, deleted: 1 },
      { path: 'blob.bin', isNew: true },
      { path: 'gone.txt', added: 0, deleted: 1 },
      { path: 'new.txt', added: 3, deleted: 0, isNew: true },
      { path: 'staged.txt', added: 2, deleted: 0, isNew: true },
    ])
  })
})
