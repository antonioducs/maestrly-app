/**
 * Shared subagent dispatch catalog for all chat runtimes.
 *
 * Agent selection is semantic and happens before execution-profile resolution.
 * Execution routing is host-managed and keyed by the selected agent name.
 * A role mentioned inside task.prompt must never alter profile resolution.
 *
 * This module exposes only logical metadata (capability / routing). It never
 * injects provider/model/effort into the prompt — those stay host-side and are
 * resolved lazily by resolveSubagentExecutionProfile.
 */
import { normalizeSubagentProfileKey, type SubagentProfileRulesV1 } from '../../shared/subagent-profiles'
import type { ChatAgent } from './agents'
import { hasSubagentMutatingCapability } from './tools'
import {
  getConversationSubagentProfileRules,
  getGlobalSubagentProfileRules,
} from './subagent-profile-config'

export type SubagentDispatchCapability = 'read-only' | 'worker'
export type SubagentDispatchRouting = 'dedicated' | 'inherited'

export interface SubagentDispatchEntry {
  name: string
  description: string
  category?: string
  capability: SubagentDispatchCapability
  routing: SubagentDispatchRouting
  source: string
}

export interface BuildSubagentDispatchCatalogInput {
  agents: readonly ChatAgent[]
  conversationId: string
  /** When true (Plan/Ask), every agent is advertised as read-only regardless of tools. */
  forceReadOnly?: boolean
  /** Optional overrides for tests — defaults read live config. */
  globalRules?: SubagentProfileRulesV1 | null
  conversationRules?: SubagentProfileRulesV1 | null
  profilesEnabled?: boolean
}

export interface RenderSubagentDispatchCatalogOptions {
  /** Soft cap for each agent description (whitespace already normalized). */
  descriptionMaxChars?: number
  /** When true, truncate with an ellipsis character (Copilot style). */
  ellipsis?: boolean
}

const GENERIC_FALLBACK = 'general-purpose'

const SELECTION_RULES = [
  'Selection rules:',
  '- If the user explicitly names an available agent, ensure that agent is actually dispatched for the requested responsibility.',
  '- Do not replace it by making general-purpose role-play as that agent.',
  '- Other auxiliary agents may still be used for independent supporting tasks.',
  '- Selecting the agent automatically activates its host-managed execution profile.',
  '- Do not choose agents based on provider or model names; execution routing is managed by Maestrly.',
  '- `#agent-name` in the user message is an explicit mandatory agent selection.',
].join('\n')

function normalizeDescription(description: string | undefined, maxChars?: number, ellipsis = false): string {
  const normalized = (description || '').replace(/\s+/g, ' ').trim() || '(no description)'
  if (maxChars == null || normalized.length <= maxChars) return normalized
  if (ellipsis) return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
  return normalized.slice(0, maxChars)
}

function hasExplicitRoute(
  rules: SubagentProfileRulesV1 | null | undefined,
  agentName: string,
  category?: string
): boolean {
  if (!rules) return false
  if (rules.byAgent?.[agentName]?.length) return true
  if (category && rules.byCategory?.[category]?.length) return true
  return false
}

/**
 * dedicated = explicit byAgent / byCategory / frontmatter profile on this agent.
 * Default-only rules and parent inheritance count as inherited — they are not a
 * per-agent configured route. Profiles disabled on the conversation force inherited.
 */
export function classifySubagentRouting(input: {
  agent: ChatAgent
  profilesEnabled: boolean
  conversationRules?: SubagentProfileRulesV1 | null
  globalRules?: SubagentProfileRulesV1 | null
}): SubagentDispatchRouting {
  if (!input.profilesEnabled) return 'inherited'
  const agentName = normalizeSubagentProfileKey(input.agent.name)
  const category = input.agent.category ? normalizeSubagentProfileKey(input.agent.category) : undefined
  if (hasExplicitRoute(input.conversationRules, agentName, category)) return 'dedicated'
  if (hasExplicitRoute(input.globalRules, agentName, category)) return 'dedicated'
  if (input.agent.profile) return 'dedicated'
  return 'inherited'
}

export function classifySubagentCapability(
  agent: ChatAgent,
  forceReadOnly = false
): SubagentDispatchCapability {
  if (forceReadOnly) return 'read-only'
  return hasSubagentMutatingCapability(agent.tools) ? 'worker' : 'read-only'
}

export function buildSubagentDispatchCatalog(
  input: BuildSubagentDispatchCatalogInput
): SubagentDispatchEntry[] {
  // Live config is only read when a real conversationId is present and the caller did not
  // supply overrides. Empty conversationId keeps pure render/unit paths store-free.
  const global =
    input.globalRules !== undefined
      ? input.globalRules
      : input.conversationId
        ? getGlobalSubagentProfileRules().rules
        : null
  const conversationPayload =
    input.conversationRules !== undefined || input.profilesEnabled !== undefined
      ? {
          rules: input.conversationRules ?? null,
          enabled: input.profilesEnabled ?? true,
        }
      : input.conversationId
        ? getConversationSubagentProfileRules(input.conversationId)
        : { rules: null, enabled: true }
  const conversationRules =
    input.conversationRules !== undefined ? input.conversationRules : conversationPayload.rules
  const profilesEnabled =
    input.profilesEnabled !== undefined ? input.profilesEnabled : conversationPayload.enabled

  return input.agents.map((agent) => {
    const name = normalizeSubagentProfileKey(agent.name) || agent.name
    return {
      name,
      description: agent.description || '',
      ...(agent.category ? { category: agent.category } : {}),
      capability: classifySubagentCapability(agent, input.forceReadOnly === true),
      routing: classifySubagentRouting({
        agent,
        profilesEnabled,
        conversationRules,
        globalRules: global,
      }),
      source: agent.source,
    }
  })
}

function entryTags(entry: SubagentDispatchEntry): string {
  const role = entry.name === GENERIC_FALLBACK ? 'generic fallback' : 'specialist'
  const profile = entry.routing === 'dedicated' ? 'dedicated profile' : 'inherited profile'
  return `${role}, ${entry.capability}, ${profile}`
}

export function formatSubagentDispatchEntry(
  entry: SubagentDispatchEntry,
  options: RenderSubagentDispatchCatalogOptions = {}
): string {
  const description = normalizeDescription(entry.description, options.descriptionMaxChars, options.ellipsis)
  return `- ${entry.name} [${entryTags(entry)}]: ${description}`
}

/**
 * Renders the shared catalog block (selection rules + available agents).
 * Callers prepend their own runtime-specific intro / heading.
 */
export function renderSubagentDispatchCatalog(
  entries: readonly SubagentDispatchEntry[],
  options: RenderSubagentDispatchCatalogOptions = {}
): string {
  if (!entries.length) return ''
  const lines = entries.map((entry) => formatSubagentDispatchEntry(entry, options))
  return `${SELECTION_RULES}\nAvailable agents:\n${lines.join('\n')}`
}

/** Convenience: build + render in one step for runners. */
export function buildAndRenderSubagentDispatchCatalog(
  input: BuildSubagentDispatchCatalogInput,
  options: RenderSubagentDispatchCatalogOptions = {}
): string {
  return renderSubagentDispatchCatalog(buildSubagentDispatchCatalog(input), options)
}

export const SUBAGENT_DISPATCH_SELECTION_RULES = SELECTION_RULES
