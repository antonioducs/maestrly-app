/**
 * MCP bridge transport for "ChatGPT Web": LOOPBACK HTTP, consumed only by `tunnel-client`
 * running on the same machine (`--mcp.server-url url=http://127.0.0.1:<port>/mcp/<token>`).
 *
 * Why HTTP instead of stdio: the bridge lives INSIDE the main process (session queue, tools rooted in
 * the conversation cwd, UI events). A stdio target would need a separate Node process just to forward
 * JSON-RPC back to main: more moving parts, same result. tunnel-client supports both targets.
 *
 * Security: bind to 127.0.0.1, use a random per-session path token, restrict `Host` to loopback
 * (DNS rebinding defense), and bound the body size. Nothing here is internet-facing: tunnel-client
 * communicates with OpenAI using OUTBOUND connections only.
 */
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { listenOnFreePort } from '../../net-port'
import type { BridgeRouter } from './bridge-router'

const BASE_PORT = 8971
const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface BridgeHttpEndpoint {
  url: string
  port: number
  close: () => Promise<void>
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true // tunnel-client may omit it; the bind is already loopback
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload muito grande'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * tunnel-client 0.0.10 recognizes MCP without OAuth when ALL PRMD candidates return 404.
 * In that version, an empty-body 404 stops discovery at the first candidate and leaves `/readyz`
 * permanently returning 503. A non-sensitive JSON envelope lets it also try the root candidate and
 * correctly classify the bridge as plain/no-auth.
 */
function writeNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }))
}

/** Start the endpoint and return the URL for tunnel-client to consume. */
export async function startBridgeHttp(bridge: Pick<BridgeRouter, 'handleMessage'>): Promise<BridgeHttpEndpoint> {
  const token = randomBytes(24).toString('hex')
  const pathname = `/mcp/${token}`

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (!isLoopbackHost(req.headers.host)) {
        res.writeHead(403).end()
        return
      }
      if (url.split('?')[0] !== pathname) {
        writeNotFound(res)
        return
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        // No dedicated SSE channel: each POST request carries its response (MCP HTTP stateless mode).
        res.writeHead(405, { Allow: 'POST' }).end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' }).end()
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        res
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }))
        return
      }
      try {
        const result = await bridge.handleMessage(payload)
        if (result === undefined) {
          res.writeHead(202).end() // notification: nothing to return
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          })
        )
      }
    })()
  })
  // Tool calls may run checks for several minutes; otherwise Node would close the connection after 2 min.
  server.keepAliveTimeout = 0
  server.headersTimeout = 0
  server.requestTimeout = 0
  server.setTimeout(0)

  const port = await listenOnFreePort(server, BASE_PORT)
  return {
    url: `http://127.0.0.1:${port}${pathname}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
