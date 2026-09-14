import { chmod, lstat, unlink } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { FrameDecoder } from '../control/framing.js'
import type { ToolRegistry } from './registry.js'

export const TOOLS_FRAME_MAX = 8 * 1024 * 1024
export class ToolsBridge {
  private sockets = new Set<Socket>()
  private server = createServer((socket) => this.attach(socket))
  readonly path: string
  constructor(
    state: string,
    private registry: ToolRegistry
  ) {
    this.path = join(state, 'tools.sock')
  }
  async start() {
    const info = await lstat(this.path).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (info) {
      if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error('Unsafe tools socket path')
      await unlink(this.path)
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.path, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    await chmod(this.path, 0o600)
  }
  private attach(socket: Socket) {
    if (this.sockets.size >= 32) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => this.sockets.delete(socket))
    const decoder = new FrameDecoder(TOOLS_FRAME_MAX)
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const raw of decoder.push(chunk)) void this.dispatch(socket, raw)
      } catch {
        socket.destroy()
      }
    })
  }
  private async dispatch(socket: Socket, raw: unknown) {
    const request = raw as { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> }
    if (request?.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof request.id)) {
      socket.destroy()
      return
    }
    try {
      let result: unknown
      if (request.method === 'tools/list') result = { tools: this.registry.list() }
      else if (request.method === 'tools/call') {
        const params = request.params ?? {}
        if (
          typeof params.turnId !== 'string' ||
          typeof params.requestId !== 'string' ||
          typeof params.name !== 'string'
        )
          throw new Error('turnId, requestId and name required')
        result = await this.registry.call(params.turnId, params.requestId, params.name, params.arguments)
      } else throw new Error('Unknown bridge method')
      this.send(socket, { jsonrpc: '2.0', id: request.id, result })
    } catch (error) {
      this.send(socket, {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: error instanceof Error ? error.message : 'Tool bridge failed' },
      })
    }
  }
  private send(socket: Socket, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n')
    if (bytes.length > TOOLS_FRAME_MAX || socket.writableLength > TOOLS_FRAME_MAX) {
      socket.destroy()
      return
    }
    if (!socket.destroyed) socket.write(bytes)
  }
  async close() {
    for (const socket of this.sockets) socket.destroy()
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
export function bridgeRequest(path: string, id: string | number, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    const decoder = new FrameDecoder(TOOLS_FRAME_MAX)
    let done = false
    const finish = (error?: Error, value?: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('Tool bridge timeout')), 310_000)
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('Tool bridge disconnected; request was not replayed')))
    socket.on('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'))
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const raw of decoder.push(chunk)) {
          const response = raw as { id: string | number; result?: unknown; error?: { message: string } }
          if (response.id !== id) throw new Error('Mismatched bridge response')
          finish(response.error ? new Error(response.error.message) : undefined, response.result)
        }
      } catch (error) {
        finish(error as Error)
      }
    })
  })
}
