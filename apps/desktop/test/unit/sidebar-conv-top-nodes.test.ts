import { describe, expect, it } from 'vitest'
import { buildConvTopNodes } from '../../src/renderer/components/sidebar/conv-top-nodes'
import type { Conversation } from '../../src/preload'

function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
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
  return nodes.map((node) =>
    node.kind === 'conv'
      ? `conv:${node.conv.id}`
      : `group:${node.info.cwd}:${node.members.map((member) => member.id).join(',')}`
  )
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
})
