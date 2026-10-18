import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathEnvKey, refreshWindowsPathFromRegistry, type WindowsPathRefreshDeps } from './fix-path'

const execFileAsync = promisify(execFile)

/** Directories where the Git for Windows installers put `git.exe`, used when the registry Path lacks Git. */
export function windowsGitDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const programFilesX86 = env['ProgramFiles(x86)']
  return [
    env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git', 'cmd'),
    programFilesX86 && path.win32.join(programFilesX86, 'Git', 'cmd'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'),
  ].filter((dir): dir is string => Boolean(dir))
}

function gitOnWindowsPath(env: NodeJS.ProcessEnv, exists: (file: string) => boolean): boolean {
  return (env[pathEnvKey(env)] ?? '').split(';').some((entry) => {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    return dir !== '' && exists(path.win32.join(dir, 'git.exe'))
  })
}

async function locateWindowsGit(deps: WindowsPathRefreshDeps): Promise<boolean> {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const added = await refreshWindowsPathFromRegistry({ ...deps, platform: 'win32', env, exists })
  // Git already reachable means the failure had another cause (such as a missing cwd), unless PATH just changed.
  if (gitOnWindowsPath(env, exists)) return added.length > 0
  const dir = windowsGitDirectories(env).find((candidate) => exists(path.win32.join(candidate, 'git.exe')))
  if (!dir) return false
  const key = pathEnvKey(env)
  env[key] = [(env[key] ?? '').replace(/;+$/, ''), dir].filter(Boolean).join(';')
  return true
}

let gitLookup: Promise<boolean> | null = null

/**
 * A Windows process keeps the PATH it started with, so Git installed while the app is open stays out of reach
 * until restart. After `git` fails to start, reread the registry Path and fall back to the installers' default
 * directories. Resolves true when PATH changed and now holds `git.exe`, so one retry may succeed. A miss is never
 * cached; concurrent callers share the lookup in flight. POSIX PATH repair happens at startup (fixPathForGuiApp).
 */
export function refreshGitPath(deps: WindowsPathRefreshDeps = {}): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== 'win32') return Promise.resolve(false)
  gitLookup ??= locateWindowsGit(deps).finally(() => {
    gitLookup = null
  })
  return gitLookup
}

/** Whether a child-process error means the executable could not be started (ENOENT at spawn). */
export function isSpawnNotFound(error: unknown): boolean {
  const value = error as NodeJS.ErrnoException | null
  return value?.code === 'ENOENT' && (value.syscall === undefined || value.syscall.startsWith('spawn'))
}

/**
 * Runs one Git invocation and, when `git` could not start, retries it once if refreshGitPath found Git. `run`
 * must read process.env when called so the retry sees the refreshed PATH.
 */
export async function retryWhenGitAppears<T>(
  run: () => Promise<T>,
  notFound: (error: unknown) => boolean = isSpawnNotFound,
  deps?: WindowsPathRefreshDeps
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!notFound(error) || !(await refreshGitPath(deps))) throw error
    return run()
  }
}

export class GitCommandError extends Error {
  readonly args: string[]
  readonly stdout: string
  readonly stderr: string
  readonly code?: number | string

  constructor(args: string[], error: unknown) {
    const value = error as { message?: string; stdout?: string; stderr?: string; code?: number | string }
    super(value.stderr?.trim() || value.message || `git ${args[0] ?? ''} failed`)
    this.name = 'GitCommandError'
    this.args = args
    this.stdout = value.stdout ?? ''
    this.stderr = value.stderr ?? ''
    this.code = value.code
  }
}

/** Single Git runner: never invoke a shell, and preserve raw stdout for NUL-delimited formats. */
export interface GitCommandOptions {
  timeoutMs?: number
  signal?: AbortSignal
  maxBuffer?: number
  /** Added to the inherited environment, for example a temporary GIT_INDEX_FILE. */
  env?: Record<string, string>
}

export async function runGitRaw(
  cwd: string,
  args: string[],
  timeoutOrOptions?: number | GitCommandOptions
): Promise<string> {
  const options = typeof timeoutOrOptions === 'number' ? { timeoutMs: timeoutOrOptions } : (timeoutOrOptions ?? {})
  try {
    const { stdout } = await retryWhenGitAppears(() =>
      execFileAsync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...options.env },
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
        ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    )
    return stdout
  } catch (error) {
    throw new GitCommandError(args, error)
  }
}

export async function runGit(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  return (await runGitRaw(cwd, args, timeoutMs)).trim()
}

export async function runGitOrNull(cwd: string, args: string[], timeoutMs?: number): Promise<string | null> {
  try {
    return await runGit(cwd, args, timeoutMs)
  } catch {
    return null
  }
}
