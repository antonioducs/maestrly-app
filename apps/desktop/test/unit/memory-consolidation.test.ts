import { getDb } from '../../src/main/store/db'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { CONSOLIDATION_LIMITS, maybeConsolidate } from '../../src/main/memory/extraction/consolidation'
import {
  createLocalMemory,
  getLocalMemory,
  listLocalMemories,
  updateLocalMemory,
} from '../../src/main/memory/local-memory-service'
import { incrementAutoCreated, getConsolidationState } from '../../src/main/store/memory-extraction-state'
import { deleteLocalMemorySpace } from '../../src/main/store/local-memories'
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

it('writes nothing when it is cancelled while the model runs, even after its space was deleted', async () => {
  const f = fixture()
  incrementAutoCreated(f.space.id, 15)
  const controller = new AbortController()
  let signal: AbortSignal | undefined
  const oneShot = vi.fn(async (input: { signal: AbortSignal }) => {
    signal = input.signal
    // The bot is purged while the provider, ignoring the abort, still answers.
    controller.abort()
    deleteLocalMemorySpace(f.space.id)
    return f.oneShot()
  })
  expect(await maybeConsolidate({ ...f, oneShot, signal: controller.signal })).toEqual({ merges: 0 })
  expect(signal?.aborted).toBe(true)
  expect(listLocalMemories(f.space.id)).toEqual([])
  expect(getConsolidationState(f.space.id)).toBeUndefined()
})

