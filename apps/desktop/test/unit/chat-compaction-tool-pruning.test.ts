import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessagePart } from '../../src/shared/chat'
import {
  applyToolPruning,
  planToolPruning,
  protectedRecentMessageIds,
  toolOutputStub,
} from '../../src/main/chat/compaction/tool-pruning'
import { renderNativeSeedTranscript, toModelMessages } from '../../src/main/chat/message'
import { estimatePortableContextTokens } from '../../src/main/chat/portable-context'
import { backgroundCompactionSourceHash } from '../../src/main/chat/background-compaction/policy'

type ToolPart = Extract<MessagePart, { type: 'tool' }>
const log = (title: string, lines = 200) =>
  `${title}\n${Array.from({ length: lines }, (_, line) => `${title} line ${line}: compiled module`).join('\n')}`
const tool = (id: string, output: string, extra: Partial<ToolPart> = {}): ToolPart => ({
  type: 'tool',
  id,
  toolCallId: id,
  toolName: 'bash',
  input: { command: `run ${id}` },
  state: { status: 'completed', output },
  ...extra,
})
const message = (id: string, role: 'user' | 'assistant', parts: MessagePart[]): ChatMessage => ({
  id,
  conversationId: 'c',
  role,
  createdAt: 0,
  parts,
})
const turn = (index: number): ChatMessage[] => [
  message(`u${index}`, 'user', [{ type: 'text', id: `u${index}-t`, text: `request ${index}` }]),
  message(`a${index}`, 'assistant', [
    { type: 'text', id: `a${index}-t`, text: `answer ${index}` },
    tool(`recent-${index}`, log(`RECENT_${index}`)),
  ]),
]

function history(oldParts: MessagePart[]): ChatMessage[] {
  return [
    message('u0', 'user', [{ type: 'text', id: 'u0-t', text: 'start' }]),
    message('a0', 'assistant', [{ type: 'text', id: 'a0-t', text: 'working' }, ...oldParts]),
    ...turn(1),
    ...turn(2),
    ...turn(3),
  ]
}
const plan = (messages: ChatMessage[], mode: 'stub' | 'clip' = 'stub') =>
  planToolPruning(messages, { protectedIds: protectedRecentMessageIds(messages), mode })

describe('tool output pruning', () => {
  it('stubs older large outputs and keeps the latest three user turns whole', () => {
    const messages = history([tool('old', log('OLD_BUILD'))])
    const targets = plan(messages)
    expect(targets.map((target) => target.partId)).toEqual(['old'])
    expect(targets[0].stub).toBe(
      '[tool bash {"command":"run old"} → completed, 201 lines, ' +
        `${log('OLD_BUILD').length} chars; output removed — rerun or use history_search/history_read]`
    )
    expect(targets[0].savedChars).toBe(log('OLD_BUILD').length - targets[0].stub.length)
  })

  it('never touches unfinished tools, plans, to-do lists, questions, small outputs or existing stubs', () => {
    const big = log('PROTECTED')
    const messages = history([
      tool('running', '', { state: { status: 'running' } }),
      tool('todo', big, { toolName: 'mcp__maestrly__todo_write' }),
      tool('plan', big, { toolName: 'review_plan' }),
      tool('question', big, { toolName: 'ask_question' }),
      tool('small', 'x'.repeat(900)),
      tool('stubbed', big, { contextStub: '[already pruned]' }),
      tool('denied', '', { state: { status: 'denied', reason: 'no' } }),
    ])
    expect(plan(messages)).toEqual([])
  })

  it('keeps the first line of an error', () => {
    const error = `Error: build failed\n${log('STACK')}`
    const [target] = plan(history([tool('failed', '', { state: { status: 'error', error } })]))
    expect(target.stub).toContain('→ error: Error: build failed, ')
    expect(target.stub).not.toContain('STACK')
  })

  it('reduces an output repeated later to a note, even below the size threshold', () => {
    const repeated = 'same listing\n'.repeat(30)
    const messages = history([tool('first', repeated), tool('second', repeated)])
    const targets = plan(messages)
    expect(targets).toEqual([
      expect.objectContaining({ partId: 'first', stub: expect.stringContaining('same output as a later call') }),
    ])
  })

  it('clips older outputs to head and tail for the summarizer', () => {
    const [target] = plan(history([tool('old', log('OLD_BUILD'))]), 'clip')
    expect(target.stub).toContain('OLD_BUILD line 0')
    expect(target.stub).toContain('OLD_BUILD line 199')
    expect(target.stub).toContain('older output clipped for the summary')
    expect(target.stub.length).toBeLessThanOrEqual(1_300)
  })

  it('protects everything when fewer than three user turns exist', () => {
    const messages = [
      message('u', 'user', [{ type: 'text', id: 't', text: 'x' }]),
      message('a', 'assistant', [tool('old', log('OLD'))]),
    ]
    expect(plan(messages)).toEqual([])
  })

  it('sends the stub to the model and native seeds and estimates, keeping the stored output and the source hash', () => {
    const messages = history([tool('old', log('OLD_BUILD', 600))])
    const pruned = applyToolPruning(messages, plan(messages))
    const oldPart = pruned[1].parts.find((part) => part.id === 'old') as ToolPart
    expect(oldPart.state).toEqual((messages[1].parts.find((part) => part.id === 'old') as ToolPart).state)
    expect(oldPart.contextStub).toContain('output removed')
    expect(messages[1].parts.find((part) => part.id === 'old')).not.toHaveProperty('contextStub')

    const model = JSON.stringify(toModelMessages(pruned))
    expect(model).toContain('output removed')
    expect(model).not.toContain('OLD_BUILD line 300')
    expect(model).toContain('RECENT_3 line 100')
    const seed = renderNativeSeedTranscript(pruned)
    expect(seed).toContain('output removed')
    expect(seed).not.toContain('OLD_BUILD line 300')
    expect(estimatePortableContextTokens(pruned)).toBeLessThan(estimatePortableContextTokens(messages) - 5_000)

    const boundary = { messageId: 'a3', partId: 'recent-3', partIndex: 1 }
    expect(backgroundCompactionSourceHash(pruned, boundary)).toBe(backgroundCompactionSourceHash(messages, boundary))
  })

  it('describes a stub with the bare tool name and shortened arguments', () => {
    expect(
      toolOutputStub(tool('t', 'one\ntwo', { toolName: 'mcp__maestrly__read', input: { path: 'a'.repeat(300) } }))
    ).toMatch(/^\[tool read \{"path":"a+…\]? → completed, 2 lines, 7 chars; output removed/)
  })
})
