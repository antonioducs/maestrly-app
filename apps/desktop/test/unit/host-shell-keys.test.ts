import { describe, expect, it, vi } from 'vitest'
import type { Conversation, WorkspaceWithConversations } from '../../src/preload'
import {
  hostActiveSetter,
  hostConversation,
  hostOfKey,
  hostRecordSetter,
  hostWorkspace,
  isRemoteKey,
  rawId,
  rawIds,
  shellConversation,
  shellGroup,
  shellIds,
  shellRecord,
  shellWorkspace,
} from '../../src/renderer/lib/hosts/shell-keys'

const HOST = 'server-1/workspaces'
const project = (id: string, workspaceId: string, extra: Partial<Conversation> = {}) =>
  ({ id, name: id, scope: 'project', workspaceId, archived: 0, pinnedAt: null, ...extra }) as Conversation
const chat = (id: string) => ({ id, name: id, scope: 'standalone', workspaceId: null }) as Conversation
const workspace = (id: string, conversations: Conversation[], groupId: string | null = null) =>
  ({ id, name: id, path: `/srv/${id}`, groupId, conversations, collapsed: false }) as WorkspaceWithConversations

describe('shell keys', () => {
  it("leaves this computer's ids as they are", () => {
    const conv = project('c1', 'w1')
    expect(shellConversation('local', conv)).toBe(conv)
    expect(hostConversation(conv)).toBe(conv)
    const ws = workspace('w1', [conv])
    expect(shellWorkspace('local', ws)).toBe(ws)
    expect(hostWorkspace(ws)).toBe(ws)
    expect(shellRecord('local', { c1: 1 })).toEqual({ c1: 1 })
    expect(isRemoteKey('c1')).toBe(false)
    expect(hostOfKey('c1')).toBe('local')
    expect(rawId('c1')).toBe('c1')
  })

  it('carries a remote host in every id of its conversations, and takes it out again', () => {
    const conv = project('c1', 'w1', {
      repos: [{ workspaceId: 'w2', repoTop: '/r', branch: 'b', base: 'main', worktreePath: '/t', linkName: 'r' }],
    } as Partial<Conversation>)
    const shell = shellConversation(HOST, conv)
    expect(shell).toMatchObject({ id: `${HOST}#c1`, workspaceId: `${HOST}#w1`, name: 'c1' })
    expect(shell.repos?.[0].workspaceId).toBe(`${HOST}#w2`)
    expect(isRemoteKey(shell.id)).toBe(true)
    expect(hostOfKey(shell.id)).toBe(HOST)
    expect(rawId(shell.id)).toBe('c1')
    expect(hostConversation(shell)).toEqual(conv)
    // A chat has no workspace to key.
    expect(shellConversation(HOST, chat('s1'))).toMatchObject({ id: `${HOST}#s1`, workspaceId: null })
  })

  it('keys a workspace with its group and conversations, and a group, a record and a set of ids', () => {
    const ws = workspace('w1', [project('c1', 'w1'), project('c2', 'w1')], 'g1')
    const shell = shellWorkspace(HOST, ws)
    expect(shell).toMatchObject({ id: `${HOST}#w1`, groupId: `${HOST}#g1`, path: '/srv/w1' })
    expect(shell.conversations.map((item) => [item.id, item.workspaceId])).toEqual([
      [`${HOST}#c1`, `${HOST}#w1`],
      [`${HOST}#c2`, `${HOST}#w1`],
    ])
    expect(hostWorkspace(shell)).toEqual(ws)
    expect(shellWorkspace(HOST, workspace('w2', [])).groupId).toBeNull()
    expect(shellGroup(HOST, { id: 'g1', name: 'G', position: 0, collapsed: false }).id).toBe(`${HOST}#g1`)
    expect(shellRecord(HOST, { c1: 'working' })).toEqual({ [`${HOST}#c1`]: 'working' })
    expect([...shellIds(HOST, ['c1', 'c2'])]).toEqual([`${HOST}#c1`, `${HOST}#c2`])
    expect(rawIds([`${HOST}#c1`, 'c9'])).toEqual(['c1', 'c9'])
  })

  it("shows a host's code only its own entries of a record of the window, and merges what it returns", () => {
    let state: Record<string, boolean> = { local1: true, [`${HOST}#c1`]: false, ['other/host#c1']: true }
    const set = hostRecordSetter<boolean>(HOST, (update) => {
      state = update(state)
    })
    const seen: Array<Record<string, boolean>> = []
    set((mine) => {
      seen.push(mine)
      return { ...mine, c2: true }
    })
    expect(seen).toEqual([{ c1: false }])
    expect(state).toEqual({ local1: true, ['other/host#c1']: true, [`${HOST}#c1`]: false, [`${HOST}#c2`]: true })
    // Returning what it was given changes nothing, keeping the record's identity.
    const before = state
    set((mine) => mine)
    expect(state).toBe(before)
    set({ c3: true })
    expect(state).toEqual({ local1: true, ['other/host#c1']: true, [`${HOST}#c3`]: true })
  })

  it("lets a host's code set the active conversation without touching another host's", () => {
    let active: Conversation | null = project('local1', 'w1')
    const set = hostActiveSetter(HOST, (update) => {
      active = update(active)
    })
    const local = active
    // Another host's conversation is active: this host sees none, and clearing leaves it alone.
    const seen = vi.fn((mine: Conversation | null) => mine)
    set(seen)
    expect(seen).toHaveBeenCalledWith(null)
    set(null)
    expect(active).toBe(local)

    set(project('c1', 'w1'))
    expect(active).toMatchObject({ id: `${HOST}#c1`, workspaceId: `${HOST}#w1` })
    // Its own conversation reaches it in host form, and what it returns goes back keyed.
    set((mine) => (mine ? { ...mine, name: 'renamed' } : mine))
    expect(active).toMatchObject({ id: `${HOST}#c1`, name: 'renamed' })
    set((mine) => (mine?.id === 'c1' ? null : mine))
    expect(active).toBeNull()
  })
})
