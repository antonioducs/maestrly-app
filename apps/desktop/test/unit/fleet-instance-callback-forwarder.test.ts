import { afterEach, expect, it } from 'vitest'
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { forwardLoginCallback } from '../../src/main/fleet/instance/provisioning/callback-forwarder'

const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { port: (server.address() as AddressInfo).port, path: '/callback' }
}
it('forwards the exact query and localhost Host header and preserves an HTTPS redirect', async () => {
  let seen: { url?: string; host?: string } = {}
  const target = await serve((req, res) => {
    seen = { url: req.url, host: req.headers.host }
    res.writeHead(302, { Location: 'https://example.test/ok', 'Content-Type': 'text/html' })
    res.end('done')
  })
  expect(await forwardLoginCallback(target, 'code=a&state=b')).toEqual({
    status: 302,
    location: 'https://example.test/ok',
    contentType: 'text/html',
    body: 'done',
  })
  expect(seen).toEqual({ url: '/callback?code=a&state=b', host: 'localhost:' + target.port })
})
it('loads a local success redirect itself and keeps its tokens on the bot', async () => {
  const seen: string[] = []
  let port = 0
  const target = await serve((req, res) => {
    seen.push(req.url ?? '')
    if (req.url?.startsWith('/callback')) {
      res.writeHead(302, { Location: `http://localhost:${port}/success?id_token=secret-token&needs_setup=true` })
      res.end()
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<p>signed in</p>')
    }
  })
  port = target.port
  const reply = await forwardLoginCallback(target, 'code=a&state=b')
  expect(reply).toEqual({ status: 200, location: null, contentType: null, body: '' })
  expect(seen).toEqual(['/callback?code=a&state=b', '/success?id_token=secret-token&needs_setup=true'])
  expect(JSON.stringify(reply)).not.toContain('secret-token')
})
it('does not follow a redirect to another local port', async () => {
  const seen: string[] = []
  const target = await serve((req, res) => {
    seen.push(req.url ?? '')
    res.writeHead(302, { Location: 'http://localhost:1/elsewhere' })
    res.end()
  })
  expect((await forwardLoginCallback(target, 'code=a')).location).toBeNull()
  expect(seen).toEqual(['/callback?code=a'])
})
it('discards insecure redirects and bounds response bytes', async () => {
  const target = await serve((_req, res) => {
    res.writeHead(302, { Location: 'http://x' })
    res.end('a'.repeat(200 * 1024))
  })
  const reply = await forwardLoginCallback(target, 'code=a')
  expect(reply.location).toBeNull()
  expect(Buffer.byteLength(reply.body)).toBe(64 * 1024)
})
it('reports a closed helper without exposing the callback query', async () => {
  const target = await serve((_req, res) => res.end())
  await new Promise<void>((resolve) => servers[0].close(() => resolve()))
  await expect(forwardLoginCallback(target, 'code=private-code')).rejects.toThrow('did not answer')
})
it('times out a helper that never responds', async () => {
  const target = await serve(() => {})
  await expect(forwardLoginCallback(target, 'code=a', { timeoutMs: 20 })).rejects.toThrow('did not answer')
})
it('does not expand a truncated UTF-8 character past the response byte limit', async () => {
  const target = await serve((_req, res) => res.end('aa' + '€'.repeat(30_000)))
  const reply = await forwardLoginCallback(target, 'code=a')
  expect(Buffer.byteLength(reply.body)).toBeLessThanOrEqual(64 * 1024)
  expect(reply.body).not.toContain('�')
})
it('falls back to the IPv6 loopback helper when IPv4 refuses the connection', async () => {
  const server = http.createServer((_req, res) => res.end('ipv6'))
  servers.push(server)
  server.listen(0, '::1')
  await once(server, 'listening')
  const target = { port: (server.address() as AddressInfo).port, path: '/callback' }
  expect((await forwardLoginCallback(target, 'code=a')).body).toBe('ipv6')
})
