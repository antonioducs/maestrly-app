import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../../../helpers/db'
import { makeConversation, makeWorkspace } from '../../../helpers/factories'
import { insertConversation, setAppSetting } from '../../../../src/main/store'
import { upsertChatMessage } from '../../../../src/main/chat/chat-store'
import {
  createLocalMemory,
  getLocalMemory,
  listLocalMemories,
  updateLocalMemory,
} from '../../../../src/main/memory/local-memory-service'
import { setPersonalMemorySettings } from '../../../../src/main/memory/personal-memory-settings'
import { getExtractionState, incrementAutoCreated } from '../../../../src/main/store/memory-extraction-state'
import {
  disposeMemoryExtraction,
  resolveExtractionSelection,
  scheduleMemoryExtraction,
  runMemoryExtraction,
} from '../../../../src/main/memory/extraction/scheduler'
import { maybeConsolidate } from '../../../../src/main/memory/extraction/consolidation'
import { applyExtraction } from '../../../../src/main/memory/extraction/apply'
vi.mock('../../../../src/main/chat/one-shot-text', () => ({ runOneShotText: vi.fn() }))
vi.mock('../../../../src/main/local-ml/embedding-service', () => ({
  embedTexts: vi.fn(async () => null),
  trackEmbeddingWrite: <T>(p: Promise<T>) => p,
}))
vi.mock('../../../../src/main/runtime-assets/app-service', () => ({
  ensureRuntimeAsset: vi.fn(),
  readyRuntimeAsset: vi.fn(async () => {
    throw Error('Unavailable in test')
  }),
  acquireRuntimeAssetLease: vi.fn(),
}))
const selection = { providerId: 'test', modelId: 'personal', effort: 'off', fastMode: false }
const space = { id: 'personal-chat', kind: 'personal' as const, roots: [] }
const settings = { enabled: true, autoRecall: true, extraction: { enabled: true, selection } }
const item = {
  action: 'create' as const,
  type: 'preference' as const,
  title: 'Answers',
  content: 'Prefer concise answers.',
  source: { messageId: 'human-1' },
}
const answer = (memories = [item]) => ({
  text: JSON.stringify({ memories }),
  usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 },
})
let conversationId: string
beforeEach(() => {
  freshDb()
  setPersonalMemorySettings(settings)
  const project = makeConversation(makeWorkspace().id)
  conversationId = 'personal-conversation'
  insertConversation({
    ...project,
    id: conversationId,
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    repos: undefined,
  })
  upsertChatMessage({
    id: 'human-1',
    conversationId,
    role: 'user',
    createdAt: 1,
    parts: [{ type: 'text', id: 'text-1', text: 'I prefer concise answers. '.repeat(80) }],
  })
  upsertChatMessage({
    id: 'assistant-1',
    conversationId,
    role: 'assistant',
    createdAt: 2,
    parts: [{ type: 'text', id: 'text-2', text: 'Invented preference. '.repeat(80) }],
  })
})
afterEach(() => {
  disposeMemoryExtraction()
  vi.useRealTimers()
  closeDb()
})
it('selects personal extraction independently from workspace settings', () => {
  setAppSetting('chat.memory', JSON.stringify({ autoRecall: false, extraction: { enabled: false, selection: null } }))
  expect(resolveExtractionSelection(conversationId)).toEqual(selection)
})
it('keeps actual user provenance and resumes the saved cursor after disposal', async () => {
  const oneShot = vi.fn(async () => answer())
  expect(await runMemoryExtraction(conversationId, undefined, { oneShot })).toBe('done')
  expect(listLocalMemories(space.id)[0]).toMatchObject({
    originMessageId: 'human-1',
    originConversationId: conversationId,
  })
  const cursor = getExtractionState(conversationId)?.lastSeq
  disposeMemoryExtraction()
  expect(await runMemoryExtraction(conversationId, undefined, { oneShot })).toBe('too-little')
  expect(getExtractionState(conversationId)?.lastSeq).toBe(cursor)
  expect(oneShot).toHaveBeenCalledTimes(1)
})
it('rejects assistant and missing references even when the provider proposes them', async () => {
  const oneShot = vi.fn(async () => answer([{ ...item, source: { messageId: 'assistant-1' } }]))
  await runMemoryExtraction(conversationId, undefined, { oneShot })
  expect(listLocalMemories(space.id)).toEqual([])
})
it.each(['memory', 'extraction'])('disabling %s during the provider wait discards writes and cursor', async (kind) => {
  const oneShot = vi.fn(async () => {
    setPersonalMemorySettings(
      kind === 'memory'
        ? { ...settings, enabled: false }
        : { ...settings, extraction: { ...settings.extraction, enabled: false } }
    )
    setPersonalMemorySettings(settings)
    return answer()
  })
  expect(await runMemoryExtraction(conversationId, undefined, { oneShot })).toBe('cancelled')
  expect(listLocalMemories(space.id)).toEqual([])
  expect(getExtractionState(conversationId)).toBeUndefined()
})
it('serializes concurrent replacement and discards the stale second result', async () => {
  const target = createLocalMemory({
    workspaceId: space.id,
    title: 'Old',
    content: 'Old preference',
    type: 'preference',
    source: 'user',
  }).memory
  const snapshots = new Map([[target.id, target]])
  const input = { space, conversationId, originMessageId: 'human-1', userMessageIds: new Set(['human-1']), snapshots }
  const results = await Promise.all(
    ['First', 'Second'].map((title) =>
      applyExtraction({
        ...input,
        output: { memories: [{ ...item, action: 'supersede', id: target.id, title, content: title }], owner: [] },
      })
    )
  )
  expect(results.map((result) => result.superseded)).toEqual([1, 0])
  expect(results[1].rejected).toBe(1)
})
it('rejects a changed target even if its timestamp stayed the same', async () => {
  const target = createLocalMemory({
    workspaceId: space.id,
    title: 'Old',
    content: 'Old preference',
    type: 'preference',
    source: 'user',
  }).memory
  updateLocalMemory(space.id, target.id, { content: 'Edited preference' })
  const current = getLocalMemory(space.id, target.id)!
  const result = await applyExtraction({
    space,
    conversationId,
    originMessageId: 'human-1',
    userMessageIds: new Set(['human-1']),
    snapshots: new Map([[target.id, { ...target, updatedAt: current.updatedAt }]]),
    output: { memories: [{ ...item, action: 'supersede', id: target.id }], owner: [] },
  })
  expect(result.rejected).toBe(1)
  expect(getLocalMemory(space.id, target.id)?.content).toBe('Edited preference')
})
it('discards consolidation when personal extraction becomes disabled', async () => {
  const ids = ['One', 'Two'].map(
    (content) =>
      createLocalMemory({ workspaceId: space.id, title: content, content, type: 'preference', source: 'user' }).memory
        .id
  )
  incrementAutoCreated(space.id, 15)
  const oneShot = vi.fn(async () => {
    setPersonalMemorySettings({ ...settings, enabled: false })
    setPersonalMemorySettings(settings)
    return {
      ...answer(),
      text: JSON.stringify({ merges: [{ ids, type: 'preference', title: 'Merged', content: 'Merged preference' }] }),
    }
  })
  expect(await maybeConsolidate({ space, conversationId, selection, cwd: '/tmp', now: 1000, oneShot })).toEqual({
    merges: 0,
  })
  setPersonalMemorySettings(settings)
  expect(listLocalMemories(space.id, { status: 'active' })).toHaveLength(2)
})

