import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  FLEET_ENVIRONMENT_LIMITS,
  fleetErrorCodeSchema,
  type FleetRoutineRun,
  type FleetOwnerMemoryEntry,
  type FleetActivityEntry,
  type FleetActivityKind,
  type FleetBot,
  type FleetBotSetup,
  type FleetCompactionConfig,
  type FleetEnvironmentSetup,
  type FleetLifecycle,
  type FleetPeerMessage,
  type FleetRoutine,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'

export type StoredRoutineRun = FleetRoutineRun & { inputId: string }

type Row = Record<string, unknown>
export type Device = {
  id: string
  name: string
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}
/** One container shared by up to `FLEET_ENVIRONMENT_LIMITS.botsMax` bots, as the gateway records it. */
export type StoredEnvironment = {
  id: string
  name: string
  lifecycle: FleetLifecycle
  setup: FleetEnvironmentSetup
  containerName: string
  volumeName: string
  /** The limit the owner set for the container; null uses the gateway's default. */
  memoryLimitBytes: number | null
  /** The compaction model of its bots that have none of their own; null when the owner has not chosen one. */
  compaction: FleetCompactionConfig | null
  /** When the owner asked to update it once its bots are idle; null when no update waits. */
  updateRequestedAt: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}
export type EnvironmentChanges = Partial<
  Pick<StoredEnvironment, 'name' | 'lifecycle' | 'setup' | 'memoryLimitBytes' | 'compaction' | 'updateRequestedAt'>
>
/** What an environment's container is started with: the token of its control API and the password of its keyring. */
export type EnvironmentSecrets = { controlToken: string; keyringPassword: string }
/** The token a bot calls the gateway with, and its digest. */
export type BotGatewaySecrets = { gatewayToken: string; gatewayTokenSha256: string }
/** A bot's gateway token together with the control token and keyring password of its environment. */
export type BotSecrets = EnvironmentSecrets & BotGatewaySecrets
/** Where a bot runs: its environment and its display slot there. */
export type BotPlacement = { environmentId: string; slot: number; archivedWithEnvironment: boolean }
export type ArchivedBotRecord = { bot: FleetBot; archivedAt: string; archivedWithEnvironment: boolean }

