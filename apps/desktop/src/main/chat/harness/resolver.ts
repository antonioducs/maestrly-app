import { NO_HARNESS_CAPABILITIES, type HarnessCapabilities } from '../../../shared/harness'
import { harnessDefinitionHash } from './compatibility'
import { applyCapabilityClaims, intersectCapabilities, resolveReasoningPolicy } from './policies'
import { deepFreeze } from './registry'
import {
  DEFAULT_HARNESS_PROFILE_ID,
  type ChatBehavior,
  type HarnessBinding,
  type HarnessOverrides,
  type HarnessProfile,
  type HarnessRegistry,
  type HarnessResolution,
  type HarnessResolutionReason,
  type ResolveHarnessInput,
  type ResolvedHarness,
  type ResolvedHarnessHook,
  type ResolvedHarnessPrompts,
  type ResolvedUltraGuidance,
} from './types'

const DEFAULT_MAX_REMINDERS = 24

interface SelectedProfile {
  profile: HarnessProfile
  reason: HarnessResolutionReason
}

/**
 * Exact identity selection. The canonical id confirmed by the transport wins over the requested
 * alias; nothing is inferred from display names, families, prefixes or nearby versions.
 */
function selectProfile(registry: HarnessRegistry, input: ResolveHarnessInput): SelectedProfile {
  const fallback: SelectedProfile = { profile: registry.default, reason: 'default' }
  if (input.frozen && input.frozenBehaviorProfileId != null) {
    const frozen = registry
      .list()
      .find((profile) =>
        profile.definition.bindings.some(
          (binding) => binding.overrides.identity?.behaviorProfileId === input.frozenBehaviorProfileId
        )
      )
    // The frozen identity must still be the one the current model resolves to; never switch profiles.
    const current = selectByIdentity(registry, input)
    if (!frozen || current.profile !== frozen) return fallback
    return { profile: frozen, reason: 'frozen-profile' }
  }
  return selectByIdentity(registry, input)
}

function selectByIdentity(registry: HarnessRegistry, input: ResolveHarnessInput): SelectedProfile {
  const fallback: SelectedProfile = { profile: registry.default, reason: 'default' }
  // A confirmed canonical identity is authoritative: a non-matching one is never overridden by the alias.
  const resolved = input.resolvedModelId?.trim() ?? ''
  if (resolved) {
    const match = registry.match(resolved)
    return match ? { profile: match, reason: identityReason(match, resolved, 'matched-resolved-model') } : fallback
  }
  const requested = input.requestedModelId.trim()
  const match = requested ? registry.match(requested) : null
  return match ? { profile: match, reason: identityReason(match, requested, 'matched-requested-model') } : fallback
}

function identityReason(
  profile: HarnessProfile,
  modelId: string,
  matched: HarnessResolutionReason
): HarnessResolutionReason {
  const caseInsensitive = profile.definition.match?.caseInsensitive === true
  const normalize = (value: string): string => (caseInsensitive ? value.toLowerCase() : value)
  return normalize(modelId.trim()) === normalize(profile.folderId) ? matched : 'matched-alias'
}

function applicableBindings(profile: HarnessProfile, input: ResolveHarnessInput): HarnessBinding[] {
  const official = input.providerKind === 'openai-responses' && input.officialOpenAIEndpoint === true
  const ordered: HarnessBinding[] = []
  for (const binding of profile.definition.bindings) {
    const endpoint = binding.endpoint ?? 'any'
    if (binding.providerKind !== '*' && binding.providerKind !== input.providerKind) continue
    if (endpoint === 'official-openai' && !official) continue
    ordered.push(binding)
  }
  const rank = (binding: HarnessBinding): number => {
    const provider = binding.providerKind === '*' ? 0 : 2
    const endpoint = (binding.endpoint ?? 'any') === 'any' ? 0 : 1
    return provider + endpoint
  }
  return ordered.sort((a, b) => rank(a) - rank(b))
}

function mergeOverrides(base: HarnessOverrides, next: HarnessOverrides): HarnessOverrides {
  return {
    identity: { ...base.identity, ...next.identity },
    prompts: {
      ...base.prompts,
      ...next.prompts,
      ...(base.prompts?.environment || next.prompts?.environment
        ? { environment: { ...base.prompts?.environment, ...next.prompts?.environment } }
        : {}),
    },
    reasoning: { ...base.reasoning, ...next.reasoning },
    capabilities: { ...base.capabilities, ...next.capabilities },
    runtime: { ...base.runtime, ...next.runtime },
    ...(next.progress !== undefined ? { progress: next.progress } : base.progress !== undefined ? { progress: base.progress } : {}),
    ...(next.hooks !== undefined ? { hooks: next.hooks } : base.hooks !== undefined ? { hooks: base.hooks } : {}),
  }
}

