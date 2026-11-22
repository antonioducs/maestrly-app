import { describe, expect, it } from 'vitest'
import { buildConvTopNodes } from '../../src/renderer/components/sidebar/conv-top-nodes'
import type { ProjectConversation } from '../../src/shared/conversation'

function conversation(id: string, overrides: Partial<ProjectConversation> = {}): ProjectConversation {
  return {
    scope: 'project',
    id,
    workspaceId: 'workspace-1',
    name: id,
    branch: 'main',
    mode: 'worktree',
    experience: 'standard',
    cwd: `/repo/${id}`,
    status: 'idle',
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 0,
    isMulti: 0,
    ...overrides,
  }
}

function nodeIds(nodes: ReturnType<typeof buildConvTopNodes>) {
  return nodes.map((node) => {
    if (node.kind === 'conv') return `conv:${node.conv.id}`
    if (node.kind === 'dispatch')
      return `dispatch:${node.info.rootId}:${node.info.rootName}:${node.members.map((member) => member.id).join(',')}`
    return `group:${node.info.cwd}:${node.members.map((member) => member.id).join(',')}`
  })
}

describe('buildConvTopNodes', () => {
  it('groups worktree conversations that share a working directory', () => {
    const conversations = [
      conversation('c5', { cwd: '/repo/shared', branch: 'first', createdAt: 50 }),
      conversation('c4', { cwd: '/repo/shared', branch: 'second', createdAt: 40 }),
    ]

    const nodes = buildConvTopNodes(conversations)

    expect(nodes[0]).toMatchObject({ kind: 'group', info: { cwd: '/repo/shared', branch: 'first' } })
    expect(nodeIds(nodes)).toEqual(['group:/repo/shared:c4,c5'])
  })

  it('keeps a conversation with a unique working directory as a singleton', () => {
    expect(nodeIds(buildConvTopNodes([conversation('c1', { cwd: '/repo/one' })]))).toEqual(['conv:c1'])
  })

  it('groups local conversations by working directory and branch without grouping multi-repository entries', () => {
    const conversations = [
      conversation('local1', { cwd: '/repo/shared', mode: 'local', createdAt: 10 }),
      conversation('local2', { cwd: '/repo/shared', mode: 'local', createdAt: 20 }),
      conversation('local-feature', { cwd: '/repo/shared', branch: 'feature', mode: 'local', createdAt: 25 }),
      conversation('multi1', { cwd: '/repo/multi', isMulti: 1, createdAt: 30 }),
      conversation('multi2', { cwd: '/repo/multi', isMulti: 1, createdAt: 40 }),
    ]

    const nodes = buildConvTopNodes(conversations)

    expect(nodes[0]).toMatchObject({
      kind: 'group',
      info: { cwd: '/repo/shared', branch: 'main', mode: 'local' },
    })
    expect(nodeIds(nodes)).toEqual([
      'group:/repo/shared:local1,local2',
      'conv:local-feature',
      'conv:multi1',
      'conv:multi2',
    ])
  })

  it('keeps local groups on different branches separate', () => {
    const nodes = buildConvTopNodes([
      conversation('main1', { cwd: '/repo/shared', mode: 'local', branch: 'main', createdAt: 10 }),
      conversation('feature1', { cwd: '/repo/shared', mode: 'local', branch: 'feature', createdAt: 20 }),
      conversation('main2', { cwd: '/repo/shared', mode: 'local', branch: 'main', createdAt: 30 }),
      conversation('feature2', { cwd: '/repo/shared', mode: 'local', branch: 'feature', createdAt: 40 }),
    ])

    expect(nodeIds(nodes)).toEqual(['group:/repo/shared:main1,main2', 'group:/repo/shared:feature1,feature2'])
    if (nodes[0]?.kind !== 'group' || nodes[1]?.kind !== 'group') throw new Error('Expected two groups')
    expect(nodes[0].info.key).not.toBe(nodes[1].info.key)
  })

  it('preserves node order by first occurrence', () => {
    const nodes = buildConvTopNodes([
      conversation('group-late', { cwd: '/repo/group', createdAt: 40 }),
      conversation('loose', { cwd: '/repo/loose', createdAt: 10 }),
      conversation('group-early', { cwd: '/repo/group', createdAt: 20 }),
    ])

    expect(nodeIds(nodes)).toEqual(['group:/repo/group:group-early,group-late', 'conv:loose'])
  })

  it('groups a root with its children and grandchildren into one dispatch folder ordered by createdAt', () => {
    const nodes = buildConvTopNodes([
      conversation('grandchild', {
        name: 'Grandchild',
        createdAt: 30,
        dispatchOrigin: {
          sourceConversationId: 'child-1',
          sourceName: 'Child 1',
          rootConversationId: 'root',
          rootName: 'FixTest',
        },
      }),
      conversation('loose', { createdAt: 5 }),
      conversation('child-2', {
        name: 'Child 2',
        createdAt: 25,
        dispatchOrigin: {
          sourceConversationId: 'root',
          sourceName: 'FixTest',
          rootConversationId: 'root',
          rootName: 'FixTest',
        },
      }),
      conversation('root', { name: 'FixTest', createdAt: 100 }),
      conversation('child-1', {
        name: 'Child 1',
        createdAt: 15,
        dispatchOrigin: {
          sourceConversationId: 'root',
          sourceName: 'FixTest',
          rootConversationId: 'root',
          rootName: 'FixTest',
        },
      }),
    ])

    expect(nodes[0]).toMatchObject({
      kind: 'dispatch',
      info: { key: 'dispatch:root', rootId: 'root', rootName: 'FixTest' },
    })
    // Folder sits at the position of its first member (grandchild), root comes first inside, then derived by createdAt.
    expect(nodeIds(nodes)).toEqual(['dispatch:root:FixTest:root,child-1,child-2,grandchild', 'conv:loose'])
  })

  it('creates a dispatch folder with only children when the root is external to the workspace', () => {
    const nodes = buildConvTopNodes([
      conversation('c2', {
        createdAt: 20,
        dispatchOrigin: {
          sourceConversationId: 'standalone-root',
          sourceName: 'Planning Chat',
          rootConversationId: 'standalone-root',
          rootName: 'Planning Chat',
        },
      }),
      conversation('c1', {
        createdAt: 10,
        dispatchOrigin: {
          sourceConversationId: 'standalone-root',
          sourceName: 'Planning Chat',
          rootConversationId: 'standalone-root',
          rootName: 'Planning Chat',
        },
      }),
    ])

    expect(nodeIds(nodes)).toEqual(['dispatch:standalone-root:Planning Chat:c1,c2'])
  })

  it('does not wrap a root without derived conversations in a dispatch folder', () => {
    const nodes = buildConvTopNodes([conversation('root', { name: 'FixTest', createdAt: 10 })])
    expect(nodeIds(nodes)).toEqual(['conv:root'])
  })

  it('gives dispatch folders precedence over shared-worktree groups while keeping shared grouping for the rest', () => {
    const nodes = buildConvTopNodes([
      conversation('root', { name: 'FixTest', cwd: '/repo/shared', createdAt: 10 }),
      conversation('child', {
        cwd: '/repo/shared',
        createdAt: 20,
        dispatchOrigin: {
          sourceConversationId: 'root',
          sourceName: 'FixTest',
          rootConversationId: 'root',
          rootName: 'FixTest',
        },
      }),
      conversation('bystander', { cwd: '/repo/shared', createdAt: 30 }),
      conversation('other-1', { cwd: '/repo/other', createdAt: 40 }),
      conversation('other-2', { cwd: '/repo/other', createdAt: 50 }),
    ])

    expect(nodeIds(nodes)).toEqual([
      'dispatch:root:FixTest:root,child',
      'conv:bystander',
      'group:/repo/other:other-1,other-2',
    ])
  })
})
