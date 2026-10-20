import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
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
import { INITIAL_COMMIT_MAX_FILE_BYTES } from '../../src/main/project-setup/initial-commit-exclusions'
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

  it('the folder commit keeps the files and neutralizes hostile identity, GPG, and hooks', async () => {
    const repo = path.join(root, 'existing')
    mkdirSync(repo)
    writeFileSync(path.join(repo, 'customer.txt'), 'keep me')
    await initializeMainRepository(repo)
    git(repo, ['add', 'customer.txt'])
    git(repo, ['config', 'commit.gpgsign', 'true'])
    git(repo, ['config', 'user.name', 'Someone Else'])
    git(repo, ['config', 'user.email', 'someone@example.com'])
    const hooks = path.join(root, 'hooks')
    const marker = path.join(root, 'hook-ran')
    mkdirSync(hooks)
    for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
      writeFileSync(path.join(hooks, hook), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 9\n`, { mode: 0o755 })
    }
    git(repo, ['config', 'core.hooksPath', hooks])

    await createInitialCommit(repo, { includeReadme: false })

    expect(git(repo, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('customer.txt')
    expect(git(repo, ['status', '--porcelain'])).toBe('')
    expect(readFileSync(path.join(repo, 'customer.txt'), 'utf8')).toBe('keep me')
    expect(git(repo, ['show', '-s', '--pretty=%an <%ae>|%cn <%ce>', 'HEAD'])).toBe(
      'Maestrly <noreply@maestrly.com>|Maestrly <noreply@maestrly.com>'
    )
    expect(git(repo, ['cat-file', '-p', 'HEAD'])).not.toContain('gpgsig')
    expect(existsSync(marker)).toBe(false)
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

describe('initial commit of an existing folder', () => {
  const trackedFiles = (cwd: string) => git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean)
  const statusLines = (cwd: string) => git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean).sort()

  async function commitFolder(repo: string, signal?: AbortSignal) {
    await initializeMainRepository(repo)
    await createInitialCommit(repo, { includeReadme: false, signal })
  }

  function nestedRepository(dir: string) {
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q', '-b', 'main'])
    writeFileSync(path.join(dir, 'inner.txt'), 'inner')
    git(dir, ['add', 'inner.txt'])
    git(dir, ['-c', 'user.name=Inner', '-c', 'user.email=inner@example.com', 'commit', '-q', '-m', 'inner'])
  }

  it('commits what Git does not ignore and leaves the rest of the folder untouched and untracked', async () => {
    const repo = path.join(root, 'customer')
    mkdirSync(path.join(repo, 'node_modules'), { recursive: true })
    writeFileSync(path.join(repo, 'app.py'), 'print("hi")\n')
    writeFileSync(path.join(repo, 'dados.txt'), 'dados')
    writeFileSync(path.join(repo, '.env'), 'TOKEN=secret')
    writeFileSync(path.join(repo, '.env.example'), 'TOKEN=')
    writeFileSync(path.join(repo, 'node_modules', 'x.js'), 'module.exports = 1')
    writeFileSync(path.join(repo, 'listed.log'), 'ignored by .gitignore')
    writeFileSync(path.join(repo, '.gitignore'), 'listed.log\n')
    nestedRepository(path.join(repo, 'sub'))
    const big = path.join(repo, 'big.bin')
    writeFileSync(big, '')
    truncateSync(big, INITIAL_COMMIT_MAX_FILE_BYTES)

    await commitFolder(repo)

    expect(git(repo, ['branch', '--show-current'])).toBe('main')
    expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe('Initial commit')
    expect(trackedFiles(repo)).toEqual(['.env.example', '.gitignore', 'app.py', 'dados.txt'])
    expect(statusLines(repo)).toEqual(['?? .env', '?? big.bin', '?? node_modules/', '?? sub/'])
    expect(readFileSync(path.join(repo, '.env'), 'utf8')).toBe('TOKEN=secret')
    expect(readFileSync(path.join(repo, 'node_modules', 'x.js'), 'utf8')).toBe('module.exports = 1')
    expect(readFileSync(path.join(repo, 'listed.log'), 'utf8')).toBe('ignored by .gitignore')
    expect(readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('listed.log\n')
    expect(git(path.join(repo, 'sub'), ['log', '-1', '--pretty=%s'])).toBe('inner')
    expect(await hasUsableHead(repo)).toBe(true)
  })

  it('gives a worktree of the new project the files of the folder', async () => {
    const repo = path.join(root, 'customer')
    mkdirSync(repo)
    writeFileSync(path.join(repo, 'app.py'), 'print("hi")\n')
    mkdirSync(path.join(repo, 'src'))
    writeFileSync(path.join(repo, 'src', 'dados.txt'), 'dados')
    await commitFolder(repo)

    const worktree = path.join(root, 'customer-worktree')
    git(repo, ['worktree', 'add', '-q', '-b', 'card/test', worktree, 'main'])

    expect(readFileSync(path.join(worktree, 'app.py'), 'utf8')).toBe('print("hi")\n')
    expect(readFileSync(path.join(worktree, 'src', 'dados.txt'), 'utf8')).toBe('dados')
  })

  it('leaves out the same names at any depth, whatever their case', async () => {
    const repo = path.join(root, 'depth')
    const files = [
      'keep.txt',
      'deep/er/keep.txt',
      'config/.env.sample',
      'config/.env.template',
      'config/.ENV.Example',
      'deep/.env',
      'deep/.env.local',
      'deep/.env.production.local',
      'deep/er/server.pem',
      'deep/er/server.KEY',
      'deep/cert.p12',
      'deep/cert.pfx',
      'deep/id_rsa',
      'deep/id_rsa.pub',
      'deep/id_ed25519',
      'deep/id_ed25519.pub',
      'deep/.DS_Store',
      'deep/er/Thumbs.db',
      'deep/er/thumbs.DB',
      'a/.venv/bin/python',
      'a/venv/lib/site.py',
      'a/__pycache__/m.pyc',
      'a/b/node_modules/pkg/index.js',
      'a/b/Node_Modules/pkg/index.js',
    ]
    for (const file of files) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      writeFileSync(path.join(repo, file), file)
    }

    await commitFolder(repo)

    expect(trackedFiles(repo)).toEqual([
      'config/.ENV.Example',
      'config/.env.sample',
      'config/.env.template',
      'deep/er/keep.txt',
      'keep.txt',
    ])
    for (const file of files) expect(existsSync(path.join(repo, file))).toBe(true)
    // Nothing is deleted or modified: every file left out is still reported untracked.
    expect(git(repo, ['status', '--porcelain', '--untracked-files=all']).split('\n')).not.toContainEqual(
      expect.stringMatching(/^ ?[DMA]/)
    )
  })

  it('keeps a folder out when it has a .git of its own, even without a usable repository', async () => {
    const repo = path.join(root, 'nested')
    mkdirSync(repo)
    writeFileSync(path.join(repo, 'keep.txt'), 'keep')
    nestedRepository(path.join(repo, 'vendor', 'lib'))
    mkdirSync(path.join(repo, 'broken', '.git'), { recursive: true })
    writeFileSync(path.join(repo, 'broken', 'file.txt'), 'broken')
    mkdirSync(path.join(repo, 'pointer', 'deeper'), { recursive: true })
    writeFileSync(path.join(repo, 'pointer', '.git'), 'gitdir: /does/not/exist\n')
    writeFileSync(path.join(repo, 'pointer', 'deeper', 'file.txt'), 'pointer')
    writeFileSync(path.join(repo, 'vendor', 'own.txt'), 'vendor')

    await commitFolder(repo)

    expect(trackedFiles(repo)).toEqual(['keep.txt', 'vendor/own.txt'])
    expect(statusLines(repo)).toEqual(['?? broken/', '?? pointer/', '?? vendor/lib/'])
  })

  it('commits names with spaces, quotes, and non-ASCII characters', async () => {
    const repo = path.join(root, 'names')
    mkdirSync(path.join(repo, 'sp ace'), { recursive: true })
    const names = ['sp ace/relatório final.txt', 'sp ace/日本語.md', "it's.txt", 'plain.txt']
    for (const name of names) writeFileSync(path.join(repo, name), name)

    await commitFolder(repo)

    expect(
      git(repo, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'HEAD']).split('\n').sort()
    ).toEqual([...names].sort())
    expect(statusLines(repo)).toEqual([])
  })

  it('respects .git/info/exclude and the global excludes of the person', async () => {
    const repo = path.join(root, 'excludes')
    const globalExcludes = path.join(root, 'global-excludes')
    mkdirSync(repo)
    writeFileSync(globalExcludes, 'from-global.txt\n')
    for (const name of ['kept.txt', 'from-info.txt', 'from-global.txt', 'from-gitignore.txt']) {
      writeFileSync(path.join(repo, name), name)
    }
    mkdirSync(path.join(repo, 'sub'))
    writeFileSync(path.join(repo, 'sub', '.gitignore'), 'nested-ignored.txt\n')
    writeFileSync(path.join(repo, 'sub', 'nested-ignored.txt'), 'ignored')
    writeFileSync(path.join(repo, 'sub', 'nested-kept.txt'), 'kept')
    writeFileSync(path.join(repo, '.gitignore'), 'from-gitignore.txt\n')
    await initializeMainRepository(repo)
    mkdirSync(path.join(repo, '.git', 'info'), { recursive: true })
    writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'from-info.txt\n')

    const previous = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
    }
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'core.excludesFile'
    process.env.GIT_CONFIG_VALUE_0 = globalExcludes
    try {
      await createInitialCommit(repo, { includeReadme: false })
    } finally {
      for (const [name, value] of [
        ['GIT_CONFIG_COUNT', previous.count],
        ['GIT_CONFIG_KEY_0', previous.key],
        ['GIT_CONFIG_VALUE_0', previous.value],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }

    expect(trackedFiles(repo)).toEqual(['.gitignore', 'kept.txt', 'sub/.gitignore', 'sub/nested-kept.txt'])
  })

  it('creates an empty commit for an empty folder and for a folder where everything is left out', async () => {
    const empty = path.join(root, 'empty')
    mkdirSync(empty)
    await commitFolder(empty)
    expect(await hasUsableHead(empty)).toBe(true)
    expect(git(empty, ['log', '-1', '--pretty=%s'])).toBe('Initial commit')
    expect(git(empty, ['ls-tree', '-r', 'HEAD'])).toBe('')
    expect(statusLines(empty)).toEqual([])

    const excluded = path.join(root, 'all-excluded')
    mkdirSync(path.join(excluded, 'node_modules'), { recursive: true })
    writeFileSync(path.join(excluded, 'node_modules', 'x.js'), 'x')
    writeFileSync(path.join(excluded, '.env'), 'TOKEN=secret')
    writeFileSync(path.join(excluded, '.DS_Store'), '')
    await commitFolder(excluded)
    expect(await hasUsableHead(excluded)).toBe(true)
    expect(git(excluded, ['ls-tree', '-r', 'HEAD'])).toBe('')
    expect(statusLines(excluded)).toEqual(['?? .DS_Store', '?? .env', '?? node_modules/'])
  })

  it('applies the same rules to files already in the index of an unborn repository', async () => {
    const repo = path.join(root, 'unborn')
    mkdirSync(repo)
    await initializeMainRepository(repo)
    writeFileSync(path.join(repo, 'staged.txt'), 'staged')
    writeFileSync(path.join(repo, 'edited.txt'), 'first')
    writeFileSync(path.join(repo, 'gone.txt'), 'gone')
    writeFileSync(path.join(repo, '.env'), 'TOKEN=secret')
    writeFileSync(path.join(repo, 'secret.pem'), 'key')
    nestedRepository(path.join(repo, 'sub'))
    git(repo, [
      '-c',
      'advice.addEmbeddedRepo=false',
      'add',
      'staged.txt',
      'edited.txt',
      'gone.txt',
      '.env',
      'secret.pem',
      'sub',
    ])
    expect(git(repo, ['ls-files', '--stage', 'sub'])).toMatch(/^160000 /)
    writeFileSync(path.join(repo, 'edited.txt'), 'second')
    unlinkSync(path.join(repo, 'gone.txt'))
    writeFileSync(path.join(repo, 'untracked.txt'), 'untracked')

    await createInitialCommit(repo, { includeReadme: false })

    expect(trackedFiles(repo)).toEqual(['edited.txt', 'staged.txt', 'untracked.txt'])
    expect(git(repo, ['show', 'HEAD:edited.txt'])).toBe('second')
    expect(statusLines(repo)).toEqual(['?? .env', '?? secret.pem', '?? sub/'])
    expect(readFileSync(path.join(repo, '.env'), 'utf8')).toBe('TOKEN=secret')
  })

  it('can be repeated after an interrupted attempt', async () => {
    const repo = path.join(root, 'retry')
    mkdirSync(repo)
    writeFileSync(path.join(repo, 'app.py'), 'print()')
    writeFileSync(path.join(repo, '.env'), 'TOKEN=secret')
    await initializeMainRepository(repo)
    // Simulates a first attempt that staged everything and stopped before the commit.
    git(repo, ['add', 'app.py', '.env'])

    await createInitialCommit(repo, { includeReadme: false })

    expect(trackedFiles(repo)).toEqual(['app.py'])
    expect(statusLines(repo)).toEqual(['?? .env'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'leaves out a file Git cannot read instead of failing the whole commit',
    async () => {
      const repo = path.join(root, 'unreadable')
      mkdirSync(repo)
      writeFileSync(path.join(repo, 'app.py'), 'print()')
      writeFileSync(path.join(repo, 'locked.txt'), 'locked')
      chmodSync(path.join(repo, 'locked.txt'), 0o000)

      await commitFolder(repo)

      expect(trackedFiles(repo)).toEqual(['app.py'])
      expect(statusLines(repo)).toEqual(['?? locked.txt'])
    }
  )

  it('fails with the initial commit error when Git cannot stage the folder', async () => {
    const repo = path.join(root, 'broken-index')
    mkdirSync(repo)
    writeFileSync(path.join(repo, 'app.py'), 'print()')
    await initializeMainRepository(repo)
    // A directory where Git needs its index file makes every staging command fail.
    mkdirSync(path.join(repo, '.git', 'index'))

    await expect(createInitialCommit(repo, { includeReadme: false })).rejects.toMatchObject({
      code: 'initial-commit-failed',
      canceled: false,
    })
    expect(readFileSync(path.join(repo, 'app.py'), 'utf8')).toBe('print()')
  })

  it.skipIf(process.platform === 'win32')(
    'cancellation leaves no live Git process while staging the folder',
    async () => {
      const repo = path.join(root, 'cancel-folder')
      const bin = path.join(root, 'folder-bin')
      const alive = path.join(root, 'folder-descendant-alive')
      mkdirSync(repo)
      mkdirSync(bin)
      await initializeMainRepository(repo)
      writeFileSync(path.join(repo, 'app.py'), 'print()')
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
        const running = createInitialCommit(repo, { includeReadme: false, signal: controller.signal })
        await vi.waitFor(() => expect(existsSync(alive)).toBe(true))
        controller.abort()
        await expect(running).rejects.toMatchObject({ canceled: true, cleanupUnsafe: false })
        expect(existsSync(alive)).toBe(false)
      } finally {
        process.env.PATH = previousPath
      }
    }
  )
})
