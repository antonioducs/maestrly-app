import { connect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { DesktopViewServer, VIEW_HEADER, VIEW_PROTOCOL, type WebSocketChannel } from '../src/main/desktop-view-server'

const servers: DesktopViewServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})
async function start(alive = () => true) {
  const server = new DesktopViewServer({ origins: () => ['file://'], alive })
  await server.start()
  servers.push(server)
  return server
}
function upgrade(server: DesktopViewServer, headers: Record<string, string>, path = '/desktop') {
  return new Promise<{ status: number; socket: Socket; head: string }>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: server.port })
    let text = ''
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1')
      if (text.includes('\r\n\r\n')) {
        socket.removeAllListeners('data')
        resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]), socket, head: text })
      }
    })
    socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
  })
}
function headersFor(server: DesktopViewServer, protocols: string[], webContentsId = 7, extra: Record<string, string> = {}) {
  return {
    Host: `127.0.0.1:${server.port}`,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    Origin: 'file://',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    'Sec-WebSocket-Protocol': protocols.join(', '),
    [VIEW_HEADER]: server.binding(webContentsId),
    ...extra,
  }
}
function frame(payload: Buffer, opcode = 2, masked = true) {
  const mask = randomBytes(4)
  const header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | payload.length])
  const body = Buffer.from(payload)
  if (masked) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3]
  return Buffer.concat([header, ...(masked ? [mask] : []), body])
}
const closed = (socket: Socket) => new Promise<void>((resolve) => (socket.destroyed ? resolve() : socket.once('close', () => resolve())))

it('binds only to loopback and upgrades with a single-use ticket carried in the subprotocol', async () => {
  const channels: WebSocketChannel[] = []
  const server = await start()
  expect(server.port).toBeGreaterThan(0)
  const { protocols, url } = server.issue(7, (channel) => channels.push(channel))
  expect(url).toBe(`ws://127.0.0.1:${server.port}/desktop`)
  expect(url).not.toContain(protocols[1].slice(4))
  const accepted = await upgrade(server, headersFor(server, protocols))
  expect(accepted.status).toBe(101)
  expect(accepted.head).toContain(`Sec-WebSocket-Protocol: ${VIEW_PROTOCOL}`)
  expect(channels).toHaveLength(1)
  const received = new Promise<Buffer>((resolve) => channels[0].once('data', resolve))
  accepted.socket.write(frame(Buffer.from('RFB 003.008\n')))
  expect((await received).toString()).toBe('RFB 003.008\n')
  const back = new Promise<Buffer>((resolve) => accepted.socket.once('data', resolve))
  channels[0].write(Buffer.from('framebuffer'))
  const bytes = await back
  expect(bytes[0]).toBe(0x82)
  expect(bytes.subarray(2).toString()).toBe('framebuffer')
  expect((await upgrade(server, headersFor(server, protocols))).status).toBe(403)
  accepted.socket.destroy()
})
it.each([
  ['a foreign origin', (s: DesktopViewServer, p: string[]) => headersFor(s, p, 7, { Origin: 'https://evil.example' })],
  ['a missing binding header', (s: DesktopViewServer, p: string[]) => { const h = headersFor(s, p); delete (h as Record<string, string>)[VIEW_HEADER]; return h }],
  ['another window binding', (s: DesktopViewServer, p: string[]) => headersFor(s, p, 8)],
  ['a different Host header', (s: DesktopViewServer, p: string[]) => headersFor(s, p, 7, { Host: `localhost:${s.port}` })],
  ['no ticket', (s: DesktopViewServer) => headersFor(s, [VIEW_PROTOCOL])],
])('refuses %s and burns the ticket', async (_name, build) => {
  const server = await start()
  let connected = 0
  const { protocols } = server.issue(7, () => connected++)
  expect((await upgrade(server, build(server, protocols))).status).toBe(403)
  if (_name !== 'no ticket') expect((await upgrade(server, headersFor(server, protocols))).status).toBe(403)
  expect(connected).toBe(0)
})
it('refuses tickets in the URL and renderers that are gone', async () => {
  const server = await start(() => false)
  const { protocols } = server.issue(7, () => {})
  const ticket = protocols[1].slice(4)
  expect((await upgrade(server, headersFor(server, [VIEW_PROTOCOL]), `/desktop?ticket=${ticket}`)).status).toBe(403)
  const again = server.issue(7, () => {})
  expect((await upgrade(server, headersFor(server, again.protocols))).status).toBe(403)
})
it.each([
  ['unmasked frames', frame(Buffer.from('x'), 2, false)],
  ['text frames', frame(Buffer.from('x'), 1)],
  ['oversized messages', Buffer.concat([Buffer.from([0x82, 0xff]), Buffer.from([0, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff]), randomBytes(4)])],
])('closes the socket on %s', async (_name, bytes) => {
  const server = await start()
  const { protocols } = server.issue(7, () => {})
  const { socket } = await upgrade(server, headersFor(server, protocols))
  socket.write(bytes)
  await closed(socket)
  expect(socket.destroyed).toBe(true)
})
it('revoking a renderer closes its sockets and forgets its pending tickets', async () => {
  const server = await start()
  const first = server.issue(7, () => {})
  const pending = server.issue(7, () => {})
  const { socket } = await upgrade(server, headersFor(server, first.protocols))
  server.revoke(7)
  await closed(socket)
  expect((await upgrade(server, headersFor(server, pending.protocols))).status).toBe(403)
})
