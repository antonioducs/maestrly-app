import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/chat'
import {
  buildClaudeSessionBinding,
  buildClaudeSessionPrompt,
  claudeSessionSeed,
  estimateClaudeSeedTokens,
  isClaudeSessionBindingCompatible,
  renderClaudeSeed,
  resolveClaudeSession,
} from '../../src/main/chat/claude-agent-sdk/session'
import { PORTABLE_IMAGE_TOKENS, estimateTextTokens } from '../../src/main/chat/portable-context'
import { CLAUDE_HARNESS_PROFILE, type ClaudeSessionBinding } from '../../src/main/chat/claude-agent-sdk/session-store'
import { pdfFallbackText } from '../../src/main/chat/pdf-attachments'
import { storedPdfPart } from '../helpers/pdf-parts'

const usage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  costUsd: 0.5,
  turns: 1,
  durationMs: 10,
  durationApiMs: 8,
}

function binding(): ClaudeSessionBinding {
  return {
    conversationId: 'conversation-1',
    sessionId: 'session-1',
    modelId: 'claude-opus',
    effort: 'high',
    fastMode: false,
    cwd: '/project',
    harnessSnapshot: null,
    harnessProfile: CLAUDE_HARNESS_PROFILE,
    promptHash: 'prompt-hash',
    toolSignature: 'tool-signature',
    lastMessageId: 'assistant-tip',
    lastAssistantUuid: 'sdk-assistant-tip',
    accountFingerprint: 'account-1',
    accountEpoch: 3,
    accountId: null,
    usage,
    context: null,
    updatedAt: 1,
  }
}

