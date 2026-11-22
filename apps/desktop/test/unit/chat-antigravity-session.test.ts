import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/chat'
import { AntigravityPromptTooLargeError } from '../../src/main/chat/antigravity-subscription/errors'
import {
  ANTIGRAVITY_PROMPT_TEXT_MAX_BYTES,
  ANTIGRAVITY_RUNTIME_PROMPT_MAX_BYTES,
  antigravityIsolatedPromptText,
  antigravityPromptTextBytes,
  antigravitySummaryChunkBytes,
  assertAntigravityPromptFits,
} from '../../src/main/chat/antigravity-subscription/prompt-limit'
import {
  ANTIGRAVITY_CONDENSED_SEED_NOTE,
  ANTIGRAVITY_MESSAGE_ANCHOR,
  buildAntigravityPromptBlocks,
  buildAntigravitySeedTranscript,
  hashAntigravityInstructions,
  pruneAntigravitySeedHistory,
} from '../../src/main/chat/antigravity-subscription/session'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function user(parts: ChatMessage['parts'], id = 'u1'): ChatMessage {
  return { id, conversationId: 'c1', role: 'user', parts, createdAt: 1 } as ChatMessage
}

const text = (value: string) => ({ type: 'text', id: `t-${value}`, text: value }) as ChatMessage['parts'][number]
const image = {
  type: 'file',
  id: 'f1',
  kind: 'image',
  name: 'shot.png',
  mediaType: 'image/png',
  data: `data:image/png;base64,${PNG}`,
} as unknown as ChatMessage['parts'][number]

