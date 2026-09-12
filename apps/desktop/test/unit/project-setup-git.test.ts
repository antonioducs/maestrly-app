import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cloneRepository,
  createInitialCommit,
  createReadme,
  hasUsableHead,
  initializeMainRepository,
  parseCloneProgress,
  preflightGit,
} from '../../src/main/project-setup/git-runner'
import { getDefaultBranch } from '../../src/main/git-service'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

let root: string
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'project-setup-git-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('project setup git runner', () => {
  it('creates a new project on main with README as the only Initial commit file', async () => {
    const repo = path.join(root, 'new-project')
    mkdirSync(repo)
    await initializeMainRepository(repo)
    await createReadme(repo, 'new-project')
    await createInitialCommit(repo, { includeReadme: true })

    expect(git(repo, ['branch', '--show-current'])).toBe('main')
    expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe('Initial commit')
    expect(git(repo, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('README.md')
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# new-project\n')
    expect(await hasUsableHead(repo)).toBe(true)
  })

  it('an empty commit preserves untracked files and neutralizes hostile identity, GPG, and hooks', async () => {
    const repo = path.join(root, 'existing')
    mkdirSync(repo)
    writeFileSync(path.join(repo, 'customer.txt'), 'keep me')
    await initializeMainRepository(repo)
    git(repo, ['add', 'customer.txt'])
    git(repo, ['config', 'commit.gpgsign', 'true'])
    const hooks = path.join(root, 'hooks')
    mkdirSync(hooks)
    writeFileSync(path.join(hooks, 'prepare-commit-msg'), '#!/bin/sh\nexit 9\n', { mode: 0o755 })
    git(repo, ['config', 'core.hooksPath', hooks])

    await createInitialCommit(repo, { includeReadme: false })

    expect(git(repo, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('')
    expect(git(repo, ['status', '--porcelain'])).toBe('A  customer.txt')
    expect(readFileSync(path.join(repo, 'customer.txt'), 'utf8')).toBe('keep me')
    expect(git(repo, ['show', '-s', '--pretty=%an <%ae>', 'HEAD'])).toBe('Maestrly <noreply@maestrly.com>')
    expect(git(repo, ['config', 'commit.gpgsign'])).toBe('true')
    expect(git(repo, ['config', 'core.hooksPath'])).toBe(hooks)
  })

  it('clones a local remote and preserves default develop even without local origin/HEAD', async () => {
    const source = path.join(root, 'source')
    const bare = path.join(root, 'remote.git')
    const dest = path.join(root, 'clone')
    mkdirSync(source)
    git(source, ['init', '-q', '-b', 'develop'])
    git(source, ['config', 'user.name', 'Test'])
    git(source, ['config', 'user.email', 'test@example.com'])
    writeFileSync(path.join(source, 'file.txt'), 'content')
    git(source, ['add', 'file.txt'])
    git(source, ['commit', '-q', '-m', 'init'])
    git(root, ['clone', '-q', '--bare', source, bare])
    mkdirSync(dest)

    const progress: Array<{ phase: string; percent?: number }> = []
    await cloneRepository({
      parentPath: root,
      remoteUrl: bare,
      destination: dest,
      signal: new AbortController().signal,
      onProgress: (event) => progress.push(event),
    })
    // Simulate a server without origin/HEAD; local HEAD still points to the correct default.
    try {
      git(dest, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'])
    } catch {}
    expect(git(dest, ['branch', '--show-current'])).toBe('develop')
    expect(await getDefaultBranch(dest)).toBe('develop')
    expect(readFileSync(path.join(dest, 'file.txt'), 'utf8')).toBe('content')
  })

  it('detects an empty clone by missing HEAD and emits only clamped allowlisted progress phases', async () => {
    const bare = path.join(root, 'empty.git')
    const dest = path.join(root, 'empty-clone')
    git(root, ['init', '-q', '--bare', '--initial-branch=main', bare])
    mkdirSync(dest)
    await cloneRepository({
      parentPath: root,
      remoteUrl: bare,
      destination: dest,
      signal: new AbortController().signal,
      onProgress: () => {},
    })
    expect(await hasUsableHead(dest)).toBe(false)
    expect(parseCloneProgress('Receiving objects: 42% (4/9)')).toEqual({
      phase: 'receiving-objects',
      percent: 42,
    })
    expect(parseCloneProgress('remote: Resolving deltas: 999%')).toEqual({
      phase: 'resolving-deltas',
      percent: 100,
    })
    expect(parseCloneProgress('fatal: https://user:secret@host/repo')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('cancellation waits for the clone process tree to exit', async () => {
    const bin = path.join(root, 'bin')
    const dest = path.join(root, 'cancel-dest')
    const alive = path.join(root, 'descendant-alive')
    mkdirSync(bin)
    mkdirSync(dest)
    const fakeGit = path.join(bin, 'git')
    writeFileSync(
      fakeGit,
      [
        '#!/bin/sh',
        'trap "exit 0" TERM INT',
        `(trap 'rm -f ${JSON.stringify(alive)}; exit 0' TERM INT; touch ${JSON.stringify(alive)}; while :; do sleep 1; done) &`,
        'wait',
      ].join('\n'),
      { mode: 0o755 }
    )
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`
    const controller = new AbortController()
    try {
      const running = cloneRepository({
        parentPath: root,
        remoteUrl: '/unused',
        destination: dest,
        signal: controller.signal,
        onProgress: () => {},
      })
      await vi.waitFor(() => expect(existsSync(alive)).toBe(true))
      controller.abort()
      await expect(running).rejects.toMatchObject({ canceled: true, cleanupUnsafe: false })
      expect(existsSync(alive)).toBe(false)
    } finally {
      process.env.PATH = previousPath
    }
  })

  it.skipIf(process.platform === 'win32')('preflight cancels the entire tree and completes', async () => {
    const bin = path.join(root, 'preflight-bin')
    const alive = path.join(root, 'preflight-descendant-alive')
    mkdirSync(bin)
    writeFileSync(
      path.join(bin, 'git'),
      [
        '#!/bin/sh',
        'trap "exit 0" TERM INT',
        `(trap 'rm -f ${JSON.stringify(alive)}; exit 0' TERM INT; touch ${JSON.stringify(alive)}; while :; do sleep 1; done) &`,
        'wait',
      ].join('\n'),
      { mode: 0o755 }
    )
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`
    const controller = new AbortController()
    try {
      const running = preflightGit(root, controller.signal)
      await vi.waitFor(() => expect(existsSync(alive)).toBe(true))
      controller.abort()
      await expect(running).rejects.toMatchObject({ canceled: true, cleanupUnsafe: false })
      expect(existsSync(alive)).toBe(false)
    } finally {
      process.env.PATH = previousPath
    }
  })

  it.skipIf(process.platform === 'win32')('classifies terminal errors even after stderr exceeds the limit', async () => {
    const bin = path.join(root, 'stderr-bin')
    const dest = path.join(root, 'stderr-dest')
    mkdirSync(bin)
    mkdirSync(dest)
    writeFileSync(
      path.join(bin, 'git'),
      '#!/bin/sh\ni=0; while [ "$i" -lt 70000 ]; do printf x >&2; i=$((i + 1)); done; printf "\\nfatal: Authentication failed\\n" >&2; exit 1\n',
      { mode: 0o755 }
    )
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`
    try {
      await expect(
        cloneRepository({
          parentPath: root,
          remoteUrl: '/unused',
          destination: dest,
          signal: new AbortController().signal,
          onProgress: () => {},
        })
      ).rejects.toMatchObject({ code: 'clone-authentication-failed' })
    } finally {
      process.env.PATH = previousPath
    }
  })

  it.skipIf(process.platform === 'win32')('git add leaves no live filter or descendant after cancellation', async () => {
    const repo = path.join(root, 'cancel-add')
    const bin = path.join(root, 'add-bin')
    const alive = path.join(root, 'add-descendant-alive')
    mkdirSync(repo)
    mkdirSync(bin)
    await initializeMainRepository(repo)
    await createReadme(repo, 'cancel-add')
    writeFileSync(
      path.join(bin, 'git'),
      [
        '#!/bin/sh',
        'trap "exit 0" TERM INT',
        `(trap 'rm -f ${JSON.stringify(alive)}; exit 0' TERM INT; touch ${JSON.stringify(alive)}; while :; do sleep 1; done) &`,
        'wait',
      ].join('\n'),
      { mode: 0o755 }
    )
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`
    const controller = new AbortController()
    try {
      const running = createInitialCommit(repo, { includeReadme: true, signal: controller.signal })
      await vi.waitFor(() => expect(existsSync(alive)).toBe(true))
      controller.abort()
      await expect(running).rejects.toMatchObject({ canceled: true, cleanupUnsafe: false })
      expect(existsSync(alive)).toBe(false)
    } finally {
      process.env.PATH = previousPath
    }
  })
})
