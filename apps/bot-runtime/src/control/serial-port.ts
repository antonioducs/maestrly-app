import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

/** Blocking reads on an idle virtio port cannot be cancelled by destroying a
 * ReadStream. Nonblocking I/O keeps reconnects from exhausting libuv's workers. */
export class SerialPort extends Duplex {
  private reading = false
  private stopped = new AbortController()
  private constructor(private handle: FileHandle) { super() }
  static async open(path: string) {
    return new SerialPort(await open(path, constants.O_RDWR | constants.O_NONBLOCK))
  }
  override _read() {
    if (this.reading || this.destroyed) return
    this.reading = true
    void this.readNext().catch(error => { if (!this.destroyed) this.destroy(error) }).finally(() => { this.reading = false })
  }
  private async readNext() {
    while (!this.destroyed) {
      const bytes = Buffer.allocUnsafe(64 * 1024)
      try {
        const { bytesRead } = await this.handle.read(bytes, 0, bytes.length, null)
        if (this.destroyed) return
        if (!bytesRead) { this.push(null); return }
        if (!this.push(bytes.subarray(0, bytesRead))) return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
        await delay(10, undefined, { signal: this.stopped.signal })
      }
    }
  }
  override _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    void this.writeBytes(bytes).then(() => callback(), error => callback(error))
  }
  private async writeBytes(bytes: Buffer) {
    let offset = 0
    while (offset < bytes.length) {
      if (this.destroyed) throw new Error('Serial port closed')
      try {
        const { bytesWritten } = await this.handle.write(bytes, offset, bytes.length - offset, null)
        if (!bytesWritten) throw new Error('Serial write made no progress')
        offset += bytesWritten
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
        await delay(10, undefined, { signal: this.stopped.signal })
      }
    }
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.stopped.abort()
    void this.handle.close().then(() => callback(error), closeError => callback(error ?? closeError))
  }
}