describe('Antigravity prompt blocks', () => {
  it('puts instructions and the tool catalog before the message of a new session', () => {
    const [block] = buildAntigravityPromptBlocks({
      conversationId: 'c1',
      message: user([text('ECHO hi')]),
      newSession: true,
      instructions: 'Be helpful.',
      toolCatalog: '<maestrly_tools>\n- maestrly_echo: Echo\n</maestrly_tools>',
      seedTranscript: '',
      dropImages: false,
    })
    expect(block).toEqual({
      type: 'text',
      text: `<maestrly_instructions>\nBe helpful.\n</maestrly_instructions>\n\n<maestrly_tools>\n- maestrly_echo: Echo\n</maestrly_tools>\n\n${ANTIGRAVITY_MESSAGE_ANCHOR}\n\nECHO hi`,
    })
  })

  it('puts the context first and the message last: seed, current environment, then the bridge to the message', () => {
    const history = [
      user([text('first question')], 'u0'),
      { id: 'a0', conversationId: 'c1', role: 'assistant', parts: [text('first answer')], createdAt: 2 } as ChatMessage,
      user([text('follow-up')]),
    ]
    const [block] = buildAntigravityPromptBlocks({
      conversationId: 'c1',
      message: history[2],
      newSession: true,
      instructions: 'i',
      toolCatalog: '<maestrly_tools></maestrly_tools>',
      seedTranscript: buildAntigravitySeedTranscript(history),
      dropImages: false,
      environment: "Today's date: 2026-10-19.",
      turnReminder: 'REMINDER',
    })
    const value = (block as { text: string }).text
    const order = [
      '<maestrly_instructions>',
      '<maestrly_tools>',
      'first answer',
      "Today's date",
      ANTIGRAVITY_MESSAGE_ANCHOR,
    ]
    const positions = order.map((marker) => value.indexOf(marker))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    // The full instructions already carry what the reminder restates.
    expect(value).not.toContain('REMINDER')
    expect(value.endsWith(`${ANTIGRAVITY_MESSAGE_ANCHOR}\n\nfollow-up`)).toBe(true)
  })

  it('gives a continuing session the reminder and the current environment before the message', () => {
    expect(
      buildAntigravityPromptBlocks({
        conversationId: 'c1',
        message: user([text('next')]),
        newSession: false,
        instructions: 'Be helpful.',
        toolCatalog: '<maestrly_tools></maestrly_tools>',
        seedTranscript: '',
        dropImages: false,
        environment: "Today's date: 2026-10-20.",
        turnReminder: 'Maestrly mode: agent.',
      })
    ).toEqual([
      {
        type: 'text',
        text: "<maestrly_turn_context>\nMaestrly mode: agent.\nToday's date: 2026-10-20.\n</maestrly_turn_context>\n\nnext",
      },
    ])
  })

  it('sends only the message to a continuing session', () => {
    expect(
      buildAntigravityPromptBlocks({
        conversationId: 'c1',
        message: user([text('next')]),
        newSession: false,
        instructions: 'Be helpful.',
        toolCatalog: '<maestrly_tools></maestrly_tools>',
        seedTranscript: '',
        dropImages: false,
      })
    ).toEqual([{ type: 'text', text: 'next' }])
  })

  it('adds the transcript seed before the message', () => {
    const history = [
      user([text('first question')], 'u0'),
      { id: 'a0', conversationId: 'c1', role: 'assistant', parts: [text('first answer')], createdAt: 2 } as ChatMessage,
      user([text('follow-up')]),
    ]
    const seed = buildAntigravitySeedTranscript(history)
    expect(seed).toContain('first question')
    expect(seed).toContain('first answer')
    expect(seed).not.toContain('follow-up')
    const [block] = buildAntigravityPromptBlocks({
      conversationId: 'c1',
      message: history[2],
      newSession: true,
      instructions: 'i',
      toolCatalog: '',
      seedTranscript: seed,
      dropImages: false,
    })
    const value = (block as { text: string }).text
    expect(value.indexOf('first answer')).toBeLessThan(value.indexOf('follow-up'))
    expect(value.endsWith('follow-up')).toBe(true)
  })

  it('sends attached images as native image blocks, or as text when the model cannot see them', () => {
    const blocks = buildAntigravityPromptBlocks({
      conversationId: 'c1',
      message: user([text('what is this?'), image]),
      newSession: false,
      instructions: '',
      toolCatalog: '',
      seedTranscript: '',
      dropImages: false,
    })
    expect(blocks).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', mimeType: 'image/png', data: PNG },
    ])
    const dropped = buildAntigravityPromptBlocks({
      conversationId: 'c1',
      message: user([text('what is this?'), image]),
      newSession: false,
      instructions: '',
      toolCatalog: '',
      seedTranscript: '',
      dropImages: true,
    })
    expect(dropped).toHaveLength(1)
    expect((dropped[0] as { text: string }).text).toContain('shot.png')
  })

  it('hashes instructions deterministically', () => {
    expect(hashAntigravityInstructions('a')).toBe(hashAntigravityInstructions('a'))
    expect(hashAntigravityInstructions('a')).not.toBe(hashAntigravityInstructions('b'))
  })

  it('seeds from a summary made during the turn instead of the history it replaced', () => {
    const history = [
      user([text('first question')], 'u0'),
      { id: 'a0', conversationId: 'c1', role: 'assistant', parts: [text('first answer')], createdAt: 2 } as ChatMessage,
      user([text('follow-up')]),
    ]
    const live = {
      id: 'a1',
      conversationId: 'c1',
      role: 'assistant',
      parts: [{ type: 'compaction', id: 'k1', text: 'Earlier work summary.', strategy: 'summary' }],
      createdAt: 3,
    } as unknown as ChatMessage
    expect(buildAntigravitySeedTranscript(history, live)).toBe('Previous summary:\nEarlier work summary.')
  })

  it('follows a condensed seed with the note on the history tools, and only then', () => {
    const build = (seedTranscript: string, seedCondensed?: boolean) =>
      (
        buildAntigravityPromptBlocks({
          conversationId: 'c1',
          message: user([text('follow-up')]),
          newSession: true,
          instructions: 'i',
          toolCatalog: '',
          seedTranscript,
          seedCondensed,
          dropImages: false,
        })[0] as { text: string }
      ).text
    const condensed = build('User: first question', true)
    expect(condensed).toContain(`User: first question\n\n${ANTIGRAVITY_CONDENSED_SEED_NOTE}\n\n`)
    expect(condensed.indexOf(ANTIGRAVITY_CONDENSED_SEED_NOTE)).toBeLessThan(
      condensed.indexOf(ANTIGRAVITY_MESSAGE_ANCHOR)
    )
    expect(build('User: first question', false)).not.toContain(ANTIGRAVITY_CONDENSED_SEED_NOTE)
    expect(build('', true)).not.toContain(ANTIGRAVITY_CONDENSED_SEED_NOTE)
  })
})

