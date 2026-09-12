import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolOutput } from '../../src/shared/chat'
import { buildOpenAIModelMessages } from '../../src/main/chat/openai/history'
import {
  chatToolOutputToAiSdkOutput,
  clearEphemeralToolImages,
  mcpResultToChatToolOutput,
} from '../../src/main/chat/tool-output'
import {
  appendOpenAIOpaqueResponseItem,
  appendOpenAIResponsesModelMessages,
  captureOpenAIResponsesModelMessages,
  captureOpenAIResponsesStream,
  createOpenAIResponsesLedger,
  parseOpenAIResponsesLedger,
  patchOpenAILedgerToolOutputs,
  reduceOpenAIResponsesStreamEvent,
  replayOpenAIResponsesLedger,
  toOpenAILedgerValue,
} from '../../src/main/chat/openai/ledger'
import type { OpenAIStreamEventLike } from '../../src/main/chat/openai/types'

describe('OpenAI Responses ledger', () => {
  it('round-trips ordered native items and unknown metadata losslessly', () => {
    const events: OpenAIStreamEventLike[] = [
      {
        type: 'reasoning-start',
        id: 'rs_1:0',
        providerMetadata: {
          openai: { itemId: 'rs_1', future: { fromStart: true } },
          futureProvider: { trace: 'keep-me' },
        },
      },
      {
        type: 'reasoning-delta',
        id: 'rs_1:0',
        text: 'I should inspect the repository.',
        providerMetadata: { openai: { summaryFormat: 'vNext' } },
      },
      {
        type: 'reasoning-end',
        id: 'rs_1:0',
        providerMetadata: {
          openai: {
            itemId: 'rs_1',
            reasoningEncryptedContent: 'encrypted-reasoning',
            future: { fromEnd: true },
          },
        },
      },
      {
        type: 'text-start',
        id: 'msg_1',
        providerMetadata: { openai: { itemId: 'msg_1', phase: 'commentary' } },
      },
      { type: 'text-delta', id: 'msg_1', text: 'I will open the files.' },
      {
        type: 'text-end',
        id: 'msg_1',
        providerMetadata: {
          openai: { itemId: 'msg_1', annotations: [{ type: 'future_annotation', value: 7 }] },
        },
      },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'read',
        input: { path: 'src/main.ts' },
        providerMetadata: {
          openai: { itemId: 'fc_1', namespace: 'workspace', futureToolField: { value: 1 } },
        },
      },
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'read',
        output: 'file contents',
      },
      {
        type: 'finish-step',
        finishReason: 'tool-calls',
        response: { id: 'resp_1' },
        providerMetadata: { openai: { responseId: 'resp_1', futureResponseField: true } },
      },
    ]

    const captured = captureOpenAIResponsesStream(events)
    const persisted = parseOpenAIResponsesLedger(JSON.parse(JSON.stringify(captured)))
    const replay = replayOpenAIResponsesLedger(persisted)

    expect(persisted).toMatchObject({ version: 1, provider: 'openai-responses', store: false })
    expect(persisted.entries.map((entry) => entry.type)).toEqual([
      'assistant-reasoning',
      'assistant-text',
      'tool-call',
      'tool-result',
      'step-boundary',
    ])
    expect(replay).toMatchObject({ lossless: true, requiresRawResponsesInput: false, issues: [] })
    expect(replay.messages).toHaveLength(2)

    const assistant = replay.messages[0]
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toEqual([
      {
        type: 'reasoning',
        text: 'I should inspect the repository.',
        providerOptions: {
          openai: {
            itemId: 'rs_1',
            summaryFormat: 'vNext',
            reasoningEncryptedContent: 'encrypted-reasoning',
            future: { fromStart: true, fromEnd: true },
          },
          futureProvider: { trace: 'keep-me' },
        },
      },
      {
        type: 'text',
        text: 'I will open the files.',
        providerOptions: {
          openai: {
            itemId: 'msg_1',
            phase: 'commentary',
            annotations: [{ type: 'future_annotation', value: 7 }],
          },
        },
      },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'read',
        input: { path: 'src/main.ts' },
        providerOptions: {
          openai: { itemId: 'fc_1', namespace: 'workspace', futureToolField: { value: 1 } },
        },
      },
    ])
    expect(replay.messages[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'read',
          output: { type: 'text', value: 'file contents' },
        },
      ],
    })
    expect(persisted.entries.at(-1)).toEqual({
      type: 'step-boundary',
      finishReason: 'tool-calls',
      responseId: 'resp_1',
      providerMetadata: { openai: { responseId: 'resp_1', futureResponseField: true } },
    })
  })

  it('folds native and ordinary tool errors into persistable terminal outputs', () => {
    const denial = Object.assign(new Error('not allowed'), { name: 'PermissionRejectedError' })
    const ledger = captureOpenAIResponsesStream([
      { type: 'tool-call', toolCallId: 'call-read-error', toolName: 'read', input: { path: 'missing' } },
      {
        type: 'tool-error',
        toolCallId: 'call-read-error',
        toolName: 'read',
        error: new Error('ENOENT'),
      },
      {
        type: 'tool-call',
        toolCallId: 'call-native-denied',
        toolName: 'apply_patch',
        input: { callId: 'call-native-denied', operation: { type: 'delete_file', path: 'safe.txt' } },
      },
      {
        type: 'tool-error',
        toolCallId: 'call-native-denied',
        toolName: 'apply_patch',
        error: denial,
      },
      { type: 'finish-step', finishReason: 'tool-calls' },
    ])

    const persisted = parseOpenAIResponsesLedger(JSON.parse(JSON.stringify(ledger)))
    expect(persisted.entries.filter((entry) => entry.type === 'tool-result')).toMatchObject([
      { output: { type: 'error-text', value: 'ENOENT' } },
      {
        output: {
          type: 'json',
          value: { status: 'failed', output: 'Maestrly permission denied: not allowed' },
        },
      },
    ])
    expect(replayOpenAIResponsesLedger(persisted)).toMatchObject({ lossless: true, issues: [] })
  })

  it('preserves parallel calls and step boundaries', () => {
    let ledger = createOpenAIResponsesLedger()
    for (const event of [
      {
        type: 'tool-call',
        toolCallId: 'call_a',
        toolName: 'read',
        input: { path: 'a.ts' },
        providerMetadata: { openai: { itemId: 'fc_a' } },
      },
      {
        type: 'tool-call',
        toolCallId: 'call_b',
        toolName: 'read',
        input: { path: 'b.ts' },
        providerMetadata: { openai: { itemId: 'fc_b' } },
      },
      { type: 'tool-result', toolCallId: 'call_a', toolName: 'read', output: 'A' },
      { type: 'tool-result', toolCallId: 'call_b', toolName: 'read', output: 'B' },
      { type: 'finish-step', finishReason: 'tool-calls' },
      {
        type: 'text-start',
        id: 'msg_final',
        providerMetadata: { openai: { itemId: 'msg_final', phase: 'final_answer' } },
      },
      { type: 'text-delta', id: 'msg_final', text: 'Done.' },
      { type: 'text-end', id: 'msg_final' },
      { type: 'finish-step', finishReason: 'stop' },
    ] satisfies OpenAIStreamEventLike[]) {
      ledger = reduceOpenAIResponsesStreamEvent(ledger, event)
    }

    const replay = replayOpenAIResponsesLedger(ledger)
    expect(replay.lossless).toBe(true)
    expect(replay.messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(replay.messages[0]).toMatchObject({
      content: [
        { type: 'tool-call', toolCallId: 'call_a' },
        { type: 'tool-call', toolCallId: 'call_b' },
      ],
    })
    expect(replay.messages[1]).toMatchObject({
      content: [
        { type: 'tool-result', toolCallId: 'call_a', output: { type: 'text', value: 'A' } },
        { type: 'tool-result', toolCallId: 'call_b', output: { type: 'text', value: 'B' } },
      ],
    })
    expect(replay.messages[2]).toMatchObject({
      content: [{ type: 'text', text: 'Done.', providerOptions: { openai: { phase: 'final_answer' } } }],
    })
  })

  it('round-trips SDK messages without rewriting OpenAI metadata', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Inspect this repository.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'summary',
            providerOptions: {
              openai: { itemId: 'rs_2', reasoningEncryptedContent: 'encrypted-2', unknown: ['kept'] },
            },
          },
          {
            type: 'text',
            text: 'Checking.',
            providerOptions: { openai: { itemId: 'msg_2', phase: 'commentary' } },
          },
          {
            type: 'tool-call',
            toolCallId: 'call_2',
            toolName: 'grep',
            input: { pattern: 'TODO' },
            providerOptions: { openai: { itemId: 'fc_2', namespace: 'code' } },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_2',
            toolName: 'grep',
            output: { type: 'text', value: '0 matches' },
          },
        ],
      },
    ]

    const ledger = appendOpenAIResponsesModelMessages(createOpenAIResponsesLedger(), messages)
    const replay = replayOpenAIResponsesLedger(parseOpenAIResponsesLedger(JSON.parse(JSON.stringify(ledger))))

    expect(replay.lossless).toBe(true)
    expect(replay.messages).toEqual(messages)
  })

  it('normalizes SDK tool content into valid ledger JSON', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_content', toolName: 'inspect', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_content',
            toolName: 'inspect',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'structured result' },
                {
                  type: 'file',
                  data: { type: 'reference', reference: { openai: 'file_123' } },
                  mediaType: 'text/plain',
                  filename: 'result.txt',
                },
              ],
            },
          },
        ],
      },
    ]

    const captured = appendOpenAIResponsesModelMessages(createOpenAIResponsesLedger(), messages)
    const persisted = parseOpenAIResponsesLedger(JSON.parse(JSON.stringify(captured)))
    const replay = replayOpenAIResponsesLedger(persisted)

    expect(persisted.entries.find((entry) => entry.type === 'tool-result')).toMatchObject({
      type: 'tool-result',
      output: {
        type: 'json',
        value: [
          { type: 'text', text: 'structured result' },
          { type: 'file', data: { type: 'reference', reference: { openai: 'file_123' } } },
        ],
      },
    })
    expect(replay).toMatchObject({ lossless: true, issues: [] })
  })

  it('persists opaque MCP image references for Responses replay', () => {
    const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    try {
      const chatOutput = mcpResultToChatToolOutput({
        content: [{ type: 'image', data: imageData, mimeType: 'image/png' }],
      })
      const messages: ModelMessage[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'call_image', toolName: 'screenshot', input: {} }],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_image',
              toolName: 'screenshot',
              output: chatToolOutputToAiSdkOutput(chatOutput),
            },
          ],
        },
      ]

      const persisted = parseOpenAIResponsesLedger(
        JSON.parse(JSON.stringify(captureOpenAIResponsesModelMessages(messages)))
      )
      expect(JSON.stringify(persisted)).not.toContain(imageData)
      expect(persisted.entries.find((entry) => entry.type === 'tool-result')).toMatchObject({
        output: { type: 'maestrly-output', value: { images: [{ mediaType: 'image/png' }] } },
      })

      const replay = replayOpenAIResponsesLedger(persisted)
      expect(replay).toMatchObject({ lossless: true, issues: [] })
      const output = (replay.messages[1] as Extract<ModelMessage, { role: 'tool' }>).content[0]
      expect(output).toMatchObject({
        type: 'tool-result',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: '(image output)' },
            { type: 'file', mediaType: 'image/png' },
          ],
        },
      })
      expect(
        (output as { output: { type: 'content'; value: Array<{ data?: { data?: string } }> } }).output.value[1].data
      ).toEqual({
        type: 'data',
        data: imageData,
      })
    } finally {
      clearEphemeralToolImages()
    }
  })

  it('marks replay lossy after ephemeral cache removal', () => {
    const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    try {
      const chatOutput = mcpResultToChatToolOutput({
        content: [{ type: 'image', data: imageData, mimeType: 'image/png' }],
      })
      const persisted = parseOpenAIResponsesLedger(
        JSON.parse(
          JSON.stringify(
            captureOpenAIResponsesModelMessages([
              {
                role: 'assistant',
                content: [{ type: 'tool-call', toolCallId: 'call_restart', toolName: 'screenshot', input: {} }],
              },
              {
                role: 'tool',
                content: [
                  {
                    type: 'tool-result',
                    toolCallId: 'call_restart',
                    toolName: 'screenshot',
                    output: chatToolOutputToAiSdkOutput(chatOutput),
                  },
                ],
              },
            ])
          )
        )
      )

      clearEphemeralToolImages()
      const replay = replayOpenAIResponsesLedger(persisted)
      expect(replay.lossless).toBe(false)
      expect(replay.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'ephemeral-image-unavailable', requiresFallback: true }),
        ])
      )

      const history: ChatMessage[] = [
        {
          id: 'assistant-restart',
          conversationId: 'c1',
          role: 'assistant',
          parts: [
            {
              type: 'tool',
              id: 'call_restart',
              toolCallId: 'call_restart',
              toolName: 'screenshot',
              input: {},
              state: { status: 'completed', output: 'persisted visual transcript' },
            },
          ],
          createdAt: 1,
        },
      ]
      const built = buildOpenAIModelMessages(history, () => persisted, { onLossyState: 'include' })
      expect(built.lossless).toBe(false)
      expect(built.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'ephemeral-image-unavailable', requiresFallback: true }),
        ])
      )
      expect(JSON.stringify(built.messages)).toContain('persisted visual transcript')
      expect(JSON.stringify(built.messages)).not.toContain('image output unavailable')
    } finally {
      clearEphemeralToolImages()
    }
  })

  it('closes orphaned calls in production lossy-state replay', () => {
    const history: ChatMessage[] = [
      {
        id: 'a-interrupted',
        conversationId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', id: 'visual', text: 'interrupted visual fallback' }],
        createdAt: 1,
      },
      {
        id: 'u-next',
        conversationId: 'c1',
        role: 'user',
        parts: [{ type: 'text', id: 'next', text: 'continue' }],
        createdAt: 2,
      },
    ]
    const orphaned = captureOpenAIResponsesStream([
      { type: 'tool-call', toolCallId: 'call_orphan', toolName: 'read', input: { path: 'a.ts' } },
    ])

    const built = buildOpenAIModelMessages(history, (messageId) => (messageId === 'a-interrupted' ? orphaned : null), {
      onLossyState: 'include',
    })

    expect(built).toMatchObject({ lossless: false, requiresRawResponsesInput: false })
    expect(built.issues).toMatchObject([{ messageId: 'a-interrupted', code: 'orphaned-tool-call' }])
    expect(built.messages).toMatchObject([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_orphan' }] },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_orphan',
            output: { type: 'error-text', value: expect.stringContaining('Treat it as failed') },
          },
        ],
      },
      { role: 'user', content: 'continue' },
    ])
  })

  it('does not promise lossless replay without encrypted reasoning', () => {
    let ledger = captureOpenAIResponsesStream([
      { type: 'reasoning-start', id: 'rs_missing:0', providerMetadata: { openai: { itemId: 'rs_missing' } } },
      { type: 'reasoning-delta', id: 'rs_missing:0', text: 'visible summary only' },
      { type: 'reasoning-end', id: 'rs_missing:0', providerMetadata: { openai: { itemId: 'rs_missing' } } },
    ])
    ledger = appendOpenAIOpaqueResponseItem(
      ledger,
      'future_computer_call',
      { type: 'future_computer_call', id: 'computer_1', action: { type: 'click', x: 10, y: 20 } },
      { openai: { itemId: 'computer_1', future: true } }
    )

    const replay = replayOpenAIResponsesLedger(ledger)
    expect(replay).toMatchObject({ lossless: false, requiresRawResponsesInput: true })
    expect(replay.issues.map((issue) => issue.code)).toEqual([
      'reasoning-missing-encrypted-content',
      'opaque-item-requires-raw-responses-input',
    ])
    expect(ledger.entries.at(-1)).toMatchObject({
      type: 'opaque-response-item',
      itemType: 'future_computer_call',
      providerMetadata: { openai: { itemId: 'computer_1', future: true } },
    })
  })

  it('rejects values that cannot round-trip through JSON', () => {
    expect(() => toOpenAILedgerValue({ createdAt: new Date() })).toThrow('plain JSON objects')
    expect(() => toOpenAILedgerValue({ cost: Number.NaN })).toThrow('finite JSON number')
    expect(() => toOpenAILedgerValue({ secret: 1n })).toThrow('not JSON-serializable')

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => toOpenAILedgerValue(circular)).toThrow('circular reference')
  })

  it('rejects unknown ledger entries instead of silently dropping them', () => {
    const corrupted = {
      ...createOpenAIResponsesLedger(),
      entries: [{ type: 'future-response-item', payload: { id: 'future_1' } }],
    }

    expect(() => parseOpenAIResponsesLedger(corrupted)).toThrowError(TypeError)
    expect(() => parseOpenAIResponsesLedger(corrupted)).toThrow(
      '$.ledger.entries[0].type has unknown entry type "future-response-item"'
    )
  })

  it('validates mandatory entry fields and unsupported keys', () => {
    const invalidEntries: Array<{ entry: unknown; message: string }> = [
      {
        entry: { type: 'assistant-text', streamId: 'msg_1', text: 42, status: 'complete' },
        message: '$.ledger.entries[0].text must be a string',
      },
      {
        entry: { type: 'tool-call', toolCallId: 'call_1', toolName: 'read' },
        message: '$.ledger.entries[0].input is required',
      },
      {
        entry: {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'read',
          output: { type: 'text', value: { unexpected: true } },
        },
        message: '$.ledger.entries[0].output.value must be a string',
      },
      {
        entry: { type: 'step-boundary', providerMetadata: { openai: 'not-an-object' } },
        message: '$.ledger.entries[0].providerMetadata.openai must be a JSON object',
      },
      {
        entry: { type: 'compaction', itemId: 'cmp_1' },
        message: '$.ledger.entries[0].encryptedContent is required',
      },
      {
        entry: { type: 'step-boundary', replayWouldIgnoreThis: true },
        message: '$.ledger.entries[0].replayWouldIgnoreThis is not supported by ledger version 1',
      },
    ]

    for (const sample of invalidEntries) {
      expect(() => parseOpenAIResponsesLedger({ ...createOpenAIResponsesLedger(), entries: [sample.entry] })).toThrow(
        sample.message
      )
    }
  })

  it('combines visual messages and native sidecars without duplication', () => {
    const history: ChatMessage[] = [
      {
        id: 'u1',
        conversationId: 'c1',
        role: 'user',
        parts: [{ type: 'text', id: 'u1-text', text: 'Inspect.' }],
        createdAt: 1,
      },
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', id: 'a1-text', text: 'visual fallback' }],
        createdAt: 2,
      },
      {
        id: 'u2',
        conversationId: 'c1',
        role: 'user',
        parts: [{ type: 'text', id: 'u2-text', text: 'Continue.' }],
        createdAt: 3,
      },
    ]
    const sidecar = captureOpenAIResponsesModelMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'summary',
            providerOptions: { openai: { itemId: 'rs_sidecar', reasoningEncryptedContent: 'encrypted-sidecar' } },
          },
          {
            type: 'text',
            text: 'native answer',
            providerOptions: { openai: { itemId: 'msg_sidecar', phase: 'final_answer' } },
          },
        ],
      },
    ])

    const built = buildOpenAIModelMessages(history, (messageId) =>
      messageId === 'a1' ? JSON.stringify(sidecar) : null
    )

    expect(built).toMatchObject({ lossless: true, issues: [], requiresRawResponsesInput: false })
    expect(built.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(built.messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'reasoning', providerOptions: { openai: { reasoningEncryptedContent: 'encrypted-sidecar' } } },
        { type: 'text', text: 'native answer', providerOptions: { openai: { phase: 'final_answer' } } },
      ],
    })
    expect(JSON.stringify(built.messages)).not.toContain('visual fallback')
  })

  it('falls back to visual transcripts for invalid sidecars', () => {
    const history: ChatMessage[] = [
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', id: 'a1-text', text: 'safe visual transcript' }],
        createdAt: 1,
      },
    ]
    const lossy = captureOpenAIResponsesStream([
      { type: 'reasoning-start', id: 'rs_partial:0', providerMetadata: { openai: { itemId: 'rs_partial' } } },
      { type: 'reasoning-delta', id: 'rs_partial:0', text: 'partial' },
    ])

    const fallback = buildOpenAIModelMessages(history, () => lossy)
    expect(fallback.lossless).toBe(false)
    expect(fallback.messages).toEqual([{ role: 'assistant', content: 'safe visual transcript' }])
    expect(fallback.issues.map((issue) => issue.code)).toEqual([
      'reasoning-missing-encrypted-content',
      'incomplete-stream-item',
    ])

    const invalid = buildOpenAIModelMessages(history, () => '{bad json')
    expect(invalid.lossless).toBe(false)
    expect(invalid.issues).toMatchObject([{ messageId: 'a1', entryIndex: -1, code: 'invalid-inference-state' }])
    expect(invalid.messages).toEqual([{ role: 'assistant', content: 'safe visual transcript' }])
  })

  it('preserves native checkpoints and prunes earlier items', () => {
    const history: ChatMessage[] = [
      {
        id: 'u-old',
        conversationId: 'c1',
        role: 'user',
        parts: [{ type: 'text', id: 'u-old-text', text: 'old user context' }],
        createdAt: 1,
      },
      {
        id: 'a-old',
        conversationId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', id: 'a-old-text', text: 'old assistant context' }],
        createdAt: 2,
      },
      {
        id: 'u-trigger',
        conversationId: 'c1',
        role: 'user',
        parts: [{ type: 'text', id: 'u-trigger-text', text: 'trigger compaction' }],
        createdAt: 3,
      },
      {
        id: 'a-compact',
        conversationId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', id: 'a-compact-text', text: 'visual answer after compaction' }],
        createdAt: 4,
      },
      {
        id: 'u-next',
        conversationId: 'c1',
        role: 'user',
        parts: [{ type: 'text', id: 'u-next-text', text: 'continue from checkpoint' }],
        createdAt: 5,
      },
    ]
    const oldSidecar = captureOpenAIResponsesModelMessages([{ role: 'assistant', content: 'native old answer' }])
    const compactedSidecar = captureOpenAIResponsesStream([
      {
        type: 'custom',
        kind: 'openai.compaction',
        providerMetadata: {
          openai: {
            type: 'compaction',
            itemId: 'cmp_1',
            encryptedContent: 'encrypted-compact-state',
          },
        },
      },
      { type: 'text-start', id: 'msg_after', providerMetadata: { openai: { itemId: 'msg_after' } } },
      { type: 'text-delta', id: 'msg_after', text: 'native answer after compaction' },
      { type: 'text-end', id: 'msg_after', providerMetadata: { openai: { phase: 'final_answer' } } },
    ])

    const built = buildOpenAIModelMessages(history, (messageId) => {
      if (messageId === 'a-old') return oldSidecar
      if (messageId === 'a-compact') return compactedSidecar
      return null
    })

    expect(built).toMatchObject({ lossless: true, issues: [] })
    expect(built.messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'custom',
            kind: 'openai.compaction',
            providerOptions: {
              openai: {
                type: 'compaction',
                itemId: 'cmp_1',
                encryptedContent: 'encrypted-compact-state',
              },
            },
          },
          {
            type: 'text',
            text: 'native answer after compaction',
            providerOptions: { openai: { itemId: 'msg_after', phase: 'final_answer' } },
          },
        ],
      },
      { role: 'user', content: 'continue from checkpoint' },
    ])
    expect(JSON.stringify(built.messages)).not.toContain('old user context')
  })

  it('preserves visual prefixes when opaque items prevent model replay', () => {
    const history: ChatMessage[] = [
      {
        id: 'u-old',
        conversationId: 'c1',
        role: 'user',
        parts: [{ type: 'text', id: 'u-old-text', text: 'context that must survive fallback' }],
        createdAt: 1,
      },
      {
        id: 'a-compact',
        conversationId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', id: 'a-compact-text', text: 'safe visual checkpoint answer' }],
        createdAt: 2,
      },
      {
        id: 'u-next',
        conversationId: 'c1',
        role: 'user',
        parts: [{ type: 'text', id: 'u-next-text', text: 'continue' }],
        createdAt: 3,
      },
    ]
    let sidecar = captureOpenAIResponsesStream([
      {
        type: 'custom',
        kind: 'openai.compaction',
        providerMetadata: {
          openai: { type: 'compaction', itemId: 'cmp_opaque', encryptedContent: 'encrypted-prefix' },
        },
      },
    ])
    sidecar = appendOpenAIOpaqueResponseItem(sidecar, 'future_computer_call', {
      type: 'future_computer_call',
      id: 'opaque_1',
    })

    const built = buildOpenAIModelMessages(history, (messageId) => (messageId === 'a-compact' ? sidecar : null), {
      onLossyState: 'include',
    })

    expect(built).toMatchObject({ lossless: false, requiresRawResponsesInput: true })
    expect(built.messages).toEqual([
      { role: 'user', content: 'context that must survive fallback' },
      { role: 'assistant', content: 'safe visual checkpoint answer' },
      { role: 'user', content: 'continue' },
    ])
  })

  it('prunes sidecar prefixes on valid native checkpoints', () => {
    const ledger = captureOpenAIResponsesStream([
      { type: 'text-start', id: 'before' },
      { type: 'text-delta', id: 'before', text: 'large prefix' },
      { type: 'text-end', id: 'before' },
      {
        type: 'custom',
        kind: 'openai.compaction',
        providerMetadata: {
          openai: { type: 'compaction', itemId: 'cmp_prune', encryptedContent: 'encrypted-pruned-prefix' },
        },
      },
      { type: 'text-start', id: 'after' },
      { type: 'text-delta', id: 'after', text: 'tail' },
      { type: 'text-end', id: 'after' },
    ])

    expect(ledger.entries.map((entry) => entry.type)).toEqual(['compaction', 'assistant-text'])
    expect(JSON.stringify(ledger)).not.toContain('large prefix')
  })

  it('does not restore full ledgers when compaction cuts messages', () => {
    const history: ChatMessage[] = [
      {
        id: 'a-compacted',
        conversationId: 'c1',
        role: 'assistant',
        parts: [
          { type: 'text', id: 'before', text: 'content before compaction' },
          { type: 'compaction', id: 'compact', text: 'canonical summary' },
          { type: 'text', id: 'after', text: 'content after compaction' },
        ],
        createdAt: 1,
      },
    ]
    const wholeMessageSidecar = captureOpenAIResponsesModelMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'native whole message (must not return)',
            providerOptions: { openai: { itemId: 'msg_whole', phase: 'final_answer' } },
          },
        ],
      },
    ])

    const built = buildOpenAIModelMessages(history, () => wholeMessageSidecar)
    expect(built.messages).toEqual([
      {
        role: 'assistant',
        content: 'Summary of the conversation so far (compacted context):\n\ncanonical summary',
      },
      { role: 'assistant', content: 'content after compaction' },
    ])
  })
})

