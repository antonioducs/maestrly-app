import { describe, expect, it } from 'vitest'
import { createAntigravityStreamMapper } from '../../src/main/chat/antigravity-subscription/stream-map'

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as const

describe('Antigravity stream mapper', () => {
  it('opens one text part and streams its deltas', () => {
    const mapper = createAntigravityStreamMapper('m1')
    expect([...mapper.push(chunk('Hel')), ...mapper.push(chunk('lo'))]).toEqual([
      { kind: 'text-start', messageId: 'm1', partId: 'm1:text:0' },
      { kind: 'text-delta', messageId: 'm1', partId: 'm1:text:0', delta: 'Hel' },
      { kind: 'text-delta', messageId: 'm1', partId: 'm1:text:0', delta: 'lo' },
    ])
    expect(mapper.state.text).toBe('Hello')
  })

  it('opens a new text part after a host tool call', () => {
    const mapper = createAntigravityStreamMapper('m1')
    mapper.push(chunk('before'))
    expect(mapper.breakTextPart()).toEqual([])
    expect(mapper.push(chunk('after'))).toEqual([
      { kind: 'text-start', messageId: 'm1', partId: 'm1:text:1' },
      { kind: 'text-delta', messageId: 'm1', partId: 'm1:text:1', delta: 'after' },
    ])
  })

  it('maps thought chunks to reasoning parts', () => {
    const mapper = createAntigravityStreamMapper('m1')
    expect(mapper.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } })).toEqual([
      { kind: 'reasoning-start', messageId: 'm1', partId: 'm1:reasoning:0' },
      { kind: 'reasoning-delta', messageId: 'm1', partId: 'm1:reasoning:0', delta: 'hmm' },
    ])
    expect(mapper.push(chunk('answer'))[0]).toEqual({ kind: 'text-start', messageId: 'm1', partId: 'm1:text:0' })
  })

  it('leaves Maestrly tool events to the host MCP server', () => {
    const mapper = createAntigravityStreamMapper('m1')
    expect(
      mapper.push({
        sessionUpdate: 'tool_call',
        toolCallId: 'x',
        title: 'maestrly_read_file',
        _meta: { mcp: { server: 'maestrly', tool: 'read_file' } },
      })
    ).toEqual([])
    expect(mapper.state.ignoredNativeTools).toEqual([])
  })

  it('records native tool calls without rendering them', () => {
    const mapper = createAntigravityStreamMapper('m1')
    expect(mapper.push({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Run list_resources?' })).toEqual([])
    expect(mapper.push({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'failed' })).toEqual([])
    expect(mapper.state.ignoredNativeTools).toEqual(['Run list_resources?'])
  })

  it('ignores other updates and non-text content', () => {
    const mapper = createAntigravityStreamMapper('m1')
    expect(mapper.push({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toEqual([])
    expect(mapper.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'image' } })).toEqual([])
  })
})
