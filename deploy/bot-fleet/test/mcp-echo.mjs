#!/usr/bin/env node
import readline from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.id === undefined) return
  if (request.method === 'initialize')
    return send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'e2e-echo', version: '1.0.0' } } })
  if (request.method === 'tools/list')
    return send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', description: 'Echo text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
  if (request.method === 'tools/call')
    return send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: `E2E-ECHO:${request.params?.arguments?.text ?? ''}` }] } })
  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
})
