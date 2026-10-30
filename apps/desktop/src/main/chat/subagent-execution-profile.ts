import { accountPoolKindOf, isActiveAccountProviderId, type ChatModelRef } from '../../shared/chat'
import {
  SUBAGENT_PROFILE_RULES_VERSION,
  normalizeSubagentProfileKey,
  type SubagentExecutionSnapshotV1,
  type TaskComplexity,
} from '../../shared/subagent-profiles'
import type { ChatAgent } from './agents'
import { getConversationSubagentProfileRules, getGlobalSubagentProfileRules } from './subagent-profile-config'
import { getSubagentProfileModelMeta } from './subagent-profile-model-meta'
import { subagentModelCatalog, subagentProviderStatus } from './subagent-provider-runtime'
import { resolveParentSubagentProfile, resolveSubagentProfile } from './subagent-profile-resolver'
import { getSubagentRouter } from './subagent-route'
import { getAccountPool } from './subscription-failover/account-pool'
import { getConvUiPrefs } from '../store'

interface ResolveSubagentExecutionProfileInput {
  agentName: string
  agents: ChatAgent[]
  conversationId: string
  parent: ChatModelRef & { effort: string }
  /** Effective Fast Mode of the parent turn, captured before resolving the child profile. */
  parentFastMode?: boolean
  /** How hard the parent said the task is; a conversation whose host routes tasks picks the model from it. */
  complexity?: TaskComplexity | null
}

interface ResolveParentSubagentExecutionProfileInput {
  agent: ChatAgent
  /** An explicit `fastMode` is validated against the model like a configured profile; omitted, Fast is inherited. */
  parent: ChatModelRef & { effort: string; fastMode?: boolean }
  /** Effective Fast Mode of the parent turn, captured before resolving the child profile. */
  parentFastMode?: boolean
}

const subagentProfileResolverDeps = {
  providerStatus: subagentProviderStatus,
  modelCatalog: subagentModelCatalog,
  modelMeta: getSubagentProfileModelMeta,
}

/**
 * A child follows the account pool its conversation selected, so it keeps rotating with the pool instead of staying
 * on the account the parent turn happened to start on. An individual account selection, or a parent running outside
 * the pool's members, stays physical.
 */
function inheritedParentProviderId(conversationId: string, providerId: string): string {
  const stored = getConvUiPrefs(conversationId).chat?.providerId
  const kind = stored && isActiveAccountProviderId(stored) ? accountPoolKindOf(stored) : null
  if (!stored || !kind) return providerId
  return getAccountPool(kind).memberProviderIds.includes(providerId) ? stored : providerId
}

/** Resolves a workflow's parent selection without applying configured agent overrides. */
export function resolveParentSubagentExecutionProfile({
  agent,
  parent,
  parentFastMode,
}: ResolveParentSubagentExecutionProfileInput): Promise<SubagentExecutionSnapshotV1> {
  return resolveParentSubagentProfile(
    {
      agent,
      parent: {
        providerId: parent.providerId,
        modelId: parent.modelId,
        effort: parent.effort,
        ...(parent.fastMode !== undefined ? { fastMode: parent.fastMode } : {}),
      },
      parentFastMode,
    },
    subagentProfileResolverDeps
  )
}

/** Impure resolution boundary: rereads config/credentials once and returns the immutable toolCallId snapshot. */
export async function resolveSubagentExecutionProfile({
  agentName,
  agents,
  conversationId,
  parent,
  parentFastMode,
  complexity,
}: ResolveSubagentExecutionProfileInput): Promise<{
  definition: ChatAgent | null
  profile: SubagentExecutionSnapshotV1
}> {
  const normalizedName = normalizeSubagentProfileKey(agentName)
  // VIRTUAL agents (custom byAgent key) enter the effective list under their logical name (e.g. `testing`).
  // Resolution checks `conversation-agent` and `global-agent` before defaults/frontmatter/parent, so
  // `byAgent.testing` is selected without changing precedence. The alias inherits base BEHAVIOR/TOOLS
  // (general-purpose), NEVER identity or profile: snapshot/card/usage use the logical alias name.
  const definition = agents.find((item) => normalizeSubagentProfileKey(item.name) === normalizedName) ?? null
  const globalConfig = getGlobalSubagentProfileRules()
  const conversationConfig = getConversationSubagentProfileRules(conversationId)
  // Revalidate at call time in addition to the gate removing `task` at turn setup. This closes the race
  // where the user disables subagents while a response already given the tool is still running.
  if (!conversationConfig.subagentsEnabled) {
    return {
      definition: null,
      profile: {
        version: SUBAGENT_PROFILE_RULES_VERSION,
        agentName: normalizedName,
        effective: null,
        attempts: [],
        diagnostics: [],
      },
    }
  }
  const profilesEnabled = conversationConfig.enabled
  const diagnostics = profilesEnabled
    ? [...globalConfig.diagnostics, ...conversationConfig.diagnostics, ...(definition?.profileDiagnostics ?? [])]
    : []
  if (!definition) {
    return {
      definition: null,
      profile: {
        version: SUBAGENT_PROFILE_RULES_VERSION,
        agentName: normalizedName,
        effective: null,
        attempts: [],
        diagnostics: [
          ...diagnostics,
          { code: 'agent-not-found', severity: 'error', message: `Subagent “${agentName}” was not found.` },
        ],
      },
    }
  }
  const router = getSubagentRouter(conversationId)
  const route = router ? router({ agentName: normalizedName, complexity: complexity ?? null }) : null
  const profile = await resolveSubagentProfile(
    {
      agent: definition,
      profilesEnabled,
      conversationRules: conversationConfig.rules,
      globalRules: globalConfig.rules,
      parent: {
        providerId: inheritedParentProviderId(conversationId, parent.providerId),
        modelId: parent.modelId,
        effort: parent.effort,
      },
      parentFastMode,
      diagnostics,
      hostRoute: route ? { ruleKey: route.info.complexity, candidates: route.candidates } : undefined,
    },
    subagentProfileResolverDeps
  )
  return { definition, profile: route ? { ...profile, delegation: route.info } : profile }
}
