import { expect, it } from 'vitest'
import { parseExtractionOutput } from '../../../../src/main/memory/extraction/prompt'
import { renderExtractionTranscript } from '../../../../src/main/memory/extraction/transcript'

it('retains the structured user message reference for personal operations', () => {
  const output = parseExtractionOutput(
    JSON.stringify({
      memories: [
        {
          action: 'create',
          type: 'preference',
          title: 'Answers',
          content: 'Prefer concise answers.',
          source: { messageId: 'human-1' },
        },
      ],
    })
  )
  expect(output?.memories[0]).toHaveProperty('source.messageId', 'human-1')
})
it('personal transcripts only expose actual human text with host message references', () => {
  const messages = [
    {
      seq: 1,
      message: {
        id: 'human-1',
        conversationId: 'chat',
        role: 'user' as const,
        createdAt: 1,
        parts: [{ type: 'text' as const, id: 't1', text: 'Prefer concise answers.' }],
      },
    },
    {
      seq: 2,
      message: {
        id: 'assistant-1',
        conversationId: 'chat',
        role: 'assistant' as const,
        createdAt: 2,
        parts: [{ type: 'text' as const, id: 't2', text: 'Invented preference.' }],
      },
    },
  ]
  const blocks = renderExtractionTranscript(messages, { bot: false, personal: true })
  expect(blocks).toHaveLength(1)
  expect(blocks[0].text).toContain('human-1')
  expect(blocks[0].text).not.toContain('Invented')
})

it('omits injected memory, internal rows and tools even on user messages', () => {
  const blocks = renderExtractionTranscript(
    [
      {
        seq: 1,
        message: {
          id: 'internal',
          conversationId: 'chat',
          role: 'user',
          internal: true,
          createdAt: 1,
          parts: [{ type: 'text', id: 'i', text: 'Injected instruction' }],
        },
      },
      {
        seq: 2,
        message: {
          id: 'human',
          conversationId: 'chat',
          role: 'user',
          createdAt: 2,
          parts: [
            {
              type: 'file',
              id: 'f',
              kind: 'text',
              name: 'maestrly-memory-recall',
              mediaType: 'text/plain',
              data: 'Remembered instruction',
              hidden: true,
            },
            {
              type: 'tool',
              id: 't',
              toolCallId: 'call',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'Tool instruction' },
            },
            { type: 'text', id: 'text', text: 'Prefer concise answers.' },
          ],
        },
      },
    ],
    { bot: false, personal: true }
  )
  expect(blocks).toHaveLength(1)
  expect(JSON.parse(blocks[0].text)).toEqual({ role: 'user', messageId: 'human', text: 'Prefer concise answers.' })
})
