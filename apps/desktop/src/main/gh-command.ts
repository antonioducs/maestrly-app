import { execFile } from 'node:child_process'

export type GhCommandErrorCode = 'no-gh' | 'not-logged-in' | 'no-repo' | 'failed' | 'aborted'

export class GhCommandError extends Error {
  constructor(
    readonly kind: GhCommandErrorCode,
    readonly args: string[],
    message: string,
    readonly exitCode?: number | string,
    readonly stdout = '',
    readonly stderr = ''
  ) {
    super(message)
    this.name = 'GhCommandError'
  }
}

export function ghCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, LC_ALL: 'C', LANG: 'C' }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  return env
}

export interface GhCommandOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxBuffer?: number
}

/** Shared gh runner: execFile only, local keyring auth, and no token override inherited from the app. */
export function runGhCommand(cwd: string, args: string[], options: GhCommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      {
        cwd,
        env: ghCommandEnv(),
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 20_000,
        maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT')
          return reject(new GhCommandError('no-gh', args, 'GitHub CLI (gh) is not installed.', code, stdout, stderr))
        if (code === 'ABORT_ERR')
          return reject(new GhCommandError('aborted', args, 'Chamada gh cancelada.', code, stdout, stderr))
        const detail = String(stderr || (error as Error).message).trim()
        const kind = args[0] === 'auth' && args[1] === 'status' ? 'not-logged-in' : 'failed'
        reject(new GhCommandError(kind, args, detail || 'GitHub CLI failed.', code, stdout, stderr))
      }
    )
  })
}
