import type { ChatStreamEvent } from '../../../shared/chat'
import { type AcpSessionUpdate, isAcpMessageChunk, isAcpToolCallUpdate } from '../acp/protocol'
import { ANTIGRAVITY_HOST_MCP_SERVER_NAME } from './permissions'

export interface AntigravityStreamMapper {
  push(update: AcpSessionUpdate): ChatStreamEvent[]
  /** Called before host tool events so later text opens a new text part. */
  breakTextPart(): ChatStreamEvent[]
  readonly state: { text: string; ignoredNativeTools: string[] }
}

/**
 * Maps ACP `session/update` notifications to Maestrly chat events. Tool cards are not built here: Maestrly's
 * loopback MCP server executes host tools and emits their events itself, and native Antigravity tools are denied.
 */
export function createAntigravityStreamMapper(messageId: string): AntigravityStreamMapper {
  const state = { text: '', ignoredNativeTools: [] as string[] }
  const nativeToolCalls = new Set<string>()
  let textSeq = 0
  let reasoningSeq = 0
  let activeText: string | null = null
  let activeReasoning: string | null = null

  const push = (update: AcpSessionUpdate): ChatStreamEvent[] => {
    if (isAcpMessageChunk(update)) {
      const content = update.content as { type?: string; text?: unknown }
      if (content?.type !== 'text' || typeof content.text !== 'string' || !content.text) return []
      const events: ChatStreamEvent[] = []
      if (update.sessionUpdate === 'agent_thought_chunk') {
        if (!activeReasoning) {
          activeReasoning = `${messageId}:reasoning:${reasoningSeq++}`
          events.push({ kind: 'reasoning-start', messageId, partId: activeReasoning })
        }
        events.push({ kind: 'reasoning-delta', messageId, partId: activeReasoning, delta: content.text })
        return events
      }
      activeReasoning = null
      if (!activeText) {
        activeText = `${messageId}:text:${textSeq++}`
        events.push({ kind: 'text-start', messageId, partId: activeText })
      }
      state.text += content.text
      events.push({ kind: 'text-delta', messageId, partId: activeText, delta: content.text })
      return events
    }
    if (isAcpToolCallUpdate(update)) {
      if (update._meta?.mcp?.server === ANTIGRAVITY_HOST_MCP_SERVER_NAME) return []
      if (update.sessionUpdate === 'tool_call' && !nativeToolCalls.has(update.toolCallId)) {
        nativeToolCalls.add(update.toolCallId)
        state.ignoredNativeTools.push(update.title ?? update.toolCallId)
      }
      return []
    }
    return []
  }

  return {
    push,
    breakTextPart() {
      activeText = null
      activeReasoning = null
      return []
    },
    state,
  }
}
