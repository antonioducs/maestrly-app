import http from 'node:http'
import net from 'node:net'
import { PassThrough, type Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FleetTunnelState } from '../../src/shared/fleet-installer'
import { InstallerError } from '../../src/main/fleet/installer/errors'
import { SshSession, generateSshKey } from '../../src/main/fleet/installer/ssh'
import { SshTunnel } from '../../src/main/fleet/installer/tunnel'
import { startFakeSshServer, type FakeSshServer } from '../fixtures/fake-ssh-server'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
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

async function setup(
  options: {
    key?: string | null
    listenPort?: number
    remotePort?: number
    allowForward?: () => boolean
    recoverForwarding?: boolean
  } = {}
) {
  const target = await gateway()
  const fake: FakeSshServer = await startFakeSshServer({
    users: {},
    forwardTo: (port) => (port === (options.remotePort ?? 7443) && (options.allowForward?.() ?? true) ? target : null),
  })
  cleanups.push(() => fake.close())
  const key = generateSshKey('maestrly-synthetic')
  fake.authorizedKeys.push(key.publicKey)
  const states: FleetTunnelState[] = []
  const errors: Array<InstallerError | null> = []
  const tunnel = new SshTunnel({
    target: { host: '127.0.0.1', port: fake.port, username: 'root' },
    hostKey: fake.fingerprint,
    privateKey: () => (options.key === undefined ? key.privateKey : options.key),
    remotePort: options.remotePort,
    recoverForwarding: options.recoverForwarding,
    listenPort: options.listenPort ?? (await freePort()),
    delay: () => 20,
    freePort,
    onState: (state) => states.push(state),
    onForwardError: (error) => errors.push(error),
  })
  cleanups.push(() => tunnel.stop())
  return { fake, tunnel, states, errors }
}

