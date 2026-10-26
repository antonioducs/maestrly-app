import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, SCHEMA_VERSION } from '../src/store/db.js'
import { tempDir } from './helpers.js'

/** The two tables version 2 changes, exactly as version 1 created them, with one row each. */
const V1 = `
CREATE TABLE host_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO host_meta VALUES ('schema_version', '1'), ('capability_key', 'a2V5');
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('local', 'device', 'bot')), owner_id TEXT NOT NULL,
  workspace_id TEXT, conversation_id TEXT, conversation_title TEXT, current_version INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'people', 'link')),
  link_expires_at INTEGER, access_code_hash TEXT, comments_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE events (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('device_added', 'access_requested', 'invite_declined', 'comment_added')),
  data_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, seen_at INTEGER);
CREATE INDEX events_unseen ON events (artifact_id, seen_at);
INSERT INTO artifacts (id, title, owner_kind, owner_id, current_version, created_at, updated_at)
  VALUES ('AAAAAAAAAAAAAAAAAAAAAA', 'Old', 'local', 'local', 1, 1, 1);
INSERT INTO events VALUES ('E1', 'AAAAAAAAAAAAAAAAAAAAAA', 'comment_added', '{"name":"Maria"}', 10, NULL);`

let cleanup = () => {}
afterEach(() => cleanup())
const fileIn = () => {
  const temp = tempDir()
  cleanup = temp.cleanup
  return path.join(temp.dir, 'artifacts.sqlite')
}
const meta = (db: DatabaseSync, key: string) =>
  (db.prepare('SELECT value FROM host_meta WHERE key = ?').get(key) as { value: string }).value
const addEvent = (db: DatabaseSync, id: string, kind: string) =>
  db
    .prepare(`INSERT INTO events (id, artifact_id, kind, created_at) VALUES (?, 'AAAAAAAAAAAAAAAAAAAAAA', ?, 20)`)
    .run(id, kind)

describe('host schema', () => {
  it('creates a new database at the current version', () => {
    const db = openDatabase(fileIn())
    expect(meta(db, 'schema_version')).toBe(String(SCHEMA_VERSION))
    db.prepare(
      `INSERT INTO artifacts (id, title, owner_kind, owner_id, current_version, created_at, updated_at)
       VALUES ('AAAAAAAAAAAAAAAAAAAAAA', 'New', 'local', 'local', 1, 1, 1)`
    ).run()
    expect({ ...(db.prepare('SELECT responses_enabled FROM artifacts').get() as object) }).toEqual({
      responses_enabled: 1,
    })
    addEvent(db, 'E2', 'response_submitted')
    db.close()
  })

  it('migrates a version 1 database and keeps its rows', () => {
    const file = fileIn()
    const old = new DatabaseSync(file)
    old.exec(V1)
    old.close()
    const db = openDatabase(file)
    expect(meta(db, 'schema_version')).toBe('2')
    expect(meta(db, 'capability_key')).toBe('a2V5')
    expect({ ...(db.prepare('SELECT responses_enabled FROM artifacts').get() as object) }).toEqual({
      responses_enabled: 1,
    })
    expect(
      db
        .prepare('SELECT id, kind, data_json FROM events')
        .all()
        .map((row) => ({ ...row }))
    ).toEqual([{ id: 'E1', kind: 'comment_added', data_json: '{"name":"Maria"}' }])
    addEvent(db, 'E2', 'response_submitted')
    expect(() => addEvent(db, 'E3', 'unknown')).toThrow()
    expect(db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE name = 'events_unseen'`).get()).toBeDefined()
    expect(db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE name = 'responses'`).get()).toBeDefined()
    db.close()
  })

  it('never lowers the version of a database written by a newer host', () => {
    const file = fileIn()
    openDatabase(file).close()
    const newer = new DatabaseSync(file)
    newer.prepare(`UPDATE host_meta SET value = '9' WHERE key = 'schema_version'`).run()
    newer.close()
    const db = openDatabase(file)
    expect(meta(db, 'schema_version')).toBe('9')
    db.close()
  })
})
