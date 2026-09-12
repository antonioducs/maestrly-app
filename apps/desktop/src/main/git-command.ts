import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
}

export async function runGitRaw(
  cwd: string,
  args: string[],
  timeoutOrOptions?: number | GitCommandOptions
): Promise<string> {
  const options = typeof timeoutOrOptions === 'number' ? { timeoutMs: timeoutOrOptions } : (timeoutOrOptions ?? {})
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
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
