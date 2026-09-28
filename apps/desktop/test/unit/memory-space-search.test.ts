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

import { createLocalMemory } from '../../src/main/memory/local-memory-service'
import { disposeMemoryIndexService } from '../../src/main/memory/index'
import { searchMemorySpace } from '../../src/main/memory/search'
import { BOT_MEMORY_SPACE_ID, type MemorySpace } from '../../src/main/memory/spaces'
import { makeWorkspace } from '../helpers/factories'

function seed(spaceId: string) {
  const add = (title: string, content: string) =>
    createLocalMemory({ workspaceId: spaceId, title, content, type: 'reference', source: 'user' }).memory
  return {
    deploy: add('Production deploy uses blue-green', 'O deploy de produção troca o tráfego do azul para o verde.'),
    ssh: add('Staging SSH uses port 2222', 'The staging server only accepts SSH on port 2222.'),
    tags: add('Release tags are signed', 'Create release tags with git tag -s and push them.'),
  }
}

describe('memory space search', () => {
  it('recalls a relevant memory above the floor with a bounded snippet', async () => {
    const workspace = makeWorkspace()
    const ids = seed(workspace.id)
    const space: MemorySpace = { id: workspace.id, kind: 'workspace', roots: [] }
    const hits = await searchMemorySpace(space, 'como é o deploy de produção? azul e verde?', {
      mode: 'recall',
      limit: 3,
    })
    expect(hits[0]?.id).toBe(ids.deploy.id)
    expect(hits[0]!.relevance).toBeGreaterThanOrEqual(0.6)
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(400)
    expect(await searchMemorySpace(space, 'me conta uma piada sobre gatos', { mode: 'recall', limit: 3 })).toEqual([])
    expect(await searchMemorySpace(space, 'me conta uma piada sobre gatos', { mode: 'search', limit: 5 })).toEqual([])
  })

  it('keeps partial matches for search only, and honors exclusions', async () => {
    const workspace = makeWorkspace()
    const ids = seed(workspace.id)
    const space: MemorySpace = { id: workspace.id, kind: 'workspace', roots: [] }
    expect(await searchMemorySpace(space, 'port number for the database', { mode: 'recall', limit: 3 })).toEqual([])
    expect((await searchMemorySpace(space, 'port number for the database', { mode: 'search', limit: 5 }))[0]?.id).toBe(
      ids.ssh.id
    )
    const excluded = await searchMemorySpace(space, 'release tags signed', {
      mode: 'recall',
      limit: 3,
      excludeIds: new Set([ids.tags.id]),
    })
    expect(excluded.map((hit) => hit.id)).not.toContain(ids.tags.id)
  })

  it('searches the bot space, which has no workspace or repository roots', async () => {
    const ids = seed(BOT_MEMORY_SPACE_ID)
    const hits = await searchMemorySpace({ id: BOT_MEMORY_SPACE_ID, kind: 'bot', roots: [] }, 'release tags', {
      mode: 'recall',
      limit: 3,
    })
    expect(hits.map((hit) => hit.id)).toEqual([ids.tags.id])
  })
})
