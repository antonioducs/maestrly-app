import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachmentConversationDir } from '../../src/main/chat/attachment-artifacts'
import { generatedImageConversationDir } from '../../src/main/chat/generated-images'
import { computeMoveDigest } from '../../src/main/conversation-move/digest'
import {
  collectConversationFiles,
  hashConversationFiles,
  removeRestoredConversationFiles,
  restoreConversationFiles,
} from '../../src/main/conversation-move/files'
import { readMovePackage, writeMovePackage } from '../../src/main/conversation-move/package'
import {
  deleteImportedConversationRows,
  insertConversationRows,
  readConversationRows,
} from '../../src/main/conversation-move/rows'
import { getConversation, getDb } from '../../src/main/store'
import { CONVERSATION_MOVE_PACKAGE_FORMAT, CONVERSATION_MOVE_PACKAGE_VERSION } from '../../src/shared/conversation-move'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

const OID = 'a'.repeat(40)
const SHA = 'b'.repeat(64)
const GIT = { headOid: OID, indexTree: OID, worktreeTree: OID }
let root: string
let cwd: string
let conv: ReturnType<typeof makeConversation>

const count = (table: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

function seed(): void {
  const db = getDb()
  const message = db.prepare(
    'INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const usage = JSON.stringify({ model: { providerId: 'p', modelId: 'm' }, usage: { input: 10, output: 5 } })
  message.run('m1', conv.id, 'user', '[{"type":"text","text":"hi"}]', null, 1, 100)
  message.run('m2', conv.id, 'assistant', '[{"type":"text","text":"hello"}]', usage, 2, 200)
  message.run('m3', conv.id, 'assistant', '[{"type":"text","text":"again"}]', usage, 3, 300)
  db.prepare(
    `INSERT INTO chat_tool_executions (conversation_id, message_id, call_id, tool_name, input_hash, status, output_json, updated_at)
     VALUES (?, 'm2', 'call-1', 'read', 'h', 'completed', '{"ok":true}', 200)`
  ).run(conv.id)
  db.prepare(
    `INSERT INTO chat_subagent_sessions (id, conversation_id, parent_message_id, tool_call_id, origin, agent_name, task, status,
       started_at, last_activity_at, runtime_handle_json)
     VALUES ('s1', ?, 'm2', 'call-2', 'task', 'explore', 'look', 'running', 200, 210, '{"cwd":"/somewhere"}')`
  ).run(conv.id)
  db.prepare(
    `INSERT INTO chat_subagent_transcript (session_id, part_id, message_id, message_seq, role, position, part_json, revision,
       created_at, updated_at)
     VALUES ('s1', 'p1', 'sm1', 1, 'assistant', 0, '{"type":"text","text":"x"}', 1, 205, 205)`
  ).run()
  db.prepare(
    `INSERT INTO chat_maestro_runs (id, conversation_id, assistant_message_id, status, started_at) VALUES ('r1', ?, 'm3', 'active', 300)`
  ).run(conv.id)
  db.prepare(
    `INSERT INTO chat_maestro_run_messages (id, run_id, seq, text, status, created_at) VALUES ('q1', 'r1', 1, 'more', 'pending', 310)`
  ).run()
}

async function seedFiles(): Promise<void> {
  await mkdir(attachmentConversationDir(conv.id), { recursive: true })
  await writeFile(path.join(attachmentConversationDir(conv.id), 'att1.png'), Buffer.from([1, 2, 3]))
  await writeFile(path.join(attachmentConversationDir(conv.id), 'att2.png.tmp'), 'partial')
  await mkdir(generatedImageConversationDir(conv.id), { recursive: true })
  await writeFile(path.join(generatedImageConversationDir(conv.id), 'gen1.webp'), Buffer.from([9, 9]))
  await mkdir(path.join(cwd, '.agents/notes/assets'), { recursive: true })
  await writeFile(path.join(cwd, '.agents/notes/_pages.json'), '{"pages":["p1"]}')
  await writeFile(path.join(cwd, '.agents/notes/p1.md'), '# Plan\n')
  await writeFile(path.join(cwd, '.agents/notes/assets/img.png'), Buffer.from([4]))
  await writeFile(path.join(cwd, '.agents/notes.md'), 'legacy\n')
  await mkdir(path.join(cwd, 'cache/inner'), { recursive: true })
  await writeFile(path.join(cwd, 'cache/inner/data.bin'), 'cached')
  await writeFile(path.join(cwd, '.env.local'), 'SECRET=1\n')
}

beforeEach(() => {
  freshDb()
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maestrly-move-rows-')))
  cwd = path.join(root, 'source')
  const ws = makeWorkspace()
  conv = makeConversation(ws.id, {
    cwd,
    branch: 'feat',
    name: 'Feature',
    pinnedAt: 50,
    uiPrefs: { mainTabOrder: ['notes'] },
  })
  seed()
})
afterEach(async () => {
  await removeRestoredConversationFiles(conv.id)
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('conversation move rows and files', () => {
  it('reads the conversation rows and neutralizes runtime-only state', () => {
    const rows = readConversationRows(conv.id, 1000)
    expect(rows.conversation).toMatchObject({
      id: conv.id,
      name: 'Feature',
      pinnedAt: 50,
      uiPrefs: { mainTabOrder: ['notes'] },
    })
    expect(rows.tables.chat_messages.map((message) => message.seq)).toEqual([1, 2, 3])
    expect(rows.tables.chat_tool_executions).toHaveLength(1)
    expect(rows.tables.chat_subagent_sessions[0]).toMatchObject({
      status: 'interrupted',
      runtime_handle_json: null,
      finished_at: 1000,
    })
    expect(rows.tables.chat_subagent_transcript).toHaveLength(1)
    expect(rows.tables.chat_maestro_runs[0]).toMatchObject({ status: 'interrupted', finished_at: 1000 })
    expect(rows.tables.chat_maestro_run_messages[0]).toMatchObject({ status: 'cancelled' })
  })

  it('inserts into another profile with the same ids, a new location and no usage double count', () => {
    const rows = JSON.parse(JSON.stringify(readConversationRows(conv.id)))
    expect(count('chat_usage_ledger')).toBe(2)
    closeDb()
    freshDb()
    const ws = makeWorkspace()
    insertConversationRows(rows, { workspaceId: ws.id, branch: 'feat-moved', cwd: '/dest' })
    expect(getConversation(conv.id)).toMatchObject({
      workspaceId: ws.id,
      cwd: '/dest',
      branch: 'feat-moved',
      mode: 'worktree',
      status: 'idle',
      name: 'Feature',
      pinnedAt: 50,
    })
    expect(count('chat_messages')).toBe(3)
    expect(count('chat_subagent_transcript')).toBe(1)
    expect(count('chat_maestro_run_messages')).toBe(1)
    expect(count('chat_usage_ledger')).toBe(0)
    expect(getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([])
    deleteImportedConversationRows(conv.id)
    expect(getConversation(conv.id)).toBeUndefined()
    expect(count('chat_messages')).toBe(0)
  })

  it('refuses an existing conversation id atomically', () => {
    const rows = readConversationRows(conv.id)
    expect(() => insertConversationRows(rows, { workspaceId: conv.workspaceId, branch: 'x', cwd: '/x' })).toThrow(
      expect.objectContaining({ code: 'conversation-exists' })
    )
    expect(count('chat_messages')).toBe(3)
  })

  it('refuses rows with columns this schema does not have', () => {
    const rows = readConversationRows(conv.id)
    closeDb()
    freshDb()
    const ws = makeWorkspace()
    rows.tables.chat_messages[0] = { ...rows.tables.chat_messages[0], no_such_column: 1 }
    expect(() => insertConversationRows(rows, { workspaceId: ws.id, branch: 'b', cwd: '/d' })).toThrow(
      expect.objectContaining({ code: 'package-invalid' })
    )
    expect(getConversation(conv.id)).toBeUndefined()
  })

  it('collects and restores attachments, generated images, notes and selected ignored files', async () => {
    await seedFiles()
    const collected = await collectConversationFiles({
      conversationId: conv.id,
      cwd,
      selectedIgnoredPaths: ['cache', '.env.local'],
    })
    expect(collected.sources.map((source) => `${source.kind}:${source.relative}`)).toEqual([
      'attachment:att1.png',
      'generated-image:gen1.webp',
      'note:notes/_pages.json',
      'note:notes/assets/img.png',
      'note:notes/p1.md',
      'note:notes.md',
      'ignored:cache/inner/data.bin',
      'ignored:.env.local',
    ])
    expect(collected.stats).toEqual({ files: 6, fileBytes: 3 + 2 + 16 + 1 + 7 + 7 })

    const pkg = await writeMovePackage(path.join(root, 'conv.maestrly-move'), {
      manifest: {
        format: CONVERSATION_MOVE_PACKAGE_FORMAT,
        version: CONVERSATION_MOVE_PACKAGE_VERSION,
        appVersion: '1',
        operationId: 'op',
        conversationId: conv.id,
        createdAt: 1,
        digest: {
          conversationId: conv.id,
          messages: 3,
          lastSeq: 3,
          messagesSha256: SHA,
          files: 6,
          filesSha256: SHA,
          ...GIT,
        },
        snapshot: {
          branch: 'feat',
          headOid: OID,
          indexTree: OID,
          worktreeTree: OID,
          indexCommit: OID,
          worktreeCommit: OID,
        },
      },
      rows: readConversationRows(conv.id),
      sources: collected.sources,
    })
    // Another host: the profile's files are not there.
    await removeRestoredConversationFiles(conv.id)
    const read = await readMovePackage(pkg.path, path.join(root, 'extract'), { appVersion: '1' })
    const target = path.join(root, 'target')
    await mkdir(target)
    await restoreConversationFiles({ conversationId: conv.id, cwd: target, files: read.files })
    expect(await readFile(path.join(attachmentConversationDir(conv.id), 'att1.png'))).toEqual(Buffer.from([1, 2, 3]))
    expect(await readFile(path.join(generatedImageConversationDir(conv.id), 'gen1.webp'))).toEqual(Buffer.from([9, 9]))
    expect(await readFile(path.join(target, '.agents/notes/p1.md'), 'utf8')).toBe('# Plan\n')
    expect(await readFile(path.join(target, '.agents/notes/assets/img.png'))).toEqual(Buffer.from([4]))
    expect(await readFile(path.join(target, '.agents/notes.md'), 'utf8')).toBe('legacy\n')
    expect(await readFile(path.join(target, 'cache/inner/data.bin'), 'utf8')).toBe('cached')
    expect(await readFile(path.join(target, '.env.local'), 'utf8')).toBe('SECRET=1\n')
    await expect(
      restoreConversationFiles({ conversationId: conv.id, cwd: target, files: read.files })
    ).rejects.toMatchObject({
      code: 'package-invalid',
    })
  })

  it('computes the same digest for the same rows and files', async () => {
    await seedFiles()
    const exported = await computeMoveDigest(conv.id, await hashConversationFiles(conv.id, cwd), GIT)
    expect(exported).toMatchObject({ messages: 3, lastSeq: 3, files: 6 })
    const rows = readConversationRows(conv.id)
    const collected = await collectConversationFiles({ conversationId: conv.id, cwd, selectedIgnoredPaths: [] })
    const pkg = await writeMovePackage(path.join(root, 'conv.maestrly-move'), {
      manifest: {
        format: CONVERSATION_MOVE_PACKAGE_FORMAT,
        version: CONVERSATION_MOVE_PACKAGE_VERSION,
        appVersion: '1',
        operationId: 'op',
        conversationId: conv.id,
        createdAt: 1,
        digest: exported,
        snapshot: {
          branch: 'feat',
          headOid: OID,
          indexTree: OID,
          worktreeTree: OID,
          indexCommit: OID,
          worktreeCommit: OID,
        },
      },
      rows,
      sources: collected.sources,
    })
    await removeRestoredConversationFiles(conv.id)
    closeDb()
    freshDb()
    const ws = makeWorkspace()
    const read = await readMovePackage(pkg.path, path.join(root, 'extract'), { appVersion: '1' })
    const target = path.join(root, 'target')
    await mkdir(target)
    insertConversationRows(read.rows, { workspaceId: ws.id, branch: 'feat', cwd: target })
    await restoreConversationFiles({ conversationId: conv.id, cwd: target, files: read.files })
    const imported = await computeMoveDigest(conv.id, await hashConversationFiles(conv.id, target), GIT)
    expect(imported).toEqual(exported)
    await writeFile(path.join(target, '.agents/notes/p1.md'), '# Changed\n')
    expect(await computeMoveDigest(conv.id, await hashConversationFiles(conv.id, target), GIT)).not.toEqual(exported)
  })
})