it('drops scheduled personal work when extraction is disabled and reenabled', async () => {
  vi.useFakeTimers()
  const run = vi.fn(async () => {})
  scheduleMemoryExtraction(conversationId, undefined, { run })
  setPersonalMemorySettings({ ...settings, extraction: { ...settings.extraction, enabled: false } })
  setPersonalMemorySettings(settings)
  await vi.advanceTimersByTimeAsync(180_000)
  expect(run).not.toHaveBeenCalled()
  expect(getExtractionState(conversationId)).toBeUndefined()
})
it('rejects operations without a source and protects pinned targets and duplicates', async () => {
  const target = createLocalMemory({
    workspaceId: space.id,
    title: item.title,
    content: item.content,
    type: 'preference',
    source: 'user',
    pinned: true,
  }).memory
  const { source: _source, ...withoutSource } = item
  const result = await applyExtraction({
    space,
    conversationId,
    originMessageId: 'assistant-1',
    userMessageIds: new Set(['human-1']),
    snapshots: new Map([[target.id, target]]),
    output: {
      memories: [withoutSource, { ...item, action: 'supersede', id: target.id, content: 'Changed' }, item],
      owner: [],
    },
  })
  expect(result).toEqual({ created: 0, superseded: 0, owner: 0, rejected: 2 })
  expect(listLocalMemories(space.id)).toHaveLength(1)
  expect(getLocalMemory(space.id, target.id)).toMatchObject({ pinned: true, status: 'active', content: item.content })
})
