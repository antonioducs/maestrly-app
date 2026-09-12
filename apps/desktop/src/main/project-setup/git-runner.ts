import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProjectSetupErrorCode, ProjectSetupProgress, ProjectSetupPhase } from '../../shared/project-setup'

const MAX_CAPTURE_BYTES = 64 * 1024
const DEFAULT_GIT_TIMEOUT_MS = 30_000
const CLONE_TIMEOUT_MS = 60 * 60_000
const COMMIT_NAME = 'Maestrly'
const COMMIT_EMAIL = 'noreply@maestrly.com'

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

interface RunGitOptions {
  cwd: string
  args: string[]
  errorCode: ProjectSetupErrorCode
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  onStderr?: (chunk: Buffer) => void
}

export class ProjectSetupGitError extends Error {
  constructor(
    readonly code: ProjectSetupErrorCode,
    readonly canceled = false,
    readonly cleanupUnsafe = false
  ) {
    super(code)
    this.name = 'ProjectSetupGitError'
  }
}

function appendLimited(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  if (current.length >= MAX_CAPTURE_BYTES) return current
  return Buffer.concat([current, chunk.subarray(0, MAX_CAPTURE_BYTES - current.length)])
}

function appendTailLimited(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  const combined = Buffer.concat([current, chunk])
  return combined.subarray(Math.max(0, combined.length - MAX_CAPTURE_BYTES))
}

function terminateTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid
  if (!pid) return Promise.resolve(true)

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      })
      let settled = false
      const finish = (terminated: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(terminated)
      }
      const timer = setTimeout(() => finish(false), 3_000)
      timer.unref()
      killer.once('close', (code) => finish(code === 0))
      killer.once('error', () => finish(false))
    })
  }

  const groupExists = (): boolean => {
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return Promise.resolve(!groupExists())
  }
  return new Promise((resolve) => {
    let settled = false
    let forceFinish: NodeJS.Timeout | undefined
    const finish = (terminated: boolean) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(escalate)
      if (forceFinish) clearTimeout(forceFinish)
      resolve(terminated)
    }
    const poll = setInterval(() => {
      if (!groupExists()) finish(true)
    }, 50)
    poll.unref()
    const escalate = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        finish(!groupExists())
        return
      }
      // If the process group survives, retain the directory: removing it while descendants may write is
      // worse than reporting incomplete cleanup.
      forceFinish = setTimeout(() => finish(!groupExists()), 1_000)
      forceFinish.unref()
    }, 3_000)
    escalate.unref()
  })
}

function runGitProcess(options: RunGitOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ProjectSetupGitError(options.errorCode, true))
      return
    }

    const child = spawn('git', options.args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    })
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let settled = false
    let stopping = false

    const cleanup = () => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const stop = (canceled: boolean) => {
      if (settled || stopping) return
      stopping = true
      void terminateTree(child).then((terminated) => {
        finish(() => reject(new ProjectSetupGitError(options.errorCode, canceled, !terminated)))
      })
    }
    const onAbort = () => stop(true)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    // Close the race between the pre-spawn check and listener installation.
    if (options.signal?.aborted) onAbort()

    const timeout = setTimeout(() => stop(false), options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS)
    timeout.unref()

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendTailLimited(stderr, chunk)
      options.onStderr?.(chunk)
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (stopping) return
      finish(() =>
        reject(
          error.code === 'ENOENT'
            ? new ProjectSetupGitError('git-not-found')
            : new ProjectSetupGitError(options.errorCode)
        )
      )
    })
    child.once('close', (code) => {
      if (stopping) return
      finish(() =>
        resolve({
          code,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
        })
      )
    })
  })
}

function execGit(
  cwd: string,
  args: string[],
  errorCode: ProjectSetupErrorCode,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return runGitProcess({ cwd, args, errorCode, signal, env })
}

async function requireGit(
  cwd: string,
  args: string[],
  code: ProjectSetupErrorCode,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const result = await execGit(cwd, args, code, signal, env)
  if (result.code !== 0) throw new ProjectSetupGitError(code)
  return result.stdout.trim()
}

export async function preflightGit(cwd: string, signal?: AbortSignal): Promise<void> {
  const result = await runGitProcess({
    cwd,
    args: ['--version'],
    errorCode: 'git-incompatible',
    signal,
    timeoutMs: 10_000,
  })
  if (result.code !== 0 || !/^git version \d+\.\d+/i.test(result.stdout.trim())) {
    throw new ProjectSetupGitError('git-incompatible')
  }
}

