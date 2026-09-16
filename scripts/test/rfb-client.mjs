// Minimal RFB 3.8 test client (security None, Raw encoding). It exists to prove real
// framebuffer transport and to act as a *hostile* viewer in tests: it can send key,
// pointer, clipboard and resize messages that a read-only server must ignore.
import { connect } from 'node:net'

export const RFB_ENCODING_RAW = 0
export const RFB_ENCODING_TIGHT = 7
export const RFB_ENCODING_DESKTOP_SIZE = -223
export const RFB_ENCODING_LAST_RECT = -224
export const RFB_ENCODING_CURSOR = -239
/** Tight quality/compression pseudo-encodings, as noVNC requests them. */
export const rfbQualityLevel = (level) => -32 + level
export const rfbCompressLevel = (level) => -256 + level
export class RfbClient {
  width = 0
  height = 0
  name = ''
  framebuffer = Buffer.alloc(0)
  updates = 0
  /** Bytes received from the server, including the handshake. */
  bytesReceived = 0
  /** Cursor shape updates (rich cursor pseudo-encoding), when requested. */
  cursors = []
  serverCutTexts = []
  closed = false
  #socket
  #buffer = Buffer.alloc(0)
  #waiters = []
  #updateWaiters = []
  #error
  constructor(socket) {
    this.#socket = socket
    socket.on('data', (chunk) => {
      this.bytesReceived += chunk.length
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#pump()
    })
    const fail = (error) => {
      this.closed = true
      this.#error = error ?? new Error('RFB connection closed')
      for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#error)
      for (const waiter of this.#updateWaiters.splice(0)) waiter.reject(this.#error)
    }
    socket.on('error', fail)
    socket.on('close', () => fail())
  }
  /** Connect to a Unix socket path or wrap an existing duplex stream. */
  static async connect(target, { shared = true, timeoutMs = 10_000, encodings = [RFB_ENCODING_RAW, RFB_ENCODING_DESKTOP_SIZE] } = {}) {
    const socket = typeof target === 'string' ? connect({ path: target }) : target
    const client = new RfbClient(socket)
    const timer = setTimeout(() => socket.destroy(new Error('RFB handshake timed out')), timeoutMs)
    try {
      const version = (await client.#read(12)).toString('latin1')
      if (!/^RFB 003\.00[378]\n$/.test(version)) throw new Error(`Unexpected RFB version ${JSON.stringify(version)}`)
      socket.write('RFB 003.008\n')
      const count = (await client.#read(1))[0]
      if (count === 0) {
        const length = (await client.#read(4)).readUInt32BE(0)
        throw new Error(`RFB refused: ${(await client.#read(length)).toString('utf8')}`)
      }
      const types = [...(await client.#read(count))]
      if (!types.includes(1)) throw new Error(`Security None not offered: ${types.join(',')}`)
      socket.write(Buffer.from([1]))
      if ((await client.#read(4)).readUInt32BE(0) !== 0) throw new Error('RFB security failed')
      socket.write(Buffer.from([shared ? 1 : 0]))
      const init = await client.#read(24)
      client.width = init.readUInt16BE(0)
      client.height = init.readUInt16BE(2)
      client.name = (await client.#read(init.readUInt32BE(20))).toString('utf8')
      client.framebuffer = Buffer.alloc(client.width * client.height * 4)
      // 32bpp little-endian true colour, R<<16 | G<<8 | B.
      const format = Buffer.alloc(20)
      format[0] = 0
      format[4] = 32
      format[5] = 24
      format[6] = 0
      format[7] = 1
      format.writeUInt16BE(255, 8)
      format.writeUInt16BE(255, 10)
      format.writeUInt16BE(255, 12)
      format[14] = 16
      format[15] = 8
      format[16] = 0
      socket.write(format)
      const setEncodings = Buffer.alloc(4 + encodings.length * 4)
      setEncodings[0] = 2
      setEncodings.writeUInt16BE(encodings.length, 2)
      encodings.forEach((value, index) => setEncodings.writeInt32BE(value, 4 + index * 4))
      socket.write(setEncodings)
      void client.#loop()
      return client
    } catch (error) {
      socket.destroy()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  #pump() {
    while (this.#waiters.length && this.#buffer.length >= this.#waiters[0].size) {
      const waiter = this.#waiters.shift()
      const bytes = this.#buffer.subarray(0, waiter.size)
      this.#buffer = this.#buffer.subarray(waiter.size)
      waiter.resolve(Buffer.from(bytes))
    }
  }
  #read(size) {
    if (this.#error) return Promise.reject(this.#error)
    return new Promise((resolve, reject) => {
      this.#waiters.push({ size, resolve, reject })
      this.#pump()
    })
  }
  async #loop() {
    try {
      for (;;) {
        const type = (await this.#read(1))[0]
        if (type === 0) {
          const header = await this.#read(3)
          const rects = header.readUInt16BE(1)
          for (let index = 0; index < rects; index++) {
            const rect = await this.#read(12)
            const x = rect.readUInt16BE(0), y = rect.readUInt16BE(2), w = rect.readUInt16BE(4), h = rect.readUInt16BE(6)
            const encoding = rect.readInt32BE(8)
            if (encoding === RFB_ENCODING_RAW) {
              const pixels = await this.#read(w * h * 4)
              for (let row = 0; row < h; row++)
                pixels.copy(this.framebuffer, ((y + row) * this.width + x) * 4, row * w * 4, (row + 1) * w * 4)
            } else if (encoding === RFB_ENCODING_CURSOR) {
              // 32bpp pixels, then a 1-bit mask padded to whole bytes per row.
              const pixels = await this.#read(w * h * 4)
              const mask = await this.#read(Math.floor((w + 7) / 8) * h)
              this.cursors.push({ width: w, height: h, hotX: x, hotY: y, visible: mask.some((byte) => byte !== 0), pixels: pixels.length })
            } else if (encoding === RFB_ENCODING_TIGHT) {
              // Measurement only: the rectangle is consumed without decoding its pixels.
              await this.#skipTight(w, h)
            } else if (encoding === RFB_ENCODING_LAST_RECT) {
              break
            } else if (encoding === RFB_ENCODING_DESKTOP_SIZE) {
              this.width = w
              this.height = h
              this.framebuffer = Buffer.alloc(w * h * 4)
            } else throw new Error(`Unsupported encoding ${encoding}`)
          }
          this.updates++
          for (const waiter of this.#updateWaiters.splice(0)) waiter.resolve(this.updates)
        } else if (type === 1) {
          const header = await this.#read(5)
          await this.#read(header.readUInt16BE(3) * 6)
        } else if (type === 2) {
          // Bell
        } else if (type === 3) {
          const header = await this.#read(7)
          this.serverCutTexts.push((await this.#read(header.readUInt32BE(3))).toString('latin1'))
        } else throw new Error(`Unsupported server message ${type}`)
      }
    } catch (error) {
      if (!this.closed) this.#socket.destroy(error)
    }
  }
  async #compactLength() {
    let length = 0
    for (let shift = 0; shift < 21; shift += 7) {
      const byte = (await this.#read(1))[0]
      length |= (byte & 0x7f) << shift
      if (!(byte & 0x80)) break
    }
    return length
  }
  /** Consumes one Tight rectangle (32bpp depth 24, so a TPIXEL is 3 bytes). */
  async #skipTight(width, height) {
    const control = (await this.#read(1))[0] >> 4
    if (control === 0x08) return void (await this.#read(3))
    if (control === 0x09) return void (await this.#read(await this.#compactLength()))
    if (control > 0x09) throw new Error(`Unsupported Tight subencoding ${control}`)
    let rowSize = width * 3
    if (control & 0x04) {
      const filter = (await this.#read(1))[0]
      if (filter === 1) {
        const colors = (await this.#read(1))[0] + 1
        await this.#read(colors * 3)
        rowSize = colors === 2 ? Math.ceil(width / 8) : width
      } else if (filter !== 0 && filter !== 2) throw new Error(`Unsupported Tight filter ${filter}`)
    }
    const size = rowSize * height
    await this.#read(size < 12 ? size : await this.#compactLength())
  }
  requestUpdate(incremental = true, x = 0, y = 0, width = this.width, height = this.height) {
    const request = Buffer.alloc(10)
    request[0] = 3
    request[1] = incremental ? 1 : 0
    request.writeUInt16BE(x, 2)
    request.writeUInt16BE(y, 4)
    request.writeUInt16BE(width, 6)
    request.writeUInt16BE(height, 8)
    this.#socket.write(request)
  }
  /** Resolves on the next FramebufferUpdate after the request. */
  update(incremental = true, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      if (this.#error) return reject(this.#error)
      const timer = setTimeout(() => {
        this.#updateWaiters = this.#updateWaiters.filter((entry) => entry !== waiter)
        reject(new Error('No framebuffer update'))
      }, timeoutMs)
      const waiter = { resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } }
      this.#updateWaiters.push(waiter)
      this.requestUpdate(incremental)
    })
  }
  pixel(x, y) {
    const offset = (y * this.width + x) * 4
    return [this.framebuffer[offset + 2], this.framebuffer[offset + 1], this.framebuffer[offset]]
  }
  digest() {
    let hash = 2166136261
    for (let index = 0; index < this.framebuffer.length; index += 4) {
      hash ^= this.framebuffer[index] | (this.framebuffer[index + 1] << 8) | (this.framebuffer[index + 2] << 16)
      hash = Math.imul(hash, 16777619) >>> 0
    }
    return hash
  }
  /** Polls incremental updates until a pixel predicate holds; resolves with elapsed ms. */
  async waitForPixel(x, y, predicate, timeoutMs = 5_000) {
    const started = performance.now()
    while (!predicate(this.pixel(x, y))) {
      if (performance.now() - started > timeoutMs) throw new Error(`Pixel ${x},${y} did not change: ${this.pixel(x, y)}`)
      await this.update(true, Math.max(1, timeoutMs - (performance.now() - started))).catch(() => {})
    }
    return performance.now() - started
  }
  // Hostile messages: a read-only server must ignore every one of them.
  sendKey(keysym, down) {
    const message = Buffer.alloc(8)
    message[0] = 4
    message[1] = down ? 1 : 0
    message.writeUInt32BE(keysym, 4)
    this.#socket.write(message)
  }
  sendPointer(x, y, mask) {
    const message = Buffer.alloc(6)
    message[0] = 5
    message[1] = mask
    message.writeUInt16BE(x, 2)
    message.writeUInt16BE(y, 4)
    this.#socket.write(message)
  }
  sendCutText(text) {
    const bytes = Buffer.from(text, 'latin1')
    const message = Buffer.alloc(8 + bytes.length)
    message[0] = 6
    message.writeUInt32BE(bytes.length, 4)
    bytes.copy(message, 8)
    this.#socket.write(message)
  }
  sendSetDesktopSize(width, height) {
    const message = Buffer.alloc(24)
    message[0] = 251
    message.writeUInt16BE(width, 2)
    message.writeUInt16BE(height, 4)
    message[6] = 1
    message.writeUInt32BE(0, 8)
    message.writeUInt16BE(0, 12)
    message.writeUInt16BE(0, 14)
    message.writeUInt16BE(width, 16)
    message.writeUInt16BE(height, 18)
    message.writeUInt32BE(0, 20)
    this.#socket.write(message)
  }
  close() {
    this.closed = true
    this.#socket.destroy()
  }
}