/** Prompt-axis-only resolution keeps text, drops every policy the legacy key must not enable. */
function promptAxisOnly(overrides: HarnessOverrides): HarnessOverrides {
  return {
    prompts: overrides.prompts,
    identity: overrides.identity?.promptIdentity ? { promptIdentity: overrides.identity.promptIdentity } : {},
  }
}

/** Own folder first, then the default: inheritance never travels through a path in the JSON. */
function text(profile: HarnessProfile, fallback: HarnessProfile, ref: string | null | undefined): string | null {
  if (!ref) return null
  return profile.texts[ref] ?? fallback.texts[ref] ?? null
}

function resolveUltra(
  profile: HarnessProfile,
  fallback: HarnessProfile,
  overrides: HarnessOverrides
): ResolvedUltraGuidance | null {
  const refs = overrides.prompts?.ultra
  if (!refs) return null
  const base = text(profile, fallback, refs.base)
  if (base == null) return null
  const byMode = {} as Record<ChatBehavior, string>
  for (const [mode, ref] of Object.entries(refs.byMode) as [ChatBehavior, string][]) {
    byMode[mode] = text(profile, fallback, ref) ?? ''
  }
  return { base, byMode }
}

function resolveHooks(
  profile: HarnessProfile,
  fallback: HarnessProfile,
  overrides: HarnessOverrides
): ResolvedHarnessHook[] {
  return (overrides.hooks ?? []).flatMap((hook) => {
    const body = text(profile, fallback, hook.text)
    if (body == null) return []
    return [{ id: hook.id, text: body, maxReminders: Math.max(1, Math.floor(hook.maxReminders ?? DEFAULT_MAX_REMINDERS)) }]
  })
}

function resolvePrompts(
  profile: HarnessProfile,
  fallback: HarnessProfile,
  overrides: HarnessOverrides
): ResolvedHarnessPrompts {
  const prompts = overrides.prompts ?? {}
  return {
    layout: prompts.layout ?? 'maestrly-base',
    base: text(profile, fallback, prompts.base),
    styleAndWork: text(profile, fallback, prompts.styleAndWork),
    behaviorHeader: prompts.behaviorHeader === true,
    subagent: text(profile, fallback, prompts.subagent),
    compaction: text(profile, fallback, prompts.compaction),
    ultra: resolveUltra(profile, fallback, overrides),
    developerPrefix: prompts.developerPrefix
      ? {
          base: text(profile, fallback, prompts.developerPrefix.base) ?? '',
          asyncTools: text(profile, fallback, prompts.developerPrefix.asyncTools),
        }
      : null,
    environment: {
      placement: prompts.environment?.placement ?? 'system',
      transient: prompts.environment?.transient === true,
    },
  }
}

function contractIdOf(bindings: readonly HarnessBinding[], providerKind: string): string {
  const last = bindings[bindings.length - 1]
  return last ? `${last.providerKind}/${last.endpoint ?? 'any'}` : `${providerKind}/none`
}

/**
 * Single decision point for harness selection. Everything downstream consumes the returned
 * contract; no runner, store or view resolves behavior from a model name.
 */
