import { getDb } from '../../src/main/store/db'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { maybeConsolidate } from '../../src/main/memory/extraction/consolidation'
import {
  createLocalMemory,
  getLocalMemory,
  listLocalMemories,
  updateLocalMemory,
} from '../../src/main/memory/local-memory-service'
import { incrementAutoCreated, getConsolidationState } from '../../src/main/store/memory-extraction-state'
vi.mock('../../src/main/local-ml/embedding-service', () => ({
  embedTexts: vi.fn(async () => null),
  trackEmbeddingWrite: <T>(p: Promise<T>) => p,
}))
vi.mock('../../src/main/runtime-assets/app-service', () => ({
  ensureRuntimeAsset: vi.fn(),
  readyRuntimeAsset: vi.fn(async () => {
    throw Error('Unavailable in test')
  }),
  acquireRuntimeAssetLease: vi.fn(),
}))
beforeEach(freshDb)
afterEach(closeDb)
function fixture(pinned = false) {
  const space = { id: makeWorkspace().id, kind: 'workspace' as const, roots: [] }
  const conversation = makeConversation(space.id)
  const ids = ['One', 'Two'].map(
    (title, index) =>
      createLocalMemory({
        workspaceId: space.id,
        title,
        content: title,
        type: 'decision',
        source: 'auto',
        pinned: pinned && index === 0,
      }).memory.id
  )
  const oneShot = vi.fn(async () => ({
    text: JSON.stringify({ merges: [{ ids, type: 'decision', title: 'Combined', content: 'One and two.' }] }),
    usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 },
  }))
  return {
    space,
    conversationId: conversation.id,
    cwd: conversation.cwd,
    selection: { providerId: 'test', modelId: 'test' },
    now: 1000,
    oneShot,
    ids,
  }
}
it('skips fewer than fifteen new memories', async () => {
  const f = fixture()
  incrementAutoCreated(f.space.id, 14)
  expect(await maybeConsolidate(f)).toEqual({ merges: 0 })
  expect(f.oneShot).not.toHaveBeenCalled()
})
it('merges active memories and supersedes both originals', async () => {
  const f = fixture()
  incrementAutoCreated(f.space.id, 15)
  expect(await maybeConsolidate(f)).toEqual({ merges: 1 })
  for (const id of f.ids) expect(getLocalMemory(f.space.id, id)?.status).toBe('superseded')
  expect(listLocalMemories(f.space.id, { status: 'active' })[0]).toMatchObject({
    title: 'Combined',
    supersedesId: f.ids[0],
  })
})
it('skips pinned and missing targets', async () => {
  const f = fixture(true)
  incrementAutoCreated(f.space.id, 15)
  expect(await maybeConsolidate(f)).toEqual({ merges: 0 })
  const g = fixture()
  g.ids[1] = 'missing'
  incrementAutoCreated(g.space.id, 15)
  expect(await maybeConsolidate(g)).toEqual({ merges: 0 })
})
it('resets the count and limits runs to once daily', async () => {
  const f = fixture()
  incrementAutoCreated(f.space.id, 15)
  await maybeConsolidate(f)
  expect(getConsolidationState(f.space.id)?.autoCreatedSince).toBe(0)
  incrementAutoCreated(f.space.id, 15)
  expect(await maybeConsolidate({ ...f, now: 2000 })).toEqual({ merges: 0 })
  expect(f.oneShot).toHaveBeenCalledTimes(1)
})
it('does not supersede originals when the merged content is already saved', async () => {
  const f = fixture()
  createLocalMemory({
    workspaceId: f.space.id,
    title: 'Combined',
    content: 'One and two.',
    type: 'decision',
    source: 'user',
  })
  incrementAutoCreated(f.space.id, 15)
  expect(await maybeConsolidate(f)).toEqual({ merges: 0 })
  for (const id of f.ids) expect(getLocalMemory(f.space.id, id)?.status).toBe('active')
})

it('accounts for the consolidation model call', async () => {
  const f = fixture()
  incrementAutoCreated(f.space.id, 15)
  await maybeConsolidate(f)
  expect(
    getDb().prepare("SELECT * FROM chat_usage_ledger WHERE message_id LIKE 'memory-consolidation:%'").all()
  ).toHaveLength(1)
})
it('serializes consolidation calls for the same space', async () => {
  const f = fixture()
  incrementAutoCreated(f.space.id, 15)
  let finish!: () => void
  const oneShot = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { text: '{"merges":[]}', usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } }
  })
  const first = maybeConsolidate({ ...f, oneShot })
  const second = maybeConsolidate(f)
  finish()
  await first
  await second
  expect(f.oneShot).not.toHaveBeenCalled()
})

it('sends complete contents within the input budget and rejects unsent ids', async () => {
  const f = fixture()
  const content = `Beginning ${'x'.repeat(1000)} UNIQUE END`
  updateLocalMemory(f.space.id, f.ids[0], { content })
  incrementAutoCreated(f.space.id, 15)
  const oneShot = vi.fn(async (input: { prompt: string }) => {
    expect(input.prompt).toContain(content)
    expect(input.prompt.length).toBeLessThanOrEqual(48_000)
    return { text: '{"merges":[]}', usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } }
  })
  await maybeConsolidate({ ...f, oneShot })
})

it('rejects ids excluded from the full-content budget', async () => {
  const f = fixture()
  for (const id of f.ids) updateLocalMemory(f.space.id, id, { content: `${id} ${'x'.repeat(30000)}` })
  incrementAutoCreated(f.space.id, 15)
  expect(await maybeConsolidate(f)).toEqual({ merges: 0 })
  for (const id of f.ids) expect(getLocalMemory(f.space.id, id)?.status).toBe('active')
})

it('skips targets edited while the model is running', async () => {
  const f = fixture()
  incrementAutoCreated(f.space.id, 15)
  const oneShot = async () => {
    getDb().prepare('UPDATE local_memories SET updated_at = updated_at + 1000 WHERE id = ?').run(f.ids[0])
    return f.oneShot()
  }
  expect(await maybeConsolidate({ ...f, oneShot })).toEqual({ merges: 0 })
  for (const id of f.ids) expect(getLocalMemory(f.space.id, id)?.status).toBe('active')
})

it('rolls back the whole merge when superseding a target fails', async () => {
  const f = fixture()
  incrementAutoCreated(f.space.id, 15)
  getDb().exec(
    `CREATE TRIGGER fail_merge BEFORE UPDATE OF status ON local_memories WHEN OLD.id = '${f.ids[1]}' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`
  )
  await expect(maybeConsolidate(f)).rejects.toThrow('synthetic failure')
  for (const id of f.ids) expect(getLocalMemory(f.space.id, id)?.status).toBe('active')
  expect(listLocalMemories(f.space.id)).toHaveLength(2)
})
