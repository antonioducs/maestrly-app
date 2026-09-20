import type { ChatModelRef, ChatContextSnapshot } from '../../../shared/chat'
import { type StoredChatMessage, upsertChatMessage } from '../chat-store'
import { deleteOpenAIInferenceState, getOpenAIInferenceState } from '../openai/inference-store'
import { getCodexThreadBinding, retireCodexThreadBinding } from '../codex-subscription/thread-store'
import { getClaudeSessionBinding, retireClaudeSessionBinding } from '../claude-agent-sdk/session-store'
import { getGitHubCopilotSessionBinding, retireGitHubCopilotSessionBinding } from '../github-copilot/session-store'
import { getCursorAgentBinding, retireCursorAgentBinding } from '../cursor-subscription/session-store'
import { estimatePortableContextTokens } from '../portable-context'

export interface PreparedMarker {
  messageId: string
  afterPartId: string
  partId: string
}

/** Pure preview. The coordinator independently verifies the source hash before committing. */
export function previewPreparedActivation(
  history: readonly StoredChatMessage[],
  marker: PreparedMarker,
  summary: string
): StoredChatMessage[] | null {
  const index = history.findIndex((message) => message.id === marker.messageId)
  if (index < 0) return null
  const anchor = history[index]
  const partIndex = anchor.parts.findIndex((part) => part.id === marker.afterPartId)
  if (partIndex < 0 || anchor.parts.some((part) => part.id === marker.partId)) return null
  return history.map((message, position) =>
    position !== index
      ? message
      : {
          ...message,
          parts: [
            ...message.parts.slice(0, partIndex + 1),
            { type: 'compaction', id: marker.partId, text: summary, strategy: 'summary' },
            ...message.parts.slice(partIndex + 1),
          ],
        }
  )
}

/** Called INSIDE candidate consumption's transaction. No network work participates in the commit. */
export function commitPreparedActivation(args: {
  conversationId: string
  history: readonly StoredChatMessage[]
  marker: PreparedMarker
  destination: ChatModelRef
  contextWindow: number
}): { messageId: string; snapshot: ChatContextSnapshot } | null {
  const anchorIndex = args.history.findIndex((message) => message.id === args.marker.messageId)
  if (anchorIndex < 0) throw new Error('Prepared compaction boundary disappeared')
  const newestAssistant = [...args.history].reverse().find((message) => message.role === 'assistant')
  const snapshot: ChatContextSnapshot = {
    model: args.destination,
    quality: 'estimated',
    usedTokens: estimatePortableContextTokens(args.history),
    modelContextWindow: args.contextWindow,
    sequence: (newestAssistant?.contextSnapshot?.sequence ?? 0) + 1,
    observedAt: Date.now(),
  }
  for (let index = anchorIndex; index < args.history.length; index += 1) {
    const message = args.history[index]
    // Billing remains intact; samples measured against the superseded prompt are no longer reusable.
    const usage = message.usage ? { ...message.usage } : undefined
    if (usage) delete usage.contextIdentity
    const inference = getOpenAIInferenceState(message.id)
    if (inference?.canonicalWindow || inference?.ledger.entries.some((entry) => entry.type === 'compaction')) {
      deleteOpenAIInferenceState(message.id)
    }
    upsertChatMessage({
      ...message,
      ...(usage ? { usage } : {}),
      contextSnapshot: message.id === newestAssistant?.id ? snapshot : undefined,
    })
  }
  deleteOpenAIInferenceState(args.marker.messageId)
  const codex = getCodexThreadBinding(args.conversationId)
  if (codex) retireCodexThreadBinding(args.conversationId, codex.threadId)
  const claude = getClaudeSessionBinding(args.conversationId)
  if (claude) retireClaudeSessionBinding(args.conversationId, claude.sessionId)
  const copilot = getGitHubCopilotSessionBinding(args.conversationId)
  if (copilot) retireGitHubCopilotSessionBinding(args.conversationId, copilot.sessionId)
  const cursor = getCursorAgentBinding(args.conversationId)
  if (cursor) retireCursorAgentBinding(args.conversationId, cursor.agentId)
  return newestAssistant ? { messageId: newestAssistant.id, snapshot } : null
}
