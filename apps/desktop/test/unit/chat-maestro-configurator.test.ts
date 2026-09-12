import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'
import { closeDb, freshDb } from '../helpers/db'
import { cloneMaestroConfig, createDefaultMaestroConfig } from '../../src/shared/maestro'
import { hashMaestroConfig, type MaestroConfiguratorCatalog } from '../../src/shared/maestro-configurator'
import { getDb, setAppSetting } from '../../src/main/store'
import { aggregateChatUsage } from '../../src/main/chat/chat-store'
import {
  MaestroConfiguratorService,
  buildMaestroConfiguratorCatalog,
  validateMaestroConfiguratorProfile,
  validateMaestroProposalCatalog,
} from '../../src/main/chat/maestro-configurator'
import type { executeSubagent } from '../../src/main/chat/subagent-executor'

const h = vi.hoisted(() => ({
  providers: [{ id: 'provider-1', name: 'Provider One' }],
  providerStatus: vi.fn(async () => 'available' as const),
  modelCatalog: vi.fn(async () => ({ status: 'available' as const, models: ['fable', 'terra'] })),
  modelMeta: vi.fn(async (_providerId: string, modelId: string) => ({
    status: 'available' as const,
    meta: {
      chatCapable: true,
      reasoning: true,
      reasoningEfforts: modelId === 'fable' ? ['high', 'max'] : ['medium', 'high'],
      fastModeCapability: modelId === 'terra',
    },
  })),
}))

vi.mock('../../src/main/chat/catalog', () => ({
  listAvailableChatProviders: () => h.providers,
}))

vi.mock('../../src/main/chat/subagent-provider-runtime', () => ({
  subagentProviderStatus: h.providerStatus,
  subagentModelCatalog: h.modelCatalog,
  subagentModelMeta: h.modelMeta,
}))

const catalog: MaestroConfiguratorCatalog = {
  generatedAt: 1,
  providers: [
    {
      id: 'provider-1',
      name: 'Provider One',
      catalogStatus: 'available',
      models: [
        { id: 'fable', reasoning: true, reasoningEfforts: ['high', 'max'], fastModeCapability: false },
        { id: 'terra', reasoning: true, reasoningEfforts: ['medium', 'high'], fastModeCapability: true },
      ],
    },
  ],
}

const resolvedProfile = async () => ({
  version: 1 as const,
  agentName: 'maestro-configurator',
  effective: {
    providerId: 'provider-1',
    modelId: 'fable',
    configuredEffort: 'high',
    sentEffort: 'high',
    fastMode: false,
    source: 'parent' as const,
    candidateIndex: 0,
  },
  attempts: [],
  diagnostics: [],
})

beforeEach(() => {
  freshDb()
  vi.clearAllMocks()
})
afterEach(closeDb)

