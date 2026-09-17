import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ModelMetaCatalogue } from '../src/main/model-meta'

/** A small slice of a real models.dev response. */
const sample = { openai: { models: { 'gpt-5': { id: 'gpt-5', limit: { context: 400000, output: 128000 }, cost: { input: 1.25, output: 10, cache_read: 0.125 } } } } }
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'model-meta-'))
  directories.push(dir)
  return dir
}

it('parses the catalogue once, keeps it on disk and serves it from memory within a day', async () => {
  const dir = await directory()
  let calls = 0
  let clock = 1_000
  const catalogue = new ModelMetaCatalogue(dir, async () => (calls++, sample), () => clock)
  const first = await catalogue.current()
  expect(first['openai/gpt-5']).toMatchObject({ contextWindow: 400000, inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.125 })
  clock += 60 * 60 * 1000
  await catalogue.current()
  expect(calls).toBe(1)
  expect(JSON.parse(await readFile(join(dir, 'models-dev.json'), 'utf8')).meta['openai/gpt-5'].contextWindow).toBe(400000)
})

it('serves yesterday\'s numbers when the network is gone, and nothing when there never were any', async () => {
  const dir = await directory()
  const online = new ModelMetaCatalogue(dir, async () => sample, () => 1_000)
  await online.current()
  // A new process, a day later, without network: the disk copy is what it has.
  const offline = new ModelMetaCatalogue(dir, async () => { throw new Error('offline') }, () => 1_000 + 25 * 60 * 60 * 1000)
  expect((await offline.current())['openai/gpt-5']?.contextWindow).toBe(400000)
  const never = new ModelMetaCatalogue(await directory(), async () => { throw new Error('offline') })
  expect(await never.current()).toEqual({})
})

it('meters the last finished turn against the window the guest reported, and prices the page', async () => {
  const { contextMeter, metaForModel } = await import('../src/renderer/features/chat/useContextMeter')
  const catalogue = { 'openai/gpt-5': { contextWindow: 400000, inputPer1M: 1, outputPer1M: 10 } }
  const at = '2026-09-17T00:00:00.000Z'
  const turn = (id: string, finishedAt: string, usage: Record<string, number>) => ({ id, botId: 'b', conversationId: 'c', messageId: 'm', status: 'succeeded' as const, generation: 1, revision: 1, createdAt: at, updatedAt: at, finishedAt, usage, model: { model: 'gpt-5', source: 'recommended' as const } })
  const turns = [turn('t1', '2026-09-17T00:01:00.000Z', { inputTokens: 1_000_000, outputTokens: 0 }), turn('t2', '2026-09-17T00:02:00.000Z', { inputTokens: 60_000, outputTokens: 100_000, contextTokens: 50_000, modelContextWindow: 200_000 })]
  const result = contextMeter(turns, catalogue, 'gpt-5')
  expect(result.usage).toMatchObject({ contextInput: 50_000 })
  expect(result.meta?.contextWindow).toBe(200_000)
  // $1 for the first turn's input, $0.06 + $1 for the second.
  expect(result.cost).toBeCloseTo(2.06, 5)
  expect(metaForModel(catalogue, 'gpt-5')).toBe(catalogue['openai/gpt-5'])
  expect(metaForModel(catalogue, 'unknown')).toBeNull()
  expect(contextMeter([], {}, 'gpt-5')).toEqual({ usage: null, meta: null, cost: null })
})
