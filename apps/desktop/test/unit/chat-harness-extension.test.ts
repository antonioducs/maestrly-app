import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHarnessSources, validateHarnessCatalog } from '../../build/harness-catalog'
import { codexAdapterCapabilities, resolveCodexThreadPolicy } from '../../src/main/chat/harness/adapters/codex'
import { createHarnessPostToolUseHooks } from '../../src/main/chat/harness/adapters/claude'
import { compareHarnessCompatibility, createHarnessSnapshot } from '../../src/main/chat/harness/compatibility'
import { harnessSubagentPrompt, buildMaestrlyBasePrompt } from '../../src/main/chat/harness/host-contracts'
import { serializableReasoningEffort } from '../../src/main/chat/harness/policies'
import { createHarnessRegistry } from '../../src/main/chat/harness/registry'
import { resolveHarness } from '../../src/main/chat/harness/resolver'
import type { HarnessRegistry, ResolveHarnessInput } from '../../src/main/chat/harness/types'
import { routeHarnessComposerSubmit } from '../../src/renderer/components/chat/harness-turn-controls'
import { parseHarnessSnapshot } from '../../src/shared/harness'

/**
 * End-to-end proof of the extension contract: a model that reuses existing strategies is added by
 * creating one folder. Nothing in production code names this model.
 */
const MODEL = 'acme-orbit-2'
const PROFILES = fileURLToPath(new URL('../../src/main/chat/harness/profiles', import.meta.url))
const DOC = fileURLToPath(new URL('../../../../docs/harness-profiles.md', import.meta.url))
const created: string[] = []

/** The example documented in docs/harness-profiles.md, validated here so the docs cannot drift. */
function documentedExample(): { config: string; prompt: string; hook: string } {
  const doc = readFileSync(DOC, 'utf8')
  const config = /<!-- example:config -->\s*```json\n([\s\S]*?)```/.exec(doc)?.[1]
  const prompt = /<!-- example:prompt -->\s*```markdown\n([\s\S]*?)```/.exec(doc)?.[1]
  const hook = /<!-- example:hook -->\s*```markdown\n([\s\S]*?)```/.exec(doc)?.[1]
  if (!config || !prompt || !hook) throw new Error('docs/harness-profiles.md lost its validated example blocks')
  return { config, prompt, hook }
}

function catalogWith(files: Record<string, string> | null): string {
  const root = mkdtempSync(join(tmpdir(), 'maestrly-extension-'))
  created.push(root)
  cpSync(join(PROFILES, 'default'), join(root, 'default'), { recursive: true })
  if (files) {
    mkdirSync(join(root, MODEL))
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, MODEL, name), body)
  }
  return root
}

