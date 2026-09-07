import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerChatIpc, type ChatIpcDeps } from '../../src/main/chat/service'
import { getConvUiPrefs, patchConvUiPrefs } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

type Handler = (event: never, ...args: unknown[]) => unknown

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerChatIpc({
    mhandle: (channel, fn) => void handlers.set(channel, fn as Handler),
    mon: vi.fn(),
    emitStatus: vi.fn(),
  } satisfies ChatIpcDeps)
  return handlers
}

describe('Design mode service contract', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('persists Design independently per Standard conversation and defaults missing preferences to Agent', () => {
    const workspace = makeWorkspace()
    const first = makeConversation(workspace.id, {
      uiPrefs: {
        chat: {
          providerId: 'provider-1',
          modelId: 'model-1',
          permMode: 'auto',
          reasoning: 'high',
          fastMode: true,
          tools: { app: false, imageGen: false, mcpDisabled: ['server-1'] },
        },
      },
    })
    const second = makeConversation(workspace.id)
    const handlers = register()
    const getMode = handlers.get('chat:get-mode')!
    const setMode = handlers.get('chat:set-mode')!

    expect(getMode(undefined as never, first.id)).toBe('agent')
    expect(setMode(undefined as never, first.id, 'design')).toEqual({ ok: true })
    expect(getMode(undefined as never, first.id)).toBe('design')
    expect(getMode(undefined as never, second.id)).toBe('agent')
    expect(getConvUiPrefs(first.id).chat).toMatchObject({
      providerId: 'provider-1',
      modelId: 'model-1',
      mode: 'design',
      permMode: 'auto',
      reasoning: 'high',
      fastMode: true,
      tools: { app: false, imageGen: false, mcpDisabled: ['server-1'] },
    })
  })

  it('rejects invalid writes without overwriting the confirmed preference', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { uiPrefs: { chat: { mode: 'design' } } })
    const setMode = register().get('chat:set-mode')!

    expect(setMode(undefined as never, conversation.id, 'maestro')).toEqual({ ok: false, error: 'invalid-mode' })
    expect(setMode(undefined as never, conversation.id, 'invalid')).toEqual({ ok: false, error: 'invalid-mode' })
    expect(setMode(undefined as never, 'missing', 'agent')).toEqual({ ok: false, error: 'invalid-conversation' })
    expect(getConvUiPrefs(conversation.id).chat?.mode).toBe('design')
  })

  it('normalizes corrupt persisted values without changing the stored value', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    patchConvUiPrefs(conversation.id, { chat: { mode: 'legacy' as never } })

    expect(register().get('chat:get-mode')!(undefined as never, conversation.id)).toBe('agent')
    expect(getConvUiPrefs(conversation.id).chat?.mode).toBe('legacy')
  })

  it('captures the admitted behavior for the generic runner instead of rereading mutable preferences', () => {
    const source = readFileSync('src/main/chat/service.ts', 'utf8')
    const genericCall = source.slice(
      source.indexOf('turnPromise = runChat({'),
      source.indexOf('\n      })', source.indexOf('turnPromise = runChat({'))
    )
    expect(genericCall).toContain('behaviorOverride: turnBehavior')
    expect(genericCall).not.toContain('modeOverride: internalTurnMode')
  })
})
