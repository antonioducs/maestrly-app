import * as memorySearch from '../../src/main/memory/search'
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
import { archiveLocalMemory, createLocalMemory, getLocalMemory } from '../../src/main/memory/local-memory-service'
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

it('keeps building the memory core when a host extras provider misses the budget', async () => {
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
  setMemoryCoreExtras(conversation.id, () => new Promise(() => {}))
  try {
    const started = Date.now()
    const turn = await prepareTurnMemory({ conversationId: conversation.id, text: 'hello there friend' })
    expect(Date.now() - started).toBeLessThan(3_000)
    turn.commit()
    expect(memoryCoreForPrompt(conversation.id)).toContain('## Pinned memories')
    expect(memoryCoreForPrompt(conversation.id)).not.toContain('## About your owner')
  } finally {
    clearMemoryCoreExtras(conversation.id)
  }
}, 5_000)

it('caps the complete recall block and accounts only for rendered hits', async () => {
  const workspace = makeWorkspace()
  const conversation = makeConversation(workspace.id)
  const hits = Array.from({ length: 3 }, (_, i) => {
    const memory = createLocalMemory({
      workspaceId: workspace.id,
      title: `Staging SSH ${i} ${'long title '.repeat(20)}`,
      content: `Staging SSH ${i} ${'details '.repeat(70)}`,
      type: 'reference',
      source: 'user',
    }).memory
    return {
      kind: 'local' as const,
      id: memory.id,
      type: memory.type,
      title: memory.title,
      snippet: memory.content.slice(0, 400),
      relevance: 1,
      pinned: false,
    }
  })
  vi.spyOn(memorySearch, 'searchMemorySpace').mockResolvedValue(hits)
  const turn = await prepareTurnMemory({ conversationId: conversation.id, text: 'staging ssh port?' })
  const part = turn.hiddenParts.find((part) => part.type === 'file' && part.name === MEMORY_RECALL_PART)
  if (part?.type !== 'file' || part.kind !== 'text') throw new Error('Missing recall')
  const data = part.data ?? ''
  expect(data.length).toBeLessThanOrEqual(1_400)
  expect(data).toMatch(/<\/maestrly-memory>$/)
  const rendered = hits.filter((hit) => data.includes(hit.id.slice(0, 8))).map((hit) => hit.id)
  expect(rendered).toHaveLength(2)
  expect(turn.memoryContext?.sources.map((source) => source.id)).toEqual(rendered)
  turn.commit()
  expect(getConversationMemoryState(conversation.id)?.recalledIds).toEqual(rendered)
  for (const hit of hits) expect(getLocalMemory(workspace.id, hit.id)?.useCount).toBe(rendered.includes(hit.id) ? 1 : 0)
})

it('does not account for recall hits dropped at the hit limit', async () => {
  const workspace = makeWorkspace()
  const conversation = makeConversation(workspace.id)
  const hits = Array.from({ length: 4 }, (_, i) => {
    const memory = createLocalMemory({
      workspaceId: workspace.id,
      title: `Staging SSH ${i}`,
      content: `Port ${2222 + i}.`,
      type: 'reference',
      source: 'user',
    }).memory
    return {
      kind: 'local' as const,
      id: memory.id,
      type: memory.type,
      title: memory.title,
      snippet: memory.content,
      relevance: 1,
      pinned: false,
    }
  })
  vi.spyOn(memorySearch, 'searchMemorySpace').mockResolvedValue(hits)
  const turn = await prepareTurnMemory({ conversationId: conversation.id, text: 'staging ssh port?' })
  expect(turn.memoryContext?.sources.map((source) => source.id)).toEqual(hits.slice(0, 3).map((hit) => hit.id))
  turn.commit()
  expect(getConversationMemoryState(conversation.id)?.recalledIds).not.toContain(hits[3].id)
  expect(getLocalMemory(workspace.id, hits[3].id)?.useCount).toBe(0)
})

import { insertConversation } from '../../src/main/store'
import { restartDb } from '../helpers/db'
import { PERSONAL_MEMORY_SPACE_ID } from '../../src/shared/memory'
import { memorySpaceForConversation, isPersonalMemoryConversation } from '../../src/main/memory/spaces'
import {
  DEFAULT_PERSONAL_MEMORY_SETTINGS,
  setPersonalMemorySettings,
} from '../../src/main/memory/personal-memory-settings'
import { forgetLocalMemory, updateLocalMemory } from '../../src/main/memory/local-memory-service'
import { exportLocalMemoryData } from '../../src/main/memory/memory-center-service'
import { reconcileMemoryIndex, getMemoryIndexStatus } from '../../src/main/memory/index'

