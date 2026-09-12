/**
 * Turn-scoped helpers for explicit subagent selection.
 * Agent selection is semantic and happens before execution-profile resolution.
 * Execution routing is host-managed and keyed by the selected agent name.
 * A role mentioned inside task.prompt must never alter profile resolution.
 *
 * Composition order for explicit turn requests:
 * 1. `agent-mention` parts from the LAST user message — chip/autocomplete selection is STRUCTURED
 *    and deterministic: the user deliberately chose it (even in a negative sentence — semantics come
 *    from structure, not text; only the free-text heuristic interprets negation);
 * 2. Phrase heuristic (e.g. "call testing") — fallback for manually typed text.
 * Plain `#agent` text (typed/pasted) NEVER becomes structured selection: only the normal
 * heuristic applies, so questions/negations/documentation/code blocks do not force the agent.
 */
import { extractAgentMentionNames } from '../../shared/chat-agent-mentions'
import type { ChatMessage } from '../../shared/chat'
import { normalizeSubagentProfileKey } from '../../shared/subagent-profiles'
import { detectExplicitSubagentRequests } from './subagent-explicit-request'

/** Last user message in history (attachments/tool parts ignored during extraction). */
function latestUserMessage(history: readonly ChatMessage[]): ChatMessage | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'user') return history[i]
  }
  return undefined
}

/** Collects visible text from the latest user message in history (attachments ignored). */
export function latestUserMessageText(history: readonly ChatMessage[]): string {
  const message = latestUserMessage(history)
  if (!message) return ''
  const chunks: string[] = []
  for (const part of message.parts) {
    if (part.type === 'text' && part.text.trim()) chunks.push(part.text.trim())
  }
  return chunks.join('\n')
}

/**
 * Explicit turn requests = union of:
 * 1. `agent-mention` parts (composer-selected chips) — ALWAYS explicit, without linguistic
 *    interpretation; conceptually precede the heuristic and are revalidated against
 *    this turn's catalog (ignore parts naming removed/out-of-catalog agents);
 * 2. Phrase heuristic (e.g. "call testing") — complements free text.
 * The guard (subagent-selection-guard) still blocks silent substitution with general-purpose
 * while requested agents are pending; auxiliary agents remain allowed.
 */
export function detectExplicitSubagentsForTurn(
  history: readonly ChatMessage[],
  availableAgentNames: readonly string[]
): string[] {
  const available = new Set(availableAgentNames.map(normalizeSubagentProfileKey).filter(Boolean))
  const latest = latestUserMessage(history)
  const structured = extractAgentMentionNames(latest?.parts ?? []).filter((name) => available.has(name))
  const text = latestUserMessageText(history)
  const heuristic = detectExplicitSubagentRequests(text, availableAgentNames).agentNames
  return [...new Set([...structured, ...heuristic])]
}
