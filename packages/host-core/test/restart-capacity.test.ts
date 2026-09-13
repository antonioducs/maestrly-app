import { afterEach, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HostService } from '../src/index.js'
import type { Image, Provider, Runtime } from '../src/provider.js'
import type { Operation, Vm } from '@maestrly/host-protocol'

const usableCapacity = vi.hoisted(() => vi.fn(() => ({ cpus: 4, memoryMiB: 4096, diskGiB: 10 })))

vi.mock('../src/capacity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/capacity.js')>()),
  usableCapacity,
}))

const skipWindows = process.platform === 'win32'
const directories: string[] = []
const services: HostService[] = []

afterEach(async () => {
  vi.clearAllMocks()
  for (const service of services.splice(0)) await service.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

class FakeProvider implements Provider {
  private readonly states = new Map<string, 'running' | 'stopped' | 'unknown'>()

  async inspectRuntime() {
    return { available: true }
  }

  async inspect(vm: Vm) {
    return this.states.get(vm.id) ?? 'stopped'
  }

  async provision(vm: Vm) {
    this.states.set(vm.id, 'stopped')
  }

  async start(vm: Vm) {
    this.states.set(vm.id, 'running')
  }

  async shutdown(vm: Vm) {
    this.states.set(vm.id, 'stopped')
  }

  async restart(vm: Vm) {
    this.states.set(vm.id, 'running')
  }

  async remove(vm: Vm) {
    this.states.delete(vm.id)
  }

  async waitReady() {
    return {
      ready: true,
      markerMatches: true,
      networkIsolated: true,
      bootId: randomUUID(),
    }
  }

  async verify() {
    return this.waitReady()
  }
}

async function finish(service: HostService, operationId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await service.dispatch({
      version: 1,
      id: randomUUID(),
      method: 'operation.get',
      params: { operationId },
    })
    const operation = response.result as Operation
    if (!['queued', 'running'].includes(operation.status)) return operation
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Operation timeout')
}

it.skipIf(skipWindows)('restarts below the configured disk ceiling and rejects only new VM creation', async () => {
  const directory = await realpath(await mkdtemp('/tmp/mh-'))
  directories.push(directory)
  const assetPath = join(directory, 'image')
  await writeFile(assetPath, 'image')
  const runtime: Runtime = {
    id: 'test',
    arch: 'arm64',
    qemu: { path: '/missing/qemu', sha256: 'a'.repeat(64) },
    qemuImg: { path: '/missing/img', sha256: 'b'.repeat(64) },
  }
  const image: Image = {
    id: 'image',
    name: 'Test',
    arch: 'arm64',
    asset: { path: assetPath, sha256: createHash('sha256').update('image').digest('hex') },
    format: 'raw',
    virtualSizeGiB: 1,
    guestAgent: true,
  }
  const provider = new FakeProvider()
  const options = {
    stateDirectory: directory,
    runtimes: [runtime],
    images: [image],
    capacity: { cpus: 4, memoryMiB: 4096, diskGiB: 10 },
    provider,
  }
  const service = new HostService(options)
  services.push(service)

  const created = await service.dispatch({
    version: 1,
    id: randomUUID(),
    method: 'vm.create',
    params: {
      name: 'existing',
      imageId: image.id,
      runtimeId: runtime.id,
      cpus: 2,
      memoryMiB: 512,
      diskGiB: 2,
      idempotencyKey: 'create-existing',
    },
  })
  const operation = created.result as Operation
  expect((await finish(service, operation.id)).status).toBe('succeeded')

  await service.close()
  usableCapacity.mockReturnValue({ cpus: 4, memoryMiB: 4096, diskGiB: 0 })

  const reopened = new HostService(options)
  services.push(reopened)
  await expect(reopened.ready()).resolves.toBeUndefined()

  const rejected = await reopened.dispatch({
    version: 1,
    id: randomUUID(),
    method: 'vm.create',
    params: {
      name: 'new',
      imageId: image.id,
      runtimeId: runtime.id,
      cpus: 2,
      memoryMiB: 512,
      diskGiB: 2,
      idempotencyKey: 'create-new',
    },
  })
  expect(rejected.error).toMatchObject({ code: 'CAPACITY_EXCEEDED' })
})
