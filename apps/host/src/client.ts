import { createConnection } from 'node:net'
import { lstat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostSchema, responseSchema } from '@maestrly/host-protocol'
import { FrameDecoder, SOCKET_PATH } from './transport.js'
export async function inspectService() {
  const parent = await lstat('/Library/MaestrlyHost/run')
  const info = await lstat(SOCKET_PATH)
  if (
    !parent.isDirectory() ||
    parent.uid === 0 ||
    (parent.mode & 0o027) !== 0 ||
    !info.isSocket() ||
    info.uid !== parent.uid ||
    (info.mode & 0o007) !== 0
  )
    throw Error('Unsafe service socket')
  const id = randomUUID()
  return new Promise<ReturnType<typeof hostSchema.parse>>((resolve, reject) => {
    const socket = createConnection(SOCKET_PATH)
    const decoder = new FrameDecoder()
    let settled = false
    const fail = () => {
      if (!settled) {
        settled = true
        reject(Error('Service inspection unavailable'))
      }
      socket.destroy()
    }
    socket.setTimeout(30000, fail)
    socket.on('error', fail)
    socket.on('close', fail)
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ version: 1, id, method: 'host.inspect', params: {} })}\n`)
    )
    socket.on('data', (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          const reply = responseSchema.parse(JSON.parse(frame))
          if (reply.id !== id || reply.error) throw Error('Invalid service reply')
          const host = hostSchema.parse(reply.result)
          settled = true
          // Runtime failure details can contain local paths: expose availability only.
          resolve({
            ...host,
            runtimes: host.runtimes.map((runtime) => ({ id: runtime.id, available: runtime.available })),
          })
          socket.destroy()
        }
      } catch {
        fail()
      }
    })
  })
}
