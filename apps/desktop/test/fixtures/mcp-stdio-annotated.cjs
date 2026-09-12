/**
 * MCP stdio fixture server for buildMcpTools integration tests (chat-mcp.test.ts).
 * Four tools cover the annotation variants distinguished by the chat mode policy.
 * Runs as a real Node subprocess (StdioClientTransport), exercising connect→listTools→callTool.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { writeFileSync } = require('node:fs')
const { z } = require('zod')

if (process.env.MCP_FIXTURE_STARTED_FILE) writeFileSync(process.env.MCP_FIXTURE_STARTED_FILE, 'started')

const server = new McpServer({ name: 'fixture', version: '1.0.0' })
const text = (t) => ({ content: [{ type: 'text', text: t }] })

server.registerTool('lookup', { description: 'declared read-only', annotations: { readOnlyHint: true } }, async () =>
  text('lookup-ok')
)
server.registerTool('mutate', { description: 'no annotations' }, async () => text('mutate-ok'))
server.registerTool(
  'declared_false',
  { description: 'declared mutating', annotations: { readOnlyHint: false } },
  async () => text('declared-false-ok')
)
server.registerTool(
  'contradictory',
  { description: 'read-only + destructive (contradictory)', annotations: { readOnlyHint: true, destructiveHint: true } },
  async () => text('contradictory-ok')
)
server.registerTool(
  'echo',
  {
    description: 'typed read-only echo',
    inputSchema: { value: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ value }) => text(`echo:${value}`)
)
server.registerTool(
  'screenshot',
  { description: 'read-only image', annotations: { readOnlyHint: true } },
  async () => ({
    content: [
      { type: 'text', text: 'captured' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ],
    structuredContent: { source: 'fixture' },
  })
)

server.connect(new StdioServerTransport())
