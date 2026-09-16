import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { migrateToV2, migrateToV3, migrateToV4, migrateToV5, HOST_DB_VERSION } from '../src/bots/migrations.js'
import { HostStore } from '../src/persistence/store.js'
import { BotRepository } from '../src/bots/repository.js'
import { DesktopRepository } from '../src/desktop/repository.js'
import { readdirSync, statSync } from 'node:fs'

it('keeps a private consistent copy of schema 4 before migrating in place, once', async () => {
  const dir = await realpath(await mkdtemp('/tmp/mbdb-'))
  const db = new DatabaseSync(join(dir, 'host.sqlite'))
  db.exec(`CREATE TABLE vms(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE operations(id TEXT PRIMARY KEY, vm_id TEXT NOT NULL REFERENCES vms(id), key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
    PRAGMA user_version=1;`)
  migrateToV2(db)
  migrateToV3(db)
  migrateToV4(db)
  const hostId = randomUUID()
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('hostId', hostId)
  db.close()
  const store = new HostStore(dir)
  expect(store.hostId).toBe(hostId)
  store.close()
  const backups = join(dir, 'database-backups')
  const copies = readdirSync(backups)
  expect(copies).toHaveLength(1)
  expect(copies[0]).toMatch(/^host-v4-.+\.sqlite$/)
  expect(statSync(backups).mode & 0o777).toBe(0o700)
  expect(statSync(join(backups, copies[0])).mode & 0o777).toBe(0o600)
  const copy = new DatabaseSync(join(backups, copies[0]), { readOnly: true })
  expect(copy.prepare('PRAGMA user_version').get()?.user_version).toBe(4)
  expect(copy.prepare('SELECT value FROM metadata WHERE key=?').get('hostId')?.value).toBe(hostId)
  copy.close()
  // Already current: reopening makes no further copy.
  new HostStore(dir).close()
  expect(readdirSync(backups)).toHaveLength(1)
})

function schema4() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE vms(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE operations(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE events(seq INTEGER PRIMARY KEY,body TEXT); PRAGMA user_version=1;')
  migrateToV2(db)
  db.prepare('INSERT INTO bots VALUES(?,?,?,?)').run('bot-a', 'vm', 'ready', JSON.stringify({ id: 'bot-a', vmId: 'vm', status: 'ready' }))
  db.prepare('INSERT INTO bot_bindings VALUES(?,?,?)').run('bot-a', 'vm', JSON.stringify({ botId: 'bot-a', vmId: 'vm' }))
  migrateToV3(db)
  migrateToV4(db)
  db.prepare('INSERT INTO shared_accounts(id,body) VALUES(?,?)').run('account', '{"name":"Conta"}')
  return db
}
const tables = ['metadata', 'vms', 'operations', 'events', 'bots', 'bot_bindings', 'bot_sessions', 'bot_vm_sessions', 'shared_accounts']
it('migrates schema 4 to 5 additively, idempotently and without touching existing rows', () => {
  const db = schema4()
  try {
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())
    migrateToV5(db)
    expect(HOST_DB_VERSION).toBe(5)
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(5)
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before)
    migrateToV5(db)
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(5)
    // One continuation per interrupted turn, and continuation turns are unique.
    const session = String(db.prepare('SELECT id FROM bot_sessions').get()!.id)
    const insert = db.prepare('INSERT INTO bot_desktop_operations(id,key,fingerprint,session_id,kind,resume_of_turn_id,continuation_turn_id,body) VALUES(?,?,?,?,?,?,?,?)')
    insert.run('o1', 'k1', 'f', session, 'return', 'turn-1', 'cont-1', '{}')
    expect(() => insert.run('o2', 'k2', 'f', session, 'return', 'turn-1', 'cont-2', '{}')).toThrow(/UNIQUE/)
    expect(() => insert.run('o3', 'k3', 'f', session, 'return', 'turn-2', 'cont-1', '{}')).toThrow(/UNIQUE/)
    insert.run('o4', 'k4', 'f', session, 'return', 'turn-1', null, '{}')
  } finally {
    db.close()
  }
})
it('rolls back an interrupted migration and leaves schema 4 intact', () => {
  const db = schema4()
  try {
    db.exec('CREATE TABLE bot_desktop_operations(conflicting TEXT)')
    expect(() => migrateToV5(db)).toThrow()
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(4)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='bot_desktop_control'").get()).toBeUndefined()
  } finally {
    db.close()
  }
})
it('an older binary refuses a newer schema instead of converting it', async () => {
  const dir = await realpath(await mkdtemp('/tmp/mbds-'))
  const store = new HostStore(dir)
  store.close()
  const db = new DatabaseSync(join(dir, 'host.sqlite'))
  db.exec('PRAGMA user_version=6')
  db.close()
  expect(() => new HostStore(dir)).toThrow('Unsupported host database version')
})
async function repository() {
  const dir = await realpath(await mkdtemp('/tmp/mbdr-'))
  const store = new HostStore(dir)
  const repo = new BotRepository(store)
  const now = new Date().toISOString()
  repo.saveBot({ id: 'bot-a', name: 'A', purpose: '', instructions: '', status: 'ready', vmId: 'vm', runtimeState: 'ready', accountState: 'connected', permissionMode: 'ask', revision: 0, createdAt: now, updatedAt: now })
  const session = { id: randomUUID(), botId: 'bot-a', vmId: 'vm', state: 'ready' as const, transport: 'managed' as const, generation: 1, revision: 0, createdAt: now, updatedAt: now }
  repo.saveSession(session)
  const desktop = new DesktopRepository(repo)
  desktop.ensure(session)
  return { store, repo, desktop, session }
}
it('transitions are idempotent by key, fenced by revision and raise the epoch strictly', async () => {
  const { store, desktop, session } = await repository()
  try {
    const intent = { kind: 'acquire' as const, mode: 'acquiring' as const, viewId: 'v1' }
    const first = desktop.beginTransition(session.id, 0, 'key-1', 'print-1', intent)
    expect(first).toMatchObject({ existing: false, record: { controlEpoch: 1, revision: 1, mode: 'acquiring' } })
    expect(desktop.beginTransition(session.id, 0, 'key-1', 'print-1', intent)).toMatchObject({ existing: true, operation: { id: first.operation.id } })
    expect(() => desktop.beginTransition(session.id, 0, 'key-1', 'print-2', intent)).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }))
    // Two concurrent acquisitions from the same revision: only one wins.
    expect(() => desktop.beginTransition(session.id, 0, 'key-2', 'print-3', intent)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    const done = desktop.commitTransition(first.operation.id, { phase: 'completed', status: 'succeeded' }, (current) => ({ ...current, mode: 'human' }))
    expect(done.status).toBe('succeeded')
    expect(desktop.get(session.id)).toMatchObject({ mode: 'human', controlEpoch: 1, revision: 2 })
    expect(() => desktop.save({ ...desktop.get(session.id)!, controlEpoch: 0 })).toThrow(expect.objectContaining({ code: 'HANDOFF_UNCERTAIN' }))
    expect(desktop.held('bot-a')).toBe(true)
  } finally {
    store.close()
  }
})
