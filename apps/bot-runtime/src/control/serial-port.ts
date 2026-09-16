import { close as closeFd, constants, open as openFd } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

type PipeHandle = { open(fd: number): void; close(callback?: () => void): void }
type PipeBinding = { Pipe: new (type: number) => PipeHandle; constants: { SOCKET: number } }
/** libuv's pipe handle: the only public-runtime way to put an arbitrary fd under epoll. */
function pipeBinding(): PipeBinding | undefined {
  try {
    const binding = (process as unknown as { binding(name: string): unknown }).binding('pipe_wrap') as PipeBinding
    return typeof binding?.Pipe === 'function' && typeof binding.constants?.SOCKET === 'number' ? binding : undefined
  } catch {
    return undefined
  }
}
/**
 * Readiness is trusted only where the kernel implements poll(): FIFOs and virtio-serial
 * ports (/dev/virtio-ports/* resolve to /dev/vportNpM). libuv aborts on descriptors that
 * epoll rejects, so every other device keeps the polling path.
 */
async function pollable(path: string) {
  const info = await stat(path)
  if (info.isFIFO()) return true
  return info.isCharacterDevice() && /^\/dev\/vport\d+p\d+$/.test(await realpath(path))
}
const openRaw = (path: string) =>
  new Promise<number>((resolve, reject) =>
    openFd(path, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOCTTY, (error, fd) => (error ? reject(error) : resolve(fd)))
  )

/**
 * A virtio-serial port as a stream. Event-driven where possible: data is delivered as soon
 * as the kernel reports it and writes wait for POLLOUT, so no message waits for a timer.
 * Closing the stream closes the descriptor, which keeps reconnects from trapping workers.
 */
export const SerialPort = {
  async open(path: string, options: { eventDriven?: boolean } = {}): Promise<Duplex> {
    const binding = options.eventDriven === false ? undefined : pipeBinding()
    if (binding && (await pollable(path))) {
      const fd = await openRaw(path)
      let handle: PipeHandle | undefined
      try {
        handle = new binding.Pipe(binding.constants.SOCKET)
        handle.open(fd)
      } catch {
        handle?.close()
        await new Promise<void>((resolve) => closeFd(fd, () => resolve()))
        return PolledPort.open(path)
      }
      // allowHalfOpen: a char device has no shutdown(); end of input (the Host side closed
      // the port) ends the whole stream and the owner reconnects.
      const socket = new Socket({ handle, allowHalfOpen: true, readable: true, writable: true } as never)
      socket.once('end', () => socket.destroy())
      return socket
    }
    return PolledPort.open(path)
  },
}

/** Fallback for descriptors without poll(): nonblocking reads retried on a short timer. */
export class PolledPort extends Duplex {
  private reading = false
  private stopped = new AbortController()
  private constructor(private handle: FileHandle) {
    super()
  }
  static async open(path: string) {
    return new PolledPort(await open(path, constants.O_RDWR | constants.O_NONBLOCK))
  }
  override _read() {
    if (this.reading || this.destroyed) return
    this.reading = true
    void this.readNext()
      .catch((error) => {
        if (!this.destroyed) this.destroy(error)
      })
      .finally(() => {
        this.reading = false
      })
  }
  private async readNext() {
    while (!this.destroyed) {
      const bytes = Buffer.allocUnsafe(64 * 1024)
      try {
        const { bytesRead } = await this.handle.read(bytes, 0, bytes.length, null)
        if (this.destroyed) return
        if (!bytesRead) {
          this.push(null)
          return
        }
        if (!this.push(bytes.subarray(0, bytesRead))) return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
        await delay(10, undefined, { signal: this.stopped.signal })
      }
    }
  }
  override _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    void this.writeBytes(bytes).then(
      () => callback(),
      (error) => callback(error)
    )
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
    void this.handle.close().then(
      () => callback(error),
      (closeError) => callback(error ?? closeError)
    )
  }
}
