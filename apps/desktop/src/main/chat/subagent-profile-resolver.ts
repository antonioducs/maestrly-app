import type { ChatModelMeta } from '../../shared/chat'
import {
  validateSubagentProfileEffort,
  validateSubagentProfileFastMode,
} from '../../shared/subagent-profile-effort'
import {
  SUBAGENT_PROFILE_RULES_VERSION,
  isUnavailableClaudeFable,
  normalizeSubagentProfileKey,
  type SubagentExecutionSnapshotV1,
  type SubagentProfileAttempt,
  type SubagentProfileCandidate,
  type SubagentProfileDiagnostic,
  type SubagentProfileRulesV1,
  type SubagentProfileSource,
} from '../../shared/subagent-profiles'
import type { ChatAgent } from './agents'

export interface SubagentProfileResolverDeps {
  providerStatus(providerId: string): Promise<'missing' | 'unsupported' | 'disconnected' | 'no-key' | 'available'>
  modelCatalog(providerId: string): Promise<{ status: 'available' | 'unavailable'; models: string[] }>
  modelMeta(
    providerId: string,
    modelId: string
  ): Promise<{ status: 'available' | 'unavailable'; meta: ChatModelMeta | null }>
}

export interface ResolveSubagentProfileInput {
  agent: ChatAgent
  /** false ignores global/conversation/frontmatter rules and resolves only the parent. */
  profilesEnabled?: boolean
  conversationRules?: SubagentProfileRulesV1 | null
  globalRules?: SubagentProfileRulesV1 | null
  parent: SubagentProfileCandidate
  /** Effective Fast Mode of the parent turn; only the selected `parent` layer may inherit it. */
  parentFastMode?: boolean
  diagnostics?: SubagentProfileDiagnostic[]
}

type Layer = {
  source: SubagentProfileSource
  ruleKey?: string
  candidates: SubagentProfileCandidate[]
  /** SYNTHESIZED candidate (legacy frontmatter/parent): effort came from the conversation, not explicit configuration.
   * Invalid effort degrades to "omit" with a warning — as the main turn does — instead of rejecting. */
  synthesizedEffort?: boolean
}

function diagnostic(
  code: SubagentProfileDiagnostic['code'],
  message: string,
  severity: SubagentProfileDiagnostic['severity'] = 'warning'
): SubagentProfileDiagnostic {
  return { code, message, severity }
}

function candidatesAt(rules: SubagentProfileRulesV1 | null | undefined, axis: 'byAgent' | 'byCategory', key?: string) {
  return key ? (rules?.[axis]?.[key] ?? []) : []
}

function buildLayers(input: ResolveSubagentProfileInput, agentName: string, category?: string): Layer[] {
  const { conversationRules: conversation, globalRules: global, agent, parent } = input
  if (input.profilesEnabled === false) {
    return [{ source: 'parent', candidates: [parent], synthesizedEffort: true }]
  }
  const frontmatter = agent.profile
    ? [agent.profile]
    : agent.legacyModel
      ? [{ providerId: parent.providerId, modelId: agent.legacyModel, effort: parent.effort }]
      : []
  return [
    { source: 'conversation-agent', ruleKey: agentName, candidates: candidatesAt(conversation, 'byAgent', agentName) },
    {
      source: 'conversation-category',
      ruleKey: category,
      candidates: candidatesAt(conversation, 'byCategory', category),
    },
    { source: 'conversation-default', candidates: conversation?.default ?? [] },
    { source: 'global-agent', ruleKey: agentName, candidates: candidatesAt(global, 'byAgent', agentName) },
    { source: 'global-category', ruleKey: category, candidates: candidatesAt(global, 'byCategory', category) },
    { source: 'global-default', candidates: global?.default ?? [] },
    { source: 'frontmatter', candidates: frontmatter, synthesizedEffort: !agent.profile },
    { source: 'parent', candidates: [parent], synthesizedEffort: true },
  ]
}

function modelIsListed(models: string[], modelId: string): boolean {
  const basename = modelId.split('/').pop()
  return models.includes(modelId) || (!!basename && models.includes(basename))
}

