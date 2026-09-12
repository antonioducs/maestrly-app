import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeWorkspace } from '../helpers/factories'
import { getDb } from '../../src/main/store'
import {
  getLegacyMemoryBackups,
  migrateLegacyMemory,
  splitLegacyMemory,
} from '../../src/main/memory/legacy-memory-migrator'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('legacy memory Markdown splitting', () => {
  it('preserves every byte while splitting the intro and level 1-3 headings deterministically', () => {
    const raw = [
      'Project preface',
      '',
      '# Alpha ###',
      'Alpha body',
      '#### This is content, not a split',
      '',
      '## Beta',
      'Beta body',
      '### Gamma ###',
      'Gamma body',
      '',
    ].join('\n')

    const sections = splitLegacyMemory('workspace-a', 'source-a', raw)

    expect(sections.map((section) => section.title)).toEqual(['Legacy project memory', 'Alpha', 'Beta', 'Gamma'])
    expect(sections.map((section) => section.content).join('')).toBe(raw)
    expect(sections.map((section) => section.id)).toEqual(
      expect.arrayContaining(sections.map(() => expect.stringMatching(/^legacy-[a-f0-9]{48}$/)))
    )
    expect(splitLegacyMemory('workspace-a', 'source-a', raw)).toEqual(sections)
    expect(splitLegacyMemory('workspace-a', 'source-b', raw).map((section) => section.id)).not.toEqual(
      sections.map((section) => section.id)
    )
  })

  it('keeps heading-free Markdown as one exact legacy section and ignores an empty file', () => {
    const raw = 'Plain memory\nwith no heading\n'

    expect(splitLegacyMemory('workspace', 'source', raw)).toEqual([
      expect.objectContaining({ title: 'Legacy project memory', content: raw }),
    ])
    expect(splitLegacyMemory('workspace', 'empty', '')).toEqual([])
  })
})