const now = () => new Date().toISOString()
const SLOTS = FLEET_ENVIRONMENT_LIMITS.botsMax
/** The names of a bot's container and home volume before environments; its migrated environment keeps them. */
export const legacyContainerName = (botId: string) => 'maestrly-bot-' + botId
export const legacyVolumeName = (botId: string) => legacyContainerName(botId) + '-home'
const environmentSteps = new Map<unknown, FleetEnvironmentSetup['step']>([
  ['container', 'container'],
  ['desktop', 'desktop'],
  // A bot reaches its profile step once its desktop answers: its environment has finished its own setup.
  ['profile', 'ready'],
  ['ready', 'ready'],
  ['failed', 'failed'],
])
/** The environment setup matching the setup a bot recorded for its container before environments. */
function environmentSetupOf(setup: unknown, lifecycle: string): FleetEnvironmentSetup {
  const fields = typeof setup === 'object' && setup !== null ? (setup as Record<string, unknown>) : {}
  const step =
    environmentSteps.get(fields.step) ??
    (lifecycle === 'creating' ? 'container' : lifecycle === 'failed' ? 'failed' : 'ready')
  const error = fleetErrorCodeSchema.safeParse(fields.error)
  return {
    step,
    error: error.success ? error.data : null,
    errorMessage: typeof fields.errorMessage === 'string' ? fields.errorMessage : null,
  }
}
/** Whether two parsed JSON values are equal, whatever the order of their object keys. */
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : typeof value === 'object' && value !== null
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
          )
        : value
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}
const environmentCreating: FleetEnvironmentSetup = { step: 'container', error: null, errorMessage: null }
const botCreating: FleetBotSetup = { step: 'container', error: null, errorMessage: null }
const botInstalling: FleetBotSetup = { step: 'profile', error: null, errorMessage: null }
export class Store {
  readonly db: DatabaseSync
  private depth = 0
  constructor(dataDir: string) {
    const file = path.join(dataDir, 'gateway.sqlite')
    this.db = new DatabaseSync(file)
    if (!existsSync(file)) throw new Error('Failed to create gateway database')
    chmodSync(file, 0o600)
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000')
      this.migrate()
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  getMetaJson(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as Row | undefined
    return row ? JSON.parse(String(row.value)) : null
  }
  setMetaJson(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value))
  }
  close() {
    this.db.close()
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth--
    }
  }
  private migrate() {
    // Rebuilding a table that others refer to needs foreign key enforcement off, which SQLite only allows outside a
    // transaction; the checks before the commit still verify every reference.
    this.db.exec('PRAGMA foreign_keys=OFF')
    try {
      this.transaction(() => this.migrateSchema())
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON')
    }
  }
  private migrateSchema() {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const version = Number(
      (this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as Row | undefined)?.value ?? 0
    )
    if (version > 8) throw new Error('Gateway database schema is newer than this binary')
    if (version === 0) {
      this.db.exec(`
        CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT);
        CREATE TABLE pairing_codes (code_sha256 TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT, attempts INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL, tint TEXT NOT NULL, ceiling TEXT NOT NULL, selection_json TEXT, talks_to_json TEXT NOT NULL, paused INTEGER NOT NULL, lifecycle TEXT NOT NULL, setup_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
        CREATE TABLE bot_secrets (bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, control_token TEXT NOT NULL, gateway_token TEXT NOT NULL, gateway_token_sha256 TEXT NOT NULL UNIQUE, keyring_password TEXT NOT NULL);
        CREATE TABLE routines (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), title TEXT NOT NULL, prompt TEXT NOT NULL, schedule_json TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at TEXT, last_run_at TEXT, last_outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT 'owner', last_input_id TEXT);
        CREATE TABLE activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, bot_id TEXT REFERENCES bots(id), kind TEXT NOT NULL, summary TEXT, data_json TEXT NOT NULL);
        CREATE TABLE peer_messages (id TEXT PRIMARY KEY, at TEXT NOT NULL, from_bot TEXT NOT NULL, to_bot TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL);
        CREATE TABLE pending_deliveries (message_id TEXT PRIMARY KEY REFERENCES peer_messages(id), to_bot TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE owner_messages (bot_id TEXT PRIMARY KEY, at TEXT NOT NULL);
        CREATE TABLE pair_blocks (pair_key TEXT PRIMARY KEY, blocked_until TEXT NOT NULL);
        CREATE TABLE idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, status INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,key));
        CREATE INDEX idx_activity_seq ON activity(seq);
        CREATE INDEX idx_idempotency_created ON idempotency(created_at);
      `)
      this.db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','3')").run()
    }
    if (version === 1) {
      this.db.exec('ALTER TABLE bot_secrets ADD COLUMN keyring_password TEXT')
      this.db.exec(
        'CREATE TABLE owner_messages (bot_id TEXT PRIMARY KEY, at TEXT NOT NULL); CREATE TABLE pair_blocks (pair_key TEXT PRIMARY KEY, blocked_until TEXT NOT NULL)'
      )
      for (const row of this.db.prepare('SELECT bot_id FROM bot_secrets').all() as Row[])
        this.db
          .prepare('UPDATE bot_secrets SET keyring_password=? WHERE bot_id=?')
          .run(randomBytes(32).toString('base64url'), row.bot_id as string)
      this.db.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run()
    }
    if (version === 1 || version === 2) {
      this.db.exec(
        "ALTER TABLE routines ADD COLUMN created_by TEXT NOT NULL DEFAULT 'owner'; ALTER TABLE routines ADD COLUMN last_input_id TEXT"
      )
      this.db.prepare("UPDATE meta SET value='3' WHERE key='schema_version'").run()
    }
    if (version <= 3) {
      const columns = this.db.prepare('PRAGMA table_info(bots)').all() as Row[]
      if (columns.length && !columns.some((column) => column.name === 'compaction_json'))
        this.db.exec('ALTER TABLE bots ADD COLUMN compaction_json TEXT')
      this.db.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run()
    }
    if (version <= 4) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS owner_memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL, author_kind TEXT NOT NULL, author_bot_id TEXT, author_name TEXT, origin TEXT, replaces_id TEXT, replaced_by_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_owner_memories_status ON owner_memories(status, created_at);
        CREATE TABLE IF NOT EXISTS routine_runs (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, bot_id TEXT NOT NULL, input_id TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, delivered_at TEXT NOT NULL, finished_at TEXT, report_json TEXT, final_text TEXT);
        CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id, delivered_at DESC);
        CREATE INDEX IF NOT EXISTS idx_routine_runs_input ON routine_runs(bot_id, input_id);
      `)
      this.db
        .prepare("INSERT INTO meta(key,value) VALUES('owner_memory_revision','0') ON CONFLICT(key) DO NOTHING")
        .run()
      this.db.prepare("UPDATE meta SET value='5' WHERE key='schema_version'").run()
    }
    if (version <= 5) this.migrateToEnvironments()
    if (version <= 6) this.migrateEnvironmentCompaction()
    if (version <= 7) this.migrateEnvironmentUpdates()

    if (this.db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Gateway migration foreign key check failed')
    const integrity = this.db.prepare('PRAGMA integrity_check').get() as Row
    if (integrity.integrity_check !== 'ok') throw new Error('Gateway migration integrity check failed')
  }
  /**
   * Schema 6: every bot becomes an environment of one with the bot's id and name, keeping the names of its container
   * and home volume. The environment takes the bot's lifecycle, setup, control token and keyring password; the bot
   * keeps its record and its own gateway token, in slot 1. Owner memories and activity recorded so far stay global.
   */
  private migrateToEnvironments() {
    this.db.exec(`
      CREATE TABLE environments (id TEXT PRIMARY KEY, name TEXT NOT NULL, lifecycle TEXT NOT NULL, setup_json TEXT NOT NULL, container_name TEXT NOT NULL UNIQUE, volume_name TEXT NOT NULL UNIQUE, memory_limit_bytes INTEGER CHECK (memory_limit_bytes IS NULL OR (typeof(memory_limit_bytes) = 'integer' AND memory_limit_bytes > 0)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, CHECK ((lifecycle = 'archived') = (archived_at IS NOT NULL)));
      CREATE TABLE environment_secrets (environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE, control_token TEXT NOT NULL, keyring_password TEXT NOT NULL);
    `)
    const insert = this.db.prepare(
      'INSERT INTO environments(id,name,lifecycle,setup_json,container_name,volume_name,memory_limit_bytes,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,NULL,?,?,?)'
    )
    for (const row of this.db.prepare('SELECT * FROM bots ORDER BY created_at, id').all() as Row[]) {
      const id = String(row.id),
        lifecycle = String(row.lifecycle)
      let setup: unknown
      try {
        setup = JSON.parse(String(row.setup_json))
      } catch {
        throw new Error(`Gateway migration failed: bot ${id} has an unreadable setup`)
      }
      insert.run(
        id,
        String(row.name),
        lifecycle,
        JSON.stringify(environmentSetupOf(setup, lifecycle)),
        legacyContainerName(id),
        legacyVolumeName(id),
        String(row.created_at),
        String(row.updated_at),
        lifecycle === 'archived' ? String(row.archived_at ?? row.updated_at) : null
      )
    }
    this.db.exec(`
      INSERT INTO environment_secrets(environment_id,control_token,keyring_password)
        SELECT bot_id,control_token,keyring_password FROM bot_secrets WHERE bot_id IN (SELECT id FROM environments);
      CREATE TABLE bots_v6 (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL, tint TEXT NOT NULL, ceiling TEXT NOT NULL, selection_json TEXT, talks_to_json TEXT NOT NULL, paused INTEGER NOT NULL, lifecycle TEXT NOT NULL, setup_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, compaction_json TEXT, environment_id TEXT NOT NULL REFERENCES environments(id), slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 8), archived_with_environment INTEGER NOT NULL DEFAULT 0 CHECK (archived_with_environment IN (0, 1)), CHECK ((lifecycle = 'archived') = (archived_at IS NOT NULL)), CHECK (archived_with_environment = 0 OR archived_at IS NOT NULL));
      INSERT INTO bots_v6(id,name,role,instructions,tint,ceiling,selection_json,talks_to_json,paused,lifecycle,setup_json,created_at,updated_at,archived_at,compaction_json,environment_id,slot,archived_with_environment)
        SELECT id,name,role,instructions,tint,ceiling,selection_json,talks_to_json,paused,lifecycle,setup_json,created_at,updated_at,
          CASE WHEN lifecycle='archived' THEN COALESCE(archived_at,updated_at) END,compaction_json,id,1,lifecycle='archived' FROM bots;
      DROP TABLE bots;
      ALTER TABLE bots_v6 RENAME TO bots;
      CREATE INDEX idx_bots_environment ON bots(environment_id);
      CREATE UNIQUE INDEX idx_bots_environment_slot ON bots(environment_id, slot) WHERE archived_at IS NULL;
      ALTER TABLE bot_secrets DROP COLUMN control_token;
      ALTER TABLE bot_secrets DROP COLUMN keyring_password;
      ALTER TABLE owner_memories ADD COLUMN environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE;
      CREATE INDEX idx_owner_memories_environment ON owner_memories(environment_id);
      ALTER TABLE activity ADD COLUMN environment_id TEXT;
      CREATE INDEX idx_activity_environment ON activity(environment_id);
    `)
    this.db.prepare("UPDATE meta SET value='6' WHERE key='schema_version'").run()
  }
  /**
   * Schema 7: environments get a default compaction model. Each one takes the model of its migrated bot (the bot with
   * its id), or else of its oldest bot with one, active bots first; its bots with that same model then inherit it.
   */
  private migrateEnvironmentCompaction() {
    this.db.exec('ALTER TABLE environments ADD COLUMN compaction_json TEXT')
    const bots = this.db.prepare(
      'SELECT id, compaction_json FROM bots WHERE environment_id=? AND compaction_json IS NOT NULL ORDER BY (archived_at IS NOT NULL), created_at, id'
    )
    for (const environment of this.db.prepare('SELECT id FROM environments').all() as Row[]) {
      const id = String(environment.id)
      const models = (bots.all(id) as Row[]).map((bot) => {
        try {
          return { id: String(bot.id), compaction: JSON.parse(String(bot.compaction_json)) as unknown }
        } catch {
          throw new Error(`Gateway migration failed: bot ${String(bot.id)} has an unreadable compaction`)
        }
      })
      const source = models.find((bot) => bot.id === id) ?? models[0]
      if (!source) continue
      this.db.prepare('UPDATE environments SET compaction_json=? WHERE id=?').run(JSON.stringify(source.compaction), id)
      for (const bot of models)
        if (sameJson(bot.compaction, source.compaction))
          this.db.prepare('UPDATE bots SET compaction_json=NULL WHERE id=?').run(bot.id)
    }
    this.db.prepare("UPDATE meta SET value='7' WHERE key='schema_version'").run()
  }
  /** Schema 8: an environment can wait for its bots to be idle before it updates. */
  private migrateEnvironmentUpdates() {
    this.db.exec('ALTER TABLE environments ADD COLUMN update_requested_at TEXT')
    this.db.prepare("UPDATE meta SET value='8' WHERE key='schema_version'").run()
  }
  private routineRun(row: Row): StoredRoutineRun {
    return {
      id: String(row.id),
      routineId: String(row.routine_id),
      botId: String(row.bot_id),
      inputId: String(row.input_id),
      trigger: row.trigger as FleetRoutineRun['trigger'],
      status: row.status as FleetRoutineRun['status'],
      deliveredAt: String(row.delivered_at),
      finishedAt: (row.finished_at as string | null) ?? null,
      report: row.report_json ? (JSON.parse(String(row.report_json)) as FleetRoutineRun['report']) : null,
      finalText: (row.final_text as string | null) ?? null,
    }
  }
  insertRoutineRun(run: StoredRoutineRun) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO routine_runs(id,routine_id,bot_id,input_id,trigger,status,delivered_at,finished_at,report_json,final_text) VALUES(?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        run.id,
        run.routineId,
        run.botId,
        run.inputId,
        run.trigger,
        run.status,
        run.deliveredAt,
        run.finishedAt,
        run.report ? JSON.stringify(run.report) : null,
        run.finalText
      )
  }
  updateRoutineRun(run: StoredRoutineRun) {
    this.db
      .prepare('UPDATE routine_runs SET status=?, finished_at=?, report_json=?, final_text=? WHERE id=?')
      .run(run.status, run.finishedAt, run.report ? JSON.stringify(run.report) : null, run.finalText, run.id)
  }
  routineRuns(routineId: string, limit: number): StoredRoutineRun[] {
    return (
      this.db
        .prepare('SELECT * FROM routine_runs WHERE routine_id=? ORDER BY delivered_at DESC LIMIT ?')
        .all(routineId, limit) as Row[]
    ).map((row) => this.routineRun(row))
  }
  routineRunById(id: string): StoredRoutineRun | null {
    const row = this.db.prepare('SELECT * FROM routine_runs WHERE id=?').get(id) as Row | undefined
    return row ? this.routineRun(row) : null
  }
  routineRunByInput(botId: string, inputId: string): StoredRoutineRun | null {
    const row = this.db.prepare('SELECT * FROM routine_runs WHERE bot_id=? AND input_id=?').get(botId, inputId) as
      | Row
      | undefined
    return row ? this.routineRun(row) : null
  }
  pruneRoutineRuns(routineId: string, keep: number) {
    this.db
      .prepare(
        'DELETE FROM routine_runs WHERE routine_id=? AND id NOT IN (SELECT id FROM routine_runs WHERE routine_id=? ORDER BY delivered_at DESC LIMIT ?)'
      )
      .run(routineId, routineId, keep)
  }

  private ownerMemory(row: Row): FleetOwnerMemoryEntry {
    return {
      id: String(row.id),
      content: String(row.content),
      status: row.status as FleetOwnerMemoryEntry['status'],
      author:
        row.author_kind === 'bot'
          ? { kind: 'bot', botId: String(row.author_bot_id), name: String(row.author_name ?? row.author_bot_id) }
          : { kind: 'owner' },
      origin: (row.origin as FleetOwnerMemoryEntry['origin']) ?? null,
      replacesId: (row.replaces_id as string | null) ?? null,
      replacedById: (row.replaced_by_id as string | null) ?? null,
      environmentId: (row.environment_id as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
  /**
   * Owner memory entries, oldest first. Without `environmentId` every entry (as the owner sees them); with it, the
   * entries the bots of that environment see: the global ones and the environment's own.
   */
  ownerMemories(status?: 'active', environmentId?: string): FleetOwnerMemoryEntry[] {
    const conditions = [
      ...(status ? ["status='active'"] : []),
      ...(environmentId === undefined ? [] : ['(environment_id IS NULL OR environment_id=?)']),
    ]
    const statement = this.db.prepare(
      'SELECT * FROM owner_memories' +
        (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '') +
        ' ORDER BY created_at'
    )
    const rows = environmentId === undefined ? statement.all() : statement.all(environmentId)
    return (rows as Row[]).map((row) => this.ownerMemory(row))
  }
  ownerMemoryById(id: string): FleetOwnerMemoryEntry | null {
    const row = this.db.prepare('SELECT * FROM owner_memories WHERE id=?').get(id) as Row | undefined
    return row ? this.ownerMemory(row) : null
  }
  /** Creates or updates an entry, including its scope: `environmentId` null makes it global. */
  saveOwnerMemory(entry: FleetOwnerMemoryEntry) {
    this.db
      .prepare(`INSERT INTO owner_memories(id,content,status,author_kind,author_bot_id,author_name,origin,replaces_id,replaced_by_id,environment_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,status=excluded.status,replaces_id=excluded.replaces_id,replaced_by_id=excluded.replaced_by_id,environment_id=excluded.environment_id,updated_at=excluded.updated_at`)
      .run(
        entry.id,
        entry.content,
        entry.status,
        entry.author.kind,
        entry.author.kind === 'bot' ? entry.author.botId : null,
        entry.author.kind === 'bot' ? entry.author.name : null,
        entry.origin,
        entry.replacesId,
        entry.replacedById,
        entry.environmentId,
        entry.createdAt,
        entry.updatedAt
      )
  }
  deleteOwnerMemory(id: string) {
    this.transaction(() => {
      this.db.prepare('UPDATE owner_memories SET replaces_id=NULL WHERE replaces_id=?').run(id)
      this.db.prepare('UPDATE owner_memories SET replaced_by_id=NULL WHERE replaced_by_id=?').run(id)
      this.db.prepare('DELETE FROM owner_memories WHERE id=?').run(id)
    })
  }
  ownerMemoryRevision(): number {
    return Number(
      (this.db.prepare("SELECT value FROM meta WHERE key='owner_memory_revision'").get() as Row | undefined)?.value ?? 0
    )
  }
  bumpOwnerMemoryRevision(): number {
    const next = this.ownerMemoryRevision() + 1
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES('owner_memory_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(String(next))
    return next
  }

  addPairing(hash: string, expiresAt: string) {
    this.db.prepare('INSERT INTO pairing_codes(code_sha256,expires_at) VALUES(?,?)').run(hash, expiresAt)
  }
  consumePairing(hash: string, device: Device, tokenHash: string): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM pairing_codes WHERE code_sha256=?').get(hash) as Row | undefined
      if (!row) throw new GatewayError('UNAUTHORIZED', 'Invalid pairing code')
      if (Number(row.attempts) >= 5) throw new GatewayError('RATE_LIMITED', 'Pairing code attempt limit reached')
      if (row.used_at || String(row.expires_at) <= new Date().toISOString())
        throw new GatewayError('UNAUTHORIZED', 'Pairing code expired or used')
      this.db.prepare('UPDATE pairing_codes SET used_at=? WHERE code_sha256=?').run(new Date().toISOString(), hash)
      this.db
        .prepare(
          'INSERT INTO devices(id,name,token_sha256,created_at,last_seen_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)'
        )
        .run(device.id, device.name, tokenHash, device.createdAt)
    })
  }
  recordPairingAttempt(hash: string) {
    this.db.prepare('UPDATE pairing_codes SET attempts=attempts+1 WHERE code_sha256=?').run(hash)
  }
  private digestMatches(candidate: string, stored: unknown): boolean {
    const left = Buffer.from(candidate, 'hex')
    const right = Buffer.from(String(stored), 'hex')
    return left.length === 32 && right.length === 32 && timingSafeEqual(left, right)
  }
  deviceByHash(hash: string): Device | null {
    let row: Row | undefined
    for (const item of this.db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL').all() as Row[]) {
      if (this.digestMatches(hash, item.token_sha256)) row = item
    }
    return row
      ? {
          id: String(row.id),
          name: String(row.name),
          createdAt: String(row.created_at),
          lastSeenAt: row.last_seen_at as string | null,
          revokedAt: row.revoked_at as string | null,
        }
      : null
  }
  listDevices(): Device[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all() as Row[]).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      createdAt: String(row.created_at),
      lastSeenAt: row.last_seen_at as string | null,
      revokedAt: row.revoked_at as string | null,
    }))
  }
  deviceRevoked(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM devices WHERE id=? AND revoked_at IS NOT NULL').get(id)
  }
  touchDevice(id: string) {
    this.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(new Date().toISOString(), id)
  }
  revokeDevice(id: string) {
    return (
      this.db
        .prepare('UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
        .run(new Date().toISOString(), id).changes > 0
    )
  }

  private environment(row: Row): StoredEnvironment {
    return {
      id: String(row.id),
      name: String(row.name),
      lifecycle: row.lifecycle as FleetLifecycle,
      setup: JSON.parse(String(row.setup_json)) as FleetEnvironmentSetup,
      containerName: String(row.container_name),
      volumeName: String(row.volume_name),
      memoryLimitBytes: row.memory_limit_bytes === null ? null : Number(row.memory_limit_bytes),
      compaction: row.compaction_json ? (JSON.parse(String(row.compaction_json)) as FleetCompactionConfig) : null,
      updateRequestedAt: (row.update_requested_at as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: (row.archived_at as string | null) ?? null,
    }
  }
  private checkMemoryLimit(bytes: number | null) {
    if (bytes !== null && !(Number.isSafeInteger(bytes) && bytes > 0))
      throw new GatewayError('INVALID_REQUEST', 'Invalid memory limit')
  }
  private activeEnvironment(id: string): StoredEnvironment {
    const environment = this.getEnvironment(id)
    if (!environment || environment.archivedAt) throw new GatewayError('NOT_FOUND', 'Environment not found')
    return environment
  }
  insertEnvironment(environment: StoredEnvironment, secrets: EnvironmentSecrets) {
    this.checkMemoryLimit(environment.memoryLimitBytes)
    this.transaction(() => {
      if (this.getEnvironment(environment.id)) throw new GatewayError('CONFLICT', 'Environment already exists')
      this.db
        .prepare(
          'INSERT INTO environments(id,name,lifecycle,setup_json,container_name,volume_name,memory_limit_bytes,compaction_json,update_requested_at,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          environment.id,
          environment.name,
          environment.lifecycle,
          JSON.stringify(environment.setup),
          environment.containerName,
          environment.volumeName,
          environment.memoryLimitBytes,
          environment.compaction ? JSON.stringify(environment.compaction) : null,
          environment.updateRequestedAt,
          environment.createdAt,
          environment.updatedAt,
          environment.lifecycle === 'archived' ? (environment.archivedAt ?? environment.updatedAt) : null
        )
      this.db
        .prepare('INSERT INTO environment_secrets(environment_id,control_token,keyring_password) VALUES(?,?,?)')
        .run(environment.id, secrets.controlToken, secrets.keyringPassword)
    })
  }
  getEnvironment(id: string): StoredEnvironment | null {
    const row = this.db.prepare('SELECT * FROM environments WHERE id=?').get(id) as Row | undefined
    return row ? this.environment(row) : null
  }
  /** Environments that have (or are getting) a container, oldest first. */
  listEnvironments(): StoredEnvironment[] {
    return (
      this.db.prepare('SELECT * FROM environments WHERE archived_at IS NULL ORDER BY created_at, id').all() as Row[]
    ).map((row) => this.environment(row))
  }
  archivedEnvironments(): StoredEnvironment[] {
    return (
      this.db
        .prepare('SELECT * FROM environments WHERE archived_at IS NOT NULL ORDER BY archived_at, created_at, id')
        .all() as Row[]
    ).map((row) => this.environment(row))
  }
  /**
   * Changes an active environment's name, lifecycle, setup, memory limit (null: the gateway's default), default
   * compaction model (null: none) or pending update (null: none).
   */
  updateEnvironment(id: string, changes: EnvironmentChanges, at = now()): StoredEnvironment {
    if (changes.lifecycle === 'archived') throw new Error('Archive an environment with archiveEnvironment')
    if (changes.memoryLimitBytes !== undefined) this.checkMemoryLimit(changes.memoryLimitBytes)
    return this.transaction(() => {
      const current = this.activeEnvironment(id)
      const next: StoredEnvironment = {
        ...current,
        name: changes.name ?? current.name,
        lifecycle: changes.lifecycle ?? current.lifecycle,
        setup: changes.setup ?? current.setup,
        memoryLimitBytes: changes.memoryLimitBytes === undefined ? current.memoryLimitBytes : changes.memoryLimitBytes,
        compaction: changes.compaction === undefined ? current.compaction : changes.compaction,
        updateRequestedAt:
          changes.updateRequestedAt === undefined ? current.updateRequestedAt : changes.updateRequestedAt,
        updatedAt: at,
      }
      this.db
        .prepare(
          'UPDATE environments SET name=?,lifecycle=?,setup_json=?,memory_limit_bytes=?,compaction_json=?,update_requested_at=?,updated_at=? WHERE id=?'
        )
        .run(
          next.name,
          next.lifecycle,
          JSON.stringify(next.setup),
          next.memoryLimitBytes,
          next.compaction ? JSON.stringify(next.compaction) : null,
          next.updateRequestedAt,
          next.updatedAt,
          id
        )
      return next
    })
  }
  environmentSecrets(id: string): EnvironmentSecrets | null {
    const row = this.db.prepare('SELECT * FROM environment_secrets WHERE environment_id=?').get(id) as Row | undefined
    return row ? { controlToken: String(row.control_token), keyringPassword: String(row.keyring_password) } : null
  }
  /**
   * Archives an active environment with its active bots, which are flagged so that restoring the environment brings
   * them back. Returns their ids.
   */
  archiveEnvironment(id: string, at = now()): string[] {
    return this.transaction(() => {
      this.activeEnvironment(id)
      const botIds = (
        this.db
          .prepare('SELECT id FROM bots WHERE environment_id=? AND archived_at IS NULL ORDER BY slot')
          .all(id) as Row[]
      ).map((row) => String(row.id))
      this.db
        .prepare(
          "UPDATE bots SET lifecycle='archived', archived_at=?, archived_with_environment=1, updated_at=? WHERE environment_id=? AND archived_at IS NULL"
        )
        .run(at, at, id)
      this.db
        .prepare("UPDATE environments SET lifecycle='archived', archived_at=?, updated_at=? WHERE id=?")
        .run(at, at, id)
      return botIds
    })
  }
  /**
   * Brings an archived environment back to be created again, with the bots archived along with it (in their own
   * slots). Bots archived on their own before stay archived. Returns the ids of the restored bots.
   */
  restoreEnvironment(id: string, at = now()): string[] {
    return this.transaction(() => {
      if (!this.getEnvironment(id)?.archivedAt) throw new GatewayError('NOT_FOUND', 'Archived environment not found')
      this.db
        .prepare(
          "UPDATE environments SET lifecycle='creating', setup_json=?, archived_at=NULL, updated_at=? WHERE id=?"
        )
        .run(JSON.stringify(environmentCreating), at, id)
      const restored: string[] = []
      const rows = this.db
        .prepare(
          'SELECT id,slot FROM bots WHERE environment_id=? AND archived_with_environment=1 ORDER BY slot, created_at'
        )
        .all(id) as Row[]
      for (const row of rows) {
        const botId = String(row.id),
          previous = Number(row.slot)
        // Nothing can join an archived environment, so its slots are still free; the fallback only guards the index.
        const slot = this.slotTaken(id, previous) ? this.freeSlot(id) : previous
        if (slot === null) {
          this.db.prepare('UPDATE bots SET archived_with_environment=0 WHERE id=?').run(botId)
          continue
        }
        this.db
          .prepare(
            "UPDATE bots SET lifecycle='creating', setup_json=?, archived_at=NULL, archived_with_environment=0, slot=?, updated_at=? WHERE id=?"
          )
          .run(JSON.stringify(botCreating), slot, at, botId)
        restored.push(botId)
      }
      return restored
    })
  }
  /**
   * Irreversible: removes an environment with every bot it has (everything `purgeBot` removes for each), its owner
   * memories, its activity and its secrets. Returns the removed bots and how many owner memories went with it.
   */
  purgeEnvironment(id: string): { botIds: string[]; ownerMemoriesDeleted: number } {
    return this.transaction(() => {
      if (!this.getEnvironment(id)) throw new GatewayError('NOT_FOUND', 'Environment not found')
      const botIds = (
        this.db.prepare('SELECT id FROM bots WHERE environment_id=? ORDER BY slot, created_at').all(id) as Row[]
      ).map((row) => String(row.id))
      for (const botId of botIds) this.purgeBot(botId)
      const scoped = 'SELECT id FROM owner_memories WHERE environment_id=?'
      this.db.prepare(`UPDATE owner_memories SET replaces_id=NULL WHERE replaces_id IN (${scoped})`).run(id)
      this.db.prepare(`UPDATE owner_memories SET replaced_by_id=NULL WHERE replaced_by_id IN (${scoped})`).run(id)
      const ownerMemoriesDeleted = Number(
        this.db.prepare('DELETE FROM owner_memories WHERE environment_id=?').run(id).changes
      )
      if (ownerMemoriesDeleted) this.bumpOwnerMemoryRevision()
      this.db.prepare('DELETE FROM activity WHERE environment_id=?').run(id)
      this.db.prepare('DELETE FROM environment_secrets WHERE environment_id=?').run(id)
      this.db.prepare('DELETE FROM environments WHERE id=?').run(id)
      return { botIds, ownerMemoriesDeleted }
    })
  }

  /** The bots of an environment by slot, optionally followed by its archived ones. */
  botsOfEnvironment(environmentId: string, includeArchived = false): FleetBot[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM bots WHERE environment_id=?' +
            (includeArchived ? '' : ' AND archived_at IS NULL') +
            ' ORDER BY archived_at IS NOT NULL, slot, created_at'
        )
        .all(environmentId) as Row[]
    ).map((row) => this.bot(row))
  }
  /** The lowest slot (1 to 8) no active bot of the environment uses; null when it is full. */
  freeSlot(environmentId: string): number | null {
    const used = new Set(
      (
        this.db
          .prepare('SELECT slot FROM bots WHERE environment_id=? AND archived_at IS NULL')
          .all(environmentId) as Row[]
      ).map((row) => Number(row.slot))
    )
    for (let slot = 1; slot <= SLOTS; slot++) if (!used.has(slot)) return slot
    return null
  }
  private slotTaken(environmentId: string, slot: number): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM bots WHERE environment_id=? AND slot=? AND archived_at IS NULL')
      .get(environmentId, slot)
  }
  /** The requested slot if free; otherwise the previous one if free, else the lowest free one. */
  private claimSlot(environmentId: string, slot: number | undefined, previous?: number): number {
    if (slot !== undefined) {
      if (!Number.isInteger(slot) || slot < 1 || slot > SLOTS)
        throw new GatewayError('INVALID_REQUEST', 'Invalid bot slot')
      if (this.slotTaken(environmentId, slot)) throw new GatewayError('CONFLICT', 'Bot slot already in use')
      return slot
    }
    if (previous !== undefined && !this.slotTaken(environmentId, previous)) return previous
    const free = this.freeSlot(environmentId)
    if (free === null) throw new GatewayError('CONFLICT', `This environment already has ${SLOTS} bots.`)
    return free
  }
  botPlacement(id: string): BotPlacement | null {
    const row = this.db.prepare('SELECT environment_id,slot,archived_with_environment FROM bots WHERE id=?').get(id) as
      | Row
      | undefined
    return row
      ? {
          environmentId: String(row.environment_id),
          slot: Number(row.slot),
          archivedWithEnvironment: Boolean(row.archived_with_environment),
        }
      : null
  }
  /**
   * For callers that predate environments: the bot gets an environment of its own with its id and name, the
   * container and volume names bots had before, and the given control token and keyring password; it takes slot 1.
   */
  insertBot(bot: FleetBot, secrets: BotSecrets): number
  /** Adds a bot to an active environment in `slot`, or else in the lowest free one. Returns the slot. */
  insertBot(bot: FleetBot, secrets: BotGatewaySecrets, placement: { environmentId: string; slot?: number }): number
  insertBot(
    bot: FleetBot,
    secrets: BotGatewaySecrets & Partial<EnvironmentSecrets>,
    placement?: { environmentId: string; slot?: number }
  ): number {
    return this.transaction(() => {
      if (this.getBot(bot.id)) throw new GatewayError('CONFLICT', 'Bot already exists')
      let environmentId = bot.id,
        slot = 1
      if (placement) {
        environmentId = this.activeEnvironment(placement.environmentId).id
        slot = this.claimSlot(environmentId, placement.slot)
      } else {
        if (secrets.controlToken === undefined || secrets.keyringPassword === undefined)
          throw new Error('A bot without an environment needs the secrets of its new environment')
        this.insertEnvironment(
          {
            id: bot.id,
            name: bot.name,
            lifecycle: bot.lifecycle,
            setup: environmentSetupOf(bot.setup, bot.lifecycle),
            containerName: legacyContainerName(bot.id),
            volumeName: legacyVolumeName(bot.id),
            memoryLimitBytes: null,
            compaction: null,
            updateRequestedAt: null,
            createdAt: bot.createdAt,
            updatedAt: bot.updatedAt,
            archivedAt: null,
          },
          { controlToken: secrets.controlToken, keyringPassword: secrets.keyringPassword }
        )
      }
      this.db
        .prepare(`INSERT INTO bots(id,name,role,instructions,tint,ceiling,selection_json,compaction_json,talks_to_json,paused,lifecycle,setup_json,created_at,updated_at,archived_at,environment_id,slot,archived_with_environment)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
        .run(
          bot.id,
          bot.name,
          bot.role,
          bot.instructions,
          bot.tint,
          bot.ceiling,
          JSON.stringify(bot.selection),
          bot.compaction ? JSON.stringify(bot.compaction) : null,
          JSON.stringify(bot.talksTo),
          Number(bot.paused),
          bot.lifecycle,
          JSON.stringify(bot.setup),
          bot.createdAt,
          bot.updatedAt,
          bot.lifecycle === 'archived' ? bot.updatedAt : null,
          environmentId,
          slot
        )
      this.db
        .prepare('INSERT INTO bot_secrets(bot_id,gateway_token,gateway_token_sha256) VALUES(?,?,?)')
        .run(bot.id, secrets.gatewayToken, secrets.gatewayTokenSha256)
      return slot
    })
  }
  /**
   * Saves a bot's own fields and state (archiving it frees its slot and keeps the time it was archived first). Its
   * environment and slot change only through the environment methods.
   */
  saveBot(bot: FleetBot) {
    const archived = Number(bot.lifecycle === 'archived')
    const result = this.db
      .prepare(`UPDATE bots SET name=?,role=?,instructions=?,tint=?,ceiling=?,selection_json=?,compaction_json=?,talks_to_json=?,paused=?,lifecycle=?,setup_json=?,updated_at=?,
      archived_at=CASE WHEN ? THEN COALESCE(archived_at,?) END,archived_with_environment=CASE WHEN ? THEN archived_with_environment ELSE 0 END WHERE id=?`)
      .run(
        bot.name,
        bot.role,
        bot.instructions,
        bot.tint,
        bot.ceiling,
        JSON.stringify(bot.selection),
        bot.compaction ? JSON.stringify(bot.compaction) : null,
        JSON.stringify(bot.talksTo),
        Number(bot.paused),
        bot.lifecycle,
        JSON.stringify(bot.setup),
        bot.updatedAt,
        archived,
        bot.updatedAt,
        archived,
        bot.id
      )
    if (!result.changes) throw new GatewayError('NOT_FOUND', 'Bot not found')
  }
  /** Archives one active bot on its own: its slot becomes free and its records stay. */
  archiveBot(id: string, at = now()): FleetBot {
    return this.transaction(() => {
      const bot = this.getBot(id)
      if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
      this.db
        .prepare(
          "UPDATE bots SET lifecycle='archived', archived_at=?, archived_with_environment=0, updated_at=? WHERE id=?"
        )
        .run(at, at, id)
      return this.getBot(id)!
    })
  }
  /**
   * Brings an archived bot back into its active environment, to install its profile again: in `slot`, or else its
   * previous slot when free, or else the lowest free one.
   */
  restoreBot(id: string, slot?: number, at = now()): FleetBot {
    return this.transaction(() => {
      const placement = this.botPlacement(id)
      if (!placement || this.getBot(id)?.lifecycle !== 'archived')
        throw new GatewayError('NOT_FOUND', 'Archived bot not found')
      if (this.getEnvironment(placement.environmentId)?.archivedAt !== null)
        throw new GatewayError('CONFLICT', 'Restore its environment first')
      const target = this.claimSlot(placement.environmentId, slot, placement.slot)
      this.db
        .prepare(
          "UPDATE bots SET lifecycle='creating', setup_json=?, archived_at=NULL, archived_with_environment=0, slot=?, updated_at=? WHERE id=?"
        )
        .run(JSON.stringify(botInstalling), target, at, id)
      return this.getBot(id)!
    })
  }
  private bot(row: Row): FleetBot {
    return {
      id: String(row.id),
      name: String(row.name),
      role: String(row.role),
      instructions: String(row.instructions),
      tint: String(row.tint),
      ceiling: row.ceiling as FleetBot['ceiling'],
      selection: JSON.parse(String(row.selection_json)),
      // The bot's own model; the lifecycle resolves the one it uses with its environment's default.
      compaction: row.compaction_json ? JSON.parse(String(row.compaction_json)) : null,
      compactionSource: row.compaction_json ? 'bot' : null,
      compactionState: null,
      talksTo: JSON.parse(String(row.talks_to_json)),
      paused: Boolean(row.paused),
      lifecycle: row.lifecycle as FleetBot['lifecycle'],
      setup: JSON.parse(String(row.setup_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      status: 'offline',
      usage: null,
      activity: null,
      pendingCount: 0,
      accounts: { connected: false, providers: [] },
      takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
      resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
      screen: { width: 1280, height: 800, display: ':0' },
      appVersion: null,
      capabilities: [],
      environmentId: String(row.environment_id),
    }
  }
  getBot(id: string): FleetBot | null {
    const row = this.db.prepare('SELECT * FROM bots WHERE id=?').get(id) as Row | undefined
    return row ? this.bot(row) : null
  }
  listBots(includeArchived = false): FleetBot[] {
    return (
      this.db
        .prepare(
          includeArchived
            ? 'SELECT * FROM bots ORDER BY created_at'
            : 'SELECT * FROM bots WHERE archived_at IS NULL ORDER BY created_at'
        )
        .all() as Row[]
    ).map((row) => this.bot(row))
  }
  archivedBots(): ArchivedBotRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM bots WHERE archived_at IS NOT NULL ORDER BY archived_at, created_at')
        .all() as Row[]
    ).map((row) => ({
      bot: this.bot(row),
      archivedAt: String(row.archived_at),
      archivedWithEnvironment: Boolean(row.archived_with_environment),
    }))
  }
  /**
   * Removes a bot and everything recorded about it (its gateway token included), so a new bot may reuse its id. Its
   * environment stays.
   */
  purgeBot(id: string) {
    this.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM pending_deliveries WHERE to_bot=? OR message_id IN (SELECT id FROM peer_messages WHERE from_bot=? OR to_bot=?)'
        )
        .run(id, id, id)
      this.db.prepare('DELETE FROM peer_messages WHERE from_bot=? OR to_bot=?').run(id, id)
      this.db.prepare('DELETE FROM routine_runs WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM routines WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM activity WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM owner_messages WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM pair_blocks WHERE pair_key LIKE ?').run('%|' + id + '|%')
      this.db
        .prepare('DELETE FROM idempotency WHERE scope IN (?,?,?,?,?)')
        .run(
          'botMessageSend:' + id,
          'routineCreate:' + id,
          'botRoutineCreate:' + id,
          'botOwnerMemorySave:' + id,
          'peer:' + id
        )
      this.db.prepare('DELETE FROM bot_secrets WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM bots WHERE id=?').run(id)
    })
  }
  /**
   * For callers that predate environments, where a bot and its environment were one: purges the bot and, once its
   * environment has no bot left, the environment too.
   */
  deleteBot(id: string) {
    this.transaction(() => {
      const environmentId = this.botPlacement(id)?.environmentId
      this.purgeBot(id)
      if (environmentId && !this.db.prepare('SELECT 1 FROM bots WHERE environment_id=?').get(environmentId))
        this.purgeEnvironment(environmentId)
    })
  }
  botSecrets(id: string): BotSecrets | null {
    const row = this.db
      .prepare(
        'SELECT s.gateway_token,s.gateway_token_sha256,e.control_token,e.keyring_password FROM bot_secrets s JOIN bots b ON b.id=s.bot_id JOIN environment_secrets e ON e.environment_id=b.environment_id WHERE s.bot_id=?'
      )
      .get(id) as Row | undefined
    return row
      ? {
          controlToken: String(row.control_token),
          gatewayToken: String(row.gateway_token),
          gatewayTokenSha256: String(row.gateway_token_sha256),
          keyringPassword: String(row.keyring_password),
        }
      : null
  }
  botGatewaySecrets(id: string): BotGatewaySecrets | null {
    const row = this.db.prepare('SELECT * FROM bot_secrets WHERE bot_id=?').get(id) as Row | undefined
    return row
      ? { gatewayToken: String(row.gateway_token), gatewayTokenSha256: String(row.gateway_token_sha256) }
      : null
  }
  botByGatewayHash(hash: string): string | null {
    let row: Row | undefined
    for (const item of this.db.prepare('SELECT bot_id,gateway_token_sha256 FROM bot_secrets').all() as Row[]) {
      if (this.digestMatches(hash, item.gateway_token_sha256)) row = item
    }
    return row ? String(row.bot_id) : null
  }
  /**
   * Records an activity entry. It happens in `environmentId` when given (null: fleet-wide), otherwise in the
   * environment of its bot.
   */
  addActivity(
    botId: string | null,
    kind: FleetActivityKind,
    summary: string | null = null,
    data: FleetActivityEntry['data'] = {},
    environmentId?: string | null
  ): FleetActivityEntry {
    const at = now()
    const environment =
      environmentId !== undefined ? environmentId : botId ? (this.botPlacement(botId)?.environmentId ?? null) : null
    const result = this.db
      .prepare('INSERT INTO activity(at,bot_id,environment_id,kind,summary,data_json) VALUES(?,?,?,?,?,?)')
      .run(at, botId, environment, kind, summary, JSON.stringify(data))
    return { seq: Number(result.lastInsertRowid), at, botId, environmentId: environment, kind, summary, data }
  }
  /**
   * Activity entries after `after`, oldest first. Without `includeEnvironment`, entries about environments themselves
   * are left out (before the limit applies), for devices that predate them.
   */
  activity(after = 0, limit = 200, includeEnvironment = true): FleetActivityEntry[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM activity WHERE seq>?' +
          (includeEnvironment ? '' : " AND kind NOT LIKE 'environment\\_%' ESCAPE '\\'") +
          ' ORDER BY seq LIMIT ?'
      )
      .all(after, limit) as Row[]
    return rows.map((row) => ({
      seq: Number(row.seq),
      at: String(row.at),
      botId: row.bot_id as string | null,
      environmentId: (row.environment_id as string | null) ?? null,
      kind: row.kind as FleetActivityKind,
      summary: row.summary as string | null,
      data: JSON.parse(String(row.data_json)),
    }))
  }
  lastActivitySeq(): number {
    return Number((this.db.prepare('SELECT MAX(seq) AS seq FROM activity').get() as Row).seq ?? 0)
  }
  peerMessages(limit = 200): FleetPeerMessage[] {
    return (this.db.prepare('SELECT * FROM peer_messages ORDER BY at DESC LIMIT ?').all(limit) as Row[]).map((row) => ({
      id: String(row.id),
      at: String(row.at),
      from: String(row.from_bot),
      to: String(row.to_bot),
      text: String(row.text),
      delivered: Boolean(row.delivered),
    }))
  }
  insertPeerMessage(message: FleetPeerMessage) {
    this.db
      .prepare('INSERT INTO peer_messages(id,at,from_bot,to_bot,text,delivered) VALUES(?,?,?,?,?,?)')
      .run(message.id, message.at, message.from, message.to, message.text, Number(message.delivered))
    if (!message.delivered)
      this.db
        .prepare('INSERT INTO pending_deliveries(message_id,to_bot,created_at) VALUES(?,?,?)')
        .run(message.id, message.to, message.at)
  }
  pendingPeers(toBot?: string): FleetPeerMessage[] {
    const rows = toBot
      ? this.db
          .prepare(
            'SELECT p.* FROM peer_messages p JOIN pending_deliveries d ON p.id=d.message_id WHERE d.to_bot=? ORDER BY p.at'
          )
          .all(toBot)
      : this.db
          .prepare('SELECT p.* FROM peer_messages p JOIN pending_deliveries d ON p.id=d.message_id ORDER BY p.at')
          .all()
    return (rows as Row[]).map((row) => ({
      id: String(row.id),
      at: String(row.at),
      from: String(row.from_bot),
      to: String(row.to_bot),
      text: String(row.text),
      delivered: false,
    }))
  }
  markPeerDelivered(id: string) {
    this.transaction(() => {
      this.db.prepare('UPDATE peer_messages SET delivered=1 WHERE id=?').run(id)
      this.db.prepare('DELETE FROM pending_deliveries WHERE message_id=?').run(id)
    })
  }
  countPeerMessages(from: string, since: string) {
    return Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS count FROM peer_messages WHERE from_bot=? AND at>=?')
          .get(from, since) as Row
      ).count
    )
  }
  countPairMessages(a: string, b: string, since: string) {
    return Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM peer_messages WHERE at>=? AND ((from_bot=? AND to_bot=?) OR (from_bot=? AND to_bot=?))'
          )
          .get(since, a, b, b, a) as Row
      ).count
    )
  }
  markOwnerMessage(botId: string, at = new Date().toISOString()) {
    this.db
      .prepare('INSERT INTO owner_messages(bot_id,at) VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET at=excluded.at')
      .run(botId, at)
    this.db.prepare('DELETE FROM pair_blocks WHERE pair_key LIKE ?').run('%|' + botId + '|%')
  }
  pairLastOwner(a: string, b: string): string | null {
    const row = this.db.prepare('SELECT MAX(at) AS at FROM owner_messages WHERE bot_id IN (?,?)').get(a, b) as Row
    return row.at as string | null
  }
  pairBlockedUntil(a: string, b: string): string | null {
    const row = this.db.prepare('SELECT blocked_until FROM pair_blocks WHERE pair_key=?').get(this.pairKey(a, b)) as
      | Row
      | undefined
    return row ? String(row.blocked_until) : null
  }
  blockPair(a: string, b: string, until: string) {
    this.db
      .prepare(
        'INSERT INTO pair_blocks(pair_key,blocked_until) VALUES(?,?) ON CONFLICT(pair_key) DO UPDATE SET blocked_until=excluded.blocked_until'
      )
      .run(this.pairKey(a, b), until)
  }
  private pairKey(a: string, b: string) {
    return '|' + [a, b].sort().join('|') + '|'
  }
  private routine(row: Row): FleetRoutine {
    return {
      id: String(row.id),
      botId: String(row.bot_id),
      title: String(row.title),
      prompt: String(row.prompt),
      schedule: JSON.parse(String(row.schedule_json)),
      enabled: Boolean(row.enabled),
      nextRunAt: row.next_run_at as string | null,
      lastRunAt: row.last_run_at as string | null,
      lastOutcome: row.last_outcome as FleetRoutine['lastOutcome'],
      createdBy: row.created_by as FleetRoutine['createdBy'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
  routines(botId?: string): FleetRoutine[] {
    const rows = botId
      ? this.db.prepare('SELECT * FROM routines WHERE bot_id=? ORDER BY created_at').all(botId)
      : this.db.prepare('SELECT * FROM routines ORDER BY created_at').all()
    return (rows as Row[]).map((row) => this.routine(row))
  }
  routineById(id: string): FleetRoutine | null {
    const row = this.db.prepare('SELECT * FROM routines WHERE id=?').get(id) as Row | undefined
    return row ? this.routine(row) : null
  }
  routineLastInputId(id: string): string | null {
    const row = this.db.prepare('SELECT last_input_id FROM routines WHERE id=?').get(id) as Row | undefined
    return (row?.last_input_id as string | null) ?? null
  }
  setRoutineLastInputId(id: string, inputId: string) {
    this.db.prepare('UPDATE routines SET last_input_id=? WHERE id=?').run(inputId, id)
  }
  saveRoutine(routine: FleetRoutine) {
    this.db
      .prepare(`INSERT INTO routines(id,bot_id,title,prompt,schedule_json,enabled,next_run_at,last_run_at,last_outcome,created_at,updated_at,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,prompt=excluded.prompt,
      schedule_json=excluded.schedule_json,enabled=excluded.enabled,next_run_at=excluded.next_run_at,
      last_run_at=excluded.last_run_at,last_outcome=excluded.last_outcome,updated_at=excluded.updated_at`)
      .run(
        routine.id,
        routine.botId,
        routine.title,
        routine.prompt,
        JSON.stringify(routine.schedule),
        Number(routine.enabled),
        routine.nextRunAt,
        routine.lastRunAt,
        routine.lastOutcome,
        routine.createdAt,
        routine.updatedAt,
        routine.createdBy
      )
  }
  deleteRoutine(id: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM routine_runs WHERE routine_id=?').run(id)
      this.db.prepare('DELETE FROM routines WHERE id=?').run(id)
    })
  }
  priorIdempotency<T>(scope: string, key: string, requestHash: string): { response: T; status: number } | null {
    this.db.prepare('DELETE FROM idempotency WHERE created_at<?').run(new Date(Date.now() - 86400000).toISOString())
    const row = this.db.prepare('SELECT * FROM idempotency WHERE scope=? AND key=?').get(scope, key) as Row | undefined
    if (!row) return null
    if (row.request_hash !== requestHash)
      throw new GatewayError('CONFLICT', 'Idempotency key used with different request')
    return { response: JSON.parse(String(row.response_json)) as T, status: Number(row.status) }
  }
  saveIdempotency(scope: string, key: string, requestHash: string, response: unknown, status: number) {
    this.db
      .prepare('INSERT INTO idempotency(scope,key,request_hash,response_json,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(scope, key, requestHash, JSON.stringify(response), status, new Date().toISOString())
  }
  idempotent<T>(
    scope: string,
    key: string,
    requestHash: string,
    create: () => { response: T; status: number }
  ): { response: T; status: number; replay: boolean } {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM idempotency WHERE created_at<?').run(new Date(Date.now() - 86400000).toISOString())
      const prior = this.db.prepare('SELECT * FROM idempotency WHERE scope=? AND key=?').get(scope, key) as
        | Row
        | undefined
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new GatewayError('CONFLICT', 'Idempotency key used with different request')
        return { response: JSON.parse(String(prior.response_json)) as T, status: Number(prior.status), replay: true }
      }
      const made = create()
      this.db
        .prepare('INSERT INTO idempotency(scope,key,request_hash,response_json,status,created_at) VALUES(?,?,?,?,?,?)')
        .run(scope, key, requestHash, JSON.stringify(made.response), made.status, new Date().toISOString())
      return { ...made, replay: false }
    })
  }
}
