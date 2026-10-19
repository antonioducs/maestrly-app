import { isIP } from 'node:net'
import tls from 'node:tls'
import { normalizeFingerprint } from './identity'

/** No address of a paired computer showed its certificate. */
export class PeerUnreachable extends Error {
  constructor(
    /** One address refused the connection: the computer is up, but its peer server is not. */
    readonly refused: boolean,
    /** One address showed another certificate: the computer was reinstalled, or something sits in between. */
    readonly identityChanged: boolean
  ) {
    super('The computer could not be reached.')
  }
}

/**
 * Tries the addresses a paired computer was known at, starting the next one while earlier ones are pending, and
 * resolves the first that completes TLS with the pinned certificate. Nothing is sent over these connections.
 */
export function reachPeer(
  candidates: string[],
  port: number,
  fingerprint: string,
  options: { staggerMs?: number; timeoutMs?: number } = {}
): Promise<string> {
  const hosts = [...new Set(candidates.filter(Boolean))]
  const staggerMs = options.staggerMs ?? 300
  const timeoutMs = options.timeoutMs ?? 5_000
  if (hosts.length === 0) return Promise.reject(new PeerUnreachable(false, false))
  return new Promise((resolve, reject) => {
    const sockets = new Set<tls.TLSSocket>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    let failed = 0
    let refused = false
    let identityChanged = false
    let settled = false
    const cleanup = () => {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      timers.clear()
      sockets.clear()
    }
    const fail = (socket: tls.TLSSocket | null) => {
      if (socket) {
        if (!sockets.delete(socket)) return
        socket.destroy()
      }
      failed++
      if (!settled && failed === hosts.length) {
        settled = true
        cleanup()
        reject(new PeerUnreachable(refused, identityChanged))
      }
    }
    const attempt = (host: string) => {
      if (settled) return
      const socket = tls.connect({
        host,
        port,
        rejectUnauthorized: false,
        servername: isIP(host) ? undefined : host,
        timeout: timeoutMs,
      })
      sockets.add(socket)
      socket.once('secureConnect', () => {
        const seen = normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? '')
        if (seen !== fingerprint) {
          identityChanged = true
          fail(socket)
          return
        }
        if (settled) return
        settled = true
        cleanup()
        resolve(host)
      })
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED') refused = true
        fail(socket)
      })
      socket.once('timeout', () => fail(socket))
    }
    hosts.forEach((host, index) => {
      if (index === 0) return attempt(host)
      const timer = setTimeout(() => {
        timers.delete(timer)
        attempt(host)
      }, index * staggerMs)
      timers.add(timer)
    })
  })
}
