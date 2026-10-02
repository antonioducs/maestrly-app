import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { upsertChatMessage, getMessageSeq } from '../../src/main/chat/chat-store'
import { patchConvUiPrefs, insertConversation } from '../../src/main/store'
import type { ChatGptWebCapabilityScope, ChatMode, MessagePart } from '../../src/shared/chat'
import { createPersonalMemoryAdapter } from '../../src/main/chat/chatgpt-web/personal-memory'
import { createChatGptWebBridge } from '../../src/main/chat/chatgpt-web/bridge-server'
import { buildCompanionPrompt, createChatGptWebSession } from '../../src/main/chat/chatgpt-web/session'
import {
  getCompanionConversationContext,
  searchCompanionConversation,
  readCompanionConversation,
  companionConversationVisibleText,
} from '../../src/main/chat/chatgpt-web/conversation-context'
import {
  PERSONAL_MEMORY_SPACE_ID,
  registerConversationMemorySpace,
  clearConversationMemorySpace,
} from '../../src/main/memory/spaces'
import { createLocalMemory, getLocalMemory, listLocalMemories } from '../../src/main/memory/local-memory-service'
import { readPersonalMemorySettings, setPersonalMemorySettings } from '../../src/main/memory/personal-memory-settings'
import { EXTRACTION_LIMITS } from '../../src/main/memory/extraction/prompt'
import { disposeMemoryExtraction, type ExtractionDeps } from '../../src/main/memory/extraction/scheduler'
import { getExtractionState } from '../../src/main/store/memory-extraction-state'
import { disposeMemoryIndexService } from '../../src/main/memory/index'

vi.mock('../../src/main/local-ml/embedding-service', () => ({
  embedTexts: vi.fn(async () => null),
  trackEmbeddingWrite: <T>(operation: Promise<T>) => operation,
}))
vi.mock('../../src/main/runtime-assets/app-service', () => ({
  ensureRuntimeAsset: vi.fn(async () => ({ state: 'unavailable' })),
  readyRuntimeAsset: vi.fn(async () => {
    throw new Error('unavailable in synthetic tests')
  }),
  acquireRuntimeAssetLease: vi.fn(),
}))

let root: string
let conversationId: string
let access: ChatGptWebCapabilityScope
let mode: ChatMode
let sessionCurrent: boolean
const authorizeWrite = vi.fn(async (_toolName: string, _signal?: AbortSignal) => {})

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'companion-personal-'))
  mkdirSync(path.join(root, 'profile'))
  vi.spyOn(app, 'getPath').mockReturnValue(path.join(root, 'profile'))
  freshDb()
  conversationId = randomUUID()
  insertConversation({
    id: conversationId,
    scope: 'standalone',
    experience: 'standard',
    workspaceId: null,
    branch: null,
    mode: null,
    isMulti: 0,
    name: 'Synthetic personal chat',
    cwd: root,
    status: 'idle',
    createdAt: Date.now(),
    archived: 0,
    pinnedAt: null,
    lastActivityAt: Date.now(),
  })
  access = 'write'
  mode = 'agent'
  sessionCurrent = true
  authorizeWrite.mockReset()
})

