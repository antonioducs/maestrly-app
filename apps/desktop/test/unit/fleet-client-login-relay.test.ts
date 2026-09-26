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
    relays.push(
      await LoginRelay.start({
        port,
        path: '/callback',
        ttlMs: 10_000,
        forward,
        page: (kind) => kind,
        redirectAllowed: (url) => url.startsWith('https://example.test/'),
      })
    )
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
    const options = {
      port,
      path: '/callback',
      ttlMs: 10_000,
      forward: vi.fn(),
      page: (kind: string) => kind,
      redirectAllowed: () => false,
    }
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
    relays.push(
      await LoginRelay.start({
        port,
        path: '/callback',
        ttlMs: 10_000,
        forward,
        page: (kind) => kind,
        redirectAllowed: () => true,
      })
    )
    expect(await request(port, '/callback?error=denied')).toMatchObject({ status: 502, body: 'failed' })
    // The bot's page and its plain-HTTP redirect never reach the browser: the Mac serves its own page.
    expect(await request(port, '/callback?code=a')).toMatchObject({ status: 200, location: undefined, body: 'done' })
  })
  it('sends the browser only to redirects the attempt allows', async () => {
    const port = await freePort()
    const forward = vi.fn(async () => ({
      status: 302,
      location: 'https://phishing.example/login',
      contentType: 'text/html',
      body: '<script>steal()</script>',
    }))
    relays.push(
      await LoginRelay.start({
        port,
        path: '/callback',
        ttlMs: 10_000,
        forward,
        page: (kind) => kind,
        redirectAllowed: (url) => url.startsWith('https://auth.openai.com/'),
      })
    )
    expect(await request(port, '/callback?code=a')).toEqual({ status: 200, location: undefined, body: 'done' })
  })
  it('shows the failure page for a refused callback without its body', async () => {
    const port = await freePort()
    const forward = vi.fn(async () => ({ status: 400, location: null, contentType: 'text/html', body: '<p>x</p>' }))
    relays.push(
      await LoginRelay.start({
        port,
        path: '/callback',
        ttlMs: 10_000,
        forward,
        page: (kind) => kind,
        redirectAllowed: () => true,
      })
    )
    expect(await request(port, '/callback?code=a')).toEqual({ status: 400, location: undefined, body: 'failed' })
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
    relays.push(
      await LoginRelay.start({
        port,
        path: '/callback',
        ttlMs: 10_000,
        forward,
        page: (kind) => kind,
        redirectAllowed: () => false,
      })
    )
    const first = request(port, '/callback?code=a')
    await vi.waitFor(() => expect(forward).toHaveBeenCalledOnce())
    const second = request(port, '/callback?code=b')
    resolve({ status: 200, location: null, contentType: null, body: '' })
    await Promise.all([first, second])
    expect(forward).toHaveBeenCalledOnce()
  })
  it.each([
    ['/favicon.ico', 'GET'],
    ['/callback', 'GET'],
    ['/callback?code=x', 'POST'],
  ])('keeps callback forwarding pending after %s %s', async (strayPath, method) => {
    const port = await freePort()
    let finish!: (value: { status: number; location: null; contentType: null; body: string }) => void
    const pending = new Promise<{ status: number; location: null; contentType: null; body: string }>((resolve) => {
      finish = resolve
    })
    const forward = vi.fn(() => pending)
    const relay = await LoginRelay.start({
      port,
      path: '/callback',
      ttlMs: 10_000,
      forward,
      page: (kind) => kind,
      redirectAllowed: () => false,
    })
    relays.push(relay)
    const first = request(port, '/callback?code=a')
    await vi.waitFor(() => expect(forward).toHaveBeenCalledOnce())
    expect((await request(port, strayPath, method)).status).toBe(404)
    const server = (relay as unknown as { servers: http.Server[] }).servers[0]
    const received = new Promise<void>((resolve) => server.once('request', () => resolve()))
    const second = request(port, '/callback?code=a')
    await received
    const calls = forward.mock.calls.length
    finish({ status: 200, location: null, contentType: null, body: '' })
    await Promise.all([first, second])
    expect(calls).toBe(1)
  })
  it('closes on expiry', async () => {
    const port = await freePort()
    relays.push(
      await LoginRelay.start({
        port,
        path: '/callback',
        ttlMs: 20,
        forward: vi.fn(),
        page: (kind) => kind,
        redirectAllowed: () => false,
      })
    )
    await vi.waitFor(async () => {
      await expect(request(port, '/other')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    })
  })
})
