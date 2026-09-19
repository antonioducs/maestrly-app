import { DatabaseSync } from 'node:sqlite'
import { freshDb, closeDb } from '../helpers/db'
import { getDb } from '../../src/main/store/db'
import { describe, expect, it, vi } from 'vitest'
import {
  conversationScopeConstraint,
  migrateStandaloneConversations,
} from '../../src/main/store/standalone-conversation-migration'

function legacy(branchDefinition = 'TEXT NOT NULL') {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE workspaces(id TEXT PRIMARY KEY);
    INSERT INTO workspaces VALUES ('ws');
    CREATE TABLE conversations(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      branch ${branchDefinition}, mode TEXT NOT NULL, experience TEXT NOT NULL DEFAULT 'standard', is_multi INTEGER NOT NULL DEFAULT 0,
      cwd TEXT NOT NULL, legacy_secret TEXT DEFAULT 'preserved');
    INSERT INTO conversations(id,workspace_id,branch,mode,cwd) VALUES ('project','ws','main','local','/repo');
    CREATE TABLE children(id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE);
    INSERT INTO children VALUES ('child','project');
    CREATE INDEX legacy_index ON conversations(legacy_secret);
    CREATE VIEW conversation_view AS SELECT id FROM conversations;
    CREATE TABLE audit(id TEXT);
    CREATE TRIGGER conversation_audit AFTER UPDATE ON conversations BEGIN INSERT INTO audit VALUES (new.id); END;
  `)
  return db
}

describe('standalone conversation schema rebuild', () => {
  it('preserves production transcripts, image references, native bindings, preferences and usage without tombstones', () => {
    freshDb()
    const db = new DatabaseSync(':memory:')
    const tables = [
      'workspaces',
      'conversations',
      'conversation_migrations',
      'conversation_repos',
      'chat_messages',
      'chat_inference_state',
      'chat_codex_threads',
      'chat_codex_thread_cleanup',
      'chat_usage_ledger',
    ]
    try {
      // Use the product's actual dependent DDL and restore the pre-feature conversation shape.
      const objects = getDb()
        .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid')
        .all()
      db.exec('PRAGMA foreign_keys=ON')
      for (const object of objects) {
        if (!tables.includes(String(object.tbl_name)) || String(object.name).includes('standalone')) continue
        let sql = String(object.sql)
        if (object.name === 'conversations') {
          sql = sql
            .replace(/scope\s+TEXT NOT NULL DEFAULT 'project',/, '')
            .replace(conversationScopeConstraint, "CHECK (mode IN ('worktree', 'local'))")
            .replace(/workspace_id\s+TEXT/, 'workspace_id TEXT NOT NULL')
            .replace(/branch\s+TEXT,/, 'branch TEXT NOT NULL,')
            .replace(/mode\s+TEXT,/, 'mode TEXT NOT NULL,')
        }
        db.exec(sql)
      }
      db.exec("INSERT INTO workspaces (id,path,name,default_branch,added_at) VALUES ('ws','/repo','Repo','main',1)")
      for (const [id, mode, experience, multi] of [
        ['local', 'local', 'standard', 0],
        ['worktree', 'worktree', 'standard', 0],
        ['multi', 'worktree', 'standard', 1],
        ['maestro', 'worktree', 'maestro', 0],
      ] as const) {
        db.prepare(`INSERT INTO conversations(id,workspace_id,name,branch,mode,experience,is_multi,cwd,created_at,ui_prefs)
          VALUES (?, 'ws', ?, 'main', ?, ?, ?, ?, 123, ?)`).run(
          id,
          id,
          mode,
          experience,
          multi,
          `/repo/${id}`,
          JSON.stringify({ chat: { reasoning: 'high' } })
        )
        db.prepare(`INSERT INTO chat_messages(id,conversation_id,role,parts_json,meta_json,seq,created_at)
          VALUES (?,?,'assistant',?,?,0,123)`).run(
          `message-${id}`,
          id,
          JSON.stringify([{ type: 'generated-image', artifactId: `image-${id}` }]),
          JSON.stringify({ usage: { input: 100, output: 20 }, model: { providerId: 'provider', modelId: 'model' } })
        )
        db.prepare(`INSERT INTO chat_codex_threads(conversation_id,thread_id,model_id,tool_signature,last_message_id,updated_at)
          VALUES (?,?,'model','signature',?,123)`).run(id, `thread-${id}`, `message-${id}`)
        db.prepare(`INSERT INTO chat_inference_state(message_id,provider_id,model_id,harness_profile,state_json,updated_at)
          VALUES (?,'provider','model','profile','{"opaque":"preserved"}',123)`).run(`message-${id}`)
      }
      db.exec(`INSERT INTO conversation_repos(conversation_id,workspace_id,repo_top,branch,base,worktree_path,link_name,position)
        VALUES ('multi','ws','/repo','main','main','/repo/multi','repo',0)`)
      const before = new Map(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]))
      migrateStandaloneConversations(db)
      migrateStandaloneConversations(db)
      for (const table of tables) {
        const actual = db.prepare(`SELECT * FROM ${table}`).all()
        expect(
          table === 'conversations'
            ? actual.map(({ scope, ...row }) => {
                expect(scope).toBe('project')
                return row
              })
            : actual
        ).toEqual(before.get(table))
      }
      expect(db.prepare('SELECT * FROM chat_codex_thread_cleanup').all()).toEqual([])
      db.exec("DELETE FROM workspaces WHERE id='ws'")
      expect(db.prepare('SELECT * FROM chat_messages').all()).toEqual([])
      expect(db.prepare('SELECT * FROM chat_codex_thread_cleanup').all()).toHaveLength(4)
      expect(db.prepare('SELECT * FROM chat_usage_ledger').all()).toHaveLength(4)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      db.close()
      closeDb()
    }
  })
  it('preserves legacy data, children, schema objects and cascade targets across repeated upgrades', () => {
    const db = legacy()
    try {
      migrateStandaloneConversations(db)
      migrateStandaloneConversations(db)
      expect(db.prepare('SELECT scope, legacy_secret FROM conversations').get()).toMatchObject({
        scope: 'project',
        legacy_secret: 'preserved',
      })
      expect(db.prepare('SELECT * FROM children').all()).toHaveLength(1)
      expect(db.prepare('SELECT * FROM conversation_view').all()).toHaveLength(1)
      db.exec("UPDATE conversations SET branch='feature' WHERE id='project'")
      expect(db.prepare('SELECT * FROM audit').all()).toHaveLength(1)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='legacy_index'").get()).toBeTruthy()
      db.exec("DELETE FROM conversations WHERE id='project'")
      expect(db.prepare('SELECT * FROM children').all()).toHaveLength(0)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
    } finally {
      db.close()
    }
  })
  it('preserves legacy generated columns, quoted defaults, and indirect dependencies', () => {
    const db = legacy()
    try {
      db.exec(`ALTER TABLE conversations ADD COLUMN extra TEXT DEFAULT 'a,b(c)';
        ALTER TABLE conversations ADD COLUMN computed TEXT GENERATED ALWAYS AS (extra || ',' || branch) VIRTUAL;
        CREATE VIEW indirect_view AS SELECT id FROM conversation_view;
        CREATE TRIGGER child_audit AFTER INSERT ON children BEGIN
          INSERT INTO audit SELECT id FROM indirect_view;
        END;`)
      migrateStandaloneConversations(db)
      expect(db.prepare('SELECT extra, computed FROM conversations').get()).toMatchObject({
        extra: 'a,b(c)',
        computed: 'a,b(c),main',
      })
      db.exec("INSERT INTO children VALUES ('second', 'project')")
      expect(db.prepare('SELECT * FROM audit').all()).toHaveLength(1)
      expect(db.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' })
    } finally {
      db.close()
    }
  })

  it('enforces explicit null discriminants and standalone structural constraints', () => {
    const db = legacy()
    try {
      migrateStandaloneConversations(db)
      const insert = db.prepare(
        'INSERT INTO conversations(id,scope,workspace_id,branch,mode,experience,is_multi,cwd) VALUES (?,?,?,?,?,?,?,?)'
      )
      insert.run('standalone', 'standalone', null, null, null, 'standard', 0, '/app/chats/standalone')
      for (const values of [
        ['project', null, 'main', 'local', 'standard', 0],
        ['project', 'ws', null, 'local', 'standard', 0],
        ['project', 'ws', 'main', null, 'standard', 0],
        ['project', 'ws', 'main', 'invalid', 'standard', 0],
        ['standalone', 'ws', null, null, 'standard', 0],
        ['standalone', null, 'main', null, 'standard', 0],
        ['standalone', null, null, 'local', 'standard', 0],
        ['standalone', null, null, null, 'maestro', 0],
        ['standalone', null, null, null, 'standard', 1],
        [null, null, null, null, 'standard', 0],
      ])
        expect(() => insert.run('bad', ...values, '/bad')).toThrow()
    } finally {
      db.close()
    }
  })
  it('rolls back a failed rebuild and restores FK enforcement', () => {
    const db = legacy()
    try {
      db.exec("PRAGMA foreign_keys=OFF; INSERT INTO children VALUES ('orphan','missing'); PRAGMA foreign_keys=ON")
      expect(() => migrateStandaloneConversations(db)).toThrow()
      expect(
        db
          .prepare('PRAGMA table_info(conversations)')
          .all()
          .map((c) => c.name)
      ).not.toContain('scope')
      expect(db.prepare('SELECT * FROM conversation_view').all()).toHaveLength(1)
      expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='conversations_standalone_new'").get()
      ).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

it('rejects a misleading final constraint without changing the legacy schema', () => {
  const db = legacy()
  try {
    db.exec(
      "ALTER TABLE conversations ADD COLUMN scope TEXT NOT NULL DEFAULT 'project' CONSTRAINT conversation_scope_discriminant CHECK (1)"
    )
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='conversations'").get()
    expect(() => migrateStandaloneConversations(db)).toThrow(/schema/i)
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='conversations'").get()).toEqual(before)
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
  } finally {
    db.close()
  }
})

it.each(['workspace_id', 'branch', 'mode', 'scope'])('validates final %s nullability', (column) => {
  const db = new DatabaseSync(':memory:')
  try {
    const fields = ['workspace_id', 'branch', 'mode'].map(
      (name) => name + ' TEXT' + (name === column ? ' NOT NULL' : '')
    )
    db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY, ${fields.join(',')},
      scope TEXT ${column === 'scope' ? '' : 'NOT NULL'} DEFAULT 'project',
      experience TEXT, is_multi INTEGER, cwd TEXT, ${conversationScopeConstraint})`)
    expect(() => migrateStandaloneConversations(db)).toThrow(/schema/i)
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
  } finally {
    db.close()
  }
})

