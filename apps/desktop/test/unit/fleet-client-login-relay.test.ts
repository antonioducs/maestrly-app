import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginRelay } from '../../src/main/fleet/client/provisioning/login-relay'

const relays: LoginRelay[] = []
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()))
})
async function freePort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
function request(
  port: number,
  path: string,
  method = 'GET'
): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location, body }))
    })
    req.on('error', reject)
    req.end()
  })
}
describe('Mac login relay', () => {
  it('forwards the exact query once, preserves HTTPS redirect and serves the done page afterwards', async () => {
    const port = await freePort()
    const forward = vi.fn(async () => ({
      status: 302,
      location: 'https://example.test/ok',
      contentType: null,
      body: '',
    }))
    relays.push(await LoginRelay.start({ port, path: '/callback', ttlMs: 10_000, forward, page: (kind) => kind }))
    expect((await request(port, '/other')).status).toBe(404)
    expect((await request(port, '/other/../callback?code=a')).status).toBe(404)
    expect((await request(port, '/callback')).status).toBe(404)
    expect((await request(port, '/callback?code=a', 'POST')).status).toBe(404)
    expect(await request(port, '/callback?code=a&state=b')).toMatchObject({
      status: 302,
      location: 'https://example.test/ok',
    })
    expect(forward).toHaveBeenCalledExactlyOnceWith('code=a&state=b')
    expect((await request(port, '/callback?code=x')).body).toBe('done')
    expect((await request(port, '/other')).body).toBe('done')
    expect(forward).toHaveBeenCalledOnce()
  })
  it('rejects a busy port and frees sockets on close', async () => {
    const port = await freePort()
    const options = { port, path: '/callback', ttlMs: 10_000, forward: vi.fn(), page: (kind: string) => kind }
    const relay = await LoginRelay.start(options)
    relays.push(relay)
    await expect(LoginRelay.start(options)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await relay.close()
    await relay.close()
    relays.push(await LoginRelay.start(options))
  })
  it('renders failure on thrown forwarding and allows a retry', async () => {
    const port = await freePort()
    const forward = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ status: 200, location: 'http://unsafe.test', contentType: 'text/html', body: '<p>ok</p>' })
    relays.push(await LoginRelay.start({ port, path: '/callback', ttlMs: 10_000, forward, page: (kind) => kind }))
    expect(await request(port, '/callback?error=denied')).toMatchObject({ status: 502, body: 'failed' })
    expect(await request(port, '/callback?code=a')).toMatchObject({
      status: 200,
      location: undefined,
      body: '<p>ok</p>',
    })
  })
  it('deduplicates concurrent callbacks while forwarding', async () => {
    const port = await freePort()
    let resolve!: (value: { status: number; location: null; contentType: null; body: string }) => void
    const forward = vi.fn(
      () =>
        new Promise<{ status: number; location: null; contentType: null; body: string }>((r) => {
          resolve = r
        })
    )
    relays.push(await LoginRelay.start({ port, path: '/callback', ttlMs: 10_000, forward, page: (kind) => kind }))
    const first = request(port, '/callback?code=a')
    await vi.waitFor(() => expect(forward).toHaveBeenCalledOnce())
    const second = request(port, '/callback?code=b')
    resolve({ status: 200, location: null, contentType: null, body: '' })
    await Promise.all([first, second])
    expect(forward).toHaveBeenCalledOnce()
  })
  it('closes on expiry', async () => {
    const port = await freePort()
    relays.push(await LoginRelay.start({ port, path: '/callback', ttlMs: 20, forward: vi.fn(), page: (kind) => kind }))
    await vi.waitFor(async () => {
      await expect(request(port, '/other')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    })
  })
})
