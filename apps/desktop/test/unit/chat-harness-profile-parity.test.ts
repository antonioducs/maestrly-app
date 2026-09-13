import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { harnessRegistry } from '../../src/main/chat/harness/catalog'
import { resolveChatHarness, resolveChatHarnessExecution } from '../../src/main/chat/harness/execution'
import { resolveHarness } from '../../src/main/chat/harness/resolver'
import { serializableReasoningEffort } from '../../src/main/chat/harness/policies'
import { resolveCodexThreadPolicy, codexAdapterCapabilities } from '../../src/main/chat/harness/adapters/codex'
import { resolveGitHubCopilotHarness } from '../../src/main/chat/harness/adapters/copilot'
import { buildHarnessDeveloperInstructions, buildHarnessPrompt } from '../../src/main/chat/harness/prompt-builder'
import {
  harnessCompactionSystem,
  harnessEnvironmentContext,
  harnessSubagentPrompt,
  harnessUltraGuidance,
  harnessBehaviorHeader,
} from '../../src/main/chat/harness/host-contracts'
import { withEnvironmentOnLastUserMessage } from '../../src/main/chat/harness/strategies/environment'
import type { ChatProviderKind } from '../../src/shared/chat'
import type { ChatBehavior } from '../../src/shared/conversation-experience'

/** Every assertion here compares the declarative catalog against the pre-refactor baseline fixtures. */
const OFFICIAL = 'https://api.openai.com/v1'
const GATEWAY = 'https://gateway.example.com/v1'
const MODES: ChatBehavior[] = ['agent', 'ask', 'plan', 'design', 'maestro']

