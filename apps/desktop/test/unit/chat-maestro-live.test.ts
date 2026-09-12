import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { createMaestroLiveRunPort } from '../../src/main/chat/maestro-live'
import { stripMaestroLiveEnvelope, type MaestroLiveEvent } from '../../src/shared/maestro-live'

describe('Maestro live run port', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('embeds pending user updates exactly once and keeps a clean renderer projection', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { experience: 'maestro' })
    const events: MaestroLiveEvent[] = []
    const port = createMaestroLiveRunPort({ conversationId: conv.id, emit: (event) => events.push(event) })
    expect(port.post('also cover Windows').ok).toBe(true)

    const first = port.embedPending('delegate-a', 'worker result')
    const second = port.embedPending('delegate-b', 'other result')
    expect(first.messageIds).toHaveLength(1)
    expect(first.output).toContain('<maestrly-user-updates')
    expect(first.output).toContain('also cover Windows')
    expect(stripMaestroLiveEnvelope(first.output)).toBe('worker result')
    expect(second).toMatchObject({ messageIds: [], output: 'other result' })
    expect(port.state().run).toMatchObject({ pendingCount: 0, embeddedCount: 1 })
    expect(events.some((event) => event.kind === 'messages-updated')).toBe(true)
  })

  it('rolls a late update over on normal finish and cancels it on stop', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { experience: 'maestro' })
    const emit = vi.fn<(event: MaestroLiveEvent) => void>()
    const completed = createMaestroLiveRunPort({ conversationId: conv.id, emit })
    completed.post('late requirement')
    completed.finish('completed')
    expect(completed.state().messages[0]?.status).toBe('rolled_over')

    const aborted = createMaestroLiveRunPort({ conversationId: conv.id, emit })
    aborted.post('do not continue')
    aborted.cancelPending()
    aborted.finish('aborted')
    expect(aborted.state().messages[0]?.status).toBe('cancelled')
  })
})
