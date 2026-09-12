import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { workspaceDataDir } from '../../src/main/app-paths'
import {
  assertSharedPathInScope,
  disposeMemoryIndexService,
  getMemoryIndexStatus,
  initMemoryIndexService,
  rebuildMemoryIndex,
  reconcileMemoryIndex,
  scheduleWorkspaceMemoryIndexWarmup,
  searchMemoryIndexLexical,
  stopWorkspaceMemoryIndex,
  warmWorkspaceMemoryIndex,
} from '../../src/main/memory/index'
import { findTrustedVectorExtension, vectorExtensionCandidates } from '../../src/main/memory/index/vector-backend'
import {
  archiveLocalMemory,
  createLocalMemory,
  forgetLocalMemory,
  getLocalMemory,
} from '../../src/main/memory/local-memory-service'
import { retrieveHybridMemory } from '../../src/main/memory/retrieval'
import { isWorkspaceMemoryEnabled, setWorkspaceMemoryEnabled } from '../../src/main/memory/access'
import { closeDb, freshDb } from '../helpers/db'
import { makeWorkspace } from '../helpers/factories'

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

function repository(name: string): string {
  const repo = path.join(root, name)
  mkdirSync(repo)
  return repo
}

function shared(repo: string, relative: string, raw: string): string {
  const file = path.join(repo, '.agents', 'knowledge', relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, raw)
  return file
}

function local(
  workspaceId: string,
  input: {
    title: string
    content: string
    pinned?: boolean
    type?: 'decision' | 'constraint' | 'preference' | 'procedure' | 'lesson' | 'reference'
  }
) {
  return createLocalMemory({
    workspaceId,
    title: input.title,
    content: input.content,
    type: input.type ?? 'reference',
    pinned: input.pinned,
    source: 'user',
  }).memory
}