function personalChat(id = randomUUID()) {
  insertConversation({
    id,
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    cwd: '/tmp/synthetic-chat',
    name: 'Chat',
    status: 'idle',
    createdAt: 1,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 1,
  })
  return id
}
function personalEntry(content = 'Use the synthetic staging SSH port 2222.') {
  return createLocalMemory({
    workspaceId: PERSONAL_MEMORY_SPACE_ID,
    title: 'Staging SSH port',
    content,
    type: 'reference',
    source: 'user',
  }).memory
}
function partText(turn: Awaited<ReturnType<typeof prepareTurnMemory>>) {
  return turn.hiddenParts.map((part) => (part.type === 'file' && part.kind === 'text' ? part.data : '')).join('\n')
}
it('invalidates personal pinned evidence after another chat corrects or archives it', async () => {
  const id = personalChat()
  const entry = personalEntry('Prefer concise explanations.')
  updateLocalMemory(PERSONAL_MEMORY_SPACE_ID, entry.id, { pinned: true })
  ;(await prepareTurnMemory({ conversationId: id, text: '/skip' })).commit()
  updateLocalMemory(PERSONAL_MEMORY_SPACE_ID, entry.id, { content: 'Prefer detailed explanations.' })
  const corrected = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  expect(partText(corrected)).toContain('Updated:')
  expect(partText(corrected)).toContain('Prefer detailed explanations.')
  corrected.commit()
  archiveLocalMemory(PERSONAL_MEMORY_SPACE_ID, entry.id)
  const archived = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  expect(partText(archived)).toContain('No longer valid')
  archived.commit()
  expect(memoryCoreForPrompt(id)).not.toContain('Prefer detailed explanations.')
})
it('shares personal memory between chats while isolating project and bot spaces', async () => {
  const a = personalChat(),
    b = personalChat()
  personalEntry()
  const project = makeConversation(makeWorkspace().id)
  expect(memorySpaceForConversation(a)).toEqual({ id: PERSONAL_MEMORY_SPACE_ID, kind: 'personal', roots: [] })
  expect(memorySpaceForConversation(b)).toEqual(memorySpaceForConversation(a))
  expect(memorySpaceForConversation(project.id)?.kind).toBe('workspace')
  registerConversationMemorySpace(b, { id: 'bot-self:synthetic', kind: 'bot' })
  registeredConversations.push(b)
  expect(isPersonalMemoryConversation(b)).toBe(false)
  expect(memorySpaceForConversation(b)?.kind).toBe('bot')
})
it('persists catalog deletion updates only after admission and survives restart', async () => {
  const id = personalChat()
  const entry = personalEntry()
  ;(await prepareTurnMemory({ conversationId: id, text: '/skip' })).commit()
  forgetLocalMemory(PERSONAL_MEMORY_SPACE_ID, entry.id)
  const abandoned = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  expect(partText(abandoned)).toContain('No longer valid')
  restartDb()
  const admitted = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  expect(partText(admitted)).toContain('No longer valid')
  admitted.commit()
  expect(partText(await prepareTurnMemory({ conversationId: id, text: '/skip' }))).not.toContain('No longer valid')
})
it('delivers corrections and re-recalls changed entries, preserving a concurrent newer admission', async () => {
  const id = personalChat()
  const entry = personalEntry()
  ;(await prepareTurnMemory({ conversationId: id, text: 'staging ssh port?' })).commit()
  const stale = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  updateLocalMemory(PERSONAL_MEMORY_SPACE_ID, entry.id, { content: 'Synthetic staging SSH port is now 3333.' })
  const corrected = await prepareTurnMemory({ conversationId: id, text: 'staging ssh port?' })
  expect(partText(corrected)).toContain('3333')
  expect(names(corrected.hiddenParts)).toContain(MEMORY_RECALL_PART)
  corrected.commit()
  const baseline = getConversationMemoryState(id)
  stale.commit()
  expect(getConversationMemoryState(id)).toEqual(baseline)
})
it('revalidates personal access and cancellation at commit', async () => {
  const id = personalChat()
  personalEntry()
  const controller = new AbortController()
  const cancelled = await prepareTurnMemory({ conversationId: id, text: '/skip', signal: controller.signal })
  controller.abort()
  cancelled.commit()
  expect(getConversationMemoryState(id)).toBeUndefined()
  const disabled = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  setPersonalMemorySettings({ ...DEFAULT_PERSONAL_MEMORY_SETTINGS, enabled: false })
  disabled.commit()
  expect(getConversationMemoryState(id)).toBeUndefined()
  expect(memoryCoreForPrompt(id)).toBe('')
})
it('indexes and exports every entry beyond the 500-row page boundary with textual fallback', async () => {
  for (let i = 0; i < 501; i++) personalEntry(`Synthetic entry ${i}`)
  await reconcileMemoryIndex(PERSONAL_MEMORY_SPACE_ID, [])
  expect((await getMemoryIndexStatus(PERSONAL_MEMORY_SPACE_ID)).localDocuments).toBe(501)
  expect(JSON.parse(exportLocalMemoryData(PERSONAL_MEMORY_SPACE_ID).json).memories).toHaveLength(501)
})

