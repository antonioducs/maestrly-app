import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listChatMessages } from '../../src/main/chat/chat-store'
import { closeStore, getDb, initStore, migrateLegacyConversationsToChat } from '../../src/main/store'
import { readTranscript } from '../../src/main/transcript-reader'

const temporaryDirectories: string[] = []
const handoffDirectory = path.join(os.tmpdir(), 'agents-test-electron', 'handoff')
const handoffFiles: string[] = []

function parsedTextMessages(conversationId: string): Array<{ role: string; text: string; partId: string }> {
  return listChatMessages(conversationId).map((message) => {
    expect(message.parts).toHaveLength(1)
    const part = message.parts[0]
    expect(part.type).toBe('text')
    if (part.type !== 'text') throw new Error('expected imported text part')
    return { role: message.role, text: part.text, partId: part.id }
  })
}

function writeLegacyHandoff(conversationId: string, unified: unknown): void {
  writeLegacyHandoffState(conversationId, { unified })
}

function writeLegacyHandoffState(conversationId: string, state: unknown): void {
  mkdirSync(handoffDirectory, { recursive: true })
  const file = path.join(handoffDirectory, `${conversationId}.json`)
  writeFileSync(file, JSON.stringify(state), 'utf8')
  handoffFiles.push(file)
}

function insertLegacyConversation(
  id: string,
  cli: string,
  createdAt: number,
  cliSessions: Record<string, string> = {}
): void {
  getDb()
    .prepare(
      `INSERT INTO conversations
        (id, workspace_id, name, branch, mode, cli, cwd, status, created_at, started, archived,
         last_activity_at, is_multi, cli_sessions, session_anchors, ui_prefs, position)
       VALUES (?, 'ws', ?, 'main', 'local', ?, '/tmp/ws', 'idle', ?, 1, 0,
               ?, 0, ?, '{}', '{}', ?)`
    )
    .run(id, id, cli, createdAt, createdAt, JSON.stringify(cliSessions), createdAt)
}

