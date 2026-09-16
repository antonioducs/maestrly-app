import { createServer, type Socket } from 'node:net'
import { chmod, lstat, unlink } from 'node:fs/promises'
import { handleDesktopAttach, type DesktopAttach } from '@maestrly/host-core'
import { recoverSocketPath } from './rpc-server.js'

export const MAX_DESKTOP_CONNECTIONS = 8
/**
 * Private media socket for desktop-stdio. Each connection authorizes itself with one
 * single-use ticket line, then carries raw RFB bytes. It serves no other request.
 */
export async function startDesktopSocket(
  path: string,
  attach: DesktopAttach,
  log: (event: 'connection_rejected' | 'protocol_rejected' | 'request_completed') => void = () => {}
) {
  await recoverSocketPath(path)
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: false }, (socket) => {
    if (sockets.size >= MAX_DESKTOP_CONNECTIONS) {
      log('connection_rejected')
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
    void handleDesktopAttach(socket, attach).then(() => log('request_completed'))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(path, 0o660)
  const owned = await lstat(path)
  return async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    try {
      const current = await lstat(path)
      if (current.ino === owned.ino) await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