export async function initializeMainRepository(cwd: string, signal?: AbortSignal): Promise<void> {
  const first = await execGit(cwd, ['init', '-b', 'main'], 'initialization-failed', signal)
  if (first.code === 0) return
  const unsupported = /unknown (?:option|switch)|unrecognized option|usage: git init/i.test(first.stderr)
  if (!unsupported) throw new ProjectSetupGitError('initialization-failed')

  const fallback = await execGit(cwd, ['init'], 'git-incompatible', signal)
  if (fallback.code !== 0) throw new ProjectSetupGitError('git-incompatible')
  await requireGit(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main'], 'git-incompatible', signal)
}

export async function forceUnbornHeadToMain(cwd: string, signal?: AbortSignal): Promise<void> {
  await forceUnbornHeadToBranch(cwd, 'main', signal)
}

export async function forceUnbornHeadToBranch(cwd: string, branch: string, signal?: AbortSignal): Promise<void> {
  await requireGit(cwd, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], 'initialization-failed', signal)
}

export async function checkoutCloneDefaultBranch(cwd: string, branch: string, signal?: AbortSignal): Promise<void> {
  const remoteRef = `refs/remotes/origin/${branch}`
  const exists = await execGit(cwd, ['show-ref', '--verify', '--quiet', remoteRef], 'clone-failed', signal)
  if (exists.code !== 0) throw new ProjectSetupGitError('clone-failed')
  await requireGit(cwd, ['checkout', '--quiet', '-B', branch, remoteRef, '--'], 'clone-failed', signal)
  await requireGit(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', remoteRef], 'clone-failed', signal)
}

export async function createReadme(cwd: string, projectName: string): Promise<void> {
  await fs.writeFile(path.join(cwd, 'README.md'), `# ${projectName}\n`, { flag: 'wx' })
}

export async function createInitialCommit(
  cwd: string,
  options: { includeReadme: boolean; signal?: AbortSignal }
): Promise<void> {
  const hooksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-hooks-'))
  const indexDir = options.includeReadme ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-index-'))
  const commitEnv = indexDir ? { GIT_INDEX_FILE: path.join(indexDir, 'index') } : undefined
  try {
    if (options.includeReadme) {
      await requireGit(cwd, ['add', '--', 'README.md'], 'initial-commit-failed', options.signal)
    } else {
      // Use an ephemeral index so an unborn repository's staged files cannot enter the intended empty
      // commit.
      await requireGit(cwd, ['read-tree', '--empty'], 'initial-commit-failed', options.signal, commitEnv)
    }
    const args = [
      '-c',
      `user.name=${COMMIT_NAME}`,
      '-c',
      `user.email=${COMMIT_EMAIL}`,
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${hooksDir}`,
      'commit',
      '--no-verify',
      ...(options.includeReadme ? [] : ['--allow-empty']),
      '-m',
      'Initial commit',
    ]
    await requireGit(cwd, args, 'initial-commit-failed', options.signal, commitEnv)
  } finally {
    await Promise.all([
      fs.rm(hooksDir, { recursive: true, force: true }).catch(() => {}),
      indexDir ? fs.rm(indexDir, { recursive: true, force: true }).catch(() => {}) : Promise.resolve(),
    ])
  }
}

export async function hasUsableHead(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const result = await execGit(cwd, ['rev-parse', '--verify', 'HEAD'], 'initial-commit-failed', signal)
  return result.code === 0 && /^[0-9a-f]{40,64}$/i.test(result.stdout.trim())
}

export async function isWorkingTreeRepository(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const result = await execGit(cwd, ['rev-parse', '--is-inside-work-tree'], 'not-git-repository', signal)
  return result.code === 0 && result.stdout.trim() === 'true'
}

export async function isBareRepository(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const result = await execGit(cwd, ['rev-parse', '--is-bare-repository'], 'bare-repository', signal)
  return result.code === 0 && result.stdout.trim() === 'true'
}

export async function getRepositoryTopLevel(cwd: string, signal?: AbortSignal): Promise<string | null> {
  const result = await execGit(cwd, ['rev-parse', '--show-toplevel'], 'not-git-repository', signal)
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

export async function validBranch(cwd: string, branch: string, signal?: AbortSignal): Promise<boolean> {
  if (!branch) return false
  const result = await execGit(cwd, ['check-ref-format', '--branch', branch], 'registration-failed', signal)
  return result.code === 0
}

export async function currentBranch(cwd: string, signal?: AbortSignal): Promise<string | null> {
  const result = await execGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'registration-failed', signal)
  if (result.code !== 0) return null
  const branch = result.stdout.trim()
  return (await validBranch(cwd, branch, signal)) ? branch : null
}

export async function getRepositoryDefaultBranch(cwd: string, signal?: AbortSignal): Promise<string> {
  const origin = await execGit(
    cwd,
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    'registration-failed',
    signal
  )
  const originBranch = origin.code === 0 ? origin.stdout.trim().replace(/^origin\//, '') : ''
  if (await validBranch(cwd, originBranch, signal)) return originBranch

  const current = await currentBranch(cwd, signal)
  if (current) {
    const exists = await execGit(
      cwd,
      ['show-ref', '--verify', '--quiet', `refs/heads/${current}`],
      'registration-failed',
      signal
    )
    if (exists.code === 0) return current
  }

  for (const candidate of ['main', 'master']) {
    const exists = await execGit(
      cwd,
      ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`],
      'registration-failed',
      signal
    )
    if (exists.code === 0) return candidate
  }
  const configured = await execGit(cwd, ['config', '--get', 'init.defaultBranch'], 'registration-failed', signal)
  const configuredBranch = configured.code === 0 ? configured.stdout.trim() : ''
  return (await validBranch(cwd, configuredBranch, signal)) ? configuredBranch : 'main'
}

