import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { deleteConversation, deleteWorkspace, getDb } from '../../src/main/store'
import {
  archiveLocalMemory,
  createLocalMemory,
  forgetLocalMemory,
  getLocalMemory,
  listLocalMemories,
  markLocalMemoriesUsed,
  restoreLocalMemory,
  updateLocalMemory,
} from '../../src/main/memory/local-memory-service'

beforeEach(freshDb)
afterEach(closeDb)

describe('structured local memories', () => {
  it('supports CRUD, filters, pin and reversible lifecycle', () => {
    const workspace = makeWorkspace()
    const created = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Release decision',
      content: 'Use signed release tags.',
      type: 'decision',
      scope: 'release',
      tags: ['Git', 'release', 'git'],
      pinned: true,
      source: 'user',
    })
    expect(created.duplicate).toBe(false)
    expect(created.memory.tags).toEqual(['git', 'release'])
    expect(listLocalMemories(workspace.id, { type: 'decision', tag: 'git', pinned: true })).toHaveLength(1)

    const updated = updateLocalMemory(workspace.id, created.memory.id, { content: 'Use annotated release tags.' })
    expect(updated.changed).toBe(true)
    expect(updated.memory.content).toContain('annotated')
    expect(archiveLocalMemory(workspace.id, created.memory.id).status).toBe('archived')
    expect(listLocalMemories(workspace.id, { status: 'active' })).toHaveLength(0)
    expect(restoreLocalMemory(workspace.id, created.memory.id).status).toBe('active')
    expect(forgetLocalMemory(workspace.id, created.memory.id)).toBe(true)
    expect(getLocalMemory(workspace.id, created.memory.id)).toBeUndefined()
  })

  it('turns exact duplicates into no-ops without semantic auto-merge', () => {
    const workspace = makeWorkspace()
    const first = createLocalMemory({
      workspaceId: workspace.id,
      title: 'One',
      content: 'Exact durable content',
      type: 'reference',
      source: 'agent',
    })
    const duplicate = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Different title',
      content: 'Exact durable content',
      type: 'lesson',
      source: 'agent',
    })
    const semantic = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Paraphrase',
      content: 'Durable content with the same meaning',
      type: 'lesson',
      source: 'agent',
    })
    expect(duplicate).toMatchObject({ duplicate: true, changed: false })
    expect(duplicate.memory.id).toBe(first.memory.id)
    expect(semantic.duplicate).toBe(false)
    expect(listLocalMemories(workspace.id)).toHaveLength(2)
  })

  it('enforces same-workspace supersedes, marks the target and rejects cycles', () => {
    const firstWorkspace = makeWorkspace()
    const secondWorkspace = makeWorkspace()
    const old = createLocalMemory({
      workspaceId: firstWorkspace.id,
      title: 'Old',
      content: 'Old rule',
      type: 'constraint',
      source: 'user',
    }).memory
    const foreign = createLocalMemory({
      workspaceId: secondWorkspace.id,
      title: 'Foreign',
      content: 'Foreign rule',
      type: 'constraint',
      source: 'user',
    }).memory
    expect(() =>
      createLocalMemory({
        workspaceId: firstWorkspace.id,
        title: 'Invalid',
        content: 'Invalid foreign supersession',
        type: 'constraint',
        source: 'user',
        supersedesId: foreign.id,
      })
    ).toThrow(/same workspace/)
    const next = createLocalMemory({
      workspaceId: firstWorkspace.id,
      title: 'New',
      content: 'New rule',
      type: 'constraint',
      source: 'user',
      supersedesId: old.id,
    }).memory
    expect(getLocalMemory(firstWorkspace.id, old.id)?.status).toBe('superseded')
    expect(() => updateLocalMemory(firstWorkspace.id, old.id, { supersedesId: next.id })).toThrow(/cycle/)
  })

  it('keeps opaque conversation provenance after transcript deletion and cascades on workspace deletion', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    const memory = createLocalMemory({
      workspaceId: workspace.id,
      title: 'Conversation lesson',
      content: 'Keep retry paths idempotent.',
      type: 'lesson',
      source: 'agent',
      originConversationId: conversation.id,
      originMessageId: 'opaque-message',
    }).memory
    deleteConversation(conversation.id)
    expect(getLocalMemory(workspace.id, memory.id)).toMatchObject({ originConversationId: conversation.id })
    deleteWorkspace(workspace.id)
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM local_memories').get()).toMatchObject({ count: 0 })
  })

  it('updates usage only for final selected hits', () => {
    const workspace = makeWorkspace()
    const first = createLocalMemory({
      workspaceId: workspace.id,
      title: 'A',
      content: 'Alpha',
      type: 'reference',
      source: 'user',
    }).memory
    const second = createLocalMemory({
      workspaceId: workspace.id,
      title: 'B',
      content: 'Beta',
      type: 'reference',
      source: 'user',
    }).memory
    markLocalMemoriesUsed(workspace.id, [first.id], 1234)
    expect(getLocalMemory(workspace.id, first.id)).toMatchObject({ lastUsedAt: 1234, useCount: 1 })
    expect(getLocalMemory(workspace.id, second.id)).toMatchObject({ useCount: 0 })
  })
})