describe('legacy memory migration', () => {
  let root: string
  let repository: string
  let userData: string

  beforeEach(() => {
    freshDb()
    root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'memory-legacy-migrator-')))
    repository = path.join(root, 'repository')
    userData = path.join(root, 'user-data')
    mkdirSync(repository)
    mkdirSync(userData)
    vi.spyOn(app, 'getPath').mockReturnValue(userData)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDb()
    rmSync(root, { recursive: true, force: true })
  })

  function appOwnedSource(workspaceId: string): string {
    return path.join(userData, 'workspace-data', workspaceId, 'memory.md')
  }

  it('imports app-owned memory.md once, verifies it, and journals the durable backup', async () => {
    const workspace = makeWorkspace({ path: repository })
    const source = appOwnedSource(workspace.id)
    const raw = '# Decision\nUse signed tags.\n\n## Context\nRelease policy.\n'
    mkdirSync(path.dirname(source), { recursive: true })
    writeFileSync(source, raw)

    await migrateLegacyMemory(workspace.id)

    const hash = sha256(raw)
    const backup = path.join(path.dirname(source), `legacy-memory.${hash}.md`)
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(backup, 'utf8')).toBe(raw)
    expect(
      getDb()
        .prepare('SELECT title, content, source FROM local_memories WHERE workspace_id = ? ORDER BY title')
        .all(workspace.id)
    ).toEqual([
      { title: 'Context', content: '## Context\nRelease policy.\n', source: 'legacy-import' },
      { title: 'Decision', content: '# Decision\nUse signed tags.\n\n', source: 'legacy-import' },
    ])
    expect(
      getDb()
        .prepare(
          'SELECT source_hash, imported_count, backup_path, status, error FROM local_memory_migrations WHERE workspace_id = ?'
        )
        .get(workspace.id)
    ).toEqual({
      source_hash: hash,
      imported_count: 2,
      backup_path: backup,
      status: 'completed',
      error: null,
    })
    expect(getLegacyMemoryBackups(workspace.id)).toEqual([{ path: backup, hash, status: 'completed' }])

    await migrateLegacyMemory(workspace.id)

    expect(
      getDb().prepare('SELECT COUNT(*) AS count FROM local_memories WHERE workspace_id = ?').get(workspace.id)
    ).toEqual({ count: 2 })
    expect(
      getDb().prepare('SELECT COUNT(*) AS count FROM local_memory_migrations WHERE workspace_id = ?').get(workspace.id)
    ).toEqual({ count: 1 })
    expect(readFileSync(backup, 'utf8')).toBe(raw)
  })

  it('copies the repository-era .agents/memory.md without modifying the user file', async () => {
    const workspace = makeWorkspace({ path: repository })
    const repositorySource = path.join(repository, '.agents', 'memory.md')
    const raw = '# Historical source\nKeep the old repository file intact.\n'
    mkdirSync(path.dirname(repositorySource), { recursive: true })
    writeFileSync(repositorySource, raw)

    await migrateLegacyMemory(workspace.id)

    expect(readFileSync(repositorySource, 'utf8')).toBe(raw)
    expect(
      getDb().prepare('SELECT title, content FROM local_memories WHERE workspace_id = ?').get(workspace.id)
    ).toEqual({ title: 'Historical source', content: raw })
    const [backup] = getLegacyMemoryBackups(workspace.id)
    expect(backup?.path).toBe(path.join(userData, 'workspace-data', workspace.id, `legacy-memory.${sha256(raw)}.md`))
    expect(readFileSync(backup!.path, 'utf8')).toBe(raw)
  })

  it('prefers the app-owned source when both legacy locations exist', async () => {
    const workspace = makeWorkspace({ path: repository })
    const ownedSource = appOwnedSource(workspace.id)
    const repositorySource = path.join(repository, '.agents', 'memory.md')
    mkdirSync(path.dirname(ownedSource), { recursive: true })
    mkdirSync(path.dirname(repositorySource), { recursive: true })
    writeFileSync(ownedSource, '# App owned\nCurrent content.\n')
    writeFileSync(repositorySource, '# Repository fallback\nOlder content.\n')

    await migrateLegacyMemory(workspace.id)

    expect(getDb().prepare('SELECT title FROM local_memories WHERE workspace_id = ?').all(workspace.id)).toEqual([
      { title: 'App owned' },
    ])
    expect(readFileSync(repositorySource, 'utf8')).toContain('Repository fallback')
  })

  it('keeps the source and imported rows recoverable when backup creation fails', async () => {
    const workspace = makeWorkspace({ path: repository })
    const source = appOwnedSource(workspace.id)
    const raw = '# Recoverable\nThe source must survive a backup failure.\n'
    const hash = sha256(raw)
    const backup = path.join(path.dirname(source), `legacy-memory.${hash}.md`)
    mkdirSync(path.dirname(source), { recursive: true })
    writeFileSync(source, raw)
    mkdirSync(backup)

    await expect(migrateLegacyMemory(workspace.id)).rejects.toBeDefined()

    expect(readFileSync(source, 'utf8')).toBe(raw)
    expect(
      getDb().prepare('SELECT title, content FROM local_memories WHERE workspace_id = ?').all(workspace.id)
    ).toEqual([{ title: 'Recoverable', content: raw }])
    expect(
      getDb()
        .prepare(
          'SELECT imported_count, backup_path, status, error FROM local_memory_migrations WHERE workspace_id = ?'
        )
        .get(workspace.id)
    ).toEqual({
      imported_count: 1,
      backup_path: null,
      status: 'backup-failed',
      error: expect.any(String),
    })

    rmSync(backup, { recursive: true })
    await migrateLegacyMemory(workspace.id)

    expect(existsSync(source)).toBe(false)
    expect(readFileSync(backup, 'utf8')).toBe(raw)
    expect(
      getDb().prepare('SELECT COUNT(*) AS count FROM local_memories WHERE workspace_id = ?').get(workspace.id)
    ).toEqual({ count: 1 })
    expect(
      getDb()
        .prepare('SELECT status, backup_path, error FROM local_memory_migrations WHERE workspace_id = ?')
        .get(workspace.id)
    ).toEqual({ status: 'completed', backup_path: backup, error: null })
  })
})