describe('OpenAI ledger enrichment after image rejection', () => {
  // Image IDs need not exist in cache for text-only replay.
  const baseOutput = {
    text: 'Screenshot captured.',
    images: [{ id: 'tool-image:ledger-shot', mediaType: 'image/png', byteSize: 10 }],
  }
  const enrichedOutput: ToolOutput = {
    ...baseOutput,
    images: [
      {
        ...baseOutput.images[0],
        description: 'Terminal screenshot: ENOENT error on line 3.',
        descriptionModel: 'vision-model',
      },
    ],
  }
  const ledgerEvents = (): OpenAIStreamEventLike[] => [
    { type: 'reasoning-start', id: 'rs:0', providerMetadata: { openai: { itemId: 'rs_1' } } },
    { type: 'reasoning-delta', id: 'rs:0', text: 'I will inspect the capture.' },
    {
      type: 'reasoning-end',
      id: 'rs:0',
      providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'encrypted-reasoning' } },
    },
    { type: 'tool-call', toolCallId: 'shot-1', toolName: 'browser_screenshot', input: { path: 'x' } },
    {
      type: 'tool-result',
      toolCallId: 'shot-1',
      toolName: 'browser_screenshot',
      output: chatToolOutputToAiSdkOutput(baseOutput),
    },
    { type: 'text-start', id: 'msg:0' },
    { type: 'text-delta', id: 'msg:0', text: 'Vou continuar.' },
    { type: 'text-end', id: 'msg:0' },
    { type: 'finish-step', finishReason: 'stop' },
  ]

  it('patches only target tool outputs while preserving reasoning and text', () => {
    const ledger = captureOpenAIResponsesStream(ledgerEvents())
    const baseReplay = replayOpenAIResponsesLedger(ledger, { dropImages: true })
    expect(JSON.stringify(baseReplay.messages)).toContain('omitted')

    const patched = patchOpenAILedgerToolOutputs(ledger, [{ toolCallId: 'shot-1', output: enrichedOutput }])
    expect(patched).not.toBe(ledger)
    // No entry changes type or order: reasoning, text, and step-boundary stay intact.
    expect(patched.entries.map((entry) => entry.type)).toEqual(ledger.entries.map((entry) => entry.type))

    const replay = replayOpenAIResponsesLedger(patched, { dropImages: true })
    const serialized = JSON.stringify(replay.messages)
    expect(serialized).toContain('Terminal screenshot: ENOENT error on line 3.')
    expect(serialized).not.toContain('omitted')
    expect(serialized).toContain('I will inspect the capture.')
    expect(serialized).toContain('Vou continuar.')
    expect(replay.lossless).toBe(true)

    // Reapplying the same enrichment returns the same reference.
    expect(patchOpenAILedgerToolOutputs(patched, [{ toolCallId: 'shot-1', output: enrichedOutput }])).toBe(patched)
    // Unknown tool call IDs leave output unchanged.
    expect(patchOpenAILedgerToolOutputs(patched, [{ toolCallId: 'other-call', output: enrichedOutput }])).toBe(patched)
    // Empty ledgers remain unchanged.
    expect(patchOpenAILedgerToolOutputs(createOpenAIResponsesLedger(), [])).toMatchObject({ entries: [] })
  })

  it('uses ledger descriptions on subsequent image-free replay', () => {
    const ledger = patchOpenAILedgerToolOutputs(captureOpenAIResponsesStream(ledgerEvents()), [
      { toolCallId: 'shot-1', output: enrichedOutput },
    ])
    const history: ChatMessage[] = [
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', id: 't1', text: 'visual fallback (must not be used)' }],
        createdAt: 1,
      },
      {
        id: 'u1',
        conversationId: 'c1',
        role: 'user',
        parts: [{ type: 'text', id: 'u1', text: 'continue' }],
        createdAt: 2,
      },
    ]

    const built = buildOpenAIModelMessages(history, (messageId) => (messageId === 'a1' ? ledger : null), {
      dropImages: true,
    })
    const serialized = JSON.stringify(built.messages)
    expect(serialized).toContain('Terminal screenshot: ENOENT error on line 3.')
    expect(serialized).not.toContain('omitted')
    expect(serialized).not.toContain('visual fallback')
    expect(serialized).toContain('I will inspect the capture.')
    expect(built.lossless).toBe(true)
  })

  it('adds descriptions without reverting newer image output', () => {
    // The ledger already contains newer tool state for the same image handle.
    const newerOutput: ToolOutput = {
      ...baseOutput,
      text: 'Screenshot AFTER retry: pipeline verde.',
      structuredContent: { status: 'ok', attempts: 2 },
      isError: true,
    }
    const events = ledgerEvents()
    const toolResultIndex = events.findIndex((event) => event.type === 'tool-result')
    events[toolResultIndex] = {
      ...(events[toolResultIndex] as Extract<OpenAIStreamEventLike, { type: 'tool-result' }>),
      output: chatToolOutputToAiSdkOutput(newerOutput),
    }
    const ledger = captureOpenAIResponsesStream(events)

    const patched = patchOpenAILedgerToolOutputs(ledger, [{ toolCallId: 'shot-1', output: enrichedOutput }])
    expect(patched).not.toBe(ledger)
    const entry = patched.entries.find((e) => e.type === 'tool-result' && e.toolCallId === 'shot-1')
    expect(entry?.type).toBe('tool-result')
    if (entry?.type !== 'tool-result') throw new Error('ledger entry ausente')
    expect(entry.output.type).toBe('maestrly-output')
    if (entry.output.type !== 'maestrly-output') throw new Error('projection inesperada')
    const value = entry.output.value as {
      text: string
      structuredContent?: unknown
      isError?: boolean
      images: Array<{ id: string; description?: string }>
    }
    expect(value.text).toBe('Screenshot AFTER retry: pipeline verde.')
    expect(value.structuredContent).toEqual({ status: 'ok', attempts: 2 })
    expect(value.isError).toBe(true)
    expect(value.images[0]?.description).toBe('Terminal screenshot: ENOENT error on line 3.')

    // Image-free replay uses newer text plus descriptions, never omission.
    const serialized = JSON.stringify(replayOpenAIResponsesLedger(patched, { dropImages: true }).messages)
    expect(serialized).toContain('Screenshot AFTER retry: pipeline verde.')
    expect(serialized).toContain('Terminal screenshot: ENOENT error on line 3.')
    expect(serialized).not.toContain('omitted')
  })
})
