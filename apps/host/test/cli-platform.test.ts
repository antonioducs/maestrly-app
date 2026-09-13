import { afterEach, expect, it, vi } from 'vitest'
import { lstat } from 'node:fs/promises'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  lstat: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it.each([
  ['win32', 'daemon'], ['win32', 'rpc-stdio'],
  ['linux', 'daemon'], ['linux', 'rpc-stdio'],
])('rejects %s %s before fixed filesystem access', async (platform, command) => {
  vi.resetModules()
  const write = vi.fn()
  const stub = Object.create(process)
  Object.defineProperties(stub, {
    platform: { value: platform },
    argv: { value: ['node', 'cli.js', command] },
    stderr: { value: { write } },
    exitCode: { value: undefined, writable: true },
  })
  vi.stubGlobal('process', stub)
  await import('../src/cli.js')
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith('maestrly-host: daemon and rpc-stdio require macOS\n'))
  expect(stub.exitCode).toBe(1)
  expect(lstat).not.toHaveBeenCalled()
})
