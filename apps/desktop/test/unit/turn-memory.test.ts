import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
const runtime = vi.hoisted(() => ({
  ensure: vi.fn(async () => ({ state: 'ready' })),
  ready: vi.fn(async () => {
    throw new Error('local ML runtime intentionally unavailable in textual fallback tests')
  }),
  acquire: vi.fn(),
  embed: vi.fn(async () => null as number[][] | null),
}))

vi.mock('../../src/main/runtime-assets/app-service', () => ({
  ensureRuntimeAsset: runtime.ensure,
  readyRuntimeAsset: runtime.ready,
  acquireRuntimeAssetLease: runtime.acquire,
}))

vi.mock('../../src/main/local-ml/embedding-service', () => ({
  embedTexts: runtime.embed,
  trackEmbeddingWrite: <T>(operation: Promise<T>) => operation,
}))

let root = ''
let userData = ''

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-memory-index-'))
  userData = path.join(root, 'user-data')
  mkdirSync(userData)
  vi.spyOn(app, 'getPath').mockReturnValue(userData)
  runtime.ready.mockClear()
  runtime.ensure.mockClear()
  runtime.acquire.mockClear()
  runtime.embed.mockClear()
  freshDb()
})

afterEach(() => {
  disposeMemoryIndexService()
  closeDb()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

import { disposeMemoryIndexService } from '../../src/main/memory/index'
import { randomUUID } from 'node:crypto'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { memoryCoreForPrompt, setMemoryCoreExtras, clearMemoryCoreExtras } from '../../src/main/memory/core'
import { archiveLocalMemory, createLocalMemory } from '../../src/main/memory/local-memory-service'
import { setWorkspaceMemoryEnabled } from '../../src/main/memory/access'
import {
  BOT_MEMORY_SPACE_ID,
  clearConversationMemorySpace,
  registerConversationMemorySpace,
} from '../../src/main/memory/spaces'
import { MEMORY_RECALL_PART, MEMORY_UPDATES_PART, prepareTurnMemory } from '../../src/main/memory/turn-memory'
import { setAppSetting } from '../../src/main/store/app-settings'
import { getConversationMemoryState } from '../../src/main/store/conversation-memory-state'
import { makeConversation, makeWorkspace } from '../helpers/factories'

function compact(conversationId: string, strategy?: 'codex-native') {
  const id = randomUUID()
  upsertChatMessage({
    id: randomUUID(),
    conversationId,
    role: 'assistant',
    createdAt: Date.now(),
    parts: [{ type: 'compaction', id, text: 'summary', ...(strategy ? { strategy } : {}) }],
  })
  return id
}
const names = (parts: Array<{ type: string; name?: string }>) => parts.map((part) => part.name)

const registeredConversations: string[] = []
afterEach(() => {
  for (const id of registeredConversations.splice(0)) {
    clearMemoryCoreExtras(id)
    clearConversationMemorySpace(id)
  }
})

describe('turn memory', () => {
  it('freezes a core, recalls relevant memories once per epoch, and skips unrelated messages', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    createLocalMemory({
      workspaceId: workspace.id,
      title: 'Commit style',
      content: 'Conventional commits.',
      type: 'constraint',
      source: 'user',
      pinned: true,
    })
    const deploy = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Production deploy uses blue-green',
      content: 'Switch traffic from blue to green after the health check.',
      type: 'decision',
      source: 'user',
    }).memory
    const first = await prepareTurnMemory({
      conversationId: conversation.id,
      text: 'how does the production deploy switch blue and green?',
    })
    expect(names(first.hiddenParts)).toEqual([MEMORY_RECALL_PART])
    expect(first.memoryContext?.sources.map((source) => source.id)).toEqual([deploy.id])
    first.commit()
    expect(memoryCoreForPrompt(conversation.id)).toContain('## Pinned memories')
    expect(memoryCoreForPrompt(conversation.id)).toContain('Production deploy uses blue-green')
    const again = await prepareTurnMemory({
      conversationId: conversation.id,
      text: 'and the production deploy blue green again?',
    })
    expect(again.hiddenParts).toEqual([])
    again.commit()
    expect(
      (await prepareTurnMemory({ conversationId: conversation.id, text: 'tell me a joke about cats' })).hiddenParts
    ).toEqual([])
  })

  it('rebuilds the core after a portable compaction and resets recall after any compaction', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    createLocalMemory({
      workspaceId: workspace.id,
      title: 'Staging SSH port 2222',
      content: 'Staging SSH only on port 2222.',
      type: 'reference',
      source: 'user',
    })
    ;(await prepareTurnMemory({ conversationId: conversation.id, text: 'staging ssh port?' })).commit()
    const nativeId = compact(conversation.id, 'codex-native')
    const afterNative = await prepareTurnMemory({ conversationId: conversation.id, text: 'staging ssh port?' })
    expect(names(afterNative.hiddenParts)).toEqual([MEMORY_RECALL_PART])
    afterNative.commit()
    expect(getConversationMemoryState(conversation.id)).toMatchObject({ coreEpoch: '', recallEpoch: nativeId })
    const portableId = compact(conversation.id)
    ;(await prepareTurnMemory({ conversationId: conversation.id, text: 'hello there friend' })).commit()
    expect(getConversationMemoryState(conversation.id)?.coreEpoch).toBe(portableId)
  })

  it('sends pinned changes as an update block, and rebuilds the core when the change is large', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    const pinned = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Old rule',
      content: 'Old.',
      type: 'constraint',
      source: 'user',
      pinned: true,
    }).memory
    ;(await prepareTurnMemory({ conversationId: conversation.id, text: 'hello there friend' })).commit()
    archiveLocalMemory(workspace.id, pinned.id)
    createLocalMemory({
      workspaceId: workspace.id,
      title: 'New rule',
      content: 'New.',
      type: 'constraint',
      source: 'user',
      pinned: true,
    })
    const updates = await prepareTurnMemory({ conversationId: conversation.id, text: 'hello there friend' })
    expect(names(updates.hiddenParts)).toEqual([MEMORY_UPDATES_PART])
    updates.commit()
    for (let i = 0; i < 3; i++)
      createLocalMemory({
        workspaceId: workspace.id,
        title: `Big ${i}`,
        content: `${i} ${'b'.repeat(650)}`,
        type: 'lesson',
        source: 'user',
        pinned: true,
      })
    const rebuilt = await prepareTurnMemory({ conversationId: conversation.id, text: 'hello there friend' })
    expect(rebuilt.hiddenParts).toEqual([])
    rebuilt.commit()
    expect(memoryCoreForPrompt(conversation.id)).toContain('Big 2')
  })

  it('uses host extras for bots and keeps the baseline when extras are unavailable', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    registeredConversations.push(conversation.id)
    registerConversationMemorySpace(conversation.id, { id: BOT_MEMORY_SPACE_ID, kind: 'bot' })
    let entries = [{ id: 'om-1', text: 'Prefer short answers.' }]
    let available = true
    setMemoryCoreExtras(conversation.id, async () =>
      available ? [{ key: 'owner', heading: 'About your owner', intro: 'Shared.', entries, budgetChars: 4_000 }] : null
    )
    ;(await prepareTurnMemory({ conversationId: conversation.id, text: 'hello there friend' })).commit()
    expect(memoryCoreForPrompt(conversation.id)).toContain('- [om-1] Prefer short answers.')
    available = false
    expect(
      (await prepareTurnMemory({ conversationId: conversation.id, text: 'hello there friend' })).hiddenParts
    ).toEqual([])
    available = true
    entries = []
    const removed = await prepareTurnMemory({ conversationId: conversation.id, text: 'hello there friend' })
    expect(String((removed.hiddenParts[0] as { data?: string }).data)).toContain('No longer valid')
    clearMemoryCoreExtras(conversation.id)
    clearConversationMemorySpace(conversation.id)
  })

  it('does nothing when memory is disabled, and recall can be switched off', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    createLocalMemory({
      workspaceId: workspace.id,
      title: 'Staging SSH port 2222',
      content: 'Port 2222.',
      type: 'reference',
      source: 'user',
    })
    setAppSetting('chat.memory', JSON.stringify({ autoRecall: false, extraction: { enabled: false, selection: null } }))
    const off = await prepareTurnMemory({ conversationId: conversation.id, text: 'staging ssh port?' })
    expect(off.hiddenParts).toEqual([])
    off.commit()
    expect(memoryCoreForPrompt(conversation.id)).toContain('# Memory')
    setWorkspaceMemoryEnabled(workspace.id, false)
    expect(memoryCoreForPrompt(conversation.id)).toBe('')
    expect(
      (await prepareTurnMemory({ conversationId: conversation.id, text: 'staging ssh port?' })).hiddenParts
    ).toEqual([])
  })
})

it('admits a turn when a host extras provider ignores cancellation', async () => {
  const workspace = makeWorkspace()
  const conversation = makeConversation(workspace.id)
  const controller = new AbortController()
  setMemoryCoreExtras(conversation.id, () => new Promise(() => {}))
  try {
    const pending = prepareTurnMemory({
      conversationId: conversation.id,
      text: 'staging ssh port?',
      signal: controller.signal,
    })
    controller.abort()
    expect((await pending).hiddenParts).toEqual([])
  } finally {
    clearMemoryCoreExtras(conversation.id)
  }
}, 200)
