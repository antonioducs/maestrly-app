import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DATABASE_FILENAME,
  DATABASE_FILENAME_MIGRATION_JOURNAL,
  LEGACY_DATABASE_FILENAME,
  prepareProductionDatabasePath,
} from '../../src/main/store/database-path-migration'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-db-name-'))
  roots.push(root)
  return root
}

function fixture(file: string, marker: string, keepOpen = false): DatabaseSync | undefined {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT, name TEXT, default_branch TEXT, added_at INTEGER);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, branch TEXT, mode TEXT, cwd TEXT, created_at INTEGER);
    CREATE TABLE fixture_marker (value TEXT NOT NULL);
  `)
  db.prepare('INSERT INTO fixture_marker(value) VALUES (?)').run(marker)
  if (keepOpen) return db
  db.close()
}

function marker(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare('SELECT value FROM fixture_marker').get() as { value: string }).value
  } finally {
    db.close()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('database filename migration', () => {
  it('snapshots old-only including committed WAL data and backs up the recoverable legacy database after boot', () => {
    const root = temporaryRoot()
    const legacy = path.join(root, LEGACY_DATABASE_FILENAME)
    const open = fixture(legacy, 'from-wal', true)!
    expect(existsSync(`${legacy}-wal`)).toBe(true)

    const migration = prepareProductionDatabasePath(root)
    expect(migration.databasePath).toBe(path.join(root, DATABASE_FILENAME))
    expect(marker(migration.databasePath)).toBe('from-wal')
    expect(existsSync(legacy)).toBe(true)

    open.close()
    migration.finalizeAfterSuccessfulBoot()
    expect(existsSync(legacy)).toBe(false)
    const journal = JSON.parse(readFileSync(path.join(root, DATABASE_FILENAME_MIGRATION_JOURNAL), 'utf8'))
    expect(journal.status).toBe('completed')
    expect(marker(path.join(journal.backupDir, LEGACY_DATABASE_FILENAME))).toBe('from-wal')

    // The next boot is idempotent and does not recreate or move the backup.
    prepareProductionDatabasePath(root).finalizeAfterSuccessfulBoot()
    expect(JSON.parse(readFileSync(path.join(root, DATABASE_FILENAME_MIGRATION_JOURNAL), 'utf8')).backupDir).toBe(
      journal.backupDir
    )
  })

  it('uses new-only without touching it', () => {
    const root = temporaryRoot()
    const current = path.join(root, DATABASE_FILENAME)
    fixture(current, 'new')
    const result = prepareProductionDatabasePath(root)
    expect(marker(result.databasePath)).toBe('new')
    result.finalizeAfterSuccessfulBoot()
    expect(existsSync(path.join(root, LEGACY_DATABASE_FILENAME))).toBe(false)
  })

  it('treats the new database as authoritative when both exist and leaves the legacy database untouched', () => {
    const root = temporaryRoot()
    fixture(path.join(root, DATABASE_FILENAME), 'new')
    fixture(path.join(root, LEGACY_DATABASE_FILENAME), 'old')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = prepareProductionDatabasePath(root)
    expect(marker(result.databasePath)).toBe('new')
    result.finalizeAfterSuccessfulBoot()
    expect(marker(path.join(root, LEGACY_DATABASE_FILENAME))).toBe('old')
    expect(warning).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(path.join(root, DATABASE_FILENAME_MIGRATION_JOURNAL), 'utf8')).status).toBe(
      'legacy-remains'
    )
  })

  it('completes a valid interrupted snapshot and removes invalid migration temporaries', () => {
    const root = temporaryRoot()
    const legacy = path.join(root, LEGACY_DATABASE_FILENAME)
    fixture(legacy, 'legacy')
    const valid = path.join(root, `${DATABASE_FILENAME}.migrating-valid`)
    fixture(valid, 'snapshot')
    const invalid = path.join(root, `${DATABASE_FILENAME}.migrating-invalid`)
    writeFileSync(invalid, 'not sqlite')

    const result = prepareProductionDatabasePath(root)
    expect(marker(result.databasePath)).toBe('snapshot')
    expect(existsSync(valid)).toBe(false)
    expect(existsSync(invalid)).toBe(false)
    result.finalizeAfterSuccessfulBoot()
  })

  it('never creates an empty new database when the only legacy database is corrupt', () => {
    const root = temporaryRoot()
    writeFileSync(path.join(root, LEGACY_DATABASE_FILENAME), 'corrupt')
    expect(() => prepareProductionDatabasePath(root)).toThrow()
    expect(existsSync(path.join(root, DATABASE_FILENAME))).toBe(false)
    expect(existsSync(path.join(root, LEGACY_DATABASE_FILENAME))).toBe(true)
  })

  it('returns the new default for a clean install', () => {
    const root = temporaryRoot()
    mkdirSync(root, { recursive: true })
    const result = prepareProductionDatabasePath(root)
    expect(result.databasePath).toBe(path.join(root, DATABASE_FILENAME))
    expect(existsSync(result.databasePath)).toBe(false)
  })
})
