import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  exists: vi.fn((_file: string) => false),
  recycleCodexConnections: vi.fn(async () => true),
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: h.execFile,
  spawn: h.spawn,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, default: { ...actual, existsSync: h.exists }, existsSync: h.exists }
})

vi.mock('../../src/main/chat/codex-subscription/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/codex-subscription/manager')>()),
  recycleCodexConnections: h.recycleCodexConnections,
}))

import { refreshWindowsPathFromRegistry } from '../../src/main/fix-path'
import { refreshGitPath, retryWhenGitAppears, runGitRaw, windowsGitDirectories } from '../../src/main/git-command'
import { preflightGit } from '../../src/main/project-setup/git-runner'
import { PluginGitSource } from '../../src/main/plugins/git-source'

const GIT_DIR = 'C:\\Program Files\\Git\\cmd'
const GIT_EXE = `${GIT_DIR}\\git.exe`
const REG_WITH_GIT = `\r\nHKEY_LOCAL_MACHINE\\...\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Windows\\system32;${GIT_DIR}\r\n`
const REG_WITHOUT_GIT = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Windows\\system32\r\n'

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('spawn git ENOENT'), {
    code: 'ENOENT',
    errno: -4058,
    syscall: 'spawn git',
    path: 'git',
  })
}

/** reg.exe answers from `registry`; `git` fails to start until `gitInstalled()` and PATH holds its directory. */
function fakeExecFile(registry: () => string, gitInstalled: () => boolean) {
  h.execFile.mockImplementation(
    (
      file: string,
      args: string[],
      opts: { env?: NodeJS.ProcessEnv } | ((...a: unknown[]) => void),
      callback?: (error: Error | null, out?: unknown) => void
    ) => {
      const done = (typeof opts === 'function' ? opts : callback)!
      if (file.toLowerCase().endsWith('reg.exe')) return done(null, args[1]?.startsWith('HKLM') ? registry() : '')
      const env = typeof opts === 'function' ? process.env : (opts.env ?? process.env)
      const path = env.Path ?? env.PATH ?? ''
      if (gitInstalled() && path.split(';').includes(GIT_DIR))
        return done(null, { stdout: 'git version 2.56.0\n', stderr: '' })
      return done(enoent())
    }
  )
}

