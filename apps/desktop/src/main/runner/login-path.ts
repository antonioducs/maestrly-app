import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'

const MARK = '__RUNNER_PATH__:'
const PROBE_TIMEOUT_MS = 6_000

/** The shell a person's terminal starts: `$SHELL`, else the platform's usual one. */
function loginShell(platform: NodeJS.Platform): string {
  if (process.env.SHELL) return process.env.SHELL
  if (platform === 'linux') return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
  return '/bin/zsh'
}

export interface LoginPathDeps {
  platform?: NodeJS.Platform
  /** Runs `file args` and answers its output; rejects when it fails. */
  exec?: (file: string, args: string[]) => Promise<string>
  /** The PATH to fall back on when the shell does not answer. */
  fallback?: () => string
  home?: () => string
}

const execText = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  })

/**
 * A function that asks the user's login shell for its PATH once, as the app does at startup, and remembers the
 * answer. The directories package managers use (Homebrew, snap, `~/.local/bin`) and the base ones follow it, so a job
 * finds its tools even when the shell does not answer.
 */
export function createLoginShellPath(deps: LoginPathDeps = {}): () => Promise<string> {
  let cached: Promise<string> | null = null
  const probe = async (): Promise<string> => {
    const platform = deps.platform ?? process.platform
    let login = ''
    try {
      // Login and interactive flags load the shell files that usually extend PATH.
      const out = await (deps.exec ?? execText)(loginShell(platform), ['-lic', `printf '%s' '${MARK}'"$PATH"`])
      const at = out.lastIndexOf(MARK)
      const got = at >= 0 ? out.slice(at + MARK.length).trim() : ''
      if (got.includes('/')) login = got
    } catch {
      // The shell did not answer: the app's own PATH, which was repaired at startup, stands in.
    }
    const home = (deps.home ?? os.homedir)()
    const known = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      home && `${home}/.local/bin`,
      '/snap/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]
    const own = login ? '' : ((deps.fallback ?? (() => process.env.PATH ?? ''))() ?? '')
    return [...new Set([...login.split(':'), ...own.split(':'), ...known].filter(Boolean) as string[])].join(':')
  }
  return () => (cached ??= probe())
}

/** The login shell's PATH, resolved on first use and kept. */
export const loginShellPath: () => Promise<string> = createLoginShellPath()
