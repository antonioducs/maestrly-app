import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeProviderReply {
  status: number
  /** Status-line reason phrase; '' reproduces HTTP/2, which has none. Omitted uses Node's default. */
  reason?: string
  /** JSON-serialized unless already a string. */
  body: unknown
}

export interface FakeProviderServer {
  /** Base URL to configure as the provider's endpoint. */
  baseURL: string
  requests: Array<{ method: string; path: string; headers: IncomingHttpHeaders }>
  close(): Promise<void>
}

/** Local HTTP endpoint that answers every request with one provider failure. */
export async function startFakeProvider(reply: FakeProviderReply): Promise<FakeProviderServer> {
  const requests: FakeProviderServer['requests'] = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers })
    req.resume()
    req.on('end', () => {
      const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
      const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      if (reply.reason === undefined) res.writeHead(reply.status, headers)
      else res.writeHead(reply.status, reply.reason, headers)
      res.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