import { FLEET_BOT_ENV } from '@maestrly/bot-fleet-protocol'
import { initMemoryIndexService, searchMemoryIndexLexical } from '../../src/main/memory/index'
it('excludes unregistered runtime chats even when personal memory is enabled', () => {
  const id = personalChat()
  vi.stubEnv(FLEET_BOT_ENV.mode, '1')
  try {
    expect(isPersonalMemoryConversation(id)).toBe(false)
    expect(memorySpaceForConversation(id)).toBeNull()
  } finally {
    vi.unstubAllEnvs()
  }
})
it('keeps previously recalled entries across compaction and emits archive and supersession updates', async () => {
  const id = personalChat()
  const entry = personalEntry()
  ;(await prepareTurnMemory({ conversationId: id, text: 'staging ssh port?' })).commit()
  compact(id)
  archiveLocalMemory(PERSONAL_MEMORY_SPACE_ID, entry.id)
  const archived = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  expect(partText(archived)).toContain('No longer valid')
  archived.commit()
  const second = personalEntry('Synthetic replacement port 4444')
  compact(id)
  ;(await prepareTurnMemory({ conversationId: id, text: '/skip' })).commit()
  createLocalMemory({
    workspaceId: PERSONAL_MEMORY_SPACE_ID,
    title: 'Replacement',
    content: 'Port 5555',
    type: 'reference',
    source: 'user',
    supersedesId: second.id,
  })
  const superseded = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  expect(partText(superseded)).toContain('No longer valid')
})
it('disables the personal index independently and keeps textual fallback after re-enabling', async () => {
  personalEntry()
  initMemoryIndexService()
  await reconcileMemoryIndex(PERSONAL_MEMORY_SPACE_ID, [])
  setPersonalMemorySettings({ ...DEFAULT_PERSONAL_MEMORY_SETTINGS, enabled: false })
  expect((await getMemoryIndexStatus(PERSONAL_MEMORY_SPACE_ID)).state).toBe('disabled')
  expect(await searchMemoryIndexLexical(PERSONAL_MEMORY_SPACE_ID, 'staging', [])).toEqual([])
  setPersonalMemorySettings(DEFAULT_PERSONAL_MEMORY_SETTINGS)
  expect(await searchMemoryIndexLexical(PERSONAL_MEMORY_SPACE_ID, 'staging', [])).toHaveLength(1)
})
it('discards prepared personal context when disabled during a pending recall', async () => {
  const id = personalChat()
  personalEntry()
  let finish!: (hits: Awaited<ReturnType<typeof memorySearch.searchMemorySpace>>) => void
  vi.spyOn(memorySearch, 'searchMemorySpace').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = prepareTurnMemory({ conversationId: id, text: 'staging ssh port?' })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  setPersonalMemorySettings({ ...DEFAULT_PERSONAL_MEMORY_SETTINGS, enabled: false })
  finish([])
  const turn = await pending
  expect(turn.hiddenParts).toEqual([])
  turn.commit()
  expect(getConversationMemoryState(id)).toBeUndefined()
})

it('retains recall tracking from both concurrent admitted turns', async () => {
  const id = personalChat()
  const first = personalEntry('Synthetic first recall'),
    second = personalEntry('Synthetic second recall')
  const hit = (memory: typeof first) => ({
    kind: 'local' as const,
    id: memory.id,
    title: memory.title,
    type: memory.type,
    relevance: 1,
    snippet: memory.content,
    pinned: false,
  })
  vi.spyOn(memorySearch, 'searchMemorySpace')
    .mockResolvedValueOnce([hit(first)])
    .mockResolvedValueOnce([hit(second)])
  const a = await prepareTurnMemory({ conversationId: id, text: 'first synthetic recall?' })
  const b = await prepareTurnMemory({ conversationId: id, text: 'second synthetic recall?' })
  b.commit()
  a.commit()
  expect(getConversationMemoryState(id)?.recalledIds).toEqual(expect.arrayContaining([first.id, second.id]))
})
it('admits the personal core without tracking a recall that exceeds the time budget', async () => {
  const id = personalChat()
  personalEntry()
  vi.spyOn(memorySearch, 'searchMemorySpace').mockImplementation(() => new Promise(() => {}))
  const turn = await prepareTurnMemory({ conversationId: id, text: 'staging ssh port?' })
  expect(turn.hiddenParts).toEqual([])
  turn.commit()
  expect(getConversationMemoryState(id)?.recalledIds).toEqual([])
  expect(memoryCoreForPrompt(id)).toContain('Staging SSH port')
}, 5000)

