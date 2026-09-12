import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const DATABASE_FILENAME = 'maestrly-agents.db'
export const LEGACY_DATABASE_FILENAME = 'claude-agents.db'
export const DATABASE_FILENAME_MIGRATION_JOURNAL = 'database-filename-migration-v1.json'

const ESSENTIAL_TABLES = ['workspaces', 'conversations'] as const
const MIGRATING_PREFIX = `${DATABASE_FILENAME}.migrating-`

interface MigrationJournal {
  version: 1
  status: 'pending-backup' | 'completed' | 'legacy-remains'
  legacyPath: string
  databasePath: string
  snapshotHash?: string
  backupDir?: string
  warning?: string
  updatedAt: number
}

export interface DatabasePathMigrationResult {
  databasePath: string
  /** Run only after the new store opens and all migrations complete. */
  finalizeAfterSuccessfulBoot(): void
}

function quoteSqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function journalPath(userData: string): string {
  return path.join(userData, DATABASE_FILENAME_MIGRATION_JOURNAL)
}

function readJournal(userData: string): MigrationJournal | undefined {
  try {
    const parsed = JSON.parse(readFileSync(journalPath(userData), 'utf8')) as Partial<MigrationJournal>
    if (parsed.version !== 1 || typeof parsed.status !== 'string') return undefined
    return parsed as MigrationJournal
  } catch {
    return undefined
  }
}

function writeJournal(userData: string, journal: MigrationJournal): void {
  mkdirSync(userData, { recursive: true })
  const destination = journalPath(userData)
  const temporary = `${destination}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
  renameSync(temporary, destination)
}

function hashFile(file: string): string {
  const digest = createHash('sha256')
  const descriptor = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null)
      if (count === 0) break
      digest.update(buffer.subarray(0, count))
    }
  } finally {
    closeSync(descriptor)
  }
  return digest.digest('hex')
}

export function validateDatabaseSnapshot(file: string, requireEssentialTables = true): void {
  const candidate = new DatabaseSync(file, { readOnly: true })
  try {
    const check = candidate.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    const value = check ? Object.values(check)[0] : undefined
    if (value !== 'ok') throw new Error(`PRAGMA quick_check failed: ${String(value ?? 'no result')}`)
    if (requireEssentialTables) {
      const rows = candidate
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workspaces','conversations')")
        .all() as Array<{ name: string }>
      const names = new Set(rows.map((row) => row.name))
      const missing = ESSENTIAL_TABLES.filter((name) => !names.has(name))
      if (missing.length > 0) throw new Error(`database is missing essential tables: ${missing.join(', ')}`)
    }
  } finally {
    candidate.close()
  }
}

function backupLegacyDatabase(userData: string, journal: MigrationJournal): void {
  const legacy = journal.legacyPath
  if (!existsSync(legacy)) {
    writeJournal(userData, { ...journal, status: 'completed', updatedAt: Date.now() })
    return
  }
  const hash = journal.snapshotHash ?? hashFile(legacy)
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const backupDir = path.join(userData, 'database-backups', `${stamp}-${hash.slice(0, 12)}`)
  mkdirSync(backupDir, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${legacy}${suffix}`
    if (!existsSync(source)) continue
    const destination = path.join(backupDir, `${LEGACY_DATABASE_FILENAME}${suffix}`)
    if (!existsSync(destination)) renameSync(source, destination)
  }
  writeJournal(userData, {
    ...journal,
    status: 'completed',
    backupDir,
    updatedAt: Date.now(),
  })
}

function recoverInterruptedSnapshot(userData: string, destination: string): string | undefined {
  const candidates = readdirSync(userData, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(MIGRATING_PREFIX))
    .map((entry) => path.join(userData, entry.name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)

  let recovered: string | undefined
  for (const candidate of candidates) {
    try {
      validateDatabaseSnapshot(candidate)
      if (!recovered) {
        renameSync(candidate, destination)
        recovered = destination
      } else {
        rmSync(candidate, { force: true })
      }
    } catch {
      rmSync(candidate, { force: true })
    }
  }
  return recovered
}

/**
 * Resolve the production database path without replacing a legacy installation with an empty database.
 * Call after instance locking and before opening DatabaseSync.
 */
export function prepareProductionDatabasePath(userData: string): DatabasePathMigrationResult {
  mkdirSync(userData, { recursive: true })
  const databasePath = path.join(userData, DATABASE_FILENAME)
  const legacyPath = path.join(userData, LEGACY_DATABASE_FILENAME)
  let journal = readJournal(userData)
  let legacyExists = existsSync(legacyPath)
  let databaseExists = existsSync(databasePath)

  if (!databaseExists && legacyExists) {
    const recovered = recoverInterruptedSnapshot(userData, databasePath)
    databaseExists = Boolean(recovered)
    if (recovered) {
      const snapshotHash = hashFile(recovered)
      journal = {
        version: 1,
        status: 'pending-backup',
        legacyPath,
        databasePath,
        snapshotHash,
        updatedAt: Date.now(),
      }
      writeJournal(userData, journal)
    }
  }

  if (!databaseExists && legacyExists) {
    // Snapshot includes committed WAL data. Keep legacy files intact until successful boot moves database
    // and sidecars into recoverable backup.
    const source = new DatabaseSync(legacyPath)
    const temporary = path.join(userData, `${MIGRATING_PREFIX}${randomUUID()}`)
    try {
      const check = source.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
      if (Object.values(check ?? {})[0] !== 'ok') throw new Error('legacy database failed PRAGMA quick_check')
      const tables = source
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspaces','conversations')")
        .all() as Array<{ name: string }>
      if (tables.length !== ESSENTIAL_TABLES.length) throw new Error('legacy database is missing essential tables')
      source.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      source.exec(`VACUUM INTO ${quoteSqliteString(temporary)}`)
    } finally {
      source.close()
    }
    try {
      validateDatabaseSnapshot(temporary)
      renameSync(temporary, databasePath)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    databaseExists = true
    journal = {
      version: 1,
      status: 'pending-backup',
      legacyPath,
      databasePath,
      snapshotHash: hashFile(databasePath),
      updatedAt: Date.now(),
    }
    writeJournal(userData, journal)
  }

  legacyExists = existsSync(legacyPath)
  if (databaseExists && legacyExists) {
    validateDatabaseSnapshot(databasePath)
    const ownsPendingMigration =
      journal?.version === 1 && journal.status === 'pending-backup' && journal.databasePath === databasePath
    if (!ownsPendingMigration) {
      const warning =
        'Both maestrly-agents.db and claude-agents.db exist; maestrly-agents.db is authoritative and the legacy database was left untouched.'
      console.warn(`[database] ${warning}`)
      journal = {
        version: 1,
        status: 'legacy-remains',
        legacyPath,
        databasePath,
        warning,
        updatedAt: Date.now(),
      }
      writeJournal(userData, journal)
    }
  }

  const pending = journal?.status === 'pending-backup' ? journal : undefined
  return {
    databasePath,
    finalizeAfterSuccessfulBoot() {
      if (pending) backupLegacyDatabase(userData, pending)
    },
  }
}