describe('Antigravity seed pruning', () => {
  const log = (title: string) =>
    Array.from({ length: 200 }, (_, line) => `${title} line ${line}: compiled module`).join('\n')
  const toolPart = (id: string, output: string) =>
    ({
      type: 'tool',
      id,
      toolCallId: id,
      toolName: 'bash',
      input: { command: `run ${id}` },
      state: { status: 'completed', output },
    }) as ChatMessage['parts'][number]
  const assistant = (id: string, parts: ChatMessage['parts']) =>
    ({ id, conversationId: 'c1', role: 'assistant', parts, createdAt: 2 }) as ChatMessage
  const turns = (from: number, count: number) =>
    Array.from({ length: count }, (_, offset) => from + offset).flatMap((index) => [
      user([text(`request ${index}`)], `u${index}`),
      assistant(`a${index}`, [text(`answer ${index}`), toolPart(`recent-${index}`, log(`RECENT_${index}`))]),
    ])

  it('stubs older tool outputs in the seed and leaves the stored messages and every text untouched', () => {
    const history = [
      user([text('start')], 'u0'),
      assistant('a0', [text('decided: keep the API stable'), toolPart('old', log('OLD_BUILD'))]),
      ...turns(1, 3),
      user([text('current request')], 'current'),
    ]
    const pruned = pruneAntigravitySeedHistory(history)
    expect(pruned.stubs).toBe(1)
    const seed = buildAntigravitySeedTranscript(pruned.history)
    expect(seed).toContain('decided: keep the API stable')
    expect(seed).toContain('output removed — rerun or use history_search/history_read')
    expect(seed).not.toContain('OLD_BUILD line 5:')
    for (const index of [1, 2, 3]) expect(seed).toContain(`RECENT_${index} line 5:`)
    expect(seed).not.toContain('current request')
    expect(buildAntigravitySeedTranscript(history)).toContain('OLD_BUILD line 5:')
    expect(history[1].parts.some((part) => part.type === 'tool' && part.contextStub)).toBe(false)
  })

  it('protects the three turns before the current message, which does not count as one of them', () => {
    const history = [user([text('start')], 'u0'), ...turns(1, 3), user([text('current request')], 'current')]
    expect(pruneAntigravitySeedHistory(history).stubs).toBe(0)
  })

  it('prunes the verbatim tail that follows a summary', () => {
    const history = [
      user([text('start')], 'u0'),
      assistant('a0', [
        toolPart('summarized', log('SUMMARIZED')),
        { type: 'compaction', id: 'k1', text: 'Earlier work summary.', strategy: 'summary' } as never,
      ]),
      assistant('a-tail', [text('tail answer'), toolPart('tail', log('TAIL_BUILD'))]),
      ...turns(1, 3),
      user([text('current request')], 'current'),
    ]
    const pruned = pruneAntigravitySeedHistory(history)
    expect(pruned.stubs).toBe(1)
    const seed = buildAntigravitySeedTranscript(pruned.history)
    expect(seed).toContain('Earlier work summary.')
    expect(seed).toContain('tail answer')
    expect(seed).not.toContain('TAIL_BUILD line 5:')
  })
})

describe('Antigravity prompt limit', () => {
  it('counts the UTF-8 bytes of text blocks and ignores image data', () => {
    expect(
      antigravityPromptTextBytes([
        { type: 'text', text: 'ação' },
        { type: 'image', mimeType: 'image/png', data: PNG },
        { type: 'text', text: 'ok' },
      ])
    ).toBe(8)
  })

  it('accepts a prompt at the limit and rejects one byte more before the runtime would cut it', () => {
    expect(ANTIGRAVITY_PROMPT_TEXT_MAX_BYTES).toBeLessThan(ANTIGRAVITY_RUNTIME_PROMPT_MAX_BYTES)
    expect(() =>
      assertAntigravityPromptFits([{ type: 'text', text: 'x'.repeat(ANTIGRAVITY_PROMPT_TEXT_MAX_BYTES) }])
    ).not.toThrow()
    const oversized = () =>
      assertAntigravityPromptFits([{ type: 'text', text: 'x'.repeat(ANTIGRAVITY_PROMPT_TEXT_MAX_BYTES + 1) }])
    expect(oversized).toThrow(AntigravityPromptTooLargeError)
    expect(oversized).toThrow(/Nothing was sent/)
  })

  it('sizes summary chunks so the wrapped stage prompt stays within the limit', () => {
    const system = 'Summarize the conversation. ✓'.repeat(200)
    const label =
      'Source chunk 120/120:\nReturn no more than 1000000 portable tokens (conservative UTF-8 estimate).\n\n'
    const chunk = 'é'.repeat(Math.floor(antigravitySummaryChunkBytes(system) / 2))
    const prompt = antigravityIsolatedPromptText(system, `${label}${chunk}`)
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(ANTIGRAVITY_PROMPT_TEXT_MAX_BYTES)
    expect(antigravitySummaryChunkBytes(system)).toBeGreaterThan(150_000)
  })
})
