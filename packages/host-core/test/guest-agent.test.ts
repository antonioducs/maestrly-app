// Socket integration cases require Unix-domain sockets; in-memory contracts remain portable.
const skipWindows = process.platform === 'win32'
import { afterEach, expect, it } from 'vitest'
import { createServer, type Socket, type Server } from 'node:net'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonChannel } from '../src/providers/qemu/qmp.js'
import { verifyGuest } from '../src/providers/qemu/guest-agent.js'
import { vmSchema } from '@maestrly/host-protocol'
const directories: string[] = []
const servers: Server[] = []
const connections = new Set<Socket>()
afterEach(async () => {
  for (const socket of connections) socket.destroy()
  connections.clear()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function guest(handler: (request: any, socket: Socket) => void, stale = true) {
  const dir = await realpath(await mkdtemp('/tmp/mh-ga-'))
  directories.push(dir)
  const path = join(dir, 'qga')
  const server = createServer((socket) => {
    connections.add(socket)
    if (stale) socket.write('garbage partial stale {"ret')
    let buffer = Buffer.alloc(0)
    let sentinel = false
    socket.on('data', (data) => {
      if (data.includes(0xff)) {
        sentinel = true
        data = data.subarray(data.indexOf(0xff) + 1)
      }
      buffer = Buffer.concat([buffer, data])
      while (buffer.includes(10)) {
        const newline = buffer.indexOf(10)
        const request = JSON.parse(buffer.subarray(0, newline).toString())
        buffer = buffer.subarray(newline + 1)
        if (request.execute === 'guest-sync-delimited') {
          expect(sentinel).toBe(true)
          socket.write(Buffer.from([0xff]))
          socket.write(JSON.stringify({ id: request.id, return: request.arguments.id }) + '\n')
        } else handler(request, socket)
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return path
}
it.skipIf(skipWindows)('synchronizes stale partial data with the actual sentinel on every reconnect', async () => {
  const path = await guest((request, socket) =>
    socket.write(JSON.stringify({ id: request.id, return: {} }) + '\n')
  )
  for (let i = 0; i < 3; i++) {
    const channel = await JsonChannel.open(path, false, 100)
    await expect(channel.command('guest-ping')).resolves.toEqual({})
    channel.close()
  }
})
it.skipIf(skipWindows)('invalidates the entire channel after a command timeout', async () => {
  const path = await guest(() => {})
  const channel = await JsonChannel.open(path, false, 30)
  await expect(channel.command('guest-ping')).rejects.toThrow('timed out')
  await expect(channel.command('guest-ping')).rejects.toThrow('timed out')
})
it.skipIf(skipWindows)('requires the synchronization response token rather than arbitrary valid JSON', async () => {
  const dir = await realpath(await mkdtemp('/tmp/mh-ga-'))
  directories.push(dir)
  const path = join(dir, 'qga')
  const server = createServer((socket) => {
    connections.add(socket)
    let buffer = ''
    socket.on('data', (data) => {
      buffer += data.toString().replace(/\uFFFD/g, '')
      if (!buffer.includes('\n')) return
      const request = JSON.parse(buffer)
      socket.write(Buffer.from([0xff]))
      socket.write(JSON.stringify({ id: request.id, return: -1 }) + '\n')
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(path, resolve))
  await expect(JsonChannel.open(path, false, 100)).rejects.toThrow('token mismatch')
})
it.skipIf(skipWindows)('uses only fixed paths and fixed sync for persistent deterministic markers', async () => {
  const vm = vmSchema.parse({
    id: 'v',
    identity: '11111111-1111-4111-8111-111111111111',
    name: 'v',
    imageId: 'i',
    runtimeId: 'r',
    cpus: 1,
    memoryMiB: 512,
    diskGiB: 1,
    state: 'running',
    revision: 0,
    createdAt: 'now',
    updatedAt: 'now',
  })
  const files = new Map([
    ['/var/lib/maestrly/provisioned', vm.identity],
    ['/proc/sys/kernel/random/boot_id', '22222222-2222-4222-8222-222222222222'],
  ])
  let opened = ''
  const commands: any[] = []
  const path = await guest((request, socket) => {
    commands.push(request)
    const args = request.arguments
    let result: any = {}
    switch (request.execute) {
      case 'guest-file-open':
        opened = args.path
        result = 1
        break
      case 'guest-file-read': {
        const data = Buffer.from(files.get(opened) ?? '')
        result = {
          count: data.length,
          'buf-b64': data.toString('base64'),
          eof: true,
        }
        break
      }
      case 'guest-file-write': {
        const data = Buffer.from(args['buf-b64'], 'base64')
        files.set(opened, data.toString())
        result = { count: data.length }
        break
      }
      case 'guest-network-get-interfaces':
        result = [{ name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1' }] }]
        break
      case 'guest-exec':
        result = { pid: 100 }
        break
      case 'guest-exec-status':
        result = { exited: true, exitcode: 0 }
        break
    }
    socket.write(JSON.stringify({ id: request.id, return: result }) + '\n')
  })
  for (const mode of ['write-marker', 'read-marker', 'write-marker'] as const) {
    const channel = await JsonChannel.open(path, false, 100)
    try {
      expect(await verifyGuest(channel, vm, mode, new AbortController().signal)).toEqual({
        ready: true,
        networkIsolated: true,
        markerMatches: true,
        bootId: '22222222-2222-4222-8222-222222222222',
      })
    } finally {
      channel.close()
    }
  }
  expect(files.get('/var/lib/maestrly/lab-marker')).toBe(vm.identity)
  expect(commands.filter((x) => x.execute === 'guest-exec').map((x) => x.arguments)).toEqual([
    { path: '/usr/bin/sync', 'capture-output': false },
    { path: '/usr/bin/sync', 'capture-output': false },
  ])
  expect(
    [...new Set(commands.filter((x) => x.execute === 'guest-file-open').map((x) => x.arguments.path))].sort()
  ).toEqual([
    '/proc/sys/kernel/random/boot_id',
    '/var/lib/maestrly/lab-marker',
    '/var/lib/maestrly/provisioned',
  ])
})
it.each([
  { provisioned: 'foreign', interfaces: [{ name: 'lo' }] },
  {
    provisioned: '11111111-1111-4111-8111-111111111111',
    interfaces: [{ name: 'lo' }, { name: 'eth0' }],
  },
])('rejects marker writes for unready or networked guests: %j', async ({ provisioned, interfaces }) => {
  const vm = vmSchema.parse({
    id: 'v',
    identity: '11111111-1111-4111-8111-111111111111',
    name: 'v',
    imageId: 'i',
    runtimeId: 'r',
    cpus: 1,
    memoryMiB: 512,
    diskGiB: 1,
    state: 'running',
    revision: 0,
    createdAt: 'now',
    updatedAt: 'now',
  })
  let opened = ''
  const writes: string[] = []
  const channel = {
    async command(execute: string, args: any) {
      if (execute === 'guest-file-open') {
        opened = args.path
        if (args.mode === 'w') writes.push(opened)
        return 1
      }
      if (execute === 'guest-file-read') {
        const data = Buffer.from(
          opened.endsWith('provisioned') ? provisioned : '22222222-2222-4222-8222-222222222222'
        )
        return { count: data.length, 'buf-b64': data.toString('base64') }
      }
      if (execute === 'guest-network-get-interfaces') return interfaces
      return {}
    },
  } as unknown as JsonChannel
  await expect(verifyGuest(channel, vm, 'write-marker', new AbortController().signal)).rejects.toThrow(
    'not safely ready'
  )
  expect(writes).toEqual([])
})
