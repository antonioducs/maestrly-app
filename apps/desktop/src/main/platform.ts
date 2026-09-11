import os from 'node:os'
import path from 'node:path'
import {
  spawn as cpSpawn,
  execFile as cpExecFile,
  execFileSync,
  type ChildProcess,
  type SpawnOptions,
  type ExecFileOptions,
} from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, accessSync, constants } from 'node:fs'
import type { SoundVoice } from '../shared/sound'
import { playManagedSound } from './sound/service'

/**
 * Central platform foundation for macOS, Windows, and Linux, matching scripts/instance-shared.mjs
 * app-data conventions. Keep platform branches explicit and preserve existing behavior. Functions
 * accept a platform argument defaulting to process.platform for lightweight cross-platform tests; pure
 * helpers cover spawn arguments, shell selection, symlink types, absolute paths, and VS Code
 * directories.
 */

export const isWin = process.platform === 'win32'
export const isMac = process.platform === 'darwin'
export const isLinux = !isWin && !isMac

const execFileAsync = promisify(cpExecFile)

// ----------------------------------------------------------------------------
// Caminhos / strings independentes de OS
// ----------------------------------------------------------------------------

/** Convert backslash separators to forward slashes for bridge paths, URIs, and agent JSON. */
export function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * Recognize absolute POSIX and Windows drive/UNC paths regardless of the host OS. Used when
 * debug/bridge inputs may follow another platform's conventions; native path.isAbsolute only
 * understands the current OS.
 */
export function isAbsolutePath(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p)
}

// CLI execution through PTY/child_process, including Windows shims.

/**
 * Resolve real executable/arguments for Windows npm shims. CreateProcess/ConPTY requires executables
 * and modern child_process rejects direct .cmd/.bat spawning: wrap them in cmd.exe /d /c. Run .ps1
 * through PowerShell -File; executables and extensionless commands remain direct. On POSIX return
 * inputs unchanged. Pure and testable.
 */
export function winSpawnArgs(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { file: string; args: string[] } {
  if (platform !== 'win32') return { file: bin, args }
  const ext = path.win32.extname(bin).toLowerCase()
  if (ext === '.cmd' || ext === '.bat') {
    // /d disables registry AutoRun commands; /c executes and exits.
    return { file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/c', bin, ...args] }
  }
  if (ext === '.ps1') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bin, ...args],
    }
  }
  return { file: bin, args }
}

/** Spawn a CLI with Windows shim handling and return its ChildProcess. */
export function spawnCli(bin: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const r = winSpawnArgs(bin, args)
  return cpSpawn(r.file, r.args, { ...opts, shell: false })
}

/** Promisified execFile with Windows shim handling; return stdout/stderr. */
export function execCli(
  bin: string,
  args: string[],
  opts: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const r = winSpawnArgs(bin, args)
  return execFileAsync(r.file, r.args, { ...opts, shell: false }) as unknown as Promise<{ stdout: string; stderr: string }>
}

// Platform-specific binary candidates and PATH lookup.

/**
 * Absolute Windows CLI candidates with .cmd/.exe suffixes for npm-global and native installations.
 * where.exe covers installations elsewhere.
 */
export function winCliCandidates(bin: string): string[] {
  const out: string[] = []
  const exts = ['.cmd', '.exe', '.bat']
  const push = (dir: string | undefined, ...sub: string[]): void => {
    if (!dir) return
    for (const ext of exts) out.push(path.win32.join(dir, ...sub, `${bin}${ext}`))
  }
  const { APPDATA, LOCALAPPDATA, ProgramFiles, USERPROFILE } = process.env
  // npm global: %APPDATA%\npm\<bin>.cmd
  push(APPDATA, 'npm')
  // Native installers: %LOCALAPPDATA%\Programs\<bin>\<bin>.exe (and \bin)
  push(LOCALAPPDATA, 'Programs', bin)
  push(LOCALAPPDATA, 'Programs', bin, 'bin')
  push(ProgramFiles, bin)
  push(ProgramFiles, bin, 'bin')
  // ~/.local/bin used by some cross-platform installers.
  push(USERPROFILE, '.local', 'bin')
  return out
}

/**
 * Fallback POSIX shell for probes. Respect SHELL; macOS defaults to zsh, while Linux uses bash/sh
 * because zsh is often absent. Pure and testable.
 */