describe('SSH tunnel to the gateway', () => {
  it('forwards this computer’s port to the gateway on the server loopback', async () => {
    const { tunnel, states } = await setup()
    const port = await tunnel.start()
    await until(() => tunnel.state === 'connected')
    expect(await get(port)).toBe('synthetic gateway')
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('forwards the artifact viewer to port 4010 independently of the gateway', async () => {
    const api = await setup()
    const viewer = await setup({ remotePort: 4010 })
    const apiPort = await api.tunnel.start()
    const viewerPort = await viewer.tunnel.start()
    await until(() => api.tunnel.state === 'connected' && viewer.tunnel.state === 'connected')
    expect(await get(viewerPort)).toBe('synthetic gateway')
    await viewer.tunnel.stop()
    expect(await get(apiPort)).toBe('synthetic gateway')
  })

  it('reports artifact forwarding failure and recovery without stopping the gateway', async () => {
    let allowed = false
    const api = await setup()
    const viewer = await setup({ remotePort: 4010, allowForward: () => allowed, recoverForwarding: true })
    const apiPort = await api.tunnel.start()
    const viewerPort = await viewer.tunnel.start()
    await until(() => api.tunnel.state === 'connected' && viewer.tunnel.state === 'connected')
    await expect(get(viewerPort)).rejects.toThrow()
    expect(viewer.tunnel.lastForwardError).not.toBeNull()
    expect(viewer.errors.at(-1)).toBe(viewer.tunnel.lastForwardError)
    expect(await get(apiPort)).toBe('synthetic gateway')
    allowed = true
    await until(() => viewer.tunnel.lastForwardError === null)
    expect(await get(viewerPort)).toBe('synthetic gateway')
    expect(viewer.errors.at(-1)).toBeNull()
    expect(viewer.tunnel.lastForwardError).toBeNull()
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

  it('carries traffic over a session it is given, without a key, and leaves that session open', async () => {
    const target = await gateway()
    const fake = await startFakeSshServer({
      users: { root: 'synthetic-root-password' },
      forwardTo: (port) => (port === 7443 ? target : null),
    })
    cleanups.push(() => fake.close())
    const server = { host: '127.0.0.1', port: fake.port, username: 'root' }
    const session = await SshSession.connect(
      server,
      { kind: 'password', password: 'synthetic-root-password' },
      { expectedHostKey: fake.fingerprint }
    )
    cleanups.push(() => session.close())
    // As setup does until Maestrly's key is on the server.
    const tunnel = new SshTunnel({
      target: server,
      hostKey: fake.fingerprint,
      privateKey: () => null,
      session: async () => session,
      listenPort: await freePort(),
      delay: () => 20,
    })
    cleanups.push(() => tunnel.stop())
    const port = await tunnel.start()
    await until(() => tunnel.state === 'connected')
    expect(await get(port)).toBe('synthetic gateway')
    expect(fake.connections).toBe(1)
    await tunnel.stop()
    expect((await session.exec('id -u')).stdout.trim()).toBe('0')
  })

  it('asks for access again when its given session can no longer be used', async () => {
    const tunnel = new SshTunnel({
      target: { host: '127.0.0.1', port: 22, username: 'root' },
      hostKey: 'SHA256:synthetic',
      privateKey: () => null,
      session: async () => {
        throw new InstallerError('ssh-auth')
      },
      listenPort: await freePort(),
      delay: () => 20,
    })
    cleanups.push(() => tunnel.stop())
    await tunnel.start()
    await until(() => tunnel.state === 'needs-credentials')
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

async function recoveryHarness() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const listeners = new Set<() => void>()
  const session = {
    forward: vi.fn<() => Promise<Duplex>>().mockRejectedValue(new InstallerError('gateway-unhealthy')),
    onClose: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: vi.fn(() => {
      for (const listener of listeners) listener()
      listeners.clear()
    }),
  }
  vi.spyOn(SshSession, 'connect').mockResolvedValue(session as unknown as SshSession)
  const errors: Array<InstallerError | null> = []
  const tunnel = new SshTunnel({
    target: { host: '127.0.0.1', port: 22, username: 'root' },
    hostKey: 'SHA256:synthetic',
    privateKey: () => 'synthetic',
    listenPort: 0,
    remotePort: 4010,
    recoverForwarding: true,
    onForwardError: (error) => errors.push(error),
  })
  cleanups.push(() => tunnel.stop())
  const port = await tunnel.start()
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.on('error', reject)
    socket.on('close', () => resolve())
  })
  expect(session.forward).toHaveBeenCalledTimes(1)
  return { session, tunnel, errors }
}

describe('artifact forwarding recovery lifecycle', () => {
  it('backs off to one attempt per minute and cancels its unreferenced timer on stop', async () => {
    const { session, tunnel } = await recoveryHarness()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const attempts = session.forward.mock.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(session.forward).toHaveBeenCalledTimes(attempts)
      await vi.advanceTimersByTimeAsync(1)
      expect(session.forward).toHaveBeenCalledTimes(attempts + 1)
      expect(tunnel.lastForwardError).not.toBeNull()
      expect(vi.getTimerCount()).toBe(1)
      expect(timers.mock.results.at(-1)?.value.hasRef()).toBe(false)
    }
    await tunnel.stop()
    expect(vi.getTimerCount()).toBe(0)
    const attempts = session.forward.mock.calls.length
    await vi.advanceTimersByTimeAsync(120000)
    expect(session.forward).toHaveBeenCalledTimes(attempts)
  })

  it('destroys a late probe channel without announcing recovery after stop', async () => {
    const { session, tunnel, errors } = await recoveryHarness()
    let complete!: (channel: Duplex) => void
    session.forward.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(1000)
    await tunnel.stop()
    const channel = new PassThrough()
    complete(channel)
    await Promise.resolve()
    expect(channel.destroyed).toBe(true)
    expect(errors).toHaveLength(1)
    expect(tunnel.lastForwardError).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a stalled probe by closing only its own SSH session and resumes after reconnect', async () => {
    const { session, tunnel } = await recoveryHarness()
    session.forward.mockImplementationOnce(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(5999)
    expect(session.forward).toHaveBeenCalledTimes(2)
    expect(session.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(session.close).toHaveBeenCalledTimes(1)
    expect(tunnel.state).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(tunnel.state).toBe('connected')
    const channel = new PassThrough()
    session.forward.mockResolvedValueOnce(channel)
    await vi.advanceTimersByTimeAsync(2000)
    expect(tunnel.lastForwardError).toBeNull()
    expect(channel.destroyed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
