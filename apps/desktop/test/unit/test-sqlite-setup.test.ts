import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'

// The test setup (test/setup.ts) opens every SQLite connection without disk flushes; these pin what it may change.
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sqlite-setup-'))
  dirs.push(dir)
  return dir
}

it('opens test connections without disk flushes, in WAL mode when asked', () => {
  const db = new DatabaseSync(path.join(temp(), 'test.db'))
  db.exec('PRAGMA journal_mode = WAL')
  expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 0 })
  expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
  db.close()
})

it('opens a file that is not a database and fails on first use, as the driver does', () => {
  const file = path.join(temp(), 'corrupt.db')
  writeFileSync(file, 'not a database '.repeat(100))
  // Failing in the constructor would leave the connection open where the code under test cannot close it.
  const db = new DatabaseSync(file)
  expect(() => db.prepare('SELECT 1 FROM sqlite_master').all()).toThrow('file is not a database')
  db.close()
})
