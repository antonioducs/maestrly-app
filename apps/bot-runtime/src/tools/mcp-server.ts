import type { Readable, Writable } from 'node:stream'
import { FrameDecoder } from '../control/framing.js'
import { TOOLS_FRAME_MAX } from './bridge.js'
export function serveMcp(
  input: Readable,
  output: Writable,
  version: string,
  forward: (id: string | number, method: string, params: Record<string, unknown>) => Promise<unknown>
) {
  const decoder = new FrameDecoder(TOOLS_FRAME_MAX)
  const send = (value: unknown) => output.write(JSON.stringify(value) + '\n')
  async function handle(raw: unknown) {
    const request = raw as { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> }
    if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } })
      return
    }
    if (request.id === undefined) return
    try {
      let result: unknown
      if (request.method === 'initialize')
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'maestrly-bot-tools', version },
        }
      else if (['tools/list', 'tools/call'].includes(request.method))
        result = await forward(request.id, request.method, request.params ?? {})
      else {
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
        return
      }
      send({ jsonrpc: '2.0', id: request.id, result })
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: error instanceof Error ? error.message : 'Bridge failed' },
      })
    }
  }
  input.on('data', (chunk: Buffer) => {
    try {
      for (const raw of decoder.push(chunk)) void handle(raw)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      input.destroy()
    }
  })
}
