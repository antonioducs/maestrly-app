import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HostConnection,
  type HostConnectionSnapshot,
  HostInvokeError,
} from '../../src/main/remote-host/client/host-connection'
import { IpcHandlerTable } from '../../src/main/remote-host/ipc-handler-table'
import { RemoteUiHub } from '../../src/main/remote-host/server/remote-ui-hub'
import { sendToConversation, sendToMainTargets } from '../../src/main/window-ipc'
import type { RemoteHostInfo } from '../../src/shared/remote-bridge'

const hostInfo: RemoteHostInfo = {
  os: 'linux',
  hostName: 'vps',
  homeDir: '/home/bot',
  roots: ['/home/bot'],
  desktopEffects: false,
  editor: false,
  browser: false,
}

const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** A host: the real hub behind a loopback HTTP server, with a handler table the test fills. */
async function host(appVersion = '1.2.3') {
  const table = new IpcHandlerTable()
  const locales: string[] = []
  const hub = new RemoteUiHub({
    table,
    appVersion,
    hostInfo: () => hostInfo,
    applyLocale: (locale) => locales.push(locale),
    log: vi.fn(),
  })
  const server = http.createServer()
  server.on('upgrade', (request, socket, head) => hub.handleUpgrade(request, socket, head))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  closers.push(async () => {
    hub.closeAll()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return { table, hub, locales, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/bridge` }
}

/** This computer's end: the real connection over the global WebSocket, as the main process opens it. */
function client(url: () => string, appVersion = '1.2.3') {
  const changes: HostConnectionSnapshot[] = []
  const events: Array<[number, string, unknown[]]> = []
  let dials = 0
  const connection = new HostConnection({
    connect: async () => {
      dials++
      return new WebSocket(url())
    },
    appVersion,
    client: () => ({ deviceName: 'Laptop', os: 'mac', locale: 'pt-BR' }),
    onChange: (snapshot) => changes.push(snapshot),
    onEvent: (origin, channel, args) => events.push([origin, channel, args]),
    timings: { retryBaseMs: 20, retryMaxMs: 40, welcomeTimeoutMs: 500 },
  })
  closers.push(() => connection.stop())
  const until = (state: HostConnectionSnapshot['state'], epoch?: number) =>
    vi.waitFor(() => {
      const now = connection.snapshot()
      expect(now.state).toBe(state)
      if (epoch !== undefined) expect(now.epoch).toBe(epoch)
    })
  return { connection, changes, events, until, dials: () => dials }
}

describe('bridge between this computer and a host', () => {
  it('connects, and says what the host is', async () => {
    const h = await host()
    const c = client(() => h.url)
    expect(c.connection.snapshot()).toEqual({ state: 'offline', epoch: 0, info: null, hostVersion: null })
    c.connection.start()
    expect(c.connection.snapshot().state).toBe('connecting')
    await c.until('online')
    expect(c.connection.snapshot()).toEqual({ state: 'online', epoch: 1, info: hostInfo, hostVersion: null })
    expect(h.locales).toEqual(['pt-BR'])
    expect(c.changes.map((change) => change.state)).toEqual(['connecting', 'online'])
  })

  it('runs the host’s handlers for a renderer of this computer and returns what they answer', async () => {
    const h = await host()
    const senders: number[] = []
    h.table.record('x:echo', 'invoke', (event, ...args: unknown[]) => {
      senders.push(event.sender.id)
      return { args }
    })
    h.table.record('x:fail', 'invoke', () => {
      throw Object.assign(new Error('No such workspace'), { code: 'not-found' })
    })
    const sent: unknown[][] = []
    h.table.record('x:note', 'send', (_event, ...args: unknown[]) => void sent.push(args))
    const c = client(() => h.url)
    c.connection.start()
    await c.until('online')
    c.connection.openOrigin(7, { role: 'main' })
    c.connection.openOrigin(8, { role: 'panel', convId: 'conv-1', panel: 'terminal' })

    const bytes = new Uint8Array([1, 2, 250])
    expect(await c.connection.invoke(7, 'x:echo', ['a', undefined, bytes, { deep: [null, 2] }])).toEqual({
      args: ['a', undefined, bytes, { deep: [null, 2] }],
    })
    await c.connection.invoke(8, 'x:echo', [])
    // Each renderer is its own sender on the host, never a real window's.
    expect(new Set(senders).size).toBe(2)
    expect(senders.every((id) => id < 0)).toBe(true)

    const failed = await c.connection.invoke(7, 'x:fail', []).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(HostInvokeError)
    expect(failed).toMatchObject({ message: 'No such workspace', code: 'not-found' })
    await expect(c.connection.invoke(7, 'x:missing', [])).rejects.toMatchObject({ code: 'unknown-channel' })
    // What drives a computer's own window or desktop is refused for another computer's renderer.
    h.table.record('sound:play', 'invoke', () => 'played')
    await expect(c.connection.invoke(7, 'sound:play', [])).rejects.toMatchObject({ code: 'remote-unsupported' })
    await expect(c.connection.invoke(99, 'x:echo', [])).rejects.toMatchObject({ code: 'unknown-origin' })

    c.connection.send(7, 'x:note', ['hello', 2])
    await vi.waitFor(() => expect(sent).toEqual([['hello', 2]]))
  })

  it('delivers what the host pushes to the renderers it concerns', async () => {
    const h = await host()
    h.table.record('x:ready', 'invoke', () => true)
    const c = client(() => h.url)
    c.connection.start()
    await c.until('online')
    c.connection.openOrigin(7, { role: 'main' })
    c.connection.openOrigin(8, { role: 'panel', convId: 'conv-1', panel: 'terminal' })
    // An answered call means the host has opened both origins.
    await c.connection.invoke(8, 'x:ready', [])

    sendToMainTargets('agent:status', { id: 'conv-1', status: 'working' })
    sendToConversation('conv-1', 'pty:data', { id: 't1', data: 'ls\n' }, { includeMain: false, panel: 'terminal' })
    sendToConversation('conv-2', 'pty:data', { id: 't2', data: 'x' }, { includeMain: false, panel: 'terminal' })
    await vi.waitFor(() => expect(c.events).toHaveLength(2))
    expect(c.events).toEqual([
      [7, 'agent:status', [{ id: 'conv-1', status: 'working' }]],
      [8, 'pty:data', [{ id: 't1', data: 'ls\n' }]],
    ])

    c.connection.closeOrigin(7)
    await c.connection.invoke(8, 'x:ready', [])
    sendToMainTargets('agent:status', { id: 'conv-1', status: 'idle' })
    await c.connection.invoke(8, 'x:ready', [])
    expect(c.events).toHaveLength(2)
  })

  it('comes back after the bridge drops: waiting calls fail, its renderers stay, and the epoch increases', async () => {
    const h = await host()
    let release: (() => void) | null = null
    h.table.record('x:slow', 'invoke', () => new Promise<void>((resolve) => (release = resolve)))
    h.table.record('x:ready', 'invoke', () => true)
    const c = client(() => h.url)
    c.connection.start()
    await c.until('online', 1)
    c.connection.openOrigin(7, { role: 'main' })
    const slow = c.connection.invoke(7, 'x:slow', []).catch((error: unknown) => error)
    await vi.waitFor(() => expect(release).not.toBeNull())

    h.hub.closeAll()
    expect(await slow).toMatchObject({ code: 'connection-lost' })
    await c.until('online', 2)
    expect(c.changes.map((change) => change.state)).toEqual(['connecting', 'online', 'reconnecting', 'online'])
    // The renderer is an origin of the new session without asking again.
    await c.connection.invoke(7, 'x:ready', [])
    sendToMainTargets('agent:status', { id: 'c', status: 'idle' })
    await vi.waitFor(() => expect(c.events).toEqual([[7, 'agent:status', [{ id: 'c', status: 'idle' }]]]))
  })

  it('keeps dialing a host that does not answer, and refuses calls meanwhile', async () => {
    const h = await host()
    let reachable = false
    const c = client(() => (reachable ? h.url : 'ws://127.0.0.1:1/v1/bridge'))
    c.connection.start()
    await c.until('reconnecting')
    await expect(c.connection.invoke(7, 'x:any', [])).rejects.toMatchObject({ code: 'not-connected' })
    await vi.waitFor(() => expect(c.dials()).toBeGreaterThan(2))
    reachable = true
    await c.until('online', 1)
  })

  it('does not insist with a host of another version until asked, and says which version it runs', async () => {
    const older = await host('1.2.2')
    const same = await host('1.2.3')
    let url = older.url
    const c = client(() => url)
    c.connection.start()
    await c.until('incompatible')
    expect(c.connection.snapshot()).toMatchObject({ epoch: 0, hostVersion: '1.2.2' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(c.dials()).toBe(1)
    await expect(c.connection.invoke(7, 'x:any', [])).rejects.toMatchObject({ code: 'not-connected' })

    // The host was updated.
    url = same.url
    c.connection.retry()
    await c.until('online', 1)
    expect(c.connection.snapshot().hostVersion).toBeNull()
  })

  it('stops for good when asked', async () => {
    const h = await host()
    const c = client(() => h.url)
    c.connection.start()
    await c.until('online')
    c.connection.openOrigin(7, { role: 'main' })
    c.connection.stop()
    expect(c.connection.snapshot().state).toBe('offline')
    expect(c.connection.hasOrigin(7)).toBe(false)
    await vi.waitFor(() => expect(h.hub.sessionCount()).toBe(0))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(c.dials()).toBe(1)
  })
})
