import { describe, expect, it } from 'vitest'
import { createServer, connect, type Socket, type AddressInfo } from 'node:net'
import { decide, isForbiddenAddress, normalizeAddress } from '../src/egress/policy.js'
import { pinnedConnect } from '../src/egress/resolver.js'
import { EgressBroker } from '../src/egress/broker.js'
import { LineDecoder } from '../src/egress/streams.js'
const policy = { mode: 'allowlist' as const, domains: ['api.openai.com', 'example.com'], revision: 1 }
describe('egress policy', () => {
  it('allows only exact allowlisted hostnames on 80/443 and never literal IPs', () => {
    expect(decide(policy, 'API.OpenAI.com', 443)).toEqual({ host: 'api.openai.com', port: 443 })
    expect(decide(policy, 'api.openai.com', 8443)).toMatchObject({ code: 'PORT_DENIED' })
    expect(decide(policy, 'evil.com', 443)).toMatchObject({ code: 'DOMAIN_DENIED' })
    expect(decide(policy, 'sub.example.com', 443)).toMatchObject({ code: 'DOMAIN_DENIED' })
    for (const literal of ['1.1.1.1', '[::1]', '2130706433', '0x7f000001', '127.0.0.1'])
      expect(decide(policy, literal, 443)).toMatchObject({ code: 'LITERAL_IP' })
    expect(decide({ ...policy, mode: 'offline' }, 'example.com', 443)).toMatchObject({ code: 'OFFLINE' })
  })
  it('normalizes IPv6 alternatives and forbids private, loopback, link-local, metadata, multicast and host addresses', () => {
    expect(normalizeAddress('::ffff:10.0.0.1')).toMatchObject({ family: 4, canonical: '10.0.0.1' })
    expect(normalizeAddress('::ffff:a00:1')).toMatchObject({ family: 4, canonical: '10.0.0.1' })
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '224.0.0.1', '0.0.0.0', '100.64.1.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1', '64:ff9b::a00:1', '2002:c0a8:1::1'])
      expect(isForbiddenAddress(address, []), address).toBe(true)
    for (const address of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])
      expect(isForbiddenAddress(address, []), address).toBe(false)
    expect(isForbiddenAddress('93.184.216.34', ['93.184.216.34'])).toBe(true)
  })
})
function listen(handler: (socket: Socket) => void) {
  return new Promise<{ port: number; close: () => void }>((resolve) => {
    const server = createServer((socket) => {
      socket.on('error', () => {})
      handler(socket)
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }))
  })
}
const dialLoopback = (port: number) => (address: string, _port: number, signal: AbortSignal) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.on('error', () => {})
    signal.addEventListener('abort', () => reject(new Error('aborted')))
    socket.once('error', reject)
    socket.once('connect', () => {
      // Tests pretend the loopback listener is the resolved public peer address.
      Object.defineProperty(socket, 'remoteAddress', { value: address })
      resolve(socket)
    })
  })
