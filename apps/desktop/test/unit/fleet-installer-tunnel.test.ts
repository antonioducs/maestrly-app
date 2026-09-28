import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { FleetTunnelState } from '../../src/shared/fleet-installer'
import { generateSshKey } from '../../src/main/fleet/installer/ssh'
import { SshTunnel } from '../../src/main/fleet/installer/tunnel'
import { startFakeSshServer, type FakeSshServer } from '../fixtures/fake-ssh-server'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function gateway(): Promise<number> {
  const server = http.createServer((_request, response) => response.end('synthetic gateway'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return (server.address() as net.AddressInfo).port
}
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}
async function get(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/`)
  return response.text()
}
async function until(check: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the tunnel')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function setup(options: { key?: string | null; listenPort?: number } = {}) {
  const target = await gateway()
  const fake: FakeSshServer = await startFakeSshServer({
    users: {},
    forwardTo: (port) => (port === 7443 ? target : null),
  })
  cleanups.push(() => fake.close())
  const key = generateSshKey('maestrly-synthetic')
  fake.authorizedKeys.push(key.publicKey)
  const states: FleetTunnelState[] = []
  const tunnel = new SshTunnel({
    target: { host: '127.0.0.1', port: fake.port, username: 'root' },
    hostKey: fake.fingerprint,
    privateKey: () => (options.key === undefined ? key.privateKey : options.key),
    listenPort: options.listenPort ?? (await freePort()),
    delay: () => 20,
    freePort,
    onState: (state) => states.push(state),
  })
  cleanups.push(() => tunnel.stop())
  return { fake, tunnel, states }
}

describe('SSH tunnel to the gateway', () => {
  it('forwards this computer’s port to the gateway on the server loopback', async () => {
    const { tunnel, states } = await setup()
    const port = await tunnel.start()
    await until(() => tunnel.state === 'connected')
    expect(await get(port)).toBe('synthetic gateway')
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('reconnects after the server drops the connection', async () => {
    const { fake, tunnel, states } = await setup()
    const port = await tunnel.start()
    await until(() => tunnel.state === 'connected')
    await fake.restart()
    await until(() => states.includes('reconnecting') && tunnel.state === 'connected')
    expect(await get(port)).toBe('synthetic gateway')
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected'])
  })

  it('stops for good when the server’s host key changes', async () => {
    const { fake, tunnel } = await setup()
    await tunnel.start()
    await until(() => tunnel.state === 'connected')
    await fake.restart({ newHostKey: true })
    await until(() => tunnel.state === 'host-key-changed')
    const attempts = fake.connections
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(fake.connections).toBe(attempts)
  })

  it('asks for access again without a key', async () => {
    const { tunnel } = await setup({ key: null })
    await tunnel.start()
    await until(() => tunnel.state === 'needs-credentials')
  })

  it('takes another port when its own is in use, and closes it when stopped', async () => {
    const taken = net.createServer().listen(0, '127.0.0.1')
    await new Promise((resolve) => taken.once('listening', resolve))
    cleanups.push(() => new Promise<void>((resolve) => taken.close(() => resolve())))
    const busy = (taken.address() as net.AddressInfo).port
    const { tunnel } = await setup({ listenPort: busy })
    const port = await tunnel.start()
    expect(port).not.toBe(busy)
    expect(tunnel.port).toBe(port)
    await until(() => tunnel.state === 'connected')
    await tunnel.stop()
    expect(tunnel.state).toBe('off')
    await expect(get(port)).rejects.toThrow()
  })

  it('drops local connections while it has no SSH session', async () => {
    const { fake, tunnel } = await setup()
    const port = await tunnel.start()
    await until(() => tunnel.state === 'connected')
    await fake.close()
    await until(() => tunnel.state === 'reconnecting')
    await expect(get(port)).rejects.toThrow()
  })
})