it('frees the space for a new run once a run is cancelled, and the late answer never frees the new one', async () => {
  const f = fixture()
  incrementAutoCreated(f.space.id, 15)
  const merged = JSON.stringify({
    merges: [{ ids: f.ids, type: 'decision', title: 'Combined', content: 'One and two.' }],
  })
  /** A provider call that ignores its abort signal and answers only when the test says so. */
  const late = () => {
    let answer: (() => void) | null = null
    let signal: AbortSignal | undefined
    const oneShot = vi.fn(
      (input: { signal: AbortSignal }) =>
        new Promise<{ text: string; usage: { input: number; output: number; cacheRead: number; cacheCreate: number } }>(
          (resolve) => {
            signal = input.signal
            answer = () => resolve({ text: merged, usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } })
          }
        )
    )
    return { oneShot, answer: () => answer?.(), signal: () => signal }
  }
  const controller = new AbortController()
  const old = late()
  const first = maybeConsolidate({ ...f, oneShot: old.oneShot, signal: controller.signal })
  await vi.waitFor(() => expect(old.oneShot).toHaveBeenCalledOnce())
  // The bot is removed while its provider runs, then created again: its next run starts before the old one answers.
  controller.abort()
  expect(old.signal()?.aborted).toBe(true)
  const next = late()
  const second = maybeConsolidate({ ...f, oneShot: next.oneShot })
  await vi.waitFor(() => expect(next.oneShot).toHaveBeenCalledOnce())

  // The old answer arrives late: it writes nothing and leaves the new run's place taken.
  old.answer()
  expect(await first).toEqual({ merges: 0 })
  for (const id of f.ids) expect(getLocalMemory(f.space.id, id)?.status).toBe('active')
  expect(await maybeConsolidate(f)).toEqual({ merges: 0 })
  expect(f.oneShot).not.toHaveBeenCalled()

  next.answer()
  expect(await second).toEqual({ merges: 1 })
  for (const id of f.ids) expect(getLocalMemory(f.space.id, id)?.status).toBe('superseded')
  expect(getConsolidationState(f.space.id)).toMatchObject({ autoCreatedSince: 0, lastRunAt: f.now })
  // Both provider calls are billed, the late one included.
  expect(
    getDb().prepare("SELECT * FROM chat_usage_ledger WHERE message_id LIKE 'memory-consolidation:%'").all()
  ).toHaveLength(2)
  // Once the new run ends, the space is free again.
  createLocalMemory({ workspaceId: f.space.id, title: 'Three', content: 'Three', type: 'decision', source: 'auto' })
  incrementAutoCreated(f.space.id, 15)
  await maybeConsolidate({ ...f, now: f.now + CONSOLIDATION_LIMITS.intervalMs })
  expect(f.oneShot).toHaveBeenCalledOnce()
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

const usage = { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 }

it('never merges procedures or what the person or the agent saved', async () => {
  const space = { id: makeWorkspace().id, kind: 'workspace' as const, roots: [] }
  const conversation = makeConversation(space.id)
  const make = (title: string, type: 'procedure' | 'decision', source: 'auto' | 'user' | 'agent') =>
    createLocalMemory({ workspaceId: space.id, title, content: `${title} body`, type, source }).memory.id
  const procedure = make('Render', 'procedure', 'auto')
  const user = make('User rule', 'decision', 'user')
  const agent = make('Agent rule', 'decision', 'agent')
  const auto = make('Auto rule', 'decision', 'auto')
  const other = make('Auto rule two', 'decision', 'auto')
  incrementAutoCreated(space.id, 15)
  let prompt = ''
  const oneShot = vi.fn(async (input: { prompt: string }) => {
    prompt = input.prompt
    return {
      text: JSON.stringify({
        merges: [
          { ids: [procedure, auto], type: 'decision', title: 'A', content: 'Render body and Auto rule body' },
          { ids: [user, other], type: 'decision', title: 'B', content: 'User rule body and Auto rule two body' },
          { ids: [agent, other], type: 'decision', title: 'C', content: 'Agent rule body and Auto rule two body' },
          { ids: [auto, other], type: 'procedure', title: 'D', content: 'Auto rule body and Auto rule two body' },
        ],
      }),
      usage,
    }
  })
  const input = { space, conversationId: conversation.id, cwd: conversation.cwd, now: 1000, oneShot }
  expect(await maybeConsolidate({ ...input, selection: { providerId: 'test', modelId: 'test' } })).toEqual({
    merges: 0,
  })
  // Only automatic, non-procedure entries are shown to the model.
  expect(prompt).toContain(auto)
  expect(prompt).toContain(other)
  for (const id of [procedure, user, agent]) expect(prompt).not.toContain(id)
  for (const id of [procedure, user, agent, auto, other]) expect(getLocalMemory(space.id, id)?.status).toBe('active')
})

it('keeps line breaks in its input and inherits importance, tags, scope and origin', async () => {
  const f = fixture()
  const steps = 'Steps:\n1. ffmpeg -i in.mov -r 30 out.mp4\n2. Upload it.'
  updateLocalMemory(f.space.id, f.ids[0], { content: steps, importance: 40, tags: ['video'], scope: 'ads' })
  updateLocalMemory(f.space.id, f.ids[1], { content: 'Upload it.', importance: 75, tags: ['upload'], scope: 'ads' })
  incrementAutoCreated(f.space.id, 15)
  const oneShot = vi.fn(async (input: { prompt: string; system: string }) => {
    const lines = input.prompt.split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines.find((line) => line.includes(f.ids[0]))!)).toMatchObject({ content: steps, new: true })
    expect(input.system).toContain('"new":true')
    return {
      text: JSON.stringify({
        merges: [{ ids: f.ids, type: 'decision', title: 'Video', content: `${steps}\n3. Done.` }],
      }),
      usage,
    }
  })
  expect(await maybeConsolidate({ ...f, oneShot })).toEqual({ merges: 1 })
  const merged = listLocalMemories(f.space.id, { status: 'active' })[0]
  expect(merged).toMatchObject({
    content: `${steps}\n3. Done.`,
    importance: 75,
    tags: ['upload', 'video'],
    scope: 'ads',
    source: 'auto',
    originConversationId: getLocalMemory(f.space.id, f.ids[0])!.originConversationId ?? f.conversationId,
  })
})