it('tracks a recalled entry deleted while recall was pending', async () => {
  const id = personalChat()
  const entry = personalEntry()
  for (let i = 0; i < 45; i++)
    createLocalMemory({
      workspaceId: PERSONAL_MEMORY_SPACE_ID,
      title: `Catalog ${i}`,
      content: `Synthetic catalog ${i}`,
      type: 'reference',
      source: 'user',
      importance: 100,
    })
  let finish!: (hits: Awaited<ReturnType<typeof memorySearch.searchMemorySpace>>) => void
  vi.spyOn(memorySearch, 'searchMemorySpace').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = prepareTurnMemory({ conversationId: id, text: 'staging ssh port?' })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  forgetLocalMemory(PERSONAL_MEMORY_SPACE_ID, entry.id)
  finish([
    {
      kind: 'local',
      id: entry.id,
      title: entry.title,
      type: entry.type,
      relevance: 1,
      snippet: entry.content,
      pinned: false,
      updatedAt: entry.updatedAt,
    },
  ])
  ;(await pending).commit()
  const next = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  expect(partText(next)).toContain('No longer valid')
})

it('refreshes an empty personal catalog on the next unrelated admission without recall', async () => {
  const a = personalChat(),
    b = personalChat()
  setPersonalMemorySettings({ ...DEFAULT_PERSONAL_MEMORY_SETTINGS, autoRecall: false })
  ;(await prepareTurnMemory({ conversationId: a, text: 'hi' })).commit()
  createLocalMemory({
    workspaceId: PERSONAL_MEMORY_SPACE_ID,
    title: 'Prefers tea',
    content: 'The user prefers tea.',
    type: 'preference',
    source: 'user',
    originConversationId: b,
  })
  ;(await prepareTurnMemory({ conversationId: a, text: 'ok' })).commit()
  expect(memoryCoreForPrompt(a)).toContain('Prefers tea')
  expect(memoryCoreForPrompt(a)).not.toContain('Save durable decisions')
})

it('invalidates every supplied personal entry on the first admission when updates overflow', async () => {
  const id = personalChat()
  const entries = Array.from({ length: 12 }, (_, i) => personalEntry(`Old ${i} ${'a'.repeat(650)}`))
  ;(await prepareTurnMemory({ conversationId: id, text: '/skip' })).commit()
  for (const entry of entries)
    updateLocalMemory(PERSONAL_MEMORY_SPACE_ID, entry.id, { content: `Corrected ${entry.id} ` + 'b'.repeat(650) })
  const turn = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  expect(partText(turn)).toContain('all earlier personal memory')
  expect(partText(turn).length).toBeLessThanOrEqual(1500)
  turn.commit()
  expect(partText(await prepareTurnMemory({ conversationId: id, text: '/skip' }))).toBe('')
})

it('refreshes personal catalog order and removals within its budget without dropping delivered evidence', async () => {
  const id = personalChat()
  const first = personalEntry('The user prefers tea.')
  ;(await prepareTurnMemory({ conversationId: id, text: '/skip' })).commit()
  const newer = Array.from(
    { length: 45 },
    (_, i) =>
      createLocalMemory({
        workspaceId: PERSONAL_MEMORY_SPACE_ID,
        title: `New preference ${i}`,
        content: `User preference ${i}.`,
        type: 'preference',
        source: 'user',
        importance: 100,
      }).memory
  )
  ;(await prepareTurnMemory({ conversationId: id, text: '/skip' })).commit()
  expect(memoryCoreForPrompt(id)).not.toContain(first.title)
  expect(memoryCoreForPrompt(id).split('## Memory catalog')[1].length).toBeLessThan(1800)
  updateLocalMemory(PERSONAL_MEMORY_SPACE_ID, first.id, { content: 'The user prefers coffee.' })
  const changed = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  expect(partText(changed)).toContain('prefers coffee')
  changed.commit()
  for (const memory of newer) archiveLocalMemory(PERSONAL_MEMORY_SPACE_ID, memory.id)
  const removed = await prepareTurnMemory({ conversationId: id, text: '/skip' })
  expect(partText(removed).length).toBeLessThanOrEqual(1500)
  removed.commit()
  expect(memoryCoreForPrompt(id)).toContain(first.title)
  expect(memoryCoreForPrompt(id)).not.toContain('New preference')
})