export function defaultPosixShell(platform: NodeJS.Platform = process.platform): string {
  if (process.env.SHELL) return process.env.SHELL
  if (platform === 'linux') return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
  return '/bin/zsh'
}

/**
 * Synchronously scan current PATH without spawning: POSIX checks X_OK; Windows applies PATHEXT when no
 * extension is supplied. Return the first executable or null. GUI PATH repair covers common
 * package-manager directories, avoiding slow login shells in most cases.
 */
export function findOnPath(bin: string, platform: NodeJS.Platform = process.platform): string | null {
  const PATH = process.env.PATH
  if (!PATH) return null
  const sep = platform === 'win32' ? ';' : ':'
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const hasExt = platform === 'win32' && path.win32.extname(bin) !== ''
  const exts =
    platform === 'win32' && !hasExt
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((e) => e.trim())
          .filter(Boolean)
      : ['']
  for (const dir of PATH.split(sep)
    .map((d) => d.trim())
    .filter(Boolean)) {
    for (const ext of exts) {
      const full = join(dir, `${bin}${ext}`)
      try {
        accessSync(full, constants.X_OK)
        return full
      } catch {
        /* Try the next candidate. */
      }
    }
  }
  return null
}

/**
 * Last-resort lookup arguments: where.exe on Windows or login-shell command -v on POSIX, loading
 * nvm/asdf/Homebrew paths. Shared by sync and async helpers.
 */
function loginLookupArgs(bin: string, platform: NodeJS.Platform): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'where.exe', args: [bin] }
  return { file: defaultPosixShell(platform), args: ['-lic', `command -v ${bin}`] }
}

/** Take the first lookup result; where.exe may output multiple paths. */
function firstFromLookup(stdout: string): string | null {
  return (
    stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .pop() || null
  )
}

/**
 * Resolve an absolute binary path using fast findOnPath first, then a login shell as a last resort.
 * Return null on failure. Prefer whichBinAsync on latency-sensitive paths because synchronous shell
 * startup blocks main.
 */
export function whichBin(bin: string, platform: NodeJS.Platform = process.platform): string | null {
  const onPath = findOnPath(bin, platform)
  if (onPath) return onPath
  try {
    const { file, args } = loginLookupArgs(bin, platform)
    return firstFromLookup(execFileSync(file, args, { encoding: 'utf8', timeout: 6000 }))
  } catch {
    return null
  }
}

/**
 * Async whichBin runs login-shell fallback through execFileAsync, keeping Settings CLI detection from
 * freezing the UI when commands are missing.
 */
export async function whichBinAsync(bin: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const onPath = findOnPath(bin, platform)
  if (onPath) return onPath
  try {
    const { file, args } = loginLookupArgs(bin, platform)
    const { stdout } = await execFileAsync(file, args, { encoding: 'utf8', timeout: 6000 })
    return firstFromLookup(stdout)
  } catch {
    return null
  }
}

// Drawer shell terminal using the user's preferred shell.

/** Preferred drawer shell identifier stored in freeTerminalShell. */
export type FreeTerminalShell = 'auto' | 'cmd' | 'powershell' | 'pwsh' | 'git-bash' | string