it('drops the scope when the originals disagree on it', async () => {
  const f = fixture()
  updateLocalMemory(f.space.id, f.ids[0], { scope: 'a' })
  updateLocalMemory(f.space.id, f.ids[1], { scope: 'b' })
  incrementAutoCreated(f.space.id, 15)
  expect(await maybeConsolidate(f)).toEqual({ merges: 1 })
  expect(listLocalMemories(f.space.id, { status: 'active' })[0].scope).toBe('')
})

it('rejects a merge that shortens its longest original', async () => {
  const f = fixture()
  updateLocalMemory(f.space.id, f.ids[0], { content: `Step one ${'detail '.repeat(40)}` })
  incrementAutoCreated(f.space.id, 15)
  expect(await maybeConsolidate(f)).toEqual({ merges: 0 })
  for (const id of f.ids) expect(getLocalMemory(f.space.id, id)?.status).toBe('active')
})

it('merges a merged entry again only together with something new', async () => {
  const f = fixture()
  incrementAutoCreated(f.space.id, 15)
  expect(await maybeConsolidate(f)).toEqual({ merges: 1 })
  const merged = listLocalMemories(f.space.id, { status: 'active' })[0]
  // An entry from before the last run, and the last run's own merge: neither is new.
  const old = createLocalMemory({
    workspaceId: f.space.id,
    title: 'Three',
    content: 'One and two, three.',
    type: 'decision',
    source: 'auto',
  }).memory
  getDb()
    .prepare('UPDATE local_memories SET created_at = ? WHERE id = ?')
    .run(f.now - 1, old.id)
  incrementAutoCreated(f.space.id, 15)
  const later = { ...f, now: f.now + CONSOLIDATION_LIMITS.intervalMs }
  const again = vi.fn(async () => ({
    text: JSON.stringify({
      merges: [{ ids: [merged.id, old.id], type: 'decision', title: 'All', content: 'One and two, three.' }],
    }),
    usage,
  }))
  expect(await maybeConsolidate({ ...later, oneShot: again })).toEqual({ merges: 0 })
  // With nothing new, the model is not even asked.
  expect(again).not.toHaveBeenCalled()
  expect(getLocalMemory(f.space.id, merged.id)?.status).toBe('active')

  // Something extracted since then makes a merge with it possible.
  const fresh = createLocalMemory({
    workspaceId: f.space.id,
    title: 'Four',
    content: 'One and two, four.',
    type: 'decision',
    source: 'auto',
  }).memory
  incrementAutoCreated(f.space.id, 15)
  const third = vi.fn(async (input: { prompt: string }) => {
    const shown = input.prompt.split('\n').map((line) => JSON.parse(line) as { id: string; new: boolean })
    expect(shown.find((entry) => entry.id === merged.id)?.new).toBe(false)
    expect(shown.find((entry) => entry.id === fresh.id)?.new).toBe(true)
    return {
      text: JSON.stringify({
        merges: [
          { ids: [merged.id, old.id], type: 'decision', title: 'Old', content: 'One and two, three.' },
          { ids: [merged.id, fresh.id], type: 'decision', title: 'New', content: 'One and two, then four.' },
        ],
      }),
      usage,
    }
  })
  expect(
    await maybeConsolidate({ ...later, now: later.now + CONSOLIDATION_LIMITS.intervalMs, oneShot: third })
  ).toEqual({ merges: 1 })
  expect(getLocalMemory(f.space.id, old.id)?.status).toBe('active')
  expect(getLocalMemory(f.space.id, fresh.id)?.status).toBe('superseded')
})

it('forgets what its last run created when the space is deleted', async () => {
  const f = fixture()
  incrementAutoCreated(f.space.id, 15)
  await maybeConsolidate(f)
  const key = `memory.consolidation.products.${f.space.id}`
  expect(getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key)).toBeDefined()
  deleteLocalMemorySpace(f.space.id)
  expect(getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key)).toBeUndefined()
})
