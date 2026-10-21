import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  FLEET_ENVIRONMENT_LIMITS,
  dictationProviderSchema,
  type DictationProvider,
  fleetErrorCodeSchema,
  fleetPushRegistrationSchema,
  type FleetDeviceClient,
  type FleetPushRegistration,
  type FleetPushRegistrationRequest,
  type FleetRoutineRun,
  type FleetOwnerMemoryEntry,
  type FleetActivityEntry,
  type FleetActivityKind,
  type FleetBot,
  type FleetBotMove,
  type FleetBotSetup,
  type FleetCompactionConfig,
  type FleetEnvironmentKind,
  type FleetEnvironmentSetup,
  type FleetHostFolderMode,
  type FleetLifecycle,
  type FleetPeerMessage,
  type FleetRoutine,
  type FleetRoutineRunSettings,
  type FleetRoutineRunKept,
  type FleetPeerThreadSettings,
  FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
  FLEET_PEER_THREAD_SETTINGS_DEFAULT,
  fleetBotDelegationSchema,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'

export type StoredRoutineRun = FleetRoutineRun & { inputId: string }
/** A message between bots, with the thread it continues (null from before threads). */
export type StoredPeerMessage = FleetPeerMessage & { threadId: string | null }
/** A thread between two bots (`peer-conversations`), as both share it. */
export interface StoredPeerThread {
  id: string
  botA: string
  botB: string
  title: string
  /** Messages between the bots in a row without one of the owner's. */
  hops: number
  messages: number
  status: 'open' | 'paused'
  /** The bot whose message the pause refused: it goes on once the owner lets the thread go on. */
  blockedBot: string | null
  createdAt: string
  lastActivityAt: string
}
/** One bot's side of a thread: its conversation of it, and what it brought back to its owner. */
export interface StoredPeerThreadSide {
  threadId: string
  botId: string
  origin: 'primary' | 'side' | 'peer'
  pinned: boolean
  conversation: 'own' | 'deleted'
  conversationDeletedAt: string | null
  kept: FleetRoutineRunKept | null
  report: string | null
  reportAt: string | null
}
function peerThreadOf(row: Row): StoredPeerThread {
  return {
    id: String(row.id),
    botA: String(row.bot_a),
    botB: String(row.bot_b),
    title: String(row.title),
    hops: Number(row.hops),
    messages: Number(row.messages),
    status: row.status === 'paused' ? 'paused' : 'open',
    blockedBot: row.blocked_bot ? String(row.blocked_bot) : null,
    createdAt: String(row.created_at),
    lastActivityAt: String(row.last_activity_at),
  }
}
function peerThreadSideOf(row: Row): StoredPeerThreadSide {
  return {
    threadId: String(row.thread_id),
    botId: String(row.bot_id),
    origin: row.origin === 'primary' || row.origin === 'side' ? row.origin : 'peer',
    pinned: Boolean(row.pinned),
    conversation: row.conversation === 'deleted' ? 'deleted' : 'own',
    conversationDeletedAt: row.conversation_deleted_at ? String(row.conversation_deleted_at) : null,
    kept: row.kept_json ? (JSON.parse(String(row.kept_json)) as FleetRoutineRunKept) : null,
    report: row.report ? String(row.report) : null,
    reportAt: row.report_at ? String(row.report_at) : null,
  }
}

type Row = Record<string, unknown>
const DEVICE_KINDS = new Set<string>(['computer', 'phone'])
const DEVICE_PLATFORMS = new Set<string>(['macos', 'windows', 'linux', 'ios', 'android'])
function deviceRow(row: Row): Device {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: DEVICE_KINDS.has(String(row.kind)) ? (String(row.kind) as Device['kind']) : null,
    platform: DEVICE_PLATFORMS.has(String(row.platform)) ? (String(row.platform) as Device['platform']) : null,
    createdAt: String(row.created_at),
    lastSeenAt: row.last_seen_at as string | null,
    revokedAt: row.revoked_at as string | null,
  }
}
export type Device = {
  id: string
  name: string
  /** What the device said it is when it paired; null for devices paired before schema 15. */
  kind: FleetDeviceClient['kind'] | null
  platform: FleetDeviceClient['platform'] | null
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}
/** One container shared by up to `FLEET_ENVIRONMENT_LIMITS.botsMax` bots, as the gateway records it. */
export type StoredEnvironment = {
  id: string
  name: string
  /** Bots, or the owner's chats and workspaces. It never changes. */
  kind: FleetEnvironmentKind
  lifecycle: FleetLifecycle
  setup: FleetEnvironmentSetup
  containerName: string
  volumeName: string
  /** The limit the owner set for the container; null uses the gateway's default. */
  memoryLimitBytes: number | null
  /** The CPUs its container may use; null: every CPU of the server. */
  cpuLimit: number | null
  /** A workspaces environment stops itself after this many idle minutes; null: never. */
  idleStopMinutes: number | null
  /** The color the owner chose for it; null: none. */
  tint: string | null
  /** Which server folder a workspaces environment mounts; null for bots environments. */
  hostFolder: FleetHostFolderMode | null
  /** The compaction model of its bots that have none of their own; null when the owner has not chosen one. */
  compaction: FleetCompactionConfig | null
  /** When the owner asked to update it once its bots are idle; null when no update waits. */
  updateRequestedAt: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}
export type EnvironmentChanges = Partial<
  Pick<
    StoredEnvironment,
    | 'name'
    | 'lifecycle'
    | 'setup'
    | 'memoryLimitBytes'
    | 'cpuLimit'
    | 'idleStopMinutes'
    | 'tint'
    | 'hostFolder'
    | 'compaction'
    | 'updateRequestedAt'
  >
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
/** A Mac that gave a bot access to its workspaces: the device that paired, and the id and name the bot sees. */
export type StoredDesktopLink = {
  botId: string
  deviceId: string
  desktopId: string
  name: string
  linkedAt: string
  updatedAt: string
}
/** A workspaces environment that gave a bot access to its workspaces: the id and name the bot sees it by. */
export type StoredEnvironmentDesktopLink = {
  botId: string
  environmentId: string
  desktopId: string
  name: string
  linkedAt: string
  updatedAt: string
}
/** Where a desktop id leads: the link of a paired computer, or of a workspaces environment. */
export type StoredDesktopTarget =
  | { kind: 'device'; link: StoredDesktopLink }
  | { kind: 'environment'; link: StoredEnvironmentDesktopLink }
/** A bot's move between environments as the gateway journals it, with the slot it leaves and the one it holds. */
export type StoredBotMove = FleetBotMove & { fromSlot: number; toSlot: number }
export type StoredDictation = { provider: DictationProvider; key: string; updatedAt: string; updatedBy: string }
export type BotMoveChanges = Partial<Pick<FleetBotMove, 'phase' | 'state' | 'error'>>

