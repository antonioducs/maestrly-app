import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeWorkspace } from '../helpers/factories'
import { createLocalMemory } from '../../src/main/memory/local-memory-service'
import {
  MEMORY_CORE_LIMITS,
  buildMemoryCore,
  loadMemoryCoreExtras,
  memoryCoreSources,
  renderMemoryDelta,
  setMemoryCoreExtras,
  type MemoryCoreExtraSection,
} from '../../src/main/memory/core'
import type { MemorySpace } from '../../src/main/memory/spaces'

beforeEach(freshDb)
afterEach(closeDb)

const owner = (entries: Array<[string, string]>): MemoryCoreExtraSection => ({
  key: 'owner',
  heading: 'About your owner',
  intro: 'Shared by all of the owner’s bots.',
  entries: entries.map(([id, text]) => ({ id, text, meta: 'Scout · 2026-09-20' })),
  budgetChars: 4_000,
})

describe('memory core', () => {
  it('renders guidance, extras, pinned memories within budget and a ranked catalog', () => {
    const workspace = makeWorkspace()
    const space: MemorySpace = { id: workspace.id, kind: 'workspace', roots: [] }
    createLocalMemory({
      workspaceId: space.id,
      title: 'Never use native select',
      content: 'Use the custom Select.',
      type: 'constraint',
      source: 'user',
      pinned: true,
    })
    createLocalMemory({
      workspaceId: space.id,
      title: 'Staging SSH port',
      content: 'Port 2222.',
      type: 'reference',
      source: 'user',
      importance: 80,
    })
    createLocalMemory({
      workspaceId: space.id,
      title: 'Low importance note',
      content: 'x',
      type: 'reference',
      source: 'user',
    })
    const core = buildMemoryCore(space, [owner([['om-1', 'Prefer short answers.']])])
    expect(core.text).toMatch(/^---\n# Memory\n/)
    expect(core.text).toContain('## About your owner')
    expect(core.text).toContain('- [om-1] Prefer short answers. (Scout · 2026-09-20)')
    expect(core.text).toContain('## Pinned memories\n### Never use native select [')
    const catalog = core.text.slice(core.text.indexOf('## Memory catalog'))
    expect(catalog.indexOf('Staging SSH port')).toBeLessThan(catalog.indexOf('Low importance note'))
    expect(core.sources.map((source) => source.key.split(':')[0]).sort()).toEqual(['owner', 'pinned'])
  })

  it('caps pinned memories and truncates long ones with a read pointer', () => {
    const workspace = makeWorkspace()
    const space: MemorySpace = { id: workspace.id, kind: 'workspace', roots: [] }
    for (let i = 0; i < 8; i++)
      createLocalMemory({
        workspaceId: space.id,
        title: `Pinned ${i}`,
        content: `${i} ${'y'.repeat(900)}`,
        type: 'lesson',
        source: 'user',
        pinned: true,
      })
    const sources = memoryCoreSources(space, [])
    expect(sources.reduce((sum, source) => sum + source.text.length, 0)).toBeLessThanOrEqual(
      MEMORY_CORE_LIMITS.pinnedChars
    )
    expect(sources[0].text).toContain('… (memory_read ')
  })

  it('describes additions, edits and removals as a bounded delta, flagging large ones', () => {
    const before = [
      { key: 'owner:a', text: 'Prefer short answers.', hash: '1' },
      { key: 'owner:b', text: 'Old', hash: '2' },
    ]
    const after = [
      { key: 'owner:a', text: 'Prefer short answers with the decision first.', hash: '3' },
      { key: 'owner:c', text: 'Lives in São Paulo.', hash: '4' },
    ]
    const delta = renderMemoryDelta(before, after)!
    expect(delta.text).toContain('<maestrly-memory kind="updates">')
    expect(delta.text).toContain('~ Updated: Prefer short answers with the decision first.')
    expect(delta.text).toContain('+ New: Lives in São Paulo.')
    expect(delta.text).toContain('- No longer valid, stop relying on it: Old')
    expect(delta.tooLarge).toBe(false)
    expect(renderMemoryDelta(before, before)).toBeNull()
    const huge = [{ key: 'pinned:x', text: 'z'.repeat(2_000), hash: '5' }]
    expect(renderMemoryDelta([], huge)!.tooLarge).toBe(true)
  })

  it('reports an unavailable extras provider as null, not as empty', async () => {
    setMemoryCoreExtras('conv-a', async () => {
      throw new Error('gateway down')
    })
    expect(await loadMemoryCoreExtras('conv-a', new AbortController().signal)).toBeNull()
    expect(await loadMemoryCoreExtras('conv-none', new AbortController().signal)).toEqual([])
  })
})
