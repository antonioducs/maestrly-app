import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { deleteWorkspace, getDb } from '../../src/main/store'
import { setWorkspaceMemoryEnabled } from '../../src/main/memory/access'
import {
  createLocalMemory,
  getLocalMemory,
  listLocalMemories,
  resolveLocalMemoryId,
} from '../../src/main/memory/local-memory-service'
import {
  BOT_MEMORY_SPACE_ID,
  clearConversationMemorySpace,
  memorySpaceForConversation,
  registerConversationMemorySpace,
} from '../../src/main/memory/spaces'

beforeEach(freshDb)
afterEach(closeDb)

const legacyTable = `CREATE TABLE local_memories (id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, title TEXT NOT NULL, content TEXT NOT NULL,
  type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', scope TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, origin_conversation_id TEXT, origin_message_id TEXT,
  supersedes_id TEXT REFERENCES local_memories(id) ON DELETE SET NULL, promoted_path TEXT,
  content_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0)`

/** Recreates the pre-space schema (workspace foreign key, no cleanup trigger) with the current rows. */
function makeLegacy(): void {
  const db = getDb()
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('DROP TRIGGER IF EXISTS local_memories_workspace_cleanup')
  db.exec('ALTER TABLE local_memories RENAME TO local_memories_current')
  db.exec(legacyTable)
  db.exec('INSERT INTO local_memories SELECT * FROM local_memories_current')
  db.exec('DROP TABLE local_memories_current')
  db.exec('CREATE INDEX idx_local_memories_workspace_status ON local_memories(workspace_id, status, updated_at DESC)')
  db.exec('PRAGMA foreign_keys = ON')
}

const workspaceKeys = () =>
  (getDb().prepare('PRAGMA foreign_key_list(local_memories)').all() as Array<{ table: string; from: string }>).filter(
    (key) => key.table === 'workspaces'
  )

describe('local memory spaces', () => {
  it('migrates the workspace-bound table and keeps rows, supersession and workspace cleanup', () => {
    const workspace = makeWorkspace()
    const first = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Old',
      content: 'Old rule',
      type: 'decision',
      source: 'user',
    }).memory
    const second = createLocalMemory({
      workspaceId: workspace.id,
      title: 'New',
      content: 'New rule',
      type: 'decision',
      source: 'user',
      supersedesId: first.id,
    }).memory
    makeLegacy()
    expect(workspaceKeys()).toHaveLength(1)
    restartDb()
    expect(workspaceKeys()).toHaveLength(0)
    expect(getLocalMemory(workspace.id, second.id)?.supersedesId).toBe(first.id)
    expect(getLocalMemory(workspace.id, first.id)?.status).toBe('superseded')
    deleteWorkspace(workspace.id)
    expect(listLocalMemories(workspace.id)).toHaveLength(0)
  })

  it('is idempotent and stores memories in a space without a workspace row', () => {
    restartDb()
    restartDb()
    const saved = createLocalMemory({
      workspaceId: BOT_MEMORY_SPACE_ID,
      title: 'Launch code',
      content: 'The e2e launch code is BLUEBIRD.',
      type: 'reference',
      source: 'auto',
    })
    expect(saved.memory.workspaceId).toBe(BOT_MEMORY_SPACE_ID)
    expect(saved.memory.source).toBe('auto')
  })

  it('resolves ids by exact value or unique prefix of at least 6 characters', () => {
    const a = createLocalMemory({
      id: 'abcdef12-aaaa',
      workspaceId: BOT_MEMORY_SPACE_ID,
      title: 'A',
      content: 'a',
      type: 'reference',
      source: 'agent',
    }).memory
    createLocalMemory({
      id: 'abcdef34-bbbb',
      workspaceId: BOT_MEMORY_SPACE_ID,
      title: 'B',
      content: 'b',
      type: 'reference',
      source: 'agent',
    })
    expect(resolveLocalMemoryId(BOT_MEMORY_SPACE_ID, 'abcdef12-aaaa')).toBe(a.id)
    expect(resolveLocalMemoryId(BOT_MEMORY_SPACE_ID, 'abcdef12')).toBe(a.id)
    expect(resolveLocalMemoryId(BOT_MEMORY_SPACE_ID, 'abcdef')).toBe('ambiguous')
    expect(resolveLocalMemoryId(BOT_MEMORY_SPACE_ID, 'abc')).toBeUndefined()
    expect(resolveLocalMemoryId('another-space', 'abcdef12')).toBeUndefined()
  })

  it('resolves the memory space of a conversation', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    expect(memorySpaceForConversation(conversation.id)).toEqual({
      id: workspace.id,
      kind: 'workspace',
      roots: [{ root: conversation.cwd }],
    })
    setWorkspaceMemoryEnabled(workspace.id, false)
    expect(memorySpaceForConversation(conversation.id)).toBeNull()
    registerConversationMemorySpace(conversation.id, { id: BOT_MEMORY_SPACE_ID, kind: 'bot' })
    expect(memorySpaceForConversation(conversation.id)).toEqual({ id: BOT_MEMORY_SPACE_ID, kind: 'bot', roots: [] })
    clearConversationMemorySpace(conversation.id)
    expect(memorySpaceForConversation('missing')).toBeNull()
  })
})
