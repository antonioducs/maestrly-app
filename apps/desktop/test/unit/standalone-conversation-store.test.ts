import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { getDb } from '../../src/main/store/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  getConversation,
  insertConversation,
  insertConvRepos,
  listStandaloneConversations,
  setConversationLocation,
  setStandaloneConversationOrder,
} from '../../src/main/store/conversations'
import type { StandaloneConversation } from '../../src/shared/conversation'
import {
  conversationPermissionScope,
  permissionScopeKey,
  getConversationCapabilities,
  requireProjectConversation,
} from '../../src/shared/conversation-scope'

beforeEach(freshDb)
afterEach(closeDb)

function standalone(id: string, archived = 0): StandaloneConversation {
  return {
    id,
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    name: id,
    cwd: `/app/chats/${id}`,
    status: 'idle',
    createdAt: 1,
    archived,
    pinnedAt: null,
    lastActivityAt: 1,
  }
}

it('persists standalone conversations and orders only their slots including archived entries', () => {
  const project = makeConversation(makeWorkspace().id)
  for (const c of [standalone('a'), standalone('archived', 1), standalone('b')]) insertConversation(c)
  expect(listStandaloneConversations().map((c) => c.id)).toEqual(['a', 'b'])
  expect(
    getDb()
      .prepare("SELECT position FROM conversations WHERE scope='standalone' ORDER BY position")
      .all()
      .map((row) => row.position)
  ).toEqual([0, 1, 2])
  setStandaloneConversationOrder(['b', project.id, 'b', 'a'])
  expect(listStandaloneConversations(true).map((c) => c.id)).toEqual(['b', 'archived', 'a'])
  restartDb()
  expect(getConversation('b')).toEqual({ ...standalone('b'), uiPrefs: {} })
  expect(getConversation(project.id)?.scope).toBe('project')
})

it('rejects project mutations for standalone conversations before changing data', () => {
  insertConversation(standalone('a'))
  expect(() => insertConvRepos('a', [])).toThrow('project-required')
  expect(() => setConversationLocation('a', { branch: 'main', mode: 'local', cwd: '/repo' })).toThrow(
    'project-required'
  )
  expect(() => requireProjectConversation(standalone('a'))).toThrow('project-required')
  expect(getConversationCapabilities(standalone('a')).project).toBe(false)
  expect(getConversation('a')?.cwd).toBe('/app/chats/a')
})

it('rejects corrupted scope discriminants at the mapping boundary', () => {
  insertConversation(standalone('corrupt'))
  getDb().exec(
    "PRAGMA ignore_check_constraints=ON; UPDATE conversations SET scope='unknown' WHERE id='corrupt'; PRAGMA ignore_check_constraints=OFF"
  )
  expect(() => getConversation('corrupt')).toThrow('Invalid conversation scope')
})

it('keeps workspace permission keys stable and isolates standalone permission scopes', () => {
  const workspace = makeWorkspace()
  const project = getConversation(makeConversation(workspace.id).id)!
  expect(permissionScopeKey(conversationPermissionScope(project))).toBe(workspace.id)
  expect(permissionScopeKey(conversationPermissionScope(standalone('a')))).toBe('conversation:a')
  expect(permissionScopeKey(conversationPermissionScope(standalone('b')))).toBe('conversation:b')
  expect(requireProjectConversation(project)).toBe(project)
  expect(getConversationCapabilities(project).project).toBe(true)
})

it('creates new databases with final scope constraints without rebuilding conversations', () => {
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec')
  try {
    freshDb()
    expect(
      getDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_conv_standalone'").get()
    ).toBeTruthy()
    expect(spy.mock.calls.some(([sql]) => sql.includes('conversations_standalone_new'))).toBe(false)
    insertConversation(standalone('fresh'))
    expect(() =>
      getDb().exec("UPDATE conversations SET scope='project', workspace_id='ws', branch='main', mode='invalid'")
    ).toThrow()
    restartDb()
    expect(getConversation('fresh')?.scope).toBe('standalone')
    expect(spy.mock.calls.some(([sql]) => sql.includes('conversations_standalone_new'))).toBe(false)
  } finally {
    spy.mockRestore()
  }
})
