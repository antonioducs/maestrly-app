import { DatabaseSync } from 'node:sqlite'
import { lstatSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { vmSchema, operationSchema, type Vm, type Operation } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { HOST_DB_VERSION, migrateToV2, migrateToV3, migrateToV4, migrateToV5 } from '../bots/migrations.js'
const now = () => new Date().toISOString()

/**
 * Before an in-place schema upgrade, keep a consistent private copy of the previous
 * database (WAL included). An older binary keeps refusing the newer schema; this copy is
 * what an operator restores explicitly. Existing copies are never overwritten or pruned.
 */
export function backupBeforeMigration(db: DatabaseSync, stateDirectory: string, version: number): string {
  const directory = join(stateDirectory, 'database-backups')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error('Invalid database backup directory')
  chmodSync(directory, 0o700)
  const target = join(directory, `host-v${version}-${now().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`)
  db.prepare('VACUUM INTO ?').run(target)
  chmodSync(target, 0o600)
  return target
}

/** One durable catalogue and an OS-released ownership lock per state directory. */
export class HostStore {
  db!: DatabaseSync
  hostId!: string
  private lock?: DatabaseSync
  private closed = false
  constructor(private readonly stateDirectory: string) {
    if (!['darwin', 'linux'].includes(process.platform) || typeof process.getuid !== 'function')
      throw new Error('Host storage requires POSIX ownership on macOS or Linux')
    this.acquireLock()
    try {
      const path = join(this.stateDirectory, 'host.sqlite')
      try {
        const stat = lstatSync(path)
        if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid?.())
          throw new Error('Invalid database file')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      this.db = new DatabaseSync(path)
      chmodSync(path, 0o600)
      this.db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'
      )
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version < 0 || version > HOST_DB_VERSION) throw new Error('Unsupported host database version')
      if (version >= 1 && version < HOST_DB_VERSION) backupBeforeMigration(this.db, this.stateDirectory, version)
      if (version < 1)
        this.db.exec(`CREATE TABLE IF NOT EXISTS vms(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, vm_id TEXT NOT NULL REFERENCES vms(id), key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
    PRAGMA user_version=1;`)
      migrateToV2(this.db)
      migrateToV3(this.db)
      migrateToV4(this.db)
      migrateToV5(this.db)
      this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run('hostId', randomUUID())
      this.hostId = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('hostId')!.value as string
      if (!/^[a-f0-9-]{36}$/.test(this.hostId)) throw new Error('Invalid persisted host identity')
      const integrity = this.db.prepare('PRAGMA quick_check').get()
      if (integrity?.quick_check !== 'ok') throw new Error('Host database integrity failure')
      this.vms()
      this.operations()
    } catch (error) {
      this.close()
      throw error
    }
  }
  private acquireLock() {
    // A separate SQLite database holds an OS-managed exclusive lock for this
    // service lifetime. The OS releases it on crashes; no stale PID/socket theft.
    const path = join(this.stateDirectory, 'owner.sqlite')
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
        throw new Error('Invalid ownership database')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const lock = new DatabaseSync(path)
    chmodSync(path, 0o600)
    try {
      lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;')
      this.lock = lock
    } catch {
      lock.close()
      throw new HostError('HOST_BUSY', 'Another service owns this state directory')
    }
  }
  /** Monotonic service generation used to fence guest sessions and turn leases. */
  nextGeneration(): number {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('hostGeneration') as { value: string } | undefined
    const next = (Number(row?.value ?? 0) || 0) + 1
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('hostGeneration', String(next))
    return next
  }
  private depth = 0
  /**
   * One IMMEDIATE transaction; calls made inside it (a finish within a cancel) run as savepoints:
   * their work commits with the enclosing transaction, and a failure rolls back only itself.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      const name = `nested_${this.depth}`
      this.db.exec(`SAVEPOINT ${name}`)
      this.depth++
      try {
        const result = fn()
        this.db.exec(`RELEASE ${name}`)
        return result
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${name}`)
        this.db.exec(`RELEASE ${name}`)
        throw error
      } finally {
        this.depth--
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth = 0
    }
  }
  event(kind: string, value: unknown) {
    this.db
      .prepare('INSERT INTO events(body) VALUES(?)')
      .run(JSON.stringify({ kind, value, createdAt: now() }))
  }
  saveVm(vm: Vm) {
    this.db
      .prepare('INSERT INTO vms(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(vm.id, JSON.stringify(vm))
    this.event('vm.changed', vm)
  }
  saveOperation(op: Operation) {
    this.db.prepare('UPDATE operations SET body=? WHERE id=?').run(JSON.stringify(op), op.id)
    this.event('operation.changed', op)
  }
  vms(): Vm[] {
    return this.db
      .prepare('SELECT body FROM vms ORDER BY rowid')
      .all()
      .map((row) => vmSchema.parse(JSON.parse(row.body as string)))
  }
  vm(id: string): Vm {
    const row = this.db.prepare('SELECT body FROM vms WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'VM not found')
    return vmSchema.parse(JSON.parse(row.body as string))
  }
  operations(): Operation[] {
    return this.db
      .prepare('SELECT body FROM operations ORDER BY rowid')
      .all()
      .map((row) => operationSchema.parse(JSON.parse(row.body as string)))
  }
  operation(id: string): Operation {
    const row = this.db.prepare('SELECT body FROM operations WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Operation not found')
    return operationSchema.parse(JSON.parse(row.body as string))
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.db?.close()
    this.lock?.close()
  }
}
