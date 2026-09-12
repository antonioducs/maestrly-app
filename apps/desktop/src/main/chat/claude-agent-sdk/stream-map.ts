import type { SDKMessage, SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatStreamEvent, SubagentRunMeta } from '../../../shared/chat'
import { toolOutputImages, toolOutputText, type ToolOutput } from '../../../shared/chat'
import { clipPersistedToolOutput } from '../message'
import { mcpResultToChatToolOutput } from '../tool-output'
import { redactClaudeCredentials } from './errors'
import { normalizeClaudeUsage, type NormalizedClaudeUsage } from './usage'

interface PendingToolCall {
  name: string
  json: string
  input: unknown
  toolUseId?: string
}

export interface ClaudeMappedToolResult {
  toolCallId: string
  isError: boolean
}

export interface ClaudeMappedUserMessage {
  events: ChatStreamEvent[]
  toolResults: ClaudeMappedToolResult[]
}

export interface ClaudeStreamMapperState {
  lastAssistantUuid: string | null
  lastAssistantModelId: string | null
  latestAssistantUsage: NormalizedClaudeUsage | null
  assistantUsageByMessageId: ReadonlyMap<string, NormalizedClaudeUsage>
}

export interface ClaudeStreamMapper {
  pushPartial(message: SDKPartialAssistantMessage): ChatStreamEvent[]
  pushAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): ChatStreamEvent[]
  pushUser(
    message: Extract<SDKMessage, { type: 'user' }>,
    subagentRuns?: ReadonlyMap<string, SubagentRunMeta>,
    canonicalOutputFor?: (toolCallId: string) => ToolOutput | undefined
  ): ClaudeMappedUserMessage
  tool(toolCallId: string): Readonly<PendingToolCall> | undefined
  state(): ClaudeStreamMapperState
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((entry) => (isRecord(entry) && typeof entry.text === 'string' ? entry.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Pure SDK-to-chat mapper. It owns only transient folding/deduplication state
 * and returns events; persistence and lifecycle decisions remain in the runner.
 */
export function createClaudeStreamMapper(
  messageId: string,
  normalizeToolName: (toolName: string) => string
): ClaudeStreamMapper {
  const startedText = new Set<string>()
  const startedReasoning = new Set<string>()
  const toolCalls = new Map<string, PendingToolCall>()
  const streamedTextMessageIds = new Set<string>()
  const streamedReasoningMessageIds = new Set<string>()
  const assistantUsageByMessageId = new Map<string, NormalizedClaudeUsage>()
  let activeStreamMessageId: string | null = null
  let lastAssistantUuid: string | null = null
  let lastAssistantModelId: string | null = null
  let latestAssistantUsage: NormalizedClaudeUsage | null = null

  const ensureTool = (toolCallId: string, toolName: string, input: unknown): ChatStreamEvent[] => {
    if (toolCalls.has(toolCallId)) return []
    const normalized = normalizeToolName(toolName)
    toolCalls.set(toolCallId, { name: normalized, json: '', input })
    return [
      { kind: 'tool-input-start', messageId, toolCallId, toolName: normalized },
      { kind: 'tool-call', messageId, toolCallId, toolName: normalized, input },
      { kind: 'tool-state', messageId, toolCallId, state: { status: 'running' } },
    ]
  }

  const finalizePartialTool = (index: number, apiMessageId: string): ChatStreamEvent[] => {
    const key = `${apiMessageId}:${index}`
    const call = toolCalls.get(key)
    if (!call) return []
    let input = call.input
    if (call.json) {
      try {
        input = JSON.parse(call.json)
      } catch {
        input = call.input
      }
    }
    toolCalls.delete(key)
    return ensureTool(call.toolUseId ?? key, call.name, input)
  }

  const pushPartial = (message: SDKPartialAssistantMessage): ChatStreamEvent[] => {
    const event = message.event as unknown as Record<string, unknown>
    if (event.type === 'message_start') {
      const apiMessage = isRecord(event.message) ? event.message : {}
      activeStreamMessageId = typeof apiMessage.id === 'string' ? apiMessage.id : null
      return []
    }
    if (event.type === 'message_stop') {
      activeStreamMessageId = null
      return []
    }
    const apiMessageId = activeStreamMessageId
    if (!apiMessageId) return []
    const index = Number(event.index) || 0
    const key = `${apiMessageId}:${index}`
    const appendText = (text: string): ChatStreamEvent[] => {
      if (!text) return []
      const partId = `claude_text_${key}`
      const events: ChatStreamEvent[] = []
      if (!startedText.has(partId)) {
        startedText.add(partId)
        events.push({ kind: 'text-start', messageId, partId })
      }
      streamedTextMessageIds.add(apiMessageId)
      events.push({ kind: 'text-delta', messageId, partId, delta: text })
      return events
    }
    const appendReasoning = (text: string): ChatStreamEvent[] => {
      if (!text) return []
      const partId = `claude_reasoning_${key}`
      const events: ChatStreamEvent[] = []
      if (!startedReasoning.has(partId)) {
        startedReasoning.add(partId)
        events.push({ kind: 'reasoning-start', messageId, partId })
      }
      streamedReasoningMessageIds.add(apiMessageId)
      events.push({ kind: 'reasoning-delta', messageId, partId, delta: text })
      return events
    }
    if (event.type === 'content_block_start') {
      const block = isRecord(event.content_block) ? event.content_block : {}
      if (block.type === 'text' && typeof block.text === 'string') return appendText(block.text)
      if (block.type === 'thinking' && typeof block.thinking === 'string') return appendReasoning(block.thinking)
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        toolCalls.set(key, {
          name: block.name,
          json: '',
          input: isRecord(block.input) ? block.input : {},
          toolUseId: block.id,
        })
      }
      return []
    }
    if (event.type === 'content_block_delta') {
      const delta = isRecord(event.delta) ? event.delta : {}
      if (delta.type === 'text_delta' && typeof delta.text === 'string') return appendText(delta.text)
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        return appendReasoning(delta.thinking)
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const call = toolCalls.get(key)
        if (call) call.json += delta.partial_json
      }
      return []
    }
    return event.type === 'content_block_stop' ? finalizePartialTool(index, apiMessageId) : []
  }

  const pushAssistant = (message: Extract<SDKMessage, { type: 'assistant' }>): ChatStreamEvent[] => {
    lastAssistantUuid = message.uuid
    lastAssistantModelId = message.message.model
    latestAssistantUsage = normalizeClaudeUsage(message.message.usage)
    assistantUsageByMessageId.set(message.message.id, latestAssistantUsage)
    const events: ChatStreamEvent[] = []
    message.message.content.forEach((block, index) => {
      if (block.type === 'tool_use') {
        events.push(...ensureTool(block.id, block.name, block.input))
      } else if (block.type === 'text' && block.text && !streamedTextMessageIds.has(message.message.id)) {
        const partId = `claude_text_${message.uuid}_${index}`
        events.push({ kind: 'text-start', messageId, partId })
        events.push({ kind: 'text-delta', messageId, partId, delta: block.text })
      } else if (
        block.type === 'thinking' &&
        'thinking' in block &&
        block.thinking &&
        !streamedReasoningMessageIds.has(message.message.id)
      ) {
        const partId = `claude_reasoning_${message.uuid}_${index}`
        events.push({ kind: 'reasoning-start', messageId, partId })
        events.push({ kind: 'reasoning-delta', messageId, partId, delta: block.thinking })
      }
    })
    return events
  }

  const pushUser = (
    message: Extract<SDKMessage, { type: 'user' }>,
    subagentRuns: ReadonlyMap<string, SubagentRunMeta> = new Map(),
    canonicalOutputFor?: (toolCallId: string) => ToolOutput | undefined
  ): ClaudeMappedUserMessage => {
    const events: ChatStreamEvent[] = []
    const toolResults: ClaudeMappedToolResult[] = []
    const content = Array.isArray(message.message.content) ? message.message.content : []
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const toolCallId = block.tool_use_id
      const call = toolCalls.get(toolCallId)
      const sub = subagentRuns.get(toolCallId)
      const providerText = toolResultText(block.content)
      const chatOutput =
        canonicalOutputFor?.(toolCallId) ??
        mcpResultToChatToolOutput({
          content: Array.isArray(block.content) ? block.content : [{ type: 'text', text: providerText }],
          isError: block.is_error === true,
        })
      const stateOutput =
        typeof chatOutput !== 'string' &&
        (toolOutputImages(chatOutput).length > 0 || chatOutput.structuredContent !== undefined)
          ? chatOutput
          : toolOutputText(chatOutput)
      events.push(...ensureTool(toolCallId, call?.name ?? 'tool', call?.input ?? {}))
      const isError = block.is_error === true
      events.push({
        kind: 'tool-state',
        messageId,
        toolCallId,
        state: isError
          ? {
              status: 'error',
              error: redactClaudeCredentials(clipPersistedToolOutput(providerText || 'Tool failed.')),
              ...(sub ? { sub } : {}),
            }
          : {
              status: 'completed',
              output:
                typeof stateOutput === 'string' ? clipPersistedToolOutput(stateOutput || '(no output)') : stateOutput,
              ...(sub ? { sub } : {}),
            },
      })
      toolResults.push({ toolCallId, isError })
    }
    return { events, toolResults }
  }

  return {
    pushPartial,
    pushAssistant,
    pushUser,
    tool: (toolCallId) => toolCalls.get(toolCallId),
    state: () => ({
      lastAssistantUuid,
      lastAssistantModelId,
      latestAssistantUsage,
      assistantUsageByMessageId,
    }),
  }
}