function fakeChild(outcome: 'enoent' | 'ok'): EventEmitter {
  const child = Object.assign(new EventEmitter(), {
    pid: outcome === 'ok' ? 4242 : undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  queueMicrotask(() => {
    if (outcome === 'enoent') {
      child.emit('error', enoent())
      return
    }
    child.stdout.write('git version 2.56.0.windows.1\n')
    child.emit('close', 0)
  })
  return child
}

describe('finding Git installed while the app is open', () => {
  let savedEnv: NodeJS.ProcessEnv
  let installed: boolean

  beforeEach(() => {
    vi.clearAllMocks()
    savedEnv = { ...process.env }
    for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH') delete process.env[key]
    process.env.Path = 'C:\\Windows\\system32'
    process.env.SystemRoot = 'C:\\Windows'
    process.env.ProgramFiles = 'C:\\Program Files'
    installed = false
    h.exists.mockImplementation((file: string) => installed && (file === GIT_DIR || file === GIT_EXE))
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, savedEnv)
  })

  it('lists the Git for Windows install directories', () => {
    expect(
      windowsGitDirectories({
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local',
      })
    ).toEqual([
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files (x86)\\Git\\cmd',
      'C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\cmd',
    ])
    expect(windowsGitDirectories({})).toEqual([])
    // A copy of the environment is a plain object; launchers may spell names in upper case.
    expect(windowsGitDirectories({ PROGRAMFILES: 'D:\\Apps', LocalAppData: 'C:\\L' })).toEqual([
      'D:\\Apps\\Git\\cmd',
      'C:\\L\\Programs\\Git\\cmd',
    ])
  })

  it('runGitRaw fails while Git is absent, then works after it is installed, without restarting', async () => {
    fakeExecFile(
      () => (installed ? REG_WITH_GIT : REG_WITHOUT_GIT),
      () => installed
    )

    await expect(runGitRaw('C:\\repo', ['--version'])).rejects.toMatchObject({ code: 'ENOENT' })
    expect(process.env.Path).toBe('C:\\Windows\\system32')

    installed = true
    await expect(runGitRaw('C:\\repo', ['--version'])).resolves.toBe('git version 2.56.0\n')
    expect(process.env.Path).toBe(`C:\\Windows\\system32;${GIT_DIR}`)
    // Later calls find Git on the refreshed PATH without rereading the registry.
    const regCalls = h.execFile.mock.calls.filter(([file]) => String(file).endsWith('reg.exe')).length
    await runGitRaw('C:\\repo', ['--version'])
    expect(h.execFile.mock.calls.filter(([file]) => String(file).endsWith('reg.exe')).length).toBe(regCalls)
  })

  it('falls back to the default install directory when the registry Path lacks Git', async () => {
    fakeExecFile(
      () => REG_WITHOUT_GIT,
      () => installed
    )
    installed = true
    await expect(runGitRaw('C:\\repo', ['--version'])).resolves.toContain('git version')
    expect(process.env.Path).toBe(`C:\\Windows\\system32;${GIT_DIR}`)
  })

  it('project setup preflight reports git-not-found, then succeeds once Git is installed', async () => {
    fakeExecFile(
      () => (installed ? REG_WITH_GIT : REG_WITHOUT_GIT),
      () => installed
    )
    h.spawn.mockImplementation((_file: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      const path = (opts.env ?? process.env).Path ?? ''
      return fakeChild(installed && path.split(';').includes(GIT_DIR) ? 'ok' : 'enoent')
    })

    await expect(preflightGit('C:\\repo')).rejects.toMatchObject({ code: 'git-not-found' })
    expect(h.spawn).toHaveBeenCalledTimes(1)

    installed = true
    await expect(preflightGit('C:\\repo')).resolves.toBeUndefined()
    expect(h.spawn).toHaveBeenCalledTimes(3)
  })

  it('plugin downloads find Git installed later, through the same restricted environment', async () => {
    process.env.GIT_DIR = 'C:\\elsewhere'
    fakeExecFile(
      () => (installed ? REG_WITH_GIT : REG_WITHOUT_GIT),
      () => installed
    )
    const envs: NodeJS.ProcessEnv[] = []
    h.spawn.mockImplementation((_file: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      const env = opts.env ?? {}
      envs.push(env)
      return fakeChild(installed && (env.Path ?? '').split(';').includes(GIT_DIR) ? 'ok' : 'enoent')
    })
    const source = new PluginGitSource({ allowFileRoot: null })

    await expect(source.gitVersion()).resolves.toBeNull()
    expect(h.spawn).toHaveBeenCalledTimes(1)

    installed = true
    await expect(source.gitVersion()).resolves.toBe('2.56.0.windows.1')
    expect(h.spawn).toHaveBeenCalledTimes(3)
    expect(envs[2].Path).toBe(`C:\\Windows\\system32;${GIT_DIR}`)
    // The retry rebuilds the environment from the same allowlist: no GIT_* override of the parent gets through.
    expect(Object.keys(envs[2]).sort()).toEqual(Object.keys(envs[1]).sort())
    expect(envs[2].GIT_DIR).toBeUndefined()
  })

  it('does not retry when Git was already on PATH (the failure had another cause)', async () => {
    installed = true
    process.env.Path = `C:\\Windows\\system32;${GIT_DIR}`
    fakeExecFile(
      () => REG_WITH_GIT,
      () => true
    )
    const run = vi.fn(async () => {
      throw enoent()
    })
    await expect(retryWhenGitAppears(run)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never retries other errors', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('fatal: not a git repository'), { code: 128 })
    })
    await expect(retryWhenGitAppears(run)).rejects.toThrow('not a git repository')
    expect(run).toHaveBeenCalledTimes(1)
    expect(h.execFile).not.toHaveBeenCalled()
  })

  it('shares one lookup between concurrent callers', async () => {
    installed = true
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const readKey = vi.fn(async (key: string) => {
      await gate
      return key.startsWith('HKLM') ? REG_WITH_GIT : ''
    })
    const first = refreshGitPath({ readKey })
    const second = refreshGitPath({ readKey })
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    // One registry read per key, not per caller.
    expect(readKey).toHaveBeenCalledTimes(2)
    // Once settled, the next call looks again instead of reusing the answer.
    await expect(refreshGitPath({ readKey })).resolves.toBe(false)
    expect(readKey).toHaveBeenCalledTimes(4)
  })

  it('leaves Linux and macOS alone', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      const run = vi.fn(async () => {
        throw enoent()
      })
      await expect(retryWhenGitAppears(run)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(run).toHaveBeenCalledTimes(1)
      expect(await refreshGitPath()).toBe(false)
    }
    expect(h.execFile).not.toHaveBeenCalled()
    expect(process.env.Path).toBe('C:\\Windows\\system32')
  })

  it('recycles idle Codex connections when a PATH refresh adds a directory, and skips when nothing changed', async () => {
    fakeExecFile(
      () => (installed ? REG_WITH_GIT : REG_WITHOUT_GIT),
      () => installed
    )

    // Registry refresh with no new directory does not recycle Codex connections.
    await expect(refreshWindowsPathFromRegistry()).resolves.toEqual([])
    expect(h.recycleCodexConnections).not.toHaveBeenCalled()

    // Registry refresh that adds Git's directory recycles idle Codex connections.
    installed = true
    await expect(refreshWindowsPathFromRegistry()).resolves.toEqual([GIT_DIR])
    expect(h.recycleCodexConnections).toHaveBeenCalledTimes(1)

    // Subsequent refresh when the directory is already on Path does not recycle again.
    await expect(refreshWindowsPathFromRegistry()).resolves.toEqual([])
    expect(h.recycleCodexConnections).toHaveBeenCalledTimes(1)

    // Fallback directory path in refreshGitPath (when registry lacks Git) also recycles idle Codex connections.
    process.env.Path = 'C:\\Windows\\system32'
    fakeExecFile(
      () => REG_WITHOUT_GIT,
      () => installed
    )
    await expect(refreshGitPath()).resolves.toBe(true)
    expect(process.env.Path).toBe(`C:\\Windows\\system32;${GIT_DIR}`)
    expect(h.recycleCodexConnections).toHaveBeenCalledTimes(2)
  })
})