describe('pinned connect', () => {
  it('refuses rebinding to private addresses and peer mismatches, and connects to the pinned public address', async () => {
    const server = await listen((socket) => socket.end('hello'))
    try {
      await expect(pinnedConnect('example.com', 443, async () => [{ address: '10.0.0.5', family: 4 }], dialLoopback(server.port), [])).rejects.toThrow(/ADDRESS_FORBIDDEN/)
      await expect(pinnedConnect('example.com', 443, async () => [{ address: '::ffff:127.0.0.1', family: 6 }], dialLoopback(server.port), [])).rejects.toThrow(/ADDRESS_FORBIDDEN/)
      await expect(pinnedConnect('example.com', 443, async () => { throw new Error('nx') }, dialLoopback(server.port), [])).rejects.toThrow(/DNS_FAILED/)
      const mismatch = (_address: string, port: number, signal: AbortSignal) => dialLoopback(server.port)('93.184.216.35', port, signal)
      await expect(pinnedConnect('example.com', 443, async () => [{ address: '93.184.216.34', family: 4 }], mismatch, [])).rejects.toThrow(/PEER_MISMATCH/)
      const socket = await pinnedConnect('example.com', 443, async () => [{ address: '93.184.216.34', family: 4 }], dialLoopback(server.port), [])
      const data = await new Promise<string>((resolve) => socket.on('data', (chunk) => resolve(chunk.toString())))
      expect(data).toBe('hello')
      socket.destroy()
    } finally {
      server.close()
    }
  })
})
async function pair() {
  const server = await listen(() => {})
  const client = connect({ host: '127.0.0.1', port: server.port })
  const guest = await new Promise<Socket>((resolve) => {
    server.close()
    resolve(client)
  })
  return guest
}
function guestChannel() {
  return new Promise<{ guest: Socket; host: Socket }>((resolve) => {
    const server = createServer((host) => {
      host.on('error', () => {})
      server.close()
      resolve({ guest: client, host })
    })
    let client: Socket
    server.listen(0, '127.0.0.1', () => {
      client = connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port })
      client.on('error', () => {})
    })
  })
}
describe('egress broker', () => {
  it.each(['offline', 'blocklist'] as const)('opens allowed streams and closes streams on %s revocation', async (mode) => {
    const remote = await listen((socket) => socket.on('data', (chunk) => socket.write(Buffer.from(`echo:${chunk}`))))
    const { guest, host } = await guestChannel()
    const broker = new EgressBroker({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], dialer: dialLoopback(remote.port), hostAddresses: [] })
    const frames: any[] = []
    const decoder = new LineDecoder()
    const waitFor = (predicate: (f: any) => boolean) =>
      new Promise<any>((resolve) => {
        const check = () => {
          const found = frames.find(predicate)
          if (found) resolve(found)
          else setTimeout(check, 10)
        }
        check()
      })
    guest.on('data', (chunk) => {
      for (const line of decoder.push(chunk)) frames.push(JSON.parse(line))
    })
    broker.bind('vm-1', host, policy)
    const send = (frame: unknown) => guest.write(JSON.stringify(frame) + '\n')
    await waitFor((f) => f.t === 'policy')
    send({ t: 'open', s: 1, host: 'evil.com', port: 443 })
    expect(await waitFor((f) => f.t === 'refused' && f.s === 1)).toMatchObject({ code: 'DOMAIN_DENIED' })
    send({ t: 'open', s: 2, host: 'example.com', port: 22 })
    expect(await waitFor((f) => f.t === 'refused' && f.s === 2)).toMatchObject({ code: 'PORT_DENIED' })
    send({ t: 'open', s: 3, host: '10.0.0.1', port: 443 })
    expect(await waitFor((f) => f.t === 'refused' && f.s === 3)).toMatchObject({ code: 'LITERAL_IP' })
    send({ t: 'open', s: 4, host: 'example.com', port: 443 })
    await waitFor((f) => f.t === 'opened' && f.s === 4)
    expect(broker.activeStreams('vm-1')).toBe(1)
    send({ t: 'data', s: 4, d: Buffer.from('ping').toString('base64') })
    const data = await waitFor((f) => f.t === 'data' && f.s === 4)
    expect(Buffer.from(data.d, 'base64').toString()).toBe('echo:ping')
    await waitFor((f) => f.t === 'ack' && f.s === 4)
    // Revoking the policy ends the active stream and denies new ones.
    broker.updatePolicy('vm-1', { mode, domains: mode === 'blocklist' ? ['example.com'] : [], revision: 2 })
    await waitFor((f) => f.t === 'close' && f.s === 4)
    expect(broker.activeStreams('vm-1')).toBe(0)
    send({ t: 'open', s: 5, host: 'example.com', port: 443 })
    expect(await waitFor((f) => f.t === 'refused' && f.s === 5)).toMatchObject({ code: mode === 'blocklist' ? 'DOMAIN_DENIED' : 'OFFLINE' })
    // Malformed frame or a frame with a foreign vm reference closes the channel; another VM never shares it.
    send({ t: 'open', s: 6, host: 'example.com', port: 443, vmId: 'vm-2' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(broker.activeStreams('vm-1')).toBe(0)
    expect(host.destroyed).toBe(true)
    broker.close()
    guest.destroy()
    remote.close()
  })
  it('fails closed with the broker stopped: the guest gets no answer and no connection', async () => {
    const remote = await listen((socket) => socket.end())
    const { guest, host } = await guestChannel()
    const broker = new EgressBroker({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], dialer: dialLoopback(remote.port), hostAddresses: [] })
    broker.bind('vm-1', host, policy)
    broker.close()
    let answered = false
    guest.on('data', () => {
      answered = true
    })
    guest.write(JSON.stringify({ t: 'open', s: 1, host: 'example.com', port: 443 }) + '\n')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(answered || host.destroyed).toBe(true)
    expect(broker.activeStreams('vm-1')).toBe(0)
    guest.destroy()
    remote.close()
  })
})
void pair

it('blocklist denies site trees without relaxing destination and address rules', async () => {
  const { decide, isForbiddenAddress } = await import('../src/egress/policy.js')
  const p = { mode: 'blocklist' as const, domains: ['blocked.test'], revision: 0 }
  expect(decide(p, 'www.google.com', 443)).toEqual({ host: 'www.google.com', port: 443 })
  expect(decide(p, 'a.blocked.test', 443)).toMatchObject({ code: 'DOMAIN_DENIED' })
  expect(decide(p, '127.0.0.1', 443)).toMatchObject({ code: 'LITERAL_IP' })
  expect(decide(p, 'www.google.com', 22)).toMatchObject({ code: 'PORT_DENIED' })
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fe80::1'])
    expect(isForbiddenAddress(ip, [])).toBe(true)
})
