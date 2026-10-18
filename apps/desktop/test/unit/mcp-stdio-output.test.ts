import { describe, expect, it } from 'vitest'
import { connectMcpServer } from '../../src/main/chat/mcp'
import { McpStdioFailure, mcpStdioSecrets, mcpStdioSummary } from '../../src/main/chat/mcp-stdio-output'

describe('the error output of a stdio MCP server', () => {
  it('keeps the lines that say why it stopped, not the report of the launcher around them', () => {
    const goServer = [
      '{"level":"fatal","message":"Authentication required: Either SLACK_MCP_XOXP_TOKEN or SLACK_MCP_XOXB_TOKEN must be provided","stacktrace":"main.main\\n\\t/src/main.go:71"}',
      'node:child_process:981',
      '    throw err;',
      '    ^',
      '',
      'Error: Command failed: /cache/_npx/bin/slack-mcp-server --transport stdio',
      '  status: 1,',
      '  signal: null,',
      '  output: [ null, null, null ],',
      '  stderr: null',
      '}',
      '',
      'Node.js v24.21.0',
    ].join('\n')
    expect(mcpStdioSummary(goServer, [])).toBe(
      'Authentication required: Either SLACK_MCP_XOXP_TOKEN or SLACK_MCP_XOXB_TOKEN must be provided | Error: Command failed: /cache/_npx/bin/slack-mcp-server --transport stdio'
    )
    const nodeServer =
      'npm warn deprecated @scope/server-slack@1.0.0: Package no longer supported.\n\x1b[31mPlease set SLACK_BOT_TOKEN and SLACK_TEAM_ID environment variables\x1b[0m\n'
    expect(mcpStdioSummary(nodeServer, [])).toBe('Please set SLACK_BOT_TOKEN and SLACK_TEAM_ID environment variables')
    expect(mcpStdioSummary('starting\nlistening on stdio\n', [])).toBe('starting | listening on stdio')
    expect(mcpStdioSummary('', [])).toBe('')
  })

  it('masks the values of its environment and arguments, and common token shapes', () => {
    const summary = mcpStdioSummary(
      'Error: token synthetic-value-0001 was rejected for --workspace synthetic-workspace\nAuthorization: Bearer abc.def-123 failed',
      ['synthetic-value-0001', 'synthetic-workspace']
    )
    expect(summary).not.toContain('synthetic-value-0001')
    expect(summary).not.toContain('synthetic-workspace')
    expect(summary).not.toContain('abc.def-123')
    expect(summary).toContain('was rejected')
    // Flag names stay readable; a flag that carries its value does not.
    expect(
      mcpStdioSecrets({ env: { TOKEN: 'synthetic-env' }, args: ['--transport', 'stdio', '--token=synthetic'] })
    ).toEqual(['synthetic-env', 'stdio', '--token=synthetic'])
  })

  it('reaches the connection error of a server that exits at once', async () => {
    const secret = 'synthetic-secret-0001'
    const error = await connectMcpServer(
      {
        id: 'mcp_00000000-0000-0000-0000-000000000000',
        name: 'slack',
        transport: 'stdio',
        enabled: true,
        command: process.execPath,
        args: ['-e', "console.error('Error: the token ' + process.env.SLACK_TOKEN + ' is invalid'); process.exit(1)"],
        env: { SLACK_TOKEN: secret },
      },
      { timeout: 20_000 }
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(McpStdioFailure)
    expect((error as McpStdioFailure).output).toBe('Error: the token *** is invalid')
    expect((error as Error).message).toMatch(
      /Connection closed\. The server's error output: Error: the token \*\*\* is/
    )
    expect((error as Error).message).not.toContain(secret)
  })
})
