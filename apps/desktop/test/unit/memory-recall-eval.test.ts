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
import { createLocalMemory } from '../../src/main/memory/local-memory-service'
import { retrieveHybridMemory } from '../../src/main/memory/retrieval'
import { searchMemorySpace } from '../../src/main/memory/search'
import { renderRecall } from '../../src/main/memory/turn-memory'
import { EVAL_MEMORIES, EVAL_QUERIES } from '../fixtures/memory-eval'
import { makeWorkspace } from '../helpers/factories'

interface Tally {
  returned: number
  relevantReturned: number
  positives: number
  positivesFound: number
  negatives: number
  negativesInjected: number
  chars: number
  turns: number
}
const empty = (): Tally => ({
  returned: 0,
  relevantReturned: 0,
  positives: 0,
  positivesFound: 0,
  negatives: 0,
  negativesInjected: 0,
  chars: 0,
  turns: 0,
})

describe('memory recall evaluation (text-only)', () => {
  it('beats the current memory_search path on precision and noise, within the per-turn budget', async () => {
    const workspace = makeWorkspace()
    const ids = new Map<string, string>()
    for (const memory of EVAL_MEMORIES)
      ids.set(
        memory.key,
        createLocalMemory({
          workspaceId: workspace.id,
          title: memory.title,
          content: memory.content,
          type: memory.type,
          pinned: memory.pinned,
          source: 'user',
        }).memory.id
      )
    const pinned = new Set(EVAL_MEMORIES.filter((memory) => memory.pinned).map((memory) => ids.get(memory.key)!))
    const space = { id: workspace.id, kind: 'workspace' as const, roots: [] }
    const old = empty()
    const recall = empty()
    for (const item of EVAL_QUERIES) {
      const relevant = new Set(item.relevant.map((key) => ids.get(key)!))
      const before = await retrieveHybridMemory({
        workspaceId: workspace.id,
        query: item.query,
        roots: [],
        limit: 5,
        maxChars: 8 * 1024,
      })
      const after = await searchMemorySpace(space, item.query, { mode: 'recall', limit: 3, excludeIds: pinned })
      const tally = (target: Tally, returned: string[], chars: number, satisfiedByCore: boolean) => {
        target.turns += 1
        target.chars += chars
        target.returned += returned.length
        target.relevantReturned += returned.filter((id) => relevant.has(id)).length
        if (relevant.size) {
          target.positives += 1
          if (satisfiedByCore || returned.some((id) => relevant.has(id))) target.positivesFound += 1
        } else {
          target.negatives += 1
          if (returned.length) target.negativesInjected += 1
        }
      }
      tally(
        old,
        before.map((hit) => hit.id),
        JSON.stringify(before).length,
        false
      )
      tally(
        recall,
        after.map((hit) => hit.id),
        after.length ? renderRecall(after).length : 0,
        [...relevant].some((id) => pinned.has(id))
      )
    }
    const report = (t: Tally) => ({
      precision: t.returned ? +(t.relevantReturned / t.returned).toFixed(2) : 1,
      recallAt3: +(t.positivesFound / t.positives).toFixed(2),
      falseInjection: +(t.negativesInjected / t.negatives).toFixed(2),
      charsPerTurn: Math.round(t.chars / t.turns),
    })
    const table = { 'memory_search today (top 5)': report(old), 'host recall (floor, ≤3)': report(recall) }
    console.table(table)
    const next = report(recall)
    expect(next.precision).toBeGreaterThanOrEqual(0.8)
    expect(next.recallAt3).toBeGreaterThanOrEqual(0.6)
    expect(next.falseInjection).toBeLessThanOrEqual(0.1)
    expect(next.charsPerTurn).toBeLessThanOrEqual(1_400)
    expect(next.falseInjection).toBeLessThan(report(old).falseInjection)
  })
})
