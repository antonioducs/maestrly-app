import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, test } from 'vitest'
import { FrameDecoder } from '../src/control/framing.js'
import { temporary } from './helpers.js'
test('MCP child forwards tools/list and tools/call as JSONL', async () => {
  const state = await temporary()
  const main = join(state, 'mcp-main.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('../src/tools/mcp-main.ts', import.meta.url))],
    outfile: main,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  })
  const requests: { method: string; params: Record<string, unknown> }[] = []
  const server = createServer((socket) => {
    const decoder = new FrameDecoder()
    socket.on('data', (bytes: Buffer) => {
      for (const raw of decoder.push(bytes)) {
        const request = raw as { id: number; method: string; params: Record<string, unknown> }
        requests.push(request)
        socket.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result:
              request.method === 'tools/list'
                ? { tools: [{ name: 'memory_propose' }] }
                : { content: [{ type: 'text', text: 'ok' }] },
          }) + '\n'
        )
      }
    })
  })
  server.listen(join(state, 'tools.sock'))
  await once(server, 'listening')
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, MAESTRLY_BOT_STATE: state, MAESTRLY_BOT_TURN_ID: 'turn' },
  })
  const exited = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString()
  })
  const decoder = new FrameDecoder()
  const replies: Record<string, unknown>[] = []
  child.stdout.on('data', (bytes: Buffer) => {
    replies.push(...(decoder.push(bytes) as Record<string, unknown>[]))
  })
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory_propose', arguments: { content: 'hello' } },
      }) + '\n'
    )
    await expect
      .poll(() => {
        if (child.exitCode !== null) throw new Error(stderr)
        return replies.length
      })
      .toBe(3)
    expect(replies.find((reply) => reply.id === 1)?.result).toMatchObject({ protocolVersion: '2024-11-05' })
    expect(replies.find((reply) => reply.id === 2)?.result).toMatchObject({ tools: [{ name: 'memory_propose' }] })
    expect(replies.find((reply) => reply.id === 3)?.result).toMatchObject({ content: [{ type: 'text', text: 'ok' }] })
    expect(requests.find((request) => request.method === 'tools/call')?.params).toMatchObject({
      turnId: 'turn',
      requestId: expect.any(String),
    })
  } finally {
    child.kill()
    await exited
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
