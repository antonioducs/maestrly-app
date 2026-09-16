import { createConnection, createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, unlink } from 'node:fs/promises'
import type { Request, Response } from '@maestrly/host-protocol'
import { FrameDecoder, handleFrame, MAX_PENDING_REQUESTS } from './transport.js'
/** Removes a stale, owned, refused socket path; refuses anything live or untrusted. */
export async function recoverSocketPath(path: string) {
  // Caller holds the HostService ready lock before attempting recovery.
  try {
    const owned = await lstat(path)
    const parent = await lstat((await import('node:path')).dirname(path))
    if (
      !owned.isSocket() ||
      owned.uid !== process.getuid?.() ||
      !parent.isDirectory() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o022) !== 0
    )
      throw Error('Socket path already exists and is untrusted')
    const refused = await new Promise<boolean>((resolve) => {
      const probe = createConnection(path)
      const finish = (value: boolean) => {
        probe.destroy()
        resolve(value)
      }
      probe.setTimeout(1000, () => finish(false))
      probe.once('connect', () => finish(false))
      probe.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED'))
    })
    if (!refused) throw Error('Socket path already exists and may be live')
    const current = await lstat(path)
    if (!current.isSocket() || current.dev !== owned.dev || current.ino !== owned.ino || current.uid !== owned.uid)
      throw Error('Socket path changed during recovery')
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
export type ConnectionContext = { connectionId: string }
export async function startSocket(
  path: string,
  dispatch: (request: Request, context: ConnectionContext) => Promise<Response>,
  log: (event: 'connection_rejected' | 'protocol_rejected' | 'request_completed') => void = () => {},
  /** A closed connection ends everything bound to it, such as desktop viewers. */
  onClose: (connectionId: string) => void = () => {}
) {
  await recoverSocketPath(path)
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (sockets.size >= 32) {
      log('connection_rejected')
      socket.destroy()
      return
    }
    sockets.add(socket)
    const context: ConnectionContext = { connectionId: randomUUID() }
    socket.setTimeout(30000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      sockets.delete(socket)
      onClose(context.connectionId)
    })
    const decoder = new FrameDecoder()
    let pending = 0
    let chain = Promise.resolve()
    socket.on('end', () => {
      if (decoder.incomplete) socket.destroy()
      else void chain.finally(() => socket.end())
    })
    socket.on('data', (chunk) => {
      try {
        const frames = decoder.push(chunk)
        if (pending + frames.length > MAX_PENDING_REQUESTS) throw Error('Queue limit')
        for (const frame of frames) {
          pending++
          chain = chain
            .then(async () => {
              if (socket.destroyed) return
              const response = await handleFrame(frame, (request) => dispatch(request, context))
              if (!socket.destroyed)
                await new Promise<void>((resolve, reject) =>
                  socket.write(`${JSON.stringify(response)}\n`, (error) => (error ? reject(error) : resolve()))
                )
              log('request_completed')
            })
            .catch(() => {
              socket.destroy()
            })
            .finally(() => {
              pending--
            })
        }
      } catch {
        log('protocol_rejected')
        socket.destroy()
      }
    })
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
