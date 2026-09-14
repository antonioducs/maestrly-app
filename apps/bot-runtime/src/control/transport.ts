import { createReadStream, createWriteStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { Duplex } from 'node:stream'
import { SerialPort } from './serial-port.js'
export async function openControlTransport(path: string): Promise<Duplex> {
  const info = await stat(path)
  if (info.isSocket()) {
    const socket = connect({ path })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return socket
  }
  if (!info.isCharacterDevice() && !info.isFile())
    throw new Error('Control path must be a socket, character device or regular file')
  if (info.isCharacterDevice()) return SerialPort.open(path)
  const handle = await open(path, 'r+')
  const readable = createReadStream(path, { fd: handle.fd, autoClose: false })
  const writable = createWriteStream(path, { fd: handle.fd, autoClose: false })
  const stream = Duplex.from({ readable, writable })
  stream.once('close', () => {
    void handle.close().catch(() => {})
  })
  return stream
}
