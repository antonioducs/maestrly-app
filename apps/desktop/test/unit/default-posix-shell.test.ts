import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  existsSync: vi.fn(),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}))

vi.mock('node:child_process', () => ({
  execFile: h.execFile,
  execFileSync: h.execFileSync,
  spawn: h.spawn,
}))
vi.mock('node:fs', () => ({ existsSync: h.existsSync }))

describe('defaultPosixShell — Linux bash/sh fallback', () => {
  let prevShell: string | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    prevShell = process.env.SHELL
    delete process.env.SHELL
  })

  afterEach(() => {
    if (prevShell === undefined) delete process.env.SHELL
    else process.env.SHELL = prevShell
  })

  it('Linux falls back to /bin/sh when /bin/bash is absent', async () => {
    h.existsSync.mockReturnValue(false)
    const { defaultPosixShell } = await import('../../src/main/platform')
    expect(defaultPosixShell('linux')).toBe('/bin/sh')
  })
})
