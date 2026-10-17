import { FLEET_BOT_ENV } from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMcpNeedsAuthError, McpNeedsAuthError } from '../../src/main/chat/mcp-auth-errors'

const user = { id: 'mcp_00000000-0000-0000-0000-000000000000', name: 'notes' }
const plugin = {
  id: 'plg_00000000000000000000',
  name: 'slack-slack',
  origin: { kind: 'plugin' as const, pluginKey: 'slack@openai', pluginName: 'Slack', serverKey: 'slack' },
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('MCP sign-in errors', () => {
  it("points to this computer's settings: Tools for the person's servers, Plugins for a plugin's", () => {
    const error = new McpNeedsAuthError(user, 'Work')
    expect(isMcpNeedsAuthError(error)).toBe(true)
    expect(error.serverId).toBe(user.id)
    expect(error.message).toBe(
      'Sign-in required: connect "notes" (account "Work") in Settings → Maestrly Chat → Tools, then try again.'
    )
    expect(new McpNeedsAuthError(plugin).message).toContain('in Settings → Maestrly Chat → Plugins,')
  })

  it("points a bot to its environment's settings in the app", () => {
    vi.stubEnv(FLEET_BOT_ENV.mode, '1')
    const message = new McpNeedsAuthError(plugin).message
    expect(message).toContain("this bot's environment settings in the Maestrly app")
    expect(message).toContain('then Plugins')
    expect(message).not.toContain('Settings → Maestrly Chat')
  })

  it('asks for a new token when the server rejected the one it was given', () => {
    const message = new McpNeedsAuthError({ ...plugin, headers: { Authorization: 'Bearer synthetic' } }).message
    expect(message).toMatch(/^Access token rejected: "slack-slack"/)
    expect(message).toContain('Replace it in Settings → Maestrly Chat → Plugins')
    expect(message).not.toContain('synthetic')
  })
})
