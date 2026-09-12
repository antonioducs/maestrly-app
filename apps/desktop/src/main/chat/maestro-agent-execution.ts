import { randomUUID } from 'node:crypto'
import type { ChatModelRef } from '../../shared/chat'
import {
  MAESTRO_CONFIG_VERSION,
  type MaestroDelegateIntent,
  type MaestroDelegationSnapshotV1,
  type MaestroResourceV1,
  type MaestroTurnSnapshotV1,
} from '../../shared/maestro'
import {
  SUBAGENT_PROFILE_RULES_VERSION,
  normalizeSubagentProfileKey,
  type SubagentExecutionSnapshotV1,
  type SubagentProfileAttempt,
  type SubagentProfileCandidate,
} from '../../shared/subagent-profiles'
import { getSubagentProfileModelMeta } from './subagent-profile-model-meta'
import { subagentModelCatalog, subagentProviderStatus } from './subagent-provider-runtime'
import { validateSubagentProfileCandidate } from './subagent-profile-resolver'

const resolverDeps = {
  providerStatus: subagentProviderStatus,
  modelCatalog: subagentModelCatalog,
  modelMeta: getSubagentProfileModelMeta,
}

export class MaestroAgentExecutionError extends Error {
  constructor(
    readonly code:
      | 'agent-required'
      | 'agent-unavailable'
      | 'explicit-agent-mismatch'
      | 'agent-profile-unavailable'
      | 'invalid-intent'
      | 'resume-session-not-found'
      | 'resume-session-foreign'
      | 'resume-session-active'
      | 'resume-agent-mismatch',
    message: string
  ) {
    super(message)
    this.name = 'MaestroAgentExecutionError'
  }
}

export interface MaestroAgentExecutionResult {
  snapshot: MaestroDelegationSnapshotV1
  resource: MaestroResourceV1
  profile: SubagentExecutionSnapshotV1
}

/** Resolves only the execution stack of the resource chosen by the parent. A rejected candidate may fall through
 * to the next configured candidate, but this function never considers or substitutes another logical agent. */
async function resolveSelectedResourceProfile(
  resource: MaestroResourceV1,
  parent: ChatModelRef & { effort: string },
  parentFastMode: boolean
): Promise<SubagentExecutionSnapshotV1> {
  const configured = resource.candidates.length > 0
  const candidates: SubagentProfileCandidate[] = configured
    ? resource.candidates
    : [{ ...parent, effort: parent.effort || 'off', ...(parentFastMode ? { fastMode: true } : {}) }]
  const attempts: SubagentProfileAttempt[] = []
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const checked = await validateSubagentProfileCandidate(candidate, resolverDeps, !configured)
    const attempt: SubagentProfileAttempt = {
      source: 'maestro-resource',
      ruleKey: resource.id,
      candidateIndex: index,
      candidate,
      outcome: checked.valid ? 'selected' : 'rejected',
      diagnostics:
        checked.valid && attempts.some((item) => item.outcome === 'rejected')
          ? [
              ...checked.diagnostics,
              {
                code: 'fallback-selected',
                severity: 'warning',
                message: 'A later candidate in the parent-selected Maestro resource was selected.',
              },
            ]
          : checked.diagnostics,
    }
    attempts.push(attempt)
    if (checked.valid) {
      return {
        version: SUBAGENT_PROFILE_RULES_VERSION,
        agentName: resource.id,
        category: resource.specialties[0],
        effective: {
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          configuredEffort: candidate.effort,
          sentEffort: checked.sentEffort,
          fastMode: candidate.fastMode === true,
          source: 'maestro-resource',
          ruleKey: resource.id,
          candidateIndex: index,
        },
        attempts,
      }
    }
  }
  return {
    version: SUBAGENT_PROFILE_RULES_VERSION,
    agentName: resource.id,
    category: resource.specialties[0],
    effective: null,
    attempts,
  }
}

/** Direct parent selection. The Maestrly process validates and launches the selected resource; it never scores the
 * Pool and never replaces the choice with another resource. */
export async function resolveMaestroAgentExecution(args: {
  intent: MaestroDelegateIntent
  turn: MaestroTurnSnapshotV1
  parent: ChatModelRef & { effort: string }
  parentFastMode: boolean
  explicitAgent?: string
  delegationId?: string
  now?: number
}): Promise<MaestroAgentExecutionResult> {
  if (!args.intent.task.trim())
    throw new MaestroAgentExecutionError('invalid-intent', 'delegate.task must not be empty.')
  const selectedId = normalizeSubagentProfileKey(args.intent.agent)
  if (!selectedId)
    throw new MaestroAgentExecutionError('agent-required', 'delegate.agent must name an available agent.')
  const explicit = normalizeSubagentProfileKey(args.explicitAgent ?? '')
  if (explicit && selectedId !== explicit) {
    throw new MaestroAgentExecutionError(
      'explicit-agent-mismatch',
      `The user explicitly selected Maestro agent “${explicit}”; delegate.agent must match it.`
    )
  }
  const resource = args.turn.pool.find((candidate) => candidate.enabled && candidate.id === selectedId)
  if (!resource) {
    throw new MaestroAgentExecutionError(
      'agent-unavailable',
      `The parent-selected Maestro agent “${selectedId}” is missing or disabled.`
    )
  }
  const profile = await resolveSelectedResourceProfile(resource, args.parent, args.parentFastMode)
  if (!profile.effective) {
    throw new MaestroAgentExecutionError(
      'agent-profile-unavailable',
      `The parent-selected Maestro agent “${selectedId}” has no runnable execution candidate.`
    )
  }
  const snapshot: MaestroDelegationSnapshotV1 = {
    version: MAESTRO_CONFIG_VERSION,
    delegationId: args.delegationId ?? `delegate_${randomUUID()}`,
    kind: args.intent.kind,
    domain: args.intent.domain,
    reviewOf: [...args.intent.reviewOf],
    strategy: args.turn.strategy,
    selection: 'parent-selected',
    resource: {
      ...resource,
      specialties: [...resource.specialties],
      candidates: resource.candidates.map((candidate) => ({ ...candidate })),
    },
    profile,
    routedAt: args.now ?? Date.now(),
    ...(args.intent.resumeSessionId ? { resumedFrom: args.intent.resumeSessionId } : {}),
  }
  return { snapshot, resource, profile }
}
