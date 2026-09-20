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

/** `gh` reports an authentication problem with this status, whatever the subcommand was. */
const GH_AUTH_EXIT = 4
const NOT_SIGNED_IN = /not logged in|gh auth login|authentication token|requires authentication/i

/**
 * A failure that produced no answer at all: the CLI is missing, it could not authenticate, or it was
 * interrupted before exiting. Anything else did run and its exit status is a statement about the command,
 * not about the transport — the caller may still read the output it printed.
 */
export function ghProducedNoAnswer(error: GhCommandError): boolean {
  return error.kind === 'no-gh' || error.kind === 'not-logged-in' || typeof error.exitCode !== 'number'
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
        // `code` is the numeric exit status when the process actually ran, and a string errno when it could
        // not be run at all. The node typings only describe the second case.
        const code = (error as { code?: number | string }).code
        if (code === 'ENOENT')
          return reject(new GhCommandError('no-gh', args, 'GitHub CLI (gh) is not installed.', code, stdout, stderr))
        if (code === 'ABORT_ERR')
          return reject(new GhCommandError('aborted', args, 'Chamada gh cancelada.', code, stdout, stderr))
        const detail = String(stderr || (error as Error).message).trim()
        // An authentication failure is the same problem whichever subcommand hit it, so it is named as such
        // instead of being flattened into a generic failure the caller cannot tell apart from a real answer.
        const kind: GhCommandErrorCode =
          (args[0] === 'auth' && args[1] === 'status') || code === GH_AUTH_EXIT || NOT_SIGNED_IN.test(detail)
            ? 'not-logged-in'
            : 'failed'
        reject(new GhCommandError(kind, args, detail || 'GitHub CLI failed.', code, stdout, stderr))
      }
    )
  })
}
