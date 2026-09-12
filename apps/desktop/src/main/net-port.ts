import net from 'node:net'
import type http from 'node:http'

/**
 * Loopback free-port helpers shared by app services. Each channel uses its own ports to avoid
 * cross-channel connections.
 */

/**
 * Probe free ports from start by opening and closing a temporary server. Suitable for immediate
 * external binding such as code serve-web; use listenOnFreePort for our own servers to avoid the
 * preflight/listen race.
 */
export function findFreePort(start: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      if (p > start + 100) return reject(new Error(`no free port starting at ${start}`))
      const srv = net.createServer()
      srv.once('error', () => tryPort(p + 1)) // port in use; try the next
      srv.once('listening', () => srv.close(() => resolve(p)))
      srv.listen(p, host)
    }
    tryPort(start)
  })
}

/**
 * Bind the actual server, retrying incremented ports on EADDRINUSE. Resolve after listening with
 * server.address()'s bound port so callers can safely connect. Remove temporary error/listening
 * handlers on completion.
 */
export function listenOnFreePort(server: http.Server, start: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    let p = start
    const cleanup = () => {
      server.removeListener('error', onError)
      server.removeListener('listening', onListening)
    }
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && p < start + 100) {
        p += 1
        server.listen(p, host) // try next port while retaining handlers until completion
        return
      }
      cleanup()
      reject(err)
    }
    const onListening = () => {
      cleanup()
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : p)
    }
    server.on('error', onError)
    server.on('listening', onListening)
    server.listen(p, host)
  })
}
