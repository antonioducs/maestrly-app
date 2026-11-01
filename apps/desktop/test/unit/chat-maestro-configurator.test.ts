import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'
import { closeDb, freshDb } from '../helpers/db'
import { cloneMaestroConfig, createDefaultMaestroConfig, type MaestroConfigV1 } from '../../src/shared/maestro'
import {
  hashMaestroConfig,
  prepareMaestroConfiguratorDraft,
  type MaestroConfiguratorCatalog,
  type MaestroSettingsDraftSession,
} from '../../src/shared/maestro-configurator'
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
  activeAccounts: [] as Array<{ id: string; name: string }>,
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
  listActiveAccountChatProviders: () => h.activeAccounts,
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
  h.activeAccounts = []
})
afterEach(closeDb)

const toolContext = (toolCallId: string) =>
  ({ toolCallId, messages: [], abortSignal: new AbortController().signal }) as never

type ExecuteArgs = { tools?: ToolSet; task: string }

function serviceWith(
  execute: (args: ExecuteArgs) => Promise<unknown>,
  dependencies: Partial<ConstructorParameters<typeof MaestroConfiguratorService>[0]> = {}
) {
  let nextId = 0
  return new MaestroConfiguratorService({
    execute: execute as unknown as typeof executeSubagent,
    catalog: async () => catalog,
    resolveProfile: resolvedProfile,
    id: () => `id-${++nextId}`,
    now: () => 100 + nextId,
    cwd: () => '/tmp',
    ...dependencies,
  })
}