function fixture(name: string): any {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/harness-baseline/${name}.json`, import.meta.url)), 'utf8')
  )
}

const registry = harnessRegistry()
const harnessFor = (modelId: string, providerKind: ChatProviderKind = 'claude-subscription', extra = {}) => {
  const resolution = resolveHarness({ providerKind, requestedModelId: modelId, ...extra }, registry)
  if (!resolution.ok) throw new Error(resolution.reason)
  return resolution.harness
}

describe('harness parity: transport resolution', () => {
  it('reproduces the recorded baseline for every transport/model pair', () => {
    const cases: Array<{ name: string; kind: ChatProviderKind; modelId: string; baseURL?: string }> = [
      { name: 'responses/astra/official', kind: 'openai-responses', modelId: 'gpt-6-astra', baseURL: OFFICIAL },
      { name: 'responses/astra/gateway', kind: 'openai-responses', modelId: 'gpt-6-astra', baseURL: GATEWAY },
      { name: 'responses/astra/uppercase', kind: 'openai-responses', modelId: 'GPT-6-Astra', baseURL: OFFICIAL },
      { name: 'responses/sol/official', kind: 'openai-responses', modelId: 'gpt-5.6-sol', baseURL: OFFICIAL },
      { name: 'responses/sol/gateway', kind: 'openai-responses', modelId: 'gpt-5.6-sol', baseURL: GATEWAY },
      { name: 'responses/sol-snapshot', kind: 'openai-responses', modelId: 'gpt-5.6-sol-2026-01-01', baseURL: OFFICIAL },
      { name: 'responses/sol-finetune', kind: 'openai-responses', modelId: 'ft:gpt-5.6-sol', baseURL: OFFICIAL },
      { name: 'responses/gpt-5.4', kind: 'openai-responses', modelId: 'gpt-5.4-terra', baseURL: OFFICIAL },
      { name: 'responses/gpt-5-codex', kind: 'openai-responses', modelId: 'gpt-5-codex', baseURL: OFFICIAL },
      { name: 'responses/unknown-model', kind: 'openai-responses', modelId: 'llama-4', baseURL: OFFICIAL },
      { name: 'codex/astra', kind: 'codex-subscription', modelId: 'gpt-6-astra' },
      { name: 'codex/sol', kind: 'codex-subscription', modelId: 'gpt-5.6-sol' },
      { name: 'codex/luna', kind: 'codex-subscription', modelId: 'gpt-5.6-luna' },
      { name: 'anthropic/fable', kind: 'claude-subscription', modelId: 'claude-fable-5-1' },
      { name: 'anthropic/opus', kind: 'claude-subscription', modelId: 'claude-opus-5' },
      { name: 'copilot/sol', kind: 'github-copilot-subscription', modelId: 'openai/gpt-5.6-sol' },
      { name: 'copilot/astra', kind: 'github-copilot-subscription', modelId: 'openai/gpt-6-astra' },
      { name: 'grok/generic', kind: 'grok-subscription', modelId: 'grok-5' },
    ]
    const recorded = cases.map((entry) => {
      const execution = resolveChatHarness(entry.kind, entry.modelId, entry.baseURL)
      return {
        name: entry.name,
        profile: execution.transport,
        modelHarnessProfileId: execution.modelHarnessProfileId,
        promptProfile: execution.promptProfile,
        capabilities: execution.capabilities,
      }
    })
    expect(recorded).toEqual(fixture('transport'))
  })

  it('keeps the feature flag closed per execution without touching a resolved contract', () => {
    const off = resolveChatHarness('openai-responses', 'gpt-6-astra', OFFICIAL, {
      flags: { 'chat.astraHarness': false },
    })
    const on = resolveChatHarness('openai-responses', 'gpt-6-astra', OFFICIAL, {
      flags: { 'chat.astraHarness': true },
    })
    expect(off.modelHarnessProfileId).toBe('openai-default-v1')
    expect(off.harness.reason).toBe('disabled')
    expect(on.modelHarnessProfileId).toBe('openai-gpt-6-astra-v1')
    expect(Object.isFrozen(on.harness)).toBe(true)
    expect(Object.isFrozen(on.harness.capabilities)).toBe(true)
  })

  it('reports why a profile was not applied', () => {
    expect(resolveChatHarness('openai-responses', 'gpt-6-astra', GATEWAY).harness.reason).toBe('unsupported-endpoint')
    expect(resolveChatHarness('anthropic', 'gpt-6-astra').harness.reason).toBe('unsupported-transport')
    expect(resolveChatHarness('anthropic', 'claude-sonnet-4').harness.reason).toBe('default')
  })

  it('distinguishes absent, empty and denied runtime metadata', () => {
    const adapter = codexAdapterCapabilities({ requestUserInputAsyncAvailable: true })
    const absent = resolveChatHarness('codex-subscription', 'gpt-6-astra', undefined, {
      adapterCapabilities: adapter,
    })
    const empty = resolveChatHarness('codex-subscription', 'gpt-6-astra', undefined, {
      adapterCapabilities: adapter,
      runtimeReasoningEfforts: [],
    })
    const denied = resolveChatHarness('codex-subscription', 'gpt-6-astra', undefined, {
      adapterCapabilities: adapter,
      runtimeCapabilities: { experimentalContext: false },
    })
    expect(absent.capabilities.serializableReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(empty.capabilities.serializableReasoningEfforts).toEqual([])
    expect(denied.harness.capabilities.experimentalContext).toBe(false)
  })

  it('never lets a permissive profile override an adapter that cannot execute a capability', () => {
    const execution = resolveChatHarness('codex-subscription', 'gpt-6-astra', undefined, {
      adapterCapabilities: codexAdapterCapabilities({ requestUserInputAsyncAvailable: false }),
    })
    expect(execution.harness.modelCapabilities.asyncTools).toBe(true)
    expect(execution.harness.capabilities.asyncTools).toBe(false)
  })
})

describe('harness parity: reasoning serialization', () => {
  it('reproduces the recorded baseline', () => {
    const astra = harnessFor('gpt-6-astra', 'codex-subscription').reasoning
    const fallback = harnessFor('anything-else', 'codex-subscription').reasoning
    const efforts = ['off', 'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'weird']
    const recorded = efforts.map((effort) => ({
      effort,
      astra: serializableReasoningEffort(astra, effort),
      default: serializableReasoningEffort(fallback, effort),
    }))
    expect(recorded).toEqual(fixture('reasoning'))
  })
})

describe('harness parity: behavioral profiles', () => {
  it('reproduces identity, flags and frozen semantics', () => {
    const baseline = fixture('behavior') as Array<{ input: Record<string, unknown>; reason: string; profile: { id: string; targetModelId: string; progressMode: string } | null }>
    for (const entry of baseline) {
      const flags: Record<string, boolean> = {}
      if (entry.input.fableEnabled === false) flags['chat.fable51Profile'] = false
      if (entry.input.opusEnabled === false) flags['chat.opus5Profile'] = false
      const resolution = resolveHarness(
        {
          providerKind: 'claude-subscription',
          requestedModelId: String(entry.input.requestedModelId),
          ...(entry.input.resolvedModelId !== undefined ? { resolvedModelId: String(entry.input.resolvedModelId) } : {}),
          ...(entry.input.frozen ? { frozen: true, frozenBehaviorProfileId: entry.input.frozenProfileId as string | null } : {}),
          flags,
        },
        registry
      )
      if (entry.reason === 'frozen-profile-mismatch') {
        expect(resolution.ok, JSON.stringify(entry.input)).toBe(false)
        continue
      }
      expect(resolution.ok, JSON.stringify(entry.input)).toBe(true)
      if (!resolution.ok) continue
      expect(resolution.harness.identity.behaviorProfileId, JSON.stringify(entry.input)).toBe(
        entry.profile?.id ?? null
      )
      if (entry.profile) {
        expect(resolution.harness.profileId).toBe(entry.profile.targetModelId)
        expect(resolution.harness.progress).toBe(entry.profile.progressMode)
      }
    }
  })

  it('reproduces the recorded prompt baseline', () => {
    const expected = fixture('behavior-prompt')
    const fable = harnessFor('claude-fable-5-1')
    const opus = harnessFor('claude-opus-5')
    const none = harnessFor('claude-sonnet-4')
    expect(harnessBehaviorHeader(fable)).toBe(expected.fableHeader)
    expect(harnessBehaviorHeader(opus)).toBe(expected.opusHeader)
    expect(fable.prompts.styleAndWork).toBe(expected.fableStyle)
    expect(opus.prompts.styleAndWork).toBe(expected.opusStyle)
    expect(harnessEnvironmentContext('OS: macOS.')).toBe(expected.environment)
    expect(harnessSubagentPrompt('LEGACY', fable)).toBe(expected.fableSubagent)
    expect(harnessSubagentPrompt('LEGACY', opus)).toBe(expected.opusSubagent)
    expect(harnessSubagentPrompt('LEGACY', none)).toBe(expected.nullSubagent)
    expect(harnessCompactionSystem('LEGACY', fable)).toBe(expected.fableCompaction)
    expect(harnessCompactionSystem('LEGACY', opus)).toBe(expected.opusCompaction)
    expect(harnessCompactionSystem('LEGACY', none)).toBe(expected.nullCompaction)
    for (const mode of MODES) expect(harnessUltraGuidance(opus, mode)).toBe(expected.opusUltra[mode])
    expect(harnessUltraGuidance(fable, 'agent')).toBeNull()
  })

  it('keeps the Opus environment on the last user message', () => {
    const opus = harnessFor('claude-opus-5')
    expect(opus.prompts.environment).toEqual({ placement: 'last-user-message', transient: true })
    expect(harnessFor('claude-fable-5-1').prompts.environment).toEqual({ placement: 'system', transient: true })
    expect(harnessFor('claude-sonnet-4').prompts.environment).toEqual({ placement: 'system', transient: false })
    expect(withEnvironmentOnLastUserMessage([{ role: 'user', content: 'hi' }], 'OS: macOS.')).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '# Current environment\nOS: macOS.' },
          { type: 'text', text: 'hi' },
        ],
      },
    ])
  })

  it('applies the behavioral axis on every transport that uses it', () => {
    for (const kind of ['claude-subscription', 'anthropic', 'github-copilot-subscription'] as ChatProviderKind[]) {
      expect(harnessFor('claude-fable-5-1', kind).identity.behaviorProfileId).toBe('maestrly-fable-5.1-v1')
    }
  })
})

describe('harness parity: Codex runtime policy', () => {
  it('reproduces the recorded baseline', () => {
    const baseline = fixture('codex-astra') as Array<{ name: string; profile: Record<string, any>; developer: string }>
    const base = {
      eligibleChatGptSession: true,
      ephemeral: false,
      reviewer: false,
      requestUserInputAsyncAvailable: true,
    }
    const inputs: Array<{ name: string; modelId: string; flags?: Record<string, boolean>; facts?: Partial<typeof base>; effort?: string }> = [
      { name: 'astra/full', modelId: 'gpt-6-astra' },
      { name: 'astra/ephemeral', modelId: 'gpt-6-astra', facts: { ephemeral: true } },
      { name: 'astra/reviewer', modelId: 'gpt-6-astra', facts: { reviewer: true } },
      { name: 'astra/ineligible', modelId: 'gpt-6-astra', facts: { eligibleChatGptSession: false } },
      { name: 'astra/no-async', modelId: 'gpt-6-astra', facts: { requestUserInputAsyncAvailable: false } },
      { name: 'astra/flag-off', modelId: 'gpt-6-astra', flags: { 'chat.astraHarness': false } },
      { name: 'astra/minimal-effort', modelId: 'gpt-6-astra', effort: 'minimal' },
      { name: 'sol', modelId: 'gpt-5.6-sol' },
    ]
    for (const entry of inputs) {
      const facts = { ...base, ...entry.facts }
      const execution = resolveChatHarness('codex-subscription', entry.modelId, undefined, {
        ...(entry.flags ? { flags: entry.flags } : {}),
        adapterCapabilities: codexAdapterCapabilities(facts),
      })
      const policy = resolveCodexThreadPolicy(execution.harness, facts, entry.effort ?? 'high')
      const expected = baseline.find((item) => item.name === entry.name)!
      expect({ name: entry.name, ...policy }, entry.name).toEqual({
        name: entry.name,
        promptVersion: expected.profile.promptVersion,
        personality: expected.profile.personality,
        nativeCompactionFirst: expected.profile.nativeCompactionFirst,
        experimentalContextEnabled: expected.profile.experimentalContextEnabled,
        asyncQuestionGuidance: expected.profile.asyncQuestionGuidance,
        reasoningEffort: expected.profile.reasoningEffort,
      })
      expect(
        buildHarnessDeveloperInstructions('BASE', execution.harness, { asyncTools: policy.asyncQuestionGuidance }),
        entry.name
      ).toBe(expected.developer)
      expect(execution.modelHarnessProfileId, entry.name).toBe(expected.profile.modelHarnessProfileId)
      expect(execution.harness.capabilities, entry.name).toEqual(
        Object.fromEntries(Object.entries(expected.profile.capabilities).filter(([key]) => key !== 'validReasoningEfforts'))
      )
      expect(execution.harness.reasoning.effectiveEfforts, entry.name).toEqual(
        expected.profile.capabilities.validReasoningEfforts
      )
    }
  })
})

describe('harness parity: Copilot family axis', () => {
  it('reproduces the recorded baseline', () => {
    const baseline = fixture('copilot') as Array<{ modelId: string; family: string; profile: string; promptProfile: string }>
    for (const entry of baseline) {
      const resolved = resolveGitHubCopilotHarness(entry.modelId, registry)
      expect(
        { family: resolved.family, profile: resolved.profile, promptProfile: resolved.promptProfile },
        entry.modelId
      ).toEqual({ family: entry.family, profile: entry.profile, promptProfile: entry.promptProfile })
    }
  })

  it('never lets the legacy Copilot key enable advanced policies', () => {
    const execution = resolveChatHarness('github-copilot-subscription', 'openai/gpt-6-astra')
    expect(execution.modelHarnessProfileId).toBe('openai-default-v1')
    expect(execution.harness.capabilities.steering).toBe(false)
  })
})

describe('harness parity: prompt layouts', () => {
  const input = {
    cwd: '/repo',
    appToolsEnabled: true,
    hasNotesTab: true,
    projectContext: 'PROJECT',
    skillsContext: 'SKILLS',
    agentsContext: 'AGENTS',
    envContext: 'OS: macOS.',
    ultraContext: 'ULTRA',
    nativeTools: { localShell: true, applyPatch: true },
  }

  it('reproduces the recorded Sol baseline', () => {
    const harness = resolveChatHarness('openai-responses', 'gpt-5.6-sol', OFFICIAL).harness
    expect(harness.prompts.layout).toBe('openai-codex-port')
    const recorded = (['agent', 'ask', 'plan', 'design'] as const).map((mode) => {
      const prompt = buildHarnessPrompt({ ...input, harness, mode })
      return {
        mode,
        instructions: prompt.instructions,
        stablePrefix: prompt.stablePrefix,
        volatileSuffix: prompt.volatileSuffix,
      }
    })
    expect(recorded).toEqual(fixture('openai-sol-prompt'))
    expect(harness.source?.commit).toBe('5bed6447998c754d154dbd796517310b8f04d4ce')
  })

  it('reproduces the recorded Astra baseline', () => {
    const harness = resolveChatHarness('openai-responses', 'gpt-6-astra', OFFICIAL).harness
    expect(harness.prompts.layout).toBe('openai-astra')
    const recorded = (['agent', 'ask', 'plan', 'design'] as const).map((mode) => {
      const prompt = buildHarnessPrompt({ ...input, harness, mode })
      return {
        mode,
        instructions: prompt.instructions,
        stablePrefix: prompt.stablePrefix,
        volatileSuffix: prompt.volatileSuffix,
      }
    })
    expect(recorded).toEqual(fixture('openai-astra-prompt'))
  })

  it('keeps host contracts out of the replaceable profile text', () => {
    const harness = harnessFor('claude-fable-5-1')
    const prompt = buildHarnessPrompt({ ...input, harness, mode: 'ask' })
    expect(prompt.layout).toBe('maestrly-base')
    expect(prompt.instructions).toContain('ASK MODE (restricted tools)')
    expect(prompt.instructions).toContain('# Behavioral profile')
    expect(prompt.instructions).toContain('# Using your tools')
    expect(prompt.transientContext).toBe('OS: macOS.')
    expect(buildHarnessPrompt({ ...input, harness: harnessFor('claude-sonnet-4'), mode: 'ask' }).transientContext).toBeNull()
  })
})

describe('harness parity: frozen executions', () => {
  it('keeps the transport axis of a legacy frozen selection without deducing a behavior', () => {
    const result = resolveChatHarnessExecution('codex-subscription', 'gpt-6-astra', undefined, {
      frozen: true,
      frozenBehaviorProfileId: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.execution.modelHarnessProfileId).toBe('openai-gpt-6-astra-v1')
    expect(result.execution.behaviorProfileId).toBeNull()
  })

  it('refuses a frozen behavioral identity that no longer matches', () => {
    const result = resolveChatHarnessExecution('claude-subscription', 'claude-fable-5-1', undefined, {
      frozen: true,
      frozenBehaviorProfileId: 'maestrly-unknown-v9',
    })
    expect(result).toEqual({ ok: false, reason: 'frozen-profile-mismatch' })
  })

  it('refuses a frozen snapshot whose contract changed', () => {
    const current = resolveChatHarness('claude-subscription', 'claude-opus-5').harness
    const result = resolveChatHarnessExecution('claude-subscription', 'claude-opus-5', undefined, {
      frozen: true,
      frozenBehaviorProfileId: 'maestrly-opus-5-v1',
      frozenSnapshot: {
        snapshotVersion: 1,
        profileId: current.profileId,
        profileVersion: current.profileVersion,
        contractId: current.contractId,
        compatibilityGroup: current.identity.compatibilityGroup,
        definitionHash: 'stale',
      },
    })
    expect(result).toEqual({ ok: false, reason: 'frozen-snapshot-mismatch' })
  })
})
