import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import { CONTROL_FRAME_MAX, VM_ROUTE_QUEUE_BYTES } from '@maestrly/host-protocol'

/** Transport only; no filesystem paths, provisioning or domain authorization. */
export class JsonWire extends EventEmitter {
  private buffer = Buffer.alloc(0)
  constructor(readonly stream: Duplex) {
    super()
    stream.on('error', () => stream.destroy())
    stream.on('close', () => this.emit('close'))
    stream.on('end', () => stream.destroy())
    stream.on('data', (chunk: Buffer) => {
      try {
        let offset = 0
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset)
          const end = newline < 0 ? chunk.length : newline
          if (this.buffer.length + end - offset + 1 > CONTROL_FRAME_MAX) throw new Error('Frame limit')
          this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)])
          if (newline < 0) break
          const frame: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer))
          this.buffer = Buffer.alloc(0)
          offset = newline + 1
          this.emit('frame', frame)
        }
      } catch { stream.destroy() }
    })
  }
  send(value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n')
    if (this.stream.destroyed || bytes.length > CONTROL_FRAME_MAX || this.stream.writableLength + bytes.length > VM_ROUTE_QUEUE_BYTES)
      throw new Error('VM channel unavailable or congested')
    this.stream.write(bytes)
  }
  close() { this.stream.destroy() }
}
