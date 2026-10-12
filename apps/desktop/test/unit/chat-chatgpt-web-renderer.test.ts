import { afterEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import {
  type ChatGptWebCompanionLifecycleApi,
  companionHookPlugins,
  companionStartError,
  openChatGptWebAppSettings,
  startChatGptWebCompanion,
} from '../../src/renderer/lib/chatgpt-web'
import { addHookNotice, type HookNoticeItem } from '../../src/renderer/components/chat/HookNotices'
import { resources } from '../../src/shared/i18n/resources'
import {
  applyNormalAttention,
  applyChatGptTurnCompleted,
  attentionFor,
  clearChatGptAttention,
  clearConversationAttention,
  reconcileChatGptAttention,
  type AgentAttentionState,
} from '../../src/renderer/lib/use-agent-statuses'

afterEach(() => vi.unstubAllGlobals())

/** The host members a case stubs; the flow must not need the others. */
const lifecycleApi = (members: Record<string, unknown>) => members as unknown as ChatGptWebCompanionLifecycleApi

describe('shared companion enablement flow', () => {
  it('starts sessions, copies prompts and opens matching views', async () => {
    const start = vi.fn(async () => ({ ok: true, kickoff: 'prompt-seguro', pairingRequired: true }))
    const open = vi.fn(async () => ({ ok: true }))
    const copy = vi.fn(async () => ({ ok: true }))
    const api = lifecycleApi({
      chatGptWebCompanionStart: start,
      chatGptWebCompanionCopyPrompt: copy,
      chatGptWebCompanionOpen: open,
    })

    await expect(startChatGptWebCompanion('conv-1', api)).resolves.toEqual({ pairingRequired: true, promptCopied: true })
    expect(start).toHaveBeenCalledWith('conv-1')
    expect(copy).toHaveBeenCalledWith('conv-1')
    expect(open).toHaveBeenCalledWith('conv-1')
  })

  it('resumes paired conversations without copying again', async () => {
    const copy = vi.fn()
    const open = vi.fn(async () => ({ ok: true }))
    const api = lifecycleApi({
      chatGptWebCompanionStart: vi.fn(async () => ({
        ok: true,
        kickoff: 'prompt-seguro',
        pairingRequired: false,
      })),
      chatGptWebCompanionCopyPrompt: copy,
      chatGptWebCompanionOpen: open,
    })

    await expect(startChatGptWebCompanion('conv-resume', api)).resolves.toEqual({
      pairingRequired: false,
      promptCopied: true,
    })
    expect(copy).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('conv-resume')
  })

  it('opens ChatGPT after clipboard failure and leaves UI retry available', async () => {
    const open = vi.fn(async () => ({ ok: true }))
    const api = lifecycleApi({
      chatGptWebCompanionStart: vi.fn(async () => ({
        ok: true,
        kickoff: 'prompt-seguro',
        pairingRequired: true,
      })),
      chatGptWebCompanionCopyPrompt: vi.fn(async () => ({ ok: false, error: 'clipboard-failed' })),
      chatGptWebCompanionOpen: open,
    })

    await expect(startChatGptWebCompanion('conv-copy-fail', api)).resolves.toEqual({
      pairingRequired: true,
      promptCopied: false,
    })
    expect(open).toHaveBeenCalledWith('conv-copy-fail')
  })

  it('does not open views when session start fails', async () => {
    const open = vi.fn()
    const api = lifecycleApi({
      chatGptWebCompanionStart: vi.fn(async () => ({ ok: false, error: 'not-configured' })),
      chatGptWebCompanionOpen: open,
    })
    await expect(startChatGptWebCompanion('conv-2', api)).rejects.toThrow('not-configured')
    expect(open).not.toHaveBeenCalled()
  })
})

describe('ChatGPT Web app upgrade action', () => {
  const status = {
    configured: true,
    appRefreshRequired: true,
    probeActive: false,
    sessions: [],
  }

  it('arms probes before opening app pages without sessions', async () => {
    const order: string[] = []
    const probeStart = vi.fn(async () => {
      order.push('probe-start')
      return { ok: true }
    })
    const openExternalUrl = vi.fn(async () => {
      order.push('open-external-url')
    })

    await openChatGptWebAppSettings(
      status,
      { chatGptWebProbeStart: probeStart, openExternalUrl },
      'https://chatgpt.com/plugins'
    )

    expect(order).toEqual(['probe-start', 'open-external-url'])
  })

  it('does not open pages after probe failure', async () => {
    const probeStart = vi.fn(async () => ({ ok: false, error: 'probe-unavailable' }))
    const openExternalUrl = vi.fn(async () => undefined)

    await expect(
      openChatGptWebAppSettings(
        status,
        { chatGptWebProbeStart: probeStart, openExternalUrl },
        'https://chatgpt.com/plugins'
      )
    ).rejects.toThrow('probe-unavailable')
    expect(openExternalUrl).not.toHaveBeenCalled()
  })
})

describe('companion sidebar attention', () => {
  const empty = (): AgentAttentionState => ({ normalAttention: new Set(), companionAttention: new Set() })

  it('marks attention when other conversations complete', () => {
    const next = applyChatGptTurnCompleted(empty(), 'conv-a', 'conv-b')
    expect(attentionFor(next)).toEqual(new Set(['conv-a']))
  })

  it('clears companion attention when entering conversations', () => {
    let state = applyChatGptTurnCompleted(empty(), 'conv-a', null)
    state = clearConversationAttention(state, 'conv-a')
    expect(attentionFor(state)).toEqual(new Set())
  })

  it('avoids badges for visible ChatGPT and clears them on return', () => {
    expect(attentionFor(applyChatGptTurnCompleted(empty(), 'conv-a', 'conv-a'))).toEqual(new Set())
    const pending = applyChatGptTurnCompleted(empty(), 'conv-a', null)
    expect(attentionFor(clearChatGptAttention(pending, 'conv-a'))).toEqual(new Set())
  })

  it('prefers main visibility state over local heuristics', () => {
    const next = reconcileChatGptAttention(empty(), 'conv-a', false, 'conv-a')

    expect(attentionFor(next)).toEqual(new Set(['conv-a']))
  })

  it('preserves badges while modals suppress native surfaces', () => {
    const pending = applyChatGptTurnCompleted(empty(), 'conv-a', null)
    const next = reconcileChatGptAttention(pending, 'conv-a', false, 'conv-a')

    expect(next.companionAttention).toEqual(new Set(['conv-a']))
  })

  it('clears only companion attention when other attention exists', () => {
    let state = applyChatGptTurnCompleted(empty(), 'conv-a', null)
    state = applyNormalAttention(state, 'conv-a')

    const next = clearChatGptAttention(state, 'conv-a')

    expect(next.normalAttention).toEqual(new Set(['conv-a']))
    expect(next.companionAttention).toEqual(new Set())
    expect(attentionFor(next)).toEqual(new Set(['conv-a']))
  })

  it('clears all attention on conversation entry', () => {
    let state = applyChatGptTurnCompleted(empty(), 'conv-a', null)
    state = applyNormalAttention(state, 'conv-a')

    const next = clearConversationAttention(state, 'conv-a')

    expect(next.normalAttention).toEqual(new Set())
    expect(next.companionAttention).toEqual(new Set())
    expect(attentionFor(next)).toEqual(new Set())
  })
})

describe('plugin hooks and the companion', () => {
  it('names the plugins whose turn hooks keep the companion from starting', async () => {
    expect(companionHookPlugins('companion-hooks-unsupported: notes, guard')).toEqual(['notes', 'guard'])
    expect(companionHookPlugins('session-not-found')).toBeNull()

    const i18n = i18next.createInstance()
    await i18n.init({ lng: 'en', resources, interpolation: { escapeValue: false } })
    const t = i18n.getFixedT('en', 'ui')
    expect(companionStartError('companion-hooks-unsupported: notes', t)).toMatch(/^notes runs hooks/)
    expect(companionStartError('companion-hooks-unsupported: notes, guard', t)).toMatch(/^notes, guard run hooks/)
    expect(companionStartError('session-not-found', t)).toBe('session-not-found')
  })

  it('keeps only the latest hook notices above the composer', () => {
    const notice = (id: number): HookNoticeItem => ({ id, plugin: 'p', event: 'Stop', text: `n${id}`, level: 'info' })
    const shown = [1, 2, 3, 4].reduce<HookNoticeItem[]>((current, id) => addHookNotice(current, notice(id)), [])
    expect(shown.map((item) => item.id)).toEqual([2, 3, 4])
  })
})
