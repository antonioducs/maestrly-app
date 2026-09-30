import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import {
  createInstanceControlServer,
  type InstanceEnvironment,
  InstanceEvents,
} from '../../src/main/fleet/instance/server'

const token = randomBytes(32).toString('base64url')
const config = parseBotInstanceConfig({
  MAESTRLY_BOT_MODE: '1',
  MAESTRLY_BOT_CONTROL_TOKEN: token,
  MAESTRLY_BOT_CONTROL_HOST: '127.0.0.1',
  MAESTRLY_BOT_CONTROL_PORT: '0',
})!
// The bridge branch runs before any environment call, so an environment with only its event stream is enough.
const environment = { events: new InstanceEvents() } as unknown as InstanceEnvironment

const servers: http.Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

async function listen(bridge?: { handleUpgrade: (...args: never[]) => void }) {
  const server = createInstanceControlServer(config, environment, bridge ? { bridge: bridge as never } : {})
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

/** The status the control server answers an upgrade with, or `upgraded` when it hands the socket over. */
function upgrade(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<number | 'upgraded'>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        'X-Maestrly-Fleet-Protocol': '1',
        Authorization: `Bearer ${token}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        ...headers,
      },
    })
    request.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('upgrade', (_response, socket) => {
      socket.destroy()
      resolve('upgraded')
    })
    request.on('error', reject)
    request.end()
  })
}

describe('bridge upgrade on the control server', () => {
  it('hands an authenticated WebSocket upgrade of the bridge path to the bridge', async () => {
    const handleUpgrade = vi.fn((_request: http.IncomingMessage, socket: import('node:stream').Duplex) => {
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    })
    const port = await listen({ handleUpgrade: handleUpgrade as never })
    expect(await upgrade(port, '/v1/bridge')).toBe('upgraded')
    expect(handleUpgrade).toHaveBeenCalledTimes(1)
    expect(handleUpgrade.mock.calls[0][0].url).toBe('/v1/bridge')
  })

  it('checks origin, protocol and the control token before the bridge sees the socket', async () => {
    const handleUpgrade = vi.fn()
    const port = await listen({ handleUpgrade: handleUpgrade as never })
    expect(await upgrade(port, '/v1/bridge', { Authorization: 'Bearer wrong' })).toBe(401)
    expect(await upgrade(port, '/v1/bridge', { Authorization: '' })).toBe(401)
    expect(await upgrade(port, '/v1/bridge', { 'X-Maestrly-Fleet-Protocol': '2' })).toBe(426)
    expect(await upgrade(port, '/v1/bridge', { Origin: 'https://bad.example' })).toBe(403)
    expect(await upgrade(port, '/v1/bridge', { Upgrade: 'maestrly-rfb' })).toBe(400)
    expect(handleUpgrade).not.toHaveBeenCalled()
  })

  it('has no bridge in a bot environment', async () => {
    const port = await listen()
    expect(await upgrade(port, '/v1/bridge')).toBe(404)
  })
})