/** Find a standard Git for Windows Bash installation, or null. */
function gitBashPath(): string | null {
  const { ProgramFiles, LOCALAPPDATA } = process.env
  const candidates = [
    ProgramFiles && path.win32.join(ProgramFiles, 'Git', 'bin', 'bash.exe'),
    ProgramFiles && path.win32.join(ProgramFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    LOCALAPPDATA && path.win32.join(LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean) as string[]
  return candidates.find((c) => existsSync(c)) ?? null
}

/**
 * Choose drawer shell and arguments by platform and user preference. POSIX uses the selected/default
 * login shell. Windows auto selects COMSPEC; support cmd, powershell, pwsh, git-bash, or a custom
 * command/path.
 */
export function freeTerminalShell(
  setting: FreeTerminalShell = 'auto',
  platform: NodeJS.Platform = process.platform
): { file: string; args: string[] } {
  if (platform !== 'win32') {
    return { file: defaultPosixShell(platform), args: ['-l'] }
  }
  switch (setting) {
    case 'cmd':
      return { file: process.env.COMSPEC || 'cmd.exe', args: [] }
    case 'powershell':
      return { file: 'powershell.exe', args: ['-NoLogo'] }
    case 'pwsh':
      return { file: 'pwsh.exe', args: ['-NoLogo'] }
    case 'git-bash':
      return { file: gitBashPath() ?? 'bash.exe', args: ['-l', '-i'] }
    case 'auto':
    case '':
      return { file: process.env.COMSPEC || 'cmd.exe', args: [] }
    default:
      // Custom shell path or command supplied by the user.
      return { file: setting, args: [] }
  }
}

/**
 * Test the selected shell by spawning and observing spawn/error, then terminate it without opening a
 * TUI. Bound execution time and return ok/error for Settings feedback.
 */
export function probeFreeTerminalShell(
  setting: FreeTerminalShell = 'auto',
  platform: NodeJS.Platform = process.platform
): Promise<{ ok: boolean; error?: string }> {
  const { file } = freeTerminalShell(setting, platform)
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: { ok: boolean; error?: string }): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    try {
      const proc = cpSpawn(file, [], { stdio: 'ignore', windowsHide: true })
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* Already exited. */
        }
        finish({ ok: true }) // spawned and remained alive, confirming the executable works
      }, 2000)
      timer.unref?.()
      proc.on('error', (e) => {
        clearTimeout(timer)
        finish({ ok: false, error: (e as Error).message }) // ENOENT and similar errors mean the shell was not found
      })
      proc.on('spawn', () => {
        clearTimeout(timer)
        try {
          proc.kill()
        } catch {
          /* Already exited. */
        }
        finish({ ok: true })
      })
    } catch (e) {
      finish({ ok: false, error: String((e as Error)?.message ?? e) })
    }
  })
}

// Stable sound facade with primary playback and native fallback owned by the sound module.

/** Play a Maestrly voice at the requested volume; synchronous interface with best-effort playback. */
export function playSound(voice: SoundVoice, volume = 1): void {
  playManagedSound(voice, volume)
}

// ----------------------------------------------------------------------------
// Open in an external OS terminal
// ----------------------------------------------------------------------------

/**
 * Open an external terminal in dir. macOS uses Terminal; Windows starts a new cmd window with a hidden
 * launcher. Linux tries gnome-terminal, konsole, xfce4-terminal, xterm, then x-terminal-emulator on
 * spawn failure. Detached/unref lets the terminal outlive the app.
 */
export function openInTerminal(dir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin') {
    cpSpawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  if (platform === 'win32') {
    // start opens a new cmd window in dir. Hide only the launching cmd.exe; the new terminal remains
    // visible.
    cpSpawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/K', 'cd', '/d', dir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    return
  }
  // Try common Linux terminal emulators in order on spawn errors, detached and unreferenced.
  const chain: Array<{ file: string; args: string[] }> = [
    { file: 'gnome-terminal', args: ['--working-directory', dir] },
    { file: 'konsole', args: ['--workdir', dir] },
    { file: 'xfce4-terminal', args: ['--working-directory', dir] },
    { file: 'xterm', args: [] },
    { file: 'x-terminal-emulator', args: [] },
  ]
  const tryAt = (i: number): void => {
    if (i >= chain.length) return
    const { file, args } = chain[i]!
    const child = cpSpawn(file, args, { cwd: dir, detached: true, stdio: 'ignore' })
    child.on('error', () => tryAt(i + 1))
    child.unref()
  }
  tryAt(0)
}

// Platform-specific VS Code serve-web user and extension directories.

/**
 * Local VS Code User directory for settings/globalStorage. Use the target platform's path conventions
 * for both runtime and cross-platform tests.
 */
export function vscodeUserDir(platform: NodeJS.Platform = process.platform): string {
  const home = os.homedir()
  const P = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'darwin') return P.join(home, 'Library', 'Application Support', 'Code', 'User')
  if (platform === 'win32') {
    return P.join(process.env.APPDATA || P.join(home, 'AppData', 'Roaming'), 'Code', 'User')
  }
  return P.join(process.env.XDG_CONFIG_HOME || P.join(home, '.config'), 'Code', 'User')
}

/** Local VS Code extension directory, ~/.vscode/extensions on every platform. */
export function vscodeExtDir(): string {
  return path.join(os.homedir(), '.vscode', 'extensions')
}

