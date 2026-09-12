import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/chat'
import {
  buildClaudeSessionBinding,
  buildClaudeSessionPrompt,
  claudeSeedTranscript,
  isClaudeSessionBindingCompatible,
  resolveClaudeSession,
} from '../../src/main/chat/claude-agent-sdk/session'
import { CLAUDE_HARNESS_PROFILE, type ClaudeSessionBinding } from '../../src/main/chat/claude-agent-sdk/session-store'

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
    expect(claudeSeedTranscript(history, 'session-1')).toBe('')
    expect(claudeSeedTranscript(history, undefined)).toContain('first')
    expect(claudeSeedTranscript(history, undefined)).not.toContain('second')
  })
})
