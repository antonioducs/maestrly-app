import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ execFileSync: vi.fn() }))
// fix-path imports defaultPosixShell from ./platform, which calls promisify(execFile) at module scope.
// The mock must expose execFile/spawn functions to prevent promisify(undefined) from throwing on import.
vi.mock('node:child_process', () => ({
  execFileSync: h.execFileSync,
  execFile: vi.fn(),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}))

import { fixPathForGuiApp } from '../../src/main/fix-path'

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