// ----------------------------------------------------------------------------
// Process tree / symlink
// ----------------------------------------------------------------------------

/** Pure parser for ps -o pid=,ppid= -ax output into a pid-to-ppid map; ignore malformed lines. */
export function parsePsTreeLines(stdout: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (Number.isInteger(pid) && Number.isInteger(ppid)) out.set(pid, ppid)
  }
  return out
}

/** Pure parser for Windows process-list JSON. */
export function parseWindowsTreeJson(stdout: string): Map<number, number> {
  const out = new Map<number, number>()
  const trimmed = stdout.trim()
  if (!trimmed) return out
  try {
    const parsed = JSON.parse(trimmed) as
      | Array<{ ProcessId?: number; ParentProcessId?: number }>
      | { ProcessId?: number; ParentProcessId?: number }
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    for (const row of rows) {
      if (typeof row?.ProcessId === 'number' && typeof row.ParentProcessId === 'number') {
        out.set(row.ProcessId, row.ParentProcessId)
      }
    }
  } catch {
    /* PowerShell may return empty or non-JSON output on failure; handle it defensively. */
  }
  return out
}

/**
 * Expand roots to live descendants using breadth-first traversal with one visit per PID. Do not
 * include or traverse another root as a descendant, avoiding double-counting overlapping process
 * records.
 */
export function descendantsOf(pidToPpid: Map<number, number>, roots: readonly number[]): Map<number, number[]> {
  const out = new Map<number, number[]>()
  const rootSet = new Set(roots.filter((pid) => Number.isInteger(pid) && pid > 0))
  const childrenOf = new Map<number, number[]>()
  for (const [pid, ppid] of pidToPpid) {
    const list = childrenOf.get(ppid)
    if (list) list.push(pid)
    else childrenOf.set(ppid, [pid])
  }
  for (const root of rootSet) {
    const seen = new Set<number>([root])
    const queue = childrenOf.get(root) ?? []
    const descendants: number[] = []
    while (queue.length > 0) {
      const pid = queue.shift()!
      if (seen.has(pid)) continue
      seen.add(pid)
      if (!rootSet.has(pid)) {
        descendants.push(pid)
        queue.push(...(childrenOf.get(pid) ?? []))
      }
    }
    descendants.sort((a, b) => a - b)
    out.set(root, descendants)
  }
  return out
}

/**
 * List live descendants for tree RSS sampling with one POSIX ps call or Windows Get-CimInstance
 * Win32_Process. On failure return an empty map so sampling degrades to root-only.
 */
export async function listDescendantPids(
  roots: readonly number[],
  opts: { timeoutMs?: number; platform?: NodeJS.Platform } = {}
): Promise<Map<number, number[]>> {
  const unique = [...new Set(roots.filter((pid) => Number.isInteger(pid) && pid > 0))]
  if (unique.length === 0) return new Map()
  const timeout = opts.timeoutMs ?? 5_000
  const platform = opts.platform ?? process.platform
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
        ],
        { timeout, windowsHide: true }
      )
      return descendantsOf(parseWindowsTreeJson(stdout), unique)
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,ppid=', '-ax'], { timeout })
    return descendantsOf(parsePsTreeLines(stdout), unique)
  } catch {
    return new Map()
  }
}

/**
 * Terminate a process tree: POSIX kills the detached process group with parent fallback; Windows uses
 * taskkill /T /F to avoid orphaned serve-web children. Resolve when the termination command finishes;
 * ChildProcess owners must also await close.
 */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!pid) return Promise.resolve()
  if (platform === 'win32') {
    try {
      const killer = cpSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        if (typeof killer.once === 'function') {
          killer.once('close', finish)
          killer.once('error', finish)
        } else {
          // Defensive seam for lightweight test doubles; real ChildProcess always has `once`.
          finish()
        }
      })
    } catch {
      /* Already terminated. */
    }
    return Promise.resolve()
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* Already terminated. */
    }
  }
  return Promise.resolve()
}

/**
 * Directory link type: Windows junctions avoid privilege/Developer Mode requirements; POSIX uses dir.
 * See guarded cleanup in aggregator-service.
 */
export function symlinkDirType(platform: NodeJS.Platform = process.platform): 'junction' | 'dir' {
  return platform === 'win32' ? 'junction' : 'dir'
}
