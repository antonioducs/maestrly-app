import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Platform helpers receive an explicit OS argument. Mock child_process to inspect taskkill and external terminal spawns without real side effects. */

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, existsSync: (file: import('node:fs').PathLike) => file === '/bin/bash' || real.existsSync(file) }
})

const h = vi.hoisted(() => ({
  spawn: vi.fn((..._args: unknown[]) => ({ on: vi.fn(), unref: vi.fn() })),
  // The callback is the last function argument in both execFile overloads used by promisify.
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as ((e: unknown, r: unknown) => void) | undefined
    cb?.(null, { stdout: '', stderr: '' })
  }),
  execFileSync: vi.fn(() => ''),
}))

vi.mock('node:child_process', () => ({
  spawn: h.spawn,
  execFile: h.execFile,
  execFileSync: h.execFileSync,
}))

import {
  winSpawnArgs,
  freeTerminalShell,
  symlinkDirType,
  isAbsolutePath,
  toForwardSlashes,
  vscodeUserDir,
  vscodeExtDir,
  winCliCandidates,
  killProcessTree,
  openInTerminal,
  spawnCli,
  execCli,
  whichBin,
  whichBinAsync,
  findOnPath,
  defaultPosixShell,
} from '../../src/main/platform'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('winSpawnArgs — Windows shim wrapper (.cmd/.bat/.ps1)', () => {
  const cmdBin = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'

  it('win: .cmd uses cmd.exe /d /c <bin> <args>, preserving arguments', () => {
    const r = winSpawnArgs(cmdBin, ['--session-id', 'abc', '--no-chrome'], 'win32')
    expect(r.file).toMatch(/cmd\.exe$/i)
    expect(r.args).toEqual(['/d', '/c', cmdBin, '--session-id', 'abc', '--no-chrome'])
  })

  it('win: runs .bat through cmd.exe', () => {
    const r = winSpawnArgs('C:\\tools\\codex.bat', ['resume'], 'win32')
    expect(r.file).toMatch(/cmd\.exe$/i)
    expect(r.args).toEqual(['/d', '/c', 'C:\\tools\\codex.bat', 'resume'])
  })

  it('win: runs .ps1 through PowerShell -File', () => {
    const r = winSpawnArgs('C:\\tools\\cursor.ps1', ['--force'], 'win32')
    expect(r.file).toBe('powershell.exe')
    expect(r.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\tools\\cursor.ps1',
      '--force',
    ])
  })

  it('win: runs .exe and extensionless files directly', () => {
    expect(winSpawnArgs('C:\\Program Files\\claude\\claude.exe', ['-v'], 'win32')).toEqual({
      file: 'C:\\Program Files\\claude\\claude.exe',
      args: ['-v'],
    })
    expect(winSpawnArgs('claude', ['-v'], 'win32')).toEqual({ file: 'claude', args: ['-v'] })
  })

  it('posix: never wraps the command', () => {
    expect(winSpawnArgs('/opt/homebrew/bin/claude', ['-r', 'id'], 'darwin')).toEqual({
      file: '/opt/homebrew/bin/claude',
      args: ['-r', 'id'],
    })
    expect(winSpawnArgs('codex', ['resume'], 'linux')).toEqual({ file: 'codex', args: ['resume'] })
  })
})

describe('freeTerminalShell — per-OS terminal shell and setting', () => {
  it('posix preserves $SHELL || /bin/zsh with -l', () => {
    const prev = process.env.SHELL
    process.env.SHELL = '/bin/zsh'
    expect(freeTerminalShell('auto', 'darwin')).toEqual({ file: '/bin/zsh', args: ['-l'] })
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
  })

  it('win auto → cmd (COMSPEC)', () => {
    const r = freeTerminalShell('auto', 'win32')
    expect(r.file).toMatch(/cmd\.exe$/i)
    expect(r.args).toEqual([])
  })

  it('win cmd/powershell/pwsh', () => {
    expect(freeTerminalShell('powershell', 'win32').file).toBe('powershell.exe')
    expect(freeTerminalShell('pwsh', 'win32').file).toBe('pwsh.exe')
    expect(freeTerminalShell('cmd', 'win32').file).toMatch(/cmd\.exe$/i)
  })

  it('win custom path runs directly', () => {
    expect(freeTerminalShell('C:\\msys64\\usr\\bin\\bash.exe', 'win32')).toEqual({
      file: 'C:\\msys64\\usr\\bin\\bash.exe',
      args: [],
    })
  })

  it('linux without $SHELL uses /bin/bash with -l', () => {
    const prev = process.env.SHELL
    delete process.env.SHELL
    expect(freeTerminalShell('auto', 'linux')).toEqual({ file: '/bin/bash', args: ['-l'] })
    if (prev !== undefined) process.env.SHELL = prev
  })
})

