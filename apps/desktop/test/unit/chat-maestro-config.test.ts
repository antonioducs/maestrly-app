import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { createDefaultMaestroConfig } from '../../src/shared/maestro'
import {
  freezeMaestroTurn,
  getConversationMaestroConfig,
  getGlobalMaestroConfig,
  MAESTRO_CONFIG_SETTING_KEY,
  setConversationMaestroConfig,
  setGlobalMaestroConfig,
  setProjectConversationMaestroConfig,
} from '../../src/main/chat/maestro-config'
import { setAppSetting } from '../../src/main/store'

describe('Maestro config persistence and snapshots', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('provides a safe versioned global default and degrades corrupt config with a diagnostic', () => {
    expect(getGlobalMaestroConfig()).toMatchObject({
      source: 'safe-default',
      hasConversationOverride: false,
      config: { version: 1, strategy: 'balanced' },
    })
    setAppSetting(MAESTRO_CONFIG_SETTING_KEY, '{broken')
    const recovered = getGlobalMaestroConfig()
    expect(recovered.config.strategy).toBe('balanced')
    expect(recovered.diagnostics[0]?.code).toBe('config-corrupt')
  })

  it('distinguishes global and conversation overrides and freezes deep snapshots', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { experience: 'maestro' })
    const global = createDefaultMaestroConfig()
    global.strategy = 'economy'
    expect(setGlobalMaestroConfig(global).ok).toBe(true)
    expect(getConversationMaestroConfig(conversation.id)).toMatchObject({
      source: 'global',
      config: { strategy: 'economy' },
    })

    const override = createDefaultMaestroConfig()
    override.strategy = 'fast'
    expect(setConversationMaestroConfig(conversation.id, override).ok).toBe(true)
    const frozen = freezeMaestroTurn(conversation.id, 123)
    expect(frozen).toMatchObject({ strategy: 'fast', source: 'conversation', frozenAt: 123 })

    override.pool[0]!.label = 'changed outside'
    const current = getConversationMaestroConfig(conversation.id)
    expect(current.config.pool[0]!.label).not.toBe('changed outside')
    expect(setConversationMaestroConfig(conversation.id, null).ok).toBe(true)
    expect(getConversationMaestroConfig(conversation.id).config.strategy).toBe('economy')
  })

  it('normalizes legacy Custom policies and scores without losing agents, instructions or candidates', () => {
    const legacy = {
      version: 1,
      strategy: 'custom',
      custom: {
        qualityWeight: 90,
        speedWeight: 5,
        economyWeight: 5,
        diversityWeight: 50,
        review: 'always',
        crossFamily: 'require',
        escalation: 'aggressive',
        parallelism: 'normal',
        preferFastInTie: true,
      },
      pool: [
        {
          id: 'legacy-worker',
          label: 'Legacy Worker',
          enabled: true,
          description: 'Preserve me',
          capability: 'worker',
          specialties: ['frontend'],
          quality: 99,
          speed: 20,
          economy: 10,
          instructions: 'Keep these instructions.',
          candidates: [{ providerId: 'openai', modelId: 'gpt-5', effort: 'high', fastMode: true }],
        },
      ],
    }
    setAppSetting(MAESTRO_CONFIG_SETTING_KEY, JSON.stringify(legacy))

    const migrated = getGlobalMaestroConfig().config
    expect(migrated).toEqual({
      version: 1,
      strategy: 'balanced',
      pool: [
        {
          id: 'legacy-worker',
          label: 'Legacy Worker',
          enabled: true,
          description: 'Preserve me',
          capability: 'worker',
          specialties: ['frontend'],
          instructions: 'Keep these instructions.',
          candidates: [{ providerId: 'openai', modelId: 'gpt-5', effort: 'high', fastMode: true }],
        },
      ],
    })
    expect(JSON.stringify(migrated)).not.toContain('qualityWeight')
    expect(JSON.stringify(migrated)).not.toContain('"quality"')
  })

  it('marks host-applied project snapshots without leaking that marker into regular overrides', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { experience: 'maestro' })
    const shared = createDefaultMaestroConfig()
    expect(setProjectConversationMaestroConfig(conversation.id, shared).ok).toBe(true)
    expect(freezeMaestroTurn(conversation.id, 1).source).toBe('project')
    expect(setConversationMaestroConfig(conversation.id, shared).ok).toBe(true)
    expect(freezeMaestroTurn(conversation.id, 2).source).toBe('conversation')
  })

  it('rejects conversation overrides on Standard conversations', () => {
    const workspace = makeWorkspace()
    const standard = makeConversation(workspace.id, { experience: 'standard' })
    expect(setConversationMaestroConfig(standard.id, createDefaultMaestroConfig())).toMatchObject({ ok: false })
  })
})