function legacyDatabase(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'maestrly-chat-only-migration-'))
  temporaryDirectories.push(directory)
  const file = path.join(directory, 'legacy.db')
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      default_branch TEXT NOT NULL, added_at INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, branch TEXT NOT NULL, mode TEXT NOT NULL,
      cli TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'regular', cwd TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle', created_at INTEGER NOT NULL,
      started INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      pinned_at INTEGER, last_activity_at INTEGER NOT NULL DEFAULT 0,
      is_multi INTEGER NOT NULL DEFAULT 0, cli_sessions TEXT NOT NULL DEFAULT '{}',
      session_anchors TEXT NOT NULL DEFAULT '{}', ui_prefs TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO workspaces VALUES ('ws', '/tmp/ws', 'ws', 'main', 100, 0);
    INSERT INTO conversations VALUES
      ('claude-exact', 'ws', 'Claude archived', 'main', 'local', 'claude', 'regular', '/tmp/ws',
       'idle', 1000, 1, 1, NULL, 1000, 0, '{}', '{}', '{}', 0),
      ('codex-conv', 'ws', 'Codex', 'main', 'local', 'codex', 'regular', '/tmp/ws',
       'idle', 2000, 1, 0, NULL, 2000, 0, '{"codex":"codex-exact"}', '{}', '{}', 1),
      ('unsupported-missing', 'ws', 'Unsupported', 'main', 'local', 'unsupported-cli', 'regular', '/tmp/ws',
       'idle', 3000, 1, 0, NULL, 3000, 0, '{}', '{}', '{}', 2),
      ('chat-existing', 'ws', 'Chat', 'main', 'local', 'chat', 'regular', '/tmp/ws',
       'idle', 4000, 1, 0, NULL, 4000, 0, '{}', '{}', '{}', 3);
  `)
  db.close()
  return file
}

afterEach(() => {
  try {
    closeStore()
  } catch {
    // The database is already closed.
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  for (const file of handoffFiles.splice(0)) rmSync(file, { force: true })
})

describe('forward-only migration of legacy conversations to Chat', () => {
  it('projects existing Chat messages as recoverable turns', async () => {
    initStore(legacyDatabase())
    getDb()
      .prepare(
        `INSERT INTO chat_messages
          (id, conversation_id, role, parts_json, meta_json, seq, created_at)
         VALUES ('chat-turn', 'chat-existing', 'assistant', '[{"type":"text","id":"text-1","text":"resposta Chat"}]', NULL, 1, 4000)`
      )
      .run()

    await expect(readTranscript('chat', '/tmp/ws', 'chat-existing')).resolves.toEqual([
      { role: 'assistant', text: 'resposta Chat' },
    ])
  })

  it('uses exact sessions, includes archived conversations and records degradation without changing native Chat', async () => {
    initStore(legacyDatabase())
    getDb()
      .prepare(
        `INSERT INTO chat_messages
          (id, conversation_id, role, parts_json, meta_json, seq, created_at)
         VALUES ('chat-original', 'chat-existing', 'user', '[{"type":"text","text":"não tocar"}]', NULL, 1, 4000)`
      )
      .run()
    const reader = vi.fn(async (cli: string) => [
      { role: 'user' as const, text: `pergunta ${cli}` },
      { role: 'assistant' as const, text: `resposta ${cli}` },
    ])

    await migrateLegacyConversationsToChat(reader)

    expect(reader).toHaveBeenCalledTimes(2)
    expect(reader).toHaveBeenNthCalledWith(1, 'claude', '/tmp/ws', 'claude-exact', {
      strict: true,
      requireExactSession: true,
    })
    expect(reader).toHaveBeenNthCalledWith(2, 'codex', '/tmp/ws', 'codex-conv', {
      strict: true,
      cliSessionId: 'codex-exact',
      requireExactSession: true,
    })

    const imported = getDb()
      .prepare('SELECT conversation_id, role, parts_json, meta_json FROM chat_messages ORDER BY conversation_id, seq')
      .all() as Array<{ conversation_id: string; role: string; parts_json: string; meta_json: string | null }>
    expect(imported.filter((row) => row.conversation_id === 'claude-exact')).toHaveLength(3)
    expect(imported.filter((row) => row.conversation_id === 'codex-conv')).toHaveLength(3)
    expect(imported.find((row) => row.conversation_id === 'claude-exact')?.parts_json).toContain(
      'Imported from Claude Code.'
    )
    expect(imported.filter((row) => row.conversation_id === 'chat-existing')).toEqual([
      expect.objectContaining({ parts_json: '[{"type":"text","text":"não tocar"}]', meta_json: null }),
    ])
    const deterministicId = `legacy-${createHash('sha256')
      .update(['claude-exact', 'claude', '0', 'Imported from Claude Code.'].join('\0'))
      .digest('hex')
      .slice(0, 32)}`
    expect(getDb().prepare('SELECT id FROM chat_messages WHERE id = ?').get(deterministicId)).toEqual({
      id: deterministicId,
    })
    const degraded = imported.find((row) => row.conversation_id === 'unsupported-missing')
    expect(JSON.parse(degraded!.meta_json!).legacyImport).toMatchObject({
      provenance: 'external-cli-transcript',
      sessionId: null,
      exactSession: true,
      degraded: true,
      degradedReason: 'session-id-missing',
    })
    const degradedMessages = listChatMessages('unsupported-missing')
    const parsedDegradedMessages = parsedTextMessages('unsupported-missing')
    expect(parsedDegradedMessages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'assistant', text: 'Imported from Legacy tool.' },
      { role: 'assistant', text: '[Legacy tool history was not imported: exact session identifier is missing.]' },
    ])
    expect(parsedDegradedMessages.every(({ partId }, index) => partId === `${degradedMessages[index].id}:part-0`)).toBe(
      true
    )

    const columns = (getDb().prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
    expect(columns).not.toEqual(expect.arrayContaining(['cli', 'started', 'cli_sessions', 'session_anchors']))

    const before = (getDb().prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number }).count
    await migrateLegacyConversationsToChat(reader)
    expect((getDb().prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number }).count).toBe(
      before
    )
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('imports known native sessions using anchored cwd and preserves existing Chat segments', async () => {
    initStore(legacyDatabase())
    getDb()
      .prepare(
        `INSERT INTO conversations
          (id, workspace_id, name, branch, mode, cli, cwd, status, created_at, started, archived,
           last_activity_at, is_multi, cli_sessions, session_anchors, ui_prefs, position)
         VALUES (?, 'ws', 'Multi CLI', 'main', 'local', 'chat', '/tmp/new-ws', 'idle', ?, 1, 0,
                 ?, 0, ?, ?, '{}', 10)`
      )
      .run(
        'multi-cli',
        5000,
        5000,
        JSON.stringify({
          claude: 'claude-history',
          codex: 'codex-history',
          opencode: 'opencode-history',
        }),
        JSON.stringify({})
      )
    getDb()
      .prepare(
        `INSERT INTO chat_messages
          (id, conversation_id, role, parts_json, meta_json, seq, created_at)
         VALUES ('multi-chat', 'multi-cli', 'user', '[{"type":"text","text":"segmento Chat"}]', NULL, 1, 5001)`
      )
      .run()

    const reader = vi.fn(
      async (cli: string, _cwd: string, _conversationId: string, opts: { cliSessionId?: string }) => [
        { role: 'user' as const, text: `${cli}:${opts.cliSessionId ?? 'claude-history'}` },
      ]
    )

    await migrateLegacyConversationsToChat(reader)

    expect(reader).toHaveBeenCalledWith('claude', '/tmp/new-ws', 'multi-cli', {
      strict: true,
      requireExactSession: true,
    })
    expect(reader).toHaveBeenCalledWith('codex', '/tmp/new-ws', 'multi-cli', {
      strict: true,
      cliSessionId: 'codex-history',
      requireExactSession: true,
    })
    expect(reader).toHaveBeenCalledWith('opencode', '/tmp/new-ws', 'multi-cli', {
      strict: true,
      cliSessionId: 'opencode-history',
      requireExactSession: true,
    })

    const imported = getDb()
      .prepare(
        `SELECT role, parts_json, meta_json, seq
         FROM chat_messages WHERE conversation_id = 'multi-cli' ORDER BY seq ASC`
      )
      .all() as Array<{ role: string; parts_json: string; meta_json: string | null; seq: number }>
    expect(imported[0]).toMatchObject({
      parts_json: '[{"type":"text","text":"segmento Chat"}]',
      meta_json: null,
      seq: 1,
    })
    expect(
      imported
        .slice(1)
        .filter((_row, index) => index % 2 === 0)
        .map((row) => JSON.parse(row.meta_json!).legacyImport.sessionId)
    ).toEqual(['claude-history', 'codex-history', 'opencode-history'])
    expect(
      imported.slice(1).map((row) => {
        const part = JSON.parse(row.parts_json)[0]
        return { type: part.type, text: part.text }
      })
    ).toEqual([
      { type: 'text', text: 'Imported from Claude Code.' },
      { type: 'text', text: 'claude:claude-history' },
      { type: 'text', text: 'Imported from Codex.' },
      { type: 'text', text: 'codex:codex-history' },
      { type: 'text', text: 'Imported from OpenCode.' },
      { type: 'text', text: 'opencode:opencode-history' },
    ])
    expect(imported.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('prioritizes canonical unified handoff order when CLI sessions interleave', async () => {
    initStore(legacyDatabase())
    getDb()
      .prepare(
        `INSERT INTO conversations
          (id, workspace_id, name, branch, mode, cli, cwd, status, created_at, started, archived,
           last_activity_at, is_multi, cli_sessions, session_anchors, ui_prefs, position)
         VALUES (?, 'ws', 'Interleaved', 'main', 'local', 'chat', '/tmp/ws', 'idle', ?, 1, 0,
                 ?, 0, ?, '{}', '{}', 20)`
      )
      .run('interleaved', 6000, 6000, JSON.stringify({ codex: 'codex-history', claude: 'claude-history' }))

    const unified = [
      { role: 'user' as const, text: 'Claude pergunta 1' },
      { role: 'assistant' as const, text: 'Claude resposta 1' },
      { role: 'user' as const, text: 'Codex pergunta' },
      { role: 'assistant' as const, text: 'Codex resposta' },
      { role: 'user' as const, text: 'Claude pergunta 2' },
      { role: 'assistant' as const, text: 'Claude resposta 2' },
    ]
    writeLegacyHandoff('interleaved', unified)

    const reader = vi.fn(async (cli: string, _cwd: string, _conversationId: string) =>
      cli === 'claude'
        ? [
            { role: 'user' as const, text: 'Claude pergunta 1' },
            { role: 'assistant' as const, text: 'Claude resposta 1' },
            { role: 'user' as const, text: 'Claude pergunta 2' },
            { role: 'assistant' as const, text: 'Claude resposta 2' },
          ]
        : [
            { role: 'user' as const, text: 'Codex pergunta' },
            { role: 'assistant' as const, text: 'Codex resposta' },
          ]
    )

    await migrateLegacyConversationsToChat(reader)

    expect(reader.mock.calls.some((call) => call[2] === 'interleaved')).toBe(false)
    const imported = getDb()
      .prepare(
        `SELECT role, parts_json, meta_json
         FROM chat_messages WHERE conversation_id = 'interleaved' ORDER BY seq ASC`
      )
      .all() as Array<{ role: string; parts_json: string; meta_json: string | null }>
    expect(imported.map((row) => ({ role: row.role, text: JSON.parse(row.parts_json)[0].text }))).toEqual(unified)
    expect(imported.every((row) => row.meta_json)).toBe(true)
    expect(JSON.parse(imported[0].meta_json!).legacyImport).toEqual({
      version: 1,
      provenance: 'legacy-unified-handoff',
      cli: null,
      sessionId: null,
      exactSession: false,
      degraded: false,
    })
    expect(parsedTextMessages('interleaved').map(({ role, text }) => ({ role, text }))).toEqual(unified)
  })

  it('uses unified history as a checkpoint and recovers the active CLI tail', async () => {
    initStore(legacyDatabase())
    insertLegacyConversation('claude-to-codex-tail', 'codex', 7000, { codex: 'codex-tail' })
    writeLegacyHandoffState('claude-to-codex-tail', {
      unified: [
        { role: 'user', text: 'Claude pergunta' },
        { role: 'assistant', text: 'Claude resposta' },
      ],
      lastRead: { claude: 2, codex: 2 },
      seen: { claude: 2, codex: 2 },
    })
    const reader = vi.fn(async (_cli: string, _cwd: string, conversationId: string) =>
      conversationId === 'claude-to-codex-tail'
        ? [
            { role: 'user' as const, text: 'Codex pergunta antiga' },
            { role: 'assistant' as const, text: 'Codex resposta antiga' },
            { role: 'user' as const, text: 'Codex pergunta nova' },
            { role: 'assistant' as const, text: 'Codex resposta nova' },
          ]
        : []
    )

    await migrateLegacyConversationsToChat(reader)

    expect(reader).toHaveBeenCalledWith('codex', '/tmp/ws', 'claude-to-codex-tail', {
      strict: true,
      cliSessionId: 'codex-tail',
      requireExactSession: true,
    })
    const imported = getDb()
      .prepare(
        `SELECT role, parts_json, meta_json
         FROM chat_messages WHERE conversation_id = 'claude-to-codex-tail' ORDER BY seq ASC`
      )
      .all() as Array<{ role: string; parts_json: string; meta_json: string | null }>
    expect(imported.map((row) => ({ role: row.role, text: JSON.parse(row.parts_json)[0].text }))).toEqual([
      { role: 'user', text: 'Claude pergunta' },
      { role: 'assistant', text: 'Claude resposta' },
      { role: 'user', text: 'Codex pergunta nova' },
      { role: 'assistant', text: 'Codex resposta nova' },
    ])
    expect(JSON.parse(imported[2].meta_json!).legacyImport).toMatchObject({
      provenance: 'legacy-active-cli-tail',
      cli: 'codex',
      sessionId: 'codex-tail',
      exactSession: true,
      degraded: false,
    })
    expect(parsedTextMessages('claude-to-codex-tail').map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Claude pergunta' },
      { role: 'assistant', text: 'Claude resposta' },
      { role: 'user', text: 'Codex pergunta nova' },
      { role: 'assistant', text: 'Codex resposta nova' },
    ])
  })

  it('preserves native Chat without duplicating Claude context or the recent tail', async () => {
    initStore(legacyDatabase())
    insertLegacyConversation('claude-to-chat-tail', 'chat', 8000)
    writeLegacyHandoffState('claude-to-chat-tail', {
      unified: [
        { role: 'user', text: 'Claude pergunta' },
        { role: 'assistant', text: 'Claude resposta' },
      ],
      lastRead: { claude: 2 },
      seen: { claude: 2, chat: 2 },
    })
    const nativeContext = JSON.stringify([
      {
        type: 'context',
        id: 'claude-context',
        source: 'Claude Code',
        text: '**Usuário:**\n\nClaude pergunta\n\n---\n\n**Assistente:**\n\nClaude resposta',
      },
    ])
    const nativeTailParts = JSON.stringify([
      { type: 'text', id: 'chat-user', text: 'Chat pergunta recente' },
      {
        type: 'tool',
        id: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'read_file',
        input: { path: 'README.md' },
        state: { status: 'output-available', output: 'conteúdo nativo' },
      },
    ])
    getDb()
      .prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
         VALUES (?, 'claude-to-chat-tail', ?, ?, ?, ?, ?)`
      )
      .run('native-context', 'assistant', nativeContext, null, 1, 8001)
    getDb()
      .prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
         VALUES (?, 'claude-to-chat-tail', ?, ?, ?, ?, ?)`
      )
      .run('native-tail', 'user', nativeTailParts, JSON.stringify({ usage: { input: 11, output: 7 } }), 2, 8002)

    const reader = vi.fn(async (_cli: string, _cwd: string, _conversationId: string) => [])
    await migrateLegacyConversationsToChat(reader)

    expect(reader.mock.calls.some((call) => call[2] === 'claude-to-chat-tail')).toBe(false)
    const rows = getDb()
      .prepare(
        `SELECT id, parts_json, meta_json, seq
         FROM chat_messages WHERE conversation_id = 'claude-to-chat-tail' ORDER BY seq ASC`
      )
      .all() as Array<{ id: string; parts_json: string; meta_json: string | null; seq: number }>
    expect(rows).toEqual([
      { id: 'native-context', parts_json: nativeContext, meta_json: null, seq: 1 },
      {
        id: 'native-tail',
        parts_json: nativeTailParts,
        meta_json: JSON.stringify({ usage: { input: 11, output: 7 } }),
        seq: 2,
      },
    ])
  })

  it('avoids duplicate context wrappers when Chat was read before returning to CLI', async () => {
    initStore(legacyDatabase())
    insertLegacyConversation('chat-to-codex', 'codex', 8500, { codex: 'codex-after-chat' })
    const contextText = '**Usuário:**\n\nClaude pergunta\n\n---\n\n**Assistente:**\n\nClaude resposta'
    writeLegacyHandoffState('chat-to-codex', {
      unified: [
        { role: 'user', text: 'Claude pergunta' },
        { role: 'assistant', text: 'Claude resposta' },
        { role: 'assistant', text: contextText },
        { role: 'user', text: 'Chat pergunta' },
        { role: 'assistant', text: 'Chat resposta' },
      ],
      lastRead: { chat: 3, codex: 0 },
      seen: { claude: 2, chat: 5 },
    })
    getDb()
      .prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
         VALUES ('chat-context', 'chat-to-codex', 'assistant', ?, NULL, 1, 8501)`
      )
      .run(JSON.stringify([{ type: 'context', id: 'ctx', source: 'Claude Code', text: contextText }]))
    getDb()
      .prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
         VALUES ('chat-tail-user', 'chat-to-codex', 'user', ?, NULL, 2, 8502)`
      )
      .run(JSON.stringify([{ type: 'text', id: 'chat-user', text: 'Chat pergunta' }]))
    getDb()
      .prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
         VALUES ('chat-tail-assistant', 'chat-to-codex', 'assistant', ?, NULL, 3, 8503)`
      )
      .run(JSON.stringify([{ type: 'text', id: 'chat-assistant', text: 'Chat resposta' }]))

    const reader = vi.fn(async (_cli: string, _cwd: string, conversationId: string) =>
      conversationId === 'chat-to-codex' ? [{ role: 'assistant' as const, text: 'Codex depois do Chat' }] : []
    )
    await migrateLegacyConversationsToChat(reader)

    const rows = getDb()
      .prepare(
        `SELECT id, parts_json
         FROM chat_messages WHERE conversation_id = 'chat-to-codex' ORDER BY seq ASC`
      )
      .all() as Array<{ id: string; parts_json: string }>
    expect(rows.map((row) => row.id)).toEqual([
      'chat-context',
      'chat-tail-user',
      'chat-tail-assistant',
      expect.stringMatching(/^legacy-/),
    ])
    expect(
      rows.filter((row) =>
        JSON.parse(row.parts_json).some((part: { type?: string; text?: string }) => part.text === contextText)
      )
    ).toHaveLength(1)
    expect(JSON.parse(rows[3].parts_json)[0].text).toBe('Codex depois do Chat')
  })

  it('preserves order without duplicating history when switching between Claude and Codex', async () => {
    initStore(legacyDatabase())
    insertLegacyConversation('back-and-forth', 'codex', 9000, { codex: 'codex-roundtrip' })
    writeLegacyHandoffState('back-and-forth', {
      unified: [
        { role: 'user', text: 'Claude 1' },
        { role: 'assistant', text: 'Claude 2' },
        { role: 'user', text: 'Codex 1' },
        { role: 'assistant', text: 'Codex 2' },
        { role: 'user', text: 'Claude 3' },
        { role: 'assistant', text: 'Claude 4' },
      ],
      lastRead: { claude: 4, codex: 2 },
      seen: { claude: 6, codex: 4 },
    })
    const reader = vi.fn(async (_cli: string, _cwd: string, conversationId: string) =>
      conversationId === 'back-and-forth'
        ? [
            { role: 'user' as const, text: 'Codex 1' },
            { role: 'assistant' as const, text: 'Codex 2' },
            { role: 'user' as const, text: 'Codex 3' },
            { role: 'assistant' as const, text: 'Codex 4' },
          ]
        : []
    )

    await migrateLegacyConversationsToChat(reader)

    const texts = (
      getDb()
        .prepare(
          `SELECT role, parts_json
           FROM chat_messages WHERE conversation_id = 'back-and-forth' ORDER BY seq ASC`
        )
        .all() as Array<{ role: string; parts_json: string }>
    ).map((row) => `${row.role}:${JSON.parse(row.parts_json)[0].text}`)
    expect(texts).toEqual([
      'user:Claude 1',
      'assistant:Claude 2',
      'user:Codex 1',
      'assistant:Codex 2',
      'user:Claude 3',
      'assistant:Claude 4',
      'user:Codex 3',
      'assistant:Codex 4',
    ])
  })
})
