/**
 * Host-side guard against silent substitution of explicitly requested
 * subagents. The guard is NOT a per-turn allowlist: auxiliary agents (explore,
 * other specialists) stay usable for independent supporting tasks. Only
 * general-purpose is blocked while a requested specialist is still pending,
 * because using it would let the main model role-play the specialist.
 *
 * Agent selection is semantic and happens before execution-profile resolution.
 * Execution routing is host-managed and keyed by the selected agent name.
 * A role mentioned inside task.prompt must never alter profile resolution.
 */
import { normalizeSubagentProfileKey } from '../../shared/subagent-profiles'
import { chatDiag } from './diag-log'

export type SubagentSelectionRuntime =
  | 'byok'
  | 'claude-subscription'
  | 'codex-subscription'
  | 'github-copilot'

/** Mutable per-turn state: requested and already-dispatched agents. Does not persist across turns. */
export interface ExplicitSubagentTurnState {
  requested: Set<string>
  dispatched: Set<string>
}

const GENERAL_PURPOSE = 'general-purpose'

export class SubagentSelectionGuardError extends Error {
  readonly requestedAgents: string[]
  readonly selectedAgent: string
  readonly code = 'subagent-selection-corrected' as const

  constructor(message: string, requestedAgents: string[], selectedAgent: string) {
    super(message)
    this.name = 'SubagentSelectionGuardError'
    this.requestedAgents = requestedAgents
    this.selectedAgent = selectedAgent
  }
}

export interface AssertSubagentSelectionInput {
  state: ExplicitSubagentTurnState
  selectedAgent: string
  availableAgents: readonly string[]
  runtime?: SubagentSelectionRuntime
  conversationId?: string
}

function canonicalize(name: string): string {
  return normalizeSubagentProfileKey(name)
}

/** Creates turn state; discards names outside the current catalog. */
export function createExplicitSubagentTurnState(
  requestedAgentNames: readonly string[],
  availableAgentNames: readonly string[]
): ExplicitSubagentTurnState {
  const available = new Set(availableAgentNames.map(canonicalize).filter(Boolean))
  const requested = new Set<string>()
  for (const name of requestedAgentNames) {
    const key = canonicalize(name)
    if (key && available.has(key)) requested.add(key)
  }
  return { requested, dispatched: new Set() }
}

/**
 * Marks an agent attempted — called immediately after the guard, before profile
 * resolution. "dispatched" means the guard ACCEPTED the dispatch attempt,
 * not that execution succeeded: if resolution or execution
 * fails with a visible error, the model may choose another strategy,
 * including fallback to another agent.
 */
export function recordSubagentDispatch(state: ExplicitSubagentTurnState, selectedAgent: string): void {
  const key = canonicalize(selectedAgent)
  if (key) state.dispatched.add(key)
}

export function subagentSelectionGuardMessage(
  requestedAgent: string,
  selectedAgent: string
): string {
  return (
    `The user explicitly requested the available subagent "${requestedAgent}". ` +
    `Call task again with agent="${requestedAgent}", or explain why that agent cannot be used. ` +
    `Do not emulate it through "${selectedAgent}" or another agent.`
  )
}

/**
 * Validates task.agent against explicit turn requests (prevents
 * substitution, not auxiliary use):
 * - Requested agent → allow (runner marks dispatch);
 * - Auxiliary agents (explore, other specialists) → allow;
 * - general-purpose → block only while a requested specialist
 *   remains undispatched, with a retryable error naming the pending agent;
 * - No requests, or requests outside catalog → no restriction.
 */
export function assertSubagentSelection(input: AssertSubagentSelectionInput): void {
  const { state, selectedAgent } = input
  const selected = canonicalize(selectedAgent)
  if (!selected) return
  if (state.requested.has(selected)) return

  const available = new Set(input.availableAgents.map(canonicalize).filter(Boolean))
  const pending = [...state.requested].filter((name) => !state.dispatched.has(name) && available.has(name))
  if (!pending.length) return
  if (selected !== GENERAL_PURPOSE) return

  const primary = pending[0]
  if (input.runtime) {
    chatDiag({
      kind: 'subagent-selection-corrected',
      requestedAgent: primary,
      selectedAgent: selected,
      runtime: input.runtime,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    })
  }

  throw new SubagentSelectionGuardError(
    subagentSelectionGuardMessage(primary, selectedAgent),
    [...state.requested],
    selectedAgent
  )
}