describe('Maestro configurator service', () => {
  it('defaults to the Maestrly Chat provider/model/reasoning when that profile is runnable', async () => {
    setAppSetting('chat.defaultProvider', 'provider-1')
    setAppSetting('chat.defaultModel', 'terra')
    setAppSetting('chat.defaultReasoning', 'high')
    const service = new MaestroConfiguratorService({ catalog: async () => catalog })
    await expect(service.state()).resolves.toMatchObject({
      profile: { providerId: 'provider-1', modelId: 'terra', effort: 'high' },
    })
  })

  it('builds a live public catalog without credentials and exposes capabilities', async () => {
    const value = await buildMaestroConfiguratorCatalog(123)
    expect(value).toEqual({
      generatedAt: 123,
      providers: [
        expect.objectContaining({
          id: 'provider-1',
          name: 'Provider One',
          models: [
            expect.objectContaining({ id: 'fable', reasoningEfforts: ['high', 'max'], fastModeCapability: false }),
            expect.objectContaining({ id: 'terra', fastModeCapability: true }),
          ],
        }),
      ],
    })
    expect(JSON.stringify(value)).not.toContain('key')
    expect(JSON.stringify(value)).not.toContain('token')
  })

  it('validates profile and every proposed Pool candidate against the live catalog', () => {
    expect(
      validateMaestroConfiguratorProfile(
        { providerId: 'provider-1', modelId: 'terra', effort: 'high', fastMode: true },
        catalog
      )
    ).toEqual([])
    expect(
      validateMaestroConfiguratorProfile(
        { providerId: 'provider-1', modelId: 'fable', effort: 'high', fastMode: true },
        catalog
      )
    ).toContain('Model “fable” does not support Fast mode.')

    const proposal = createDefaultMaestroConfig()
    proposal.pool[0].candidates = [{ providerId: 'provider-1', modelId: 'missing', effort: 'high' }]
    expect(validateMaestroProposalCatalog(proposal, catalog)).toEqual([
      expect.objectContaining({ severity: 'error', resourceId: proposal.pool[0].id }),
    ])
  })

  it('streams a restricted turn, persists a reviewable proposal and records standalone usage', async () => {
    const draft = createDefaultMaestroConfig()
    const proposed = cloneMaestroConfig(draft)
    proposed.strategy = 'best-quality'
    proposed.pool[0].candidates = [{ providerId: 'provider-1', modelId: 'fable', effort: 'high' }]
    const execute = vi.fn(
      async (args: { tools?: ToolSet; onTextUpdate?: (update: { kind: 'append'; text: string }) => void }) => {
        expect(Object.keys(args.tools ?? {}).sort()).toEqual([
          'propose_maestro_config',
          'read_available_model_catalog',
          'read_maestro_draft',
        ])
        expect('bash' in (args.tools ?? {})).toBe(false)
        args.onTextUpdate?.({ kind: 'append', text: 'Preparing proposal' })
        await args.tools!.propose_maestro_config.execute!({ summary: 'Maximum quality Pool', config: proposed }, {
          toolCallId: 'proposal',
          messages: [],
          abortSignal: new AbortController().signal,
        } as never)
        return {
          text: 'Review the proposal below.',
          model: { providerId: 'provider-1', modelId: 'fable' },
          usage: { input: 10, output: 4, cacheRead: 2, cacheCreate: 1, totalInput: 13 },
        }
      }
    ) as unknown as typeof executeSubagent
    let nextId = 0
    const service = new MaestroConfiguratorService({
      execute,
      catalog: async () => catalog,
      resolveProfile: resolvedProfile,
      id: () => `id-${++nextId}`,
      now: () => 100 + nextId,
      cwd: () => '/tmp',
    })
    await expect(
      service.setProfile({ providerId: 'provider-1', modelId: 'fable', effort: 'high' })
    ).resolves.toMatchObject({ ok: true })

    const events: Array<{ kind: string; [key: string]: unknown }> = []
    let complete!: () => void
    const completed = new Promise<void>((resolve) => {
      complete = resolve
    })
    const sent = await service.send(
      { text: 'Use maximum quality', draft, baseHash: hashMaestroConfig(draft) },
      (event) => {
        events.push(event)
        if (event.kind === 'completed') complete()
      }
    )
    expect(sent).toMatchObject({ ok: true })
    await completed

    const state = await service.state()
    expect(state.thread.messages).toHaveLength(2)
    expect(state.thread.messages[1]).toMatchObject({
      role: 'assistant',
      proposal: {
        baseHash: hashMaestroConfig(draft),
        summary: 'Maximum quality Pool',
        config: { strategy: 'best-quality' },
      },
    })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'text-update' }),
        expect.objectContaining({ kind: 'completed' }),
      ])
    )
    expect(getDb().prepare('SELECT conversation_id, provider_id, model_id FROM chat_usage_ledger').get()).toEqual({
      conversation_id: null,
      provider_id: 'provider-1',
      model_id: 'fable',
    })
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 0 })
    expect(aggregateChatUsage()).toMatchObject({
      totalTurns: 1,
      perModel: [expect.objectContaining({ providerId: 'provider-1', modelId: 'fable', turns: 1 })],
    })
  })

  it('rejects stale drafts and concurrent turns, then suppresses a late completion after reset', async () => {
    const draft = createDefaultMaestroConfig()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi.fn(async () => {
      await gate
      return { text: 'late', model: { providerId: 'provider-1', modelId: 'fable' } }
    }) as unknown as typeof executeSubagent
    const service = new MaestroConfiguratorService({
      execute,
      catalog: async () => catalog,
      resolveProfile: resolvedProfile,
      id: () => Math.random().toString(36),
      cwd: () => '/tmp',
    })
    await service.setProfile({ providerId: 'provider-1', modelId: 'fable', effort: 'high' })
    await expect(service.send({ text: 'stale', draft, baseHash: 'wrong' }, vi.fn())).resolves.toEqual({
      ok: false,
      error: 'maestro-configurator-stale-draft',
    })
    const emit = vi.fn()
    const first = await service.send({ text: 'first', draft, baseHash: hashMaestroConfig(draft) }, emit)
    expect(first.ok).toBe(true)
    await expect(service.send({ text: 'second', draft, baseHash: hashMaestroConfig(draft) }, emit)).resolves.toEqual({
      ok: false,
      error: 'maestro-configurator-busy',
    })
    service.reset(emit)
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(emit).toHaveBeenCalledWith({ kind: 'reset' })
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'completed' }))
  })

  it('cancels the active runtime, emits cancelled and still accounts measured usage', async () => {
    const draft = createDefaultMaestroConfig()
    const execute = vi.fn(
      async (args: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          const abort = () =>
            reject(
              Object.assign(new Error('aborted'), {
                subagentUsage: { input: 5, output: 1, cacheRead: 0, cacheCreate: 0, totalInput: 5 },
                subagentModel: { providerId: 'provider-1', modelId: 'fable' },
              })
            )
          if (args.signal.aborted) abort()
          else args.signal.addEventListener('abort', abort, { once: true })
        })
    ) as unknown as typeof executeSubagent
    const service = new MaestroConfiguratorService({
      execute,
      catalog: async () => catalog,
      resolveProfile: resolvedProfile,
      id: () => Math.random().toString(36),
      cwd: () => '/tmp',
    })
    await service.setProfile({ providerId: 'provider-1', modelId: 'fable', effort: 'high' })
    let cancelled!: () => void
    const event = new Promise<void>((resolve) => {
      cancelled = resolve
    })
    const sent = await service.send(
      { text: 'cancel me', draft, baseHash: hashMaestroConfig(draft) },
      (value) => value.kind === 'cancelled' && cancelled()
    )
    expect(sent.ok).toBe(true)
    expect(service.cancel(sent.ok ? sent.turnId : undefined)).toBe(true)
    await event
    expect(aggregateChatUsage()).toMatchObject({ totalTurns: 1 })
  })
})
