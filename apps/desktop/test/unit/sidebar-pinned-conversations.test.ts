import { describe, expect, it } from 'vitest'
import {
  buildPinnedWorkspaceLabels,
  collectPinnedConversations,
} from '../../src/renderer/components/sidebar/pinned-conversations'
import type { Conversation, WorkspaceWithConversations } from '../../src/preload'

/** Local fixtures require pinnedAt; explicitly pass null for unpinned conversations. */
function conv(id: string, pinnedAt: number | null, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    workspaceId: 'ws-1',
    name: id,
    branch: 'main',
    mode: 'worktree',
    experience: 'standard',
    cwd: `/repo/${id}`,
    status: 'idle',
    createdAt: 1,
    archived: 0,
    pinnedAt,
    lastActivityAt: 0,
    isMulti: 0,
    ...overrides,
  }
}

function ws(id: string, conversations: Conversation[]): WorkspaceWithConversations {
  return {
    id,
    path: `/repo/${id}`,
    name: id,
    defaultBranch: 'main',
    addedAt: 1,
    conversations,
    archivedCount: 0,
    groupId: null,
    collapsed: false,
  }
}

function ids(items: ReturnType<typeof collectPinnedConversations>): string[] {
  return items.map((item) => item.conversation.id)
}

/** Deep-freeze input so strict-mode ESM throws on any helper mutation. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

describe('collectPinnedConversations', () => {
  it('returns an empty list when no conversation is pinned', () => {
    const workspaces = [ws('ws-1', [conv('c1', null), conv('c2', null)]), ws('ws-2', [])]

    expect(collectPinnedConversations(workspaces)).toEqual([])
  })

  it('flattens workspaces and exposes the source workspace and global index for each item', () => {
    const w1 = ws('ws-1', [conv('a', 200)])
    const w2 = ws('ws-2', [conv('b', 100), conv('c', 300)])

    const items = collectPinnedConversations([w1, w2])

    expect(ids(items)).toEqual(['c', 'a', 'b'])
    expect(items[0]!.workspace).toBe(w2)
    expect(items[0]!.originalIndex).toBe(2)
    expect(items[1]!.workspace).toBe(w1)
    expect(items[1]!.originalIndex).toBe(0)
    expect(items[2]!.workspace).toBe(w2)
    expect(items[2]!.originalIndex).toBe(1)
  })

  it('sorts by descending pinnedAt with the newest pin first', () => {
    const w = ws('ws-1', [conv('oldest', 100), conv('newest', 900), conv('middle', 500)])

    expect(ids(collectPinnedConversations([w]))).toEqual(['newest', 'middle', 'oldest'])
  })

  it('stable ties within a workspace use increasing originalIndex for equal pinnedAt', () => {
    const w = ws('ws-1', [conv('i0', 500), conv('i1', 400), conv('i2', 500), conv('i3', 400)])

    expect(ids(collectPinnedConversations([w]))).toEqual(['i0', 'i2', 'i1', 'i3'])
  })

  it('stable ties across workspaces follow traversal order for equal pinnedAt', () => {
    const w1 = ws('ws-1', [conv('w1a', 400), conv('w1b', 300)])
    const w2 = ws('ws-2', [conv('w2a', 400)])
    const w3 = ws('ws-3', [conv('w3a', 300)])

    const items = collectPinnedConversations([w1, w2, w3])

    expect(ids(items)).toEqual(['w1a', 'w2a', 'w1b', 'w3a'])
    expect(items.map((item) => item.originalIndex)).toEqual([0, 2, 1, 3])
  })

  it('originalIndex counts the entire workspace-to-conversation traversal without resetting', () => {
    const w1 = ws('ws-1', [conv('skip-archived', 100, { archived: 1 }), conv('a', 200)])
    const w2 = ws('ws-2', [conv('b', 300), conv('skip-unpinned', null), conv('d', 500)])

    const items = collectPinnedConversations([w1, w2])

    // Full traversal includes excluded entries: a=1, b=2, d=4; indices never reset per workspace.
    expect(ids(items)).toEqual(['d', 'b', 'a'])
    expect(items.map((item) => item.originalIndex)).toEqual([4, 2, 1])
  })

  it('excludes archived and unpinned conversations', () => {
    const w = ws('ws-1', [
      conv('pinned', 100),
      conv('archived', 200, { archived: 1 }),
      conv('unpinned', null),
    ])

    expect(ids(collectPinnedConversations([w]))).toEqual(['pinned'])
  })

  it('collapsed workspaces retain their pinned conversation shortcuts', () => {
    const collapsed = ws('ws-1', [conv('c1', 100), conv('c2', null)])
    collapsed.collapsed = true

    expect(ids(collectPinnedConversations([collapsed]))).toEqual(['c1'])
  })

  it('pinning creates a shortcut to the same object while preserving the complete tree', () => {
    const w = ws('ws-1', [conv('a', 100), conv('b', null)])
    const items = collectPinnedConversations([w])

    // The shortcut references the same object, so rename and status updates affect both occurrences.
    expect(items[0]!.conversation).toBe(w.conversations[0])
    // The original remains in the workspace tree.
    expect(w.conversations).toHaveLength(2)
  })

  it('unpinning removes only the shortcut and preserves the original tree entry', () => {
    const w = ws('ws-1', [conv('a', 100), conv('b', 200)])
    expect(ids(collectPinnedConversations([w]))).toEqual(['b', 'a'])

    // Unpin b by setting pinnedAt to null, then collect from the same state again.
    const after = collectPinnedConversations([
      { ...w, conversations: w.conversations.map((c) => (c.id === 'b' ? { ...c, pinnedAt: null } : c)) },
    ])

    expect(ids(after)).toEqual(['a'])
    expect(after[0]!.conversation).toBe(w.conversations[0]) // The original a remains in the tree.
  })

  it('does not mutate workspaces, lists, or conversations', () => {
    const workspaces = deepFreeze([
      ws('ws-1', [conv('a', 200), conv('unpinned', null)]),
      ws('ws-2', [conv('b', 100)]),
    ])
    const snapshot = JSON.stringify(workspaces)

    expect(() => collectPinnedConversations(workspaces)).not.toThrow()
    expect(JSON.stringify(workspaces)).toBe(snapshot)
  })
})

describe('buildPinnedWorkspaceLabels', () => {
  it('uses only the name when project names differ', () => {
    const labels = buildPinnedWorkspaceLabels([ws('frontend', []), ws('backend', [])])

    expect(labels.get('frontend')).toBe('frontend')
    expect(labels.get('backend')).toBe('backend')
  })

  it('adds the parent directory when project names match', () => {
    const clientA = ws('client-a-api', [])
    clientA.name = 'api'
    clientA.path = '/projects/client-a/api'
    const clientB = ws('client-b-api', [])
    clientB.name = 'api'
    clientB.path = 'C:\\projects\\client-b\\api\\'

    const labels = buildPinnedWorkspaceLabels([clientA, clientB])

    expect(labels.get(clientA.id)).toBe('client-a / api')
    expect(labels.get(clientB.id)).toBe('client-b / api')
  })
})
