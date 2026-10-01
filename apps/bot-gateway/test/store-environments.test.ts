import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type FleetBot,
  type FleetBotSetup,
  type FleetEnvironmentSetup,
  type FleetOwnerMemoryEntry,
  type FleetRoutine,
  fleetEnvironmentSetupSchema,
} from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayError } from '../src/errors.js'
import { Store, type StoredEnvironment } from '../src/store.js'
import { createSchema5Database, createSchema6Database, createSchema7Database, dumpTables } from './store-fixtures.js'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close()
    } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'store-environments-'))
  dirs.push(dir)
  return dir
}
function open(dir = temp()) {
  const store = new Store(dir)
  stores.push(store)
  return store
}
const file = (dir: string) => path.join(dir, 'gateway.sqlite')
const at = (day: number, hour = 10) =>
  `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const setup = (step: FleetEnvironmentSetup['step']): FleetEnvironmentSetup => ({
  step,
  error: null,
  errorMessage: null,
})
const botSetup = (step: FleetBotSetup['step']): FleetBotSetup => ({ step, error: null, errorMessage: null })
const version = (db: DatabaseSync) =>
  String((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: unknown }).value)
const schemaOf = (db: DatabaseSync) => db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof GatewayError ? error.code : 'NOT_A_GATEWAY_ERROR'
  }
  return 'NO_ERROR'
}

const selection = { providerId: 'openai', modelId: 'synthetic-model', reasoning: 'high', fastMode: false }
const compaction = { ...selection, intervalTokens: 60000 }

function botRecord(id: string, overrides: Partial<FleetBot> = {}): FleetBot {
  return {
    id,
    name: 'Bot ' + id,
    role: '',
    instructions: 'Synthetic instructions',
    tint: '#4978c6',
    ceiling: 'ask',
    selection: null,
    compaction: null,
    compactionSource: null,
    compactionState: null,
    talksTo: [],
    publishArtifacts: false,
    paused: false,
    lifecycle: 'running',
    setup: botSetup('ready'),
    status: 'offline',
    activity: null,
    pendingCount: 0,
    accounts: { connected: false, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
    screen: { width: 1280, height: 800, display: ':0' },
    appVersion: null,
    capabilities: [],
    usage: null,
    environmentId: null,
    createdAt: at(20),
    updatedAt: at(20),
    ...overrides,
  }
}
function environmentRecord(id: string, overrides: Partial<StoredEnvironment> = {}): StoredEnvironment {
  return {
    id,
    name: 'Environment ' + id,
    lifecycle: 'running',
    setup: setup('ready'),
    containerName: 'maestrly-env-' + id,
    volumeName: 'maestrly-env-' + id + '-home',
    memoryLimitBytes: null,
    compaction: null,
    updateRequestedAt: null,
    createdAt: at(20),
    updatedAt: at(20),
    archivedAt: null,
    ...overrides,
  }
}
const environmentSecrets = (id: string) => ({
  controlToken: 'synthetic-control-' + id,
  keyringPassword: 'synthetic-keyring-' + id,
})
const gatewaySecrets = (id: string) => ({
  gatewayToken: 'synthetic-gateway-' + id,
  gatewayTokenSha256: hash('synthetic-gateway-' + id),
})
function memory(
  id: string,
  environmentId: string | null,
  createdAt: string,
  status: FleetOwnerMemoryEntry['status'] = 'active'
): FleetOwnerMemoryEntry {
  return {
    id,
    content: 'Synthetic fact ' + id,
    status,
    author: { kind: 'owner' },
    origin: null,
    replacesId: null,
    replacedById: null,
    environmentId,
    createdAt,
    updatedAt: createdAt,
  }
}
function routine(botId: string): FleetRoutine {
  return {
    id: 'routine-' + botId,
    botId,
    title: 'Check',
    prompt: 'Check synthetic prices',
    schedule: { kind: 'interval', everyMinutes: 60 },
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastOutcome: null,
    createdBy: 'owner',
    createdAt: at(21),
    updatedAt: at(21),
  }
}

/** Two bots as a version 5 gateway stored them: `alpha` running, `beta` archived, with everything recorded about them. */
function seedSchema5(db: DatabaseSync) {
  const bot = db.prepare(
    'INSERT INTO bots(id,name,role,instructions,tint,ceiling,selection_json,talks_to_json,paused,lifecycle,setup_json,created_at,updated_at,archived_at,compaction_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  )
  bot.run(
    'alpha',
    'Alpha',
    'Research',
    'Collect synthetic facts',
    '#4978c6',
    'auto',
    JSON.stringify(selection),
    '[]',
    1,
    'running',
    JSON.stringify(botSetup('ready')),
    at(20),
    at(21),
    null,
    JSON.stringify(compaction)
  )
  bot.run(
    'beta',
    'Beta',
    '',
    'Archived synthetic bot',
    '#9b65b6',
    'ask',
    'null',
    '[]',
    0,
    'archived',
    JSON.stringify(botSetup('ready')),
    at(18),
    at(22),
    at(22),
    null
  )
  const secrets = db.prepare(
    'INSERT INTO bot_secrets(bot_id,control_token,gateway_token,gateway_token_sha256,keyring_password) VALUES(?,?,?,?,?)'
  )
  for (const id of ['alpha', 'beta'])
    secrets.run(
      id,
      'synthetic-control-' + id,
      'synthetic-gateway-' + id,
      hash('synthetic-gateway-' + id),
      'synthetic-keyring-' + id
    )
  db.exec(`
    INSERT INTO devices VALUES('device-1','Synthetic Mac','${hash('device')}','${at(19)}',NULL,NULL);
    INSERT INTO pairing_codes VALUES('${hash('pairing')}','${at(19)}',NULL,1);
    INSERT INTO routines VALUES('routine-1','alpha','Prices','Check synthetic prices','{"kind":"interval","everyMinutes":60}',1,'${at(23)}','${at(22)}','sent','${at(20)}','${at(22)}','owner','input-1');
    INSERT INTO routine_runs VALUES('run-1','routine-1','alpha','input-1','schedule','completed','${at(22)}','${at(22, 11)}',NULL,'Synthetic result');
    INSERT INTO peer_messages VALUES('message-1','${at(21)}','alpha','beta','Synthetic hello',0);
    INSERT INTO pending_deliveries VALUES('message-1','beta','${at(21)}');
    INSERT INTO owner_messages VALUES('alpha','${at(21)}');
    INSERT INTO pair_blocks VALUES('|alpha|beta|','${at(30)}');
    INSERT INTO idempotency VALUES('peer:alpha','synthetic-key','synthetic-request','{"delivered":false}',201,'${at(21)}');
    INSERT INTO owner_memories VALUES('memory-owner','Prefer synthetic answers.','active','owner',NULL,NULL,NULL,NULL,NULL,'${at(20)}','${at(20)}');
    INSERT INTO owner_memories VALUES('memory-bot','Synthetic prices change weekly.','active','bot','alpha','Alpha','auto',NULL,NULL,'${at(21)}','${at(21)}');
    INSERT INTO activity(at,bot_id,kind,summary,data_json) VALUES('${at(20)}','alpha','bot_created',NULL,'{}');
    INSERT INTO activity(at,bot_id,kind,summary,data_json) VALUES('${at(22)}','beta','bot_archived',NULL,'{}');
    INSERT INTO activity(at,bot_id,kind,summary,data_json) VALUES('${at(22)}',NULL,'bot_deleted','Gamma','{}');
    INSERT INTO meta VALUES('synthetic-setting','preserve-me');
  `)
}

describe('schema 6 migration', () => {
  it('creates schema 9 with environments in an empty data directory', () => {
    const store = open()
    expect(version(store.db)).toBe('9')
    const columns = (table: string) =>
      store.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => [column.name, column.notnull])
    expect(columns('environments')).toEqual([
      ['id', 0],
      ['name', 1],
      ['lifecycle', 1],
      ['setup_json', 1],
      ['container_name', 1],
      ['volume_name', 1],
      ['memory_limit_bytes', 0],
      ['created_at', 1],
      ['updated_at', 1],
      ['archived_at', 0],
      ['compaction_json', 0],
      ['update_requested_at', 0],
    ])
    expect(columns('environment_secrets')).toEqual([
      ['environment_id', 0],
      ['control_token', 1],
      ['keyring_password', 1],
    ])
    expect(columns('bot_secrets')).toEqual([
      ['bot_id', 0],
      ['gateway_token', 1],
      ['gateway_token_sha256', 1],
    ])
    expect(columns('bots').slice(-4)).toEqual([
      ['environment_id', 1],
      ['slot', 1],
      ['archived_with_environment', 1],
      ['publish_artifacts', 1],
    ])
    expect(columns('owner_memories').at(-1)).toEqual(['environment_id', 0])
    expect(columns('activity').at(-1)).toEqual(['environment_id', 0])
    const references = (table: string) =>
      store.db
        .prepare(`PRAGMA foreign_key_list(${table})`)
        .all()
        .map((key) => [key.from, key.table, key.on_delete])
    expect(references('bots')).toEqual([['environment_id', 'environments', 'NO ACTION']])
    expect(references('environment_secrets')).toEqual([['environment_id', 'environments', 'CASCADE']])
    expect(references('owner_memories')).toEqual([['environment_id', 'environments', 'CASCADE']])
    expect(store.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(store.listEnvironments()).toEqual([])
    expect(store.archivedEnvironments()).toEqual([])
  })

  it('turns each schema 5 bot into an environment of one, keeping its data and moving its secrets and its model', () => {
    const dir = temp()
    const db = createSchema5Database(dir)
    seedSchema5(db)
    const untouched = [
      'devices',
      'pairing_codes',
      'routines',
      'routine_runs',
      'peer_messages',
      'pending_deliveries',
      'owner_messages',
      'pair_blocks',
      'idempotency',
    ]
    const snapshot = (database: DatabaseSync) =>
      Object.fromEntries(
        untouched.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
      )
    const meta = (database: DatabaseSync) =>
      database.prepare("SELECT * FROM meta WHERE key!='schema_version' ORDER BY key").all()
    const before = snapshot(db)
    const metaBefore = meta(db)
    const botsBefore = db.prepare('SELECT * FROM bots ORDER BY id').all()
    const memoriesBefore = db.prepare('SELECT * FROM owner_memories ORDER BY id').all()
    const activityBefore = db.prepare('SELECT * FROM activity ORDER BY seq').all()
    db.close()

    const store = open(dir)
    expect(version(store.db)).toBe('9')
    expect(snapshot(store.db)).toEqual(before)
    expect(meta(store.db)).toEqual(metaBefore)

    expect(store.listEnvironments()).toEqual([
      {
        id: 'alpha',
        name: 'Alpha',
        lifecycle: 'running',
        setup: setup('ready'),
        containerName: 'maestrly-bot-alpha',
        volumeName: 'maestrly-bot-alpha-home',
        memoryLimitBytes: null,
        compaction,
        updateRequestedAt: null,
        createdAt: at(20),
        updatedAt: at(21),
        archivedAt: null,
      },
    ])
    expect(store.archivedEnvironments()).toEqual([
      {
        id: 'beta',
        name: 'Beta',
        lifecycle: 'archived',
        setup: setup('ready'),
        containerName: 'maestrly-bot-beta',
        volumeName: 'maestrly-bot-beta-home',
        memoryLimitBytes: null,
        compaction: null,
        updateRequestedAt: null,
        createdAt: at(18),
        updatedAt: at(22),
        archivedAt: at(22),
      },
    ])

    expect(store.db.prepare('SELECT * FROM bots ORDER BY id').all()).toEqual(
      botsBefore.map((row) => ({
        publish_artifacts: 0,
        ...row,
        // The migrated bot's model became its environment's default, which it now inherits.
        compaction_json: null,
        environment_id: row.id,
        slot: 1,
        archived_with_environment: row.id === 'beta' ? 1 : 0,
      }))
    )
    expect(store.getBot('alpha')).toEqual(
      botRecord('alpha', {
        name: 'Alpha',
        role: 'Research',
        instructions: 'Collect synthetic facts',
        ceiling: 'auto',
        selection,
        paused: true,
        environmentId: 'alpha',
        createdAt: at(20),
        updatedAt: at(21),
      })
    )
    expect(store.listBots().map((bot) => bot.id)).toEqual(['alpha'])
    expect(store.archivedBots()).toEqual([
      {
        bot: expect.objectContaining({ id: 'beta', lifecycle: 'archived', environmentId: 'beta' }),
        archivedAt: at(22),
        archivedWithEnvironment: true,
      },
    ])
    expect(store.botPlacement('alpha')).toEqual({ environmentId: 'alpha', slot: 1, archivedWithEnvironment: false })
    expect(store.botPlacement('beta')).toEqual({ environmentId: 'beta', slot: 1, archivedWithEnvironment: true })
    expect(store.botsOfEnvironment('alpha').map((bot) => bot.id)).toEqual(['alpha'])
    expect(store.botsOfEnvironment('beta')).toEqual([])
    expect(store.botsOfEnvironment('beta', true).map((bot) => bot.id)).toEqual(['beta'])

    for (const id of ['alpha', 'beta']) {
      expect(store.environmentSecrets(id)).toEqual(environmentSecrets(id))
      expect(store.botSecrets(id)).toEqual({ ...environmentSecrets(id), ...gatewaySecrets(id) })
      expect(store.botByGatewayHash(hash('synthetic-gateway-' + id))).toBe(id)
    }
    expect(store.db.prepare('SELECT * FROM bot_secrets ORDER BY bot_id').all()).toEqual(
      ['alpha', 'beta'].map((id) => ({
        bot_id: id,
        gateway_token: 'synthetic-gateway-' + id,
        gateway_token_sha256: hash('synthetic-gateway-' + id),
      }))
    )

    expect(store.db.prepare('SELECT * FROM owner_memories ORDER BY id').all()).toEqual(
      memoriesBefore.map((row) => ({ ...row, environment_id: null }))
    )
    expect(store.ownerMemories().map((entry) => [entry.id, entry.environmentId])).toEqual([
      ['memory-owner', null],
      ['memory-bot', null],
    ])
    expect(store.db.prepare('SELECT * FROM activity ORDER BY seq').all()).toEqual(
      activityBefore.map((row) => ({ ...row, environment_id: null }))
    )
    expect(store.activity().map((entry) => entry.environmentId)).toEqual([null, null, null])
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(store.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })

    const schema = schemaOf(store.db)
    const data = dumpTables(store.db)
    store.close()
    const reopened = open(dir)
    expect(version(reopened.db)).toBe('9')
    expect(schemaOf(reopened.db)).toEqual(schema)
    expect(dumpTables(reopened.db)).toEqual(data)
    expect(reopened.db.prepare('SELECT total_changes() AS count').get()).toEqual({ count: 0 })
  })

  it('maps every bot setup step to a valid environment setup and keeps the bot its own', () => {
    const dir = temp()
    const db = createSchema5Database(dir)
    const cases: [string, string, unknown, FleetEnvironmentSetup][] = [
      ['new-bot', 'creating', botSetup('container'), setup('container')],
      ['booting-bot', 'starting', botSetup('desktop'), setup('desktop')],
      ['profile-bot', 'starting', botSetup('profile'), setup('ready')],
      ['stopped-bot', 'stopped', botSetup('ready'), setup('ready')],
      [
        'failed-bot',
        'failed',
        { step: 'failed', error: 'IMAGE_MISSING', errorMessage: 'Bot image missing' },
        { step: 'failed', error: 'IMAGE_MISSING', errorMessage: 'Bot image missing' },
      ],
      ['blank-bot', 'running', {}, setup('ready')],
      ['blank-new-bot', 'creating', {}, setup('container')],
      ['blank-failed-bot', 'failed', { error: 'NOT_A_CODE' }, setup('failed')],
    ]
    const insert = db.prepare(
      "INSERT INTO bots(id,name,role,instructions,tint,ceiling,selection_json,talks_to_json,paused,lifecycle,setup_json,created_at,updated_at) VALUES(?,?,'','','#4978c6','ask','null','[]',0,?,?,?,?)"
    )
    for (const [id, lifecycle, bot] of cases) insert.run(id, id, lifecycle, JSON.stringify(bot), at(20), at(20))
    db.close()

    const store = open(dir)
    for (const [id, lifecycle, bot, expected] of cases) {
      const environment = store.getEnvironment(id)
      expect(environment).toMatchObject({ id, lifecycle, setup: expected })
      expect(fleetEnvironmentSetupSchema.parse(environment?.setup)).toEqual(expected)
      expect(store.getBot(id)?.setup).toEqual(bot)
    }
  })

  it.each([
    [
      'an unreadable bot setup',
      (db: DatabaseSync) => db.prepare("UPDATE bots SET setup_json='{not json' WHERE id='beta'").run(),
      (db: DatabaseSync) => db.prepare("UPDATE bots SET setup_json='{}' WHERE id='beta'").run(),
      /unreadable setup/,
    ],
    [
      'a broken foreign key',
      (db: DatabaseSync) => {
        db.exec('PRAGMA foreign_keys=OFF')
        db.prepare(
          "INSERT INTO routines(id,bot_id,title,prompt,schedule_json,enabled,created_at,updated_at) VALUES('orphan','ghost','Orphan','Check','{}',1,?,?)"
        ).run(at(20), at(20))
      },
      (db: DatabaseSync) => db.prepare("DELETE FROM routines WHERE id='orphan'").run(),
      /foreign key check failed/,
    ],
  ])('rolls back the whole migration on %s and leaves schema 5 intact', (_, corrupt, repair, error) => {
    const dir = temp()
    const db = createSchema5Database(dir)
    seedSchema5(db)
    corrupt(db)
    const schema = schemaOf(db)
    const data = dumpTables(db)
    db.close()

    expect(() => new Store(dir)).toThrow(error)
    const raw = new DatabaseSync(file(dir))
    expect(version(raw)).toBe('5')
    expect(schemaOf(raw)).toEqual(schema)
    expect(dumpTables(raw)).toEqual(data)
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'environment%'").all()).toEqual([])
    repair(raw)
    raw.close()

    const store = open(dir)
    expect(version(store.db)).toBe('9')
    expect(store.listEnvironments().map((environment) => environment.id)).toEqual(['alpha'])
  })

  it('refuses a database written by a newer gateway and leaves it untouched', () => {
    const dir = temp()
    new Store(dir).close()
    const raw = new DatabaseSync(file(dir))
    raw.prepare("UPDATE meta SET value='10' WHERE key='schema_version'").run()
    const schema = schemaOf(raw)
    const data = dumpTables(raw)
    raw.close()

    expect(() => new Store(dir)).toThrow('Gateway database schema is newer than this binary')
    const after = new DatabaseSync(file(dir))
    expect(version(after)).toBe('10')
    expect(schemaOf(after)).toEqual(schema)
    expect(dumpTables(after)).toEqual(data)
    after.close()
  })
})

describe('schema 7 migration', () => {
  const model = (modelId: string, intervalTokens = 60000) => ({
    providerId: 'openai',
    modelId,
    reasoning: null,
    fastMode: false,
    intervalTokens,
  })
  /** An environment and its bots as a version 6 gateway stored them; a string compaction is stored verbatim. */
  function seedSchema6Environment(
    db: DatabaseSync,
    id: string,
    bots: { id: string; compaction: unknown; createdAt: string; archived?: boolean }[]
  ) {
    db.prepare(
      'INSERT INTO environments(id,name,lifecycle,setup_json,container_name,volume_name,memory_limit_bytes,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,NULL,?,?,NULL)'
    ).run(
      id,
      'Environment ' + id,
      'running',
      JSON.stringify(setup('ready')),
      'maestrly-env-' + id,
      'maestrly-env-' + id + '-home',
      at(10),
      at(10)
    )
    db.prepare('INSERT INTO environment_secrets(environment_id,control_token,keyring_password) VALUES(?,?,?)').run(
      id,
      'synthetic-control-' + id,
      'synthetic-keyring-' + id
    )
    bots.forEach((bot, index) => {
      db.prepare(
        "INSERT INTO bots(id,name,role,instructions,tint,ceiling,selection_json,talks_to_json,paused,lifecycle,setup_json,created_at,updated_at,archived_at,compaction_json,environment_id,slot,archived_with_environment) VALUES(?,?,'','Synthetic instructions','#4978c6','ask','null','[]',0,?,?,?,?,?,?,?,?,0)"
      ).run(
        bot.id,
        'Bot ' + bot.id,
        bot.archived ? 'archived' : 'running',
        JSON.stringify(botSetup('ready')),
        bot.createdAt,
        bot.createdAt,
        bot.archived ? bot.createdAt : null,
        bot.compaction === null
          ? null
          : typeof bot.compaction === 'string'
            ? bot.compaction
            : JSON.stringify(bot.compaction),
        id,
        index + 1
      )
      db.prepare('INSERT INTO bot_secrets(bot_id,gateway_token,gateway_token_sha256) VALUES(?,?,?)').run(
        bot.id,
        'synthetic-gateway-' + bot.id,
        hash('synthetic-gateway-' + bot.id)
      )
    })
  }
  const storedCompaction = (db: DatabaseSync, id: string) => {
    const row = db.prepare('SELECT compaction_json FROM bots WHERE id=?').get(id) as { compaction_json: unknown }
    return row.compaction_json === null ? null : JSON.parse(String(row.compaction_json))
  }
  const checked = (db: DatabaseSync) => {
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  }

  it('seeds each environment default from its bots and makes the bots with that model inherit it', () => {
    const dir = temp()
    const db = createSchema6Database(dir)
    // A migrated environment: its migrated bot wins over an older sibling.
    seedSchema6Environment(db, 'alpha', [
      { id: 'early', compaction: model('model-y'), createdAt: at(19) },
      { id: 'alpha', compaction: model('model-x'), createdAt: at(20) },
    ])
    // A shared environment: the oldest active bot wins over an older archived one; the same model written with its
    // keys in another order still counts as the same.
    const x = model('model-x')
    seedSchema6Environment(db, 'shared', [
      { id: 'theta', compaction: model('model-w'), createdAt: at(17), archived: true },
      { id: 'beta', compaction: x, createdAt: at(18) },
      { id: 'gamma', compaction: model('model-y'), createdAt: at(19) },
      {
        id: 'delta',
        compaction: JSON.stringify({
          intervalTokens: x.intervalTokens,
          fastMode: x.fastMode,
          reasoning: x.reasoning,
          modelId: x.modelId,
          providerId: x.providerId,
        }),
        createdAt: at(20),
      },
    ])
    seedSchema6Environment(db, 'empty', [{ id: 'epsilon', compaction: null, createdAt: at(18) }])
    // Only an archived bot has a model: it still seeds the default.
    seedSchema6Environment(db, 'quiet', [
      { id: 'zeta', compaction: model('model-z'), createdAt: at(18), archived: true },
      { id: 'eta', compaction: null, createdAt: at(19) },
    ])
    const untouched = (database: DatabaseSync) => ({
      secrets: database.prepare('SELECT * FROM environment_secrets ORDER BY environment_id').all(),
      botSecrets: database.prepare('SELECT * FROM bot_secrets ORDER BY bot_id').all(),
      bots: database
        .prepare('SELECT * FROM bots ORDER BY id')
        .all()
        .map(({ compaction_json: _, ...row }) => ({ publish_artifacts: 0, ...row })),
    })
    const before = untouched(db)
    checked(db)
    db.close()

    const store = open(dir)
    expect(version(store.db)).toBe('9')
    checked(store.db)
    expect(untouched(store.db)).toEqual(before)
    expect(
      Object.fromEntries(
        [...store.listEnvironments()].map((environment) => [environment.id, environment.compaction?.modelId ?? null])
      )
    ).toEqual({ alpha: 'model-x', shared: 'model-x', empty: null, quiet: 'model-z' })
    expect(store.getEnvironment('alpha')?.compaction).toEqual(model('model-x'))
    expect(
      Object.fromEntries(
        ['alpha', 'early', 'theta', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'].map((id) => [
          id,
          storedCompaction(store.db, id)?.modelId ?? null,
        ])
      )
    ).toEqual({
      alpha: null,
      early: 'model-y',
      theta: 'model-w',
      beta: null,
      gamma: 'model-y',
      delta: null,
      epsilon: null,
      zeta: null,
      eta: null,
    })
    expect(store.getBot('gamma')?.compaction).toEqual(model('model-y'))
    expect(store.getBot('beta')?.compaction).toBeNull()

    const schema = schemaOf(store.db)
    const data = dumpTables(store.db)
    store.close()
    const reopened = open(dir)
    expect(version(reopened.db)).toBe('9')
    expect(schemaOf(reopened.db)).toEqual(schema)
    expect(dumpTables(reopened.db)).toEqual(data)
    expect(reopened.db.prepare('SELECT total_changes() AS count').get()).toEqual({ count: 0 })
  })

  it('rolls back the whole migration on an unreadable compaction and leaves schema 6 intact', () => {
    const dir = temp()
    const db = createSchema6Database(dir)
    seedSchema6Environment(db, 'alpha', [
      { id: 'alpha', compaction: model('model-x'), createdAt: at(18) },
      { id: 'broken', compaction: '{not json', createdAt: at(19) },
    ])
    const schema = schemaOf(db)
    const data = dumpTables(db)
    db.close()

    expect(() => new Store(dir)).toThrow('Gateway migration failed: bot broken has an unreadable compaction')
    const raw = new DatabaseSync(file(dir))
    expect(version(raw)).toBe('6')
    expect(schemaOf(raw)).toEqual(schema)
    expect(dumpTables(raw)).toEqual(data)
    checked(raw)
    raw.prepare("UPDATE bots SET compaction_json=NULL WHERE id='broken'").run()
    raw.close()

    const store = open(dir)
    expect(version(store.db)).toBe('9')
    expect(store.getEnvironment('alpha')?.compaction).toEqual(model('model-x'))
  })

  it('stores, changes and removes the default compaction model of an environment', () => {
    const store = open()
    store.insertEnvironment(environmentRecord('work', { compaction: model('model-x') }), environmentSecrets('work'))
    expect(store.getEnvironment('work')?.compaction).toEqual(model('model-x'))
    const changed = store.updateEnvironment('work', { compaction: model('model-y', 120000) }, at(23))
    expect(changed).toEqual(environmentRecord('work', { compaction: model('model-y', 120000), updatedAt: at(23) }))
    expect(store.getEnvironment('work')).toEqual(changed)
    // Other changes keep it.
    expect(store.updateEnvironment('work', { name: 'Work 2' }, at(24)).compaction).toEqual(model('model-y', 120000))
    expect(store.updateEnvironment('work', { compaction: null }, at(25)).compaction).toBeNull()
    expect(store.getEnvironment('work')?.compaction).toBeNull()
    checked(store.db)
  })
})

describe('schema 8 migration', () => {
  const checked = (db: DatabaseSync) => {
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  }

  it('adds a pending update to every environment of a schema 7 database, none of them waiting', () => {
    const dir = temp()
    const db = createSchema7Database(dir)
    db.prepare(
      'INSERT INTO environments(id,name,lifecycle,setup_json,container_name,volume_name,memory_limit_bytes,created_at,updated_at,archived_at,compaction_json) VALUES(?,?,?,?,?,?,NULL,?,?,?,?)'
    ).run(
      'alpha',
      'Alpha',
      'running',
      JSON.stringify(setup('ready')),
      'maestrly-env-alpha',
      'maestrly-env-alpha-home',
      at(10),
      at(11),
      null,
      JSON.stringify(compaction)
    )
    db.prepare(
      'INSERT INTO environments(id,name,lifecycle,setup_json,container_name,volume_name,memory_limit_bytes,created_at,updated_at,archived_at,compaction_json) VALUES(?,?,?,?,?,?,NULL,?,?,?,NULL)'
    ).run(
      'beta',
      'Beta',
      'archived',
      JSON.stringify(setup('ready')),
      'maestrly-env-beta',
      'maestrly-env-beta-home',
      at(10),
      at(12),
      at(12)
    )
    for (const id of ['alpha', 'beta'])
      db.prepare('INSERT INTO environment_secrets(environment_id,control_token,keyring_password) VALUES(?,?,?)').run(
        id,
        'synthetic-control-' + id,
        'synthetic-keyring-' + id
      )
    const before = db.prepare('SELECT * FROM environments ORDER BY id').all()
    checked(db)
    db.close()

    const store = open(dir)
    expect(version(store.db)).toBe('9')
    checked(store.db)
    expect(store.db.prepare('SELECT * FROM environments ORDER BY id').all()).toEqual(
      before.map((row) => ({ ...row, update_requested_at: null }))
    )
    expect(store.getEnvironment('alpha')).toEqual(
      environmentRecord('alpha', {
        name: 'Alpha',
        containerName: 'maestrly-env-alpha',
        volumeName: 'maestrly-env-alpha-home',
        compaction,
        createdAt: at(10),
        updatedAt: at(11),
      })
    )
    expect(store.getEnvironment('beta')?.updateRequestedAt).toBeNull()

    const schema = schemaOf(store.db)
    const data = dumpTables(store.db)
    store.close()
    const reopened = open(dir)
    expect(version(reopened.db)).toBe('9')
    expect(schemaOf(reopened.db)).toEqual(schema)
    expect(dumpTables(reopened.db)).toEqual(data)
    expect(reopened.db.prepare('SELECT total_changes() AS count').get()).toEqual({ count: 0 })
  })

  it('migrates a schema 6 database through schema 7 to schema 9', () => {
    const dir = temp()
    createSchema6Database(dir).close()
    const store = open(dir)
    expect(version(store.db)).toBe('9')
    checked(store.db)
    store.insertEnvironment(environmentRecord('work'), environmentSecrets('work'))
    expect(store.getEnvironment('work')).toEqual(environmentRecord('work'))
  })

  it('stores, keeps and clears when an environment update was requested', () => {
    const store = open()
    store.insertEnvironment(environmentRecord('work'), environmentSecrets('work'))
    const requested = store.updateEnvironment('work', { updateRequestedAt: at(22) }, at(22))
    expect(requested).toEqual(environmentRecord('work', { updateRequestedAt: at(22), updatedAt: at(22) }))
    expect(store.getEnvironment('work')).toEqual(requested)
    // Other changes keep it.
    expect(store.updateEnvironment('work', { lifecycle: 'restarting' }, at(23)).updateRequestedAt).toBe(at(22))
    expect(store.updateEnvironment('work', { updateRequestedAt: null }, at(24)).updateRequestedAt).toBeNull()
    expect(store.getEnvironment('work')?.updateRequestedAt).toBeNull()
    // An environment inserted while waiting keeps its request.
    store.insertEnvironment(environmentRecord('home', { updateRequestedAt: at(21) }), environmentSecrets('home'))
    expect(store.getEnvironment('home')?.updateRequestedAt).toBe(at(21))
    checked(store.db)
  })
})

describe('environments and their bots', () => {
  it('creates, lists, updates, archives and restores environments with their secrets', () => {
    const store = open()
    store.insertEnvironment(environmentRecord('work'), environmentSecrets('work'))
    const home = environmentRecord('home', { createdAt: at(21), updatedAt: at(21), memoryLimitBytes: 6 * 1024 ** 3 })
    store.insertEnvironment(home, environmentSecrets('home'))
    expect(codeOf(() => store.insertEnvironment(environmentRecord('work'), environmentSecrets('work')))).toBe(
      'CONFLICT'
    )
    expect(store.getEnvironment('work')).toEqual(environmentRecord('work'))
    expect(store.getEnvironment('missing')).toBeNull()
    expect(store.listEnvironments()).toEqual([environmentRecord('work'), home])
    expect(store.environmentSecrets('home')).toEqual(environmentSecrets('home'))
    expect(store.environmentSecrets('missing')).toBeNull()

    const updated = store.updateEnvironment(
      'home',
      { name: 'Home office', lifecycle: 'restarting', setup: setup('desktop'), memoryLimitBytes: null },
      at(23)
    )
    expect(updated).toEqual({
      ...home,
      name: 'Home office',
      lifecycle: 'restarting',
      setup: setup('desktop'),
      memoryLimitBytes: null,
      updatedAt: at(23),
    })
    expect(store.getEnvironment('home')).toEqual(updated)
    expect(store.updateEnvironment('home', { memoryLimitBytes: 8 * 1024 ** 3 }, at(24))).toEqual({
      ...updated,
      memoryLimitBytes: 8 * 1024 ** 3,
      updatedAt: at(24),
    })
    expect(codeOf(() => store.updateEnvironment('missing', { name: 'Missing' }))).toBe('NOT_FOUND')
    expect(codeOf(() => store.updateEnvironment('home', { memoryLimitBytes: 1.5 }))).toBe('INVALID_REQUEST')
    expect(codeOf(() => store.updateEnvironment('home', { memoryLimitBytes: 0 }))).toBe('INVALID_REQUEST')
    expect(() => store.updateEnvironment('home', { lifecycle: 'archived' })).toThrow('archiveEnvironment')
    expect(store.getEnvironment('home')?.memoryLimitBytes).toBe(8 * 1024 ** 3)

    store.insertBot(botRecord('writer', { createdAt: at(20, 1) }), gatewaySecrets('writer'), { environmentId: 'work' })
    store.insertBot(botRecord('editor', { createdAt: at(20, 2) }), gatewaySecrets('editor'), { environmentId: 'work' })
    store.insertBot(botRecord('scribe', { createdAt: at(20, 3) }), gatewaySecrets('scribe'), { environmentId: 'work' })
    store.archiveBot('scribe', at(24))
    expect(store.archiveEnvironment('work', at(25))).toEqual(['writer', 'editor'])
    expect(store.getEnvironment('work')).toEqual(
      environmentRecord('work', { lifecycle: 'archived', updatedAt: at(25), archivedAt: at(25) })
    )
    expect(store.listEnvironments().map((environment) => environment.id)).toEqual(['home'])
    expect(store.archivedEnvironments().map((environment) => environment.id)).toEqual(['work'])
    expect(store.environmentSecrets('work')).toEqual(environmentSecrets('work'))
    expect(store.botsOfEnvironment('work')).toEqual([])
    expect(store.botsOfEnvironment('work', true).map((bot) => [bot.id, bot.lifecycle])).toEqual([
      ['writer', 'archived'],
      ['editor', 'archived'],
      ['scribe', 'archived'],
    ])
    expect(
      store
        .archivedBots()
        .map(({ bot, archivedAt, archivedWithEnvironment }) => [bot.id, archivedAt, archivedWithEnvironment])
    ).toEqual([
      ['scribe', at(24), false],
      ['writer', at(25), true],
      ['editor', at(25), true],
    ])
    expect(codeOf(() => store.insertBot(botRecord('late'), gatewaySecrets('late'), { environmentId: 'work' }))).toBe(
      'NOT_FOUND'
    )
    expect(codeOf(() => store.updateEnvironment('work', { name: 'Renamed' }))).toBe('NOT_FOUND')
    expect(codeOf(() => store.archiveEnvironment('work'))).toBe('NOT_FOUND')
    expect(codeOf(() => store.restoreBot('writer'))).toBe('CONFLICT')

    expect(store.restoreEnvironment('work', at(26))).toEqual(['writer', 'editor'])
    expect(store.getEnvironment('work')).toEqual(
      environmentRecord('work', { lifecycle: 'creating', setup: setup('container'), updatedAt: at(26) })
    )
    expect(
      store.botsOfEnvironment('work').map((bot) => [bot.id, bot.lifecycle, bot.setup.step, bot.updatedAt])
    ).toEqual([
      ['writer', 'creating', 'container', at(26)],
      ['editor', 'creating', 'container', at(26)],
    ])
    expect(store.botPlacement('writer')).toEqual({ environmentId: 'work', slot: 1, archivedWithEnvironment: false })
    expect(store.botPlacement('editor')).toEqual({ environmentId: 'work', slot: 2, archivedWithEnvironment: false })
    expect(store.botPlacement('scribe')).toEqual({ environmentId: 'work', slot: 3, archivedWithEnvironment: false })
    expect(store.getBot('scribe')?.lifecycle).toBe('archived')
    expect(codeOf(() => store.restoreEnvironment('work'))).toBe('NOT_FOUND')
    expect(codeOf(() => store.restoreEnvironment('missing'))).toBe('NOT_FOUND')
  })

  it('places bots in the lowest free slot up to 8 and frees the slot of an archived bot', () => {
    const store = open()
    store.insertEnvironment(environmentRecord('team'), environmentSecrets('team'))
    const add = (id: string, slot?: number) =>
      store.insertBot(botRecord(id), gatewaySecrets(id), { environmentId: 'team', slot })
    expect(store.freeSlot('team')).toBe(1)
    expect(add('b1')).toBe(1)
    expect(store.freeSlot('team')).toBe(2)
    expect(add('b2')).toBe(2)
    expect(codeOf(() => add('taken', 2))).toBe('CONFLICT')
    expect(codeOf(() => add('outside', 9))).toBe('INVALID_REQUEST')
    expect(codeOf(() => add('zero', 0))).toBe('INVALID_REQUEST')
    expect(add('b5', 5)).toBe(5)
    for (const id of ['b3', 'b4', 'b6', 'b7', 'b8']) add(id)
    expect(store.botsOfEnvironment('team').map((bot) => [bot.id, store.botPlacement(bot.id)?.slot])).toEqual([
      ['b1', 1],
      ['b2', 2],
      ['b3', 3],
      ['b4', 4],
      ['b5', 5],
      ['b6', 6],
      ['b7', 7],
      ['b8', 8],
    ])
    expect(store.freeSlot('team')).toBeNull()
    expect(codeOf(() => add('b9'))).toBe('CONFLICT')
    for (const id of ['taken', 'outside', 'zero', 'b9']) {
      expect(store.getBot(id)).toBeNull()
      expect(store.botSecrets(id)).toBeNull()
    }

    expect(store.archiveBot('b1', at(24))).toMatchObject({ id: 'b1', lifecycle: 'archived', updatedAt: at(24) })
    expect(store.botPlacement('b1')).toEqual({ environmentId: 'team', slot: 1, archivedWithEnvironment: false })
    expect(store.freeSlot('team')).toBe(1)
    expect(add('b9')).toBe(1)
    expect(store.freeSlot('team')).toBeNull()
    expect(codeOf(() => store.restoreBot('b1'))).toBe('CONFLICT')

    store.archiveBot('b4', at(25))
    expect(store.restoreBot('b1', undefined, at(26))).toMatchObject({
      id: 'b1',
      lifecycle: 'creating',
      setup: botSetup('profile'),
      updatedAt: at(26),
    })
    expect(store.botPlacement('b1')).toEqual({ environmentId: 'team', slot: 4, archivedWithEnvironment: false })
    expect(codeOf(() => store.restoreBot('b1'))).toBe('NOT_FOUND')
    expect(codeOf(() => store.archiveBot('b4'))).toBe('NOT_FOUND')
    expect(codeOf(() => store.archiveBot('missing'))).toBe('NOT_FOUND')

    store.archiveBot('b3', at(27))
    store.archiveBot('b8', at(27))
    store.restoreBot('b8', undefined, at(28))
    expect(store.botPlacement('b8')?.slot).toBe(8)
    expect(codeOf(() => store.restoreBot('b3', 8))).toBe('CONFLICT')
    store.restoreBot('b3', 3, at(28))
    expect(store.botPlacement('b3')?.slot).toBe(3)

    store.insertEnvironment(environmentRecord('solo'), environmentSecrets('solo'))
    expect(store.insertBot(botRecord('s1'), gatewaySecrets('s1'), { environmentId: 'solo' })).toBe(1)
    expect(codeOf(() => store.insertBot(botRecord('x'), gatewaySecrets('x'), { environmentId: 'missing' }))).toBe(
      'NOT_FOUND'
    )
    expect(() => store.db.prepare("UPDATE bots SET slot=2 WHERE id='b5'").run()).toThrow(/UNIQUE/)
  })

  it('scopes owner memories: the owner sees every entry, a bot sees global ones and its environment', () => {
    const store = open()
    for (const id of ['a', 'b']) store.insertEnvironment(environmentRecord(id), environmentSecrets(id))
    store.saveOwnerMemory(memory('global', null, at(20)))
    store.saveOwnerMemory(memory('in-a', 'a', at(21)))
    store.saveOwnerMemory(memory('in-b', 'b', at(22)))
    store.saveOwnerMemory(memory('old-a', 'a', at(23), 'archived'))
    const ids = (entries: FleetOwnerMemoryEntry[]) => entries.map((entry) => entry.id)
    expect(ids(store.ownerMemories())).toEqual(['global', 'in-a', 'in-b', 'old-a'])
    expect(ids(store.ownerMemories(undefined, 'a'))).toEqual(['global', 'in-a', 'old-a'])
    expect(ids(store.ownerMemories('active', 'a'))).toEqual(['global', 'in-a'])
    expect(ids(store.ownerMemories('active', 'b'))).toEqual(['global', 'in-b'])
    expect(store.ownerMemoryById('in-a')).toEqual(memory('in-a', 'a', at(21)))

    store.saveOwnerMemory({ ...memory('in-a', 'a', at(21)), environmentId: null, updatedAt: at(24) })
    expect(store.ownerMemoryById('in-a')).toMatchObject({ environmentId: null, updatedAt: at(24) })
    expect(ids(store.ownerMemories('active', 'b'))).toEqual(['global', 'in-a', 'in-b'])
    store.saveOwnerMemory({ ...memory('global', null, at(20)), environmentId: 'b', updatedAt: at(24) })
    expect(ids(store.ownerMemories('active', 'a'))).toEqual(['in-a'])
    expect(() => store.saveOwnerMemory(memory('ghost', 'nowhere', at(25)))).toThrow()
    expect(store.ownerMemoryById('ghost')).toBeNull()
  })

  it('records activity in the environment of its bot or in an explicit environment', () => {
    const store = open()
    store.insertEnvironment(environmentRecord('work'), environmentSecrets('work'))
    store.insertBot(botRecord('writer'), gatewaySecrets('writer'), { environmentId: 'work' })
    expect(store.addActivity('writer', 'turn_completed', 'Synthetic turn')).toMatchObject({
      botId: 'writer',
      environmentId: 'work',
    })
    expect(store.addActivity(null, 'bot_configured', 'Synthetic Mac', { accounts: 1 }, 'work')).toMatchObject({
      botId: null,
      environmentId: 'work',
      data: { accounts: 1 },
    })
    expect(store.addActivity(null, 'bot_deleted', 'Gone')).toMatchObject({ botId: null, environmentId: null })
    expect(store.activity().map((entry) => [entry.botId, entry.environmentId, entry.kind])).toEqual([
      ['writer', 'work', 'turn_completed'],
      [null, 'work', 'bot_configured'],
      [null, null, 'bot_deleted'],
    ])
  })

  it('purges an environment with every record of its bots and leaves other environments alone', () => {
    const store = open()
    store.insertEnvironment(environmentRecord('work'), environmentSecrets('work'))
    store.insertEnvironment(environmentRecord('home'), environmentSecrets('home'))
    store.insertBot(botRecord('writer'), gatewaySecrets('writer'), { environmentId: 'work' })
    store.insertBot(botRecord('editor'), gatewaySecrets('editor'), { environmentId: 'work' })
    store.insertBot(botRecord('helper'), gatewaySecrets('helper'), { environmentId: 'home' })
    store.archiveBot('editor', at(21))
    const scopes = ['botMessageSend:', 'routineCreate:', 'botRoutineCreate:', 'botOwnerMemorySave:', 'peer:']
    for (const botId of ['writer', 'editor', 'helper']) store.markOwnerMessage(botId, at(21))
    for (const [botId, peerId] of [
      ['writer', 'helper'],
      ['editor', 'helper'],
      ['helper', 'outsider'],
    ]) {
      store.saveRoutine(routine(botId))
      store.insertRoutineRun({
        id: 'run-' + botId,
        routineId: 'routine-' + botId,
        botId,
        inputId: 'input-' + botId,
        trigger: 'manual',
        status: 'delivered',
        deliveredAt: at(21),
        finishedAt: null,
        report: null,
        finalText: null,
      })
      store.insertPeerMessage({
        id: 'message-' + botId,
        at: at(21),
        from: botId,
        to: peerId,
        text: 'Synthetic hello',
        delivered: false,
      })
      store.blockPair(botId, peerId, at(30))
      for (const scope of scopes) store.saveIdempotency(scope + botId, 'key-' + botId, 'request', { ok: true }, 201)
      store.addActivity(botId, 'turn_completed', 'Synthetic turn')
    }
    store.insertPeerMessage({
      id: 'message-to-editor',
      at: at(22),
      from: 'helper',
      to: 'editor',
      text: 'Synthetic reply',
      delivered: false,
    })
    store.addActivity(null, 'bot_configured', 'Synthetic Mac', {}, 'work')
    store.addActivity(null, 'bot_configured', 'Synthetic Mac', {}, 'home')
    store.addActivity(null, 'bot_deleted', 'Old bot')
    store.saveOwnerMemory({
      ...memory('global-note', null, at(20), 'superseded'),
      replacedById: 'work-note',
    })
    store.saveOwnerMemory({ ...memory('work-note', 'work', at(21)), replacesId: 'global-note' })
    store.saveOwnerMemory(memory('work-archived', 'work', at(22), 'archived'))
    store.saveOwnerMemory(memory('home-note', 'home', at(23)))
    const revision = store.ownerMemoryRevision()

    expect(store.purgeEnvironment('work')).toEqual({ botIds: ['writer', 'editor'], ownerMemoriesDeleted: 2 })
    expect(store.ownerMemoryRevision()).toBe(revision + 1)
    expect(store.getEnvironment('work')).toBeNull()
    expect(store.environmentSecrets('work')).toBeNull()
    for (const id of ['writer', 'editor']) {
      expect(store.getBot(id)).toBeNull()
      expect(store.botSecrets(id)).toBeNull()
      expect(store.botPlacement(id)).toBeNull()
      expect(store.botByGatewayHash(hash('synthetic-gateway-' + id))).toBeNull()
    }
    expect(store.routines().map((item) => item.id)).toEqual(['routine-helper'])
    expect(store.routineRunById('run-writer')).toBeNull()
    expect(store.routineRunById('run-helper')?.botId).toBe('helper')
    expect(store.peerMessages().map((message) => message.id)).toEqual(['message-helper'])
    expect(store.pendingPeers().map((message) => message.id)).toEqual(['message-helper'])
    expect(store.db.prepare('SELECT bot_id FROM owner_messages').all()).toEqual([{ bot_id: 'helper' }])
    expect(store.db.prepare('SELECT pair_key FROM pair_blocks').all()).toEqual([{ pair_key: '|helper|outsider|' }])
    expect(store.db.prepare('SELECT scope FROM idempotency ORDER BY scope').all()).toEqual(
      scopes.map((scope) => ({ scope: scope + 'helper' })).sort((a, b) => a.scope.localeCompare(b.scope))
    )
    expect(store.activity().map((entry) => [entry.botId, entry.environmentId, entry.kind])).toEqual([
      ['helper', 'home', 'turn_completed'],
      [null, 'home', 'bot_configured'],
      [null, null, 'bot_deleted'],
    ])
    expect(store.ownerMemories().map((entry) => [entry.id, entry.replacedById])).toEqual([
      ['global-note', null],
      ['home-note', null],
    ])
    expect(store.getBot('helper')?.environmentId).toBe('home')
    expect(store.botSecrets('helper')).toEqual({ ...environmentSecrets('home'), ...gatewaySecrets('helper') })
    expect(store.getEnvironment('home')).toEqual(environmentRecord('home'))
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(codeOf(() => store.purgeEnvironment('work'))).toBe('NOT_FOUND')
  })

  it('purges one bot, including its peer idempotency, and keeps its environment', () => {
    const store = open()
    store.insertEnvironment(environmentRecord('work'), environmentSecrets('work'))
    for (const id of ['writer', 'editor']) {
      store.insertBot(botRecord(id), gatewaySecrets(id), { environmentId: 'work' })
      for (const scope of ['botMessageSend:', 'peer:']) store.saveIdempotency(scope + id, 'key', 'request', {}, 201)
    }
    store.purgeBot('writer')
    expect(store.getBot('writer')).toBeNull()
    expect(store.botSecrets('writer')).toBeNull()
    expect(store.db.prepare('SELECT scope FROM idempotency ORDER BY scope').all()).toEqual([
      { scope: 'botMessageSend:editor' },
      { scope: 'peer:editor' },
    ])
    expect(store.getEnvironment('work')).toEqual(environmentRecord('work'))
    expect(store.environmentSecrets('work')).toEqual(environmentSecrets('work'))
    expect(store.botsOfEnvironment('work', true).map((bot) => bot.id)).toEqual(['editor'])
    expect(store.freeSlot('work')).toBe(1)
  })

  it('keeps the single-bot create, save and delete of older callers working through an environment of one', () => {
    const store = open()
    const bot = botRecord('legacy', { lifecycle: 'creating', setup: botSetup('container'), createdAt: at(20) })
    const secrets = { ...environmentSecrets('legacy'), ...gatewaySecrets('legacy') }
    expect(store.insertBot(bot, secrets)).toBe(1)
    expect(store.getEnvironment('legacy')).toEqual({
      id: 'legacy',
      name: 'Bot legacy',
      lifecycle: 'creating',
      setup: setup('container'),
      containerName: 'maestrly-bot-legacy',
      volumeName: 'maestrly-bot-legacy-home',
      memoryLimitBytes: null,
      compaction: null,
      updateRequestedAt: null,
      createdAt: at(20),
      updatedAt: at(20),
      archivedAt: null,
    })
    expect(store.getBot('legacy')).toEqual({ ...bot, environmentId: 'legacy' })
    expect(store.botSecrets('legacy')).toEqual(secrets)
    expect(store.environmentSecrets('legacy')).toEqual(environmentSecrets('legacy'))
    expect(store.botByGatewayHash(secrets.gatewayTokenSha256)).toBe('legacy')
    expect(codeOf(() => store.insertBot(botRecord('legacy'), secrets))).toBe('CONFLICT')

    store.saveBot({ ...bot, lifecycle: 'archived', updatedAt: at(24) })
    expect(store.archivedBots()).toEqual([
      { bot: expect.objectContaining({ id: 'legacy' }), archivedAt: at(24), archivedWithEnvironment: false },
    ])
    expect(store.listBots()).toEqual([])
    expect(store.freeSlot('legacy')).toBe(1)
    store.saveBot({ ...bot, name: 'Renamed', lifecycle: 'archived', updatedAt: at(25) })
    expect(store.archivedBots()[0]).toMatchObject({ bot: { name: 'Renamed' }, archivedAt: at(24) })
    store.saveBot({ ...bot, lifecycle: 'running', setup: botSetup('ready'), updatedAt: at(26) })
    expect(store.listBots()).toEqual([
      { ...bot, lifecycle: 'running', setup: botSetup('ready'), updatedAt: at(26), environmentId: 'legacy' },
    ])
    expect(store.botPlacement('legacy')).toEqual({ environmentId: 'legacy', slot: 1, archivedWithEnvironment: false })
    expect(codeOf(() => store.saveBot(botRecord('ghost')))).toBe('NOT_FOUND')
    expect(store.getBot('ghost')).toBeNull()

    store.deleteBot('legacy')
    expect(store.getBot('legacy')).toBeNull()
    expect(store.getEnvironment('legacy')).toBeNull()
    expect(store.environmentSecrets('legacy')).toBeNull()
    store.insertBot(bot, { ...secrets, keyringPassword: 'synthetic-keyring-again' })
    expect(store.environmentSecrets('legacy')?.keyringPassword).toBe('synthetic-keyring-again')

    store.insertEnvironment(environmentRecord('pair'), environmentSecrets('pair'))
    for (const id of ['one', 'two']) store.insertBot(botRecord(id), gatewaySecrets(id), { environmentId: 'pair' })
    store.deleteBot('one')
    expect(store.getEnvironment('pair')).toEqual(environmentRecord('pair'))
    store.deleteBot('two')
    expect(store.getEnvironment('pair')).toBeNull()
  })
})

describe('schema 9 migration', () => {
  it('defaults existing bots to disabled and persists later publishing changes', () => {
    const dir = temp()
    const old = new Store(dir)
    const bot = botRecord('legacy')
    old.insertBot(bot, { ...environmentSecrets('legacy'), ...gatewaySecrets('legacy') })
    old.db.exec('ALTER TABLE bots DROP COLUMN publish_artifacts')
    old.db.prepare("UPDATE meta SET value='8' WHERE key='schema_version'").run()
    old.close()
    const store = open(dir)
    expect(store.getBot('legacy')?.publishArtifacts).toBe(false)
    store.saveBot({ ...store.getBot('legacy')!, publishArtifacts: true })
    store.close()
    expect(open(dir).getBot('legacy')?.publishArtifacts).toBe(true)
  })
})
