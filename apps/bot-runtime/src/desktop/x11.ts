import { connect, type Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { runtimeError } from '../turns/service.js'

// Minimal X11 client for XTEST input on the session's own display. One persistent
// connection keeps human input latency low; there is no generic command execution.
type XauthEntry = { family: number; address: string; number: string; name: string; data: Buffer }
export function parseXauthority(bytes: Buffer): XauthEntry[] {
  const entries: XauthEntry[] = []
  let offset = 0
  const field = () => {
    if (offset + 2 > bytes.length) throw new Error('Truncated Xauthority')
    const length = bytes.readUInt16BE(offset)
    offset += 2
    if (offset + length > bytes.length) throw new Error('Truncated Xauthority')
    const value = bytes.subarray(offset, offset + length)
    offset += length
    return value
  }
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) throw new Error('Truncated Xauthority')
    const family = bytes.readUInt16BE(offset)
    offset += 2
    entries.push({
      family,
      address: field().toString('latin1'),
      number: field().toString('latin1'),
      name: field().toString('latin1'),
      data: Buffer.from(field()),
    })
  }
  return entries
}
export function selectCookie(entries: XauthEntry[], display: string, host = hostname()) {
  const candidates = entries.filter(
    (entry) => entry.name === 'MIT-MAGIC-COOKIE-1' && entry.data.length === 16 && (entry.number === display || entry.number === '')
  )
  return (
    candidates.find((entry) => entry.family === 256 && entry.address === host) ??
    candidates.find((entry) => entry.family === 65535) ??
    candidates.find((entry) => entry.family === 256)
  )
}
const pad = (length: number) => (4 - (length % 4)) % 4
type Pending = { resolve: (reply: Buffer) => void; reject: (error: Error) => void }
export const X_EVENT = { keyPress: 2, keyRelease: 3, buttonPress: 4, buttonRelease: 5, motion: 6 } as const

