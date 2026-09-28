import { describe, expect, it } from 'vitest'
import { transformMcpServerForBot } from '../../src/main/fleet/client/provisioning/mcp-transform'
import type { McpServer } from '../../src/main/chat/mcp-types'

const server: McpServer = { id: 'm1', name: 'Tools', transport: 'stdio', enabled: true, command: 'npx' }
describe('Mac MCP transformation', () => {
  it.each([
    ['/opt/homebrew/bin/npx', 'npx', []],
    ['/Users/me/bin/tool', '/Users/me/bin/tool', ['absolute-command']],
    ['docker', 'docker', ['unsupported-command']],
  ])('transforms %s', (command, expected, warnings) => {
    const result = transformMcpServerForBot({ ...server, command }, '/Users/me')
    expect(result.payload?.command).toBe(expected)
    expect(result.warnings).toEqual(warnings)
    expect(result.recommended).toBe(warnings.length === 0)
  })
  it('flags Mac paths in arguments and environment', () => {
    expect(
      transformMcpServerForBot({ ...server, args: ['/Users/me/data'], env: { ROOT: '~/data' } }, '/Users/me').warnings
    ).toEqual(['mac-path'])
  })
  it('flags local hosts without exposing URL credentials or query secrets', () => {
    const result = transformMcpServerForBot(
      { ...server, transport: 'http', url: 'http://user:secret@127.0.0.1:3000/mcp?token=secret' },
      '/Users/me'
    )
    expect(result.warnings).toEqual(['local-url'])
    expect(result.target).toBe('127.0.0.1:3000')
  })
  it('refuses unavailable details', () => {
    expect(transformMcpServerForBot({ ...server, unavailable: true }, '/Users/me')).toMatchObject({
      payload: null,
      warnings: ['unavailable'],
      recommended: false,
    })
  })
})
