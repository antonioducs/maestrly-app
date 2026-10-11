import { clipboard } from 'electron'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  companionPrompt: vi.fn((_conversationId: string): string | null => null),
  companionSessionKey: vi.fn((_conversationId: string): string | null => null),
}))
vi.mock('../../src/main/chat/chatgpt-web/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/chatgpt-web/manager')>()),
  companionPrompt: h.companionPrompt,
  companionSessionKey: h.companionSessionKey,
}))

import { registerChatIpc, type ChatIpcDeps } from '../../src/main/chat/service'
import { closeDb, freshDb } from '../helpers/db'

type Handler = (event: never, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const write = vi.spyOn(clipboard, 'writeText')
const copy = (channel: string, input?: unknown) => handlers.get(channel)!(undefined as never, input)

const channels = [
  ['chat:chatgpt-web:companion-copy-prompt', h.companionPrompt, 'safe-prompt'],
  ['chat:chatgpt-web:companion-copy-session-key', h.companionSessionKey, 'safe-session-key'],
] as const

describe('ChatGPT Web companion clipboard IPC', () => {
  beforeAll(() => {
    freshDb()
    registerChatIpc({
      mhandle: (channel, fn) => void handlers.set(channel, fn as Handler),
      mon: vi.fn(),
      emitStatus: vi.fn(),
    } satisfies ChatIpcDeps)
  })
  beforeEach(() => {
    write.mockReset()
    write.mockResolvedValue(undefined)
    h.companionPrompt.mockReset().mockReturnValue(null)
    h.companionSessionKey.mockReset().mockReturnValue(null)
  })
  afterAll(() => {
    write.mockRestore()
    closeDb()
  })

  it('registers dedicated copy channels and no channel that returns the session key', () => {
    for (const [channel] of channels) expect(handlers.has(channel)).toBe(true)
    expect(handlers.has('chat:chatgpt-web:companion-session-key')).toBe(false)
  })

  it.each(channels)('%s copies in main and resolves only after the native write', async (channel, source, text) => {
    source.mockReturnValue(text)
    let settle!: () => void
    write.mockReturnValueOnce(new Promise<void>((resolve) => (settle = resolve)))
    let result: unknown
    const pending = Promise.resolve(copy(channel, { conversationId: 'conv-web' })).then((value) => {
      result = value
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(source).toHaveBeenCalledWith('conv-web')
    expect(write).toHaveBeenCalledWith(text)
    expect(result).toBeUndefined()
    settle()
    await pending
    // The renderer learns only whether the copy succeeded, never the copied value.
    expect(result).toEqual({ ok: true })
  })

  it.each(channels)('%s reports a missing session without touching the clipboard', async (channel, source) => {
    await expect(copy(channel, { conversationId: 'ended' })).resolves.toEqual({ ok: false, error: 'session-not-found' })
    expect(source).toHaveBeenCalledWith('ended')
    for (const input of [undefined, {}, { conversationId: '' }, { conversationId: 42 }])
      await expect(copy(channel, input)).resolves.toEqual({ ok: false, error: 'session-not-found' })
    expect(source).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
  })

  it.each(channels)('%s returns clipboard failures as errors', async (channel, source, text) => {
    source.mockReturnValue(text)
    write.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    await expect(copy(channel, { conversationId: 'conv-web' })).resolves.toEqual({
      ok: false,
      error: 'Clipboard unavailable',
    })
    write.mockRejectedValueOnce('denied')
    await expect(copy(channel, { conversationId: 'conv-web' })).resolves.toEqual({ ok: false, error: 'denied' })
  })
})