describe('memory index warm-up', () => {
  it('deduplicates a workspace flight and ignores its late completion after cancellation', async () => {
    const repo = repository('warmup-cancel')
    const workspace = makeWorkspace({ path: repo })
    let releaseInstall!: () => void
    runtime.ensure.mockImplementationOnce(
      () => new Promise((resolve) => (releaseInstall = () => resolve({ state: 'ready' })))
    )

    const first = warmWorkspaceMemoryIndex(workspace.id)
    const duplicate = warmWorkspaceMemoryIndex(workspace.id)

    expect(duplicate).toBe(first)
    expect(runtime.ensure).toHaveBeenCalledOnce()
    stopWorkspaceMemoryIndex(workspace.id)
    releaseInstall()
    await expect(first).resolves.toBeUndefined()
    expect(runtime.ready).not.toHaveBeenCalled()
  })

  it('defers scheduled work to a later turn so callers are never blocked', async () => {
    vi.useFakeTimers()
    try {
      const repo = repository('warmup-scheduled')
      const workspace = makeWorkspace({ path: repo })
      local(workspace.id, { title: 'Warm local', content: 'Local authority prepared during warm-up.' })
      shared(repo, 'reference/warm.md', '# Shared warm-up\nKnowledge authority prepared during warm-up.')
      writeFileSync(path.join(repo, 'application.ts'), 'const forbiddenCodeToken = "never-index-source-code"')

      scheduleWorkspaceMemoryIndexWarmup(workspace.id)
      scheduleWorkspaceMemoryIndexWarmup(workspace.id)

      expect(runtime.ensure).not.toHaveBeenCalled()
      await vi.runOnlyPendingTimersAsync()
      expect(runtime.ensure).toHaveBeenCalledOnce()
      await warmWorkspaceMemoryIndex(workspace.id)
      expect(await getMemoryIndexStatus(workspace.id)).toMatchObject({
        documents: 2,
        localDocuments: 1,
        sharedDocuments: 1,
      })
      await expect(searchMemoryIndexLexical(workspace.id, 'never-index-source-code')).resolves.toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('memory access gate', () => {
  it('fails closed before/after store availability', async () => {
    closeDb()

    expect(isWorkspaceMemoryEnabled('not-initialized')).toBe(false)
    await expect(retrieveHybridMemory({ workspaceId: 'not-initialized', query: 'release process' })).resolves.toEqual(
      []
    )
  })

  it('stops and clears the transient index while disabled, then rebuilds when enabled', async () => {
    const repo = repository('toggle-repo')
    const workspace = makeWorkspace({ path: repo })
    local(workspace.id, { title: 'Toggle memory', content: 'Remember the toggle boundary.' })
    initMemoryIndexService()
    await reconcileMemoryIndex(workspace.id, [{ root: repo }])
    expect((await getMemoryIndexStatus(workspace.id)).documents).toBe(1)

    setWorkspaceMemoryEnabled(workspace.id, false)

    expect(await getMemoryIndexStatus(workspace.id)).toEqual({
      workspaceId: workspace.id,
      state: 'disabled',
      documents: 0,
      chunks: 0,
      localDocuments: 0,
      sharedDocuments: 0,
      semanticAvailable: false,
      pendingEmbeddings: 0,
    })
    await expect(retrieveHybridMemory({ workspaceId: workspace.id, query: 'toggle' })).resolves.toEqual([])

    setWorkspaceMemoryEnabled(workspace.id, true)
    await reconcileMemoryIndex(workspace.id, [{ root: repo }])
    await vi.waitFor(async () => {
      expect(await getMemoryIndexStatus(workspace.id)).toMatchObject({
        state: 'text-only',
        documents: 1,
        localDocuments: 1,
      })
    })
  })
})

describe('text-first memory index', () => {
  it('indexes local/shared sources, excludes ineligible documents and exposes provenance without ML', async () => {
    const repo = repository('primary-repo')
    const workspace = makeWorkspace({ path: repo })
    const localMemory = local(workspace.id, {
      title: 'Local release checklist',
      content: 'The release checklist requires signed tags.',
      type: 'procedure',
    })
    shared(
      repo,
      'decision/release.md',
      '---\nid: shared-release\ntype: decision\nstatus: active\ntags: [release]\n---\n# Release boundary\nSigned tags are mandatory.'
    )
    shared(
      repo,
      'decision/broken.md',
      '---\nid: broken-release\ntype: decision\nstatus: invented\n---\n# Broken release\nMust not enter prompts.'
    )

    await reconcileMemoryIndex(workspace.id, [{ root: repo, linkName: 'primary' }])

    expect(await getMemoryIndexStatus(workspace.id)).toMatchObject({
      state: 'text-only',
      documents: 3,
      localDocuments: 1,
      sharedDocuments: 2,
      semanticAvailable: false,
      pendingEmbeddings: 0,
    })
    expect(runtime.embed).not.toHaveBeenCalled()
    const hits = await searchMemoryIndexLexical(
      workspace.id,
      'release signed',
      [{ root: repo, linkName: 'primary' }],
      10
    )
    expect(hits.map((hit) => [hit.kind, hit.id])).toEqual(
      expect.arrayContaining([
        ['local', localMemory.id],
        ['shared', 'shared-release'],
      ])
    )
    expect(hits.some((hit) => hit.id === 'broken-release')).toBe(false)
    expect(hits.find((hit) => hit.id === 'shared-release')).toMatchObject({
      repo: 'primary',
      path: '.agents/knowledge/decision/release.md',
      heading: 'Release boundary',
      startLine: 7,
      endLine: 8,
    })

    archiveLocalMemory(workspace.id, localMemory.id)
    const afterArchive = await searchMemoryIndexLexical(workspace.id, 'checklist', [{ root: repo }], 10)
    expect(afterArchive.some((hit) => hit.id === localMemory.id)).toBe(false)
  })

  it('keeps shared results scoped to explicitly selected roots and public link names', async () => {
    const repoA = repository('repo-a')
    const repoB = repository('repo-b')
    const workspace = makeWorkspace({ path: repoA })
    shared(repoA, 'constraint/a.md', '# Alpha boundary\nmultiroot sentinel alpha')
    shared(repoB, 'constraint/b.md', '# Beta boundary\nmultiroot sentinel beta')
    await reconcileMemoryIndex(workspace.id, [
      { root: repoA, linkName: 'alpha' },
      { root: repoB, linkName: 'beta' },
    ])

    const alpha = await searchMemoryIndexLexical(
      workspace.id,
      'multiroot sentinel',
      [{ root: repoA, linkName: 'alpha' }],
      10
    )
    const beta = await searchMemoryIndexLexical(
      workspace.id,
      'multiroot sentinel',
      [{ root: repoB, linkName: 'beta' }],
      10
    )

    expect(alpha.filter((hit) => hit.kind === 'shared').map((hit) => hit.repo)).toEqual(['alpha'])
    expect(alpha.map((hit) => hit.content).join('\n')).not.toContain('sentinel beta')
    expect(beta.filter((hit) => hit.kind === 'shared').map((hit) => hit.repo)).toEqual(['beta'])
    expect(beta.map((hit) => hit.content).join('\n')).not.toContain('sentinel alpha')
  })

  it('removes forgotten/deleted sources and rebuilds a corrupt transient index from authorities', async () => {
    const repo = repository('rebuild-repo')
    const workspace = makeWorkspace({ path: repo })
    const memory = local(workspace.id, { title: 'Rebuild me', content: 'rebuild-authority sentinel' })
    const sharedFile = shared(repo, 'reference/rebuild.md', '# Shared rebuild\nrebuild-authority shared')
    await reconcileMemoryIndex(workspace.id, [{ root: repo }])
    expect((await getMemoryIndexStatus(workspace.id)).documents).toBe(2)

    forgetLocalMemory(workspace.id, memory.id)
    unlinkSync(sharedFile)
    await reconcileMemoryIndex(workspace.id, [{ root: repo }])
    expect(await getMemoryIndexStatus(workspace.id)).toMatchObject({ documents: 0, chunks: 0 })

    const replacement = local(workspace.id, { title: 'Authoritative replacement', content: 'rebuilt safely' })
    await reconcileMemoryIndex(workspace.id, [{ root: repo }])
    stopWorkspaceMemoryIndex(workspace.id)
    const indexFile = path.join(workspaceDataDir(workspace.id), 'memory-index.sqlite')
    writeFileSync(indexFile, 'not a sqlite database')

    await reconcileMemoryIndex(workspace.id, [{ root: repo }])

    expect(await getMemoryIndexStatus(workspace.id)).toMatchObject({ documents: 1, localDocuments: 1 })
    expect((await searchMemoryIndexLexical(workspace.id, 'rebuilt', [{ root: repo }], 10))[0]?.id).toBe(replacement.id)
    expect(
      readdirSync(path.dirname(indexFile)).some((name) => name.startsWith('memory-index.sqlite.diagnostic-'))
    ).toBe(true)

    await rebuildMemoryIndex(workspace.id, [{ root: repo }])
    expect(await getMemoryIndexStatus(workspace.id)).toMatchObject({ documents: 1, state: 'text-only' })
  })

  it('enforces the lexical shared-path boundary', () => {
    const repo = repository('path-jail')
    expect(() => assertSharedPathInScope(repo, path.join(repo, '.agents', 'knowledge', 'ok.md'))).not.toThrow()
    expect(() => assertSharedPathInScope(repo, path.join(root, 'outside.md'))).toThrow(/escaped repository scope/)
  })

  it.skipIf(process.platform === 'win32')('trusts vector binaries only inside the runtime asset', () => {
    const runtimeRoot = repository('runtime-root')
    const outside = path.join(root, 'outside-vector')
    writeFileSync(outside, 'binary')
    const candidate = vectorExtensionCandidates(runtimeRoot)[0]!
    mkdirSync(path.dirname(candidate), { recursive: true })
    symlinkSync(outside, candidate)
    expect(findTrustedVectorExtension(runtimeRoot)).toBeUndefined()

    unlinkSync(candidate)
    writeFileSync(candidate, 'trusted binary')
    expect(findTrustedVectorExtension(runtimeRoot)).toBe(realpathSync(candidate))
  })
})

describe('hybrid retrieval', () => {
  it('deduplicates identical local/shared content and tracks selected local usage', async () => {
    const repo = repository('retrieval-repo')
    const workspace = makeWorkspace({ path: repo })
    const duplicated = 'Signed release tags are mandatory for production.'
    const duplicateLocal = local(workspace.id, {
      title: 'Local duplicate',
      content: duplicated,
      type: 'decision',
    })
    const usedLocal = local(workspace.id, {
      title: 'Release owner',
      content: 'The signed release owner must verify the deployment checklist.',
      type: 'procedure',
    })
    shared(
      repo,
      'decision/release.md',
      `---\nid: canonical-release\ntype: decision\nstatus: active\n---\n${duplicated}`
    )

    const hits = await retrieveHybridMemory({
      workspaceId: workspace.id,
      query: 'signed release tags deployment checklist',
      roots: [{ root: repo, linkName: 'main' }],
      markUsed: true,
      limit: 10,
    })

    expect(hits.filter((hit) => hit.content.trim() === duplicated)).toHaveLength(1)
    expect(hits.some((hit) => hit.id === usedLocal.id)).toBe(true)
    expect(getLocalMemory(workspace.id, usedLocal.id)).toMatchObject({ useCount: 1 })
    expect(getLocalMemory(workspace.id, duplicateLocal.id)).toMatchObject({ useCount: 0 })

    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'shared', id: 'canonical-release', repo: 'main' }),
        expect.objectContaining({ kind: 'local', id: usedLocal.id }),
      ])
    )
  })

  it('includes pinned memories for unrelated queries and enforces pinned/normal character budgets', async () => {
    const repo = repository('budget-repo')
    const workspace = makeWorkspace({ path: repo })
    const pinned = local(workspace.id, {
      title: 'Always-on incident rule',
      content: `Pinned rule ${'p'.repeat(1_450)}`,
      pinned: true,
      type: 'constraint',
    })
    local(workspace.id, {
      title: 'Second pinned rule',
      content: `Second pinned ${'q'.repeat(1_450)}`,
      pinned: true,
    })

    const pinnedHits = await retrieveHybridMemory({
      workspaceId: workspace.id,
      query: 'a completely unrelated question',
      roots: [{ root: repo }],
      limit: 10,
    })
    expect(pinnedHits.some((hit) => hit.id === pinned.id)).toBe(true)
    expect(pinnedHits.reduce((sum, hit) => sum + hit.content.length, 0)).toBeLessThanOrEqual(3_000)

    for (let index = 0; index < 3; index += 1) {
      local(workspace.id, {
        title: `Budget result ${index}`,
        content: `normalbudget token ${String(index)} ${String.fromCharCode(97 + index).repeat(1_150)}`,
      })
    }
    const normal = await retrieveHybridMemory({
      workspaceId: workspace.id,
      query: 'normalbudget token',
      roots: [{ root: repo }],
      limit: 10,
      maxChars: 2_000,
    })
    const normalChars = normal
      .filter((hit) => !hit.pinned && !hit.alwaysApply)
      .reduce((sum, hit) => sum + hit.content.length, 0)
    expect(normalChars).toBeLessThanOrEqual(2_000)
  })

  it('returns at most two chunks from one document', async () => {
    const repo = repository('chunk-budget-repo')
    const workspace = makeWorkspace({ path: repo })
    const memory = local(workspace.id, {
      title: 'Large procedure',
      content: [0, 1, 2].map((index) => `chunkneedle ${index} ${'x'.repeat(2_900)}`).join('\n'),
      type: 'procedure',
    })

    const hits = await retrieveHybridMemory({
      workspaceId: workspace.id,
      query: 'chunkneedle',
      roots: [{ root: repo }],
      limit: 10,
      maxChars: 16_000,
    })

    expect(hits.filter((hit) => hit.id === memory.id)).toHaveLength(2)
  })
})
