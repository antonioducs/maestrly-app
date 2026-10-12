import { describe, expect, it } from 'vitest'
import type { Conversation, WorkspaceWithConversations } from '../../src/preload'
import { memoryKeyFor, memoryTargetOf, personalMemoryKey } from '../../src/renderer/lib/memory-target'

const SERVER = 'server-1/workspaces'
const conversation = (id: string, patch: Partial<Conversation> = {}) => ({ id, ...patch }) as Conversation
const workspace = (id: string, conversations: Conversation[]) =>
  ({ id, conversations }) as unknown as WorkspaceWithConversations

// The conversations of every host, keyed for the window as DesktopApp passes them.
const workspaces = [
  workspace('ws-1', [conversation('conv-1')]),
  workspace(`${SERVER}#ws-1`, [conversation(`${SERVER}#conv-1`)]),
]
const chats = [
  conversation('chat-1'),
  conversation('bot-chat', { botOrigin: { botName: 'Bot' } as Conversation['botOrigin'] }),
  conversation(`${SERVER}#chat-1`),
]

describe('which memory center a link opens', () => {
  it("opens the personal memory of a chat's host, this computer's or a server's", () => {
    expect(memoryKeyFor({ conversationId: 'chat-1' }, workspaces, chats)).toBe(personalMemoryKey('local'))
    expect(memoryKeyFor({ conversationId: `${SERVER}#chat-1` }, workspaces, chats)).toBe(personalMemoryKey(SERVER))
    expect(personalMemoryKey(SERVER)).not.toBe(personalMemoryKey('local'))
  })

  it("opens a workspace conversation's own workspace on its host, never a same-named one of another host", () => {
    expect(memoryKeyFor({ conversationId: 'conv-1' }, workspaces, chats)).toBe('ws-1')
    expect(memoryKeyFor({ conversationId: `${SERVER}#conv-1` }, workspaces, chats)).toBe(`${SERVER}#ws-1`)
  })

  it('opens the personal memory a request names, this computer’s when it names no host', () => {
    expect(memoryKeyFor({ personal: true, hostId: SERVER }, [], [])).toBe(personalMemoryKey(SERVER))
    expect(memoryKeyFor({ personal: true }, [], [])).toBe(personalMemoryKey('local'))
  })

  it('opens nothing for a bot conversation or one this window does not know', () => {
    expect(memoryKeyFor({ conversationId: 'bot-chat' }, workspaces, chats)).toBeNull()
    expect(memoryKeyFor({ conversationId: `${SERVER}#unknown` }, workspaces, chats)).toBeNull()
    expect(memoryKeyFor({}, workspaces, chats)).toBeNull()
  })

  it('reads the target back from its key', () => {
    expect(memoryTargetOf(null)).toBeNull()
    // This computer's personal memory keeps the key it always had.
    expect(personalMemoryKey('local')).toBe('personal-chat')
    expect(memoryTargetOf(personalMemoryKey('local'))).toEqual({ kind: 'personal', hostId: 'local' })
    expect(memoryTargetOf(personalMemoryKey(SERVER))).toEqual({ kind: 'personal', hostId: SERVER })
    expect(memoryTargetOf(`${SERVER}#ws-1`)).toEqual({ kind: 'workspace', workspaceId: `${SERVER}#ws-1` })
    expect(memoryTargetOf('ws-1')).toEqual({ kind: 'workspace', workspaceId: 'ws-1' })
  })
})
