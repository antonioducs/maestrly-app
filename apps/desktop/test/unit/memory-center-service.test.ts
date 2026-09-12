import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const index = vi.hoisted(() => ({
  reconcile: vi.fn(async () => undefined),
  rebuild: vi.fn(async () => undefined),
}))

vi.mock('../../src/main/memory/index', () => ({
  reconcileMemoryIndex: index.reconcile,
  rebuildMemoryIndex: index.rebuild,
}))

import {
  exportLocalMemoryData,
  previewLocalMemoryPromotion,
  promoteLocalMemory,
  renderSharedMemoryMarkdown,
  searchMemoryCenter,
} from '../../src/main/memory/memory-center-service'
import { createLocalMemory, getLocalMemory, updateLocalMemory } from '../../src/main/memory/local-memory-service'
import { parseSharedKnowledgeDocument } from '../../src/main/memory/shared-knowledge'
import { setWorkspaceMemoryEnabled } from '../../src/main/memory/access'
import { closeDb, freshDb } from '../helpers/db'
import { makeWorkspace } from '../helpers/factories'

let root = ''

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'maestrly-memory-center-')))
  index.reconcile.mockClear()
  index.rebuild.mockClear()
  freshDb()
})

afterEach(() => {
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

function repo(name = 'repo'): string {
  const directory = path.join(root, name)
  mkdirSync(directory)
  return directory
}

function gitRepo(name = 'repo'): string {
  const directory = repo(name)
  execFileSync('git', ['init', '-q'], { cwd: directory })
  return directory
}

function memory(workspaceId: string, overrides: Partial<Parameters<typeof createLocalMemory>[0]> = {}) {
  return createLocalMemory({
    workspaceId,
    title: 'Release São & API',
    content: 'Use signed release tags.',
    type: 'decision',
    tags: ['api,web', 'release'],
    source: 'user',
    ...overrides,
  }).memory
}

describe('memory promotion rendering and preview', () => {
  it('renders parseable shared Markdown and a sanitized deterministic path', async () => {
    const repository = repo()
    const workspace = makeWorkspace({ path: repository })
    const local = memory(workspace.id)

    const preview = await previewLocalMemoryPromotion({
      workspaceId: workspace.id,
      memoryId: local.id,
      scope: 'packages/api',
    })

    expect(preview.relativePath).toBe('.agents/knowledge/decision/release-sao-api.md')
    const parsed = parseSharedKnowledgeDocument({
      root: repository,
      relativePath: preview.relativePath,
      raw: preview.markdown,
      modifiedAt: 1,
    })
    expect(parsed).toMatchObject({
      id: 'release-sao-api',
      title: 'Release São & API',
      content: expect.stringContaining('Use signed release tags.'),
      type: 'decision',
      scope: 'packages/api',
      tags: ['api,web', 'release'],
      eligibleForContext: true,
      warnings: [],
    })
  })

  it('keeps the standalone renderer compatible with hand-authored metadata', () => {
    const markdown = renderSharedMemoryMarkdown({
      id: 'deploy',
      title: 'Deploy safely',
      content: 'Verify production health.',
      type: 'procedure',
      tags: ['ops,critical'],
      supersedes: ['deploy-v1'],
      alwaysApply: true,
    })
    const parsed = parseSharedKnowledgeDocument({
      root,
      relativePath: '.agents/knowledge/procedure/deploy.md',
      raw: markdown,
      modifiedAt: 1,
    })

    expect(parsed).toMatchObject({
      id: 'deploy',
      tags: ['ops,critical'],
      supersedes: ['deploy-v1'],
      alwaysApply: true,
      eligibleForContext: true,
    })
  })
})

describe('safe promotion and Git visibility', () => {
  it('writes only shared knowledge, keeps notes private and records provenance on the local memory', async () => {
    const repository = gitRepo()
    const workspace = makeWorkspace({ path: repository })
    const local = memory(workspace.id)
    mkdirSync(path.join(repository, '.agents', 'notes'), { recursive: true })
    writeFileSync(path.join(repository, '.agents', 'notes', 'private.md'), 'private note')

    const result = await promoteLocalMemory({ workspaceId: workspace.id, memoryId: local.id })

    expect(result).toMatchObject({
      path: '.agents/knowledge/decision/release-sao-api.md',
      gitIgnored: false,
    })
    const target = path.join(repository, result.path)
    expect(readFileSync(target, 'utf8')).toBe(result.markdown)
    expect(getLocalMemory(workspace.id, local.id)?.promotedPath).toBe(result.path)
    expect(index.reconcile).toHaveBeenCalledWith(workspace.id, [{ root: realpathSync(repository) }])

    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repository,
      encoding: 'utf8',
    })
    expect(status).toContain('?? .agents/knowledge/decision/release-sao-api.md')
    expect(status).not.toContain('.agents/notes/private.md')
    const excludes = readFileSync(path.join(repository, '.git', 'info', 'exclude'), 'utf8')
    expect(excludes).toContain('!.agents/')
    expect(excludes).toContain('.agents/notes/')
    expect(excludes).not.toContain('.agents/knowledge/')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses symlinked ancestors and targets without writing outside the repository',
    async () => {
      const repository = repo()
      const workspace = makeWorkspace({ path: repository })
      const local = memory(workspace.id)
      const outside = path.join(root, 'outside')
      mkdirSync(outside)
      symlinkSync(outside, path.join(repository, '.agents'))

      await expect(promoteLocalMemory({ workspaceId: workspace.id, memoryId: local.id })).rejects.toThrow(
        /not a safe directory/
      )
      expect(existsSync(path.join(outside, 'knowledge'))).toBe(false)

      rmSync(path.join(repository, '.agents'))
      const targetDirectory = path.join(repository, '.agents', 'knowledge', 'decision')
      mkdirSync(targetDirectory, { recursive: true })
      const outsideFile = path.join(outside, 'do-not-overwrite.md')
      writeFileSync(outsideFile, 'outside sentinel')
      symlinkSync(outsideFile, path.join(targetDirectory, 'release-sao-api.md'))

      await expect(promoteLocalMemory({ workspaceId: workspace.id, memoryId: local.id })).rejects.toThrow(
        /not a regular file/
      )
      expect(readFileSync(outsideFile, 'utf8')).toBe('outside sentinel')
    }
  )

  it('requires explicit overwrite and atomically replaces an existing regular source', async () => {
    const repository = gitRepo()
    const workspace = makeWorkspace({ path: repository })
    const local = memory(workspace.id)
    const first = await promoteLocalMemory({ workspaceId: workspace.id, memoryId: local.id })
    updateLocalMemory(workspace.id, local.id, { content: 'Use signed tags and verify provenance.' })

    await expect(promoteLocalMemory({ workspaceId: workspace.id, memoryId: local.id })).rejects.toThrow(
      /already exists/
    )
    const replaced = await promoteLocalMemory({
      workspaceId: workspace.id,
      memoryId: local.id,
      overwrite: true,
    })

    expect(readFileSync(path.join(repository, first.path), 'utf8')).toBe(replaced.markdown)
    expect(replaced.markdown).toContain('verify provenance')
    expect(
      readdirSync(path.dirname(path.join(repository, first.path))).filter((name) => name.endsWith('.tmp'))
    ).toEqual([])
  })

  it('reports a user Git rule that still hides shared knowledge', async () => {
    const repository = gitRepo()
    writeFileSync(path.join(repository, '.gitignore'), '.agents/\n')
    const workspace = makeWorkspace({ path: repository })
    const local = memory(workspace.id)

    const result = await promoteLocalMemory({ workspaceId: workspace.id, memoryId: local.id })

    expect(result.gitIgnored).toBe(true)
    expect(result.gitRule).toContain('.gitignore')
    expect(existsSync(path.join(repository, result.path))).toBe(true)
  })
})

describe('manual Memory Center access while automatic retrieval is disabled', () => {
  it('keeps local/shared records searchable in the UI and exports local data', async () => {
    const repository = repo()
    const workspace = makeWorkspace({ path: repository })
    const local = memory(workspace.id, {
      title: 'Fallback local',
      content: 'fallback-sentinel local content',
      type: 'reference',
      tags: ['fallback'],
    })
    const sharedFile = path.join(repository, '.agents', 'knowledge', 'reference', 'fallback.md')
    mkdirSync(path.dirname(sharedFile), { recursive: true })
    writeFileSync(sharedFile, '# Fallback shared\nfallback-sentinel shared content')
    setWorkspaceMemoryEnabled(workspace.id, false)

    const hits = await searchMemoryCenter(workspace.id, 'fallback-sentinel')

    expect(hits.map((hit) => hit.kind).sort()).toEqual(['local', 'shared'])
    expect(hits.find((hit) => hit.kind === 'local')?.id).toBe(local.id)
    const exported = exportLocalMemoryData(workspace.id)
    const parsed = JSON.parse(exported.json) as { schemaVersion: number; memories: Array<{ id: string }> }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.memories.map((item) => item.id)).toContain(local.id)
    expect(exported.markdown).toContain('fallback-sentinel local content')
  })
})
