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

/** The artifacts table exactly as version 2 created it, with one row. */
const V2 = `
CREATE TABLE host_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO host_meta VALUES ('schema_version', '2'), ('capability_key', 'a2V5');
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('local', 'device', 'bot')), owner_id TEXT NOT NULL,
  workspace_id TEXT, conversation_id TEXT, conversation_title TEXT, current_version INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'people', 'link')),
  link_expires_at INTEGER, access_code_hash TEXT, comments_enabled INTEGER NOT NULL DEFAULT 1,
  responses_enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO artifacts (id, title, owner_kind, owner_id, current_version, created_at, updated_at)
  VALUES ('AAAAAAAAAAAAAAAAAAAAAA', 'Old', 'local', 'local', 1, 1, 1);`

/** The artifacts table and board elements exactly as version 3 created them, with one row. */
const V3 = `
CREATE TABLE host_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO host_meta VALUES ('schema_version', '3'), ('capability_key', 'a2V5');
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('local', 'device', 'bot')), owner_id TEXT NOT NULL,
  workspace_id TEXT, conversation_id TEXT, conversation_title TEXT, current_version INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'people', 'link')),
  link_expires_at INTEGER, access_code_hash TEXT, comments_enabled INTEGER NOT NULL DEFAULT 1,
  responses_enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'whiteboard')),
  board_revision INTEGER NOT NULL DEFAULT 0,
  board_editors TEXT NOT NULL DEFAULT 'owner' CHECK (board_editors IN ('owner', 'people')));
CREATE TABLE board_elements (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  id TEXT NOT NULL, rev INTEGER NOT NULL, by TEXT NOT NULL CHECK (by IN ('agent', 'person')),
  element_json TEXT NOT NULL, PRIMARY KEY (artifact_id, id));
CREATE INDEX board_elements_rev ON board_elements (artifact_id, rev);
INSERT INTO artifacts (id, title, owner_kind, owner_id, current_version, created_at, updated_at)
  VALUES ('AAAAAAAAAAAAAAAAAAAAAA', 'Old', 'local', 'local', 1, 1, 1);`

