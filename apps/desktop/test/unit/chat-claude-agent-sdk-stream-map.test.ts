import { describe, expect, it } from 'vitest'
import type { SubagentRunMeta } from '../../src/shared/chat'
import { toolOutputImages } from '../../src/shared/chat'
import { createClaudeStreamMapper } from '../../src/main/chat/claude-agent-sdk/stream-map'
import { mcpResultToChatToolOutput, toolOutputToMcpCallResult } from '../../src/main/chat/tool-output'

function mapper() {
  return createClaudeStreamMapper('assistant-1', (name) => (name === 'Read' ? 'read' : name))
}

describe('Claude Agent SDK stream mapper', () => {
  it('deduplicates consolidated text and reasoning after partial envelopes by API message id', () => {
    const map = mapper()
    map.pushPartial({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'api-message-1' } },
    } as never)
    const text = map.pushPartial({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello' } },
    } as never)
    const thinking = map.pushPartial({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'considering' },
      },
    } as never)
    const consolidated = map.pushAssistant({
      type: 'assistant',
      uuid: 'sdk-assistant-1',
      parent_tool_use_id: null,
      message: {
        id: 'api-message-1',
        model: 'claude-opus',
        usage: { input_tokens: 10, output_tokens: 2 },
        content: [
          { type: 'thinking', thinking: 'considering', signature: 'signature' },
          { type: 'text', text: 'hello' },
        ],
      },
    } as never)

    expect(text.map((event) => event.kind)).toEqual(['text-start', 'text-delta'])
    expect(thinking.map((event) => event.kind)).toEqual(['reasoning-start', 'reasoning-delta'])
    expect(consolidated).toEqual([])
    expect(map.state()).toMatchObject({
      lastAssistantUuid: 'sdk-assistant-1',
      lastAssistantModelId: 'claude-opus',
      latestAssistantUsage: { input: 10, output: 2 },
    })
  })

  it('folds fragmented tool JSON once and normalizes the tool name', () => {
    const map = mapper()
    map.pushPartial({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'api-message-1' } },
    } as never)
    map.pushPartial({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
      },
    } as never)
    map.pushPartial({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      },
    } as never)
    map.pushPartial({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"/tmp/a"}' },
      },
    } as never)
    const events = map.pushPartial({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_stop', index: 0 },
    } as never)

    expect(events).toEqual([
      {
        kind: 'tool-input-start',
        messageId: 'assistant-1',
        toolCallId: 'tool-1',
        toolName: 'read',
      },
      {
        kind: 'tool-call',
        messageId: 'assistant-1',
        toolCallId: 'tool-1',
        toolName: 'read',
        input: { path: '/tmp/a' },
      },
      {
        kind: 'tool-state',
        messageId: 'assistant-1',
        toolCallId: 'tool-1',
        state: { status: 'running' },
      },
    ])
    expect(
      map.pushAssistant({
        type: 'assistant',
        uuid: 'sdk-assistant-1',
        parent_tool_use_id: null,
        message: {
          id: 'api-message-1',
          model: 'claude-opus',
          usage: {},
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/a' } }],
        },
      } as never)
    ).toEqual([])
  })

  it('preserves subagent metadata and redacts credentials in failed tool results', () => {
    const map = mapper()
    const sub = {
      profile: {
        requested: { providerId: 'claude-subscription', modelId: 'claude-opus' },
        effective: { providerId: 'claude-subscription', modelId: 'claude-opus' },
      },
      usage: { input: 3, output: 1, cacheRead: 0, cacheCreate: 0 },
    } as unknown as SubagentRunMeta
    const mapped = map.pushUser(
      {
        type: 'user',
        uuid: 'sdk-user-1',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-task',
              is_error: true,
              content: 'Authorization: Bearer private-runtime-token',
            },
          ],
        },
      } as never,
      new Map([['tool-task', sub]])
    )
    const final = mapped.events.at(-1)

    expect(mapped.toolResults).toEqual([{ toolCallId: 'tool-task', isError: true }])
    expect(final).toMatchObject({
      kind: 'tool-state',
      toolCallId: 'tool-task',
      state: { status: 'error', sub },
    })
    expect(JSON.stringify(final)).not.toContain('private-runtime-token')
  })

  it('reuses the host image handle when Claude echoes a tool result', () => {
    const original = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const originalImage = toolOutputImages(original)[0]
    const echoed = toolOutputToMcpCallResult(original)
    const mapped = mapper().pushUser({
      type: 'user',
      uuid: 'sdk-user-image-1',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ tool_use_id: 'tool-image', type: 'tool_result', content: echoed.content }],
      },
    } as never)
    const final = mapped.events.at(-1)

    expect(originalImage).toBeDefined()
    expect(final?.kind).toBe('tool-state')
    if (final?.kind === 'tool-state' && final.state.status === 'completed') {
      expect(toolOutputImages(final.state.output)).toHaveLength(1)
      expect(toolOutputImages(final.state.output)[0]?.id).toBe(originalImage?.id)
    }
  })
})
