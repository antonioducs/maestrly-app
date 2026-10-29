import os from 'node:os'
import { FLEET_RUNNER_PROTOCOL_VERSION, fleetRunnerCapabilitiesSchema } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { probeRunnerCapabilities } from '../../src/main/runner/capabilities'
import { createLoginShellPath } from '../../src/main/runner/login-path'

const missing = async () => {
  throw new Error('not found')
}

describe('runner capabilities', () => {
  it('describes the computer in the shape the gateway checks', async () => {
    const capabilities = await probeRunnerCapabilities({ executor: 'native', slots: 2, exec: missing })
    expect(fleetRunnerCapabilitiesSchema.parse(capabilities)).toEqual(capabilities)
    expect(capabilities).toMatchObject({
      protocol: FLEET_RUNNER_PROTOCOL_VERSION,
      executor: 'native',
      slots: 2,
      cpus: os.availableParallelism(),
      memoryBytes: os.totalmem(),
      gpu: null,
    })
  })

  it('maps platforms to operating systems and clamps the slots', async () => {
    const probe = (platform: NodeJS.Platform, slots: number) =>
      probeRunnerCapabilities({ executor: 'container', slots, platform, exec: missing })
    expect((await probe('darwin', 1)).os).toBe('macos')
    expect((await probe('linux', 1)).os).toBe('linux')
    expect((await probe('win32', 1)).os).toBe('windows')
    expect((await probe('linux', 0)).slots).toBe(1)
    expect((await probe('linux', 99)).slots).toBe(8)
    expect((await probeRunnerCapabilities({ executor: 'native', slots: 1, arch: 'arm64', exec: missing })).arch).toBe(
      'arm64'
    )
    expect((await probeRunnerCapabilities({ executor: 'native', slots: 1, arch: 'x64', exec: missing })).arch).toBe(
      'x64'
    )
  })

  it('reports the first NVIDIA GPU nvidia-smi lists, with its memory in bytes', async () => {
    const calls: Array<[string, string[]]> = []
    const capabilities = await probeRunnerCapabilities({
      executor: 'container',
      slots: 1,
      platform: 'linux',
      exec: async (file, args) => {
        calls.push([file, args])
        return 'NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 3090, 24576\n'
      },
    })
    expect(capabilities.gpu).toEqual({
      vendor: 'nvidia',
      name: 'NVIDIA GeForce RTX 4090',
      memoryBytes: 24564 * 1024 * 1024,
    })
    expect(calls).toEqual([['nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']]])
  })

  it('keeps a GPU name that has a comma, and reports unknown memory as null', async () => {
    const odd = await probeRunnerCapabilities({
      executor: 'native',
      slots: 1,
      platform: 'linux',
      exec: async () => 'Fancy, Card Pro, 8192\n',
    })
    expect(odd.gpu).toEqual({ vendor: 'nvidia', name: 'Fancy, Card Pro', memoryBytes: 8192 * 1024 * 1024 })
    const unknown = await probeRunnerCapabilities({
      executor: 'native',
      slots: 1,
      platform: 'linux',
      exec: async () => 'Some GPU, [N/A]\n',
    })
    expect(unknown.gpu).toEqual({ vendor: 'nvidia', name: 'Some GPU', memoryBytes: null })
  })

  it('has no GPU when nvidia-smi is absent, fails or lists nothing', async () => {
    expect(
      (await probeRunnerCapabilities({ executor: 'native', slots: 1, platform: 'linux', exec: missing })).gpu
    ).toBeNull()
    expect(
      (await probeRunnerCapabilities({ executor: 'native', slots: 1, platform: 'win32', exec: async () => '\n' })).gpu
    ).toBeNull()
  })

  it('names the chip of an Apple silicon Mac and has no memory figure for it', async () => {
    const calls: Array<[string, string[]]> = []
    const capabilities = await probeRunnerCapabilities({
      executor: 'native',
      slots: 1,
      platform: 'darwin',
      exec: async (file, args) => {
        calls.push([file, args])
        return 'Apple M2 Pro\n'
      },
    })
    expect(capabilities.gpu).toEqual({ vendor: 'apple', name: 'Apple M2 Pro', memoryBytes: null })
    expect(calls).toEqual([['sysctl', ['-n', 'machdep.cpu.brand_string']]])
    const intel = await probeRunnerCapabilities({
      executor: 'native',
      slots: 1,
      platform: 'darwin',
      exec: async () => 'Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz\n',
    })
    expect(intel.gpu).toBeNull()
  })
})

describe('login shell PATH', () => {
  it('asks the login shell once and remembers the answer', async () => {
    const calls: Array<[string, string[]]> = []
    const path = createLoginShellPath({
      platform: 'linux',
      home: () => '/home/me',
      exec: async (file, args) => {
        calls.push([file, args])
        // A noisy shell: the marker tells where the PATH starts.
        return 'welcome banner\n__RUNNER_PATH__:/home/me/.nvm/bin:/usr/local/bin:/usr/bin'
      },
    })
    const first = await path()
    expect(first.split(':').slice(0, 3)).toEqual(['/home/me/.nvm/bin', '/usr/local/bin', '/usr/bin'])
    // The directories package managers use follow it, once each.
    expect(first.split(':')).toContain('/opt/homebrew/bin')
    expect(first.split(':')).toContain('/home/me/.local/bin')
    expect(first.split(':').filter((dir) => dir === '/usr/bin')).toHaveLength(1)
    expect(await path()).toBe(first)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1][0]).toBe('-lic')
  })

  it('falls back on the PATH it was given when the shell does not answer', async () => {
    const path = createLoginShellPath({
      platform: 'linux',
      home: () => '/home/me',
      fallback: () => '/custom/bin:/usr/bin',
      exec: missing,
    })
    const result = (await path()).split(':')
    expect(result.slice(0, 2)).toEqual(['/custom/bin', '/usr/bin'])
    expect(result).toContain('/usr/local/bin')
  })
})
