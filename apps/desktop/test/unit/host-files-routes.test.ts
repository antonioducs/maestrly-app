import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { FLEET_HOST_FILE_ROUTE_KEYS, FLEET_INSTANCE_ROUTES, buildPath } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import {
  createInstanceControlServer,
  type InstanceEnvironment,
  InstanceEvents,
} from '../../src/main/fleet/instance/server'
import { HostFiles } from '../../src/main/remote-host/server/host-files'

const token = randomBytes(32).toString('base64url')
const config = parseBotInstanceConfig({
  MAESTRLY_BOT_MODE: '1',
  MAESTRLY_BOT_CONTROL_TOKEN: token,
  MAESTRLY_BOT_CONTROL_HOST: '127.0.0.1',
  MAESTRLY_BOT_CONTROL_PORT: '0',
})!
// File routes run before any environment call, so an environment with only its event stream is enough.
const environment = { events: new InstanceEvents() } as unknown as InstanceEnvironment
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

let base: string
const servers: http.Server[] = []
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'host-files-routes-')))
  mkdirSync(path.join(base, 'srv'))
})
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  rmSync(base, { recursive: true, force: true })
})

async function listen(withFiles: boolean) {
  const hostFiles = new HostFiles({
    roots: () => [path.join(base, 'srv')],
    readRoots: () => [],
    uploadsDir: path.join(base, 'uploads'),
  })
  const server = createInstanceControlServer(config, environment, withFiles ? { hostFiles } : {})
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return (route: string, init: RequestInit & { auth?: boolean } = {}) =>
    fetch(origin + route, {
      ...init,
      headers: {
        'X-Maestrly-Fleet-Protocol': '1',
        ...(init.auth === false ? {} : { Authorization: `Bearer ${token}` }),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
}
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

// A workspaces host runs on Linux or macOS, and the host protocol takes POSIX paths only.
describe.skipIf(process.platform === 'win32')('host file routes of the control server', () => {
  it('stat, read a range, upload, commit and abort through HTTP', async () => {
    const call = await listen(true)
    const file = path.join(base, 'srv', 'a.txt')
    writeFileSync(file, '0123456789')
    const stat = await call('/v1/host-files/stat', json({ path: file }))
    expect(stat.status).toBe(200)
    const info = (await stat.json()) as { identity: string; size: number }
    expect(info.size).toBe(10)

    const range = await call(`/v1/host-files/content?path=${encodeURIComponent(file)}`, {
      headers: { range: 'bytes=0-3', 'x-maestrly-file-identity': info.identity },
    })
    expect(range.status).toBe(206)
    expect(range.headers.get('x-maestrly-sha256')).toBe(sha(Buffer.from('0123')))
    expect(await range.text()).toBe('0123')

    const bytes = randomBytes(4096)
    const begin = await call(
      '/v1/host-files/uploads',
      json({ directory: path.join(base, 'srv'), name: 'up.bin', size: bytes.length, overwrite: false })
    )
    expect(begin.status).toBe(200)
    const { uploadId } = (await begin.json()) as { uploadId: string }
    const put = await call(`/v1/host-files/uploads/${uploadId}?offset=0`, {
      method: 'PUT',
      headers: { 'x-maestrly-sha256': sha(bytes), 'x-maestrly-length': String(bytes.length) },
      body: bytes,
    })
    expect(put.status).toBe(204)
    const commit = await call(`/v1/host-files/uploads/${uploadId}/commit`, json({ sha256: sha(bytes) }))
    expect(commit.status).toBe(200)
    expect(readFileSync(path.join(base, 'srv', 'up.bin')).equals(bytes)).toBe(true)

    const other = (await (
      await call(
        '/v1/host-files/uploads',
        json({ directory: path.join(base, 'srv'), name: 'gone.bin', size: 1, overwrite: false })
      )
    ).json()) as { uploadId: string }
    expect((await call(`/v1/host-files/uploads/${other.uploadId}`, { method: 'DELETE' })).status).toBe(204)

    expect((await call('/v1/host-files/stat', { ...json({ path: file }), auth: false })).status).toBe(401)
  })

  it('has no file routes where it hosts bots', async () => {
    const call = await listen(false)
    for (const key of FLEET_HOST_FILE_ROUTE_KEYS) {
      const route = FLEET_INSTANCE_ROUTES[key]
      const response = await call(buildPath(route.path, { uploadId: 'abcdefghijklmnopqrstuv' }), {
        method: route.method,
        ...(route.body ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      })
      expect([key, response.status, ((await response.json()) as { message: string }).message]).toEqual([
        key,
        404,
        'Route not found.',
      ])
    }
  })
})
