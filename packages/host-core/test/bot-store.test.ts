import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HostStore } from '../src/persistence/store.js'
import { HOST_DB_VERSION, migrateToV2 } from '../src/bots/migrations.js'
import { BotRepository } from '../src/bots/repository.js'
import { directory } from './bot-helpers.js'
const skipWindows = process.platform === 'win32'
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function v1Database() {
  const dir = await directory()
  dirs.push(dir)
  const db = new DatabaseSync(join(dir, 'host.sqlite'))
  db.exec(`CREATE TABLE vms(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE operations(id TEXT PRIMARY KEY, vm_id TEXT NOT NULL REFERENCES vms(id), key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
    PRAGMA user_version=1;`)
  const hostId = randomUUID()
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('hostId', hostId)
  const vm = {
    id: randomUUID(), identity: randomUUID(), name: 'legacy', imageId: 'i', runtimeId: 'r', cpus: 2, memoryMiB: 2048, diskGiB: 12,
    revision: 3, state: 'stopped', desiredState: 'stopped', health: 'unknown', startupPolicy: 'manual', diskRetained: true, createdAt: 'now', updatedAt: 'now',
  }
  db.prepare('INSERT INTO vms(id,body) VALUES(?,?)').run(vm.id, JSON.stringify(vm))
  db.prepare('INSERT INTO operations(id,vm_id,key,fingerprint,request,body) VALUES(?,?,?,?,?,?)').run('op1', vm.id, 'k1', 'f', '{}', JSON.stringify({ id: 'op1', vmId: vm.id, method: 'vm.start', status: 'succeeded', createdAt: 'now', updatedAt: 'now' }))
  db.close()
  return { dir, hostId, vm }
}
describe.skipIf(skipWindows)('bot schema migration', () => {
  it('migrates 1→2 transactionally preserving host identity, VMs and operations', async () => {
    const { dir, hostId, vm } = await v1Database()
    const store = new HostStore(dir)
    try {
      expect(store.hostId).toBe(hostId)
      expect(store.vms().map((x) => x.id)).toEqual([vm.id])
      expect(store.operations().map((x) => x.id)).toEqual(['op1'])
      expect((store.db.prepare('PRAGMA user_version').get() as any).user_version).toBe(HOST_DB_VERSION)
      const repo = new BotRepository(store)
      expect(repo.bots()).toEqual([])
    } finally {
      store.close()
    }
  })
  it('refuses a future schema and leaves version 1 intact when the migration aborts', async () => {
    const { dir } = await v1Database()
    const db = new DatabaseSync(join(dir, 'host.sqlite'))
    // A conflicting table makes CREATE fail; the transaction must roll back completely.
    db.exec('CREATE TABLE bot_turns(x TEXT)')
    expect(() => migrateToV2(db)).toThrow()
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBe(1)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='bots'").get()).toBeUndefined()
    db.exec('DROP TABLE bot_turns; PRAGMA user_version=99;')
    db.close()
    expect(() => new HostStore(dir)).toThrow('Unsupported host database version')
  })
  it('allows bots to share a VM while enforcing one active turn per bot', async () => {
    const dir = await directory()
    dirs.push(dir)
    const store = new HostStore(dir)
    try {
      const repo = new BotRepository(store)
      const now = new Date().toISOString()
      const base = { purpose: '', instructions: '', status: 'ready' as const, runtimeState: 'ready' as const, accountState: 'connected' as const, permissionMode: 'ask' as const, revision: 0, createdAt: now, updatedAt: now }
      repo.saveBot({ id: 'a', name: 'A', vmId: 'vm1', ...base })
      repo.saveBot({ id: 'b', name: 'B', vmId: 'vm1', ...base })
      expect(repo.botsByVm('vm1')).toHaveLength(2)
      repo.saveBot({ id: 'a', name: 'A', vmId: 'vm1', ...base, status: 'archived' })
      repo.saveBot({ id: 'b', name: 'B', vmId: 'vm1', ...base })
      repo.saveConversation({ id: 'c', botId: 'b', title: '', contextRevision: 0, lastSequence: 0, revision: 0, createdAt: now, updatedAt: now })
      const turn = { botId: 'b', conversationId: 'c', messageId: 'm', status: 'running' as const, generation: 1, revision: 0, createdAt: now, updatedAt: now }
      repo.saveTurn({ id: 't1', ...turn })
      expect(() => repo.saveTurn({ id: 't2', ...turn })).toThrow(/BOT_BUSY|already/)
      repo.saveTurn({ id: 't1', ...turn, status: 'succeeded' })
      repo.saveTurn({ id: 't2', ...turn })
      expect(repo.activeTurn('b')?.id).toBe('t2')
    } finally {
      store.close()
    }
  })
  it('deduplicates runtime events per bot and pages by byte budget', async () => {
    const dir = await directory()
    dirs.push(dir)
    const store = new HostStore(dir)
    try {
      const repo = new BotRepository(store)
      const now = new Date().toISOString()
      const base = { purpose: '', instructions: '', status: 'ready' as const, runtimeState: 'ready' as const, accountState: 'connected' as const, permissionMode: 'ask' as const, revision: 0, createdAt: now, updatedAt: now }
      repo.saveBot({ id: 'a', name: 'A', ...base })
      expect(repo.appendEvent({ botId: 'a', kind: 'diagnostic', summary: 'one', runtimeEventId: 'e1', createdAt: now })?.seq).toBe(1)
      expect(repo.appendEvent({ botId: 'a', kind: 'diagnostic', summary: 'dup', runtimeEventId: 'e1', createdAt: now })).toBeUndefined()
      for (let i = 0; i < 20; i++) repo.appendEvent({ botId: 'a', kind: 'assistant.delta', summary: 'x'.repeat(300), createdAt: now })
      const page = repo.events('a', 0, 100, 2000)
      expect(page.hasMore).toBe(true)
      expect(page.events.length).toBeGreaterThan(0)
      expect(page.events.length).toBeLessThan(21)
      const rest = repo.events('a', page.events.at(-1)!.seq, 100, 1024 * 1024)
      expect(rest.events.length + page.events.length).toBe(21)
      expect(rest.hasMore).toBe(false)
    } finally {
      store.close()
    }
  })
})