afterEach(() => {
  disposeMemoryExtraction()
  vi.useRealTimers()
  clearConversationMemorySpace(conversationId)
  disposeMemoryIndexService()
  closeDb()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function adapter() {
  return createPersonalMemoryAdapter({
    conversationId,
    access: () => {
      if (!sessionCurrent) throw new Error('personal-memory-session-stale')
      return access
    },
    mode: () => mode,
    authorizeWrite,
  })
}

const entry = { title: 'Preferred language', content: 'Use English in release notes.', type: 'preference' }
function data(result: unknown) {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)
}

describe('Companion personal memory', () => {
  it('shares the native local store in both directions and never chooses a model scope', async () => {
    const native = createLocalMemory({
      ...entry,
      type: 'preference',
      workspaceId: PERSONAL_MEMORY_SPACE_ID,
      source: 'user',
    }).memory
    const remote = adapter()
    expect(data(await remote.call({ operation: 'read', arguments: { id: native.id } })).content).toBe(entry.content)
    const saved = data(
      await remote.call({
        operation: 'upsert',
        arguments: { ...entry, title: 'Writing style', content: 'Prefer concise release notes.' },
      })
    ).memory
    expect(getLocalMemory(PERSONAL_MEMORY_SPACE_ID, saved.id)?.content).toBe('Prefer concise release notes.')
    const found = data(await remote.call({ operation: 'search', arguments: { query: 'concise release notes' } }))
    expect(found.results.some((hit: { id: string }) => hit.id === saved.id)).toBe(true)
    expect(authorizeWrite).toHaveBeenCalledWith('memory_upsert', expect.any(AbortSignal))
    expect(data(await remote.call({ operation: 'list', arguments: {} }))).toHaveLength(2)
  })

  it.each(['off', 'read', 'write'] as const)('enforces the %s capability', async (value) => {
    access = value
    const remote = adapter()
    if (value === 'off') {
      await expect(remote.call({ operation: 'list', arguments: {} })).rejects.toThrow('disabled')
    } else {
      expect(data(await remote.call({ operation: 'list', arguments: {} }))).toEqual([])
    }
    if (value !== 'write') {
      await expect(remote.call({ operation: 'upsert', arguments: entry })).rejects.toThrow(
        value === 'off' ? 'disabled' : 'read-only'
      )
      expect(authorizeWrite).not.toHaveBeenCalled()
      expect(listLocalMemories(PERSONAL_MEMORY_SPACE_ID)).toEqual([])
    }
  })

  it.each(['ask', 'plan', 'agent', 'design'] as const)('respects %s mode', async (value) => {
    mode = value
    const write = adapter().call({ operation: 'upsert', arguments: entry })
    if (value === 'ask' || value === 'plan') {
      await expect(write).rejects.toThrow('mode-denied')
      expect(authorizeWrite).not.toHaveBeenCalled()
    } else {
      expect(data(await write).memory.title).toBe(entry.title)
    }
  })

  it.each([
    { operation: 'upsert', arguments: { ...entry, workspaceId: 'other' } },
    { operation: 'upsert', arguments: { ...entry, spaceId: 'other' } },
    { operation: 'list', arguments: { conversationId: 'other' } },
    { operation: 'search', arguments: { query: 'language', limit: 999 } },
    { operation: 'upsert', arguments: { ...entry, pinned: 'yes' } },
    { operation: 'forget', arguments: { id: 'synthetic', confirm: false } },
    { operation: 'forget', arguments: { id: 'synthetic' } },
    { operation: 'promote_to_shared', arguments: {} },
  ])('strictly rejects invalid input $operation', async (input) => {
    await expect(adapter().call(input)).rejects.toThrow()
    expect(authorizeWrite).not.toHaveBeenCalled()
  })

  it('requires deletion confirmation and preserves the native archive/restore lifecycle', async () => {
    const remote = adapter()
    const saved = data(await remote.call({ operation: 'upsert', arguments: entry })).memory
    await remote.call({ operation: 'archive', arguments: { id: saved.id } })
    expect(getLocalMemory(PERSONAL_MEMORY_SPACE_ID, saved.id)?.status).toBe('archived')
    await remote.call({ operation: 'restore', arguments: { id: saved.id } })
    expect(getLocalMemory(PERSONAL_MEMORY_SPACE_ID, saved.id)?.status).toBe('active')
    expect(data(await remote.call({ operation: 'forget', arguments: { id: saved.id, confirm: true } }))).toEqual({
      forgotten: true,
    })
    expect(getLocalMemory(PERSONAL_MEMORY_SPACE_ID, saved.id)).toBeUndefined()
  })

  it.each(['off', 'disabled', 'reenabled', 'mode', 'stale', 'abort', 'denied'])(
    'rechecks %s after permission waits',
    async (reason) => {
      const controller = new AbortController()
      authorizeWrite.mockImplementationOnce(async () => {
        if (reason === 'off') access = 'off'
        if (reason === 'disabled') setPersonalMemorySettings({ ...readPersonalMemorySettings(), enabled: false })
        if (reason === 'reenabled') {
          setPersonalMemorySettings({ ...readPersonalMemorySettings(), enabled: false })
          setPersonalMemorySettings({ ...readPersonalMemorySettings(), enabled: true })
        }
        if (reason === 'mode') mode = 'plan'
        if (reason === 'stale') sessionCurrent = false
        if (reason === 'abort') controller.abort()
        if (reason === 'denied') throw new Error('policy denied')
      })
      await expect(adapter().call({ operation: 'upsert', arguments: entry }, controller.signal)).rejects.toThrow()
      expect(listLocalMemories(PERSONAL_MEMORY_SPACE_ID)).toEqual([])
    }
  )

  it('resolves current persisted access, global disable and bot exclusion in the manager', async () => {
    const { capabilitiesForConversation } = await import('../../src/main/chat/chatgpt-web/manager')
    patchConvUiPrefs(conversationId, {
      chatGptWebCapabilities: {
        personalMemory: 'write',
        memory: 'read',
        conversation: 'off',
        git: 'off',
        gh: 'off',
        browser: 'off',
        mcp: {},
      },
    })
    const enabled = capabilitiesForConversation(conversationId)
    expect(enabled.capabilities).toMatchObject({ personalMemory: 'write', memory: 'off' })
    setPersonalMemorySettings({ ...readPersonalMemorySettings(), enabled: false })
    const disabled = capabilitiesForConversation(conversationId)
    expect(disabled.capabilities.personalMemory).toBe('off')
    expect(disabled.fingerprint).not.toBe(enabled.fingerprint)
    setPersonalMemorySettings({ ...readPersonalMemorySettings(), enabled: true })
    registerConversationMemorySpace(conversationId, { id: 'bot-self:synthetic', kind: 'bot' })
    expect(capabilitiesForConversation(conversationId).capabilities.personalMemory).toBe('off')
  })

  it('rejects a conversation rebound to a bot space', async () => {
    const remote = adapter()
    registerConversationMemorySpace(conversationId, { id: 'bot-self:synthetic', kind: 'bot' })
    await expect(remote.call({ operation: 'list', arguments: {} })).rejects.toThrow('unavailable')
  })

  it('fails closed through the bridge and redacts operation content from diagnostic events', async () => {
    const events: unknown[] = []
    const bridge = createChatGptWebBridge({
      cwd: root,
      conversationScope: 'standalone',
      personalMemory: adapter(),
      onEvent: (event) => events.push(event),
    })
    access = 'off'
    expect((await bridge.callTool('personal_memory', { operation: 'list', arguments: {} })).isError).toBe(true)
    access = 'write'
    const result = await bridge.callTool('personal_memory', { operation: 'upsert', arguments: entry })
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(events)).not.toContain(entry.content)
    bridge.endSession()
    expect((await bridge.callTool('personal_memory', { operation: 'list', arguments: {} })).isError).toBe(true)
  })

  it('cancels pending permission on session end without writing', async () => {
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    authorizeWrite.mockImplementationOnce(
      (_name, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(new Error('session ended')), { once: true })
          entered()
        })
    )
    const bridge = createChatGptWebBridge({
      cwd: root,
      conversationScope: 'standalone',
      personalMemory: adapter(),
    })
    const result = bridge.callTool('personal_memory', { operation: 'upsert', arguments: entry })
    await waiting
    bridge.endSession()
    expect((await result).isError).toBe(true)
    expect(listLocalMemories(PERSONAL_MEMORY_SPACE_ID)).toEqual([])
  })

  it('does not inject memory into standalone context when access is off', async () => {
    access = 'off'
    const projectContext = vi.fn(() => 'synthetic private recalled preference')
    const bridge = createChatGptWebBridge({
      cwd: root,
      conversationScope: 'standalone',
      personalMemory: adapter(),
      projectContext,
    })
    const result = await bridge.callTool('get_context', {})
    expect(JSON.stringify(result)).not.toContain('private recalled')
    expect(projectContext).not.toHaveBeenCalled()
    bridge.endSession()
  })

  it('does not disclose old hidden recall through conversation text or off kickoff', () => {
    const parts: MessagePart[] = [
      { type: 'text', id: 'visible', text: 'Visible local request' },
      {
        type: 'file',
        id: 'recall',
        name: 'maestrly-memory-recall',
        hidden: true,
        kind: 'text',
        mediaType: 'text/markdown',
        data: 'synthetic private recalled preference',
      },
    ]
    expect(companionConversationVisibleText(parts)).toBe('Visible local request')
    const messageId = randomUUID()
    upsertChatMessage({ id: messageId, conversationId, role: 'user', createdAt: Date.now(), parts })
    expect(JSON.stringify(getCompanionConversationContext(conversationId))).not.toContain('private recalled')
    expect(searchCompanionConversation(conversationId, { query: 'private recalled' }).hits).toEqual([])
    expect(
      JSON.stringify(readCompanionConversation(conversationId, { around_seq: getMessageSeq(messageId)! }))
    ).not.toContain('private recalled')
    const kickoff = buildCompanionPrompt({
      scope: 'standalone',
      personalMemory: 'off',
      appName: 'Synthetic',
      sessionKey: 'synthetic',
    })
    expect(kickoff).not.toContain('personal_memory')
    expect(kickoff).not.toContain('private recalled')
  })
})

