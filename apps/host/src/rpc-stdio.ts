import { createConnection } from 'node:net'
import { lstat } from 'node:fs/promises'
import { requestSchema, responseSchema } from '@maestrly/host-protocol'
import { FrameDecoder, SOCKET_PATH, MAX_PENDING_REQUESTS } from './transport.js'

export async function rpcStdio() {
  if (process.platform !== 'darwin') throw Error('rpc-stdio requires macOS')
  const parent = await lstat('/Library/MaestrlyHost/run')
  const info = await lstat(SOCKET_PATH)
  if (
    !parent.isDirectory() ||
    (parent.mode & 0o027) !== 0 ||
    parent.uid === 0 ||
    !info.isSocket() ||
    (info.mode & 0o007) !== 0 ||
    info.uid !== parent.uid
  )
    throw Error('Unsafe socket')
  const socket = createConnection(SOCKET_PATH)
  const incoming = new FrameDecoder()
  const outgoing = new FrameDecoder()
  const pending = new Set<string>()
  let ended = false
  const fail = () => {
    process.exitCode = 1
    socket.destroy()
    process.stdin.destroy()
  }
  socket.setTimeout(30000, fail)
  socket.on('error', fail)
  socket.on('close', () => {
    if (pending.size) process.exitCode = 1
    process.stdin.destroy()
  })
  socket.on('data', (chunk) => {
    try {
      for (const frame of outgoing.push(chunk)) {
        const reply = responseSchema.parse(JSON.parse(frame))
        if (!pending.delete(reply.id)) throw Error('Unexpected reply')
        if (!process.stdout.write(`${JSON.stringify(reply)}\n`)) socket.pause()
      }
      if (ended && pending.size === 0) socket.end()
    } catch {
      fail()
    }
  })
  process.stdout.on('drain', () => socket.resume())
  process.stdout.on('error', fail)
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const frame of incoming.push(chunk)) {
        const request = requestSchema.parse(JSON.parse(frame))
        if (pending.size >= MAX_PENDING_REQUESTS || pending.has(request.id)) throw Error('Request limit')
        pending.add(request.id)
        if (!socket.write(`${JSON.stringify(request)}\n`)) process.stdin.pause()
      }
    } catch {
      fail()
    }
  })
  socket.on('drain', () => process.stdin.resume())
  process.stdin.on('error', fail)
  process.stdin.on('end', () => {
    ended = true
    if (incoming.incomplete) fail()
    else if (pending.size === 0) socket.end()
  })
}