export class X11Connection {
  root = 0
  width = 0
  height = 0
  minKeycode = 8
  maxKeycode = 255
  private xtest = 0
  private sequence = 0
  private buffer = Buffer.alloc(0)
  private pending = new Map<number, Pending>()
  private voidErrors: Error[] = []
  private failure?: Error
  private setupWaiter?: { resolve: () => void; reject: (error: Error) => void }
  private mappingListeners = new Set<() => void>()
  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.consume(chunk))
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.fail(new Error('X11 connection closed')))
  }
  get alive() {
    return !this.failure
  }
  onMappingChanged(listener: () => void) {
    this.mappingListeners.add(listener)
    return () => this.mappingListeners.delete(listener)
  }
  static async open(options: { display: string; xauthority?: string; timeoutMs?: number }): Promise<X11Connection> {
    const match = /^:([0-9]{1,4})$/.exec(options.display)
    if (!match) throw runtimeError('DESKTOP_CONFIGURATION', 'Invalid display')
    const number = match[1]
    const cookie = options.xauthority
      ? selectCookie(parseXauthority(await readFile(options.xauthority)), number)?.data
      : undefined
    let lastError: Error | undefined
    // Abstract socket first (per network namespace), then the private /tmp socket.
    for (const path of [`\0/tmp/.X11-unix/X${number}`, `/tmp/.X11-unix/X${number}`]) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const candidate = connect({ path })
          candidate.once('connect', () => resolve(candidate))
          candidate.once('error', reject)
        })
        const connection = new X11Connection(socket)
        await connection.handshake(cookie, options.timeoutMs ?? 5_000)
        return connection
      } catch (error) {
        lastError = error as Error
      }
    }
    throw runtimeError('DESKTOP_UNAVAILABLE', lastError?.message ?? 'X display unavailable')
  }
  private async handshake(cookie: Buffer | undefined, timeoutMs: number) {
    const name = cookie ? Buffer.from('MIT-MAGIC-COOKIE-1', 'latin1') : Buffer.alloc(0)
    const data = cookie ?? Buffer.alloc(0)
    const request = Buffer.alloc(12 + name.length + pad(name.length) + data.length + pad(data.length))
    request[0] = 0x6c
    request.writeUInt16LE(11, 2)
    request.writeUInt16LE(0, 4)
    request.writeUInt16LE(name.length, 6)
    request.writeUInt16LE(data.length, 8)
    name.copy(request, 12)
    data.copy(request, 12 + name.length + pad(name.length))
    const ready = new Promise<void>((resolve, reject) => {
      this.setupWaiter = { resolve, reject }
    })
    const timer = setTimeout(() => this.fail(new Error('X11 setup timed out')), timeoutMs)
    this.socket.write(request)
    try {
      await ready
    } finally {
      clearTimeout(timer)
    }
    const extension = await this.reply(this.encode(98, 0, this.text(Buffer.from('XTEST', 'latin1'))))
    if (extension[8] !== 1) throw runtimeError('DESKTOP_UNAVAILABLE', 'XTEST extension missing')
    this.xtest = extension[9]
  }
  private text(name: Buffer) {
    const body = Buffer.alloc(4 + name.length + pad(name.length))
    body.writeUInt16LE(name.length, 0)
    name.copy(body, 4)
    return body
  }
  private encode(opcode: number, data: number, body: Buffer) {
    const request = Buffer.alloc(4 + body.length)
    request[0] = opcode
    request[1] = data
    request.writeUInt16LE(request.length / 4, 2)
    body.copy(request, 4)
    return request
  }
  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.setupWaiter) {
      if (this.buffer.length < 8) return
      const size = 8 + this.buffer.readUInt16LE(6) * 4
      if (this.buffer.length < size) return
      const setup = this.buffer.subarray(0, size)
      this.buffer = this.buffer.subarray(size)
      const waiter = this.setupWaiter
      this.setupWaiter = undefined
      if (setup[0] !== 1) return waiter.reject(new Error('X11 authorization refused'))
      const body = setup.subarray(8)
      const vendor = body.readUInt16LE(16)
      this.minKeycode = body[26]
      this.maxKeycode = body[27]
      const screen = 32 + vendor + pad(vendor) + body[21] * 8
      this.root = body.readUInt32LE(screen)
      this.width = body.readUInt16LE(screen + 20)
      this.height = body.readUInt16LE(screen + 22)
      waiter.resolve()
    }
    while (this.buffer.length >= 32) {
      const kind = this.buffer[0] & 0x7f
      const size = kind === 1 || kind === 35 ? 32 + this.buffer.readUInt32LE(4) * 4 : 32
      if (this.buffer.length < size) return
      const message = Buffer.from(this.buffer.subarray(0, size))
      this.buffer = this.buffer.subarray(size)
      const sequence = message.readUInt16LE(2)
      if (kind === 0) {
        const error = runtimeError('DESKTOP_INPUT_REJECTED', `X11 error ${message[1]}`)
        const pending = this.pending.get(sequence)
        if (pending) {
          this.pending.delete(sequence)
          pending.reject(error)
        } else this.voidErrors.push(error)
      } else if (kind === 1) {
        const pending = this.pending.get(sequence)
        this.pending.delete(sequence)
        pending?.resolve(message)
      } else if (kind === 34) for (const listener of this.mappingListeners) listener()
    }
  }
  private fail(error: Error) {
    if (this.failure) return
    this.failure = error
    this.setupWaiter?.reject(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.socket.destroy()
  }
  private send(request: Buffer) {
    if (this.failure) throw runtimeError('DESKTOP_UNAVAILABLE', 'X11 connection closed')
    this.sequence = (this.sequence + 1) & 0xffff
    this.socket.write(request)
    return this.sequence
  }
  private reply(request: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const sequence = this.send(request)
        this.pending.set(sequence, { resolve, reject })
      } catch (error) {
        reject(error)
      }
    })
  }
  /** Round trip: every earlier request was processed; surfaces asynchronous errors. */
  async sync() {
    await this.reply(this.encode(43, 0, Buffer.alloc(0)))
    const error = this.voidErrors.shift()
    this.voidErrors.length = 0
    if (error) throw error
  }
  fakeInput(type: number, detail: number, x = 0, y = 0) {
    const request = Buffer.alloc(36)
    request[0] = this.xtest
    request[1] = 2
    request.writeUInt16LE(9, 2)
    request[4] = type
    request[5] = detail
    request.writeUInt32LE(type === X_EVENT.motion ? this.root : 0, 12)
    request.writeInt16LE(x, 24)
    request.writeInt16LE(y, 26)
    this.send(request)
  }
  async keyboardMapping() {
    const count = this.maxKeycode - this.minKeycode + 1
    const body = Buffer.alloc(4)
    body[0] = this.minKeycode
    body[1] = count
    const reply = await this.reply(this.encode(101, 0, body))
    const perKeycode = reply[1]
    const keysyms: number[] = []
    for (let offset = 32; offset + 4 <= reply.length && keysyms.length < count * perKeycode; offset += 4) keysyms.push(reply.readUInt32LE(offset))
    return { perKeycode, keysyms }
  }
  changeKeyboardMapping(keycode: number, perKeycode: number, keysyms: number[]) {
    const body = Buffer.alloc(4 + perKeycode * 4)
    body[0] = keycode
    body[1] = perKeycode
    keysyms.slice(0, perKeycode).forEach((keysym, index) => body.writeUInt32LE(keysym, 4 + index * 4))
    this.send(this.encode(100, 1, body))
  }
  async internAtom(name: string, onlyIfExists = false) {
    const reply = await this.reply(this.encode(16, onlyIfExists ? 1 : 0, this.text(Buffer.from(name, 'latin1'))))
    return reply.readUInt32LE(8)
  }
  async selectionOwner(atom: number) {
    const body = Buffer.alloc(4)
    body.writeUInt32LE(atom, 0)
    return (await this.reply(this.encode(23, 0, body))).readUInt32LE(8)
  }
  async pointer() {
    const body = Buffer.alloc(4)
    body.writeUInt32LE(this.root, 0)
    const reply = await this.reply(this.encode(38, 0, body))
    return { x: reply.readInt16LE(16), y: reply.readInt16LE(18) }
  }
  close() {
    this.fail(new Error('X11 connection closed by client'))
  }
}