describe('Claude Agent SDK session resolution', () => {
  it('requires an exact harness, account, model, prompt and tool match', () => {
    const expected = {
      modelId: 'claude-opus',
      reasoningEffort: 'high',
      fastMode: false,
      cwd: '/project',
      promptHash: 'prompt-hash',
      toolSignature: 'tool-signature',
      accountIdentity: { fingerprint: 'account-1', epoch: 3 },
    }
    expect(isClaudeSessionBindingCompatible(binding(), expected)).toBe(true)
    expect(isClaudeSessionBindingCompatible({ ...binding(), accountEpoch: 4 }, expected)).toBe(false)
    expect(isClaudeSessionBindingCompatible({ ...binding(), toolSignature: 'other-tools' }, expected)).toBe(false)
    expect(isClaudeSessionBindingCompatible({ ...binding(), promptHash: 'maestrly-fable-5.1-v1-hash' }, expected)).toBe(
      false
    )
  })

  it('resumes the tip and forks from a mapped rewind', () => {
    expect(
      resolveClaudeSession({
        binding: binding(),
        compatible: true,
        previousMessageId: 'assistant-tip',
        mappedAssistantUuid: null,
        mappedSessionId: null,
      })
    ).toEqual({ resume: 'session-1', forkSession: false, retireExisting: false })

    expect(
      resolveClaudeSession({
        binding: binding(),
        compatible: true,
        previousMessageId: 'assistant-old',
        mappedAssistantUuid: 'sdk-assistant-old',
        mappedSessionId: 'session-1',
      })
    ).toEqual({
      resume: 'session-1',
      resumeSessionAt: 'sdk-assistant-old',
      forkSession: true,
      retireExisting: false,
    })
  })

  it('retires incompatible or unreachable bindings', () => {
    expect(
      resolveClaudeSession({
        binding: binding(),
        compatible: false,
        previousMessageId: 'assistant-tip',
        mappedAssistantUuid: null,
        mappedSessionId: null,
      }).retireExisting
    ).toBe(true)
    expect(
      resolveClaudeSession({
        binding: binding(),
        compatible: true,
        previousMessageId: 'assistant-old',
        mappedAssistantUuid: null,
        mappedSessionId: 'session-1',
      }).retireExisting
    ).toBe(true)
  })

  it('builds a gated multimodal prompt and authoritative binding metadata', async () => {
    const message = {
      id: 'user-1',
      conversationId: 'conversation-1',
      role: 'user',
      model: { providerId: 'claude-subscription', modelId: 'claude-opus' },
      createdAt: 1,
      parts: [
        { type: 'text', text: 'continue' },
        { type: 'file', kind: 'text', name: 'notes.txt', data: 'hello' },
        { type: 'file', kind: 'image', name: 'pixel.png', data: 'data:image/png;base64,YQ==' },
      ],
    } as ChatMessage
    const prompt = buildClaudeSessionPrompt(message, 'prior transcript')
    prompt.release()
    const next = await prompt.prompt[Symbol.asyncIterator]().next()
    expect(next.value?.message.content).toEqual([
      {
        type: 'text',
        text: 'Previous Maestrly transcript (continue from this context):\n\nprior transcript',
      },
      { type: 'text', text: 'continue' },
      { type: 'text', text: 'File notes.txt:\n\nhello' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'YQ==' },
      },
    ])

    const built = buildClaudeSessionBinding({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      modelId: 'claude-opus',
      reasoningEffort: 'high',
      cwd: '/project',
      promptHash: 'prompt-hash',
      toolSignature: 'tool-signature',
      lastMessageId: 'assistant-1',
      lastAssistantUuid: 'sdk-assistant-1',
      accountIdentity: { fingerprint: 'account-1', epoch: 3 },
      usage,
      context: null,
    })
    expect(built).toMatchObject({
      harnessProfile: CLAUDE_HARNESS_PROFILE,
      accountFingerprint: 'account-1',
      accountEpoch: 3,
      effort: 'high',
      fastMode: false,
    })
    expect(() =>
      buildClaudeSessionBinding({
        ...built,
        reasoningEffort: built.effort,
        accountIdentity: { fingerprint: null, epoch: 3 },
      })
    ).toThrow('Claude is not authenticated.')
  })

  it('drops Claude image bytes while preserving the cached interpreter description', async () => {
    const message = {
      id: 'user-image-1',
      conversationId: 'conversation-1',
      role: 'user',
      createdAt: 1,
      parts: [
        {
          type: 'file',
          kind: 'image',
          name: 'screen.png',
          data: 'data:image/png;base64,SECRET_IMAGE_BYTES',
          description: 'A login form with an invalid password error.',
          descriptionModel: 'Vision Co/vision-model',
        },
      ],
    } as ChatMessage

    const prompt = buildClaudeSessionPrompt(message, '', { dropImages: true })
    prompt.release()
    const next = await prompt.prompt[Symbol.asyncIterator]().next()
    const content = next.value?.message.content

    expect(content).toEqual([
      {
        type: 'text',
        text:
          '[image "screen.png" — the selected model cannot see images, so here is a description by Vision Co/vision-model]\n' +
          'A login form with an invalid password error.',
      },
    ])
    expect(JSON.stringify(content)).not.toContain('SECRET_IMAGE_BYTES')
  })

  it('sends PDFs as native document blocks and falls back to extracted text when disabled', async () => {
    const { conversationId, part, bytes, cleanup } = await storedPdfPart()
    try {
      const message = {
        id: 'user-pdf',
        conversationId,
        role: 'user',
        createdAt: 1,
        parts: [part],
      } as ChatMessage

      const native = buildClaudeSessionPrompt(message, '')
      native.release()
      const nativeContent = (await native.prompt[Symbol.asyncIterator]().next()).value?.message.content
      expect(nativeContent).toEqual([
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
          title: 'a.pdf',
        },
      ])

      const text = buildClaudeSessionPrompt(message, '', { nativePdf: false })
      text.release()
      const textContent = (await text.prompt[Symbol.asyncIterator]().next()).value?.message.content
      expect(textContent).toEqual([{ type: 'text', text: pdfFallbackText(part) }])
    } finally {
      await cleanup()
    }
  })

  it('adds current environment context to the new user message without changing prior transcript bytes', async () => {
    const message = {
      id: 'user-env',
      conversationId: 'conversation-1',
      role: 'user',
      createdAt: 1,
      parts: [{ type: 'text', text: 'continue' }],
    } as ChatMessage
    const seed = 'stable prior transcript'
    const prompt = buildClaudeSessionPrompt(message, seed, {
      transientContext: '# Current environment\nGit branch: main (clean).',
    })
    prompt.release()
    const next = await prompt.prompt[Symbol.asyncIterator]().next()
    expect(next.value?.message.content).toEqual([
      { type: 'text', text: `Previous Maestrly transcript (continue from this context):\n\n${seed}` },
      { type: 'text', text: '# Current environment\nGit branch: main (clean).' },
      { type: 'text', text: 'continue' },
    ])
    expect(seed).toBe('stable prior transcript')
  })

  it('only seeds a transcript when no native session can resume', () => {
    const history = [
      {
        id: 'user-1',
        conversationId: 'conversation-1',
        role: 'user',
        parts: [{ type: 'text', text: 'first' }],
        createdAt: 1,
      },
      {
        id: 'user-2',
        conversationId: 'conversation-1',
        role: 'user',
        parts: [{ type: 'text', text: 'second' }],
        createdAt: 2,
      },
    ] as ChatMessage[]
    expect(claudeSessionSeed(history, 'session-1')).toEqual({ transcript: '', images: [] })
    expect(claudeSessionSeed(history, undefined).transcript).toContain('first')
    expect(claudeSessionSeed(history, undefined).transcript).not.toContain('second')
  })
})

