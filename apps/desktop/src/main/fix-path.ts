import { execFileSync } from 'node:child_process'
import { defaultPosixShell } from './platform'

/**
 * GUI-launched apps inherit a minimal PATH. Before spawning, merge the login-shell PATH when available
 * with current PATH and known directories that remain available if shell probing fails. Usually
 * unchanged in terminal-based development.
 */
export function fixPathForGuiApp(): void {
  if (process.platform === 'win32') return
  const current = process.env.PATH || ''
  const homeDirectory = process.env.HOME ?? ''
  // Always include known Homebrew, Linux local/snap, and base POSIX directories regardless of probing.
  const staticDirs = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    homeDirectory && `${homeDirectory}/.local/bin`,
    '/snap/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean) as string[]

  let real = ''
  try {
    const shell = defaultPosixShell()
    const MARK = '__APPPATH__:'
    // Login and interactive flags load the shell files that typically extend PATH.
    const out = execFileSync(shell, ['-lic', `printf '%s' '${MARK}'"$PATH"`], {
      encoding: 'utf8',
      timeout: 6000,
    })
    const i = out.lastIndexOf(MARK)
    if (i >= 0) {
      const got = out.slice(i + MARK.length).trim()
      if (got.includes('/')) real = got
    }
  } catch {
    /* Shell probing failed; retain current PATH and static directories. */
  }

  // Priority: login-shell PATH, current PATH, known directories. Set deduplication preserves the first
  // occurrence.
  const merged = new Set<string>([...real.split(':'), ...current.split(':'), ...staticDirs])
  process.env.PATH = [...merged].filter(Boolean).join(':')
}