describe('symlinkDirType / isAbsolutePath / toForwardSlashes', () => {
  it('symlinkDirType: win=junction, posix=dir', () => {
    expect(symlinkDirType('win32')).toBe('junction')
    expect(symlinkDirType('darwin')).toBe('dir')
    expect(symlinkDirType('linux')).toBe('dir')
  })

  it('isAbsolutePath accepts POSIX and Windows paths', () => {
    expect(isAbsolutePath('/usr/local/bin')).toBe(true)
    expect(isAbsolutePath('C:\\Users\\me')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
    expect(isAbsolutePath('src/main/index.ts')).toBe(false)
    expect(isAbsolutePath('..\\x')).toBe(false)
  })

  it('toForwardSlashes replaces backslashes with forward slashes', () => {
    expect(toForwardSlashes('a\\b\\c')).toBe('a/b/c')
    expect(toForwardSlashes('a/b/c')).toBe('a/b/c')
  })
})

describe('vscodeUserDir / vscodeExtDir per OS', () => {
  it('mac, Windows, and Linux resolve the correct VS Code User directory', () => {
    expect(vscodeUserDir('darwin')).toMatch(/Library\/Application Support\/Code\/User$/)
    const prev = process.env.APPDATA
    process.env.APPDATA = 'C:\\Users\\me\\AppData\\Roaming'
    expect(vscodeUserDir('win32')).toBe('C:\\Users\\me\\AppData\\Roaming\\Code\\User')
    if (prev === undefined) delete process.env.APPDATA
    else process.env.APPDATA = prev
    expect(vscodeUserDir('linux')).toMatch(/Code\/User$/)
  })

  it('vscodeExtDir = ~/.vscode/extensions', () => {
    expect(vscodeExtDir()).toMatch(/[/\\]\.vscode[/\\]extensions$/)
  })
})

describe('winCliCandidates', () => {
  it('includes the npm shim and Programs installer as absolute paths with suffixes', () => {
    const prev = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
    process.env.APPDATA = 'C:\\Users\\me\\AppData\\Roaming'
    process.env.LOCALAPPDATA = 'C:\\Users\\me\\AppData\\Local'
    const c = winCliCandidates('claude')
    expect(c).toContain('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
    expect(c.some((p) => /Programs\\claude\\claude\.exe$/.test(p))).toBe(true)
    expect(c.every((p) => /\.(cmd|exe|bat)$/.test(p))).toBe(true)
    process.env.APPDATA = prev.APPDATA
    process.env.LOCALAPPDATA = prev.LOCALAPPDATA
  })
})

describe('killProcessTree — Windows uses taskkill /T /F', () => {
  it('win: spawns taskkill for the tree', () => {
    killProcessTree(1234, 'win32')
    expect(h.spawn).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '1234', '/T', '/F'],
      expect.objectContaining({ windowsHide: true })
    )
  })

  it('zero or missing PID is a no-op', () => {
    killProcessTree(0, 'win32')
    expect(h.spawn).not.toHaveBeenCalled()
  })
})

describe('openInTerminal — external terminal per OS', () => {
  it('mac: open -a Terminal <dir>', () => {
    openInTerminal('/tmp/x', 'darwin')
    expect(h.spawn).toHaveBeenCalledWith(
      'open',
      ['-a', 'Terminal', '/tmp/x'],
      expect.objectContaining({ detached: true })
    )
  })

  it('win: uses cmd start with windowsHide', () => {
    openInTerminal('C:\\tmp\\x', 'win32')
    const call = h.spawn.mock.calls.at(-1)!
    expect(call[0]).toBe('cmd.exe')
    expect(call[2]).toMatchObject({ windowsHide: true, detached: true })
  })

  it('linux: uses gnome-terminal --working-directory <dir> with cwd', () => {
    openInTerminal('/tmp/x', 'linux')
    expect(h.spawn).toHaveBeenCalledWith(
      'gnome-terminal',
      ['--working-directory', '/tmp/x'],
      expect.objectContaining({ cwd: '/tmp/x', detached: true })
    )
  })

  it('linux: falls back to konsole when gnome-terminal fails with ENOENT', () => {
    h.spawn.mockImplementationOnce(() => ({
      on: vi.fn((ev: string, cb: () => void) => {
        if (ev === 'error') cb()
      }),
      unref: vi.fn(),
    }))
    openInTerminal('/tmp/x', 'linux')
    const files = h.spawn.mock.calls.map((c) => c[0])
    expect(files[0]).toBe('gnome-terminal')
    expect(files[1]).toBe('konsole')
  })
})