it('reports when SQLite cannot enable foreign keys in an existing transaction', () => {
  const db = legacy()
  try {
    migrateStandaloneConversations(db)
    db.exec('PRAGMA foreign_keys=OFF; BEGIN')
    expect(() => migrateStandaloneConversations(db)).toThrow(/restore foreign key enforcement/i)
    db.exec('ROLLBACK')
    migrateStandaloneConversations(db)
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
  } finally {
    db.close()
  }
})

it('rolls back schema and dependent objects when restoration fails', () => {
  const db = legacy()
  const execute = db.exec.bind(db)
  const spy = vi.spyOn(db, 'exec').mockImplementation((sql) => {
    if (sql.startsWith('CREATE TRIGGER conversation_audit')) throw new Error('injected restoration failure')
    return execute(sql)
  })
  try {
    expect(() => migrateStandaloneConversations(db)).toThrow('injected restoration failure')
    expect(db.prepare('SELECT * FROM conversation_view').all()).toHaveLength(1)
    expect(db.prepare('SELECT * FROM children').all()).toHaveLength(1)
    db.exec("UPDATE conversations SET branch='restored'")
    expect(db.prepare('SELECT * FROM audit').all()).toHaveLength(1)
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
    spy.mockRestore()
    migrateStandaloneConversations(db)
    migrateStandaloneConversations(db)
  } finally {
    spy.mockRestore()
    db.close()
  }
})

it('preserves constraint-like text inside legacy column defaults', () => {
  const db = legacy("TEXT DEFAULT 'NOT NULL' NOT NULL")
  try {
    migrateStandaloneConversations(db)
    expect(
      db
        .prepare('PRAGMA table_info(conversations)')
        .all()
        .find((c) => c.name === 'branch')
    ).toMatchObject({
      notnull: 0,
      dflt_value: "'NOT NULL'",
    })
  } finally {
    db.close()
  }
})