/** Sends one message and resolves with every event once the turn ends. */
async function runTurn(
  service: MaestroConfiguratorService,
  input: Parameters<MaestroConfiguratorService['send']>[0]
): Promise<Array<{ kind: string; [key: string]: unknown }>> {
  const events: Array<{ kind: string; [key: string]: unknown }> = []
  let done!: () => void
  const finished = new Promise<void>((resolve) => {
    done = resolve
  })
  const sent = await service.send(input, (event) => {
    events.push(event)
    if (event.kind === 'completed' || event.kind === 'error' || event.kind === 'cancelled') done()
  })
  expect(sent).toMatchObject({ ok: true })
  await finished
  return events
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

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

  it('offers the active-account entry of an account pool, like the Pool editor does', async () => {
    h.activeAccounts = [{ id: 'provider-1@~active', name: 'Provider One — Active account' }]
    const value = await buildMaestroConfiguratorCatalog(1)
    expect(value.providers.map((provider) => provider.id)).toEqual(['provider-1', 'provider-1@~active'])
    expect(h.providerStatus).toHaveBeenCalledWith('provider-1@~active')
  })

  it('accepts a draft with unfinished candidate rows and normalized fields', async () => {
    const draft = createDefaultMaestroConfig()
    draft.pool[0].candidates = [{ providerId: 'provider-1', modelId: '', effort: '' }]
    draft.pool[1].label = 'Frontend '
    const prepared = prepareMaestroConfiguratorDraft(draft)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const service = serviceWith(async () => ({ text: 'ok', model: { providerId: 'provider-1', modelId: 'fable' } }))
    await service.setProfile({ providerId: 'provider-1', modelId: 'fable', effort: 'high' })
    await runTurn(service, { text: 'hi', draft, baseHash: prepared.value.baseHash })
  })

  it('reads the editor state live: open strategy, unsaved changes and unfinished rows', async () => {
    const saved = createDefaultMaestroConfig()
    let session: MaestroSettingsDraftSession = {
      profileId: 'global',
      profileName: '',
      draft: cloneMaestroConfig(saved),
      orchestrator: null,
      savedHash: hashMaestroConfig(saved),
    }
    let liveHash = ''
    const service = serviceWith(
      async (args) => {
        // The user keeps editing after sending: the tool must report the edit, not the sent draft.
        const edited = cloneMaestroConfig(saved)
        edited.strategy = 'fast'
        edited.pool[0].candidates = [{ providerId: 'provider-1', modelId: '', effort: '' }]
        session = { ...session, draft: edited }
        const read = (await args.tools!.read_maestro_draft.execute!({}, toolContext('read'))) as {
          baseHash: string
          config: MaestroConfigV1
        }
        expect(read).toMatchObject({
          config: { strategy: 'fast' },
          editing: { strategyId: 'global', kind: 'global', readOnly: false, unsavedChanges: 1 },
          unfinishedCandidateRows: [{ resourceId: 'explorer', index: 0 }],
        })
        liveHash = read.baseHash
        const proposed = cloneMaestroConfig(read.config)
        proposed.pool[1].candidates = [{ providerId: 'provider-1', modelId: 'terra', effort: 'high' }]
        await expect(
          args.tools!.propose_maestro_config.execute!(
            { summary: 'Frontend on Terra', config: proposed },
            toolContext('p')
          )
        ).resolves.toMatchObject({ ok: true, changes: 1, notes: [expect.stringContaining('unfinished')] })
        return { text: 'Proposed.', model: { providerId: 'provider-1', modelId: 'fable' } }
      },
      {
        liveDraft: () => session,
        strategyProfiles: () => [
          { id: 'global', name: 'Global default', source: 'global', config: saved, orchestrator: null },
        ],
      }
    )
    await service.setProfile({ providerId: 'provider-1', modelId: 'fable', effort: 'high' })
    await runTurn(service, { text: 'Put Terra on frontend', draft: saved, baseHash: hashMaestroConfig(saved) })
    const proposal = (await service.state()).thread.messages[1].proposal
    // The proposal is based on the draft as edited, so it is not stale for the editor.
    expect(proposal?.baseHash).toBe(liveHash)
    expect(liveHash).not.toBe(hashMaestroConfig(saved))
  })

  it('warns that a built-in strategy cannot take a proposal', async () => {
    const saved = createDefaultMaestroConfig()
    const builtin = { ...cloneMaestroConfig(saved), strategy: 'fast' as const }
    const service = serviceWith(
      async (args) => {
        const proposed = cloneMaestroConfig(builtin)
        proposed.pool[0].candidates = [{ providerId: 'provider-1', modelId: 'terra', effort: 'high' }]
        await expect(args.tools!.read_maestro_draft.execute!({}, toolContext('read'))).resolves.toMatchObject({
          editing: { kind: 'builtin', readOnly: true, unsavedChanges: 0 },
        })
        await expect(
          args.tools!.propose_maestro_config.execute!({ summary: 'x', config: proposed }, toolContext('p'))
        ).resolves.toMatchObject({ ok: true, notes: [expect.stringContaining('read-only built-in')] })
        return { text: 'ok', model: { providerId: 'provider-1', modelId: 'fable' } }
      },
      {
        liveDraft: () => ({
          profileId: 'builtin:fast',
          profileName: '',
          draft: builtin,
          orchestrator: null,
          savedHash: hashMaestroConfig(builtin),
        }),
        strategyProfiles: () => [
          { id: 'builtin:fast', name: 'Fast', source: 'builtin', config: builtin, orchestrator: null },
        ],
      }
    )
    await service.setProfile({ providerId: 'provider-1', modelId: 'fable', effort: 'high' })
    await runTurn(service, { text: 'Use Terra', draft: builtin, baseHash: hashMaestroConfig(builtin) })
  })

  it('records editor actions in the thread and tells the next turn whether a proposal was applied and saved', async () => {
    const draft = createDefaultMaestroConfig()
    const proposed = cloneMaestroConfig(draft)
    proposed.pool[0].candidates = [{ providerId: 'provider-1', modelId: 'fable', effort: 'high' }]
    const tasks: string[] = []
    const service = serviceWith(async (args) => {
      tasks.push(args.task)
      if (tasks.length === 1) {
        await args.tools!.propose_maestro_config.execute!(
          { summary: 'Fable explorer', config: proposed },
          toolContext('p')
        )
      }
      return { text: 'ok', model: { providerId: 'provider-1', modelId: 'fable' } }
    })
    await service.setProfile({ providerId: 'provider-1', modelId: 'fable', effort: 'high' })
    // Nothing to tell an empty thread.
    expect(service.recordEvent({ kind: 'saved', target: 'global', profileName: 'Global default' })).toBeNull()
    await runTurn(service, { text: 'Fable for exploring', draft, baseHash: hashMaestroConfig(draft) })
    const proposalId = (await service.state()).thread.messages[1].proposal!.id
    expect(tasks[0]).not.toContain('Event:')

    expect(service.recordEvent({ kind: 'proposal-applied', proposalId: 'unknown' })).toBeNull()
    expect(service.recordEvent({ kind: 'proposal-applied', proposalId })).toMatchObject({
      role: 'event',
      event: { kind: 'proposal-applied', proposalId },
    })
    expect(service.recordEvent({ kind: 'proposal-applied', proposalId })).toBeNull()
    expect(service.recordEvent({ kind: 'saved', target: 'global', profileName: 'Global default' })).not.toBeNull()
    expect(service.recordEvent({ kind: 'saved', target: 'nowhere' })).toBeNull()

    await runTurn(service, { text: 'And now?', draft: proposed, baseHash: hashMaestroConfig(proposed) })
    expect(tasks[1]).toContain(`[Proposal ${proposalId}, applied to the draft, then saved: Fable explorer]`)
    expect(tasks[1]).toContain(`Event: The user applied proposal ${proposalId} to the draft. It is not saved yet.`)
    expect(tasks[1]).toContain('Event: The user saved the draft as the Global default.')
    expect(tasks[1]).not.toContain('# Latest proposal (not applied)')
  })

  it('tells the next turn which parts of a proposal were left out, and which proposals were dismissed', async () => {
    const draft = createDefaultMaestroConfig()
    const first = cloneMaestroConfig(draft)
    first.strategy = 'fast'
    first.pool[0].candidates = [{ providerId: 'provider-1', modelId: 'fable', effort: 'high' }]
    first.pool[4].candidates = [{ providerId: 'provider-1', modelId: 'terra', effort: 'high' }]
    const second = cloneMaestroConfig(draft)
    second.pool[1].candidates = [{ providerId: 'provider-1', modelId: 'terra', effort: 'high' }]
    const tasks: string[] = []
    const service = serviceWith(async (args) => {
      tasks.push(args.task)
      const config = tasks.length === 1 ? first : tasks.length === 2 ? second : null
      if (config) {
        await args.tools!.propose_maestro_config.execute!(
          { summary: `Proposal ${tasks.length}`, config },
          toolContext(`p${tasks.length}`)
        )
      }
      return { text: 'ok', model: { providerId: 'provider-1', modelId: 'fable' } }
    })
    await service.setProfile({ providerId: 'provider-1', modelId: 'fable', effort: 'high' })
    await runTurn(service, { text: 'Faster', draft, baseHash: hashMaestroConfig(draft) })
    const firstId = (await service.state()).thread.messages[1].proposal!.id
    expect(
      service.recordEvent({ kind: 'proposal-applied', proposalId: firstId, skipped: ['strategy', 'resource:reviewer'] })
    ).toMatchObject({
      text: `The user applied proposal ${firstId} to the draft except the strategy change, the changes to resource "reviewer", which they left as they were. It is not saved yet.`,
    })
    const applied = cloneMaestroConfig(draft)
    applied.pool[0].candidates = first.pool[0].candidates
    await runTurn(service, { text: 'Now the frontend', draft: applied, baseHash: hashMaestroConfig(applied) })
    const secondId = (await service.state()).thread.messages.find(
      (message) => message.proposal && message.proposal.id !== firstId
    )!.proposal!.id
    expect(service.recordEvent({ kind: 'proposal-dismissed', proposalId: 'unknown' })).toBeNull()
    expect(service.recordEvent({ kind: 'proposal-dismissed', proposalId: secondId })).toMatchObject({
      text: `The user dismissed proposal ${secondId} without applying any of it.`,
    })

    await runTurn(service, { text: 'Why?', draft: applied, baseHash: hashMaestroConfig(applied) })
    expect(tasks[2]).toContain(
      `[Proposal ${firstId}, applied to the draft except the strategy change, the changes to resource "reviewer": Proposal 1]`
    )
    expect(tasks[2]).toContain(`[Proposal ${secondId}, dismissed by the user: Proposal 2]`)
    // A dismissed proposal is not offered again as the one still waiting.
    expect(tasks[2]).not.toContain('# Latest proposal (not applied)')
  })

  it('transcribes attached images with the assistant model before the turn and keeps the text', async () => {
    const draft = createDefaultMaestroConfig()
    const describeImage = vi.fn(
      async ({ interpreter }: { interpreter: { modelId: string } }) => `Pool screenshot read by ${interpreter.modelId}`
    )
    let task = ''
    const service = serviceWith(
      async (args) => {
        task = args.task
        return { text: 'I see six roles.', model: { providerId: 'provider-1', modelId: 'fable' } }
      },
      { describeImage, imageInterpreter: async () => null }
    )
    await service.setProfile({ providerId: 'provider-1', modelId: 'fable', effort: 'high' })
    // The declared type is not trusted: the bytes are a PNG.
    const events = await runTurn(service, {
      text: '',
      draft,
      baseHash: hashMaestroConfig(draft),
      images: [{ name: 'pool.png', mediaType: 'image/jpeg', bytes: PNG }],
    })
    expect(describeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        interpreter: { providerId: 'provider-1', modelId: 'fable', effort: 'high' },
        image: expect.objectContaining({ name: 'pool.png', mediaType: 'image/png' }),
      })
    )
    expect(task).toContain('# Attached images')
    expect(task).toContain('Pool screenshot read by fable')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'progress', message: 'Reading image 1 of 1…' }),
        expect.objectContaining({
          kind: 'message',
          message: expect.objectContaining({ images: [expect.objectContaining({ description: expect.any(String) })] }),
        }),
      ])
    )
    const user = (await service.state()).thread.messages[0]
    expect(user.images).toEqual([
      expect.objectContaining({
        name: 'pool.png',
        description: 'Pool screenshot read by fable',
        descriptionModel: 'Provider One / fable',
      }),
    ])
    expect(JSON.stringify(user)).not.toContain('"bytes"')
  })

  it('falls back to the image interpreter and refuses images nobody can read or that are not images', async () => {
    const blind: MaestroConfiguratorCatalog = {
      ...catalog,
      providers: [
        {
          ...catalog.providers[0],
          models: catalog.providers[0].models.map((model) => ({ ...model, vision: false })),
        },
      ],
    }
    const draft = createDefaultMaestroConfig()
    const baseHash = hashMaestroConfig(draft)
    const execute = async () => ({ text: 'ok', model: { providerId: 'provider-1', modelId: 'fable' } })
    const withoutInterpreter = serviceWith(execute, {
      catalog: async () => blind,
      describeImage: vi.fn(async () => 'never'),
      imageInterpreter: async () => null,
    })
    await withoutInterpreter.setProfile({ providerId: 'provider-1', modelId: 'fable', effort: 'high' })
    const image = { name: 'pool.png', mediaType: 'image/png', bytes: PNG }
    await expect(withoutInterpreter.send({ text: 'see', draft, baseHash, images: [image] }, vi.fn())).resolves.toEqual({
      ok: false,
      error: 'maestro-configurator-no-vision',
    })
    await expect(
      withoutInterpreter.send(
        { text: 'see', draft, baseHash, images: [{ ...image, bytes: new TextEncoder().encode('not an image') }] },
        vi.fn()
      )
    ).resolves.toEqual({ ok: false, error: 'maestro-configurator-invalid-image' })

    const describeImage = vi.fn(async () => 'Read by the interpreter')
    const withInterpreter = serviceWith(execute, {
      catalog: async () => blind,
      describeImage,
      imageInterpreter: async () => ({ providerId: 'vision', modelId: 'eye' }),
    })
    await withInterpreter.setProfile({ providerId: 'provider-1', modelId: 'fable', effort: 'high' })
    await runTurn(withInterpreter, { text: 'see', draft, baseHash, images: [image] })
    expect(describeImage).toHaveBeenCalledTimes(1)
    expect(describeImage).toHaveBeenCalledWith(
      expect.objectContaining({ interpreter: { providerId: 'vision', modelId: 'eye' } })
    )
  })
})
