import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  dropOperationStash,
  executePreparedLocalGit,
  prepareLocalGitOperation,
} from '../../src/main/local-conversation/git'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@test'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(dir, 'tracked.txt'), 'base\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  git(dir, ['branch', '-M', 'main'])
}

let repo: string
beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'local-conv-git-')))
  initRepo(repo)
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('local conversation git', () => {
  it('needs no confirmation when the current branch and commit already match the destination', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n')

    const prepared = await prepareLocalGitOperation(repo, {
      type: 'switch-existing',
      branch: 'main',
      ref: { kind: 'local', name: 'main' },
    })

    expect(prepared.preview).toMatchObject({
      currentBranch: 'main',
      targetBranch: 'main',
      dirty: true,
      requiresConfirmation: false,
    })
    expect(prepared.preview.headOid).toBe(prepared.preview.targetOid)
    expect((await executePreparedLocalGit(prepared)).status).toBe('applied')
    expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('dirty\n')
  })

  it('attaching the current branch ignores activity and pending conflicts without changing checkout', async () => {
    git(repo, ['switch', '-c', 'conflict-side'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'side\n')
    git(repo, ['add', 'tracked.txt'])
    git(repo, ['commit', '-q', '-m', 'side'])
    git(repo, ['switch', 'main'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'main\n')
    git(repo, ['add', 'tracked.txt'])
    git(repo, ['commit', '-q', '-m', 'main'])
    expect(() => git(repo, ['merge', 'conflict-side'])).toThrow()

    const beforeStatus = git(repo, ['status', '--porcelain=v2'])
    const beforeContents = readFileSync(path.join(repo, 'tracked.txt'), 'utf8')
    const mergeHead = git(repo, ['rev-parse', '--git-path', 'MERGE_HEAD'])

    const prepared = await prepareLocalGitOperation(
      repo,
      {
        type: 'switch-existing',
        branch: 'main',
        ref: { kind: 'local', name: 'main' },
      },
      [{ kind: 'chat', count: 1, blocking: true }]
    )

    expect(prepared.blockers).toEqual([])
    expect(prepared.preview).toMatchObject({
      currentBranch: 'main',
      targetBranch: 'main',
      requiresConfirmation: false,
    })
    expect((await executePreparedLocalGit(prepared)).status).toBe('applied')
    expect(git(repo, ['branch', '--show-current'])).toBe('main')
    expect(git(repo, ['status', '--porcelain=v2'])).toBe(beforeStatus)
    expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe(beforeContents)
    expect(existsSync(path.resolve(repo, mergeHead))).toBe(true)
  })

  it('treats the current branch remote namesake as attach-only but blocks other ambiguous names', async () => {
    const remote = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'local-conv-remote-attach-')))
    try {
      git(remote, ['init', '-q', '--bare'])
      git(repo, ['remote', 'add', 'origin', remote])
      git(repo, ['push', '-q', 'origin', 'main'])
      git(repo, ['branch', 'other'])
      git(repo, ['push', '-q', 'origin', 'other'])
      git(repo, ['fetch', '-q', 'origin'])
      writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n')

      // Selecting main from origin while on local main attaches without mutation.
      const attach = await prepareLocalGitOperation(repo, {
        type: 'switch-existing',
        branch: 'main',
        ref: { kind: 'remote', remote: 'origin', name: 'main', ref: 'refs/remotes/origin/main' },
      })
      expect(attach.blockers).toEqual([])
      expect(attach.preview).toMatchObject({
        currentBranch: 'main',
        targetBranch: 'main',
        requiresConfirmation: false,
      })
      expect((await executePreparedLocalGit(attach)).status).toBe('applied')
      expect(git(repo, ['branch', '--show-current'])).toBe('main')
      expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('dirty\n')

      // A local namesake other than the current branch remains ambiguous and blocked.
      const blocked = await prepareLocalGitOperation(repo, {
        type: 'switch-existing',
        branch: 'other',
        ref: { kind: 'remote', remote: 'origin', name: 'other', ref: 'refs/remotes/origin/other' },
      })
      expect(blocked.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'branch-exists' })]))
    } finally {
      rmSync(remote, { recursive: true, force: true })
    }
  })

  it('creates a branch from dirty HEAD without a stash while preserving all local changes', async () => {
    writeFileSync(path.join(repo, 'tracked.txt'), 'staged\n')
    git(repo, ['add', 'tracked.txt'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'staged\nunstaged\n')
    writeFileSync(path.join(repo, 'new.txt'), 'new\n')

    const prepared = await prepareLocalGitOperation(repo, {
      type: 'create-from-head',
      branch: 'feature/head',
    })
    expect(prepared.strategy).toBe('switch-head')
    expect(prepared.preview.changes).toEqual({
      staged: ['tracked.txt'],
      unstaged: ['tracked.txt'],
      untracked: ['new.txt'],
    })
    expect((await executePreparedLocalGit(prepared)).status).toBe('applied')
    expect(git(repo, ['branch', '--show-current'])).toBe('feature/head')
    expect(git(repo, ['stash', 'list'])).toBe('')
    expect(git(repo, ['diff', '--cached', '--name-only'])).toBe('tracked.txt')
    expect(git(repo, ['diff', '--name-only'])).toBe('tracked.txt')
    expect(readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('new\n')
  })

  it('preserves both stash entries during cleanup when a stash already existed', async () => {
    git(repo, ['switch', '-c', 'other'])
    writeFileSync(path.join(repo, 'other.txt'), 'other\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'other'])
    git(repo, ['switch', 'main'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n')
    git(repo, ['add', 'tracked.txt'])
    writeFileSync(path.join(repo, 'new.txt'), 'new\n')
    git(repo, ['stash', 'push', '-u', '-m', 'preexisting'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n')
    git(repo, ['add', 'tracked.txt'])
    writeFileSync(path.join(repo, 'new.txt'), 'new\n')

    const prepared = await prepareLocalGitOperation(repo, {
      type: 'switch-existing',
      branch: 'other',
      ref: { kind: 'local', name: 'other' },
    })
    expect(prepared.strategy).toBe('stash-switch-apply')
    const result = await executePreparedLocalGit(prepared)
    expect(result.status).toBe('applied')
    if (result.status !== 'applied' || !result.stashOid || !result.marker) throw new Error('stash ausente')
    expect(git(repo, ['branch', '--show-current'])).toBe('other')
    expect(git(repo, ['diff', '--cached', '--name-only'])).toBe('tracked.txt')
    expect(existsSync(path.join(repo, 'new.txt'))).toBe(true)
    expect(git(repo, ['stash', 'list'])).toContain(result.marker)
    expect(await dropOperationStash(repo, result.stashOid, result.marker)).toBe(false)
    expect(git(repo, ['stash', 'list'])).toContain(result.marker)
    expect(git(repo, ['stash', 'list'])).toContain('preexisting')
  })

  it('removes the operation stash by CAS when it is the only entry', async () => {
    git(repo, ['switch', '-c', 'target'])
    writeFileSync(path.join(repo, 'target.txt'), 'target\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'target'])
    git(repo, ['switch', 'main'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n')

    const prepared = await prepareLocalGitOperation(repo, {
      type: 'switch-existing',
      branch: 'target',
      ref: { kind: 'local', name: 'target' },
    })
    const result = await executePreparedLocalGit(prepared)
    if (result.status !== 'applied' || !result.stashOid || !result.marker) {
      throw new Error('operation stash is missing')
    }

    expect(await dropOperationStash(repo, result.stashOid, result.marker)).toBe(true)
    expect(git(repo, ['stash', 'list'])).toBe('')
  })

  it('preserves a concurrent newer stash and refuses automatic deletion', async () => {
    git(repo, ['switch', '-c', 'target'])
    writeFileSync(path.join(repo, 'target.txt'), 'target\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'target'])
    git(repo, ['switch', 'main'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n')

    const prepared = await prepareLocalGitOperation(repo, {
      type: 'switch-existing',
      branch: 'target',
      ref: { kind: 'local', name: 'target' },
    })
    const result = await executePreparedLocalGit(prepared)
    if (result.status !== 'applied' || !result.stashOid || !result.marker) {
      throw new Error('operation stash is missing')
    }
    writeFileSync(path.join(repo, 'concurrent.txt'), 'concurrent\n')
    git(repo, ['stash', 'push', '-u', '-m', 'concurrent'])

    expect(await dropOperationStash(repo, result.stashOid, result.marker)).toBe(false)
    const stashes = git(repo, ['stash', 'list'])
    expect(stashes).toContain(result.marker)
    expect(stashes).toContain('concurrent')
  })

  it('detects changes between prepare and execute without mutating the branch', async () => {
    const prepared = await prepareLocalGitOperation(repo, {
      type: 'create-from-head',
      branch: 'feature/stale',
    })
    writeFileSync(path.join(repo, 'later.txt'), 'changed')
    expect((await executePreparedLocalGit(prepared)).status).toBe('stale')
    expect(git(repo, ['branch', '--show-current'])).toBe('main')
  })

  it('pins branch creation to the displayed OID even if its ref moves later', async () => {
    git(repo, ['branch', 'base'])
    const prepared = await prepareLocalGitOperation(repo, {
      type: 'create-from-ref',
      branch: 'feature/pinned',
      ref: { kind: 'local', name: 'base' },
    })
    writeFileSync(path.join(repo, 'later.txt'), 'later\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'later'])
    git(repo, ['branch', '-f', 'base', 'HEAD'])

    const result = await executePreparedLocalGit(prepared)
    expect(result.status).toBe('stale')
    expect(git(repo, ['branch', '--show-current'])).toBe('main')
  })

  it('excludes ordinary ignored files from the stash and blocks destination collisions', async () => {
    writeFileSync(path.join(repo, '.gitignore'), '.mcp.json\n.claude/settings.local.json\n')
    git(repo, ['add', '.gitignore'])
    git(repo, ['commit', '-q', '-m', 'ignore'])
    git(repo, ['switch', '-c', 'tracks-config'])
    writeFileSync(path.join(repo, '.mcp.json'), 'tracked')
    git(repo, ['add', '-f', '.mcp.json'])
    git(repo, ['commit', '-q', '-m', 'track config'])
    git(repo, ['switch', 'main'])
    mkdirSync(path.join(repo, '.claude'), { recursive: true })
    writeFileSync(path.join(repo, '.mcp.json'), 'local secret')
    writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}')
    writeFileSync(path.join(repo, 'dirty.txt'), 'dirty')

    const prepared = await prepareLocalGitOperation(repo, {
      type: 'switch-existing',
      branch: 'tracks-config',
      ref: { kind: 'local', name: 'tracks-config' },
    })
    expect(prepared.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ignored-collision', paths: ['.mcp.json'] })])
    )
    expect((await executePreparedLocalGit(prepared)).status).toBe('blocked')
    expect(readFileSync(path.join(repo, '.mcp.json'), 'utf8')).toBe('local secret')
    expect(existsSync(path.join(repo, '.claude', 'settings.local.json'))).toBe(true)
  })

  it('restores staged and unstaged changes in the same file when switching trees', async () => {
    git(repo, ['switch', '-c', 'target'])
    writeFileSync(path.join(repo, 'target.txt'), 'target\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'target'])
    git(repo, ['switch', 'main'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'staged\n')
    git(repo, ['add', 'tracked.txt'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'staged\nunstaged\n')

    const prepared = await prepareLocalGitOperation(repo, {
      type: 'switch-existing',
      branch: 'target',
      ref: { kind: 'local', name: 'target' },
    })
    const result = await executePreparedLocalGit(prepared)
    expect(result.status).toBe('applied')
    expect(git(repo, ['diff', '--cached', '--name-only'])).toBe('tracked.txt')
    expect(git(repo, ['diff', '--name-only'])).toBe('tracked.txt')
  })

  it('preserves the stash when a filter changes restored content despite successful apply', async () => {
    writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=inject\n')
    git(repo, ['config', 'filter.inject.clean', "sed 's/X$//'"])
    git(repo, ['config', 'filter.inject.smudge', "sed 's/$/X/'"])
    git(repo, ['add', '.gitattributes'])
    git(repo, ['commit', '-q', '-m', 'filter'])
    git(repo, ['switch', '-c', 'target'])
    writeFileSync(path.join(repo, 'target'), 'target\n')
    git(repo, ['add', 'target'])
    git(repo, ['commit', '-q', '-m', 'target'])
    git(repo, ['switch', 'main'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n')

    const prepared = await prepareLocalGitOperation(repo, {
      type: 'switch-existing',
      branch: 'target',
      ref: { kind: 'local', name: 'target' },
    })
    const result = await executePreparedLocalGit(prepared)

    expect(result.status).toBe('recovery-required')
    expect(readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('dirtyX\n')
    expect(git(repo, ['stash', 'list'])).toContain('maestrly-local:')
  })

  it('preserves the stash on apply conflict without automatic cleanup', async () => {
    git(repo, ['switch', '-c', 'target'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'target\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'target'])
    git(repo, ['switch', 'main'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'local dirty\n')

    const prepared = await prepareLocalGitOperation(repo, {
      type: 'switch-existing',
      branch: 'target',
      ref: { kind: 'local', name: 'target' },
    })
    const result = await executePreparedLocalGit(prepared)
    expect(result.status).toBe('recovery-required')
    expect(git(repo, ['branch', '--show-current'])).toBe('target')
    expect(git(repo, ['ls-files', '-u'])).not.toBe('')
    expect(git(repo, ['stash', 'list'])).toContain('maestrly-local:')
    if (result.status === 'recovery-required') {
      expect(result.recovery.commands).not.toEqual(expect.arrayContaining([expect.stringContaining('stash apply')]))
    }
  })

  it('uses no-overwrite-ignore as the final barrier against late files', async () => {
    writeFileSync(path.join(repo, '.gitignore'), 'late.txt\n')
    git(repo, ['add', '.gitignore'])
    git(repo, ['commit', '-q', '-m', 'ignore late'])
    git(repo, ['switch', '-c', 'target'])
    writeFileSync(path.join(repo, 'late.txt'), 'tracked target\n')
    git(repo, ['add', '-f', 'late.txt'])
    git(repo, ['commit', '-q', '-m', 'track late'])
    git(repo, ['switch', 'main'])

    const prepared = await prepareLocalGitOperation(repo, {
      type: 'switch-existing',
      branch: 'target',
      ref: { kind: 'local', name: 'target' },
    })
    writeFileSync(path.join(repo, 'late.txt'), 'local secret\n')
    const result = await executePreparedLocalGit(prepared)

    expect(result.status).toBe('blocked')
    expect(readFileSync(path.join(repo, 'late.txt'), 'utf8')).toBe('local secret\n')
    expect(git(repo, ['branch', '--show-current'])).toBe('main')
  })

  it('keeps noncolliding ignored configuration on disk and outside stash -u', async () => {
    writeFileSync(path.join(repo, '.gitignore'), '.mcp.json\n.claude/settings.local.json\n')
    git(repo, ['add', '.gitignore'])
    git(repo, ['commit', '-q', '-m', 'ignore'])
    git(repo, ['switch', '-c', 'target'])
    writeFileSync(path.join(repo, 'target.txt'), 'target\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'target'])
    git(repo, ['switch', 'main'])
    mkdirSync(path.join(repo, '.claude'), { recursive: true })
    writeFileSync(path.join(repo, '.mcp.json'), 'secret')
    writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}')
    writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n')

    const prepared = await prepareLocalGitOperation(repo, {
      type: 'switch-existing',
      branch: 'target',
      ref: { kind: 'local', name: 'target' },
    })
    const result = await executePreparedLocalGit(prepared)
    expect(result.status).toBe('applied')
    if (result.status !== 'applied' || !result.stashOid) throw new Error('stash ausente')
    expect(readFileSync(path.join(repo, '.mcp.json'), 'utf8')).toBe('secret')
    expect(existsSync(path.join(repo, '.claude', 'settings.local.json'))).toBe(true)
    expect(git(repo, ['stash', 'show', '--include-untracked', '--name-only', result.stashOid])).not.toContain(
      '.mcp.json'
    )
  })

  it('creates tracking for dirty remote-only branches and blocks ambiguous remote names', async () => {
    const remoteA = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'local-conv-remote-a-')))
    const remoteB = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'local-conv-remote-b-')))
    try {
      git(remoteA, ['init', '-q', '--bare'])
      git(remoteB, ['init', '-q', '--bare'])
      git(repo, ['remote', 'add', 'origin', remoteA])
      git(repo, ['remote', 'add', 'backup', remoteB])
      git(repo, ['switch', '-c', 'seed'])
      writeFileSync(path.join(repo, 'remote.txt'), 'remote\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'remote'])
      git(repo, ['push', '-q', 'origin', 'seed:remote-only'])
      git(repo, ['switch', 'main'])
      git(repo, ['branch', '-D', 'seed'])
      git(repo, ['fetch', '-q', 'origin'])
      writeFileSync(path.join(repo, 'local.txt'), 'dirty')

      const unique = await prepareLocalGitOperation(repo, {
        type: 'switch-existing',
        branch: 'remote-only',
        ref: {
          kind: 'remote',
          remote: 'origin',
          name: 'remote-only',
          ref: 'refs/remotes/origin/remote-only',
        },
      })
      expect(unique.strategy).toBe('stash-switch-apply')
      expect((await executePreparedLocalGit(unique)).status).toBe('applied')
      expect(git(repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/remote-only')

      git(repo, ['push', '-q', 'backup', 'HEAD:remote-only'])
      git(repo, ['fetch', '-q', 'backup'])
      const ambiguous = await prepareLocalGitOperation(repo, {
        type: 'switch-existing',
        branch: 'another-local',
        ref: {
          kind: 'remote',
          remote: 'origin',
          name: 'remote-only',
          ref: 'refs/remotes/origin/remote-only',
        },
      })
      expect(ambiguous.blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'remote-ambiguous' })])
      )

      // Ambiguity uses exact matches: feature/xyz on the same remote does not make xyz ambiguous.
      git(repo, ['push', '-q', 'origin', 'HEAD:xyz'])
      git(repo, ['push', '-q', 'origin', 'HEAD:feature/xyz'])
      git(repo, ['fetch', '-q', 'origin'])
      const suffixHomonym = await prepareLocalGitOperation(repo, {
        type: 'switch-existing',
        branch: 'xyz',
        ref: { kind: 'remote', remote: 'origin', name: 'xyz', ref: 'refs/remotes/origin/xyz' },
      })
      expect(suffixHomonym.blockers).toEqual([])
    } finally {
      rmSync(remoteA, { recursive: true, force: true })
      rmSync(remoteB, { recursive: true, force: true })
    }
  })

  it('blocks branches open in another worktree before mutation', async () => {
    const worktree = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'local-conv-wt-')))
    rmSync(worktree, { recursive: true, force: true })
    git(repo, ['worktree', 'add', '-q', '-b', 'occupied', worktree])
    try {
      const prepared = await prepareLocalGitOperation(repo, {
        type: 'switch-existing',
        branch: 'occupied',
        ref: { kind: 'local', name: 'occupied' },
      })
      expect(prepared.blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'branch-in-worktree' })])
      )
    } finally {
      git(repo, ['worktree', 'remove', '--force', worktree])
    }
  })

  it.each([
    ['rebase-merge', true],
    ['rebase-apply', true],
    ['CHERRY_PICK_HEAD', false],
    ['REVERT_HEAD', false],
    ['sequencer', true],
    ['BISECT_START', false],
  ] as const)('blocks an in-progress Git state: %s', async (gitPath, directory) => {
    const target = git(repo, ['rev-parse', '--git-path', gitPath])
    if (directory) mkdirSync(path.isAbsolute(target) ? target : path.join(repo, target), { recursive: true })
    else writeFileSync(path.isAbsolute(target) ? target : path.join(repo, target), git(repo, ['rev-parse', 'HEAD']))
    const prepared = await prepareLocalGitOperation(repo, {
      type: 'create-from-head',
      branch: `feature/${gitPath.toLowerCase()}`,
    })
    expect(prepared.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'git-operation' })]))
  })

  it('blocks dirty submodules', async () => {
    const sub = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'local-conv-sub-')))
    try {
      initRepo(sub)
      git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub'])
      git(repo, ['commit', '-q', '-am', 'submodule'])
      writeFileSync(path.join(repo, 'vendor/sub/tracked.txt'), 'dirty submodule\n')
      const prepared = await prepareLocalGitOperation(repo, {
        type: 'create-from-head',
        branch: 'feature/submodule',
      })
      expect(prepared.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'submodule-dirty' })]))
    } finally {
      rmSync(sub, { recursive: true, force: true })
    }
  })

  it('validates branch names in main and blocks an active merge', async () => {
    const invalid = await prepareLocalGitOperation(repo, {
      type: 'create-from-head',
      branch: '-bad',
    })
    expect(invalid.blockers[0]?.code).toBe('branch-invalid')

    writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), git(repo, ['rev-parse', 'HEAD']))
    const merge = await prepareLocalGitOperation(repo, {
      type: 'create-from-head',
      branch: 'good',
    })
    expect(merge.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'git-operation' })]))
  })
})
