import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/chat'
import {
  buildAntigravityPromptBlocks,
  buildAntigravitySeedTranscript,
  hashAntigravityInstructions,
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
      text: '<maestrly_instructions>\nBe helpful.\n</maestrly_instructions>\n\n<maestrly_tools>\n- maestrly_echo: Echo\n</maestrly_tools>\n\nECHO hi',
    })
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
})
