import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  moveWorktree,
  slugifyBranch,
  excludeFromGitInfo,
  APP_OWNED_EXCLUDES,
  hasUnmergedFiles,
  isMergeInProgress,
  hasConflictMarkers,
  isBranchPushed,
  baseExists,
  listBranches,
  gitEnvInfo,
  getDefaultBranch,
  currentGitHead,
} from '../../src/main/git-service'
import { worktreeRelPath, workspaceDataRelPath } from '../../src/main/app-paths'

/**
 * External worktree regression coverage (#143): conversation cwd lives outside the user repository.
 * Creation uses the injected destination under a separate userData-style directory.
 * The user repository remains clean and info/exclude is shared through the common gitdir.
 * The worktree also stays clean, and reuse, removal and listing remain supported.
 *
 * Create a temporary repository outside the project and a separate external base.
 * Pure app-path helpers receive an injected base; Electron imports use the Vitest stub.
 * Test paths never depend on the real Electron profile.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@test'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(dir, 'README.md'), '# repo\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  git(dir, ['branch', '-M', 'main']) // Idempotent if already on main.
}

function installPostCheckoutHook(dir: string, body: string): void {
  writeFileSync(path.join(dir, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

const missingGitLfsHook =
  'printf >&2 "This repository is configured for Git LFS but \'git-lfs\' was not found on your path.\\n"\nexit 2'

// ── fixtures ──────────────────────────────────────────────────────────────────

let repo: string // User repository.
let ext: string // External base simulating userData.

beforeEach(() => {
  // Resolve symlinks because macOS temporary paths may use /tmp while Git lists /private/tmp.
  // Fixtures and returned worktree paths must use the same realpath before comparison.
  repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'gitsvc-repo-')))
  ext = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'gitsvc-ext-')))
  initRepo(repo)
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(ext, { recursive: true, force: true })
})

// Pure functions.

describe('gitEnvInfo supplies branch and dirty state to the system prompt', () => {
  it('a clean repository returns main and dirty=false', async () => {
    expect(await gitEnvInfo(repo)).toEqual({ branch: 'main', dirty: false })
  })

  it('uncommitted changes return dirty=true', async () => {
    writeFileSync(path.join(repo, 'novo.txt'), 'x')
    expect(await gitEnvInfo(repo)).toEqual({ branch: 'main', dirty: true })
  })

  it('reflects the current branch after checkout', async () => {
    git(repo, ['checkout', '-q', '-b', 'feature/x'])
    expect(await gitEnvInfo(repo)).toMatchObject({ branch: 'feature/x' })
  })

  it('returns null outside a Git repository', async () => {
    expect(await gitEnvInfo(ext)).toBeNull() // The external temporary directory has no Git repository.
  })
})

describe('getDefaultBranch', () => {
  it('prefers the effective symbolic HEAD before conventional fallbacks', async () => {
    git(repo, ['checkout', '-q', '-b', 'develop'])
    expect(await getDefaultBranch(repo)).toBe('develop')
  })
})

describe('currentGitHead', () => {
  it('returns the current symbolic branch', async () => {
    expect(await currentGitHead(repo)).toEqual({ kind: 'branch', name: 'main' })
  })

  it('identifies detached HEAD with a short SHA', async () => {
    const sha = git(repo, ['rev-parse', '--short', 'HEAD'])
    git(repo, ['checkout', '-q', '--detach', 'HEAD'])

    expect(await currentGitHead(repo)).toEqual({ kind: 'detached', commit: sha })
  })

  it('returns unavailable outside a repository', async () => {
    expect(await currentGitHead(ext)).toEqual({ kind: 'unavailable' })
  })
})

describe('slugifyBranch', () => {
  it('replaces slash separators with hyphens and sanitizes other characters', () => {
    expect(slugifyBranch('feature/x')).toBe('feature-x')
    expect(slugifyBranch('a/b\\c')).toBe('a-b-c')
    expect(slugifyBranch('feat@123')).toBe('feat_123')
  })
})

describe('worktreeRelPath and workspaceDataRelPath are pure with an injected base', () => {
  it('worktreeRelPath isolates paths by workspace and branch', () => {
    expect(worktreeRelPath('/base', 'ws1', 'feature/x')).toBe(path.join('/base', 'worktrees', 'ws1', 'feature-x'))
    expect(worktreeRelPath('/base', 'ws1', 'main')).not.toBe(worktreeRelPath('/base', 'ws2', 'main'))
    expect(worktreeRelPath('/base', 'ws1', 'a')).not.toBe(worktreeRelPath('/base', 'ws1', 'b'))
  })
  it('produces the same path for identical inputs', () => {
    expect(worktreeRelPath('/base', 'ws1', 'x')).toBe(worktreeRelPath('/base', 'ws1', 'x'))
  })
  it('workspaceDataRelPath anchors paths by workspace', () => {
    expect(workspaceDataRelPath('/base', 'ws1')).toBe(path.join('/base', 'workspace-data', 'ws1'))
  })
})

// createWorktree with an external destination.

describe('createWorktree with an external destination', () => {
  it('creates a complete checkout outside the repository and returns its destination', async () => {
    const dest = worktreeRelPath(ext, 'ws1', 'feature/x')
    const wt = await createWorktree({ top: repo, branch: 'feature/x', base: 'main', isNewBranch: true, dest })

    expect(wt).toBe(dest)
    expect(wt.startsWith(repo)).toBe(false) // Outside the user repository.
    expect(existsSync(path.join(wt, 'README.md'))).toBe(true) // Complete checkout.
    expect(statSync(path.join(wt, '.git')).isFile()).toBe(true) // .git is a gitdir pointer file rather than a directory.
  })

  it('app-owned files do not dirty the original repository or external worktree', async () => {
    const dest = worktreeRelPath(ext, 'ws1', 'feature/x')
    const wt = await createWorktree({ top: repo, branch: 'feature/x', base: 'main', isNewBranch: true, dest })

    mkdirSync(path.join(wt, '.maestrly'), { recursive: true })
    writeFileSync(path.join(wt, '.maestrly', 'agent-selection.json'), '{}')
    writeFileSync(path.join(wt, '.maestrly', 'agent-navigation.json'), '{}')

    expect(git(repo, ['status', '--porcelain'])).toBe('') // User repository unchanged.
    expect(git(wt, ['status', '--porcelain'])).toBe('') // Clean worktree using shared info/exclude.
  })

  it('excludes specific app files without hiding user files', async () => {
    const dest = worktreeRelPath(ext, 'ws1', 'feature/x')
    await createWorktree({ top: repo, branch: 'feature/x', base: 'main', isNewBranch: true, dest })
    // A user rule in the main repository must remain visible, not hidden by broad directory exclusions.
    // -uall lists individual files instead of grouping untracked directories.
    mkdirSync(path.join(repo, '.legacy-tool', 'rules'), { recursive: true })
    writeFileSync(path.join(repo, '.legacy-tool', 'rules', 'my-rule.mdc'), 'user rule')
    expect(git(repo, ['status', '--porcelain', '-uall'])).toContain('.legacy-tool/rules/my-rule.mdc')
  })

  it('populates the shared info/exclude with the app-owned catalog', async () => {
    const dest = worktreeRelPath(ext, 'ws1', 'feature/x')
    await createWorktree({ top: repo, branch: 'feature/x', base: 'main', isNewBranch: true, dest })
    const content = readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
    for (const entry of APP_OWNED_EXCLUDES) expect(content).toContain(entry)
  })

  it('reuses the same worktree path for repeated requests for a branch', async () => {
    const dest = worktreeRelPath(ext, 'ws1', 'feature/x')
    const a = await createWorktree({ top: repo, branch: 'feature/x', base: 'main', isNewBranch: true, dest })
    const b = await createWorktree({ top: repo, branch: 'feature/x', base: 'main', isNewBranch: true, dest })
    expect(b).toBe(a)
    expect((await listWorktrees(repo)).filter((w) => w.branch === 'feature/x')).toHaveLength(1)
  })

  it('accepts an intact worktree on the first attempt when only a stale Git LFS hook fails', async () => {
    installPostCheckoutHook(repo, missingGitLfsHook)
    const dest = worktreeRelPath(ext, 'ws1', 'feature/stale-lfs-hook')

    await expect(
      createWorktree({ top: repo, branch: 'feature/stale-lfs-hook', base: 'main', isNewBranch: true, dest })
    ).resolves.toBe(dest)
    expect(git(dest, ['branch', '--show-current'])).toBe('feature/stale-lfs-hook')
    expect(git(dest, ['status', '--porcelain'])).toBe('')
  })

  it('does not ignore missing Git LFS when the commit contains an LFS pointer', async () => {
    writeFileSync(path.join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(
      path.join(repo, 'asset.bin'),
      'version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 1\n'
    )
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'add lfs pointer'])
    installPostCheckoutHook(repo, missingGitLfsHook)
    const dest = worktreeRelPath(ext, 'ws1', 'feature/real-lfs')

    await expect(
      createWorktree({ top: repo, branch: 'feature/real-lfs', base: 'main', isNewBranch: true, dest })
    ).rejects.toThrow("'git-lfs' was not found")
  })

  it('does not ignore arbitrary post-checkout hook failures', async () => {
    installPostCheckoutHook(repo, 'printf >&2 "project hook failed\\n"\nexit 2')
    const dest = worktreeRelPath(ext, 'ws1', 'feature/failing-hook')

    await expect(
      createWorktree({ top: repo, branch: 'feature/failing-hook', base: 'main', isNewBranch: true, dest })
    ).rejects.toThrow('project hook failed')
  })

  it('refuses to reuse a branch already open inside the user repository for an external destination', async () => {
    const dest = worktreeRelPath(ext, 'ws1', 'main')

    await expect(createWorktree({ top: repo, branch: 'main', base: 'main', isNewBranch: false, dest })).rejects.toThrow(
      'is already open in a worktree inside the repository'
    )
  })

  it('lists the external worktree and removes it through the repository root', async () => {
    const dest = worktreeRelPath(ext, 'ws1', 'feature/x')
    const wt = await createWorktree({ top: repo, branch: 'feature/x', base: 'main', isNewBranch: true, dest })
    expect((await listWorktrees(repo)).some((w) => w.path === wt)).toBe(true)
    await removeWorktree(repo, wt, true)
    expect((await listWorktrees(repo)).some((w) => w.path === wt)).toBe(false)
  })

  it('preserves the historical .claude/worktrees fallback when dest is omitted', async () => {
    const wt = await createWorktree({ top: repo, branch: 'feature/y', base: 'main', isNewBranch: true })
    expect(wt).toBe(path.join(repo, '.claude', 'worktrees', 'feature-y'))
    expect(existsSync(path.join(wt, 'README.md'))).toBe(true)
  })

  it('sets push.default=current only in the worktree without changing the main repository', async () => {
    const dest = worktreeRelPath(ext, 'ws1', 'feature/9')
    const wt = await createWorktree({ top: repo, branch: 'feature/9', base: 'main', isNewBranch: true, dest })
    // Worktree-only push.default=current and autoSetupRemote create a matching origin branch.
    expect(git(wt, ['config', '--worktree', '--get', 'push.default'])).toBe('current')
    expect(git(wt, ['config', '--worktree', '--get', 'push.autoSetupRemote'])).toBe('true')
    // The main repository retains an unset push.default; git config --get exits with code 1.
    expect(() => git(repo, ['config', '--get', 'push.default'])).toThrow()
  })

  it('creates the feature branch without tracking the base upstream', async () => {
    const dest = worktreeRelPath(ext, 'ws1', 'feature/9')
    const wt = await createWorktree({ top: repo, branch: 'feature/9', base: 'main', isNewBranch: true, dest })
    // No upstream makes rev-parse fail and prevents misleading up-to-date-with-main status.
    expect(() => git(wt, ['rev-parse', '--abbrev-ref', 'feature/9@{upstream}'])).toThrow()
  })
})

// baseExists validates the configurable base (#557).
describe('baseExists (#557)', () => {
  it('returns true for an existing local branch', async () => {
    expect(await baseExists(repo, 'main')).toBe(true)
    git(repo, ['branch', 'develop'])
    expect(await baseExists(repo, 'develop')).toBe(true)
  })

  it('returns false for a missing branch', async () => {
    expect(await baseExists(repo, 'ghost')).toBe(false)
  })

  it('fetches best-effort and recognizes a remote-only branch', async () => {
    const remote = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'gitsvc-remote-')))
    try {
      git(remote, ['init', '-q', '--bare'])
      git(repo, ['remote', 'add', 'origin', remote])
      git(repo, ['push', '-q', 'origin', 'main'])
      // Create release remotely, then delete the local branch and tracking ref to force a fetch.
      git(repo, ['branch', 'release'])
      git(repo, ['push', '-q', 'origin', 'release'])
      git(repo, ['branch', '-D', 'release'])
      gitTry(repo, ['update-ref', '-d', 'refs/remotes/origin/release'])

      expect(await baseExists(repo, 'release')).toBe(true) // Found through fetch.
      expect(await baseExists(repo, 'ghost')).toBe(false) // Absent everywhere.
    } finally {
      rmSync(remote, { recursive: true, force: true })
    }
  })

  it('rejects worktree creation from a nonexistent base', async () => {
    const dest = worktreeRelPath(ext, 'ws1', 'novella')
    await expect(
      createWorktree({ top: repo, branch: 'novella', base: 'ghost', isNewBranch: true, dest })
    ).rejects.toThrow()
  })
})

describe('listBranches', () => {
  it('lists local and remote branches without symbolic HEAD refs', async () => {
    git(repo, ['branch', 'develop'])
    const remote = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'gitsvc-remote-')))
    try {
      git(remote, ['init', '-q', '--bare'])
      git(repo, ['remote', 'add', 'origin', remote])
      git(repo, ['push', '-q', 'origin', 'main'])
      // Keep feature/api remote-only by deleting the local branch after push.
      git(repo, ['branch', 'feature/api'])
      git(repo, ['push', '-q', 'origin', 'feature/api'])
      git(repo, ['fetch', '-q', 'origin'])
      git(repo, ['branch', '-D', 'feature/api'])
      // set-head creates origin/HEAD, which Git can also expose as the phantom origin ref.
      gitTry(repo, ['remote', 'set-head', 'origin', 'main'])

      const info = await listBranches(repo)
      expect(info.local).toContain('main')
      expect(info.local).toContain('develop')
      expect(info.remote).toContain('feature/api') // Remote branch without a local equivalent.
      expect(info.remoteRefs).toContainEqual({
        remote: 'origin',
        name: 'feature/api',
        ref: 'refs/remotes/origin/feature/api',
      })
      expect(info.remote).not.toContain('origin') // Exclude the phantom ref regression.
      expect(info.remote).not.toContain('HEAD')
      expect(info.remote).not.toContain('main') // A local equivalent must not appear again in remoteOnly.
    } finally {
      rmSync(remote, { recursive: true, force: true })
    }
  })
})

describe('moveWorktree', () => {
  it('moves the worktree and updates the Git registration', async () => {
    const from = worktreeRelPath(ext, 'ws1', 'feature/x')
    await createWorktree({ top: repo, branch: 'feature/x', base: 'main', isNewBranch: true, dest: from })
    const to = path.join(ext, 'worktrees', 'ws1', 'moved')
    await moveWorktree(repo, from, to)

    expect(existsSync(path.join(to, 'README.md'))).toBe(true)
    const paths = (await listWorktrees(repo)).map((w) => w.path)
    expect(paths).toContain(to)
    expect(paths).not.toContain(from)
  })
})

// Merge preconditions and postconditions (#321).
// Nonthrowing Git helper for expected conflicts and best-effort fixture commands.
function gitTry(cwd: string, args: string[]): void {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
  } catch {
    /* esperado em merge conflitado / set-upstream */
  }
}

