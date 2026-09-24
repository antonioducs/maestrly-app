import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { botChatComposerSource, localChatComposerSource } from '../../src/renderer/components/chat/chat-composer-source'

const sourceFile = (name: string) => readFileSync(`src/renderer/components/${name}`, 'utf8')

describe('chat composer data sources', () => {
  it('keeps the desktop menus on the existing local methods', async () => {
    const api = {
      chatConfig: vi.fn().mockResolvedValue({}),
      chatGetConvTools: vi.fn().mockResolvedValue({}),
      chatSetConvTools: vi.fn().mockResolvedValue({ ok: true }),
      chatSubagentProfilesGetConversation: vi.fn().mockResolvedValue({}),
      chatSubagentProfilesSetConversationEnabled: vi.fn().mockResolvedValue({ ok: true }),
      chatSubagentsSetConversationEnabled: vi.fn().mockResolvedValue({ ok: true }),
      chatSkillsState: vi.fn().mockResolvedValue({}),
      chatSkillSetOverride: vi.fn().mockResolvedValue({ ok: true }),
      chatSkillResetOverrides: vi.fn().mockResolvedValue({ ok: true }),
      chatSkillSetSelection: vi.fn().mockResolvedValue({ ok: true }),
      chatCommands: vi.fn().mockResolvedValue({}),
    }
    vi.stubGlobal('window', { api })
    const source = localChatComposerSource('conversation-1')
    await source.chatConfig()
    await source.chatGetConvTools()
    await source.chatSetConvTools({ mcpDisabled: ['mcp'] })
    await source.chatSubagentProfilesGetConversation()
    await source.chatSubagentProfilesSetConversationEnabled(false)
    await source.chatSubagentsSetConversationEnabled(false)
    await source.chatSkillsState()
    await source.chatSkillSetOverride('skill', 'off')
    await source.chatSkillResetOverrides()
    await source.chatSkillSetSelection({ kind: 'none' })
    await source.chatCommands()
    expect(api.chatConfig).toHaveBeenCalledWith()
    expect(api.chatGetConvTools).toHaveBeenCalledWith('conversation-1')
    expect(api.chatSetConvTools).toHaveBeenCalledWith('conversation-1', { mcpDisabled: ['mcp'] })
    expect(api.chatSubagentProfilesGetConversation).toHaveBeenCalledWith('conversation-1')
    expect(api.chatSubagentProfilesSetConversationEnabled).toHaveBeenCalledWith('conversation-1', false)
    expect(api.chatSubagentsSetConversationEnabled).toHaveBeenCalledWith('conversation-1', false)
    expect(api.chatSkillsState).toHaveBeenCalledWith('conversation-1')
    expect(api.chatSkillSetOverride).toHaveBeenCalledWith('conversation-1', 'skill', 'off')
    expect(api.chatSkillResetOverrides).toHaveBeenCalledWith('conversation-1')
    expect(api.chatSkillSetSelection).toHaveBeenCalledWith('conversation-1', { kind: 'none' })
    expect(api.chatCommands).toHaveBeenCalledWith('conversation-1')
    vi.unstubAllGlobals()
  })

  it('drops conversation ids from all bot menu calls', async () => {
    const api = {
      fleetConversationCall: vi.fn().mockResolvedValue({}),
      fleetListSelections: vi.fn(),
      fleetUpdateBot: vi.fn(),
      fleetTakeover: vi.fn(),
      fleetUiOpen: vi.fn(),
    }
    vi.stubGlobal('window', { api })
    const source = botChatComposerSource({ id: 'bot-1', ceiling: 'auto' }, vi.fn(), () => 'human')
    await source.chatConfig()
    await source.chatGetConvTools()
    await source.chatSetConvTools({ app: true })
    await source.chatSubagentProfilesGetConversation()
    await source.chatSubagentProfilesSetConversationEnabled(true)
    await source.chatSubagentsSetConversationEnabled(true)
    await source.chatSkillsState()
    await source.chatSkillSetOverride('skill', 'on')
    await source.chatSkillResetOverrides()
    await source.chatSkillSetSelection({ kind: 'all' })
    await source.chatCommands()
    expect(api.fleetConversationCall.mock.calls).toEqual([
      ['bot-1', 'chatConfig'],
      ['bot-1', 'chatGetConvTools'],
      ['bot-1', 'chatSetConvTools', { app: true }],
      ['bot-1', 'chatSubagentProfilesGetConversation'],
      ['bot-1', 'chatSubagentProfilesSetConversationEnabled', true],
      ['bot-1', 'chatSubagentsSetConversationEnabled', true],
      ['bot-1', 'chatSkillsState'],
      ['bot-1', 'chatSkillSetOverride', 'skill', 'on'],
      ['bot-1', 'chatSkillResetOverrides'],
      ['bot-1', 'chatSkillSetSelection', { kind: 'all' }],
      ['bot-1', 'chatCommands'],
    ])
    vi.unstubAllGlobals()
  })

  it('reads the takeover state when managing, so a memoized source never acts on a stale state', async () => {
    const api = {
      fleetConversationCall: vi.fn(),
      fleetListSelections: vi.fn(),
      fleetUpdateBot: vi.fn(),
      fleetTakeover: vi.fn().mockResolvedValue({}),
      fleetUiOpen: vi.fn().mockResolvedValue(undefined),
    }
    vi.stubGlobal('window', { api })
    let state: FleetBot['takeover']['state'] = 'none'
    const openScreen = vi.fn()
    const source = botChatComposerSource({ id: 'bot-1', ceiling: 'ask' }, openScreen, () => state)
    await source.bot?.manage('skills')
    expect(api.fleetTakeover).toHaveBeenCalledTimes(1)
    state = 'human'
    await source.bot?.manage('mcp')
    expect(api.fleetTakeover).toHaveBeenCalledTimes(1)
    expect(api.fleetUiOpen.mock.calls).toEqual([
      ['bot-1', { target: 'skills' }],
      ['bot-1', { target: 'mcp' }],
    ])
    expect(openScreen).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })

  it('keeps the bot source stable across status and usage updates', () => {
    const composer = sourceFile('fleet/BotComposer.tsx')
    // A source rebuilt on every `bot.updated` event would reload commands over the network several times a second.
    expect(composer).toMatch(/\[bot\.id, bot\.ceiling\]\s*\)/)
    expect(composer).not.toMatch(/botChatComposerSource\([^)]*\), \[bot\]\)/)
  })

  it('uses the desktop composer and menu controls with skill, prompt, and project commands', () => {
    const composer = sourceFile('fleet/BotComposer.tsx')
    for (const component of [
      'ChatComposer',
      'ChatPlusMenu',
      'ChatSkillsMenu',
      'ChatModelChip',
      'ChatPermModePicker',
      'ChatReasoningPicker',
      'FastModeChip',
      'ChatMicButton',
    ])
      expect(composer).toContain(`<${component}`)
    expect(composer).not.toContain('<select')
    expect(composer).not.toContain('<Select')
    expect(composer).toContain('...result.skills.map')
    expect(composer).toContain('...result.prompts.map')
    expect(composer).toContain('...result.project.map')
    expect(composer).toContain('commands={commands}')
    expect(composer).toContain('onPickCommand=')
  })
})