describe('Claude session seed images', () => {
  const png = (payload: string) => `data:image/png;base64,${Buffer.from(payload).toString('base64')}`
  const imagePart = (name: string, data: string, extra: Record<string, unknown> = {}) => ({
    type: 'file',
    id: `file-${name}`,
    kind: 'image',
    name,
    mediaType: 'image/png',
    data,
    ...extra,
  })
  const userMessage = (id: string, parts: unknown[]) =>
    ({ id, conversationId: 'conversation-1', role: 'user', parts, createdAt: 1 }) as ChatMessage
  const assistantMessage = (id: string, text: string) =>
    ({
      id,
      conversationId: 'conversation-1',
      role: 'assistant',
      parts: [{ type: 'text', id: `${id}-text`, text }],
      createdAt: 1,
    }) as ChatMessage
  const contentOf = async (prompt: ReturnType<typeof buildClaudeSessionPrompt>) => {
    prompt.release()
    return (await prompt.prompt[Symbol.asyncIterator]().next()).value?.message.content
  }

  it('re-sends earlier images as image blocks referenced from the transcript', async () => {
    const history = [
      userMessage('user-1', [{ type: 'text', id: 't1', text: 'see this' }, imagePart('one.png', png('first'))]),
      assistantMessage('assistant-1', 'I see it'),
      userMessage('user-2', [{ type: 'text', id: 't2', text: 'and now?' }]),
    ]
    const seed = claudeSessionSeed(history, undefined)
    expect(seed.transcript).toContain('[image "one.png" — re-sent below as transcript image 1]')
    expect(seed.transcript).not.toContain('does not accept images')
    expect(seed.images).toHaveLength(1)
    expect(estimateClaudeSeedTokens(seed)).toBe(estimateTextTokens(seed.transcript) + PORTABLE_IMAGE_TOKENS)

    const content = await contentOf(buildClaudeSessionPrompt(history[2], seed))
    expect(content).toEqual([
      { type: 'text', text: `Previous Maestrly transcript (continue from this context):\n\n${seed.transcript}` },
      { type: 'text', text: 'Transcript image 1 ("one.png"):' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: Buffer.from('first').toString('base64') },
      },
      { type: 'text', text: 'and now?' },
    ])
  })

  it('keeps the newest images within the budget left by the message sent with the seed', () => {
    const earlier = Array.from({ length: 5 }, (_, index) =>
      userMessage(`user-${index}`, [imagePart(`old-${index}.png`, png(`old-${index}`))])
    )
    const current = userMessage(
      'user-current',
      Array.from({ length: 5 }, (_, index) => imagePart(`new-${index}.png`, png(`new-${index}`)))
    )
    const seed = claudeSessionSeed([...earlier, current], undefined)
    // 8 images per request, 5 of them in the current message: only the 3 newest earlier images are re-sent.
    expect(seed.images.map((image) => [image.index, image.name])).toEqual([
      [1, 'old-2.png'],
      [2, 'old-3.png'],
      [3, 'old-4.png'],
    ])
    expect(seed.transcript).toContain(
      '[image "old-1.png" attached earlier; its pixels are not part of this text transcript]'
    )
    expect(seed.transcript).toContain('[image "old-4.png" — re-sent below as transcript image 3]')
  })

  it('carries the current images into a continuation and skips those before a compaction summary', () => {
    const history = [
      userMessage('user-1', [imagePart('compacted.png', png('compacted'))]),
      {
        ...assistantMessage('assistant-1', ''),
        parts: [{ type: 'compaction', id: 'summary', text: 'summary of the earlier work', strategy: 'summary' }],
      } as ChatMessage,
      userMessage('user-2', [
        { type: 'text', id: 't2', text: 'what is on screen?' },
        imagePart('screen.png', png('screen')),
      ]),
      assistantMessage('assistant-2', 'partial answer'),
    ]
    const seed = renderClaudeSeed(history)
    expect(seed.images.map((image) => image.name)).toEqual(['screen.png'])
    expect(seed.transcript).toContain('[image "screen.png" — re-sent below as transcript image 1]')
    expect(seed.transcript).not.toContain('compacted.png')

    expect(renderClaudeSeed(history, { budget: { images: 0, bytes: 0 } })).toEqual({
      transcript: expect.stringContaining('[image "screen.png" attached earlier;'),
      images: [],
    })
  })

  it('marks unreadable images instead of dropping them silently', async () => {
    const missing = imagePart('gone.png', undefined as unknown as string, { artifactId: 'a'.repeat(32), byteSize: 10 })
    const seed = renderClaudeSeed([userMessage('user-1', [missing])])
    expect(seed.images).toEqual([])
    expect(seed.transcript).toContain('[Image attachment gone.png could not be decoded by the host.]')

    const content = await contentOf(buildClaudeSessionPrompt(userMessage('user-2', [missing]), ''))
    expect(content).toEqual([{ type: 'text', text: '[Image attachment gone.png could not be decoded by the host.]' }])
  })

  it('describes images as text when the runtime drops them', () => {
    const history = [
      userMessage('user-1', [
        imagePart('one.png', png('first'), { description: 'A chart.', descriptionModel: 'Vision' }),
      ]),
      userMessage('user-2', [{ type: 'text', id: 't2', text: 'next' }]),
    ]
    const seed = claudeSessionSeed(history, undefined, { dropImages: true })
    expect(seed.images).toEqual([])
    expect(seed.transcript).toContain(
      '[image "one.png" — the selected model cannot see images, so here is a description by Vision]\nA chart.'
    )
  })
})
