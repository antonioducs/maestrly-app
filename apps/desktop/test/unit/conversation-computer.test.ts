import { describe, expect, it } from 'vitest'
import { screenTargetOf } from '../../src/renderer/lib/fleet/screen-target'
import { computerStage } from '../../src/renderer/lib/conversation-computer'

describe("a remote conversation's Computer tab", () => {
  it('shows the screen once the computer runs, and why there is none otherwise', () => {
    expect(computerStage({ ok: true, display: ':10', started: true })).toEqual({
      stage: 'screen',
      holders: [],
      error: '',
    })
    expect(computerStage({ ok: false, reason: 'busy', holders: ['Fix login', 'Docs'] })).toEqual({
      stage: 'busy',
      holders: ['Fix login', 'Docs'],
      error: '',
    })
    expect(computerStage({ ok: false, reason: 'unavailable' })).toMatchObject({ stage: 'unavailable' })
    expect(computerStage(new Error('x'))).toEqual({ stage: 'error', holders: [], error: 'x' })
  })

  it("streams the conversation's computer from its environment, and keeps the other screen targets", () => {
    expect(screenTargetOf({ kind: 'conversation', id: 'workspaces', conversationId: 'c-1', surface: null })).toEqual({
      environmentId: 'workspaces',
      conversationId: 'c-1',
      surface: 'apps',
    })
    expect(
      screenTargetOf({ kind: 'conversation', id: 'workspaces', conversationId: 'c-1', surface: 'browser' })
    ).toEqual({ environmentId: 'workspaces', conversationId: 'c-1', surface: 'browser' })
    expect(screenTargetOf({ kind: 'environment', id: 'work', surface: null })).toEqual({ environmentId: 'work' })
    expect(screenTargetOf({ kind: 'bot', id: 'scout', surface: 'apps' })).toEqual({ botId: 'scout', surface: 'apps' })
    expect(screenTargetOf({ kind: 'bot', id: 'scout', surface: null })).toBe('scout')
  })
})
