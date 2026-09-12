import { describe, expect, it, vi } from 'vitest'
import {
  hasEffectiveChatGptWebMcpWriteAccess,
  restartChatGptWebCompanion,
  type ChatGptWebCompanionLifecycleApi,
} from '../../src/renderer/lib/chatgpt-web'
import type { ChatGptWebCapabilities, ChatGptWebCapabilitiesInfo } from '../../src/shared/chat'
import { resources } from '../../src/shared/i18n/resources'

const capabilities: ChatGptWebCapabilities = {
  git: 'read',
  gh: 'read',
  conversation: 'read',
  memory: 'read',
  browser: 'interact',
  mcp: { enabled: 'write', disabled: 'write' },
}

const info: ChatGptWebCapabilitiesInfo = {
  capabilities,
  mcpServers: [
    { id: 'enabled', name: 'Enabled', enabled: true, scope: 'write' },
    { id: 'disabled', name: 'Disabled', enabled: false, scope: 'off' },
  ],
  editable: true,
  fingerprint: 'fingerprint',
}

function lifecycleApi(events: string[]): ChatGptWebCompanionLifecycleApi {
  return {
    chatGptWebCompanionEnd: vi.fn(async () => {
      events.push('end')
      return { ok: true }
    }),
    chatGptWebSetCapabilities: vi.fn(async (_conversationId, value) => {
      events.push(`save:${value.browser}:${value.conversation}`)
      return { ...info, capabilities: value }
    }),
    chatGptWebCompanionStart: vi.fn(async () => {
      events.push('start')
      return { ok: true, kickoff: 'pairing prompt', pairingRequired: true }
    }),
    chatGptWebCompanionCopyPrompt: vi.fn(async () => {
      events.push('copy')
      return { ok: true }
    }),
    chatGptWebCompanionOpen: vi.fn(async () => {
      events.push('open')
      return { ok: true }
    }),
  }
}

describe('ChatGPT Web access UI policy', () => {
  it('shows MCP write risk only for globally enabled servers with effective write access', () => {
    expect(hasEffectiveChatGptWebMcpWriteAccess(info, capabilities)).toBe(true)
    expect(
      hasEffectiveChatGptWebMcpWriteAccess(
        { mcpServers: info.mcpServers.map((server) => ({ ...server, enabled: false })) },
        capabilities
      )
    ).toBe(false)
    expect(hasEffectiveChatGptWebMcpWriteAccess(info, { ...capabilities, mcp: { enabled: 'read' } })).toBe(false)
  })

  it('registers Off/Read copy for bounded main-conversation access in both locales', () => {
    expect(resources.en.chat.chatGptWebAccess.conversationTitle).toBe('Conversation')
    expect(resources.en.chat.chatGptWebAccess.conversationReadDescription).toContain('bounded')
    expect(resources['pt-BR'].chat.chatGptWebAccess.conversationTitle).toBe('Conversa principal')
    expect(resources['pt-BR'].chat.chatGptWebAccess.conversationIsolation).toContain('outras conversas')
  })

  it('revokes the frozen session before saving capabilities and starting a new pairing', async () => {
    const events: string[] = []
    const result = await restartChatGptWebCompanion('conv', capabilities, false, lifecycleApi(events))

    expect(events).toEqual(['end', 'save:interact:read', 'start', 'copy', 'open'])
    expect(result).toMatchObject({ pairingRequired: true, promptCopied: true, capabilities: { capabilities } })
  })

  it('refuses to restart while a Review Loop owns the conversation', async () => {
    const events: string[] = []
    await expect(restartChatGptWebCompanion('conv', capabilities, true, lifecycleApi(events))).rejects.toThrow(
      'review-loop-active'
    )
    expect(events).toEqual([])
  })

  it('does not persist a new policy when revoking the previous session fails', async () => {
    const events: string[] = []
    const api = lifecycleApi(events)
    api.chatGptWebCompanionEnd = vi.fn(async () => {
      events.push('end')
      return { ok: false }
    })

    await expect(restartChatGptWebCompanion('conv', capabilities, false, api)).rejects.toThrow('session-end-failed')
    expect(events).toEqual(['end'])
  })
})
