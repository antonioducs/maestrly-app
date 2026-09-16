import { createConnection } from 'node:net'
import { lstat } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { DESKTOP_ATTACH_LINE_MAX, desktopAttachRequestSchema } from '@maestrly/host-protocol'
import { DESKTOP_SOCKET_PATH } from './transport.js'

/** Reads exactly one bounded line; bytes after it are returned untouched. */
export function readAttachLine(input: Readable, max = DESKTOP_ATTACH_LINE_MAX): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const done = (error?: Error, value?: { line: string; rest: Buffer }) => {
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('error', onEnd)
      input.pause()
      if (error) reject(error)
      else resolve(value!)
    }
    const onEnd = () => done(Error('Attach line missing'))
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(10)
      if (newline < 0) {
        if (buffer.length > max) done(Error('Attach line too long'))
        return
      }
      if (newline > max) return done(Error('Attach line too long'))
      done(undefined, { line: buffer.subarray(0, newline).toString('utf8'), rest: buffer.subarray(newline + 1) })
    }
    input.on('data', onData)
    input.once('end', onEnd)
    input.once('error', onEnd)
  })
}
/**
 * Fixed media bridge for the application: stdin carries one ticket line, then RFB
 * bytes. No arguments, no destinations and no secrets on the command line.
 */
export async function desktopStdio() {
  if (process.platform !== 'darwin') throw Error('desktop-stdio requires macOS')
  const parent = await lstat('/Library/MaestrlyHost/run')
  const info = await lstat(DESKTOP_SOCKET_PATH)
  if (!parent.isDirectory() || (parent.mode & 0o027) !== 0 || parent.uid === 0 || !info.isSocket() || (info.mode & 0o007) !== 0 || info.uid !== parent.uid)
    throw Error('Unsafe socket')
  const { line, rest } = await readAttachLine(process.stdin)
  const request = desktopAttachRequestSchema.parse(JSON.parse(line))
  const socket = createConnection(DESKTOP_SOCKET_PATH)
  const fail = () => {
    process.exitCode = 1
    socket.destroy()
    process.stdin.destroy()
  }
  socket.on('error', fail)
  socket.once('close', () => process.stdin.destroy())
  process.stdin.on('error', fail)
  process.stdout.on('error', fail)
  socket.once('connect', () => {
    socket.write(`${JSON.stringify(request)}\n`)
    if (rest.length) socket.write(rest)
    process.stdin.pipe(socket)
    socket.pipe(process.stdout)
    process.stdin.resume()
  })
}
