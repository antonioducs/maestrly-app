import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceDataDir } from '../../src/main/app-paths'
import {
  getLegacyMemoryBackups,
  migrateLegacyMemory,
  splitLegacyMemory,
} from '../../src/main/memory/legacy-memory-migrator'
import { listLocalMemories } from '../../src/main/memory/local-memory-service'
import { getDb } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeWorkspace } from '../helpers/factories'

let root = ''
let userData = ''

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-legacy-memory-'))
  userData = path.join(root, 'user-data')
  mkdirSync(userData)
  vi.spyOn(app, 'getPath').mockReturnValue(userData)
  freshDb()
})

afterEach(() => {
  closeDb()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function workspaceWithRepo() {
  const repo = path.join(root, `repo-${Math.random().toString(16).slice(2)}`)
  mkdirSync(repo)
  return { repo, workspace: makeWorkspace({ path: repo }) }
}

function appOwnedSource(workspaceId: string, content: string): string {
  const source = path.join(workspaceDataDir(workspaceId), 'memory.md')
  mkdirSync(path.dirname(source), { recursive: true })
  writeFileSync(source, content)
  return source
}

describe('legacy memory sectioning', () => {
  it('preserves every source byte across intro/headings and derives stable ids', () => {
    const content = [
      'Loose introductory memory.\n\n',
      '# Release process\nUse signed tags.\n\n',
      '## Testing ##\nRun unit tests.\n',
      '#### A level-four heading stays inside Testing.\n',
    ].join('')

    const first = splitLegacyMemory('workspace-1', 'source-hash', content)
    const second = splitLegacyMemory('workspace-1', 'source-hash', content)

    expect(first).toEqual(second)
    expect(first.map((section) => section.title)).toEqual(['Legacy project memory', 'Release process', 'Testing'])
    expect(first.map((section) => section.content).join('')).toBe(content)
    expect(first.every((section) => /^legacy-[a-f0-9]{48}$/.test(section.id))).toBe(true)
  })

  it('keeps a heading-free file as one record and handles an empty file', () => {
    expect(splitLegacyMemory('workspace-1', 'hash', '')).toEqual([])
    expect(splitLegacyMemory('workspace-1', 'hash', 'Remember this.')).toEqual([
      expect.objectContaining({ title: 'Legacy project memory', content: 'Remember this.' }),
    ])
  })
})

describe('legacy memory migration journal', () => {
  it('imports app-owned memory.md transactionally, verifies it and replaces it with a recorded backup', async () => {
    const { workspace } = workspaceWithRepo()
    const content = '# Decision\nUse SQLite.\n\n## Procedure\nRun migrations first.\n'
    const source = appOwnedSource(workspace.id, content)

    await migrateLegacyMemory(workspace.id)

    const memories = listLocalMemories(workspace.id)
    expect(memories).toHaveLength(2)
    const byId = new Map(memories.map((memory) => [memory.id, memory.content]))
    expect(
      splitLegacyMemory(workspace.id, sha256(content), content)
        .map((section) => byId.get(section.id))
        .join('')
    ).toBe(content)
    expect(memories.every((memory) => memory.source === 'legacy-import')).toBe(true)
    expect(memories.every((memory) => memory.tags.includes('legacy'))).toBe(true)
    expect(existsSync(source)).toBe(false)

    const [backup] = getLegacyMemoryBackups(workspace.id)
    expect(backup).toMatchObject({ hash: sha256(content), status: 'completed' })
    expect(backup?.path).toBe(path.join(path.dirname(source), `legacy-memory.${sha256(content)}.md`))
    expect(readFileSync(backup!.path, 'utf8')).toBe(content)

    await migrateLegacyMemory(workspace.id)
    expect(listLocalMemories(workspace.id)).toHaveLength(2)
    expect(getLegacyMemoryBackups(workspace.id)).toHaveLength(1)
  })

  it('copies the historical repository file without editing or deleting the user copy', async () => {
    const { repo, workspace } = workspaceWithRepo()
    const content = '# Repository-era memory\nPreserve the original file.\n'
    const repositorySource = path.join(repo, '.agents', 'memory.md')
    mkdirSync(path.dirname(repositorySource), { recursive: true })
    writeFileSync(repositorySource, content)

    await migrateLegacyMemory(workspace.id)
    await migrateLegacyMemory(workspace.id)

    expect(readFileSync(repositorySource, 'utf8')).toBe(content)
    expect(listLocalMemories(workspace.id)).toHaveLength(1)
    const [backup] = getLegacyMemoryBackups(workspace.id)
    expect(readFileSync(backup!.path, 'utf8')).toBe(content)
  })

  it('resumes safely when imported rows exist but the source was restored before backup completion', async () => {
    const { workspace } = workspaceWithRepo()
    const content = '# Recoverable\nThe same deterministic row must be reused.\n'
    const source = appOwnedSource(workspace.id, content)
    await migrateLegacyMemory(workspace.id)
    const [backup] = getLegacyMemoryBackups(workspace.id)
    copyFileSync(backup!.path, source)

    await migrateLegacyMemory(workspace.id)

    expect(listLocalMemories(workspace.id)).toHaveLength(1)
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(backup!.path, 'utf8')).toBe(content)
    expect(getLegacyMemoryBackups(workspace.id)[0]?.status).toBe('completed')
  })

  it('never moves the source when an existing journal cannot be verified', async () => {
    const { workspace } = workspaceWithRepo()
    const content = '# Missing imported row\nKeep this source intact.\n'
    const source = appOwnedSource(workspace.id, content)
    const sourceHash = sha256(content)
    const now = Date.now()
    getDb()
      .prepare(
        `INSERT INTO local_memory_migrations
         (workspace_id, source_hash, imported_count, backup_path, status, error, created_at, updated_at)
         VALUES (?, ?, 1, NULL, 'imported', NULL, ?, ?)`
      )
      .run(workspace.id, sourceHash, now, now)

    await expect(migrateLegacyMemory(workspace.id)).rejects.toThrow(/verification failed/)

    expect(readFileSync(source, 'utf8')).toBe(content)
    expect(existsSync(path.join(path.dirname(source), `legacy-memory.${sourceHash}.md`))).toBe(false)
  })

  it('records backup-failed and retains the source if the final rename cannot be completed', async () => {
    const { workspace } = workspaceWithRepo()
    const content = '# Backup failure\nDo not discard imported source bytes.\n'
    const source = appOwnedSource(workspace.id, content)
    const sourceHash = sha256(content)
    const backup = path.join(path.dirname(source), `legacy-memory.${sourceHash}.md`)
    mkdirSync(backup)

    await expect(migrateLegacyMemory(workspace.id)).rejects.toThrow()

    expect(readFileSync(source, 'utf8')).toBe(content)
    expect(listLocalMemories(workspace.id)).toHaveLength(1)
    const row = getDb()
      .prepare(
        'SELECT status, backup_path, error FROM local_memory_migrations WHERE workspace_id = ? AND source_hash = ?'
      )
      .get(workspace.id, sourceHash) as { status: string; backup_path: string | null; error: string | null }
    expect(row.status).toBe('backup-failed')
    expect(row.backup_path).toBeNull()
    expect(row.error).toEqual(expect.any(String))
  })
})