/** A version 4 database with its `comments` table (before `suggestion_json`) and an existing comment row. */
const V4 = `
CREATE TABLE host_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO host_meta VALUES ('schema_version', '4'), ('capability_key', 'a2V5');
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('local', 'device', 'bot')), owner_id TEXT NOT NULL,
  workspace_id TEXT, conversation_id TEXT, conversation_title TEXT, current_version INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'people', 'link')),
  link_expires_at INTEGER, access_code_hash TEXT, comments_enabled INTEGER NOT NULL DEFAULT 1,
  responses_enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'whiteboard')),
  board_revision INTEGER NOT NULL DEFAULT 0,
  board_editors TEXT NOT NULL DEFAULT 'owner' CHECK (board_editors IN ('owner', 'people')),
  versions_visible INTEGER NOT NULL DEFAULT 0);
CREATE TABLE principals (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invited', 'approved', 'guest')),
  name TEXT NOT NULL DEFAULT '', invite_token_hash TEXT UNIQUE, invite_expires_at INTEGER,
  created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE comments (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('owner', 'agent', 'invited', 'approved', 'guest')),
  principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL, body TEXT NOT NULL, anchor_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at INTEGER NOT NULL, deleted_at INTEGER);
INSERT INTO artifacts (id, title, owner_kind, owner_id, current_version, created_at, updated_at)
  VALUES ('AAAAAAAAAAAAAAAAAAAAAA', 'Old', 'local', 'local', 1, 1, 1);
INSERT INTO comments (id, artifact_id, version, parent_id, author_kind, principal_id, author_name, body, anchor_json, status, created_at)
  VALUES ('CCCCCCCCCCCCCCCCCCCCCC', 'AAAAAAAAAAAAAAAAAAAAAA', 1, NULL, 'owner', NULL, 'Antonio', 'Pre-v5 comment', NULL, 'open', 100);`

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
    expect(meta(db, 'schema_version')).toBe(String(SCHEMA_VERSION))
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

  it('migrates a version 2 database to whiteboards and keeps its artifacts as pages', () => {
    const file = fileIn()
    const old = new DatabaseSync(file)
    old.exec(V2)
    old.close()
    const db = openDatabase(file)
    expect(meta(db, 'schema_version')).toBe(String(SCHEMA_VERSION))
    expect({
      ...(db.prepare('SELECT kind, board_editors, board_revision, versions_visible FROM artifacts').get() as object),
    }).toEqual({ kind: 'page', board_editors: 'owner', board_revision: 0, versions_visible: 0 })
    expect(() => db.prepare(`UPDATE artifacts SET kind = 'slides'`).run()).toThrow()
    expect(() => db.prepare(`UPDATE artifacts SET board_editors = 'anyone'`).run()).toThrow()
    expect(db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE name = 'board_elements_rev'`).get()).toBeDefined()

    const other = tempDir()
    const fresh = openDatabase(path.join(other.dir, 'artifacts.sqlite'))
    // Added columns come last in a migrated table, so positions differ; names, types and defaults may not.
    const columns = (target: DatabaseSync, table: string) =>
      target
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(({ cid: _, ...row }) => row)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    expect(columns(db, 'artifacts')).toEqual(columns(fresh, 'artifacts'))
    expect(columns(db, 'board_elements')).toEqual(columns(fresh, 'board_elements'))
    fresh.close()
    other.cleanup()
    db.close()
  })

  it('migrates a version 3 database with earlier versions hidden by default', () => {
    const file = fileIn()
    const old = new DatabaseSync(file)
    old.exec(V3)
    old.close()
    const db = openDatabase(file)
    expect(meta(db, 'schema_version')).toBe(String(SCHEMA_VERSION))
    expect({ ...(db.prepare('SELECT versions_visible FROM artifacts').get() as object) }).toEqual({
      versions_visible: 0,
    })

    const other = tempDir()
    const fresh = openDatabase(path.join(other.dir, 'artifacts.sqlite'))
    const columns = (target: DatabaseSync, table: string) =>
      target
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(({ cid: _, ...row }) => row)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    expect(columns(db, 'artifacts')).toEqual(columns(fresh, 'artifacts'))
    fresh.close()
    other.cleanup()
    db.close()
  })

  it('migrates a version 4 database to schema 5, preserving existing comments and adding suggestion_json', () => {
    const file = fileIn()
    const old = new DatabaseSync(file)
    old.exec(V4)
    old.close()
    const db = openDatabase(file)
    expect(meta(db, 'schema_version')).toBe('5')
    expect(meta(db, 'schema_version')).toBe(String(SCHEMA_VERSION))

    const existing = db
      .prepare('SELECT id, body, suggestion_json FROM comments WHERE id = ?')
      .get('CCCCCCCCCCCCCCCCCCCCCC') as Record<string, unknown>
    expect({ ...existing }).toEqual({
      id: 'CCCCCCCCCCCCCCCCCCCCCC',
      body: 'Pre-v5 comment',
      suggestion_json: null,
    })

    const suggestionJson = JSON.stringify({
      file: 'tokens.css',
      changes: [{ name: '--color-bg', from: '#ffffff', to: '#000000' }],
      appliedVersion: null,
    })
    db.prepare(
      `INSERT INTO comments (id, artifact_id, version, parent_id, author_kind, principal_id, author_name, body, anchor_json, suggestion_json, status, created_at)
       VALUES ('DDDDDDDDDDDDDDDDDDDDDD', 'AAAAAAAAAAAAAAAAAAAAAA', 1, NULL, 'invited', NULL, 'Maria', 'Try dark', NULL, ?, 'open', 200)`
    ).run(suggestionJson)
    const inserted = db.prepare('SELECT suggestion_json FROM comments WHERE id = ?').get('DDDDDDDDDDDDDDDDDDDDDD') as {
      suggestion_json: string
    }
    expect(JSON.parse(inserted.suggestion_json)).toEqual({
      file: 'tokens.css',
      changes: [{ name: '--color-bg', from: '#ffffff', to: '#000000' }],
      appliedVersion: null,
    })

    const other = tempDir()
    const fresh = openDatabase(path.join(other.dir, 'artifacts.sqlite'))
    const columns = (target: DatabaseSync, table: string) =>
      target
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(({ cid: _, ...row }) => row)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    expect(columns(db, 'comments')).toEqual(columns(fresh, 'comments'))
    fresh.close()
    other.cleanup()
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
