import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getConversation, getConvUiPrefs, getDb } from '../../src/main/store'
import { createDefaultMaestroConfig } from '../../src/shared/maestro'
import {
  convertMaestroConversationToStandard,
  convertStandardConversationToMaestro,
  setChatMode,
} from '../../src/main/chat/service'

describe('Maestro and Standard conversation behavior', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('preserves Standard modes including Design and ignores mode mutation for Maestro', () => {
    const workspace = makeWorkspace()
    const standard = makeConversation(workspace.id, { experience: 'standard' })
    const maestro = makeConversation(workspace.id, { experience: 'maestro' })

    setChatMode(standard.id, 'design')
    setChatMode(maestro.id, 'plan')

    expect(getConvUiPrefs(standard.id).chat?.mode).toBe('design')
    expect(getConvUiPrefs(maestro.id).chat?.mode).toBeUndefined()
  })

  it('hands an idle Maestro conversation to Standard without losing its model, history settings, or Pool', () => {
    const workspace = makeWorkspace()
    const maestroConfig = createDefaultMaestroConfig()
    maestroConfig.strategy = 'best-quality'
    const maestro = makeConversation(workspace.id, {
      experience: 'maestro',
      status: 'ready',
      uiPrefs: {
        chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'ask', reasoning: 'high' },
        maestro: { config: maestroConfig },
      },
    })
    getDb()
      .prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
         VALUES (?, ?, 'assistant', ?, NULL, 1, ?)`
      )
      .run('message-1', maestro.id, JSON.stringify([{ type: 'text', text: 'Maestro result' }]), Date.now())

    expect(convertMaestroConversationToStandard(maestro.id)).toEqual({ ok: true })
    expect(getConversation(maestro.id)?.experience).toBe('standard')
    expect(getDb().prepare('SELECT parts_json FROM chat_messages WHERE id = ?').get('message-1')).toEqual({
      parts_json: JSON.stringify([{ type: 'text', text: 'Maestro result' }]),
    })
    expect(getConvUiPrefs(maestro.id)).toMatchObject({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'ask', reasoning: 'high' },
      maestro: { config: { strategy: 'best-quality' } },
    })

    setChatMode(maestro.id, 'plan')
    expect(getConvUiPrefs(maestro.id).chat?.mode).toBe('plan')
  })

  it('refuses the handoff while the Maestro conversation is active', () => {
    const workspace = makeWorkspace()
    const maestro = makeConversation(workspace.id, { experience: 'maestro', status: 'working' })

    expect(convertMaestroConversationToStandard(maestro.id)).toEqual({
      ok: false,
      error: 'conversation-busy',
    })
    expect(getConversation(maestro.id)?.experience).toBe('maestro')
  })

  it('refuses the handoff while a durable Maestro run is still active', () => {
    const workspace = makeWorkspace()
    const maestro = makeConversation(workspace.id, { experience: 'maestro', status: 'ready' })
    getDb()
      .prepare(
        `INSERT INTO chat_maestro_runs (id, conversation_id, status, started_at)
         VALUES (?, ?, 'active', ?)`
      )
      .run('run-1', maestro.id, Date.now())

    expect(convertMaestroConversationToStandard(maestro.id)).toEqual({
      ok: false,
      error: 'conversation-busy',
    })
    expect(getConversation(maestro.id)?.experience).toBe('maestro')
  })

  it('enters Maestro without losing history, model, Pool, or the current Standard mode', () => {
    const workspace = makeWorkspace()
    const maestroConfig = createDefaultMaestroConfig()
    maestroConfig.strategy = 'economy'
    const standard = makeConversation(workspace.id, {
      experience: 'standard',
      status: 'ready',
      uiPrefs: {
        chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'design', reasoning: 'high' },
        maestro: { config: maestroConfig },
      },
    })
    getDb()
      .prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
         VALUES (?, ?, 'assistant', ?, NULL, 1, ?)`
      )
      .run('standard-message-1', standard.id, JSON.stringify([{ type: 'text', text: 'Standard result' }]), Date.now())

    expect(convertStandardConversationToMaestro(standard.id)).toEqual({ ok: true })
    expect(getConversation(standard.id)?.experience).toBe('maestro')
    expect(getDb().prepare('SELECT parts_json FROM chat_messages WHERE id = ?').get('standard-message-1')).toEqual({
      parts_json: JSON.stringify([{ type: 'text', text: 'Standard result' }]),
    })
    expect(getConvUiPrefs(standard.id)).toMatchObject({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'design', reasoning: 'high' },
      maestro: { config: { strategy: 'economy' } },
    })

    expect(convertMaestroConversationToStandard(standard.id)).toEqual({ ok: true })
    expect(getConversation(standard.id)?.experience).toBe('standard')
    expect(getConvUiPrefs(standard.id).chat?.mode).toBe('design')
  })

  it('refuses to enter Maestro while the Standard conversation is active', () => {
    const workspace = makeWorkspace()
    const standard = makeConversation(workspace.id, { experience: 'standard', status: 'working' })

    expect(convertStandardConversationToMaestro(standard.id)).toEqual({
      ok: false,
      error: 'conversation-busy',
    })
    expect(getConversation(standard.id)?.experience).toBe('standard')
  })
})