describe('Companion completion extraction', () => {
  function enableExtraction() {
    setPersonalMemorySettings({
      ...readPersonalMemorySettings(),
      extraction: {
        enabled: true,
        selection: { providerId: 'synthetic', modelId: 'synthetic', effort: 'off', fastMode: false },
      },
    })
  }
  function persistUserText(role: 'user' | 'assistant' = 'user') {
    const id = randomUUID()
    upsertChatMessage({
      id,
      conversationId,
      role,
      createdAt: Date.now(),
      parts: [
        {
          type: 'text',
          id: randomUUID(),
          text: 'I prefer concise English explanations with practical examples. '.repeat(30),
        },
      ],
    })
    return id
  }
  function result(id: string) {
    return {
      text: JSON.stringify({
        memories: [
          {
            action: 'create',
            type: 'preference',
            title: 'Explanation style',
            content: 'Prefer concise English explanations with practical examples.',
            source: { messageId: id },
          },
        ],
        owner: [],
      }),
      usage: { input: 10, output: 2, cacheRead: 0, cacheCreate: 0 },
    }
  }
  async function complete(oneShot: ExtractionDeps['oneShot']) {
    const remote = adapter()
    const session = createChatGptWebSession({
      conversationId,
      cwd: root,
      bridge: { conversationScope: 'standalone' },
      onTurnCompleted: () => remote.scheduleExtraction({ oneShot }),
    })
    await session.bridge.callTool('notify_turn_complete', { idempotency_key: 'synthetic-completion' })
    await vi.advanceTimersByTimeAsync(EXTRACTION_LIMITS.debounceMs)
    session.end()
  }
  it.each(['off', 'read', 'ended', 'ask', 'plan', 'disabled', 'empty', 'assistant', 'short', 'write', 'design'])(
    'extracts persisted user text only with eligible %s authorization',
    async (scenario) => {
      vi.useFakeTimers()
      enableExtraction()
      let id = ''
      if (scenario !== 'empty') id = persistUserText(scenario === 'assistant' ? 'assistant' : 'user')
      if (scenario === 'short')
        upsertChatMessage({
          id,
          conversationId,
          role: 'user',
          createdAt: Date.now(),
          parts: [{ type: 'text', id: randomUUID(), text: 'Hello.' }],
        })
      if (scenario === 'off' || scenario === 'read') access = scenario
      if (scenario === 'ended') sessionCurrent = false
      if (scenario === 'ask' || scenario === 'plan' || scenario === 'design') mode = scenario
      if (scenario === 'disabled')
        setPersonalMemorySettings({ ...readPersonalMemorySettings(), extraction: { enabled: false, selection: null } })
      const oneShot = vi.fn(async () => result(id))
      await complete(oneShot)
      const eligible = scenario === 'write' || scenario === 'design'
      expect(oneShot).toHaveBeenCalledTimes(eligible ? 1 : 0)
      expect(listLocalMemories(PERSONAL_MEMORY_SPACE_ID)).toHaveLength(eligible ? 1 : 0)
    }
  )
  it('does not extract the same local text again on another completion', async () => {
    vi.useFakeTimers()
    enableExtraction()
    const id = persistUserText()
    const oneShot = vi.fn(async () => result(id))
    await complete(oneShot)
    await complete(oneShot)
    expect(oneShot).toHaveBeenCalledTimes(1)
  })
  it.each(['off', 'read', 'ended', 'plan', 'reenabled', 'extraction-reenabled'])(
    'rejects pending extraction after %s revocation',
    async (reason) => {
      vi.useFakeTimers()
      enableExtraction()
      const id = persistUserText()
      const oneShot = vi.fn(async () => result(id))
      adapter().scheduleExtraction({ oneShot })
      if (reason === 'off' || reason === 'read') access = reason
      if (reason === 'ended') sessionCurrent = false
      if (reason === 'plan') mode = 'plan'
      if (reason === 'reenabled') {
        setPersonalMemorySettings({ ...readPersonalMemorySettings(), enabled: false })
        setPersonalMemorySettings({ ...readPersonalMemorySettings(), enabled: true })
      }
      if (reason === 'extraction-reenabled') {
        setPersonalMemorySettings({ ...readPersonalMemorySettings(), extraction: { enabled: false, selection: null } })
        enableExtraction()
      }
      await vi.advanceTimersByTimeAsync(EXTRACTION_LIMITS.debounceMs)
      expect(oneShot).not.toHaveBeenCalled()
      expect(listLocalMemories(PERSONAL_MEMORY_SPACE_ID)).toEqual([])
    }
  )
  it.each(['off', 'read', 'ended', 'plan', 'reenabled'])(
    'discards results revoked by %s during the model wait',
    async (reason) => {
      vi.useFakeTimers()
      enableExtraction()
      const id = persistUserText()
      const oneShot = vi.fn(async () => {
        if (reason === 'off' || reason === 'read') access = reason
        if (reason === 'ended') sessionCurrent = false
        if (reason === 'plan') mode = 'plan'
        if (reason === 'reenabled') {
          setPersonalMemorySettings({ ...readPersonalMemorySettings(), enabled: false })
          setPersonalMemorySettings({ ...readPersonalMemorySettings(), enabled: true })
        }
        return result(id)
      })
      await complete(oneShot)
      expect(oneShot).toHaveBeenCalledTimes(1)
      expect(listLocalMemories(PERSONAL_MEMORY_SPACE_ID)).toEqual([])
      expect(getExtractionState(conversationId)).toBeUndefined()
    }
  )
})
