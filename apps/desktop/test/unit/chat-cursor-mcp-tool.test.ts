import { describe, expect, it } from 'vitest'
import { applyChatEvent, findPendingChatQuestion, type ChatMessage } from '../../src/shared/chat'
import {
  isCursorMcpToolEnvelope,
  unwrapCursorMcpToolCall,
  unwrapCursorMcpToolPart,
} from '../../src/shared/cursor-mcp-tool'
import { cursorNameFromSdk, normalizeCursorToolEvent } from '../../src/main/chat/cursor-subscription/tool-bridge'

const envelope = (toolName: string, args: unknown, providerIdentifier = 'custom-user-tools') => ({
  providerIdentifier,
  toolName,
  args,
})

describe('unwrapCursorMcpToolCall', () => {
  it('promotes the nested name and flattens arguments', () => {
    expect(unwrapCursorMcpToolCall('mcp', envelope('grep', { pattern: 'foo', include: '*.ts' }))).toEqual({
      toolName: 'grep',
      input: { pattern: 'foo', include: '*.ts' },
    })
  })

  it('promotes todo_write, ask_question and task', () => {
    expect(unwrapCursorMcpToolCall('mcp', envelope('todo_write', { todos: [] })).toolName).toBe('todo_write')
    expect(unwrapCursorMcpToolCall('mcp', envelope('ask_question', { questions: [] })).toolName).toBe('ask_question')
    expect(unwrapCursorMcpToolCall('mcp', envelope('task', { agent: 'explore', prompt: 'ache X' }))).toEqual({
      toolName: 'task',
      input: { agent: 'explore', prompt: 'ache X' },
    })
  })

  it('promotes third-party MCP envelopes', () => {
    expect(unwrapCursorMcpToolCall('mcp', envelope('jira_search', { jql: 'a' }, 'atlassian'))).toEqual({
      toolName: 'jira_search',
      input: { jql: 'a' },
    })
  })

  it('preserves mcp without an envelope', () => {
    expect(unwrapCursorMcpToolCall('mcp', { command: 'ls' })).toEqual({
      toolName: 'mcp',
      input: { command: 'ls' },
    })
    expect(unwrapCursorMcpToolCall('mcp', undefined)).toEqual({ toolName: 'mcp', input: undefined })
    expect(unwrapCursorMcpToolCall('mcp', 'plain')).toEqual({ toolName: 'mcp', input: 'plain' })
  })

  it('leaves already normalized calls unchanged', () => {
    const first = unwrapCursorMcpToolCall('mcp', envelope('bash', { command: 'ls' }))
    expect(unwrapCursorMcpToolCall(first.toolName, first.input)).toEqual(first)
    expect(unwrapCursorMcpToolCall('bash', { command: 'ls' })).toEqual({
      toolName: 'bash',
      input: { command: 'ls' },
    })
  })

  it('rejects empty nested names and missing provider identifiers', () => {
    expect(unwrapCursorMcpToolCall('mcp', { providerIdentifier: 'custom-user-tools', toolName: '  ' })).toEqual({
      toolName: 'mcp',
      input: { providerIdentifier: 'custom-user-tools', toolName: '  ' },
    })
    expect(unwrapCursorMcpToolCall('mcp', { toolName: 'bash', args: { command: 'ls' } })).toEqual({
      toolName: 'mcp',
      input: { toolName: 'bash', args: { command: 'ls' } },
    })
  })

  it('recognizes only the complete envelope', () => {
    expect(isCursorMcpToolEnvelope(envelope('read', { path: 'a.ts' }))).toBe(true)
    expect(isCursorMcpToolEnvelope({ path: 'a.ts' })).toBe(false)
  })
})

describe('unwrapCursorMcpToolPart', () => {
  it('projects a tool part without mutating the original', () => {
    const part = {
      type: 'tool' as const,
      toolName: 'mcp',
      toolCallId: 'c1',
      input: envelope('read', { path: 'a.ts' }),
    }
    const projected = unwrapCursorMcpToolPart(part)
    expect(projected).toEqual({
      type: 'tool',
      toolName: 'read',
      toolCallId: 'c1',
      input: { path: 'a.ts' },
    })
    expect(part.toolName).toBe('mcp')
    expect(unwrapCursorMcpToolPart(projected)).toBe(projected)
  })
})

describe('normalizeCursorToolEvent', () => {
  const nameFromSdk = (name: string) => cursorNameFromSdk(name, new Set(['task', 'bash', 'todo_write', 'ask_question']))

  it('preserves the nested task name', () => {
    const event = normalizeCursorToolEvent(
      {
        kind: 'tool-call',
        messageId: 'a1',
        toolCallId: 't1',
        toolName: 'mcp',
        input: envelope('task', { agent: 'explore', prompt: 'ache X' }),
      },
      nameFromSdk
    )
    expect(event).toMatchObject({
      kind: 'tool-call',
      toolName: 'task',
      input: { agent: 'explore', prompt: 'ache X' },
    })
  })

  it('preserves task identity when execution and stream events are folded', () => {
    let msgs: ChatMessage[] = [{ id: 'a1', conversationId: 'c1', role: 'assistant', parts: [], createdAt: 1 }]
    msgs = applyChatEvent(msgs, {
      kind: 'tool-input-start',
      messageId: 'a1',
      toolCallId: 't1',
      toolName: 'task',
    })
    msgs = applyChatEvent(msgs, {
      kind: 'tool-call',
      messageId: 'a1',
      toolCallId: 't1',
      toolName: 'task',
      input: { agent: 'explore', prompt: 'ache X' },
    })
    const fromStream = normalizeCursorToolEvent(
      {
        kind: 'tool-call',
        messageId: 'a1',
        toolCallId: 't1',
        toolName: 'mcp',
        input: envelope('task', { agent: 'explore', prompt: 'ache X' }),
      },
      nameFromSdk
    )
    msgs = applyChatEvent(msgs, fromStream)
    const part = msgs[0].parts[0]
    expect(part.type).toBe('tool')
    if (part.type === 'tool') {
      expect(part.toolName).toBe('task')
      expect(part.input).toEqual({ agent: 'explore', prompt: 'ache X' })
    }
  })

  it('normalizes the promoted name through cursorNameFromSdk', () => {
    const event = normalizeCursorToolEvent(
      {
        kind: 'tool-call',
        messageId: 'a1',
        toolCallId: 't1',
        toolName: 'mcp',
        input: envelope('mcp__custom-user-tools__bash', { command: 'ls' }),
      },
      nameFromSdk
    )
    expect(event).toMatchObject({ kind: 'tool-call', toolName: 'bash', input: { command: 'ls' } })
  })
})

describe('findPendingChatQuestion with an MCP envelope', () => {
  it('finds ask_question persisted as an MCP envelope', () => {
    const pending: ChatMessage[] = [
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        parts: [
          {
            type: 'tool',
            id: 'q1',
            toolCallId: 'q1',
            toolName: 'mcp',
            input: envelope('ask_question', {
              questions: [{ header: 'h', question: 'q?', options: [{ label: 'sim' }] }],
            }),
            state: { status: 'running' },
          },
        ],
        createdAt: 1,
      },
    ]
    const found = findPendingChatQuestion(pending)
    expect(found?.toolCallId).toBe('q1')
    expect(found?.questions).toHaveLength(1)
  })
})
