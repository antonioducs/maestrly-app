/**
 * EFFECTIVE AGENTS layer: physical (project/global/built-in via `listAgents`) + VIRTUAL agents
 * synthesized from CUSTOM `byAgent` keys in subagent profile rules.
 *
 * V1 contract:
 * - A `byAgent.<alias>` key with nonempty candidates creates an EXECUTABLE virtual agent (no .md file)
 *   based on `general-purpose` — inherits BEHAVIOR/TOOLS, not identity or profile:
 *   normal layers still resolve profiles (conversation > global > frontmatter > parent),
 *   consulting `byAgent.<alias>`; cards and local diagnostics use the LOGICAL NAME (alias).
 * - Real agents (project/global/built-in) always WIN over same-name virtuals: create no duplicate.
 * - Only keys with candidates qualify; `byCategory`/`default`/frontmatter do NOT create virtuals.
 * - Conversation rules first, global rules next; deduplicate by normalized name.
 * - Conversation `subagentProfilesEnabled === false` → synthesize no aliases.
 */
import { normalizeSubagentProfileKey, type SubagentProfileRulesV1 } from '../../shared/subagent-profiles'
import type { ChatMode } from '../../shared/chat'
import { capabilityBehaviorFor } from '../../shared/chat-mode'
import { BUILTIN_AGENTS, listAgents, type ChatAgent } from './agents'
import { getConversationSubagentProfileRules, getGlobalSubagentProfileRules } from './subagent-profile-config'

export const VIRTUAL_AGENT_CATEGORY = 'custom'
export const VIRTUAL_AGENT_SOURCE = 'virtual-profile'
export const VIRTUAL_AGENT_DESCRIPTION =
  'Custom virtual agent based on general-purpose with a dedicated host-managed profile.'

export interface MergeVirtualSubagentsInput {
  agents: readonly ChatAgent[]
  conversationRules?: SubagentProfileRulesV1 | null
  globalRules?: SubagentProfileRulesV1 | null
  profilesEnabled?: boolean
}

/**
 * Appends virtual agents to the physical catalog. Effective base is PHYSICAL `general-purpose`
 * (custom project/global if present) or the built-in. The alias inherits base prompt/tools, never
 * profile/frontmatter — identity and execution profile always belong to the alias.
 */
export function mergeVirtualSubagents({
  agents,
  conversationRules,
  globalRules,
  profilesEnabled = true,
}: MergeVirtualSubagentsInput): ChatAgent[] {
  if (!profilesEnabled) return [...agents]
  const byName = new Map(agents.map((agent) => [normalizeSubagentProfileKey(agent.name), agent]))

  // Conversation first, globals next; normalized keys deduplicate entries.
  const keys: string[] = []
  const seen = new Set<string>()
  const collect = (rules: SubagentProfileRulesV1 | null | undefined): void => {
    if (!rules) return
    for (const [rawKey, candidates] of Object.entries(rules.byAgent ?? {})) {
      const key = normalizeSubagentProfileKey(rawKey)
      if (!key || seen.has(key) || !candidates?.length) continue
      seen.add(key)
      keys.push(key)
    }
  }
  collect(conversationRules)
  collect(globalRules)

  // Without keys there are no virtuals: no need to find the base (keeps the path cheap and tolerant of
  // mocks/environments without BUILTIN_AGENTS).
  if (keys.length === 0) return [...agents]
  const base = byName.get('general-purpose') ?? BUILTIN_AGENTS.find((agent) => agent.name === 'general-purpose')
  if (!base) return [...agents]

  const virtuals: ChatAgent[] = []
  for (const key of keys) {
    if (byName.has(key)) continue // Real agent wins over same-name virtual.
    const virtual: ChatAgent = {
      ...base,
      name: key,
      description: VIRTUAL_AGENT_DESCRIPTION,
      category: VIRTUAL_AGENT_CATEGORY,
      source: VIRTUAL_AGENT_SOURCE,
      virtual: true,
      baseAgentName: base.name,
    }
    // Virtuals inherit prompt/tools, not identity or profile: base frontmatter/provider/model/effort
    // do NOT apply — profiles come only from `byAgent.<alias>` rules (resolver).
    delete virtual.provider
    delete virtual.model
    delete virtual.effort
    delete virtual.legacyModel
    delete virtual.profile
    delete virtual.profileDiagnostics
    virtuals.push(virtual)
  }
  return [...agents, ...virtuals]
}

export interface ListEffectiveAgentsInput {
  cwd: string
  conversationId: string
  home?: string
  /** Agent capabilities = physical + virtual; plan/ask = physical only (read-only modes; runners
   * already restrict Ultra to `explore`). Omitted = UI (includes virtuals). */
  mode?: ChatMode
}

/** Effective conversation catalog: physical via `listAgents` + virtual rules (if enabled). */
export async function listEffectiveAgents(input: ListEffectiveAgentsInput): Promise<ChatAgent[]> {
  const conversation = getConversationSubagentProfileRules(input.conversationId)
  if (!conversation.subagentsEnabled) return []
  const physical = await listAgents(input.cwd, input.home)
  if (input.mode !== undefined && capabilityBehaviorFor(input.mode) !== 'agent') return physical
  if (!conversation.enabled) return physical
  const global = getGlobalSubagentProfileRules()
  return mergeVirtualSubagents({
    agents: physical,
    conversationRules: conversation.rules,
    globalRules: global.rules,
  })
}