export function parseCloneProgress(text: string): Pick<ProjectSetupProgress, 'phase' | 'percent'> | null {
  const match = /(?:remote:\s*)?(Receiving objects|Resolving deltas):\s+(\d{1,3})%/i.exec(text)
  if (!match) return null
  const phase: ProjectSetupPhase = /^receiving/i.test(match[1]) ? 'receiving-objects' : 'resolving-deltas'
  return { phase, percent: Math.max(0, Math.min(100, Number(match[2]))) }
}

function classifyCloneFailure(stderr: string): ProjectSetupErrorCode {
  const safe = stderr.toLowerCase()
  if (
    /authentication failed|permission denied|could not read username|terminal prompts disabled|publickey/.test(safe)
  ) {
    return 'clone-authentication-failed'
  }
  if (
    /could not resolve host|failed to connect|connection timed out|network is unreachable|connection reset/.test(safe)
  ) {
    return 'clone-network-failed'
  }
  if (/repository .* not found|does not appear to be a git repository|not found/.test(safe)) {
    return 'remote-not-found'
  }
  return 'clone-failed'
}

async function createAskpassDenyScript(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-askpass-'))
  const script = path.join(dir, process.platform === 'win32' ? 'deny.cmd' : 'deny.sh')
  await fs.writeFile(script, process.platform === 'win32' ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  return { path: script, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

export async function cloneRepository(options: {
  parentPath: string
  remoteUrl: string
  destination: string
  signal: AbortSignal
  onProgress: (progress: Pick<ProjectSetupProgress, 'phase' | 'percent'>) => void
}): Promise<void> {
  if (options.signal.aborted) throw new ProjectSetupGitError('clone-failed', true)
  const askpass = await createAskpassDenyScript()
  let progressBuffer = ''

  try {
    if (options.signal.aborted) throw new ProjectSetupGitError('clone-failed', true)
    const result = await runGitProcess({
      cwd: options.parentPath,
      args: ['-c', 'credential.interactive=never', 'clone', '--progress', '--', options.remoteUrl, options.destination],
      errorCode: 'clone-failed',
      signal: options.signal,
      timeoutMs: CLONE_TIMEOUT_MS,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GIT_ASKPASS: askpass.path,
        SSH_ASKPASS: askpass.path,
        SSH_ASKPASS_REQUIRE: 'never',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      },
      onStderr: (chunk) => {
        progressBuffer = `${progressBuffer}${chunk.toString('utf8')}`.slice(-4_096)
        const lines = progressBuffer.split(/[\r\n]/)
        progressBuffer = lines.pop() ?? ''
        for (const line of lines) {
          const progress = parseCloneProgress(line)
          if (progress) options.onProgress(progress)
        }
      },
    })
    const trailing = parseCloneProgress(progressBuffer)
    if (trailing) options.onProgress(trailing)
    if (result.code !== 0) throw new ProjectSetupGitError(classifyCloneFailure(result.stderr))
  } finally {
    await askpass.cleanup().catch(() => {})
  }
}
