import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GUEST_PROTOCOL } from '@maestrly/host-protocol'
import { SocketGuestSession } from '../src/guest/session.js'
import { botChannelArgs, botChannelPaths } from '../src/guest/profile.js'
import { buildQemuArgs } from '../src/qemu.js'
import { runtime } from './bot-helpers.js'
const skipWindows = process.platform === 'win32'
const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function guestSocket(onConnection: (socket: Socket) => void) {
  const dir = await mkdtemp('/tmp/mbs-')
  dirs.push(dir)
  const path = join(dir, 'c.sock')
  const server = createServer((socket) => {
    socket.on('error', () => {})
    onConnection(socket)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return path
}
const hello = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'hello', protocol: GUEST_PROTOCOL, runtimeVersion: '0.1.0', bootId: randomUUID(), generation: 3, nonce: 'n'.repeat(32), capabilities: ['provider.codex'], ...extra }) + '\n'
describe.skipIf(skipWindows)('guest control session', () => {
  it('handshakes with hello/welcome echoing the nonce, correlates responses and acks events only after the listener persists', async () => {
    const received: string[] = []
    const path = await guestSocket((socket) => {
      socket.write(hello())
      socket.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const frame = JSON.parse(line)
          received.push(frame.type)
          if (frame.type === 'welcome') {
            expect(frame.nonce).toBe('n'.repeat(32))
            expect(frame.hostGeneration).toBe(7)
            socket.write(JSON.stringify({ type: 'event', runtimeEventId: 'e1', kind: 'diagnostic', summary: 'hi', createdAt: new Date().toISOString() }) + '\n')
          }
          if (frame.type === 'request') socket.write(JSON.stringify({ type: 'response', id: frame.id, result: { state: 'ready', echo: frame.method } }) + '\n')
        }
      })
    })
    const session = await SocketGuestSession.open('vm', path, 7, 2000)
    expect(session.bootId).toMatch(/[0-9a-f-]{36}/)
    expect(session.generation).toBe(3)
    let ackFn: (() => void) | undefined
    session.onEvent((event, ack) => {
      expect(event.runtimeEventId).toBe('e1')
      ackFn = ack
    })
    expect(await session.request('runtime.inspect', {})).toMatchObject({ echo: 'runtime.inspect' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received).not.toContain('ack')
    ackFn?.()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received).toContain('ack')
    session.close()
  })
  it('rejects a protocol mismatch, frames before hello, oversized frames and foreign fields', async () => {
    const bad = await guestSocket((socket) => socket.write(hello({ protocol: 'bot.runtime.v2' })))
    await expect(SocketGuestSession.open('vm', bad, 1, 500)).rejects.toThrow(/protocol mismatch|Invalid guest control frame/)
    const early = await guestSocket((socket) => socket.write(JSON.stringify({ type: 'response', id: 'x', result: 1 }) + '\n'))
    await expect(SocketGuestSession.open('vm', early, 1, 500)).rejects.toThrow(/before hello|Invalid guest control frame|closed/)
    const foreign = await guestSocket((socket) => socket.write(hello({ vmId: 'other' })))
    await expect(SocketGuestSession.open('vm', foreign, 1, 500)).rejects.toThrow(/Invalid guest control frame|closed/)
    const huge = await guestSocket((socket) => socket.write('x'.repeat(300 * 1024)))
    await expect(SocketGuestSession.open('vm', huge, 1, 500)).rejects.toThrow(/exceeds limit|closed/)
    const silent = await guestSocket(() => {})
    await expect(SocketGuestSession.open('vm', silent, 1, 200)).rejects.toThrow(/did not answer/)
  })
  it('reports unknown outcome on request timeout and rejects pending requests when the channel drops', async () => {
    const path = await guestSocket((socket) => {
      socket.write(hello())
      socket.on('data', (chunk) => {
        if (chunk.toString().includes('"turn.cancel"')) socket.destroy()
      })
    })
    const session = await SocketGuestSession.open('vm', path, 1, 500)
    let closed: Error | undefined
    session.onClose((error) => {
      closed = error
    })
    await expect(session.request('runtime.inspect', {}, 100)).rejects.toMatchObject({ code: 'RUNTIME_TIMEOUT' })
    expect(session.alive).toBe(false)
    expect(closed).toMatchObject({ code: 'RUNTIME_TIMEOUT' })
    await expect(session.request('turn.cancel', { turnId: 't', generation: 1 }, 1000)).rejects.toThrow()
    expect(session.alive).toBe(false)
    expect(closed).toBeDefined()
  })
  it('invalidates the old session when the guest restarts on the same socket', async () => {
    let guest!: Socket
    const path = await guestSocket(socket => { guest = socket; socket.write(hello()) })
    const session = await SocketGuestSession.open('vm', path, 1, 500)
    const closed = new Promise<Error>(resolve => session.onClose(resolve))
    guest.write(hello({ generation: 4 }))
    await expect(closed).resolves.toMatchObject({ code: 'RUNTIME_RESTARTED' })
    expect(session.alive).toBe(false)
    await expect(session.request('runtime.inspect', {})).rejects.toMatchObject({ code: 'RUNTIME_UNREACHABLE' })
    guest.destroy()
  })
})
describe('bot launch profile', () => {
  it('adds only the two private virtio ports and keeps -nic none', () => {
    const vm: any = { id: '11111111-1111-4111-8111-111111111111', identity: randomUUID(), cpus: 2, memoryMiB: 2048, diskGiB: 12 }
    const paths = { directory: '/vm', disk: '/vm/disk', seed: '/vm/seed', qmp: '/vm/qmp', qga: '/vm/qga', firmwareVars: '/vm/vars', log: '/vm/log' }
    const plain = buildQemuArgs(vm, runtime, paths)
    const channels = botChannelPaths('/vm')
    const bot = buildQemuArgs(vm, runtime, paths, { botChannels: channels })
    expect(bot.slice(0, plain.length)).toEqual(plain)
    expect(bot.slice(plain.length)).toEqual(botChannelArgs(channels))
    expect(bot.filter((a) => a === '-nic')).toHaveLength(1)
    expect(bot[bot.indexOf('-nic') + 1]).toBe('none')
    expect(bot.join(' ')).toContain('name=org.maestrly.bot.control.0')
    expect(bot.join(' ')).toContain('name=org.maestrly.bot.egress.0')
    expect(bot).not.toContain('-netdev')
    expect(() => botChannelPaths('/'.padEnd(120, 'x'))).toThrow()
  })
})
