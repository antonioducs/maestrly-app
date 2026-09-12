import { describe, expect, it } from 'vitest'
import {
  chatGptWebCapabilityFingerprint,
  remoteMcpServerCapabilities,
  resolveChatGptWebCapabilities,
} from '../../src/main/chat/chatgpt-web/capability-policy'
import { createChatGptWebBridge } from '../../src/main/chat/chatgpt-web/bridge-server'
import { deriveResumableSessionKey } from '../../src/main/chat/chatgpt-web/session'
import type { McpServer } from '../../src/main/chat/mcp'
import type { ChatGptWebCapabilities } from '../../src/shared/chat'

const servers: McpServer[] = [
  {
    id: 'jira',
    name: 'Jira',
    transport: 'http',
    enabled: true,
    url: 'https://example.test/mcp',
    headers: { Authorization: 'secret' },
  },
  { id: 'disabled', name: 'Disabled', transport: 'stdio', enabled: false, command: 'server', env: { TOKEN: 'secret' } },
]

describe('ChatGPT Web capability policy', () => {
  it('defaults to read-only and never grants a globally disabled server', () => {
    expect(resolveChatGptWebCapabilities(undefined, servers)).toEqual({
      git: 'read',
      gh: 'read',
      conversation: 'off',
      memory: 'off',
      browser: 'off',
      mcp: { jira: 'read', disabled: 'off' },
    })
    expect(
      resolveChatGptWebCapabilities(
        {
          git: 'read',
          gh: 'read',
          conversation: 'read',
          memory: 'read',
          browser: 'interact',
          mcp: { jira: 'write', disabled: 'write' },
        },
        servers
      ).mcp
    ).toEqual({ jira: 'write', disabled: 'off' })
  })

  it('resolves legacy persisted policies with sensitive capabilities fail-closed', () => {
    const legacy = { git: 'read', gh: 'read', browser: 'off', mcp: {} } as unknown as ChatGptWebCapabilities
    expect(resolveChatGptWebCapabilities(legacy, servers).conversation).toBe('off')
    expect(
      resolveChatGptWebCapabilities({ ...legacy, conversation: 'write' } as unknown as ChatGptWebCapabilities, servers)
        .conversation
    ).toBe('off')
  })

  it('browser defaults off and preserves only Off/Inspect/Interact values', () => {
    expect(resolveChatGptWebCapabilities(undefined, servers).browser).toBe('off')
    expect(
      resolveChatGptWebCapabilities(
        { git: 'read', gh: 'read', conversation: 'off', memory: 'off', browser: 'inspect', mcp: {} },
        servers
      ).browser
    ).toBe('inspect')
    expect(
      resolveChatGptWebCapabilities(
        { git: 'read', gh: 'read', conversation: 'off', memory: 'off', browser: 'interact', mcp: {} },
        servers
      ).browser
    ).toBe('interact')
    expect(
      resolveChatGptWebCapabilities(
        {
          git: 'read',
          gh: 'read',
          conversation: 'off',
          memory: 'off',
          browser: 'write' as never,
          mcp: {},
        },
        servers
      ).browser
    ).toBe('off')
  })

  it('rotates fingerprint/key on privilege or MCP config changes and remains stable otherwise', () => {
    const read = resolveChatGptWebCapabilities(undefined, servers)
    const readFingerprint = chatGptWebCapabilityFingerprint(read, servers)
    expect(chatGptWebCapabilityFingerprint(read, structuredClone(servers))).toBe(readFingerprint)
    const write = { ...read, mcp: { ...read.mcp, jira: 'write' as const } }
    const writeFingerprint = chatGptWebCapabilityFingerprint(write, servers)
    expect(writeFingerprint).not.toBe(readFingerprint)
    expect(chatGptWebCapabilityFingerprint({ ...read, browser: 'inspect' }, servers)).not.toBe(readFingerprint)
    expect(chatGptWebCapabilityFingerprint({ ...read, browser: 'interact' }, servers)).not.toBe(readFingerprint)
    expect(chatGptWebCapabilityFingerprint({ ...read, conversation: 'read' }, servers)).not.toBe(readFingerprint)
    expect(
      chatGptWebCapabilityFingerprint(read, [{ ...servers[0], headers: { Authorization: 'rotated' } }, servers[1]])
    ).not.toBe(readFingerprint)

    const base = { platformKey: 'platform-secret', tunnelId: 'tun', conversationId: 'conv', sessionScope: 'scope' }
    expect(deriveResumableSessionKey({ ...base, capabilityFingerprint: readFingerprint })).not.toBe(
      deriveResumableSessionKey({ ...base, capabilityFingerprint: writeFingerprint })
    )
    const conversationFingerprint = chatGptWebCapabilityFingerprint({ ...read, conversation: 'read' }, servers)
    expect(deriveResumableSessionKey({ ...base, capabilityFingerprint: readFingerprint })).not.toBe(
      deriveResumableSessionKey({ ...base, capabilityFingerprint: conversationFingerprint })
    )
  })

  it('discloses only authorized MCPs without transport metadata to the remote companion', async () => {
    const capabilities = resolveChatGptWebCapabilities(undefined, servers)
    expect(remoteMcpServerCapabilities(capabilities, servers)).toEqual([
      { serverId: 'jira', name: 'Jira', scope: 'read' },
    ])

    const bridge = createChatGptWebBridge({
      cwd: process.cwd(),
      external: {
        listCapabilities: () => ({
          conversation: 'read',
          mcpServers: [
            { serverId: 'jira', name: 'Jira', transport: 'http', scope: 'read' },
            { serverId: 'disabled', name: 'Disabled', transport: 'stdio', scope: 'off' },
          ],
        }),
        searchMcpTools: () => ({}),
        callMcpRead: () => ({}),
        callMcpWrite: () => ({}),
        gitRead: () => ({}),
        ghRead: () => ({}),
      },
    })
    const result = await bridge.callTool('list_external_capabilities', {})
    const payload = JSON.parse(result.content[0].text ?? '') as {
      conversation: string
      mcpServers: unknown[]
    }
    expect(payload.conversation).toBe('read')
    expect(payload.mcpServers).toEqual([{ serverId: 'jira', name: 'Jira', scope: 'read' }])
    expect(JSON.stringify(payload)).not.toContain('Disabled')
    expect(JSON.stringify(payload)).not.toContain('stdio')
    bridge.endSession()
  })
})
