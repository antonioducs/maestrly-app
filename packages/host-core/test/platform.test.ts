import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostService } from '../src/service.js'
import { HostStore } from '../src/persistence/store.js'
import { bootSession, processStart } from '../src/persistence/launch.js'

afterEach(() => vi.unstubAllGlobals())

function platform(platform: string, getuid: (() => number) | undefined = () => 1000) {
  const stub = Object.create(process)
  Object.defineProperties(stub, { platform: { value: platform }, getuid: { value: getuid, configurable: true } })
  vi.stubGlobal('process', stub)
}

it.each(['win32', 'freebsd'])('rejects %s storage before creating a directory or database', async (os) => {
  const directory = await mkdtemp(join(tmpdir(), 'mh-platform-'))
  const stateDirectory = join(directory, 'state')
  platform(os)
  try {
    expect(() => new HostService({ stateDirectory, runtimes: [], images: [] })).toThrow('POSIX ownership')
    expect(() => new HostStore(directory)).toThrow('POSIX ownership')
    await expect(access(join(directory, 'owner.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(stateDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('requires an actual ownership API without substituting root', () => {
  platform('linux')
  Object.defineProperty(process, 'getuid', { value: undefined, configurable: true })
  expect(() => new HostService({ stateDirectory: 'unused', runtimes: [], images: [] })).toThrow('POSIX ownership')
  expect(() => new HostStore('unused')).toThrow('POSIX ownership')
})

it.each(['win32', 'freebsd'])('never treats unsupported %s process identity as a dead process', async (os) => {
  platform(os)
  await expect(bootSession()).rejects.toThrow('only on macOS or Linux')
  await expect(processStart(123)).rejects.toThrow('only on macOS or Linux')
})