const now = () => new Date().toISOString()
const SLOTS = FLEET_ENVIRONMENT_LIMITS.botsMax
/** A running move holds its slot in its destination until it commits; the bot holds it from then on. */
const RESERVING = "state='running' AND phase NOT IN ('releasing-source','completed')"
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
function pushRegistrationRow(row: Row): FleetPushRegistration {
  return fleetPushRegistrationSchema.parse({
    provider: row.provider,
    token: row.token,
    platform: row.platform,
    locale: row.locale,
    preferences: JSON.parse(String(row.preferences_json)),
    updatedAt: row.updated_at,
  })
}

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
    if (version > 21) throw new Error('Gateway database schema is newer than this binary')
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
    if (version <= 8) {
      this.db.exec('ALTER TABLE bots ADD COLUMN publish_artifacts INTEGER NOT NULL DEFAULT 0')
      this.db.prepare("UPDATE meta SET value='9' WHERE key='schema_version'").run()
    }
    if (version <= 9) {
      // Which Macs gave which bot access to their workspaces: the gateway routes a bot's calls by these and keeps
      // nothing else of a Mac (no grant, catalog or conversation).
      this.db.exec(`
        CREATE TABLE desktop_links (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, desktop_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, linked_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (bot_id, device_id));
        CREATE INDEX idx_desktop_links_device ON desktop_links(device_id);
      `)
      this.db.prepare("UPDATE meta SET value='10' WHERE key='schema_version'").run()
    }
    if (version <= 10) this.migrateEnvironmentKinds()
    if (version <= 11) this.migrateHostSecrets()
    if (version <= 12) this.migrateEnvironmentScopes()
    if (version <= 13) {
      // Schema 14: the push token and notification preferences of each phone.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS push_registrations (device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE, provider TEXT NOT NULL, token TEXT NOT NULL, platform TEXT NOT NULL, locale TEXT NOT NULL, preferences_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      `)
      this.db.prepare("UPDATE meta SET value='14' WHERE key='schema_version'").run()
    }
    if (version <= 14) {
      // Schema 15: whether each device is a phone or a computer, and its platform, as it said when it paired.
      const columns = (this.db.prepare('PRAGMA table_info(devices)').all() as Row[]).map((column) => column.name)
      if (columns.length && !columns.includes('kind')) this.db.exec('ALTER TABLE devices ADD COLUMN kind TEXT')
      if (columns.length && !columns.includes('platform')) this.db.exec('ALTER TABLE devices ADD COLUMN platform TEXT')
      this.db.prepare("UPDATE meta SET value='15' WHERE key='schema_version'").run()
    }
    if (version <= 15) {
      // Schema 16: which workspaces environments gave which bot access to their workspaces, as desktop_links does for
      // Macs. The gateway routes a bot's calls by these and keeps nothing else (no grant, catalog or conversation).
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS environment_desktop_links (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE, desktop_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, linked_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (bot_id, environment_id));
        CREATE INDEX IF NOT EXISTS idx_environment_desktop_links_environment ON environment_desktop_links(environment_id);
      `)
      this.db.prepare("UPDATE meta SET value='16' WHERE key='schema_version'").run()
    }
    if (version <= 16) {
      // Schema 17: the journal of bots' moves between environments. A running move holds its slot in the destination;
      // a move whose bot left a copy behind stays at `releasing-source` until its former environment deletes it.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS bot_moves (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, from_environment_id TEXT NOT NULL, to_environment_id TEXT NOT NULL, from_slot INTEGER NOT NULL CHECK (from_slot BETWEEN 1 AND 8), to_slot INTEGER NOT NULL CHECK (to_slot BETWEEN 1 AND 8), new_environment INTEGER NOT NULL DEFAULT 0 CHECK (new_environment IN (0, 1)), phase TEXT NOT NULL CHECK (phase IN ('prepared','freezing','exporting','importing','verifying','committing','releasing-source','completed')), state TEXT NOT NULL CHECK (state IN ('running','completed','failed')), error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK (from_environment_id <> to_environment_id));
        CREATE INDEX IF NOT EXISTS idx_bot_moves_bot ON bot_moves(bot_id, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_moves_running ON bot_moves(bot_id) WHERE state='running';
        CREATE INDEX IF NOT EXISTS idx_bot_moves_release ON bot_moves(from_environment_id) WHERE phase='releasing-source';
      `)
      this.db.prepare("UPDATE meta SET value='17' WHERE key='schema_version'").run()
    }
    if (version <= 17) {
      // Schema 18: routine runs in conversations of their own (`routine-conversations`). A run keeps its routine's
      // title, where it ran, whether the owner keeps it, its last activity, what its conversation holds, what was kept
      // when that conversation was deleted, and the owner's changes there; a bot keeps how long those conversations
      // stay. Runs from before ran in the bot's conversation.
      const columns = new Set(
        (this.db.prepare('PRAGMA table_info(routine_runs)').all() as Row[]).map((row) => row.name)
      )
      const add = (name: string, definition: string) => {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE routine_runs ADD COLUMN ${name} ${definition}`)
      }
      add('routine_title', 'TEXT')
      add('conversation', "TEXT NOT NULL DEFAULT 'primary'")
      add('quiet', 'INTEGER NOT NULL DEFAULT 0')
      add('pinned', 'INTEGER NOT NULL DEFAULT 0')
      add('last_activity_at', 'TEXT')
      add('conversation_deleted_at', 'TEXT')
      add('media_json', 'TEXT')
      add('kept_json', 'TEXT')
      add('adjustments', 'INTEGER NOT NULL DEFAULT 0')
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_routine_runs_bot ON routine_runs(bot_id, delivered_at DESC)')
      const bots = new Set((this.db.prepare('PRAGMA table_info(bots)').all() as Row[]).map((row) => row.name))
      if (!bots.has('run_settings_json')) this.db.exec('ALTER TABLE bots ADD COLUMN run_settings_json TEXT')
      this.db.prepare("UPDATE meta SET value='18' WHERE key='schema_version'").run()
    }
    if (version <= 18) {
      // Schema 19: conversations between bots in threads of their own (`peer-conversations`). A thread is shared by
      // its two bots, with how many messages they exchanged in a row without the owner; each bot has its own side,
      // with its conversation, what it kept and what it brought back to its owner. Messages name their thread.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS peer_threads (id TEXT PRIMARY KEY, bot_a TEXT NOT NULL, bot_b TEXT NOT NULL, title TEXT NOT NULL, hops INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paused')), blocked_bot TEXT, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS peer_thread_sides (thread_id TEXT NOT NULL REFERENCES peer_threads(id) ON DELETE CASCADE, bot_id TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('primary','side','peer')), pinned INTEGER NOT NULL DEFAULT 0, conversation TEXT NOT NULL DEFAULT 'own' CHECK (conversation IN ('own','deleted')), conversation_deleted_at TEXT, kept_json TEXT, report TEXT, report_at TEXT, PRIMARY KEY (thread_id, bot_id));
        CREATE INDEX IF NOT EXISTS idx_peer_thread_sides_bot ON peer_thread_sides(bot_id);
      `)
      const messages = new Set(
        (this.db.prepare('PRAGMA table_info(peer_messages)').all() as Row[]).map((row) => row.name)
      )
      // A database without messages between bots has nothing to name a thread in.
      if (messages.size && !messages.has('thread_id'))
        this.db.exec('ALTER TABLE peer_messages ADD COLUMN thread_id TEXT')
      const bots = new Set((this.db.prepare('PRAGMA table_info(bots)').all() as Row[]).map((row) => row.name))
      if (!bots.has('peer_settings_json')) this.db.exec('ALTER TABLE bots ADD COLUMN peer_settings_json TEXT')
      this.db.prepare("UPDATE meta SET value='19' WHERE key='schema_version'").run()
    }
    if (version <= 19) {
      // Schema 20: the server's speech-to-text key for phone dictation (`dictation`). One row at most.
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS dictation_settings (id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL, api_key TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)'
      )
      this.db.prepare("UPDATE meta SET value='20' WHERE key='schema_version'").run()
    }
    if (version <= 20) {
      // Schema 21: how a bot splits its work into tasks (`bot-delegation`); null until the owner sets it.
      const bots = new Set((this.db.prepare('PRAGMA table_info(bots)').all() as Row[]).map((row) => row.name))
      if (!bots.has('delegation_json')) this.db.exec('ALTER TABLE bots ADD COLUMN delegation_json TEXT')
      this.db.prepare("UPDATE meta SET value='21' WHERE key='schema_version'").run()
    }

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
  /** Schema 11: an environment runs bots or hosts workspaces; every environment so far runs bots. */
  private migrateEnvironmentKinds() {
    this.db.exec(
      "ALTER TABLE environments ADD COLUMN kind TEXT NOT NULL DEFAULT 'bots' CHECK (kind IN ('bots','workspaces'))"
    )
    this.db.prepare("UPDATE meta SET value='11' WHERE key='schema_version'").run()
  }
  /**
   * Schema 12: the token a workspaces environment publishes artifacts with. Environments get one when their container
   * is next created.
   */
  private migrateHostSecrets() {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS host_secrets (environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE, gateway_token TEXT NOT NULL, gateway_token_sha256 TEXT NOT NULL UNIQUE)'
    )
    this.db.prepare("UPDATE meta SET value='12' WHERE key='schema_version'").run()
  }
  /**
   * Schema 13: environments get a CPU limit, an idle stop and a tint, and workspaces environments a server folder mode.
   * Workspaces environments so far mount the whole server folder (`shared`), so the paths of their workspaces keep
   * working; new ones get a folder of their own.
   */
  private migrateEnvironmentScopes() {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(environments)').all() as Row[]).map((column) => String(column.name))
    )
    const columns: Array<[string, string]> = [
      ['cpu_limit', 'REAL CHECK (cpu_limit IS NULL OR cpu_limit > 0)'],
      ['idle_stop_minutes', 'INTEGER CHECK (idle_stop_minutes IS NULL OR idle_stop_minutes > 0)'],
      ['tint', 'TEXT'],
      ['host_folder', "TEXT CHECK (host_folder IS NULL OR host_folder IN ('own','shared'))"],
    ]
    for (const [name, definition] of columns)
      if (!existing.has(name)) this.db.exec(`ALTER TABLE environments ADD COLUMN ${name} ${definition}`)
    this.db.exec("UPDATE environments SET host_folder='shared' WHERE kind='workspaces' AND host_folder IS NULL")
    this.db.prepare("UPDATE meta SET value='13' WHERE key='schema_version'").run()
  }
  private routineRun(row: Row): StoredRoutineRun {
    const json = <T>(value: unknown): T | null => (value ? (JSON.parse(String(value)) as T) : null)
    return {
      id: String(row.id),
      routineId: String(row.routine_id),
      botId: String(row.bot_id),
      inputId: String(row.input_id),
      trigger: row.trigger as FleetRoutineRun['trigger'],
      status: row.status as FleetRoutineRun['status'],
      deliveredAt: String(row.delivered_at),
      finishedAt: (row.finished_at as string | null) ?? null,
      report: json<FleetRoutineRun['report']>(row.report_json),
      finalText: (row.final_text as string | null) ?? null,
      routineTitle: (row.routine_title as string | null) ?? null,
      conversation: ((row.conversation as string | null) ?? 'primary') as FleetRoutineRun['conversation'],
      quiet: Boolean(row.quiet),
      pinned: Boolean(row.pinned),
      lastActivityAt: (row.last_activity_at as string | null) ?? null,
      // Computed from the bot's settings when the run is read.
      expiresAt: null,
      conversationDeletedAt: (row.conversation_deleted_at as string | null) ?? null,
      media: json<FleetRoutineRun['media']>(row.media_json),
      kept: json<FleetRoutineRun['kept']>(row.kept_json),
      adjustments: Number(row.adjustments ?? 0),
    }
  }
  insertRoutineRun(run: StoredRoutineRun) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO routine_runs(id,routine_id,bot_id,input_id,trigger,status,delivered_at,finished_at,report_json,final_text,routine_title,conversation,quiet,pinned,last_activity_at,conversation_deleted_at,media_json,kept_json,adjustments) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
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
        run.finalText,
        run.routineTitle ?? null,
        run.conversation ?? 'primary',
        Number(run.quiet ?? false),
        Number(run.pinned ?? false),
        run.lastActivityAt ?? null,
        run.conversationDeletedAt ?? null,
        run.media ? JSON.stringify(run.media) : null,
        run.kept ? JSON.stringify(run.kept) : null,
        run.adjustments ?? 0
      )
  }
  updateRoutineRun(run: StoredRoutineRun) {
    this.db
      .prepare(
        'UPDATE routine_runs SET status=?, finished_at=?, report_json=?, final_text=?, conversation=?, quiet=?, pinned=?, last_activity_at=?, conversation_deleted_at=?, media_json=?, kept_json=?, adjustments=? WHERE id=?'
      )
      .run(
        run.status,
        run.finishedAt,
        run.report ? JSON.stringify(run.report) : null,
        run.finalText,
        run.conversation,
        Number(run.quiet),
        Number(run.pinned),
        run.lastActivityAt,
        run.conversationDeletedAt,
        run.media ? JSON.stringify(run.media) : null,
        run.kept ? JSON.stringify(run.kept) : null,
        run.adjustments,
        run.id
      )
  }
  routineRuns(routineId: string, limit: number): StoredRoutineRun[] {
    return (
      this.db
        .prepare('SELECT * FROM routine_runs WHERE routine_id=? ORDER BY delivered_at DESC LIMIT ?')
        .all(routineId, limit) as Row[]
    ).map((row) => this.routineRun(row))
  }
  /** A bot's runs, newest first; `before` starts after that run, `routineId` keeps one routine's. */
  botRoutineRuns(
    botId: string,
    options: { limit: number; before?: StoredRoutineRun | null; routineId?: string | null }
  ): StoredRoutineRun[] {
    const clauses = ['bot_id=?']
    const values: Array<string | number> = [botId]
    if (options.routineId) {
      clauses.push('routine_id=?')
      values.push(options.routineId)
    }
    if (options.before) {
      clauses.push('(delivered_at<? OR (delivered_at=? AND id<?))')
      values.push(options.before.deliveredAt, options.before.deliveredAt, options.before.id)
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM routine_runs WHERE ${clauses.join(' AND ')} ORDER BY delivered_at DESC, id DESC LIMIT ?`
        )
        .all(...values, options.limit) as Row[]
    ).map((row) => this.routineRun(row))
  }
  /** The runs whose conversations are their own and still there, of one bot or of all: what retention looks at. */
  ownRoutineRuns(botId?: string): StoredRoutineRun[] {
    return (
      (botId
        ? this.db
            .prepare("SELECT * FROM routine_runs WHERE conversation='own' AND bot_id=? ORDER BY delivered_at DESC")
            .all(botId)
        : this.db
            .prepare("SELECT * FROM routine_runs WHERE conversation='own' ORDER BY delivered_at DESC")
            .all()) as Row[]
    ).map((row) => this.routineRun(row))
  }
  /** The routines whose runs are recorded for a bot, with the newest title of each: runs outlive their routines. */
  routineRunGroups(botId: string): Array<{ routineId: string; routineTitle: string | null; count: number }> {
    return (
      this.db
        .prepare(
          'SELECT routine_id, (SELECT routine_title FROM routine_runs AS newest WHERE newest.routine_id=r.routine_id AND newest.bot_id=r.bot_id ORDER BY delivered_at DESC LIMIT 1) AS title, COUNT(*) AS count FROM routine_runs AS r WHERE bot_id=? GROUP BY routine_id'
        )
        .all(botId) as Row[]
    ).map((row) => ({
      routineId: String(row.routine_id),
      routineTitle: (row.title as string | null) ?? null,
      count: Number(row.count),
    }))
  }
  deleteRoutineRun(id: string) {
    this.db.prepare('DELETE FROM routine_runs WHERE id=?').run(id)
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
  /**
   * Keeps a routine's newest `keep` runs, and older ones the owner keeps or whose conversations are still there: those
   * leave once retention deleted their conversations.
   */
  pruneRoutineRuns(routineId: string, keep: number): string[] {
    const removed = (
      this.db
        .prepare(
          "SELECT id FROM routine_runs WHERE routine_id=? AND pinned=0 AND conversation<>'own' AND id NOT IN (SELECT id FROM routine_runs WHERE routine_id=? ORDER BY delivered_at DESC LIMIT ?)"
        )
        .all(routineId, routineId, keep) as Row[]
    ).map((row) => String(row.id))
    const remove = this.db.prepare('DELETE FROM routine_runs WHERE id=?')
    this.transaction(() => {
      for (const id of removed) remove.run(id)
    })
    return removed
  }
  /** How a bot keeps its runs' conversations; null until the owner chose. */
  runSettings(botId: string): FleetRoutineRunSettings | null {
    const row = this.db.prepare('SELECT run_settings_json FROM bots WHERE id=?').get(botId) as Row | undefined
    return row?.run_settings_json ? (JSON.parse(String(row.run_settings_json)) as FleetRoutineRunSettings) : null
  }
  saveRunSettings(botId: string, settings: FleetRoutineRunSettings) {
    this.db.prepare('UPDATE bots SET run_settings_json=? WHERE id=?').run(JSON.stringify(settings), botId)
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
  /** Codes that can still pair a device: not used, not expired, not locked by failed attempts. */
  activePairings(now = new Date().toISOString()): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM pairing_codes WHERE used_at IS NULL AND expires_at > ? AND attempts < 5')
      .get(now) as { n: number }
    return Number(row.n)
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
          'INSERT INTO devices(id,name,kind,platform,token_sha256,created_at,last_seen_at,revoked_at) VALUES(?,?,?,?,?,?,NULL,NULL)'
        )
        .run(device.id, device.name, device.kind, device.platform, tokenHash, device.createdAt)
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
    return row ? deviceRow(row) : null
  }
  listDevices(): Device[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all() as Row[]).map(deviceRow)
  }
  deviceRevoked(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM devices WHERE id=? AND revoked_at IS NOT NULL').get(id)
  }
  touchDevice(id: string) {
    this.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(new Date().toISOString(), id)
  }
  revokeDevice(id: string) {
    const revoked =
      this.db
        .prepare('UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
        .run(new Date().toISOString(), id).changes > 0
    // A removed phone gets no more notifications, and its push token is not kept.
    this.deletePushRegistration(id)
    return revoked
  }
  pushRegistration(deviceId: string): FleetPushRegistration | null {
    const row = this.db.prepare('SELECT * FROM push_registrations WHERE device_id=?').get(deviceId) as Row | undefined
    return row ? pushRegistrationRow(row) : null
  }
  savePushRegistration(deviceId: string, request: FleetPushRegistrationRequest): FleetPushRegistration {
    const at = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO push_registrations(device_id,provider,token,platform,locale,preferences_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET provider=excluded.provider, token=excluded.token, platform=excluded.platform, locale=excluded.locale, preferences_json=excluded.preferences_json, updated_at=excluded.updated_at'
      )
      .run(
        deviceId,
        request.provider,
        request.token,
        request.platform,
        request.locale,
        JSON.stringify(request.preferences),
        at,
        at
      )
    return this.pushRegistration(deviceId)!
  }
  deletePushRegistration(deviceId: string): boolean {
    return this.db.prepare('DELETE FROM push_registrations WHERE device_id=?').run(deviceId).changes > 0
  }
  /** The server's dictation key, in plaintext like the other secrets the gateway keeps. */
  dictationSettings(): StoredDictation | null {
    const row = this.db.prepare('SELECT * FROM dictation_settings WHERE id=1').get() as Row | undefined
    if (!row) return null
    const provider = dictationProviderSchema.safeParse(row.provider)
    if (!provider.success) return null
    return {
      provider: provider.data,
      key: String(row.api_key),
      updatedAt: String(row.updated_at),
      updatedBy: String(row.updated_by),
    }
  }
  saveDictationSettings(provider: DictationProvider, key: string, updatedBy: string): void {
    this.db
      .prepare(
        'INSERT INTO dictation_settings(id,provider,api_key,updated_at,updated_by) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, api_key=excluded.api_key, updated_at=excluded.updated_at, updated_by=excluded.updated_by'
      )
      .run(provider, key, new Date().toISOString(), updatedBy)
  }
  clearDictationSettings(): boolean {
    return this.db.prepare('DELETE FROM dictation_settings WHERE id=1').run().changes > 0
  }
  /** The registrations of phones still paired. */
  activePushRegistrations(): { deviceId: string; registration: FleetPushRegistration }[] {
    const rows = this.db
      .prepare(
        'SELECT push_registrations.* FROM push_registrations JOIN devices ON devices.id = push_registrations.device_id WHERE devices.revoked_at IS NULL'
      )
      .all() as Row[]
    return rows.flatMap((row) => {
      try {
        return [{ deviceId: String(row.device_id), registration: pushRegistrationRow(row) }]
      } catch {
        return []
      }
    })
  }
  device(id: string): Device | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE id=?').get(id) as Row | undefined
    return row ? deviceRow(row) : null
  }

  private desktopLink(row: Row): StoredDesktopLink {
    return {
      botId: String(row.bot_id),
      deviceId: String(row.device_id),
      desktopId: String(row.desktop_id),
      name: String(row.name),
      linkedAt: String(row.linked_at),
      updatedAt: String(row.updated_at),
    }
  }
  /** The Macs linked to a bot, oldest link first. */
  desktopLinks(botId: string): StoredDesktopLink[] {
    return (
      this.db.prepare('SELECT * FROM desktop_links WHERE bot_id=? ORDER BY linked_at, desktop_id').all(botId) as Row[]
    ).map((row) => this.desktopLink(row))
  }
  desktopLinksOfDevice(deviceId: string): StoredDesktopLink[] {
    return (
      this.db
        .prepare('SELECT * FROM desktop_links WHERE device_id=? ORDER BY linked_at, desktop_id')
        .all(deviceId) as Row[]
    ).map((row) => this.desktopLink(row))
  }
  /** The one link a desktop id names, a computer's or an environment's; ids are unique across both. */
  desktopLinkById(desktopId: string): StoredDesktopTarget | null {
    const row = this.db.prepare('SELECT * FROM desktop_links WHERE desktop_id=?').get(desktopId) as Row | undefined
    if (row) return { kind: 'device', link: this.desktopLink(row) }
    const environment = this.db.prepare('SELECT * FROM environment_desktop_links WHERE desktop_id=?').get(desktopId) as
      | Row
      | undefined
    return environment ? { kind: 'environment', link: this.environmentDesktopLink(environment) } : null
  }
  private environmentDesktopLink(row: Row): StoredEnvironmentDesktopLink {
    return {
      botId: String(row.bot_id),
      environmentId: String(row.environment_id),
      desktopId: String(row.desktop_id),
      name: String(row.name),
      linkedAt: String(row.linked_at),
      updatedAt: String(row.updated_at),
    }
  }
  /** The workspaces environments linked to a bot, oldest link first. */
  environmentDesktopLinks(botId: string): StoredEnvironmentDesktopLink[] {
    return (
      this.db
        .prepare('SELECT * FROM environment_desktop_links WHERE bot_id=? ORDER BY linked_at, desktop_id')
        .all(botId) as Row[]
    ).map((row) => this.environmentDesktopLink(row))
  }
  /** The bots a workspaces environment gave access to, oldest link first. */
  desktopLinksOfEnvironment(environmentId: string): StoredEnvironmentDesktopLink[] {
    return (
      this.db
        .prepare('SELECT * FROM environment_desktop_links WHERE environment_id=? ORDER BY linked_at, desktop_id')
        .all(environmentId) as Row[]
    ).map((row) => this.environmentDesktopLink(row))
  }
  /** Links a workspaces environment to a bot under a name, or renames its link; its `desktopId` stays as it was. */
  saveEnvironmentDesktopLink(
    botId: string,
    environmentId: string,
    name: string,
    desktopId: string,
    at = now()
  ): StoredEnvironmentDesktopLink {
    this.db
      .prepare(
        `INSERT INTO environment_desktop_links(bot_id,environment_id,desktop_id,name,linked_at,updated_at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(bot_id,environment_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`
      )
      .run(botId, environmentId, desktopId, name, at, at)
    const row = this.db
      .prepare('SELECT * FROM environment_desktop_links WHERE bot_id=? AND environment_id=?')
      .get(botId, environmentId) as Row
    return this.environmentDesktopLink(row)
  }
  deleteEnvironmentDesktopLink(botId: string, environmentId: string): StoredEnvironmentDesktopLink | null {
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM environment_desktop_links WHERE bot_id=? AND environment_id=?')
        .get(botId, environmentId) as Row | undefined
      if (!row) return null
      this.db
        .prepare('DELETE FROM environment_desktop_links WHERE bot_id=? AND environment_id=?')
        .run(botId, environmentId)
      return this.environmentDesktopLink(row)
    })
  }
  /**
   * Links a Mac to a bot under a name, or renames its link: a link keeps its `desktopId` for as long as it exists, so
   * the ids the Mac handed the bot stay valid. Linking again after an unlink mints a new one.
   */
  saveDesktopLink(botId: string, deviceId: string, name: string, desktopId: string, at = now()): StoredDesktopLink {
    this.db
      .prepare(
        `INSERT INTO desktop_links(bot_id,device_id,desktop_id,name,linked_at,updated_at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(bot_id,device_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`
      )
      .run(botId, deviceId, desktopId, name, at, at)
    const row = this.db
      .prepare('SELECT * FROM desktop_links WHERE bot_id=? AND device_id=?')
      .get(botId, deviceId) as Row
    return this.desktopLink(row)
  }
  deleteDesktopLink(botId: string, deviceId: string): StoredDesktopLink | null {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM desktop_links WHERE bot_id=? AND device_id=?').get(botId, deviceId) as
        | Row
        | undefined
      if (!row) return null
      this.db.prepare('DELETE FROM desktop_links WHERE bot_id=? AND device_id=?').run(botId, deviceId)
      return this.desktopLink(row)
    })
  }
  /** Removes every link of a Mac; returns them. */
  deleteDesktopLinksOfDevice(deviceId: string): StoredDesktopLink[] {
    return this.transaction(() => {
      const links = this.desktopLinksOfDevice(deviceId)
      this.db.prepare('DELETE FROM desktop_links WHERE device_id=?').run(deviceId)
      return links
    })
  }

  private environment(row: Row): StoredEnvironment {
    return {
      id: String(row.id),
      name: String(row.name),
      kind: row.kind === 'workspaces' ? 'workspaces' : 'bots',
      lifecycle: row.lifecycle as FleetLifecycle,
      setup: JSON.parse(String(row.setup_json)) as FleetEnvironmentSetup,
      containerName: String(row.container_name),
      volumeName: String(row.volume_name),
      memoryLimitBytes: row.memory_limit_bytes === null ? null : Number(row.memory_limit_bytes),
      cpuLimit: row.cpu_limit === null || row.cpu_limit === undefined ? null : Number(row.cpu_limit),
      idleStopMinutes:
        row.idle_stop_minutes === null || row.idle_stop_minutes === undefined ? null : Number(row.idle_stop_minutes),
      tint: typeof row.tint === 'string' ? row.tint : null,
      hostFolder: row.host_folder === 'own' || row.host_folder === 'shared' ? row.host_folder : null,
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
          'INSERT INTO environments(id,name,kind,lifecycle,setup_json,container_name,volume_name,memory_limit_bytes,cpu_limit,idle_stop_minutes,tint,host_folder,compaction_json,update_requested_at,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          environment.id,
          environment.name,
          environment.kind,
          environment.lifecycle,
          JSON.stringify(environment.setup),
          environment.containerName,
          environment.volumeName,
          environment.memoryLimitBytes,
          environment.cpuLimit ?? null,
          environment.idleStopMinutes ?? null,
          environment.tint ?? null,
          environment.hostFolder ?? null,
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
        cpuLimit: changes.cpuLimit === undefined ? current.cpuLimit : changes.cpuLimit,
        idleStopMinutes: changes.idleStopMinutes === undefined ? current.idleStopMinutes : changes.idleStopMinutes,
        tint: changes.tint === undefined ? current.tint : changes.tint,
        hostFolder: changes.hostFolder === undefined ? current.hostFolder : changes.hostFolder,
        compaction: changes.compaction === undefined ? current.compaction : changes.compaction,
        updateRequestedAt:
          changes.updateRequestedAt === undefined ? current.updateRequestedAt : changes.updateRequestedAt,
        updatedAt: at,
      }
      this.db
        .prepare(
          'UPDATE environments SET name=?,lifecycle=?,setup_json=?,memory_limit_bytes=?,cpu_limit=?,idle_stop_minutes=?,tint=?,host_folder=?,compaction_json=?,update_requested_at=?,updated_at=? WHERE id=?'
        )
        .run(
          next.name,
          next.lifecycle,
          JSON.stringify(next.setup),
          next.memoryLimitBytes,
          next.cpuLimit,
          next.idleStopMinutes,
          next.tint,
          next.hostFolder,
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
  /** The token a workspaces environment publishes artifacts with, or null until its container is created with one. */
  hostGatewaySecrets(environmentId: string): BotGatewaySecrets | null {
    const row = this.db.prepare('SELECT * FROM host_secrets WHERE environment_id=?').get(environmentId) as
      | Row
      | undefined
    return row
      ? { gatewayToken: String(row.gateway_token), gatewayTokenSha256: String(row.gateway_token_sha256) }
      : null
  }
  /** Gives a workspaces environment its token, unless it already has one; returns the token it keeps. */
  ensureHostGatewaySecrets(environmentId: string, secrets: BotGatewaySecrets): BotGatewaySecrets {
    return this.transaction(() => {
      const environment = this.activeEnvironment(environmentId)
      if (environment.kind !== 'workspaces') throw new Error('Only a workspaces environment has a host token')
      this.db
        .prepare(
          'INSERT INTO host_secrets(environment_id,gateway_token,gateway_token_sha256) VALUES(?,?,?) ON CONFLICT(environment_id) DO NOTHING'
        )
        .run(environmentId, secrets.gatewayToken, secrets.gatewayTokenSha256)
      return this.hostGatewaySecrets(environmentId)!
    })
  }
  /** The active workspaces environment a host token belongs to; an archived one's token is refused. */
  hostByGatewayHash(hash: string): string | null {
    let row: Row | undefined
    for (const item of this.db
      .prepare(
        "SELECT s.environment_id,s.gateway_token_sha256 FROM host_secrets s JOIN environments e ON e.id=s.environment_id WHERE e.kind='workspaces' AND e.archived_at IS NULL"
      )
      .all() as Row[]) {
      if (this.digestMatches(hash, item.gateway_token_sha256)) row = item
    }
    return row ? String(row.environment_id) : null
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
      this.db.prepare('DELETE FROM host_secrets WHERE environment_id=?').run(id)
      this.db.prepare('DELETE FROM environment_desktop_links WHERE environment_id=?').run(id)
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
  /**
   * The lowest slot (1 to 8) that no active bot of the environment uses and no bot moving there holds; null when it is
   * full.
   */
  freeSlot(environmentId: string): number | null {
    const used = new Set(
      (
        this.db
          .prepare(
            `SELECT slot FROM bots WHERE environment_id=? AND archived_at IS NULL UNION SELECT to_slot AS slot FROM bot_moves WHERE to_environment_id=? AND ${RESERVING}`
          )
          .all(environmentId, environmentId) as Row[]
      ).map((row) => Number(row.slot))
    )
    for (let slot = 1; slot <= SLOTS; slot++) if (!used.has(slot)) return slot
    return null
  }
  private slotTaken(environmentId: string, slot: number): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM bots WHERE environment_id=? AND slot=? AND archived_at IS NULL UNION SELECT 1 FROM bot_moves WHERE to_environment_id=? AND to_slot=? AND ${RESERVING}`
      )
      .get(environmentId, slot, environmentId, slot)
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
        const environment = this.activeEnvironment(placement.environmentId)
        if (environment.kind === 'workspaces')
          throw new GatewayError('CONFLICT', 'Workspaces environments hold no bots.')
        environmentId = environment.id
        slot = this.claimSlot(environmentId, placement.slot)
      } else {
        if (secrets.controlToken === undefined || secrets.keyringPassword === undefined)
          throw new Error('A bot without an environment needs the secrets of its new environment')
        this.insertEnvironment(
          {
            id: bot.id,
            name: bot.name,
            kind: 'bots',
            lifecycle: bot.lifecycle,
            setup: environmentSetupOf(bot.setup, bot.lifecycle),
            containerName: legacyContainerName(bot.id),
            volumeName: legacyVolumeName(bot.id),
            memoryLimitBytes: null,
            cpuLimit: null,
            idleStopMinutes: null,
            tint: null,
            hostFolder: null,
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
        .prepare(`INSERT INTO bots(id,name,role,instructions,tint,ceiling,selection_json,compaction_json,talks_to_json,paused,publish_artifacts,lifecycle,setup_json,created_at,updated_at,archived_at,environment_id,slot,delegation_json,archived_with_environment)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
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
          Number(bot.publishArtifacts ?? false),
          bot.lifecycle,
          JSON.stringify(bot.setup),
          bot.createdAt,
          bot.updatedAt,
          bot.lifecycle === 'archived' ? bot.updatedAt : null,
          environmentId,
          slot,
          bot.delegation ? JSON.stringify(bot.delegation) : null
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
      .prepare(`UPDATE bots SET name=?,role=?,instructions=?,tint=?,ceiling=?,selection_json=?,compaction_json=?,talks_to_json=?,paused=?,publish_artifacts=?,lifecycle=?,setup_json=?,delegation_json=?,updated_at=?,
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
        Number(bot.publishArtifacts ?? false),
        bot.lifecycle,
        JSON.stringify(bot.setup),
        bot.delegation ? JSON.stringify(bot.delegation) : null,
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
  private botMoveRow(row: Row): StoredBotMove {
    return {
      id: String(row.id),
      botId: String(row.bot_id),
      fromEnvironmentId: String(row.from_environment_id),
      toEnvironmentId: String(row.to_environment_id),
      fromSlot: Number(row.from_slot),
      toSlot: Number(row.to_slot),
      newEnvironment: Boolean(row.new_environment),
      phase: row.phase as FleetBotMove['phase'],
      state: row.state as FleetBotMove['state'],
      error:
        row.error_code === null || row.error_code === undefined
          ? null
          : { code: row.error_code as NonNullable<FleetBotMove['error']>['code'], message: String(row.error_message) },
      startedAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
  /**
   * Starts a bot's move to an active bots environment, holding the lowest free slot there: refused for a bot that is
   * archived, already moving, or already in that environment, and for a destination that is full.
   */
  beginBotMove(input: { id: string; botId: string; toEnvironmentId: string; newEnvironment: boolean }, at = now()) {
    return this.transaction(() => {
      const bot = this.getBot(input.botId)
      const placement = this.botPlacement(input.botId)
      if (!bot || !placement || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
      if (this.runningBotMove(input.botId)) throw new GatewayError('CONFLICT', 'This bot is already moving.')
      const target = this.activeEnvironment(input.toEnvironmentId)
      if (target.kind === 'workspaces') throw new GatewayError('CONFLICT', 'Workspaces environments hold no bots.')
      if (target.id === placement.environmentId) throw new GatewayError('CONFLICT', 'The bot is already there.')
      const slot = this.claimSlot(target.id, undefined)
      this.db
        .prepare(
          "INSERT INTO bot_moves(id,bot_id,from_environment_id,to_environment_id,from_slot,to_slot,new_environment,phase,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'prepared','running',?,?)"
        )
        .run(
          input.id,
          input.botId,
          placement.environmentId,
          target.id,
          placement.slot,
          slot,
          Number(input.newEnvironment),
          at,
          at
        )
      return this.botMove(input.id)!
    })
  }
  botMove(id: string): StoredBotMove | null {
    const row = this.db.prepare('SELECT * FROM bot_moves WHERE id=?').get(id) as Row | undefined
    return row ? this.botMoveRow(row) : null
  }
  /** The bot's last move, running or finished. */
  latestBotMove(botId: string): StoredBotMove | null {
    const row = this.db
      .prepare('SELECT * FROM bot_moves WHERE bot_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(botId) as Row | undefined
    return row ? this.botMoveRow(row) : null
  }
  runningBotMove(botId: string): StoredBotMove | null {
    const row = this.db.prepare("SELECT * FROM bot_moves WHERE bot_id=? AND state='running'").get(botId) as
      | Row
      | undefined
    return row ? this.botMoveRow(row) : null
  }
  runningBotMoves(): StoredBotMove[] {
    return (this.db.prepare("SELECT * FROM bot_moves WHERE state='running' ORDER BY created_at").all() as Row[]).map(
      (row) => this.botMoveRow(row)
    )
  }
  /** The moves whose bot left a copy in this environment, still to delete. */
  pendingReleases(environmentId: string): StoredBotMove[] {
    return (
      this.db
        .prepare("SELECT * FROM bot_moves WHERE from_environment_id=? AND phase='releasing-source' ORDER BY created_at")
        .all(environmentId) as Row[]
    ).map((row) => this.botMoveRow(row))
  }
  updateBotMove(id: string, changes: BotMoveChanges, at = now()): StoredBotMove {
    const current = this.botMove(id)
    if (!current) throw new GatewayError('NOT_FOUND', 'Move not found')
    const next = { ...current, ...changes }
    this.db
      .prepare('UPDATE bot_moves SET phase=?, state=?, error_code=?, error_message=?, updated_at=? WHERE id=?')
      .run(next.phase, next.state, next.error?.code ?? null, next.error?.message ?? null, at, id)
    return this.botMove(id)!
  }
  /**
   * The commit point of a move: the bot belongs to its destination, in the slot the move held, and the owner memories
   * it wrote in the environment it leaves go with it. What an earlier move left of the bot in the destination was
   * replaced by its import, so no release deletes it any more. Returns how many owner memories moved.
   */
  commitBotMove(id: string, at = now()): { ownerMemoriesMoved: number } {
    return this.transaction(() => {
      const move = this.botMove(id)
      if (move?.state !== 'running' || move.phase !== 'committing')
        throw new GatewayError('CONFLICT', 'The move cannot commit')
      this.db
        .prepare('UPDATE bots SET environment_id=?, slot=?, updated_at=? WHERE id=?')
        .run(move.toEnvironmentId, move.toSlot, at, move.botId)
      const ownerMemoriesMoved = Number(
        this.db
          .prepare(
            "UPDATE owner_memories SET environment_id=?, updated_at=? WHERE author_kind='bot' AND author_bot_id=? AND environment_id=?"
          )
          .run(move.toEnvironmentId, at, move.botId, move.fromEnvironmentId).changes
      )
      if (ownerMemoriesMoved) this.bumpOwnerMemoryRevision()
      this.db
        .prepare(
          "UPDATE bot_moves SET phase='completed', updated_at=? WHERE bot_id=? AND from_environment_id=? AND phase='releasing-source'"
        )
        .run(at, move.botId, move.toEnvironmentId)
      this.updateBotMove(id, { phase: 'releasing-source' }, at)
      return { ownerMemoriesMoved }
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
      publishArtifacts: Boolean(row.publish_artifacts),
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
      resources: {
        memoryBytes: null,
        memoryLimitBytes: null,
        cpuPercent: null,
        startedAt: null,
        swapBytes: null,
        oomKills: null,
        limitOoms: null,
      },
      screen: { width: 1280, height: 800, display: ':0' },
      appVersion: null,
      capabilities: [],
      environmentId: String(row.environment_id),
      move: null,
      runSettings: row.run_settings_json
        ? (JSON.parse(String(row.run_settings_json)) as FleetRoutineRunSettings)
        : FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
      peerSettings: row.peer_settings_json
        ? (JSON.parse(String(row.peer_settings_json)) as FleetPeerThreadSettings)
        : FLEET_PEER_THREAD_SETTINGS_DEFAULT,
      delegation: row.delegation_json
        ? (fleetBotDelegationSchema.safeParse(JSON.parse(String(row.delegation_json))).data ?? null)
        : null,
      sharedFiles: null,
      runningRun: null,
      turns: null,
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
      // Its sides of threads go; a thread whose other bot keeps its conversation stays for that bot.
      this.db.prepare('DELETE FROM peer_thread_sides WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM peer_threads WHERE id NOT IN (SELECT thread_id FROM peer_thread_sides)').run()
      this.db.prepare('DELETE FROM routine_runs WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM routines WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM activity WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM desktop_links WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM environment_desktop_links WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM owner_messages WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM bot_moves WHERE bot_id=?').run(id)
      this.db.prepare('DELETE FROM pair_blocks WHERE pair_key LIKE ?').run('%|' + id + '|%')
      this.db
        .prepare('DELETE FROM idempotency WHERE scope IN (?,?,?,?,?,?,?,?)')
        .run(
          'botMessageSend:' + id,
          'botMessageEdit:' + id,
          'routineCreate:' + id,
          'botRoutineCreate:' + id,
          'botOwnerMemorySave:' + id,
          'peer:' + id,
          'botMove:' + id,
          'botPeerThreadMessageSend:' + id
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
  insertPeerMessage(message: FleetPeerMessage, threadId: string | null = null) {
    this.db
      .prepare('INSERT INTO peer_messages(id,at,from_bot,to_bot,text,delivered,thread_id) VALUES(?,?,?,?,?,?,?)')
      .run(message.id, message.at, message.from, message.to, message.text, Number(message.delivered), threadId)
    if (!message.delivered)
      this.db
        .prepare('INSERT INTO pending_deliveries(message_id,to_bot,created_at) VALUES(?,?,?)')
        .run(message.id, message.to, message.at)
  }
  /** Messages waiting for their bot, with the thread each continues (null from before threads). */
  pendingPeers(toBot?: string): StoredPeerMessage[] {
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
      threadId: row.thread_id ? String(row.thread_id) : null,
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
  // Threads between bots (`peer-conversations`).
  /** Records a thread with its two sides; a thread already there (a retried send) stays as it is. */
  insertPeerThread(thread: StoredPeerThread, sides: StoredPeerThreadSide[]) {
    this.transaction(() => {
      const inserted = this.db
        .prepare(
          'INSERT OR IGNORE INTO peer_threads(id,bot_a,bot_b,title,hops,messages,status,blocked_bot,created_at,last_activity_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          thread.id,
          thread.botA,
          thread.botB,
          thread.title,
          thread.hops,
          thread.messages,
          thread.status,
          thread.blockedBot,
          thread.createdAt,
          thread.lastActivityAt
        )
      if (!inserted.changes) return
      for (const side of sides) this.savePeerThreadSide(side)
    })
  }
  peerThread(id: string): StoredPeerThread | null {
    const row = this.db.prepare('SELECT * FROM peer_threads WHERE id=?').get(id) as Row | undefined
    return row ? peerThreadOf(row) : null
  }
  updatePeerThread(thread: StoredPeerThread) {
    this.db
      .prepare(
        'UPDATE peer_threads SET title=?, hops=?, messages=?, status=?, blocked_bot=?, last_activity_at=? WHERE id=?'
      )
      .run(
        thread.title,
        thread.hops,
        thread.messages,
        thread.status,
        thread.blockedBot,
        thread.lastActivityAt,
        thread.id
      )
  }
  peerThreadSide(threadId: string, botId: string): StoredPeerThreadSide | null {
    const row = this.db
      .prepare('SELECT * FROM peer_thread_sides WHERE thread_id=? AND bot_id=?')
      .get(threadId, botId) as Row | undefined
    return row ? peerThreadSideOf(row) : null
  }
  savePeerThreadSide(side: StoredPeerThreadSide) {
    this.db
      .prepare(
        `INSERT INTO peer_thread_sides(thread_id,bot_id,origin,pinned,conversation,conversation_deleted_at,kept_json,report,report_at)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(thread_id,bot_id) DO UPDATE SET pinned=excluded.pinned, conversation=excluded.conversation,
           conversation_deleted_at=excluded.conversation_deleted_at, kept_json=excluded.kept_json, report=excluded.report,
           report_at=excluded.report_at`
      )
      .run(
        side.threadId,
        side.botId,
        side.origin,
        Number(side.pinned),
        side.conversation,
        side.conversationDeletedAt,
        side.kept ? JSON.stringify(side.kept) : null,
        side.report,
        side.reportAt
      )
  }
  /** A bot's sides of its threads with the threads themselves, the most recently active first. */
  botPeerThreads(botId: string, limit: number): Array<{ thread: StoredPeerThread; side: StoredPeerThreadSide }> {
    const rows = this.db
      .prepare(
        'SELECT t.*, s.thread_id, s.bot_id, s.origin, s.pinned, s.conversation, s.conversation_deleted_at, s.kept_json, s.report, s.report_at FROM peer_thread_sides s JOIN peer_threads t ON t.id=s.thread_id WHERE s.bot_id=? ORDER BY t.last_activity_at DESC, t.id LIMIT ?'
      )
      .all(botId, limit) as Row[]
    return rows.map((row) => ({ thread: peerThreadOf(row), side: peerThreadSideOf(row) }))
  }
  /** Every side whose conversation the bot still has: retention looks at them. */
  ownPeerThreadSides(): Array<{ thread: StoredPeerThread; side: StoredPeerThreadSide }> {
    const rows = this.db
      .prepare(
        "SELECT t.*, s.thread_id, s.bot_id, s.origin, s.pinned, s.conversation, s.conversation_deleted_at, s.kept_json, s.report, s.report_at FROM peer_thread_sides s JOIN peer_threads t ON t.id=s.thread_id WHERE s.conversation='own' ORDER BY t.last_activity_at"
      )
      .all() as Row[]
    return rows.map((row) => ({ thread: peerThreadOf(row), side: peerThreadSideOf(row) }))
  }
  /** Deletes a thread once neither of its bots has its conversation any more. */
  deletePeerThreadIfGone(id: string): boolean {
    const own = this.db
      .prepare("SELECT COUNT(*) AS count FROM peer_thread_sides WHERE thread_id=? AND conversation='own'")
      .get(id) as Row
    if (Number(own.count) > 0) return false
    this.db.prepare('DELETE FROM peer_threads WHERE id=?').run(id)
    return true
  }
  peerSettings(botId: string): FleetPeerThreadSettings | null {
    const row = this.db.prepare('SELECT peer_settings_json FROM bots WHERE id=?').get(botId) as Row | undefined
    return row?.peer_settings_json ? (JSON.parse(String(row.peer_settings_json)) as FleetPeerThreadSettings) : null
  }
  savePeerSettings(botId: string, settings: FleetPeerThreadSettings) {
    this.db.prepare('UPDATE bots SET peer_settings_json=? WHERE id=?').run(JSON.stringify(settings), botId)
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
  /** A routine leaves with the runs it made in the bot's conversation; those with conversations of their own stay. */
  deleteRoutine(id: string) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM routine_runs WHERE routine_id=? AND conversation='primary'").run(id)
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
