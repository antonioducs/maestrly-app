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
import { closeDb, freshDb } from '../helpers/db'
import { makeWorkspace } from '../helpers/factories'
import type { Workspace } from '../../src/main/store'
import { checkKnowledgeGitVisibility, excludeFromGitInfo } from '../../src/main/git-service'
import { createLocalMemory, getLocalMemory, updateLocalMemory } from '../../src/main/memory/local-memory-service'
import { previewLocalMemoryPromotion, promoteLocalMemory } from '../../src/main/memory/memory-center-service'

vi.mock('../../src/main/memory/index', () => ({
  rebuildMemoryIndex: vi.fn(),
  reconcileMemoryIndex: vi.fn(),
  searchMemoryIndexLexical: vi.fn(),
  searchMemoryIndexVector: vi.fn(),
}))

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('Memory Center promotion and Git visibility', () => {
  let root: string
  let repository: string
  let workspace: Workspace

  beforeEach(() => {
    freshDb()
    root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'memory-center-promotion-')))
    repository = path.join(root, 'repository')
    mkdirSync(repository)
    execFileSync('git', ['init', '-q', repository])
    workspace = makeWorkspace({ path: repository })
  })

  afterEach(() => {
    vi.clearAllMocks()
    closeDb()
    rmSync(root, { recursive: true, force: true })
  })

  it('previews a normalized, parseable path without touching the repository', async () => {
    const memory = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Déjà Vu / API',
      content: 'Prefer stable response envelopes.',
      type: 'preference',
      scope: 'original scope',
      tags: ['UX', 'api'],
      source: 'user',
    }).memory

    const preview = await previewLocalMemoryPromotion({
      workspaceId: workspace.id,
      memoryId: memory.id,
      slug: '../Árvore de Decisão',
      scope: ' public API ',
    })

    expect(preview.relativePath).toBe('.agents/knowledge/reference/arvore-de-decisao.md')
    expect(preview.markdown).toBe(
      [
        '---',
        'id: "arvore-de-decisao"',
        'type: reference',
        'status: active',
        'scope: "public API"',
        'tags: ["api","ux"]',
        'always_apply: false',
        '---',
        '',
        '# Déjà Vu / API',
        '',
        'Prefer stable response envelopes.',
        '',
      ].join('\n')
    )
    expect(existsSync(path.join(repository, '.agents'))).toBe(false)
  })

  it('promotes without committing, rejects accidental replacement, and overwrites atomically when requested', async () => {
    const memory = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Release Gate',
      content: 'Use signed tags.',
      type: 'decision',
      scope: 'release',
      tags: ['git'],
      source: 'user',
    }).memory

    const promoted = await promoteLocalMemory({ workspaceId: workspace.id, memoryId: memory.id })
    const target = path.join(repository, promoted.path)

    expect(promoted).toMatchObject({
      path: '.agents/knowledge/decision/release-gate.md',
      gitIgnored: false,
    })
    expect(readFileSync(target, 'utf8')).toBe(promoted.markdown)
    expect(getLocalMemory(workspace.id, memory.id)?.promotedPath).toBe(promoted.path)
    expect(git(repository, ['status', '--porcelain', '--untracked-files=all'])).toContain(
      '?? .agents/knowledge/decision/release-gate.md'
    )

    await expect(promoteLocalMemory({ workspaceId: workspace.id, memoryId: memory.id })).rejects.toThrow(
      'shared memory already exists'
    )
    updateLocalMemory(workspace.id, memory.id, { content: 'Use signed and annotated tags.' })
    const overwritten = await promoteLocalMemory({
      workspaceId: workspace.id,
      memoryId: memory.id,
      overwrite: true,
    })

    expect(readFileSync(target, 'utf8')).toBe(overwritten.markdown)
    expect(overwritten.markdown).toContain('Use signed and annotated tags.')
    expect(readdirSync(path.dirname(target))).toEqual(['release-gate.md'])

    const excludePath = git(repository, ['rev-parse', '--git-path', 'info/exclude'])
    const exclude = readFileSync(path.resolve(repository, excludePath), 'utf8')
    expect(exclude.match(/# BEGIN MAESTRLY MANAGED/g)).toHaveLength(1)
    expect(exclude).toContain('!.agents/')
    expect(exclude).toContain('.agents/notes/')
    expect(exclude).not.toContain('\n.agents/\n')
  })

  it('reports a user Git rule that still hides shared knowledge', async () => {
    writeFileSync(path.join(repository, '.gitignore'), '.agents/\n')
    const memory = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Visible warning',
      content: 'The promotion still writes, but reports ignore visibility.',
      type: 'reference',
      source: 'user',
    }).memory

    const promoted = await promoteLocalMemory({ workspaceId: workspace.id, memoryId: memory.id })

    expect(promoted.gitIgnored).toBe(true)
    expect(promoted.gitRule).toContain('.gitignore')
    expect(existsSync(path.join(repository, promoted.path))).toBe(true)
    expect(existsSync(path.join(repository, '.agents', 'knowledge', '__maestrly_probe__.md'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink promotion target without modifying its destination',
    async () => {
      const memory = createLocalMemory({
        workspaceId: workspace.id,
        title: 'Symlink target',
        content: 'Must stay jailed.',
        type: 'decision',
        source: 'user',
      }).memory
      const outside = path.join(root, 'outside.md')
      const directory = path.join(repository, '.agents', 'knowledge', 'decision')
      mkdirSync(directory, { recursive: true })
      writeFileSync(outside, 'outside sentinel')
      symlinkSync(outside, path.join(directory, 'symlink-target.md'))

      await expect(promoteLocalMemory({ workspaceId: workspace.id, memoryId: memory.id })).rejects.toThrow(
        'promotion target is not a regular file'
      )
      expect(readFileSync(outside, 'utf8')).toBe('outside sentinel')
      expect(getLocalMemory(workspace.id, memory.id)?.promotedPath).toBeUndefined()
    }
  )

  it('keeps external info/exclude lines and updates the managed block idempotently', async () => {
    const excludePath = path.resolve(repository, git(repository, ['rev-parse', '--git-path', 'info/exclude']))
    writeFileSync(excludePath, '*.private\n')

    await excludeFromGitInfo(repository, ['.maestrly/test-only.json'])
    await excludeFromGitInfo(repository, ['.maestrly/test-only.json'])

    const content = readFileSync(excludePath, 'utf8')
    expect(content).toContain('*.private')
    expect(content.match(/# BEGIN MAESTRLY MANAGED/g)).toHaveLength(1)
    expect(content.match(/\.maestrly\/test-only\.json/g)).toHaveLength(1)
    expect(await checkKnowledgeGitVisibility(repository)).toEqual({ ignored: false })
  })

  it('reopens knowledge when migrating a managed block that used to ignore all of .agents', async () => {
    const excludePath = path.resolve(repository, git(repository, ['rev-parse', '--git-path', 'info/exclude']))
    writeFileSync(
      excludePath,
      ['# BEGIN MAESTRLY MANAGED', '.agents/', '.agents/notes/', '# END MAESTRLY MANAGED', ''].join('\n')
    )

    await excludeFromGitInfo(repository, [])

    expect(await checkKnowledgeGitVisibility(repository)).toEqual({ ignored: false })
  })
})
