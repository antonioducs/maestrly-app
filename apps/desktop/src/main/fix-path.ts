import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
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

/** Registry keys Windows builds a new process environment from: machine first, then user, as Explorer does. */
export const WINDOWS_ENVIRONMENT_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
] as const

/** Parses `reg query <key>` output into its string values, keeping each name's registry casing. */
export function parseRegQueryValues(stdout: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^ {4}(.+?) {4}(?:REG_SZ|REG_EXPAND_SZ)(?: {4}(.*))?$/.exec(line)
    if (match) values.set(match[1]!, match[2] ?? '')
  }
  return values
}

type EnvSource = Readonly<Record<string, string | undefined>>

/**
 * Expands `%NAME%` references as Windows does: names are case-insensitive and unknown ones stay literal.
 * Earlier sources win.
 */
export function expandWindowsEnvVars(value: string, ...sources: EnvSource[]): string {
  const lookup = new Map<string, string>()
  for (const source of sources) {
    for (const [name, v] of Object.entries(source)) {
      if (v !== undefined && !lookup.has(name.toUpperCase())) lookup.set(name.toUpperCase(), v)
    }
  }
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => lookup.get(name.toUpperCase()) ?? whole)
}

/** The process environment's PATH key; Windows spells it `Path`, and test environments may differ. */
export function pathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

function windowsPathIdentity(dir: string): string {
  return dir
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

export type RegistryKeyReader = (key: string) => Promise<string | null>

function readRegistryKey(key: string): Promise<string | null> {
  const reg = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  return new Promise((resolve) => {
    execFile(reg, ['query', key], { encoding: 'utf8', timeout: 5_000, windowsHide: true }, (error, stdout) =>
      resolve(error ? null : stdout)
    )
  })
}

export interface WindowsPathRefreshDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  readKey?: RegistryKeyReader
  exists?: (dir: string) => boolean
}

/**
 * A Windows process keeps the environment it started with, so tools installed while the app is open stay
 * invisible to it and to every child it spawns. Append the existing directories of the registry's machine and
 * user Path that the process lacks; current entries stay first, so tools already resolved keep their
 * precedence. Each call rereads the registry. Returns the directories added; a no-op off Windows.
 */
export async function refreshWindowsPathFromRegistry(deps: WindowsPathRefreshDeps = {}): Promise<string[]> {
  if ((deps.platform ?? process.platform) !== 'win32') return []
  const env = deps.env ?? process.env
  const readKey = deps.readKey ?? readRegistryKey
  const exists = deps.exists ?? existsSync
  const [machine, user] = await Promise.all(
    WINDOWS_ENVIRONMENT_KEYS.map(async (key) => parseRegQueryValues((await readKey(key).catch(() => null)) ?? ''))
  )
  // Variables an installer created next to its Path entry are known only to the registry.
  const userVars = Object.fromEntries(user)
  const machineVars = Object.fromEntries(machine)

  const key = pathEnvKey(env)
  const original = env[key] ?? ''
  const seen = new Set(original.split(';').filter(Boolean).map(windowsPathIdentity))
  const added: string[] = []
  for (const values of [machine, user]) {
    const raw = [...values].find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? ''
    for (const entry of raw.split(';')) {
      const dir = expandWindowsEnvVars(entry.trim(), env, userVars, machineVars).replace(/^"(.*)"$/, '$1')
      const identity = windowsPathIdentity(dir)
      // reg.exe prints in the console code page: skip entries that did not expand or no longer exist.
      if (!identity || dir.includes('%') || !path.win32.isAbsolute(dir) || seen.has(identity) || !exists(dir)) {
        continue
      }
      seen.add(identity)
      added.push(dir)
    }
  }
  if (added.length > 0) env[key] = [original.replace(/;+$/, ''), ...added].filter(Boolean).join(';')
  return added
}
