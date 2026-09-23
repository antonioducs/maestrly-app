import { describe, expect, it, vi } from 'vitest'
import {
  resolveConversationDispatchSettings,
  sameDispatchSettings,
  type ConversationDispatchSettingsDeps,
  type DispatchModelCapability,
} from '../../src/main/conversation-dispatch-settings'
import type { ConversationDispatchSettings } from '../../src/shared/conversation-dispatch'

const SOURCE: ConversationDispatchSettings = {
  providerId: 'codex',
  modelId: 'gpt-5.6',
  reasoning: 'high',
  fastMode: true,
}

const CAPABILITIES: Record<string, DispatchModelCapability> = {
  'codex\0gpt-5.6': {
    available: true,
    reasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    nativeUltraMode: false,
    fastMode: true,
  },
  'claude\0opus': {
    available: true,
    reasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    nativeUltraMode: false,
    fastMode: false,
  },
  'claude-2\0opus': {
    available: true,
    reasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    nativeUltraMode: false,
    fastMode: false,
  },
  'byok\0plain': { available: true, reasoning: false, reasoningEfforts: [], nativeUltraMode: false, fastMode: false },
  'byok\0unknown-efforts': {
    available: true,
    reasoning: true,
    reasoningEfforts: [],
    nativeUltraMode: false,
    fastMode: false,
  },
}

function deps(overrides: Partial<ConversationDispatchSettingsDeps> = {}): ConversationDispatchSettingsDeps {
  return {
    sourceSettings: vi.fn(() => SOURCE),
    listModels: vi.fn(async () => [
      { providerId: 'codex', providerLabel: 'ChatGPT', modelId: 'gpt-5.6', reasoningEfforts: [], fastMode: true },
      { providerId: 'claude', providerLabel: 'Claude (work)', modelId: 'opus', reasoningEfforts: [], fastMode: false },
      { providerId: 'claude-2', providerLabel: 'Claude (personal)', modelId: 'opus', reasoningEfforts: [], fastMode: false },
      { providerId: 'byok', providerLabel: 'OpenRouter', modelId: 'plain', reasoningEfforts: [], fastMode: false },
    ]),
    describeModel: vi.fn(
      async (providerId: string, modelId: string) =>
        CAPABILITIES[`${providerId}\0${modelId}`] ?? {
          available: false,
          reasoning: false,
          reasoningEfforts: [],
          nativeUltraMode: false,
          fastMode: false,
        }
    ),
    validateSelection: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  }
}

describe('resolveConversationDispatchSettings', () => {
  it('inherits every omitted setting from the source and reports it', async () => {
    const result = await resolveConversationDispatchSettings('source', {}, deps())
    expect(result).toEqual({ ok: true, settings: SOURCE, inherited: ['model', 'reasoning', 'fastMode'] })
  })

  it('applies explicit supported effort and Fast, including explicitly disabled Fast', async () => {
    const d = deps()
    const result = await resolveConversationDispatchSettings(
      'source',
      { providerId: 'codex', modelId: 'gpt-5.6', reasoning: 'xhigh', fastMode: false },
      d
    )
    expect(result).toEqual({
      ok: true,
      settings: { providerId: 'codex', modelId: 'gpt-5.6', reasoning: 'xhigh', fastMode: false },
      inherited: [],
    })
    expect(d.validateSelection).toHaveBeenCalledWith('source', {
      providerId: 'codex',
      modelId: 'gpt-5.6',
      reasoning: 'xhigh',
      fastMode: false,
    })
  })

  it('rejects an explicitly requested unsupported effort instead of downgrading it', async () => {
    const result = await resolveConversationDispatchSettings(
      'source',
      { providerId: 'claude', modelId: 'opus', reasoning: 'xhigh' },
      deps()
    )
    expect(result).toMatchObject({ ok: false, error: 'reasoning-unsupported' })
    if (!result.ok) expect(result.message).toContain('low, medium, high, max')
  })

  it('rejects explicit Fast on a model without Fast support', async () => {
    const result = await resolveConversationDispatchSettings(
      'source',
      { providerId: 'claude', modelId: 'opus', fastMode: true },
      deps()
    )
    expect(result).toMatchObject({ ok: false, error: 'fast-mode-unsupported' })
  })

  it('resets incompatible inherited settings to provider defaults and says so', async () => {
    const result = await resolveConversationDispatchSettings('source', { providerId: 'byok', modelId: 'plain' }, deps())
    expect(result).toEqual({
      ok: true,
      settings: { providerId: 'byok', modelId: 'plain', reasoning: 'off', fastMode: false },
      inherited: ['reasoning (reset to default: "high" is unsupported)', 'fastMode (off: unsupported by this model)'],
    })
  })

  it('never authorizes an explicit effort when the model does not advertise its levels', async () => {
    const result = await resolveConversationDispatchSettings(
      'source',
      { providerId: 'byok', modelId: 'unknown-efforts', reasoning: 'high' },
      deps()
    )
    expect(result).toMatchObject({ ok: false, error: 'reasoning-unsupported' })
  })

  it('resolves a model named without provider only when it is unambiguous', async () => {
    await expect(resolveConversationDispatchSettings('source', { modelId: 'plain' }, deps())).resolves.toMatchObject({
      ok: true,
      settings: { providerId: 'byok', modelId: 'plain' },
    })
    const ambiguous = await resolveConversationDispatchSettings('source', { modelId: 'opus' }, deps())
    expect(ambiguous).toMatchObject({ ok: false, error: 'model-ambiguous' })
    if (!ambiguous.ok) expect(ambiguous.message).toMatch(/Claude \(work\) = claude; Claude \(personal\) = claude-2/)
  })

  it('reports unavailable models and missing authentication', async () => {
    await expect(
      resolveConversationDispatchSettings('source', { providerId: 'codex', modelId: 'gone' }, deps())
    ).resolves.toMatchObject({ ok: false, error: 'model-unavailable' })
    await expect(
      resolveConversationDispatchSettings(
        'source',
        { providerId: 'codex', modelId: 'gpt-5.6' },
        deps({ validateSelection: vi.fn(async () => ({ ok: false as const, error: 'no-key' })) })
      )
    ).resolves.toMatchObject({ ok: false, error: 'provider-unavailable' })
  })

  it('requires a model when only another provider is named, and a source when nothing is named', async () => {
    await expect(resolveConversationDispatchSettings('source', { providerId: 'claude' }, deps())).resolves.toMatchObject({
      ok: false,
      error: 'model-required',
    })
    await expect(
      resolveConversationDispatchSettings('source', {}, deps({ sourceSettings: vi.fn(() => null) }))
    ).resolves.toMatchObject({ ok: false, error: 'no-source-model' })
  })

  it('maps Ultra to Maestrly Ultra and accepts default aliases', async () => {
    await expect(
      resolveConversationDispatchSettings('source', { providerId: 'claude', modelId: 'opus', reasoning: 'ultra' }, deps())
    ).resolves.toMatchObject({ ok: true, settings: { reasoning: 'maestrly-ultra' } })
    await expect(
      resolveConversationDispatchSettings('source', { providerId: 'claude', modelId: 'opus', reasoning: 'Default' }, deps())
    ).resolves.toMatchObject({ ok: true, settings: { reasoning: 'off' } })
  })
})

describe('sameDispatchSettings', () => {
  it('compares the effective selection exactly', () => {
    expect(sameDispatchSettings(SOURCE, { ...SOURCE })).toBe(true)
    expect(sameDispatchSettings({ ...SOURCE, fastMode: false }, SOURCE)).toBe(false)
    expect(sameDispatchSettings(null, SOURCE)).toBe(false)
  })
})
