import type { Duplex } from 'node:stream'
import { DESKTOP_ATTACH_LINE_MAX, desktopAttachReplySchema, desktopAttachRequestSchema, type DesktopAttachReply } from '@maestrly/host-protocol'

export type DesktopAttach = (ticket: string) => Promise<{ stream: Duplex; width: number; height: number }>
const code = (error: unknown) => {
  const value = (error as { code?: unknown })?.code
  return typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value) ? value : 'DESKTOP_UNAVAILABLE'
}
/**
 * One attach per connection: a bounded JSON line carrying a single-use ticket, then raw
 * RFB bytes in both directions. The ticket never appears in arguments, URLs or logs; a
 * malformed first line closes the connection without touching the guest.
 */
export function handleDesktopAttach(client: Duplex, attach: DesktopAttach, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0)
    let settled = false
    const reply = (value: DesktopAttachReply) => client.write(`${JSON.stringify(desktopAttachReplySchema.parse(value))}\n`)
    const refuse = (reason: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.off('data', onData)
      if (!client.destroyed) client.end(`${JSON.stringify({ accepted: false, code: reason })}\n`)
      resolve()
    }
    const timer = setTimeout(() => refuse('ATTACH_TIMEOUT'), timeoutMs)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(10)
      if (newline < 0) {
        if (buffer.length > DESKTOP_ATTACH_LINE_MAX) refuse('ATTACH_INVALID')
        return
      }
      if (newline > DESKTOP_ATTACH_LINE_MAX) return refuse('ATTACH_INVALID')
      client.off('data', onData)
      client.pause()
      clearTimeout(timer)
      let request: { ticket: string }
      try {
        request = desktopAttachRequestSchema.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8')))
      } catch {
        return refuse('ATTACH_INVALID')
      }
      const rest = buffer.subarray(newline + 1)
      void attach(request.ticket).then(
        ({ stream, width, height }) => {
          if (client.destroyed) {
            stream.destroy()
            return resolve()
          }
          settled = true
          reply({ accepted: true, width, height })
          if (rest.length) stream.write(rest)
          const close = () => {
            client.destroy()
            stream.destroy()
            resolve()
          }
          stream.on('error', () => stream.destroy())
          client.on('error', () => client.destroy())
          stream.once('close', close)
          client.once('close', close)
          client.pipe(stream).pipe(client)
          client.resume()
        },
        (error) => {
          settled = false
          refuse(code(error))
        }
      )
    }
    client.on('data', onData)
    client.on('error', () => refuse('ATTACH_INVALID'))
  })
}