function resolve(registry: HarnessRegistry, input: Partial<ResolveHarnessInput> = {}) {
  const result = resolveHarness({ providerKind: 'codex-subscription', requestedModelId: MODEL, ...input }, registry)
  if (!result.ok) throw new Error(result.reason)
  return result.harness
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('adding a model is a folder', () => {
  it('flows through scanner, schema, resolver, prompts, options, snapshot and interface', () => {
    const { config, prompt, hook } = documentedExample()
    const root = catalogWith({ 'config.json': config, 'prompt.md': prompt, 'read-batching.md': hook })
    const registry = validateHarnessCatalog(root)
    const facts = { requestUserInputAsyncAvailable: true }
    const harness = resolve(registry, { adapterCapabilities: codexAdapterCapabilities(facts) })

    expect(harness.profileId).toBe(MODEL)
    expect(harness.reason).toBe('matched-requested-model')

    // Prompt text comes from the folder, host contracts stay outside it.
    const base = buildMaestrlyBasePrompt({ harness, cwd: '/repo', appToolsEnabled: false, mode: 'ask', hasNotesTab: false })
    expect(base).toContain('Orbit works in small, verified steps.')
    expect(base).toContain('ASK MODE (restricted tools)')
    expect(harnessSubagentPrompt('CHILD', harness)).toContain('acme-orbit-2-v1 for acme-orbit-2')

    // Existing strategies are reused without a branch: steering and the read-batching hook.
    expect(harness.capabilities.steering).toBe(true)
    expect(createHarnessPostToolUseHooks(harness)).not.toBeNull()
    expect(serializableReasoningEffort(harness.reasoning, 'minimal')).toBeNull()
    expect(serializableReasoningEffort(harness.reasoning, 'high')).toBe('high')
    const policy = resolveCodexThreadPolicy(
      harness,
      { eligibleChatGptSession: true, ephemeral: false, reviewer: false, ...facts },
      'high'
    )
    expect(policy).toMatchObject({ nativeCompactionFirst: true, reasoningEffort: 'high' })

    // Persistence round-trips the new identity and compares contracts, with no store edit.
    const snapshot = parseHarnessSnapshot(JSON.parse(JSON.stringify(createHarnessSnapshot(harness))))
    expect(snapshot?.profileId).toBe(MODEL)
    expect(compareHarnessCompatibility(snapshot, harness).compatible).toBe(true)

    // The interface routes by the published capability, never by the model string.
    expect(
      routeHarnessComposerSubmit({
        streaming: true,
        midTurnSteering: harness.capabilities.steering,
        text: 'go on',
        attachmentCount: 0,
        agentMentionCount: 0,
        invokesSkill: false,
        maestro: false,
      })
    ).toBe('steer')
  })

  it('resolves a subagent on the new model with the same contract for the same input', () => {
    const { config, prompt, hook } = documentedExample()
    const registry = createHarnessRegistry(readHarnessSources(catalogWith({ 'config.json': config, 'prompt.md': prompt, 'read-batching.md': hook })))
    expect(resolve(registry).definitionHash).toBe(resolve(registry).definitionHash)
    expect(resolve(registry, { providerKind: 'claude-subscription' }).profileId).toBe(MODEL)
  })

  it('changes only the text when only the Markdown changes', () => {
    const { config, prompt, hook } = documentedExample()
    const before = resolve(validateHarnessCatalog(catalogWith({ 'config.json': config, 'prompt.md': prompt, 'read-batching.md': hook })))
    const after = resolve(
      validateHarnessCatalog(catalogWith({ 'config.json': config, 'prompt.md': `${prompt}\nAlways cite files.`, 'read-batching.md': hook }))
    )
    expect(after.prompts.styleAndWork).toContain('Always cite files.')
    expect(after.capabilities).toEqual(before.capabilities)
    expect(after.definitionHash).not.toBe(before.definitionHash)
  })

  it('changes only the policy when only the configuration changes', () => {
    const { config, prompt, hook } = documentedExample()
    const parsed = JSON.parse(config)
    parsed.bindings[1].overrides.capabilities.steering = false
    const before = resolve(validateHarnessCatalog(catalogWith({ 'config.json': config, 'prompt.md': prompt, 'read-batching.md': hook })), {
      adapterCapabilities: codexAdapterCapabilities({ requestUserInputAsyncAvailable: true }),
    })
    const after = resolve(
      validateHarnessCatalog(catalogWith({ 'config.json': JSON.stringify(parsed), 'prompt.md': prompt, 'read-batching.md': hook })),
      { adapterCapabilities: codexAdapterCapabilities({ requestUserInputAsyncAvailable: true }) }
    )
    expect(before.capabilities.steering).toBe(true)
    expect(after.capabilities.steering).toBe(false)
    expect(after.prompts.styleAndWork).toBe(before.prompts.styleAndWork)
  })

  it('restores the default when the folder is removed, and fails loudly when it is invalid', () => {
    const fallback = resolve(validateHarnessCatalog(catalogWith(null)))
    expect(fallback.profileId).toBe('default')
    expect(() => validateHarnessCatalog(catalogWith({ 'config.json': '{"schemaVersion": 1,' }))).toThrow(
      new RegExp(`\\[harness:${MODEL}\\] config\\.json: invalid JSON`)
    )
  })
})
