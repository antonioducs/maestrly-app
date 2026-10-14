import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatGitSnapshot, readGitSnapshot, snapshotHasChanges } from '../../src/main/chat/review/git-diff'

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
})
