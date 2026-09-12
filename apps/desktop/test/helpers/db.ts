import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initStore, closeStore } from '../../src/main/store'

/**
 * Test database: a SQLite FILE in a unique temporary directory per call, rather than `:memory:`,
 * exercising real WAL, `PRAGMA foreign_keys=ON`, migrations, and CASCADE with the production engine.
 * Pair `beforeEach(freshDb)` with `afterEach(closeDb)` to give each test a fresh, isolated database.
 */
let currentDir: string | null = null
let currentDbPath: string | null = null

/** Create a temporary directory and initialize the store (schema, migrations, and backfill). */
export function freshDb(): void {
  closeDb() // Defensively close and clean up any previous database.
  currentDir = mkdtempSync(path.join(os.tmpdir(), 'agents-db-'))
  currentDbPath = path.join(currentDir, 'test.db')
  initStore(currentDbPath)
}

/** Simulate a process restart while retaining the same SQLite file. */
export function restartDb(): void {
  if (!currentDbPath) throw new Error('freshDb must run before restartDb')
  closeStore()
  initStore(currentDbPath)
}

/** Close the SQLite handle (release WAL/SHM) and remove the temporary directory; no-op if no database is open. */
export function closeDb(): void {
  closeStore()
  if (currentDir) {
    rmSync(currentDir, { recursive: true, force: true })
    currentDir = null
    currentDbPath = null
  }
}