export function resolveHarness(input: ResolveHarnessInput, registry: HarnessRegistry): HarnessResolution {
  const selected = selectProfile(registry, input)
  const fallback = registry.default

  if (input.frozen && input.frozenBehaviorProfileId != null && selected.reason !== 'frozen-profile') {
    return { ok: false, reason: 'frozen-profile-mismatch' }
  }

  const flagKey = selected.profile.definition.featureFlag?.key
  const flagDefault = selected.profile.definition.featureFlag?.default ?? true
  // A frozen execution reproduces its recorded contract; a live flag toggle never reinterprets it.
  const flagEnabled =
    selected.reason === 'frozen-profile' || !flagKey ? true : (input.flags?.[flagKey] ?? flagDefault)

  // A legacy frozen selection stored no behavioral identity: keep its transport axis, never deduce one.
  const legacyBehaviorSuppressed = input.frozen === true && input.frozenBehaviorProfileId == null
  const declaresBehavior = (binding: HarnessBinding): boolean =>
    typeof binding.overrides.identity?.behaviorProfileId === 'string'

  const defaultBindings = applicableBindings(fallback, input)
  const specificBindings = (
    selected.profile === fallback || !flagEnabled ? [] : applicableBindings(selected.profile, input)
  ).filter((binding) => !(legacyBehaviorSuppressed && declaresBehavior(binding)))

  let overrides: HarnessOverrides = {}
  for (const binding of defaultBindings) overrides = mergeOverrides(overrides, binding.overrides)
  for (const binding of specificBindings) {
    overrides = mergeOverrides(overrides, input.promptAxisOnly ? promptAxisOnly(binding.overrides) : binding.overrides)
  }

  const usesSpecific = specificBindings.length > 0
  const reason: HarnessResolutionReason = usesSpecific
    ? selected.reason
    : selected.profile === fallback
      ? 'default'
      : legacyBehaviorSuppressed
        ? 'frozen-legacy'
        : !flagEnabled
          ? 'disabled'
          : selected.profile.definition.bindings.some(
                (binding) => binding.providerKind === input.providerKind || binding.providerKind === '*'
              )
            ? 'unsupported-endpoint'
            : 'unsupported-transport'

  const effectiveProfile = usesSpecific ? selected.profile : fallback
  const modelBaseline = applyCapabilityClaims(NO_HARNESS_CAPABILITIES, overrides.capabilities)
  const modelCapabilities = applyCapabilityClaims(modelBaseline, input.runtimeCapabilities)
  const adapterCapabilities: HarnessCapabilities = applyCapabilityClaims(
    NO_HARNESS_CAPABILITIES,
    input.adapterCapabilities
  )
  const capabilities = intersectCapabilities(modelCapabilities, adapterCapabilities)

  const reasoning = resolveReasoningPolicy({
    manifestEfforts: overrides.reasoning?.manifestEfforts ?? null,
    nonSerializableEfforts: overrides.reasoning?.nonSerializableEfforts ?? [],
    nativeUltra: overrides.reasoning?.nativeUltra === true,
    runtimeEfforts: input.runtimeReasoningEfforts,
  })

  const prompts = resolvePrompts(effectiveProfile, fallback, overrides)
  const hooks = resolveHooks(effectiveProfile, fallback, overrides)
  const identity = {
    harnessProfileId: overrides.identity?.harnessProfileId ?? 'openai-default-v1',
    behaviorProfileId: overrides.identity?.behaviorProfileId ?? null,
    compatibilityGroup: overrides.identity?.compatibilityGroup ?? 'openai-current-v1',
    promptIdentity: overrides.identity?.promptIdentity ?? 'maestrly-legacy',
  }
  const runtime = {
    promptCacheTtl: overrides.runtime?.promptCacheTtl ?? null,
    personality: overrides.runtime?.personality ?? null,
    nativeCompactionFirst: overrides.runtime?.nativeCompactionFirst === true,
    experimentalContext: overrides.runtime?.experimentalContext === true,
    codexPromptVersion: overrides.runtime?.codexPromptVersion ?? 'codex-current-v1',
  }
  const progress = overrides.progress ?? 'default'
  const bindings = [...defaultBindings, ...specificBindings]
  const contractId = contractIdOf(bindings, input.providerKind)

  const harness: ResolvedHarness = deepFreeze({
    profileId: effectiveProfile.folderId,
    profileVersion: effectiveProfile.definition.profileVersion,
    reason,
    contractId,
    identity,
    prompts,
    reasoning,
    modelCapabilities,
    adapterCapabilities,
    capabilities,
    runtime,
    progress,
    hooks,
    source: effectiveProfile.definition.source ?? null,
    definitionHash: harnessDefinitionHash({
      profileId: effectiveProfile.folderId,
      contractId,
      identity,
      prompts,
      reasoning: { manifestEfforts: reasoning.manifestEfforts, nonSerializableEfforts: reasoning.nonSerializableEfforts, nativeUltra: reasoning.nativeUltra },
      runtime,
      progress,
      hooks,
      capabilities: modelBaseline,
    }),
  })

  if (input.frozenSnapshot && input.frozenSnapshot.definitionHash !== harness.definitionHash) {
    return { ok: false, reason: 'frozen-snapshot-mismatch' }
  }
  return { ok: true, harness }
}

export { DEFAULT_HARNESS_PROFILE_ID }
