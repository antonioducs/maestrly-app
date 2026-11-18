import { describe, expect, it } from 'vitest'
import {
  createAntigravityStreamMapper,
  createAntigravityUsageReader,
  readAntigravityContextUsage,
  releasesApiFailure,
} from '../../src/main/chat/antigravity-subscription/stream-map'

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
    expect(mapper.push({ sessionUpdate: 'usage_update', used: 24_310, size: 1_048_576 })).toEqual([])
  })

  it('reads the context occupancy of a usage update', () => {
    expect(readAntigravityContextUsage({ sessionUpdate: 'usage_update', used: 24_310, size: 1_048_576 })).toEqual({
      used: 24_310,
      size: 1_048_576,
    })
    expect(readAntigravityContextUsage({ sessionUpdate: 'usage_update', used: 512.7, size: 0 })).toEqual({ used: 512 })
    expect(readAntigravityContextUsage({ sessionUpdate: 'usage_update', used: -1, size: 100 })).toBeNull()
    expect(readAntigravityContextUsage({ sessionUpdate: 'usage_update', used: '24310', size: 100 })).toBeNull()
    expect(readAntigravityContextUsage(chunk('used 10'))).toBeNull()
  })

  it('splits a usage report that folds several model calls', () => {
    const read = createAntigravityUsageReader()
    expect(read(120_000)).toEqual({ perCall: 120_000, calls: 1 })
    expect(read(133_282)).toEqual({ perCall: 133_282, calls: 1 })
    // A failed call and its retry, reported together.
    expect(read(267_169)).toEqual({ perCall: 133_585, calls: 2 })
    expect(read(140_000)).toEqual({ perCall: 140_000, calls: 1 })
  })

  it('takes a small session doubling as real growth', () => {
    const read = createAntigravityUsageReader()
    read(9_000)
    expect(read(25_000)).toEqual({ perCall: 25_000, calls: 1 })
  })

  it('releases a withheld failure only on updates that continue the turn', () => {
    expect(releasesApiFailure(chunk('more'))).toBe(true)
    expect(releasesApiFailure({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x' } })).toBe(
      true
    )
    expect(releasesApiFailure({ sessionUpdate: 'tool_call', toolCallId: 'x' })).toBe(true)
    expect(releasesApiFailure({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'failed' })).toBe(false)
    expect(releasesApiFailure({ sessionUpdate: 'usage_update', used: 1, size: 2 })).toBe(false)
  })
})
