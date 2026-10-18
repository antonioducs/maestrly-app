import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ execFileSync: vi.fn(), execFile: vi.fn() }))
// fix-path imports defaultPosixShell from ./platform, which calls promisify(execFile) at module scope.
// The mock must expose execFile/spawn functions to prevent promisify(undefined) from throwing on import.
vi.mock('node:child_process', () => ({
  execFileSync: h.execFileSync,
  execFile: h.execFile,
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}))

import {
  expandWindowsEnvVars,
  fixPathForGuiApp,
  parseRegQueryValues,
  refreshWindowsPathFromRegistry,
  WINDOWS_ENVIRONMENT_KEYS,
} from '../../src/main/fix-path'

describe('fixPathForGuiApp — PATH merging for GUI apps (POSIX)', () => {
  let prevPath: string | undefined
  let prevHome: string | undefined
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    prevPath = process.env.PATH
    prevHome = process.env.HOME
    process.env.HOME = '/home/tester'
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
  })

  it('successful probe merges login-shell PATH with known directories', () => {
    process.env.PATH = '/usr/bin'
    h.execFileSync.mockReturnValue('ruido\n__APPPATH__:/custom/bin:/usr/bin')
    fixPathForGuiApp()
    const dirs = (process.env.PATH || '').split(':')
    expect(dirs).toContain('/custom/bin')
    expect(dirs).toContain('/home/tester/.local/bin')
    expect(dirs).toContain('/snap/bin')
  })

  it('a failed probe without a usable $SHELL still merges ~/.local/bin and /snap/bin', () => {
    process.env.PATH = '/usr/bin'
    h.execFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    fixPathForGuiApp()
    const dirs = (process.env.PATH || '').split(':')
    expect(dirs).toContain('/home/tester/.local/bin')
    expect(dirs).toContain('/snap/bin')
    expect(dirs).toContain('/usr/bin')
  })
})

const MACHINE_QUERY = [
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  '    ComSpec    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe',
  '    NUMBER_OF_PROCESSORS    REG_SZ    4',
  '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\Git\\cmd;%TOOL_HOME%\\bin;',
  '    TOOL_HOME    REG_SZ    D:\\Tool',
  '    DriverData    REG_DWORD    0x0',
  '',
].join('\r\n')

const USER_QUERY = [
  '',
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;"%LOCALAPPDATA%\\Programs\\Tool"',
  '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
  '',
].join('\r\n')

describe('Windows registry PATH refresh', () => {
  it('parses string values from reg query output and skips other types', () => {
    const values = parseRegQueryValues(MACHINE_QUERY)
    expect(values.get('Path')).toBe('%SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\Git\\cmd;%TOOL_HOME%\\bin;')
    expect(values.get('TOOL_HOME')).toBe('D:\\Tool')
    expect(values.has('DriverData')).toBe(false)
    expect(parseRegQueryValues('    Path    REG_SZ').get('Path')).toBe('')
  })

  it('expands %VAR% case-insensitively, earlier sources first, and keeps unknown names literal', () => {
    expect(expandWindowsEnvVars('%systemroot%\\system32', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\system32')
    expect(expandWindowsEnvVars('%A%;%B%', { A: 'first' }, { A: 'second', b: 'other' })).toBe('first;other')
    expect(expandWindowsEnvVars('%MISSING%\\bin;100%', {})).toBe('%MISSING%\\bin;100%')
  })

  it('appends registry entries the process lacks, after the current ones, and never caches', async () => {
    const env: NodeJS.ProcessEnv = {
      Path: 'C:\\Windows\\system32;C:\\Windows\\',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\ana',
      LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local',
    }
    const installed = new Set([
      'C:\\Windows\\system32',
      'C:\\Windows',
      'D:\\Tool\\bin',
      'C:\\Users\\ana\\AppData\\Local\\Programs\\Tool',
    ])
    const readKey = vi.fn(async (key: string) => (key.startsWith('HKLM') ? MACHINE_QUERY : USER_QUERY))
    const exists = (dir: string) => installed.has(dir)

    expect(await refreshWindowsPathFromRegistry({ platform: 'win32', env, readKey, exists })).toEqual([
      'D:\\Tool\\bin',
      'C:\\Users\\ana\\AppData\\Local\\Programs\\Tool',
    ])
    expect(readKey.mock.calls.map(([key]) => key)).toEqual([...WINDOWS_ENVIRONMENT_KEYS])
    expect(env.Path).toBe(
      'C:\\Windows\\system32;C:\\Windows\\;D:\\Tool\\bin;C:\\Users\\ana\\AppData\\Local\\Programs\\Tool'
    )
    expect(env.PATH).toBeUndefined()

    // Git installed afterwards: the next call rereads the registry instead of reusing the earlier answer.
    installed.add('C:\\Program Files\\Git\\cmd')
    expect(await refreshWindowsPathFromRegistry({ platform: 'win32', env, readKey, exists })).toEqual([
      'C:\\Program Files\\Git\\cmd',
    ])
    expect(readKey).toHaveBeenCalledTimes(4)
    expect(await refreshWindowsPathFromRegistry({ platform: 'win32', env, readKey, exists })).toEqual([])
  })

  it('skips unexpanded entries and tolerates an unreadable registry', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '' }
    const added = await refreshWindowsPathFromRegistry({
      platform: 'win32',
      env,
      readKey: async (key) => {
        if (key.startsWith('HKCU')) throw new Error('access denied')
        return MACHINE_QUERY
      },
      exists: () => true,
    })
    expect(added).toEqual(['C:\\Program Files\\Git\\cmd', 'D:\\Tool\\bin'])
    expect(env.PATH).toBe('C:\\Program Files\\Git\\cmd;D:\\Tool\\bin')
  })

  it('reads the registry with reg.exe from System32', async () => {
    const prevRoot = process.env.SystemRoot
    process.env.SystemRoot = 'C:\\Windows'
    h.execFile.mockImplementation(
      (_file: string, args: string[], _opts: unknown, callback: (e: Error | null, out?: string) => void) =>
        callback(null, args[1]?.startsWith('HKLM') ? MACHINE_QUERY : USER_QUERY)
    )
    try {
      const env: NodeJS.ProcessEnv = { PATH: 'C:\\Program Files\\Git\\cmd' }
      await refreshWindowsPathFromRegistry({ platform: 'win32', env, exists: () => true })
      expect(h.execFile).toHaveBeenCalledWith(
        'C:\\Windows\\System32\\reg.exe',
        ['query', WINDOWS_ENVIRONMENT_KEYS[0]],
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function)
      )
      expect(env.PATH).toBe('C:\\Program Files\\Git\\cmd;D:\\Tool\\bin')
    } finally {
      h.execFile.mockReset()
      if (prevRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = prevRoot
    }
  })

  it('is a no-op off Windows', async () => {
    const readKey = vi.fn()
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    expect(await refreshWindowsPathFromRegistry({ platform: 'linux', env, readKey })).toEqual([])
    expect(await refreshWindowsPathFromRegistry({ platform: 'darwin', env, readKey })).toEqual([])
    expect(readKey).not.toHaveBeenCalled()
    expect(env.PATH).toBe('/usr/bin')
  })
})
