// A client of the bots' screen stream (`maestrly-video`) for the container tests: through the gateway's WebSocket, or
// on a socket upgraded at an environment's control port. It acknowledges every frame as it arrives, as a viewer that
// draws at once would, and decodes nothing: the tests check the stream, the key frames and the input.
import {
  SCREEN_LIMITS,
  ScreenMessageReader,
  containsIdr,
  decodeServerMessage,
  encodeAck,
  encodeClipboardInput,
  encodeKey,
  encodePointerInput,
} from '@maestrly/bot-fleet-protocol'

export class ScreenStreamClient {
  /** Opens a gateway screen URL (`ws://…/v1/screen?ticket=…`). */
  static async webSocket(url) {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('Screen WebSocket failed: ' + url)), { once: true })
      ws.addEventListener('close', (event) => reject(new Error('Screen WebSocket closed: ' + event.code)), {
        once: true,
      })
    })
    const client = new ScreenStreamClient(
      (bytes) => ws.send(bytes),
      () => ws.close()
    )
    ws.addEventListener('message', (event) => client.receive(new Uint8Array(event.data)))
    ws.addEventListener('close', (event) => client.end(event.code))
    return client
  }

  /** Uses a socket that an environment's control port upgraded to the screen stream; `head` came with the answer. */
  static socket(socket, head) {
    const client = new ScreenStreamClient(
      (bytes) => socket.write(bytes),
      () => socket.destroy()
    )
    if (head?.length) client.receive(head)
    socket.on('data', (chunk) => client.receive(chunk))
    socket.on('close', () => client.end(null))
    socket.on('error', () => {})
    return client
  }

  constructor(write, close) {
    this.write = write
    this.closeTransport = close
    this.reader = new ScreenMessageReader(SCREEN_LIMITS.serverPayloadMax)
    this.events = []
    /** Every frame received: `{ id, key, bytes }`. */
    this.frames = []
    this.closed = undefined
    this.waiters = new Set()
  }

  receive(bytes) {
    for (const message of this.reader.push(new Uint8Array(bytes))) {
      const event = decodeServerMessage(message)
      if (event.type === 'frame') {
        this.frames.push({ id: event.id, key: event.key, idr: containsIdr(event.data), bytes: event.data.byteLength })
        this.write(encodeAck(event.id))
      }
      this.events.push(event)
    }
    this.wake()
  }

  end(code) {
    if (this.closed !== undefined) return
    this.closed = code
    this.wake()
  }

  wake() {
    for (const wake of [...this.waiters]) wake()
  }

  /** Resolves with the first truthy value of `test`, checked as the stream moves; rejects after `ms` or on close. */
  until(label, test, ms = 10000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        let value
        try {
          value = test()
        } catch (error) {
          finish()
          reject(error)
          return
        }
        if (value) {
          finish()
          resolve(value)
        } else if (this.closed !== undefined) {
          finish()
          reject(new Error(`Screen closed (${this.closed}) before ${label}`))
        }
      }
      const timer = setTimeout(() => {
        finish()
        reject(new Error('Timed out waiting for ' + label))
      }, ms)
      const finish = () => {
        clearTimeout(timer)
        this.waiters.delete(check)
      }
      this.waiters.add(check)
      check()
    })
  }

  /** The screen's hello: `{ version, width, height, mode }`. */
  async hello() {
    return (await this.until('the screen hello', () => this.events.find((event) => event.type === 'hello'))).hello
  }

  /** The first key frame, which must hold an IDR slice. */
  async keyFrame(ms = 10000) {
    const frame = await this.until('a key frame', () => this.frames.find((item) => item.key), ms)
    if (!frame.idr) throw new Error('Key frame ' + frame.id + ' holds no IDR slice')
    return frame
  }

  pointer(x, y, buttons = 0) {
    this.write(encodePointerInput(x, y, buttons))
  }
  key(keysym, down) {
    this.write(encodeKey(keysym, down))
  }
  tap(keysym) {
    this.key(keysym, true)
    this.key(keysym, false)
  }
  clipboard(text) {
    this.write(encodeClipboardInput(text))
  }

  /** The text of the next clipboard message after this call; rejects after `ms`. */
  async nextClipboard(ms = 3000) {
    const from = this.events.length
    const event = await this.until(
      'a clipboard message',
      () => this.events.slice(from).find((item) => item.type === 'clipboard'),
      ms
    )
    if (event.tooLarge) throw new Error('The screen clipboard is too large to send')
    return event.text
  }

  /** Clipboard messages received after index `from` of `events`. */
  clipboardsSince(from) {
    return this.events.slice(from).filter((item) => item.type === 'clipboard')
  }

  /** The close code (`null` for a socket without one) once the screen closed. */
  async closeCode(ms = 10000) {
    await this.until('the screen to close', () => this.closed !== undefined, ms)
    return this.closed
  }

  close() {
    this.closeTransport()
  }
}