export async function validateSubagentProfileCandidate(
  candidate: SubagentProfileCandidate,
  deps: SubagentProfileResolverDeps,
  synthesizedEffort: boolean
): Promise<{ sentEffort: string | null; diagnostics: SubagentProfileDiagnostic[]; valid: boolean }> {
  const provider = await deps.providerStatus(candidate.providerId)
  if (provider === 'missing') {
    return {
      sentEffort: null,
      valid: false,
      diagnostics: [diagnostic('provider-missing', `Provider “${candidate.providerId}” no longer exists.`, 'error')],
    }
  }
  if (provider === 'unsupported') {
    return {
      sentEffort: null,
      valid: false,
      diagnostics: [
        diagnostic(
          'provider-unsupported',
          `Provider “${candidate.providerId}” cannot execute deterministic subagent profiles.`,
          'error'
        ),
      ],
    }
  }
  if (provider === 'disconnected') {
    return {
      sentEffort: null,
      valid: false,
      diagnostics: [
        diagnostic(
          'provider-disconnected',
          `Provider “${candidate.providerId}” is not authenticated. Sign in before using it for subagents.`,
          'error'
        ),
      ],
    }
  }
  if (provider === 'no-key') {
    return {
      sentEffort: null,
      valid: false,
      diagnostics: [diagnostic('no-key', `Provider “${candidate.providerId}” has no API key.`, 'error')],
    }
  }

  const diagnostics: SubagentProfileDiagnostic[] = []
  const catalog = await deps.modelCatalog(candidate.providerId)
  if (catalog.status === 'unavailable') {
    diagnostics.push(
      diagnostic(
        'catalog-unavailable',
        `Model catalog for “${candidate.providerId}” is unavailable; the configured ID will be attempted.`
      )
    )
  } else if (isUnavailableClaudeFable(candidate.providerId, candidate.modelId, catalog.models)) {
    return {
      sentEffort: null,
      valid: false,
      diagnostics: [
        diagnostic(
          'model-unavailable',
          'Fable is not available in the model catalog for this Claude account.',
          'error'
        ),
      ],
    }
  } else if (!modelIsListed(catalog.models, candidate.modelId)) {
    diagnostics.push(
      diagnostic('model-not-found', `Model “${candidate.modelId}” is not listed; the configured ID will be attempted.`)
    )
  }

  const metadata = await deps.modelMeta(candidate.providerId, candidate.modelId)
  const effort =
    candidate.effort === 'off'
      ? { sentEffort: null, diagnostics: [], valid: true }
      : validateSubagentProfileEffort(candidate, metadata, synthesizedEffort)
  const fastMode = validateSubagentProfileFastMode(candidate, metadata)
  return {
    sentEffort: effort.sentEffort,
    valid: effort.valid && fastMode.valid,
    diagnostics: [...diagnostics, ...effort.diagnostics, ...fastMode.diagnostics],
  }
}

/** Resolves exactly once and records every considered candidate in deterministic precedence order. */
export async function resolveSubagentProfile(
  input: ResolveSubagentProfileInput,
  deps: SubagentProfileResolverDeps
): Promise<SubagentExecutionSnapshotV1> {
  const agentName = normalizeSubagentProfileKey(input.agent.name)
  const category = input.agent.category ? normalizeSubagentProfileKey(input.agent.category) : undefined
  const attempts: SubagentProfileAttempt[] = []
  for (const layer of buildLayers(input, agentName, category)) {
    for (let candidateIndex = 0; candidateIndex < layer.candidates.length; candidateIndex++) {
      const candidate = layer.candidates[candidateIndex]
      const checked = await validateSubagentProfileCandidate(candidate, deps, layer.synthesizedEffort === true)
      const priorRejected = attempts.some((attempt) => attempt.outcome === 'rejected')
      const attempt: SubagentProfileAttempt = {
        source: layer.source,
        ...(layer.ruleKey ? { ruleKey: layer.ruleKey } : {}),
        candidateIndex,
        candidate,
        outcome: checked.valid ? 'selected' : 'rejected',
        diagnostics:
          checked.valid && priorRejected
            ? [
                ...checked.diagnostics,
                diagnostic(
                  'fallback-selected',
                  'A fallback profile was selected after earlier candidates were rejected.'
                ),
              ]
            : checked.diagnostics,
      }
      attempts.push(attempt)
      if (checked.valid) {
        return {
          version: SUBAGENT_PROFILE_RULES_VERSION,
          agentName,
          ...(category ? { category } : {}),
          effective: {
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            configuredEffort: candidate.effort,
            sentEffort: checked.sentEffort,
            fastMode: layer.source === 'parent' ? input.parentFastMode === true : candidate.fastMode === true,
            source: layer.source,
            ...(layer.ruleKey ? { ruleKey: layer.ruleKey } : {}),
            candidateIndex,
          },
          attempts,
          ...(input.diagnostics?.length ? { diagnostics: input.diagnostics } : {}),
        }
      }
    }
  }
  const parentAttempt = attempts.at(-1)
  if (parentAttempt?.source === 'parent') {
    parentAttempt.diagnostics = [
      ...parentAttempt.diagnostics,
      diagnostic('parent-profile-invalid', 'The parent conversation profile is not runnable.', 'error'),
    ]
  }
  return {
    version: SUBAGENT_PROFILE_RULES_VERSION,
    agentName,
    ...(category ? { category } : {}),
    effective: null,
    ...(input.diagnostics?.length ? { diagnostics: input.diagnostics } : {}),
    attempts,
  }
}

/**
 * Validates only the parent candidate and freezes the result in a snapshot.
 *
 * Workflows running a built-in agent outside `task` must still
 * cross the same provider/model/effort boundary, but must not apply
 * overrides configured for that agent (e.g. `general-purpose`).
 */
export function resolveParentSubagentProfile(
  input: Omit<ResolveSubagentProfileInput, 'profilesEnabled'>,
  deps: SubagentProfileResolverDeps
): Promise<SubagentExecutionSnapshotV1> {
  return resolveSubagentProfile({ ...input, profilesEnabled: false }, deps)
}