/** Leave repo on feature with a conflicted merge from main and divergent foo.txt changes. */
function makeConflict(dir: string): void {
  writeFileSync(path.join(dir, 'foo.txt'), 'base\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base'])
  git(dir, ['switch', '-c', 'feature'])
  writeFileSync(path.join(dir, 'foo.txt'), 'feature side\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'feat'])
  git(dir, ['switch', 'main'])
  writeFileSync(path.join(dir, 'foo.txt'), 'main side\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'mainchg'])
  git(dir, ['switch', 'feature'])
  gitTry(dir, ['merge', 'main']) // Expected conflict: active merge, unmerged files and markers.
}

describe('hasUnmergedFiles / isMergeInProgress / hasConflictMarkers (#321)', () => {
  it('returns false for every conflict check in a clean repository', async () => {
    expect(await hasUnmergedFiles(repo)).toBe(false)
    expect(await isMergeInProgress(repo)).toBe(false)
    expect(await hasConflictMarkers(repo)).toBe(false)
  })

  it('detects unmerged files, active merge and conflict markers during a conflicted merge', async () => {
    makeConflict(repo)
    expect(await hasUnmergedFiles(repo)).toBe(true)
    expect(await isMergeInProgress(repo)).toBe(true)
    expect(await hasConflictMarkers(repo)).toBe(true)
  })

  it('clears every conflict check after git merge --abort', async () => {
    makeConflict(repo)
    gitTry(repo, ['merge', '--abort'])
    expect(await hasUnmergedFiles(repo)).toBe(false)
    expect(await isMergeInProgress(repo)).toBe(false)
    expect(await hasConflictMarkers(repo)).toBe(false)
  })

  it('detects committed conflict markers even with a clean index', async () => {
    // Simulate accidentally committed markers with no active merge or unmerged index entries.
    writeFileSync(path.join(repo, 'c.txt'), '<<<<<<< HEAD\nlado a\n=======\nlado b\n>>>>>>> outro\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'oops markers'])
    expect(await isMergeInProgress(repo)).toBe(false)
    expect(await hasUnmergedFiles(repo)).toBe(false)
    expect(await hasConflictMarkers(repo)).toBe(true)
  })
})

describe('isBranchPushed handles an upstream pointing to origin/main', () => {
  it('returns false before push and true after an explicit HEAD:<branch> push', async () => {
    const remote = mkdtempSync(path.join(os.tmpdir(), 'gitsvc-remote-'))
    git(remote, ['init', '-q', '--bare'])
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['push', '-q', 'origin', 'main'])

    // The feature branch starts from main with origin/main as its upstream.
    // An implicit push could target the wrong ref; isBranchPushed queries ls-remote directly.
    git(repo, ['switch', '-c', 'feature-x'])
    gitTry(repo, ['branch', '--set-upstream-to=origin/main'])
    writeFileSync(path.join(repo, 'k.txt'), 'k\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'k'])

    expect(await isBranchPushed(repo, 'feature-x')).toBe(false) // Only main exists remotely.
    git(repo, ['push', '-q', 'origin', 'HEAD:feature-x']) // Explicit refspec as required by the prompt.
    expect(await isBranchPushed(repo, 'feature-x')).toBe(true)

    rmSync(remote, { recursive: true, force: true })
  })

  it('returns false without a configured remote without throwing', async () => {
    expect(await isBranchPushed(repo, 'main')).toBe(false)
  })
})

describe('excludeFromGitInfo', () => {
  it('is idempotent without duplicating entries', async () => {
    await excludeFromGitInfo(repo, ['.foo', '.bar'])
    await excludeFromGitInfo(repo, ['.foo', '.bar'])
    const lines = readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n')
    expect(lines.filter((l) => l === '.foo')).toHaveLength(1)
  })
  it('is a no-op outside a Git repository', async () => {
    const notRepo = mkdtempSync(path.join(os.tmpdir(), 'notrepo-'))
    await expect(excludeFromGitInfo(notRepo, ['.x'])).resolves.toBeUndefined()
    rmSync(notRepo, { recursive: true, force: true })
  })
})