describe('spawnCli delegates the resolved file and arguments to child_process', () => {
  it('forwards binary and arguments to spawn on the current platform', () => {
    spawnCli('/opt/homebrew/bin/claude', ['-p'], { cwd: '/tmp' })
    expect(h.spawn).toHaveBeenCalledTimes(1)
    const call = h.spawn.mock.calls[0]!
    // POSIX CI preserves file and arguments; winSpawnArgs above covers Windows.
    expect(call[2]).toMatchObject({ cwd: '/tmp' })
  })
})

describe('CLI wrappers keep arguments out of an implicit shell', () => {
  it('forces direct spawning even when shell is requested', () => {
    spawnCli('/tmp/tool with spaces', ['$(echo unsafe)', '&'], { shell: true })
    expect(h.spawn).toHaveBeenCalledWith('/tmp/tool with spaces', ['$(echo unsafe)', '&'], { shell: false })
  })

  it('forces direct execFile even when shell is requested', async () => {
    await execCli('/tmp/tool with spaces', ['$(echo unsafe)', '&'], { shell: true })
    expect(h.execFile).toHaveBeenCalledWith(
      '/tmp/tool with spaces', ['$(echo unsafe)', '&'], { shell: false }, expect.any(Function)
    )
  })
})

describe('whichBin / defaultPosixShell — per-OS shell fallback', () => {
  it('linux without $SHELL probes with /bin/bash when the binary is absent from PATH', () => {
    const prevShell = process.env.SHELL
    const prevPath = process.env.PATH
    delete process.env.SHELL
    process.env.PATH = mkdtempSync(join(tmpdir(), 'empty-')) // Empty directory makes findOnPath fall back to the shell.
    whichBin('claude', 'linux')
    expect(h.execFileSync).toHaveBeenCalledWith('/bin/bash', ['-lic', 'command -v claude'], expect.any(Object))
    if (prevShell !== undefined) process.env.SHELL = prevShell
    process.env.PATH = prevPath
  })

  it('defaultPosixShell: linux uses /bin/bash, mac uses /bin/zsh without $SHELL', () => {
    const prev = process.env.SHELL
    delete process.env.SHELL
    expect(defaultPosixShell('linux')).toBe('/bin/bash')
    expect(defaultPosixShell('darwin')).toBe('/bin/zsh')
    if (prev !== undefined) process.env.SHELL = prev
  })
})

describe('findOnPath / whichBinAsync — PATH resolution without a login shell', () => {
  const prevPath = process.env.PATH
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whichbin-'))
  })
  afterEach(() => {
    process.env.PATH = prevPath
  })

  const mkExe = (name: string): string => {
    const p = join(dir, process.platform === 'win32' ? `${name}.EXE` : name)
    writeFileSync(p, '#!/bin/sh\n')
    chmodSync(p, 0o755)
    return p
  }

  it('findOnPath finds a native executable using JavaScript without spawning a shell', () => {
    const bin = mkExe('mytool')
    process.env.PATH = dir
    expect(findOnPath('mytool', process.platform)).toBe(bin)
    expect(h.execFileSync).not.toHaveBeenCalled()
  })

  it('findOnPath returns null when no PATH directory contains the binary', () => {
    process.env.PATH = dir
    expect(findOnPath('missing-xyz', 'linux')).toBeNull()
  })

  it('whichBin checks PATH first and avoids a login shell when found', () => {
    const bin = mkExe('mytool')
    process.env.PATH = dir
    expect(whichBin('mytool', process.platform)).toBe(bin)
    expect(h.execFileSync).not.toHaveBeenCalled()
  })

  it('whichBinAsync resolves through PATH without execFile or blocking main', async () => {
    const bin = mkExe('mytool')
    process.env.PATH = dir
    await expect(whichBinAsync('mytool', process.platform)).resolves.toBe(bin)
    expect(h.execFile).not.toHaveBeenCalled()
  })

  it('whichBinAsync falls back to an asynchronous login shell when absent from PATH', async () => {
    process.env.PATH = dir
    h.execFile.mockImplementationOnce((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as ((e: unknown, r: unknown) => void) | undefined
      cb?.(null, { stdout: '/usr/bin/mytool\n', stderr: '' })
    })
    await expect(whichBinAsync('mytool', process.platform)).resolves.toBe('/usr/bin/mytool')
    expect(h.execFile).toHaveBeenCalledTimes(1)
  })
})
