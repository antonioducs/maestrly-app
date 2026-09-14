import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// POSIX ownership, directory fsync, Unix sockets and executable shebang fixtures.
const skipWindows = process.platform === 'win32'
import { createServer, type Server } from 'node:net'
import { HostService } from '../src/index.js'
import { verifyAsset, stageAsset } from '../src/assets.js'
import { noCloudSeed } from '../src/seed.js'
import { buildQemuArgs } from '../src/qemu.js'
import { JsonChannel } from '../src/qmp.js'
import { QemuProvider, type Provider, type Runtime } from '../src/provider.js'
import type { Vm, Operation } from '@maestrly/host-protocol'
const directories: string[] = []
const services: HostService[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const service of services.splice(0)) await service.close()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function directory() {
  const value = await realpath(await mkdtemp('/tmp/mh-'))
  directories.push(value)
  return value
}
const runtime: Runtime = {
  id: 'test',
  arch: 'arm64',
  qemu: { path: '/missing/qemu', sha256: 'a'.repeat(64) },
  qemuImg: { path: '/missing/img', sha256: 'b'.repeat(64) },
}
const vm: Vm = {
  id: '11111111-1111-4111-8111-111111111111',
  identity: '22222222-2222-4222-8222-222222222222',
  name: 'test',
  runtimeId: 'test',
  imageId: 'image',
  cpus: 2,
  memoryMiB: 512,
  diskGiB: 2,
  revision: 0,
  state: 'stopped',
  desiredState: 'stopped',
  health: 'unknown',
  startupPolicy: 'manual',
  diskRetained: true,
  createdAt: 'now',
  updatedAt: 'now',
}
class FakeProvider implements Provider {
  states = new Map<string, 'running' | 'stopped' | 'unknown'>()
  calls: string[] = []
  async inspectRuntime() {
    return { available: true }
  }
  async inspect(vm: Vm) {
    return this.states.get(vm.id) ?? ('stopped' as const)
  }
  async provision(vm: Vm) {
    this.calls.push('provision')
    this.states.set(vm.id, 'stopped')
  }
  async start(vm: Vm) {
    this.calls.push('start')
    this.states.set(vm.id, 'running')
  }
  async shutdown(vm: Vm) {
    this.calls.push('shutdown')
    this.states.set(vm.id, 'stopped')
  }
  async restart() {
    this.calls.push('restart')
  }
  async waitReady() {
    this.calls.push('ready')
    return {
      ready: true,
      markerMatches: true,
      networkIsolated: true,
      bootId: '33333333-3333-4333-8333-333333333333',
    }
  }
  async verify() {
    return this.waitReady()
  }
  async remove(vm: Vm) {
    this.calls.push('remove')
    this.states.delete(vm.id)
  }
}
async function setup(capacity = { cpus: 4, memoryMiB: 4096, diskGiB: 10 }) {
  const dir = await directory()
  const asset = join(dir, 'image')
  await writeFile(asset, 'image')
  const provider = new FakeProvider()
  const options = {
    stateDirectory: dir,
    runtimes: [runtime],
    images: [
      {
        id: 'image',
        name: 'Test',
        arch: 'arm64' as const,
        asset: {
          path: asset,
          sha256: createHash('sha256').update('image').digest('hex'),
        },
        format: 'raw' as const,
        virtualSizeGiB: 1,
        guestAgent: true as const,
      },
    ],
    capacity,
    provider,
  }
  const service = new HostService(options)
  services.push(service)
  return { service, provider, options }
}
const createParams = {
  name: 'vm',
  imageId: 'image',
  runtimeId: 'test',
  cpus: 2,
  memoryMiB: 512,
  diskGiB: 2,
  idempotencyKey: 'create',
}
async function call(service: HostService, method: string, params: unknown = {}) {
  return service.dispatch({ version: 1, id: randomUUID(), method, params })
}
async function finish(service: HostService, id: string) {
  for (let i = 0; i < 200; i++) {
    const response = await call(service, 'operation.get', { operationId: id })
    const operation = response.result as Operation
    if (!['queued', 'running'].includes(operation.status)) return operation
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Operation timeout')
}
describe('durable host lifecycle', () => {
  it.skipIf(skipWindows)('reuses operations, persists revisions/events and rejects key mismatches', async () => {
    const { service, provider, options } = await setup()
    const response = await call(service, 'vm.create', createParams)
    expect(response.error).toBeUndefined()
    const op = response.result as Operation
    expect((await call(service, 'vm.create', createParams)).result).toMatchObject({ id: op.id })
    expect((await finish(service, op.id)).status).toBe('succeeded')
    expect(provider.calls).toEqual(['provision', 'start', 'ready'])
    expect((await call(service, 'vm.create', { ...createParams, name: 'changed' })).error?.code).toBe(
      'IDEMPOTENCY_CONFLICT'
    )
    const current = (await call(service, 'vm.inspect', { vmId: op.vmId })).result as Vm
    expect(current.revision).toBeGreaterThan(0)
    expect(
      (
        await call(service, 'vm.start', {
          vmId: op.vmId,
          expectedRevision: 0,
          idempotencyKey: 'start',
        })
      ).error?.code
    ).toBe('REVISION_CONFLICT')
    const start = (
      await call(service, 'vm.start', {
        vmId: op.vmId,
        expectedRevision: current.revision,
        idempotencyKey: 'start',
      })
    ).result as Operation
    expect((await finish(service, start.id)).status).toBe('succeeded')
    await service.close()
    const reopened = new HostService(options)
    services.push(reopened)
    expect((await call(reopened, 'operation.get', { operationId: op.id })).result).toMatchObject({
      id: op.id,
      status: 'succeeded',
    })
    const events = (await call(reopened, 'events.list', { after: 0, limit: 500 })).result as { seq: number }[]
    expect(events.length).toBeGreaterThan(5)
    expect(new Set(events.map((x) => x.seq)).size).toBe(events.length)
  })
  it.skipIf(skipWindows)('atomically admits capacity across concurrent creates', async () => {
    const { service } = await setup({ cpus: 2, memoryMiB: 512, diskGiB: 2 })
    const results = await Promise.all([
      call(service, 'vm.create', createParams),
      call(service, 'vm.create', { ...createParams, idempotencyKey: 'other' }),
    ])
    expect(results.filter((x) => x.error?.code === 'CAPACITY_EXCEEDED')).toHaveLength(1)
    expect(results.filter((x) => x.result)).toHaveLength(1)
  })
  it.skipIf(skipWindows)('cancels queued creates and releases reservations', async () => {
    const { service, provider } = await setup()
    const op = (await call(service, 'vm.create', createParams)).result as Operation
    expect((await call(service, 'operation.cancel', { operationId: op.id })).result).toMatchObject({
      status: 'cancelled',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(provider.calls).toEqual([])
    expect((await call(service, 'vm.list')).result).toEqual([])
  })
  it.skipIf(skipWindows)('marks interrupted operations failed without replaying provider effects', async () => {
    const { service, provider, options } = await setup()
    const op = (await call(service, 'vm.create', createParams)).result as Operation
    await finish(service, op.id)
    await service.close()
    const db = new DatabaseSync(join(options.stateDirectory, 'host.sqlite'))
    db.prepare('UPDATE operations SET body=? WHERE id=?').run(
      JSON.stringify({ ...op, status: 'running' }),
      op.id
    )
    db.close()
    provider.states.set(op.vmId, 'unknown')
    const reopened = new HostService(options)
    services.push(reopened)
    const result = (await call(reopened, 'operation.get', { operationId: op.id })).result as Operation
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('INTERRUPTED')
    expect(provider.calls).toEqual(['provision', 'start', 'ready'])
  })
  it.skipIf(skipWindows)('allows only one service for a state directory', async () => {
    const { service, options } = await setup()
    await service.ready()
    const other = new HostService(options)
    services.push(other)
    await expect(other.ready()).rejects.toThrow('Another service')
  })
  it.skipIf(skipWindows)('fails closed for an unknown recovered identity', async () => {
    const { service, provider, options } = await setup()
    const op = (await call(service, 'vm.create', createParams)).result as Operation
    await finish(service, op.id)
    await service.close()
    provider.states.set(op.vmId, 'unknown')
    const reopened = new HostService(options)
    services.push(reopened)
    const current = (await call(reopened, 'vm.inspect', { vmId: op.vmId })).result as Vm
    expect(current.state).toBe('unknown')
    expect(
      (
        await call(reopened, 'vm.remove', {
          vmId: current.id,
          expectedRevision: current.revision,
          idempotencyKey: 'remove',
        })
      ).error?.code
    ).toBe('INVALID_STATE')
  })
})
describe('runtime isolation and provisioning', () => {
  it('emits structured disk arguments and no NIC', () => {
    const args = buildQemuArgs(vm, runtime, {
      directory: '/vm', disk: '/vm/disk', seed: '/vm/seed', qmp: '/vm/qmp',
      qga: '/vm/qga', firmwareVars: '/vm/vars', log: '/vm/log',
    })
    expect(args.slice(args.indexOf('-nic'), args.indexOf('-nic') + 2)).toEqual(['-nic', 'none'])
    expect(args).not.toContain('-netdev')
    expect(args).toContain('-nodefaults')
    expect(args).toContain(vm.identity)
    expect(JSON.parse(args[args.indexOf('-blockdev') + 1]).driver).toBe('file')
  })
  it('encodes the nine-character NoCloud filenames using VFAT long names', () => {
    const seed = noCloudSeed(vm.identity)
    const root = 65 * 512
    expect(seed[root + 32 + 11]).toBe(0x0f)
    const offsets = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]
    const name = offsets
      .map((offset) => seed.readUInt16LE(root + 32 + offset))
      .filter((code) => code !== 0 && code !== 65535)
      .map((code) => String.fromCharCode(code))
      .join('')
    expect(name).toBe('meta-data')
  })
  it('produces a FAT16 CIDATA disk containing cloud-init metadata', () => {
    const seed = noCloudSeed(vm.identity)
    expect(seed.length).toBe(4 * 1024 * 1024)
    expect(seed.toString('ascii', 43, 54)).toBe('CIDATA     ')
    expect(seed.readUInt16LE(510)).toBe(0xaa55)
    expect(seed.includes(Buffer.from(`instance-id: ${vm.identity}`))).toBe(true)
    expect(seed.includes(Buffer.from('qemu-guest-agent.service'))).toBe(true)
  })
  it('verifies checksum and refuses untrusted files', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'mh-hash-')))
    directories.push(dir)
    const path = join(dir, 'asset')
    await writeFile(path, 'hello')
    await expect(
      verifyAsset({
        path,
        sha256: createHash('sha256').update('hello').digest('hex'),
      })
    ).resolves.toBe(path)
    await expect(verifyAsset({ path, sha256: '0'.repeat(64) })).rejects.toThrow('checksum')
    await expect(
      stageAsset({
        url: 'http://example.invalid',
        destination: path,
        sha256: 'a'.repeat(64),
        maxBytes: 10,
      })
    ).rejects.toThrow('configuration')
  })
  it.skipIf(skipWindows)('stages downloads atomically and cleans failed checksum/oversize files', async () => {
    const dir = await directory()
    const path = join(dir, 'asset')

    const bytes = Buffer.from('verified')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    vi.stubGlobal('fetch', async () => new Response(bytes))
    await stageAsset({
      url: 'https://example.invalid/asset',
      allowedHosts: ['example.invalid'],
      destination: path,
      sha256,
      maxBytes: 100,
    })
    expect(await readFile(path, 'utf8')).toBe('verified')
    await expect(
      stageAsset({
        url: 'https://example.invalid/asset',
        allowedHosts: ['example.invalid'],
        destination: path,
        sha256: 'a'.repeat(64),
        maxBytes: 100,
      })
    ).rejects.toThrow('checksum')
    await expect(
      stageAsset({
        url: 'https://example.invalid/asset',
        allowedHosts: ['example.invalid'],
        destination: join(dir, 'oversize'),
        sha256,
        maxBytes: 1,
      })
    ).rejects.toThrow('size limit')
    expect(await readFile(path, 'utf8')).toBe('verified')
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(dir)).toEqual(['asset'])
  })
  it.skipIf(skipWindows)('refuses a monitor whose UUID belongs to another VM', async () => {
    const dir = await directory()
    const provider = new QemuProvider(dir)
    const p = provider.paths(vm)
    await mkdir(p.directory, { recursive: true, mode: 0o700 })
    await writeFile(join(p.directory, 'identity'), vm.identity)
    await writeFile(join(p.directory, 'launched'), '')
    const commands: string[] = []
    const server = createServer((socket) => {
      socket.write('{"QMP":{}}\n')
      let buffer = ''
      socket.on('data', (data) => {
        buffer += data.toString().replace(/\uFFFD/g, '')
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n')
          const request = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          commands.push(request.execute)
          socket.write(
            JSON.stringify({
              id: request.id,
              return: request.execute === 'query-uuid' ? { UUID: randomUUID() } : {},
            }) + '\n'
          )
        }
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(p.qmp, resolve))
    expect(await provider.inspect(vm)).toBe('unknown')
    await expect(provider.shutdown(vm, new AbortController().signal)).rejects.toThrow('uncertain')
    expect(commands).not.toContain('system_powerdown')
  })
  it.skipIf(skipWindows)('performs graceful QGA shutdown and clears only the verified launch marker', async () => {
    const dir = await directory()
    const provider = new QemuProvider(dir, 2000)
    const p = provider.paths(vm)
    await mkdir(p.directory, { recursive: true, mode: 0o700 })
    await writeFile(join(p.directory, 'identity'), vm.identity)
    await writeFile(
      join(p.directory, 'launched'),
      JSON.stringify({
        generation: randomUUID(),
        identity: vm.identity,
        bootSession: 'previous-boot',
      })
    )
    const sockets = new Set<import('node:net').Socket>()
    const commands: string[] = []
    function frames(socket: import('node:net').Socket, handler: (request: any) => void) {
      let buffer = ''
      socket.on('data', (data) => {
        buffer += data.toString().replace(/\uFFFD/g, '')
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n')
          const request = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          handler(request)
        }
      })
    }
    const qmp = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.write('{"QMP":{}}\n')
      frames(socket, (request) => {
        if (socket.writableEnded) return
        commands.push(request.execute)
        socket.write(
          JSON.stringify({
            id: request.id,
            return:
              request.execute === 'query-uuid'
                ? { UUID: vm.identity }
                : request.execute === 'query-status'
                  ? { running: true, status: 'running' }
                  : {},
          }) + '\n'
        )
      })
    })
    const qga = createServer((socket) =>
      frames(socket, (request) => {
        if (socket.writableEnded) return
        commands.push(request.execute)
        if (request.execute === 'guest-sync-delimited') {
          socket.write(Buffer.from([0xff]))
          socket.write(JSON.stringify({ id: request.id, return: request.arguments.id }) + '\n')
        } else if (request.execute === 'guest-shutdown') {
          for (const monitor of sockets) monitor.end()
          qmp.close()
          socket.end()
          qga.close()
        } else socket.write(JSON.stringify({ id: request.id, return: {} }) + '\n')
      })
    )
    servers.push(qmp, qga)
    await new Promise<void>((resolve) => qmp.listen(p.qmp, resolve))
    await new Promise<void>((resolve) => qga.listen(p.qga, resolve))
    await provider.shutdown(vm, new AbortController().signal)
    expect(await provider.inspect(vm)).toBe('stopped')
    expect(commands).toContain('guest-shutdown')
    expect(commands).not.toContain('system_powerdown')
    await expect(readFile(join(p.directory, 'launched'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.skipIf(skipWindows)('retains uncertain launch identities without killing processes', async () => {
    const dir = await directory()
    const provider = new QemuProvider(dir)
    const p = provider.paths(vm)
    await mkdir(p.directory, { recursive: true, mode: 0o700 })
    await writeFile(join(p.directory, 'identity'), vm.identity)
    await writeFile(join(p.directory, 'launched'), '')
    expect(await provider.inspect(vm)).toBe('unknown')
    await expect(provider.remove(vm, new AbortController().signal)).rejects.toThrow('proven stopped')
    expect(await readFile(join(p.directory, 'launched'), 'utf8')).toBe('')
  })
})
describe('bounded private JSON monitor', () => {
  async function monitor(handler: (socket: import('node:net').Socket) => void) {
    const dir = await directory()
    const path = join(dir, 'qmp')
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(path, resolve))
    return path
  }
  it.skipIf(skipWindows)('matches IDs, handles split frames and ignores events', async () => {
    const path = await monitor((socket) => {
      socket.write('{"QMP":')
      socket.write('{}}\n')
      let buffer = ''
      socket.on('data', (data) => {
        buffer += data.toString()
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n')
          const request = JSON.parse(buffer.slice(0, index))
          buffer = buffer.slice(index + 1)
          socket.write(JSON.stringify({ event: 'STOP' }) + '\n')
          socket.write(JSON.stringify({ id: request.id, return: request.execute }) + '\n')
        }
      })
    })
    const channel = await JsonChannel.open(path)
    try {
      expect(await channel.command('query-status')).toBe('query-status')
    } finally {
      channel.close()
    }
  })
  it.skipIf(skipWindows)('sends QGA shutdown without waiting for an absent reply', async () => {
    let received: any
    const path = await monitor((socket) =>
      socket.on('data', (data) => {
        received = JSON.parse(data.toString().replace(/\uFFFD/g, ''))
        if (received.execute === 'guest-sync-delimited') {
          socket.write(Buffer.from([0xff]))
          socket.write(JSON.stringify({ id: received.id, return: received.arguments.id }) + '\n')
        }
      })
    )
    const channel = await JsonChannel.open(path, false, 30)
    try {
      await channel.notify('guest-shutdown', { mode: 'powerdown' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(received.execute).toBe('guest-shutdown')
    } finally {
      channel.close()
    }
  })
  it.skipIf(skipWindows)('bounds incoming frames and command deadlines', async () => {
    const path = await monitor((socket) => {
      socket.write('{"QMP":{}}\n')
      socket.on('data', () => socket.write('x'.repeat(1025)))
    })
    await expect(JsonChannel.open(path, true, 100, 1024)).rejects.toThrow('frame exceeds')
    const silent = await monitor(() => {})
    await expect(JsonChannel.open(silent, true, 20)).rejects.toThrow('timed out')
  })
})

describe('critical acceptance regressions', () => {
  it.skipIf(skipWindows)('does not succeed create when QEMU runs but provisioning is not ready', async () => {
    const { service, provider } = await setup()
    provider.waitReady = async () => ({
      ready: false,
      markerMatches: false,
      networkIsolated: true,
      bootId: randomUUID(),
    })
    const operation = (await call(service, 'vm.create', createParams)).result as Operation
    expect((await finish(service, operation.id)).status).toBe('failed')
    expect((await call(service, 'vm.inspect', { vmId: operation.vmId })).result).toMatchObject({
      state: 'running',
      health: 'unresponsive',
      desiredState: 'running',
    })
  })
  it.skipIf(skipWindows)('retains disks by default and releases storage only after explicit successful purge', async () => {
    const { service, provider } = await setup()
    const created = (await call(service, 'vm.create', createParams)).result as Operation
    await finish(service, created.id)
    async function mutate(method: string, extra = {}) {
      const current = (await call(service, 'vm.inspect', { vmId: created.vmId })).result as Vm
      const response = await call(service, method, {
        vmId: current.id,
        expectedRevision: current.revision,
        idempotencyKey: randomUUID(),
        ...extra,
      })
      expect(response.error).toBeUndefined()
      return finish(service, (response.result as Operation).id)
    }
    expect((await mutate('vm.shutdown')).status).toBe('succeeded')
    expect((await mutate('vm.remove')).status).toBe('succeeded')
    expect(provider.calls).not.toContain('remove')
    expect((await call(service, 'host.inspect')).result).toMatchObject({
      allocated: { cpus: 0, memoryMiB: 0, diskGiB: 2 },
    })
    provider.remove = async () => {
      throw new Error('Deletion failed')
    }
    expect((await mutate('vm.remove', { deleteData: true })).status).toBe('failed')
    expect((await call(service, 'host.inspect')).result).toMatchObject({
      allocated: { diskGiB: 2 },
    })
    provider.remove = async (vm) => {
      provider.states.delete(vm.id)
    }
    expect((await mutate('vm.remove', { deleteData: true })).status).toBe('succeeded')
    expect((await call(service, 'host.inspect')).result).toMatchObject({
      allocated: { diskGiB: 0 },
    })
    expect((await mutate('vm.remove', { deleteData: true })).status).toBe('succeeded')
  })
  it.skipIf(skipWindows)('serializes verification with lifecycle mutations and verifies deterministic content', async () => {
    const { service, provider } = await setup()
    const created = (await call(service, 'vm.create', createParams)).result as Operation
    await finish(service, created.id)
    const current = (await call(service, 'vm.inspect', { vmId: created.vmId })).result as Vm
    let release!: () => void
    provider.verify = async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {
        ready: true,
        markerMatches: true,
        networkIsolated: true,
        bootId: randomUUID(),
      }
    }
    const pending = call(service, 'vm.verify', {
      vmId: current.id,
      mode: 'write-marker',
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(
      (
        await call(service, 'vm.verify', {
          vmId: current.id,
          mode: 'read-marker',
        })
      ).error?.code
    ).toBe('VM_BUSY')
    expect(
      (
        await call(service, 'vm.shutdown', {
          vmId: current.id,
          expectedRevision: current.revision,
          idempotencyKey: 'shutdown',
        })
      ).error?.code
    ).toBe('VM_BUSY')
    release()
    expect((await pending).result).toMatchObject({
      ready: true,
      markerMatches: true,
    })
  })
  it.skipIf(skipWindows)('persists host identity and rejects unsupported protocol versions explicitly', async () => {
    const { service, options } = await setup()
    const host = (await call(service, 'host.inspect')).result as any
    await service.close()
    const reopened = new HostService(options)
    services.push(reopened)
    expect((await call(reopened, 'host.inspect')).result).toMatchObject({
      id: host.id,
      protocolVersion: 1,
      serviceVersion: '0.2.0',
    })
    expect(
      (
        await reopened.dispatch({
          version: 2,
          id: 'r',
          method: 'host.inspect',
          params: {},
        })
      ).error?.code
    ).toBe('INCOMPATIBLE_VERSION')
  })
  it.skipIf(skipWindows)('rejects caps beyond physical resources and corrupt database bodies', async () => {
    const { service, options } = await setup()
    expect(
      () =>
        new HostService({
          ...options,
          capacity: { cpus: 999999, memoryMiB: 1, diskGiB: 1 },
        })
    ).toThrow('physical')
    const created = (await call(service, 'vm.create', createParams)).result as Operation
    await finish(service, created.id)
    await service.close()
    const db = new DatabaseSync(join(options.stateDirectory, 'host.sqlite'))
    db.prepare('UPDATE vms SET body=?').run('{"id":"broken"}')
    db.close()
    const reopened = new HostService(options)
    services.push(reopened)
    await expect(reopened.ready()).rejects.toThrow()
  })
  it.skipIf(skipWindows)('recovers a dead launch or reused PID while retaining a live same-process launch', async () => {
    const { bootSession, processStart, saveLaunch } = await import('../src/persistence/launch.js')
    const dir = await directory()
    const provider = new QemuProvider(dir)
    const p = provider.paths(vm)
    await mkdir(p.directory, { recursive: true, mode: 0o700 })
    await writeFile(join(p.directory, 'identity'), vm.identity)
    const launch = {
      generation: randomUUID(),
      identity: vm.identity,
      bootSession: await bootSession(),
      pid: process.pid,
      processStart: await processStart(process.pid),
    }
    await saveLaunch(p.directory, launch, true)
    expect(await provider.inspect(vm)).toBe('unknown')
    await saveLaunch(p.directory, {
      ...launch,
      processStart: 'previous-pid-incarnation',
    })
    expect(await provider.inspect(vm)).toBe('stopped')
    await expect(readFile(join(p.directory, 'launched'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.skipIf(skipWindows)('cleans known interrupted staging and preserves unknown artifacts', async () => {
    const dir = await directory()
    const provider = new QemuProvider(dir)
    const stage = provider.paths(vm).directory + '.staging'
    await mkdir(stage, { recursive: true, mode: 0o700 })
    await writeFile(join(stage, 'identity'), 'foreign')
    await writeFile(join(stage, 'disk.qcow2'), 'partial')
    expect(await provider.inspect(vm)).toBe('unknown')
    expect(await readFile(join(stage, 'disk.qcow2'), 'utf8')).toBe('partial')
    await writeFile(join(stage, 'identity'), vm.identity)
    expect(await provider.inspect(vm)).toBe('stopped')
    await expect(readFile(join(stage, 'disk.qcow2'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  it.skipIf(skipWindows)('does not let an old child exit callback remove a newer launch', async () => {
    const { saveLaunch, cleanLaunch } = await import('../src/persistence/launch.js')
    const dir = await directory()
    const old = {
      generation: randomUUID(),
      identity: vm.identity,
      bootSession: 'boot',
    }
    const latest = { ...old, generation: randomUUID() }
    await saveLaunch(dir, old, true)
    await saveLaunch(dir, latest)
    await cleanLaunch(dir, old)
    expect(JSON.parse(await readFile(join(dir, 'launched'), 'utf8')).generation).toBe(latest.generation)
  })
})

it.skipIf(skipWindows)('cleans the launch generation when its actual child exits after startup', async () => {
  const dir = await directory()
  const executable = join(dir, 'fake-qemu')
  await writeFile(
    executable,
    `#!${process.execPath}
const net = require('node:net');
const args = process.argv.slice(2);
const path = args[args.indexOf('-qmp') + 1].slice(5).split(',')[0];
const identity = args[args.indexOf('-uuid') + 1];
const sockets = new Set();
const server = net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.write('{"QMP":{}}\\n');
  let buffer = '';
  socket.on('data', data => {
    buffer += data;
    while (buffer.includes('\\n')) {
      const end = buffer.indexOf('\\n');
      const request = JSON.parse(buffer.slice(0,end));
      buffer = buffer.slice(end+1);
      socket.write(JSON.stringify({id:request.id,return:request.execute === 'query-uuid' ? {UUID:identity} : request.execute === 'query-status' ? {running:true,status:'running'} : {}})+'\\n');
      if (request.execute === 'quit') {
        for (const peer of sockets) peer.end();
        server.close();
      }
    }
  });
});
server.listen(path);
`,
    { mode: 0o700 }
  )
  const provider = new QemuProvider(dir, 3000)
  vi.spyOn(provider, 'inspectRuntime').mockResolvedValue({ available: true })
  const p = provider.paths(vm)
  await mkdir(p.directory, { recursive: true, mode: 0o700 })
  for (const [name, content] of [
    ['identity', vm.identity],
    ['disk.qcow2', 'disk'],
    ['seed.img', 'seed'],
  ])
    await writeFile(join(p.directory, name), content)
  await provider.start(
    vm,
    { ...runtime, qemu: { path: executable, sha256: 'a'.repeat(64) } },
    new AbortController().signal
  )
  expect(await provider.inspect(vm)).toBe('running')
  expect(JSON.parse(await readFile(join(p.directory, 'launched'), 'utf8'))).toMatchObject({
    identity: vm.identity,
    pid: expect.any(Number),
    processStart: expect.any(String),
  })
  const channel = await JsonChannel.open(p.qmp)
  await channel.command('quit')
  channel.close()
  for (let i = 0; i < 100 && (await provider.inspect(vm)) !== 'stopped'; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(await provider.inspect(vm)).toBe('stopped')
  await expect(readFile(join(p.directory, 'launched'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

it.skipIf(skipWindows)('restores only always-policy desired-running VMs after a proven stop', async () => {
  for (const startupPolicy of ['manual', 'always'] as const) {
    const { service, provider, options } = await setup()
    const created = (await call(service, 'vm.create', { ...createParams, startupPolicy })).result as Operation
    await finish(service, created.id)
    await service.close()
    provider.states.set(created.vmId, 'stopped')
    provider.calls.length = 0
    const reopened = new HostService(options)
    services.push(reopened)
    await reopened.ready()
    await reopened.close()
    expect(provider.calls).toEqual(startupPolicy === 'always' ? ['start', 'ready'] : [])
  }
})
it.skipIf(skipWindows)('refuses direct root provider construction and shared disk deletion', async () => {
  const uid = vi.spyOn(process, 'getuid').mockReturnValue(0)
  try {
    expect(() => new QemuProvider('/private/tmp/unused')).toThrow('nonroot')
  } finally {
    uid.mockRestore()
  }
  const dir = await directory()
  const provider = new QemuProvider(dir)
  const p = provider.paths(vm)
  await mkdir(p.directory, { recursive: true, mode: 0o700 })
  await writeFile(join(p.directory, 'identity'), vm.identity)
  await writeFile(p.disk, 'shared')
  const { link } = await import('node:fs/promises')
  await link(p.disk, join(dir, 'shared'))
  await expect(provider.remove(vm, new AbortController().signal)).rejects.toThrow('shared or external')
  expect(await readFile(p.disk, 'utf8')).toBe('shared')
})
it.skipIf(skipWindows)('preserves unowned directories and staging with missing ownership records', async () => {
  const dir = await directory()
  const provider = new QemuProvider(dir)
  const p = provider.paths(vm)
  await mkdir(p.directory + '.staging', { recursive: true, mode: 0o700 })
  await writeFile(join(p.directory + '.staging', 'disk.qcow2'), 'unknown')
  expect(await provider.inspect(vm)).toBe('unknown')
  await expect(provider.remove(vm, new AbortController().signal)).rejects.toThrow('proven stopped')
  expect(await readFile(join(p.directory + '.staging', 'disk.qcow2'), 'utf8')).toBe('unknown')
})

it.skipIf(skipWindows)('handles spawn failure before log close without leaving an uncertain launch', async () => {
  const dir = await directory()
  const provider = new QemuProvider(dir, 200)
  vi.spyOn(provider, 'inspectRuntime').mockResolvedValue({ available: true })
  const p = provider.paths(vm)
  await mkdir(p.directory, { recursive: true, mode: 0o700 })
  for (const [name, content] of [
    ['identity', vm.identity],
    ['disk.qcow2', 'disk'],
    ['seed.img', 'seed'],
  ])
    await writeFile(join(p.directory, name), content)
  await expect(provider.start(vm, runtime, new AbortController().signal)).rejects.toThrow('ENOENT')
  expect(await provider.inspect(vm)).toBe('stopped')
})

it.skipIf(skipWindows)('looks up persisted operations by key and enumerates retained disks for another client', async () => {
  const { service, provider, options } = await setup()
  expect((await call(service, 'operation.lookup', { idempotencyKey: 'create' })).result).toBeNull()
  const op = (await call(service, 'vm.create', createParams)).result as Operation
  expect((await call(service, 'operation.lookup', { idempotencyKey: 'create' })).result).toMatchObject({ id: op.id })
  await finish(service, op.id)
  let current = (await call(service, 'vm.inspect', { vmId: op.vmId })).result as Vm
  const shutdown = (
    await call(service, 'vm.shutdown', { vmId: op.vmId, expectedRevision: current.revision, idempotencyKey: 'stop' })
  ).result as Operation
  expect((await finish(service, shutdown.id)).status).toBe('succeeded')
  current = (await call(service, 'vm.inspect', { vmId: op.vmId })).result as Vm
  const removal = (
    await call(service, 'vm.remove', {
      vmId: op.vmId,
      expectedRevision: current.revision,
      idempotencyKey: 'retain',
      deleteData: false,
    })
  ).result as Operation
  expect((await finish(service, removal.id)).status).toBe('succeeded')
  expect((await call(service, 'vm.list')).result).toEqual([])
  const calls = [...provider.calls]
  await service.close()
  const reopened = new HostService(options)
  services.push(reopened)
  expect((await call(reopened, 'operation.lookup', { idempotencyKey: 'retain' })).result).toMatchObject({
    id: removal.id,
    status: 'succeeded',
  })
  expect((await call(reopened, 'operation.lookup', { idempotencyKey: 'missing' })).result).toBeNull()
  const retained = (await call(reopened, 'vm.list', { includeRetained: true })).result as Vm[]
  expect(retained).toMatchObject([{ id: op.vmId, state: 'removed', diskRetained: true }])
  expect(provider.calls).toEqual(calls)
  const purge = (
    await call(reopened, 'vm.remove', {
      vmId: op.vmId,
      expectedRevision: retained[0].revision,
      idempotencyKey: 'purge',
      deleteData: true,
    })
  ).result as Operation
  expect((await finish(reopened, purge.id)).status).toBe('succeeded')
  expect((await call(reopened, 'vm.list', { includeRetained: true })).result).toEqual([])
})
