import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMaestroSwarmGit } from '../../src/main/chat/maestro-swarm-git'

const tempDirs: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()
}

function makeTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'maestro-swarm-git-'))
  tempDirs.push(dir)
  git(dir, ['init', '-b', 'main'])
  writeFileSync(path.join(dir, 'README.md'), 'init\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-m', 'init'])
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('createMaestroSwarmGit', () => {
  it('resolves branch tips and checks ancestor status for merged, unmerged, and bogus refs', async () => {
    const repo = makeTempRepo()

    // Create a branch and merge it into main.
    git(repo, ['checkout', '-b', 'feat/merged'])
    writeFileSync(path.join(repo, 'merged.txt'), 'merged\n')
    git(repo, ['add', 'merged.txt'])
    git(repo, ['commit', '-m', 'merged work'])
    const expectedMergedTip = git(repo, ['rev-parse', 'HEAD'])

    git(repo, ['checkout', 'main'])
    git(repo, ['merge', '--no-ff', 'feat/merged', '-m', 'merge feat/merged'])

    // Create another branch that is NOT merged into main.
    git(repo, ['checkout', '-b', 'feat/unmerged'])
    writeFileSync(path.join(repo, 'unmerged.txt'), 'unmerged\n')
    git(repo, ['add', 'unmerged.txt'])
    git(repo, ['commit', '-m', 'unmerged work'])
    const expectedUnmergedTip = git(repo, ['rev-parse', 'HEAD'])

    // Return to main as HEAD.
    git(repo, ['checkout', 'main'])

    const swarmGit = createMaestroSwarmGit(repo)

    const mergedTip = await swarmGit.branchTip('feat/merged')
    const unmergedTip = await swarmGit.branchTip('feat/unmerged')
    const missingTip = await swarmGit.branchTip('feat/does-not-exist')

    expect(mergedTip).toBe(expectedMergedTip)
    expect(unmergedTip).toBe(expectedUnmergedTip)
    expect(missingTip).toBeNull()

    expect(await swarmGit.isAncestor(mergedTip!)).toBe(true)
    expect(await swarmGit.isAncestor(unmergedTip!)).toBe(false)
    expect(await swarmGit.isAncestor('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull()
  })
})
