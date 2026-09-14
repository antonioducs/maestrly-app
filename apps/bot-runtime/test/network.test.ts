import { createServer, connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, expect, test } from 'vitest'
import { EgressTransport, STREAM_WINDOW } from '../src/network/serial-transport.js'
import { LocalProxy } from '../src/network/proxy.js'
import { FrameDecoder } from '../src/control/framing.js'
import { temporary } from './helpers.js'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(ack = true) {
  const sockets = new Set<Socket>()
  let outstanding = 0
  let maximum = 0
  let bytes = 0
  let acknowledged = 0
  const path = join(await temporary(), 'egress.sock')
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    const decoder = new FrameDecoder(80 * 1024)
    const send = (frame: unknown) => socket.write(JSON.stringify(frame) + '\n')
    send({ t: 'policy', revision: 4, mode: 'allowlist' })
    socket.on('data', (chunk: Buffer) => {
      for (const raw of decoder.push(chunk)) {
        const frame = raw as { t: string; s: number; d: string; n: number }
        if (frame.t === 'ack') acknowledged += frame.n
        if (frame.t === 'open') send({ t: 'opened', s: frame.s })
        if (frame.t === 'data') {
          const n = Buffer.from(frame.d, 'base64').length
          bytes += n
          outstanding += n
          maximum = Math.max(maximum, outstanding)
          if (ack) {
            send({ t: 'data', s: frame.s, d: frame.d })
            setTimeout(() => {
              outstanding -= n
              send({ t: 'ack', s: frame.s, n })
            }, 5)
          }
        }
        if (frame.t === 'end') send({ t: 'end', s: frame.s })
      }
    })
  })
  server.listen(path)
  await once(server, 'listening')
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const transport = new EgressTransport(path)
  await transport.start()
  cleanup.push(() => transport.close())
  const proxy = new LocalProxy(transport, 0)
  proxy.updatePolicy({ mode: 'allowlist', domains: ['example.com'], revision: 4 })
  await proxy.start()
  cleanup.push(() => proxy.close())
  const address = proxy.address as { port: number }
  async function request(host: string) {
    const socket = connect(address.port, '127.0.0.1')
    socket.on('error', () => {})
    cleanup.push(() => {
      socket.destroy()
    })
    await once(socket, 'connect')
    socket.write('CONNECT ' + host + ' HTTP/1.1\r\nHost: ' + host + '\r\n\r\n')
    const [reply] = await once(socket, 'data')
    return { socket, reply: String(reply) }
  }
  return { transport, proxy, sockets, request, stats: () => ({ bytes, maximum, acknowledged }) }
}
test('CONNECT tunnels bytes and policy frames update revision', async () => {
  const f = await fixture()
  const { socket, reply } = await f.request('example.com:443')
  expect(reply).toContain('200 Connection Established')
  socket.write('hello')
  expect(String((await once(socket, 'data'))[0])).toBe('hello')
  expect(f.transport.hostPolicyRevision).toBe(4)
})
test.each([
  ['denied.example:443', 'DOMAIN_DENIED'],
  ['1.2.3.4:443', 'INVALID_HOST'],
  ['127.0.0.1:80', 'LOCAL_ONLY'],
  ['localhost:80', 'LOCAL_ONLY'],
  ['[::1]:80', 'LOCAL_ONLY'],
])('refuses %s locally', async (host, code) => {
  const f = await fixture()
  const { reply } = await f.request(host)
  expect(reply).toContain('403 Forbidden')
  expect(reply).toContain(code)
})
test('offline refuses immediately', async () => {
  const f = await fixture()
  f.proxy.updatePolicy({ mode: 'offline', domains: [], revision: 5 })
  expect((await f.request('example.com:443')).reply).toContain('OFFLINE')
})
test('channel loss destroys tunnels and fails closed', async () => {
  const f = await fixture()
  const { socket } = await f.request('example.com:443')
  const closed = once(socket, 'close')
  for (const channel of f.sockets) channel.destroy()
  await closed
  expect((await f.request('example.com:443')).reply).toContain('EGRESS_UNAVAILABLE')
})
test('17th concurrent tunnel is refused', async () => {
  const f = await fixture()
  for (let i = 0; i < 16; i++) expect((await f.request('example.com:443')).reply).toContain('200')
  expect((await f.request('example.com:443')).reply).toContain('LIMIT')
})
test('2 MiB writes respect the 512 KiB acknowledgement window', async () => {
  const f = await fixture()
  const stream = await f.transport.open('example.com', 443)
  stream.resume()
  await new Promise<void>((resolve, reject) =>
    stream.write(Buffer.alloc(2 * 1024 * 1024), (error) => (error ? reject(error) : resolve()))
  )
  // The write callback means queued frames; the final ack confirms the broker received them.
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (f.stats().bytes === 2 * 1024 * 1024) {
        clearInterval(timer)
        resolve()
      }
    }, 5)
  })
  expect(f.stats().maximum).toBeLessThanOrEqual(STREAM_WINDOW)
})
test('a withheld ack blocks writes at the window', async () => {
  const f = await fixture(false)
  const stream = await f.transport.open('example.com', 443)
  let completed = false
  stream.write(Buffer.alloc(2 * 1024 * 1024), () => {
    completed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(f.stats().bytes).toBe(STREAM_WINDOW)
  expect(completed).toBe(false)
})

test('incoming bytes are acknowledged only after the consumer reads them', async () => {
  const f = await fixture()
  const stream = await f.transport.open('example.com', 443)
  stream.write(Buffer.alloc(1024))
  await expect.poll(() => stream.readableLength).toBe(1024)
  expect(f.stats().acknowledged).toBe(0)
  expect(stream.read(512).length).toBe(512)
  await expect.poll(() => f.stats().acknowledged).toBe(512)
  expect(stream.read(512).length).toBe(512)
  await expect.poll(() => f.stats().acknowledged).toBe(1024)
})

test('plain HTTP forwards origin-form request bytes and body', async () => {
  const f = await fixture()
  const address = f.proxy.address as { port: number }
  const socket = connect(address.port, '127.0.0.1')
  cleanup.push(() => {
    socket.destroy()
  })
  await once(socket, 'connect')
  const chunks: Buffer[] = []
  socket.on('data', (bytes) => chunks.push(bytes))
  socket.write('POST http://example.com/report?q=1 HTTP/1.1\r\nHost: example.com\r\nContent-Length: 4\r\n\r\ndata')
  await expect.poll(() => Buffer.concat(chunks).toString()).toContain('data')
  const request = Buffer.concat(chunks).toString()
  expect(request).toContain('POST /report?q=1 HTTP/1.1\r\n')
  expect(request).toContain('Connection: close\r\n')
  expect(request).not.toContain('http://example.com')
})

test('offline CONNECT peer reset is handled before any tunnel is registered', async () => {
  const f = await fixture()
  f.proxy.updatePolicy({ mode: 'offline', domains: [], revision: 5 })
  const { socket, reply } = await f.request('example.com:443')
  expect(reply).toContain('403 Forbidden')
  socket.resetAndDestroy()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const next = await f.request('example.com:443')
  expect(next.reply).toContain('403 Forbidden')
})

test('public internet blocks site trees and terminates a newly blocked live tunnel', async () => {
  const f = await fixture()
  f.proxy.updatePolicy({ mode: 'blocklist', domains: [], revision: 5 })
  const { socket, reply } = await f.request('www.example.com:443')
  expect(reply).toContain('200 Connection Established')
  const closed = once(socket, 'close')
  f.proxy.updatePolicy({ mode: 'blocklist', domains: ['example.com'], revision: 6 })
  await closed
  expect((await f.request('a.example.com:443')).reply).toContain('DOMAIN_DENIED')
  expect((await f.request('other.test:443')).reply).toContain('200 Connection Established')
  expect((await f.request('127.0.0.1:443')).reply).toContain('LOCAL_ONLY')
})
