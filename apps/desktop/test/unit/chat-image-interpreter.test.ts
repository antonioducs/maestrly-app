/**
 * Image interpreter settings and description caching.
 *
 * Protect costly invariants: generate descriptions once per image because
 * history is replayed every turn; interpretation failures
 * must not break turns and must enter negative caches to prevent
 * infinite retries. Images before active compaction boundaries are not
 * described or sent. Persisted description updates signal historyChanged so
 * services retire native bindings. Diagnostic ledgers retain interpretation usage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  generateText: vi.fn(),
  recordModelCallUsage: vi.fn(),
  hasApiKey: vi.fn((_providerId: string) => true),
  runCodexEphemeralWithFailover: vi.fn(),
  runClaudeEphemeralWithFailover: vi.fn(),
  summarizeWithClaudeRuntime: vi.fn(),
  summarizeWithCodexRuntime: vi.fn(),
}))
const generateText = h.generateText
const recordModelCallUsage = h.recordModelCallUsage
const hasApiKey = h.hasApiKey
/** Changing this fake API key changes interpreter identity even for the same model. */
let apiKeyValue = 'test-key'
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => h.generateText(...args) }))
vi.mock('../../src/main/chat/provider', () => ({
  resolveLanguageModel: () => ({ modelId: 'vision-model' }),
  buildOpenAIProviderFingerprint: (_descriptor: unknown, _transport: unknown, apiKey: string) => `fp:${apiKey}`,
}))
vi.mock('../../src/main/chat/credentials', () => ({
  hasApiKey: (providerId: string) => h.hasApiKey(providerId),
  getApiKey: (providerId: string) => (h.hasApiKey(providerId) ? apiKeyValue : null),
}))
vi.mock('../../src/main/chat/model-meta', () => ({
  getProviderModelMeta: async () => null,
  catalogProviderForBaseURL: () => null,
}))
vi.mock('../../src/main/chat/usage-diagnostics', () => ({
  recordModelCallUsage: (...args: unknown[]) => h.recordModelCallUsage(...args),
}))
vi.mock('../../src/main/chat/subscription-failover', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/subscription-failover')>()
  return {
    ...original,
    runCodexEphemeralWithFailover: (...args: unknown[]) => h.runCodexEphemeralWithFailover(...args),
  }
})
vi.mock('../../src/main/chat/subscription-failover/claude-ephemeral', () => ({
  runClaudeEphemeralWithFailover: (...args: unknown[]) => h.runClaudeEphemeralWithFailover(...args),
}))
vi.mock('../../src/main/chat/portable-summarizer', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/portable-summarizer')>()
  return {
    ...original,
    summarizeWithClaudeRuntime: (...args: unknown[]) => h.summarizeWithClaudeRuntime(...args),
    summarizeWithCodexRuntime: (...args: unknown[]) => h.summarizeWithCodexRuntime(...args),
  }
})

import type { ChatMessage, ChatToolImage, MessagePart, ToolOutput } from '../../src/shared/chat'
import { addProvider, CODEX_SUBSCRIPTION_PROVIDER_ID, removeProvider } from '../../src/main/chat/catalog'
import {
  clearChatMessages,
  deleteChatMessage,
  deleteChatMessagesFrom,
  getMessageSeq,
  listChatMessages,
  upsertChatMessage,
} from '../../src/main/chat/chat-store'
import {
  applyPersistedToolImageEnrichment,
  describeConversationImages,
  describeEphemeralToolImage,
  describePersistedToolImages,
  DESCRIBE_TIMEOUT_MS,
  getImageInterpreter,
  hasConfiguredImageInterpreter,
  hasImagesToDescribe,
  normalizeImageInterpreter,
  setImageInterpreter,
} from '../../src/main/chat/image-interpreter'
import {
  getOpenAIInferenceState,
  getToolExecution,
  OPENAI_INFERENCE_STATE_VERSION,
  putChatMessageWithOpenAIInferenceState,
  putToolExecution,
} from '../../src/main/chat/openai/inference-store'
import { createOpenAIResponsesLedger, toOpenAIToolResultOutput } from '../../src/main/chat/openai/ledger'
import {
  clearConversationToolImageMetadata,
  clearEphemeralToolImages,
  deleteConversationToolImageMetadata,
  EPHEMERAL_IMAGE_CACHE_TTL_MS,
  MAX_EPHEMERAL_IMAGE_CACHE_ENTRIES,
  mcpResultToChatToolOutput,
  modelOutputToChatToolOutput,
} from '../../src/main/chat/tool-output'
import { toolOutputImages } from '../../src/shared/chat'
import { insertConversation, insertWorkspace } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'

const IMAGE = 'data:image/png;base64,AAAA'

function imagePart(id: string, name = 'error.png'): Extract<MessagePart, { type: 'file' }> {
  return { type: 'file', id, name, mediaType: 'image/png', kind: 'image', data: IMAGE }
}

function userMessage(id: string, parts: MessagePart[]): ChatMessage {
  return { id, conversationId: 'c', role: 'user', parts, createdAt: Date.now() }
}

let providerId = ''

afterEach(() => clearEphemeralToolImages())

beforeEach(() => {
  freshDb()
  apiKeyValue = 'test-key'
  generateText.mockReset()
  recordModelCallUsage.mockReset()
  hasApiKey.mockReset()
  hasApiKey.mockReturnValue(true)
  h.runClaudeEphemeralWithFailover.mockReset()
  h.summarizeWithClaudeRuntime.mockReset()
  h.runCodexEphemeralWithFailover.mockReset()
  h.summarizeWithCodexRuntime.mockReset()
  generateText.mockResolvedValue({
    text: '  Terminal screenshot: ENOENT error on line 3.  ',
    totalUsage: { inputTokens: 1_000, outputTokens: 120, cachedInputTokens: 0 },
  })
  insertWorkspace({ id: 'w', path: '/tmp/w', name: 'W', defaultBranch: 'main', addedAt: 1 })
  insertConversation({
    id: 'c',
    workspaceId: 'w',
    name: 'C',
    branch: 'main',
    mode: 'local',
    experience: 'standard',
    cwd: '/tmp/w',
    status: 'idle',
    createdAt: 1,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 1,
    isMulti: 0,
  })
  providerId = addProvider({ name: 'Vision Co', baseURL: 'https://vision.test/v1' }).id
})
afterEach(closeDb)

const enable = () => setImageInterpreter({ providerId, modelId: 'vision-model', effort: 'high' })

describe('image interpreter settings', () => {
  it('round-trips settings and treats invalid values as off', () => {
    enable()
    expect(getImageInterpreter()).toEqual({ providerId, modelId: 'vision-model', effort: 'high' })

    setImageInterpreter({ providerId, modelId: 'vision-model', effort: 'off' })
    expect(getImageInterpreter()).toEqual({ providerId, modelId: 'vision-model' })

    expect(normalizeImageInterpreter({ providerId, modelId: '   ' })).toBeNull()
    expect(normalizeImageInterpreter(null)).toBeNull()
    setImageInterpreter(null)
    expect(getImageInterpreter()).toBeNull()
  })

  it('requires locally available providers and credentials', () => {
    enable()
    expect(hasConfiguredImageInterpreter()).toBe(true)

    hasApiKey.mockReturnValue(false)
    expect(hasConfiguredImageInterpreter()).toBe(false)

    hasApiKey.mockReturnValue(true)
    removeProvider(providerId)
    expect(hasConfiguredImageInterpreter()).toBe(false)
  })
})

describe('image descriptions', () => {
  it('describes a pending image, caches the part, and does NOT describe it again next turn', async () => {
    enable()
    const parts: MessagePart[] = [{ type: 'text', id: 't', text: 'look at this' }, imagePart('f1')]
    expect(hasImagesToDescribe('c', parts)).toBe(true)

    const described = await describeConversationImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      pendingParts: parts,
      signal: new AbortController().signal,
    })
    // Pending messages are not in SQLite and need no binding invalidation.
    expect(described).toEqual({ described: 1, historyChanged: false })
    const file = parts[1] as Extract<MessagePart, { type: 'file' }>
    expect(file.description).toBe('Terminal screenshot: ENOENT error on line 3.')
    expect(file.descriptionModel).toBe('Vision Co/vision-model')
    expect(generateText).toHaveBeenCalledTimes(1)
    // Billable interpretation enters the diagnostic ledger.
    expect(recordModelCallUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: 'byok-ai-sdk',
        providerId,
        modelId: 'vision-model',
        conversationId: 'c',
        agent: 'image-interpreter',
        usage: expect.objectContaining({ totalInput: 1_000, output: 120 }),
      })
    )

    // Persisted descriptions prevent repeated interpretation on subsequent turns.
    upsertChatMessage(userMessage('u1', parts))
    expect(hasImagesToDescribe('c', [])).toBe(false)
    expect(
      await describeConversationImages({
        conversationId: 'c',
        cwd: '/tmp/w',
        pendingParts: [],
        signal: new AbortController().signal,
      })
    ).toEqual({ described: 0, historyChanged: false })
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('records each failed and successful interpretation attempt once', async () => {
    setImageInterpreter({ providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, modelId: 'vision-model' })
    const failedUsage = { input: 60, output: 7, cacheRead: 40, cacheCreate: 0, totalInput: 100 }
    const winningUsage = { input: 90, output: 11, cacheRead: 50, cacheCreate: 0, totalInput: 140 }
    h.summarizeWithCodexRuntime
      .mockRejectedValueOnce(Object.assign(new Error('UsageLimitExceeded'), { partialUsage: failedUsage }))
      .mockResolvedValueOnce({ text: 'Codex description.', usage: winningUsage })
    h.runCodexEphemeralWithFailover.mockImplementationOnce(async (args: any) => {
      const primary = { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, runtimeModelId: 'vision-a', client: {} }
      const fallback = {
        providerId: `${CODEX_SUBSCRIPTION_PROVIDER_ID}@acc_b`,
        runtimeModelId: 'vision-b',
        client: {},
      }
      let partial: typeof failedUsage | undefined
      try {
        await args.operation(primary, args.signal)
      } catch (error) {
        partial = args.extractAttemptUsage(error)
        if (partial) args.onAttemptUsage({ target: primary, attempt: 1, usage: partial, outcome: 'failed' })
      }
      const result = await args.operation(fallback, args.signal)
      const usage = args.extractAttemptUsage(result)
      if (usage) args.onAttemptUsage({ target: fallback, attempt: 2, usage, outcome: 'success' })
      return partial ? args.mergeAttemptUsage(result, partial) : result
    })

    const part = imagePart('codex-f1')
    await expect(
      describeConversationImages({
        conversationId: 'c',
        cwd: '/tmp/w',
        pendingParts: [part],
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ described: 1, historyChanged: false })

    expect(recordModelCallUsage).toHaveBeenCalledTimes(2)
    expect(recordModelCallUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
        modelId: 'vision-a',
        attempt: 1,
        usage: failedUsage,
      })
    )
    expect(recordModelCallUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerId: `${CODEX_SUBSCRIPTION_PROVIDER_ID}@acc_b`,
        modelId: 'vision-b',
        attempt: 2,
        usage: winningUsage,
      })
    )
  })

  it('describes older active-context images and updates persisted messages', async () => {
    upsertChatMessage(userMessage('u1', [imagePart('f1', 'old.png')]))
    enable()

    const described = await describeConversationImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      pendingParts: [],
      signal: new AbortController().signal,
    })
    // Rewriting persisted messages signals binding retirement because resumed
    // sessions would miss descriptions when lastMessageId is unchanged.
    expect(described).toEqual({ described: 1, historyChanged: true })
    const persisted = listChatMessages('c')[0].parts[0] as Extract<MessagePart, { type: 'file' }>
    expect(persisted.description).toContain('ENOENT')
  })

  it('ignores images before compaction boundaries', async () => {
    upsertChatMessage(userMessage('u1', [imagePart('f1', 'velha.png')]))
    upsertChatMessage({
      id: 'a1',
      conversationId: 'c',
      role: 'assistant',
      parts: [{ type: 'compaction', id: 'k', text: 'summary' }],
      createdAt: Date.now(),
    })
    enable()

    expect(hasImagesToDescribe('c', [])).toBe(false)
    expect(
      await describeConversationImages({
        conversationId: 'c',
        cwd: '/tmp/w',
        pendingParts: [],
        signal: new AbortController().signal,
      })
    ).toEqual({ described: 0, historyChanged: false })
    expect(generateText).not.toHaveBeenCalled()
  })

  it('tolerates disabled or failed interpreters without breaking turns', async () => {
    const parts: MessagePart[] = [imagePart('f1')]
    // Disabled: does not attempt.
    expect(
      await describeConversationImages({
        conversationId: 'c',
        cwd: '/tmp/w',
        pendingParts: parts,
        signal: new AbortController().signal,
      })
    ).toEqual({ described: 0, historyChanged: false })
    expect(generateText).not.toHaveBeenCalled()

    enable()
    generateText.mockRejectedValueOnce(new Error('provider unavailable'))
    expect(
      await describeConversationImages({
        conversationId: 'c',
        cwd: '/tmp/w',
        pendingParts: parts,
        signal: new AbortController().signal,
      })
    ).toEqual({ described: 0, historyChanged: false })
    expect((parts[0] as Extract<MessagePart, { type: 'file' }>).description).toBeUndefined()
  })

  it('bounds negative-cache retries and rearms on configuration changes', async () => {
    enable()
    generateText.mockRejectedValue(new Error('permanently broken interpreter'))
    const part = imagePart('f1')
    const attempt = () =>
      describeConversationImages({
        conversationId: 'c',
        cwd: '/tmp/w',
        pendingParts: [part],
        signal: new AbortController().signal,
      })

    await attempt() // tentativa 1
    await attempt() // Attempt 2 (last).
    await attempt() // Exhausted: no more calls.
    await attempt()
    expect(generateText).toHaveBeenCalledTimes(2)

    // Changing or resaving configuration rearms attempts; success clears the counter.
    enable()
    generateText.mockResolvedValue({ text: 'Agora foi.' })
    expect(await attempt()).toEqual({ described: 1, historyChanged: false })
    expect(generateText).toHaveBeenCalledTimes(3)
    expect(part.description).toBe('Agora foi.')
  })

  it('SERIALIZES per conversation: two concurrent cycles for the same image make ONE paid call', async () => {
    upsertChatMessage(userMessage('u1', [imagePart('f1')]))
    enable()
    let release!: (value: { text: string }) => void
    generateText.mockReturnValueOnce(
      new Promise<{ text: string }>((resolve) => {
        release = resolve
      })
    )

    const first = describeConversationImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      pendingParts: [],
      signal: new AbortController().signal,
    })
    // Concurrent cycles wait for initial interpretation and then rescan.
    const second = describeConversationImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      pendingParts: [],
      signal: new AbortController().signal,
    })
    release({ text: 'Unique description.' })
    expect(await first).toEqual({ described: 1, historyChanged: true })
    expect(await second).toEqual({ described: 0, historyChanged: false })
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('deduplicates interpretation while keeping consumer cancellation local', async () => {
    enable()
    const image = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'CCCC', mimeType: 'image/png' }] })
    )[0]
    expect(image).toBeDefined()
    let release!: (value: { text: string }) => void
    let interpreterSignal!: AbortSignal
    generateText.mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) => {
      interpreterSignal = abortSignal
      return new Promise<{ text: string }>((resolve) => {
        release = resolve
      })
    })

    const firstController = new AbortController()
    const secondController = new AbortController()
    const thirdController = new AbortController()
    const first = describeEphemeralToolImage({
      image: image!,
      conversationId: 'c',
      cwd: '/tmp/w',
      signal: firstController.signal,
    })
    const second = describeEphemeralToolImage({
      image: image!,
      conversationId: 'c',
      cwd: '/tmp/w',
      signal: secondController.signal,
    })
    const third = describeEphemeralToolImage({
      image: image!,
      conversationId: 'c',
      cwd: '/tmp/w',
      signal: thirdController.signal,
    })
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1))

    const stopReason = new Error('Stop first consumer')
    firstController.abort(stopReason)
    await expect(first).rejects.toBe(stopReason)
    expect(interpreterSignal.aborted).toBe(false)

    release({ text: 'Shared description.' })
    await expect(second).resolves.toEqual({
      text: 'Shared description.',
      model: 'Vision Co/vision-model',
    })
    await expect(third).resolves.toEqual({
      text: 'Shared description.',
      model: 'Vision Co/vision-model',
    })
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('reuses completed descriptions until configuration changes', async () => {
    enable()
    const image = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'HHHH', mimeType: 'image/png' }] })
    )[0]
    expect(image).toBeDefined()
    generateText.mockResolvedValueOnce({ text: 'Cached description.' })

    await expect(
      describeEphemeralToolImage({
        image: image!,
        conversationId: 'c',
        cwd: '/tmp/w',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ text: 'Cached description.' })
    await expect(
      describeEphemeralToolImage({
        image: image!,
        conversationId: 'c',
        cwd: '/tmp/w',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ text: 'Cached description.' })
    expect(generateText).toHaveBeenCalledTimes(1)

    setImageInterpreter({ providerId, modelId: 'vision-model', effort: 'low' })
    generateText.mockResolvedValueOnce({ text: 'New configuration description.' })
    await expect(
      describeEphemeralToolImage({
        image: image!,
        conversationId: 'c',
        cwd: '/tmp/w',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ text: 'New configuration description.' })
    expect(generateText).toHaveBeenCalledTimes(2)
  })

  it('bounds LRU descriptions without expiring active handles', async () => {
    enable()
    const image = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'IIII', mimeType: 'image/png' }] })
    )[0]
    expect(image).toBeDefined()

    for (let index = 0; index < MAX_EPHEMERAL_IMAGE_CACHE_ENTRIES; index++) {
      await describeEphemeralToolImage({
        image: image!,
        conversationId: `conversation-${index}`,
        cwd: '/tmp/w',
        signal: new AbortController().signal,
      })
    }
    expect(generateText).toHaveBeenCalledTimes(MAX_EPHEMERAL_IMAGE_CACHE_ENTRIES)

    await describeEphemeralToolImage({
      image: image!,
      conversationId: 'conversation-0',
      cwd: '/tmp/w',
      signal: new AbortController().signal,
    })
    await describeEphemeralToolImage({
      image: image!,
      conversationId: `conversation-${MAX_EPHEMERAL_IMAGE_CACHE_ENTRIES}`,
      cwd: '/tmp/w',
      signal: new AbortController().signal,
    })
    expect(generateText).toHaveBeenCalledTimes(MAX_EPHEMERAL_IMAGE_CACHE_ENTRIES + 1)
    await describeEphemeralToolImage({
      image: image!,
      conversationId: 'conversation-1',
      cwd: '/tmp/w',
      signal: new AbortController().signal,
    })
    expect(generateText).toHaveBeenCalledTimes(MAX_EPHEMERAL_IMAGE_CACHE_ENTRIES + 2)

    // Touch the byte handle without touching its description; only the positive entry should expire.
    const baseTime = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(baseTime)
    try {
      await describeEphemeralToolImage({
        image: image!,
        conversationId: 'conversation-0',
        cwd: '/tmp/w',
        signal: new AbortController().signal,
      })
      now.mockReturnValue(baseTime + EPHEMERAL_IMAGE_CACHE_TTL_MS - 1)
      const touchedImage = toolOutputImages(
        mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'IIII', mimeType: 'image/png' }] })
      )[0]
      expect(touchedImage?.id).toBe(image?.id)
      now.mockReturnValue(baseTime + EPHEMERAL_IMAGE_CACHE_TTL_MS + 1)
      await describeEphemeralToolImage({
        image: touchedImage!,
        conversationId: 'conversation-0',
        cwd: '/tmp/w',
        signal: new AbortController().signal,
      })
    } finally {
      now.mockRestore()
    }
    expect(generateText).toHaveBeenCalledTimes(MAX_EPHEMERAL_IMAGE_CACHE_ENTRIES + 3)
  })

  it('isolates shared-handle flights and failures by conversation', async () => {
    enable()
    const imageA = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'FFFF', mimeType: 'image/png' }] })
    )[0]
    const imageB = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'FFFF', mimeType: 'image/png' }] })
    )[0]
    expect(imageA).toBeDefined()
    expect(imageB).toMatchObject({ id: imageA?.id })

    type GeneratedImage = {
      text: string
      totalUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number }
    }
    let releaseA!: (value: GeneratedImage) => void
    let releaseB!: (value: GeneratedImage) => void
    generateText
      .mockImplementationOnce(
        () =>
          new Promise<GeneratedImage>((resolve) => {
            releaseA = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<GeneratedImage>((resolve) => {
            releaseB = resolve
          })
      )

    const first = describeEphemeralToolImage({
      image: imageA!,
      conversationId: 'conversation-a',
      cwd: '/tmp/a',
      signal: new AbortController().signal,
    })
    const second = describeEphemeralToolImage({
      image: imageB!,
      conversationId: 'conversation-b',
      cwd: '/tmp/b',
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(2))

    releaseA({
      text: 'Conversation A description.',
      totalUsage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 },
    })
    releaseB({
      text: 'Conversation B description.',
      totalUsage: { inputTokens: 20, outputTokens: 3, cachedInputTokens: 0 },
    })
    await expect(first).resolves.toMatchObject({ text: 'Conversation A description.' })
    await expect(second).resolves.toMatchObject({ text: 'Conversation B description.' })
    expect(recordModelCallUsage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conversation-a' }))
    expect(recordModelCallUsage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conversation-b' }))
    expect(generateText).toHaveBeenCalledTimes(2)

    const failedImageA = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'GGGG', mimeType: 'image/png' }] })
    )[0]
    expect(failedImageA).toBeDefined()
    expect(failedImageA?.id).not.toBe(imageA?.id)
    generateText
      .mockRejectedValueOnce(new Error('conversation A interpreter failure'))
      .mockRejectedValueOnce(new Error('conversation A interpreter failure again'))
    await expect(
      describeEphemeralToolImage({
        image: failedImageA!,
        conversationId: 'conversation-a',
        cwd: '/tmp/a',
        signal: new AbortController().signal,
      })
    ).resolves.toBeNull()
    await expect(
      describeEphemeralToolImage({
        image: failedImageA!,
        conversationId: 'conversation-a',
        cwd: '/tmp/a',
        signal: new AbortController().signal,
      })
    ).resolves.toBeNull()

    await expect(
      describeEphemeralToolImage({
        image: imageB!,
        conversationId: 'conversation-b',
        cwd: '/tmp/b',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ text: 'Conversation B description.' })
    expect(generateText).toHaveBeenCalledTimes(4)
  })

  it('separates same-handle descriptions and failures by name', async () => {
    enable()
    // Same bytes means same handle; different names mean different prompts (userPrompt embeds the name).
    const namedImage = (filename: string) =>
      toolOutputImages(
        modelOutputToChatToolOutput({
          type: 'content',
          value: [{ type: 'file', data: { type: 'data', data: 'FFFF' }, mediaType: 'image/png', filename }],
        })
      )[0]
    const imageA = namedImage('error-a.png')
    const imageB = namedImage('error-b.png')
    expect(imageA).toBeDefined()
    expect(imageB).toMatchObject({ id: imageA?.id, name: 'error-b.png' })

    generateText
      .mockResolvedValueOnce({
        text: 'Description of A.',
        totalUsage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 },
      })
      .mockResolvedValueOnce({
        text: 'Description of B.',
        totalUsage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 },
      })

    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageA!))).resolves.toMatchObject({
      text: 'Description of A.',
    })
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageB!))).resolves.toMatchObject({
      text: 'Description of B.',
    })
    expect(generateText).toHaveBeenCalledTimes(2)
    // Each request includes its own reference name.
    const prompts = generateText.mock.calls.map((call) => JSON.stringify(call[0].messages))
    expect(prompts[0]).toContain('error-a.png')
    expect(prompts[1]).toContain('error-b.png')

    // Each name has a separate cache key and avoids repeated calls.
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageA!))).resolves.toMatchObject({
      text: 'Description of A.',
    })
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageB!))).resolves.toMatchObject({
      text: 'Description of B.',
    })
    expect(generateText).toHaveBeenCalledTimes(2)
  })

  it('deduplicates same-name image descriptions', async () => {
    enable()
    const namedImage = (filename: string) =>
      toolOutputImages(
        modelOutputToChatToolOutput({
          type: 'content',
          value: [{ type: 'file', data: { type: 'data', data: 'FFFF' }, mediaType: 'image/png', filename }],
        })
      )[0]
    const imageA = namedImage('error.png')
    const imageB = namedImage('error.png')
    expect(imageA).toBeDefined()
    expect(imageB?.id).toBe(imageA?.id)

    let release!: (value: { text: string }) => void
    generateText.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((resolve) => {
          release = resolve
        })
    )

    const first = describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageA!))
    const second = describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageB!))
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1))
    release({ text: 'Unique description.' })
    await expect(first).resolves.toMatchObject({ text: 'Unique description.' })
    await expect(second).resolves.toMatchObject({ text: 'Unique description.' })

    // Sequential calls reuse positive cached descriptions.
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageA!))).resolves.toMatchObject({
      text: 'Unique description.',
    })
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('does not exhaust another name retry budget for the same handle', async () => {
    enable()
    const namedImage = (filename: string) =>
      toolOutputImages(
        modelOutputToChatToolOutput({
          type: 'content',
          value: [{ type: 'file', data: { type: 'data', data: 'FFFF' }, mediaType: 'image/png', filename }],
        })
      )[0]
    const imageA = namedImage('failure-a.png')
    const imageB = namedImage('failure-b.png')
    expect(imageA).toBeDefined()
    expect(imageB?.id).toBe(imageA?.id)

    generateText.mockRejectedValue(new Error('interpreter unavailable'))
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageA!))).resolves.toBeNull()
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageA!))).resolves.toBeNull()
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageA!))).resolves.toBeNull()
    // Exhausting name A retries does not exhaust name B.
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageB!))).resolves.toBeNull()
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageB!))).resolves.toBeNull()
    expect(generateText).toHaveBeenCalledTimes(4)
  })

  it('releases flights after all consumers abort without caching failures', async () => {
    enable()
    const image = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'EEEE', mimeType: 'image/png' }] })
    )[0]
    expect(image).toBeDefined()
    generateText.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
        })
    )

    const controller = new AbortController()
    const pending = describeEphemeralToolImage({
      image: image!,
      conversationId: 'c',
      cwd: '/tmp/w',
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1))
    const stopReason = new Error('Stop')
    controller.abort(stopReason)
    await expect(pending).rejects.toBe(stopReason)

    generateText.mockImplementationOnce(async () => ({ text: 'New attempt.' }))
    await expect(
      describeEphemeralToolImage({
        image: image!,
        conversationId: 'c',
        cwd: '/tmp/w',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ text: 'New attempt.', model: 'Vision Co/vision-model' })
    expect(generateText).toHaveBeenCalledTimes(2)
  })

  it('releases failed flights for retries without duplicate failures', async () => {
    enable()
    const image = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'DDDD', mimeType: 'image/png' }] })
    )[0]
    expect(image).toBeDefined()
    generateText.mockRejectedValueOnce(new Error('temporary interpreter failure'))

    const first = describeEphemeralToolImage({
      image: image!,
      conversationId: 'c',
      cwd: '/tmp/w',
      signal: new AbortController().signal,
    })
    const second = describeEphemeralToolImage({
      image: image!,
      conversationId: 'c',
      cwd: '/tmp/w',
      signal: new AbortController().signal,
    })
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    expect(generateText).toHaveBeenCalledTimes(1)

    generateText.mockResolvedValueOnce({ text: 'Retry bem-sucedido.' })
    await expect(
      describeEphemeralToolImage({
        image: image!,
        conversationId: 'c',
        cwd: '/tmp/w',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ text: 'Retry bem-sucedido.', model: 'Vision Co/vision-model' })
    expect(generateText).toHaveBeenCalledTimes(2)
  })

  it('bounds ephemeral interpretation and caches timeout failures', async () => {
    enable()
    const image = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] })
    )[0]
    expect(image).toBeDefined()
    generateText.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
        })
    )

    const firstTimeout = new AbortController()
    const secondTimeout = new AbortController()
    const timeoutControllers = [firstTimeout, secondTimeout]
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeoutControllers.shift()!.signal)
    try {
      const pending = describeEphemeralToolImage({
        image: image!,
        conversationId: 'c',
        cwd: '/tmp/w',
        signal: new AbortController().signal,
      })
      await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1))
      expect(timeout).toHaveBeenCalledWith(DESCRIBE_TIMEOUT_MS)
      firstTimeout.abort(new Error('interpreter timeout'))
      await expect(pending).resolves.toBeNull()

      const retry = describeEphemeralToolImage({
        image: image!,
        conversationId: 'c',
        cwd: '/tmp/w',
        signal: new AbortController().signal,
      })
      await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(2))
      secondTimeout.abort(new Error('interpreter timeout'))
      await expect(retry).resolves.toBeNull()

      await expect(
        describeEphemeralToolImage({
          image: image!,
          conversationId: 'c',
          cwd: '/tmp/w',
          signal: new AbortController().signal,
        })
      ).resolves.toBeNull()
      expect(generateText).toHaveBeenCalledTimes(2)
    } finally {
      timeout.mockRestore()
    }
  })

  it('propagates Stop instead of returning omission', async () => {
    enable()
    const image = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'BBBB', mimeType: 'image/png' }] })
    )[0]
    expect(image).toBeDefined()
    let interpreterSignal!: AbortSignal
    generateText.mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) => {
      interpreterSignal = abortSignal
      return new Promise((_, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
      })
    })

    const controller = new AbortController()
    const reason = new Error('Stop')
    const pending = describeEphemeralToolImage({
      image: image!,
      conversationId: 'c',
      cwd: '/tmp/w',
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(interpreterSignal).toBeDefined())
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(interpreterSignal.aborted).toBe(true)
  })
})

describe('interpreter identity across credential changes', () => {
  const imageFor = (data: string) =>
    toolOutputImages(mcpResultToChatToolOutput({ content: [{ type: 'image', data, mimeType: 'image/png' }] }))[0]!

  it('invalidates positive image cache after API key changes', async () => {
    enable()
    const image = imageFor('P1P1')
    generateText.mockResolvedValueOnce({
      text: 'Old identity description.',
      totalUsage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 },
    })

    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image))).resolves.toMatchObject({
      text: 'Old identity description.',
    })
    // Same identity: reuses the positive cache without another call.
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image))).resolves.toMatchObject({
      text: 'Old identity description.',
    })
    expect(generateText).toHaveBeenCalledTimes(1)

    apiKeyValue = 'new-key'
    generateText.mockResolvedValueOnce({
      text: 'New identity description.',
      totalUsage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 },
    })
    // Changed credentials prevent reuse of old-identity descriptions.
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image))).resolves.toMatchObject({
      text: 'New identity description.',
    })
    expect(generateText).toHaveBeenCalledTimes(2)
    // The new identity receives its own cache.
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image))).resolves.toMatchObject({
      text: 'New identity description.',
    })
    expect(generateText).toHaveBeenCalledTimes(2)
  })

  it('rearms negative cache after API key changes', async () => {
    enable()
    const image = imageFor('P2P2')
    generateText.mockRejectedValue(new Error('broken interpreter'))
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image))).resolves.toBeNull()
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image))).resolves.toBeNull()
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image))).resolves.toBeNull()
    expect(generateText).toHaveBeenCalledTimes(2) // Exhausted under the old identity.

    apiKeyValue = 'new-key'
    generateText.mockResolvedValueOnce({
      text: 'Retry with the new identity.',
      totalUsage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 },
    })
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image))).resolves.toMatchObject({
      text: 'Retry with the new identity.',
    })
    expect(generateText).toHaveBeenCalledTimes(3)
  })

  it('does NOT share single-flight across distinct identities but shares it within the SAME identity', async () => {
    enable()
    const image = imageFor('P3P3')
    type GeneratedImage = {
      text: string
      totalUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number }
    }
    let releaseOld!: (value: GeneratedImage) => void
    let releaseNew!: (value: GeneratedImage) => void
    generateText
      .mockImplementationOnce(
        () =>
          new Promise<GeneratedImage>((resolve) => {
            releaseOld = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<GeneratedImage>((resolve) => {
            releaseNew = resolve
          })
      )

    const first = describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image))
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1))

    // Consumers after key rotation cannot join old-identity requests.
    apiKeyValue = 'new-key'
    const second = describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image))
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(2))
    // A third consumer with the SAME new identity shares the new flight.
    const third = describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image))
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(2))

    releaseOld({ text: 'Old flight.', totalUsage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 } })
    releaseNew({ text: 'New flight.', totalUsage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 } })
    await expect(first).resolves.toMatchObject({ text: 'Old flight.' })
    await expect(second).resolves.toMatchObject({ text: 'New flight.' })
    await expect(third).resolves.toMatchObject({ text: 'New flight.' })
    expect(generateText).toHaveBeenCalledTimes(2)
  })

  it('rearms conversation attempts after credential changes', async () => {
    enable()
    upsertChatMessage(userMessage('u1', [imagePart('f1', 'velha.png')]))
    generateText.mockRejectedValue(new Error('broken interpreter'))
    for (let round = 0; round < 3; round++) {
      await describeConversationImages({
        conversationId: 'c',
        cwd: '/tmp/w',
        pendingParts: [],
        signal: new AbortController().signal,
      })
    }
    expect(generateText).toHaveBeenCalledTimes(2) // Exhausted under the old identity.

    apiKeyValue = 'new-key'
    generateText.mockResolvedValueOnce({
      text: 'Now using the new key.',
      totalUsage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 },
    })
    const result = await describeConversationImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      pendingParts: [],
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ described: 1, historyChanged: true })
    expect(generateText).toHaveBeenCalledTimes(3)
  })
})

/** Persist a tool-image message as the durable reference owner. */
function toolImageOwnerMessage(id: string, conversationId: string, imageId: string, toolPartId = 't1'): ChatMessage {
  return {
    id,
    conversationId,
    role: 'assistant',
    parts: [
      {
        type: 'tool',
        id: toolPartId,
        toolCallId: toolPartId,
        toolName: 'bash',
        input: {},
        state: { status: 'completed', output: { text: 'x', images: [{ id: imageId, mediaType: 'image/png' }] } },
      },
    ],
    createdAt: Date.now(),
  }
}

const EPHEMERAL_DESCRIBE_ARGS = (conversationId: string, image: ChatToolImage) => ({
  image,
  conversationId,
  cwd: '/tmp/w',
  signal: new AbortController().signal,
})

describe('description lifecycle on conversation and message deletion', () => {
  it('clears only conversation-owned descriptions for shared handles', async () => {
    enable()
    const image = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'JJJJ', mimeType: 'image/png' }] })
    )[0]
    expect(image).toBeDefined()
    // Shared handles require another durable owner outside the cleared conversation;
    // otherwise byte cleanup correctly prevents reinterpretation.
    upsertChatMessage(toolImageOwnerMessage('m-owner-a', 'c', image!.id))
    insertConversation({
      id: 'conversation-b',
      workspaceId: 'w',
      name: 'B',
      branch: 'main',
      mode: 'local',
      experience: 'standard',
      cwd: '/tmp/w',
      status: 'idle',
      createdAt: 1,
      archived: 0,
      pinnedAt: null,
      lastActivityAt: 1,
      isMulti: 0,
    })
    upsertChatMessage(toolImageOwnerMessage('m-owner-b', 'conversation-b', image!.id))

    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image!))).resolves.toMatchObject({
      text: 'Terminal screenshot: ENOENT error on line 3.',
    })
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('conversation-b', image!))).resolves.toMatchObject({
      text: 'Terminal screenshot: ENOENT error on line 3.',
    })
    expect(generateText).toHaveBeenCalledTimes(2)

    await clearChatMessages('c')

    // Descriptions lose cleared ownership while bytes survive through B.
    generateText.mockResolvedValueOnce({ text: 'Described again after clear.' })
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image!))).resolves.toMatchObject({
      text: 'Described again after clear.',
    })
    // Other-owner descriptions stay cached; cleared conversations can cache anew.
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('conversation-b', image!))).resolves.toMatchObject({
      text: 'Terminal screenshot: ENOENT error on line 3.',
    })
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image!))).resolves.toMatchObject({
      text: 'Described again after clear.',
    })
    expect(generateText).toHaveBeenCalledTimes(3)
  })

  it('removes only descriptions belonging to deleted messages', async () => {
    enable()
    const imageA = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'K1K1', mimeType: 'image/png' }] })
    )[0]
    const imageB = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'K2K2', mimeType: 'image/png' }] })
    )[0]
    expect(imageA).toBeDefined()
    expect(imageB).toBeDefined()
    expect(imageB?.id).not.toBe(imageA?.id)
    upsertChatMessage(toolImageOwnerMessage('m-keep', 'c', imageB!.id, 't-keep'))
    upsertChatMessage(toolImageOwnerMessage('m-remove', 'c', imageA!.id, 't-remove'))
    // Removed the shared handle owner; otherwise cleanup would free the bytes and mask the cache.
    insertConversation({
      id: 'conversation-b',
      workspaceId: 'w',
      name: 'B',
      branch: 'main',
      mode: 'local',
      experience: 'standard',
      cwd: '/tmp/w',
      status: 'idle',
      createdAt: 1,
      archived: 0,
      pinnedAt: null,
      lastActivityAt: 1,
      isMulti: 0,
    })
    upsertChatMessage(toolImageOwnerMessage('m-owner-b', 'conversation-b', imageA!.id))

    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageA!))).resolves.toMatchObject({
      text: 'Terminal screenshot: ENOENT error on line 3.',
    })
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageB!))).resolves.toMatchObject({
      text: 'Terminal screenshot: ENOENT error on line 3.',
    })
    expect(generateText).toHaveBeenCalledTimes(2)

    deleteChatMessage('m-remove')

    // Deleted-handle descriptions are recomputed while shared bytes survive.
    generateText.mockResolvedValueOnce({ text: 'Described again after message deletion.' })
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageA!))).resolves.toMatchObject({
      text: 'Described again after message deletion.',
    })
    // Surviving handles in the same conversation keep descriptions cached.
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', imageB!))).resolves.toMatchObject({
      text: 'Terminal screenshot: ENOENT error on line 3.',
    })
    expect(generateText).toHaveBeenCalledTimes(3)
  })

  it('rearms truncated-part negative caches', async () => {
    enable()
    generateText.mockRejectedValue(new Error('interpreter unavailable'))
    // Keep sequence one and truncate sequence two; later reuse IDs to test rearming.
    upsertChatMessage(userMessage('m-old', [imagePart('f1', 'velha.png')]))
    upsertChatMessage(userMessage('m-truncated', [imagePart('f2', 'truncated.png')]))

    for (let round = 0; round < 2; round++) {
      await describeConversationImages({
        conversationId: 'c',
        cwd: '/tmp/w',
        pendingParts: [],
        signal: new AbortController().signal,
      })
    }
    expect(generateText).toHaveBeenCalledTimes(4) // 2 images × 2 attempts

    // Exhausted attempts do not invoke the interpreter next turn.
    await describeConversationImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      pendingParts: [],
      signal: new AbortController().signal,
    })
    expect(generateText).toHaveBeenCalledTimes(4)

    deleteChatMessagesFrom('c', getMessageSeq('m-truncated')!)
    upsertChatMessage(userMessage('m-reborn', [imagePart('f2', 'restored.png')]))

    generateText.mockResolvedValue({ text: 'Agora vai.' })
    const described = await describeConversationImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      pendingParts: [],
      signal: new AbortController().signal,
    })
    // Truncation rearmed f2 (the truncated part owned the failure); f1 remains exhausted.
    expect(described).toEqual({ described: 1, historyChanged: true })
    expect(generateText).toHaveBeenCalledTimes(5)
    const reborn = listChatMessages('c').find((m) => m.id === 'm-reborn')
    expect((reborn?.parts[0] as Extract<MessagePart, { type: 'file' }>).description).toBe('Agora vai.')
  })

  it('clears positive and negative caches without killing live conversations', async () => {
    enable()
    const image = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'LLLL', mimeType: 'image/png' }] })
    )[0]
    expect(image).toBeDefined()
    generateText.mockRejectedValue(new Error('broken interpreter'))
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image!))).resolves.toBeNull()
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image!))).resolves.toBeNull()
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image!))).resolves.toBeNull()
    expect(generateText).toHaveBeenCalledTimes(2) // esgotado no cache negativo

    clearConversationToolImageMetadata('c')

    generateText.mockResolvedValueOnce({ text: 'Retry after cleanup.' })
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image!))).resolves.toMatchObject({
      text: 'Retry after cleanup.',
    })
    // Clearing allows recaching because it does not create deletion tombstones.
    await expect(describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('c', image!))).resolves.toMatchObject({
      text: 'Retry after cleanup.',
    })
    expect(generateText).toHaveBeenCalledTimes(3)
  })

  it('prevents recaching late descriptions after metadata tombstones', async () => {
    enable()
    const image = toolOutputImages(
      mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'MMMM', mimeType: 'image/png' }] })
    )[0]
    expect(image).toBeDefined()
    let release!: (value: { text: string }) => void
    generateText.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((resolve) => {
          release = resolve
        })
    )

    const inFlight = describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('conversation-deleted', image!))
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1))

    deleteConversationToolImageMetadata('conversation-deleted')
    release({ text: 'Completed after deletion.' })
    await expect(inFlight).resolves.toMatchObject({ text: 'Completed after deletion.' })

    // Late completion did not recache; every new attempt reaches the interpreter.
    generateText.mockResolvedValue({ text: 'No cache.' })
    await expect(
      describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('conversation-deleted', image!))
    ).resolves.toMatchObject({
      text: 'No cache.',
    })
    await expect(
      describeEphemeralToolImage(EPHEMERAL_DESCRIBE_ARGS('conversation-deleted', image!))
    ).resolves.toMatchObject({
      text: 'No cache.',
    })
    expect(generateText).toHaveBeenCalledTimes(3)
  })
})

describe('persisted tool image enrichment after runner discovery', () => {
  const toolMessage = (output: ToolOutput): ChatMessage => ({
    id: 'a1',
    conversationId: 'c',
    role: 'assistant',
    createdAt: 2,
    parts: [
      {
        type: 'tool',
        id: 'shot-1',
        toolCallId: 'shot-1',
        toolName: 'browser_screenshot',
        input: {},
        state: { status: 'completed', output },
      },
    ],
  })

  it('returns enriched tool outputs without mutating messages', async () => {
    enable()
    const canonical = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const enriched = await describePersistedToolImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      message: toolMessage(canonical),
      signal: new AbortController().signal,
    })
    expect(enriched).toHaveLength(1)
    expect(enriched[0].toolCallId).toBe('shot-1')
    const images = toolOutputImages(enriched[0].output)
    expect(images[0]?.description).toContain('Terminal screenshot')
    expect(images[0]?.descriptionModel).toBe('Vision Co/vision-model')
    // Do not mutate original runner messages; callers choose persistence.
    expect(toolOutputImages(canonical)[0]?.description).toBeUndefined()
    // Cached descriptions prevent repeated vision charges.
    const second = await describePersistedToolImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      message: toolMessage(canonical),
      signal: new AbortController().signal,
    })
    expect(second).toHaveLength(1)
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('returns nothing without an interpreter or undescribed images', async () => {
    const canonical = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    // Without configured interpreters, return nothing and make no calls.
    expect(
      await describePersistedToolImages({
        conversationId: 'c',
        cwd: '/tmp/w',
        message: toolMessage(canonical),
        signal: new AbortController().signal,
      })
    ).toEqual([])
    expect(generateText).not.toHaveBeenCalled()
    // Text output without images: nothing to process.
    expect(
      await describePersistedToolImages({
        conversationId: 'c',
        cwd: '/tmp/w',
        message: toolMessage('plain text'),
        signal: new AbortController().signal,
      })
    ).toEqual([])
    // Images ALREADY described need no new calls.
    enable()
    const first = await describePersistedToolImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      message: toolMessage(canonical),
      signal: new AbortController().signal,
    })
    expect(first).toHaveLength(1)
    const callsBefore = generateText.mock.calls.length
    expect(
      await describePersistedToolImages({
        conversationId: 'c',
        cwd: '/tmp/w',
        message: toolMessage(first[0].output),
        signal: new AbortController().signal,
      })
    ).toEqual([])
    expect(generateText.mock.calls.length).toBe(callsBefore)
  })
})

describe('conditional post-turn image enrichment persistence', () => {
  const toolMessage = (output: ToolOutput): ChatMessage => ({
    id: 'a1',
    conversationId: 'c',
    role: 'assistant',
    createdAt: 2,
    parts: [
      {
        type: 'tool',
        id: 'shot-1',
        toolCallId: 'shot-1',
        toolName: 'browser_screenshot',
        input: {},
        state: { status: 'completed', output },
      },
    ],
  })
  const canonical = () =>
    mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] })

  const completedOutput = (parts: MessagePart[]): ToolOutput | undefined => {
    const part = parts[0] as Extract<MessagePart, { type: 'tool' }>
    if (part.type !== 'tool' || (part.state.status !== 'completed' && part.state.status !== 'running')) return undefined
    return part.state.output
  }

  const describeAndApply = async (): Promise<void> => {
    const enriched = await describePersistedToolImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      message: toolMessage(canonical()),
      signal: new AbortController().signal,
    })
    expect(enriched).toHaveLength(1)
    applyPersistedToolImageEnrichment({ conversationId: 'c', messageId: 'a1', enriched })
  }

  it('patches persisted messages with descriptions', async () => {
    enable()
    upsertChatMessage(toolMessage(canonical()))
    await describeAndApply()
    const stored = listChatMessages('c')[0]
    const output = completedOutput(stored.parts)
    expect(toolOutputImages(output)[0]?.description).toContain('Terminal screenshot')
    expect(toolOutputImages(output)[0]?.descriptionModel).toBe('Vision Co/vision-model')
  })

  it('does not resurrect cleared messages after pending enrichment', async () => {
    enable()
    upsertChatMessage(toolMessage(canonical()))
    const enriched = await describePersistedToolImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      message: toolMessage(canonical()),
      signal: new AbortController().signal,
    })
    await clearChatMessages('c')
    applyPersistedToolImageEnrichment({ conversationId: 'c', messageId: 'a1', enriched })
    expect(listChatMessages('c')).toEqual([])
  })

  it('does not resurrect deleted messages after pending enrichment', async () => {
    enable()
    upsertChatMessage(toolMessage(canonical()))
    const enriched = await describePersistedToolImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      message: toolMessage(canonical()),
      signal: new AbortController().signal,
    })
    deleteChatMessage('a1')
    applyPersistedToolImageEnrichment({ conversationId: 'c', messageId: 'a1', enriched })
    expect(listChatMessages('c')).toEqual([])
  })

  it('does not resurrect truncated messages after pending enrichment', async () => {
    enable()
    upsertChatMessage(toolMessage(canonical()))
    const enriched = await describePersistedToolImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      message: toolMessage(canonical()),
      signal: new AbortController().signal,
    })
    deleteChatMessagesFrom('c', getMessageSeq('a1')!)
    applyPersistedToolImageEnrichment({ conversationId: 'c', messageId: 'a1', enriched })
    expect(listChatMessages('c')).toEqual([])
  })

  it('preserves newer output for the same tool call', async () => {
    enable()
    upsertChatMessage(toolMessage(canonical()))
    const enriched = await describePersistedToolImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      message: toolMessage(canonical()),
      signal: new AbortController().signal,
    })
    // Rewriting the SAME bubble (same id and toolCallId) with DIFFERENT bytes gives different image ids.
    const newer = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'ZGlmZmVyZW50LWJ5dGVz', mimeType: 'image/png' }],
    })
    expect(toolOutputImages(newer)[0]?.id).not.toBe(toolOutputImages(canonical())[0]?.id)
    upsertChatMessage(toolMessage(newer))
    applyPersistedToolImageEnrichment({ conversationId: 'c', messageId: 'a1', enriched })
    const output = completedOutput(listChatMessages('c')[0].parts)
    expect(toolOutputImages(output)[0]?.id).toBe(toolOutputImages(newer)[0]?.id)
    expect(toolOutputImages(output)[0]?.description).toBeUndefined()
  })

  it('adds only descriptions to newer completed image state', async () => {
    enable()
    const snapshotImage = toolOutputImages(canonical())[0]!
    const runningMessage: ChatMessage = {
      id: 'a1',
      conversationId: 'c',
      role: 'assistant',
      createdAt: 2,
      parts: [
        {
          type: 'tool',
          id: 'shot-1',
          toolCallId: 'shot-1',
          toolName: 'browser_screenshot',
          input: {},
          state: { status: 'running', output: { text: 'capturing the screen…', images: [snapshotImage] } },
        },
      ],
    }
    const enriched = await describePersistedToolImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      message: runningMessage,
      signal: new AbortController().signal,
    })
    expect(enriched).toHaveLength(1)
    // Tools may complete while descriptions are pending with the same image handle
    // but newer text and structured metadata; patches must preserve the newer state.
    upsertChatMessage({
      ...runningMessage,
      parts: [
        {
          type: 'tool',
          id: 'shot-1',
          toolCallId: 'shot-1',
          toolName: 'browser_screenshot',
          input: {},
          state: {
            status: 'completed',
            output: {
              text: 'Screenshot AFTER retry: pipeline verde.',
              images: [snapshotImage],
              structuredContent: { status: 'ok', attempts: 2 },
              isError: true,
            },
          },
        },
      ],
    })
    applyPersistedToolImageEnrichment({ conversationId: 'c', messageId: 'a1', enriched })
    const output = completedOutput(listChatMessages('c')[0].parts)
    expect(output).toMatchObject({
      text: 'Screenshot AFTER retry: pipeline verde.',
      structuredContent: { status: 'ok', attempts: 2 },
      isError: true,
    })
    expect(toolOutputImages(output)[0]?.id).toBe(snapshotImage.id)
    expect(toolOutputImages(output)[0]?.description).toContain('Terminal screenshot')
    expect(toolOutputImages(output)[0]?.descriptionModel).toBe('Vision Co/vision-model')
  })

  it('does not recreate removed message parts', async () => {
    enable()
    upsertChatMessage(toolMessage(canonical()))
    const enriched = await describePersistedToolImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      message: toolMessage(canonical()),
      signal: new AbortController().signal,
    })
    upsertChatMessage({
      id: 'a1',
      conversationId: 'c',
      role: 'assistant',
      createdAt: 3,
      parts: [{ type: 'text', id: 't1', text: 'new version without the tool part' }],
    })
    applyPersistedToolImageEnrichment({ conversationId: 'c', messageId: 'a1', enriched })
    const stored = listChatMessages('c')[0]
    expect(stored.parts).toHaveLength(1)
    expect(stored.parts[0]).toMatchObject({ type: 'text', text: 'new version without the tool part' })
  })

  it('atomically patches current OpenAI sidecars without resurrection after clear', async () => {
    enable()
    const message = toolMessage(canonical())
    const ledger = createOpenAIResponsesLedger()
    ledger.entries.push({
      type: 'tool-result',
      toolCallId: 'shot-1',
      toolName: 'browser_screenshot',
      output: toOpenAIToolResultOutput(canonical(), '$.toolResult.maestrly'),
    })
    putChatMessageWithOpenAIInferenceState(message, {
      version: OPENAI_INFERENCE_STATE_VERSION,
      providerId,
      modelId: 'vision-model',
      providerFingerprint: 'f'.repeat(64),
      harnessProfile: 'openai-responses-v1',
      ledger,
    })
    putToolExecution({
      conversationId: 'c',
      messageId: 'a1',
      callId: 'shot-1',
      toolName: 'browser_screenshot',
      inputHash: 'hash',
      status: 'completed',
      output: canonical(),
    })
    const enriched = await describePersistedToolImages({
      conversationId: 'c',
      cwd: '/tmp/w',
      message,
      signal: new AbortController().signal,
    })
    applyPersistedToolImageEnrichment({ conversationId: 'c', messageId: 'a1', enriched })

    // Update both visual messages and current ledger sidecars.
    const visual = completedOutput(listChatMessages('c')[0].parts)
    expect(toolOutputImages(visual)[0]?.description).toContain('Terminal screenshot')
    const state = getOpenAIInferenceState('a1')
    expect(state).not.toBeNull()
    const entry = state!.ledger.entries.find((e) => e.type === 'tool-result' && e.toolCallId === 'shot-1')
    expect(entry?.type).toBe('tool-result')
    if (entry?.type !== 'tool-result') throw new Error('ledger entry ausente')
    expect(entry.output).toMatchObject({ type: 'maestrly-output' })
    if (entry.output.type !== 'maestrly-output') throw new Error('projection inesperada')
    expect(toolOutputImages(entry.output.value as unknown as ToolOutput)[0]?.description).toContain(
      'Terminal screenshot'
    )
    // Apply the same patch to crash-recovery checkpoints.
    expect(toolOutputImages(getToolExecution('c', 'shot-1')!.output as ToolOutput)[0]?.description).toContain(
      'Terminal screenshot'
    )

    // Clearing during enrichment must not resurrect messages or sidecars.
    await clearChatMessages('c')
    applyPersistedToolImageEnrichment({ conversationId: 'c', messageId: 'a1', enriched })
    expect(listChatMessages('c')).toEqual([])
    expect(getOpenAIInferenceState('a1')).toBeNull()
    expect(getToolExecution('c', 'shot-1')).toBeNull()
  })
})

it('routes Claude images through the physical target and avoids caching rotated results', async () => {
  const { CLAUDE_SUBSCRIPTION_PROVIDER_ID } = await import('../../src/main/chat/catalog')
  setImageInterpreter({ providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'vision-model' })
  const usage = { input: 4, output: 2, cacheRead: 0, cacheCreate: 0, totalInput: 4 }
  h.summarizeWithClaudeRuntime.mockResolvedValue({ text: 'Rotated image.', usage })
  const target = {
    providerId: `${CLAUDE_SUBSCRIPTION_PROVIDER_ID}@b`,
    runtimeModelId: 'resolved',
    accountIdentity: { fingerprint: 'b', epoch: 2 },
    manager: {},
    fastMode: false,
  }
  h.runClaudeEphemeralWithFailover.mockImplementation(async (args: any) => {
    const result = await args.operation(target, args.signal)
    args.onAttemptUsage({ target, attempt: 2, usage, outcome: 'success' })
    return result
  })
  const image = toolOutputImages(
    modelOutputToChatToolOutput({
      type: 'content',
      value: [{ type: 'file', data: { type: 'data', data: 'FFFF' }, mediaType: 'image/png' }],
    })
  )[0]!
  const args = { image, conversationId: 'c', cwd: '/tmp/w', signal: new AbortController().signal }
  await expect(describeEphemeralToolImage(args)).resolves.toMatchObject({ text: 'Rotated image.' })
  await expect(describeEphemeralToolImage(args)).resolves.toMatchObject({ text: 'Rotated image.' })
  expect(h.summarizeWithClaudeRuntime).toHaveBeenCalledTimes(2)
  expect(h.summarizeWithClaudeRuntime).toHaveBeenCalledWith(
    expect.objectContaining({
      accountIdentity: target.accountIdentity,
      modelId: 'resolved',
      images: [expect.objectContaining({ base64: 'FFFF', mediaType: 'image/png' })],
    })
  )
  expect(recordModelCallUsage).toHaveBeenCalledWith(
    expect.objectContaining({ providerId: target.providerId, attempt: 2, usage })
  )
})

it('does not share an old Claude in-flight description across account identity changes', async () => {
  const { CLAUDE_SUBSCRIPTION_PROVIDER_ID } = await import('../../src/main/chat/catalog')
  const { getClaudeSubscriptionManager } = await import('../../src/main/chat/claude-agent-sdk/manager')
  const snapshot = vi.spyOn(getClaudeSubscriptionManager(), 'getStatusSnapshot')
  snapshot.mockReturnValue({ accountFingerprint: 'a', accountEpoch: 1 } as any)
  setImageInterpreter({ providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'vision-model' })
  let release!: (value: { text: string }) => void
  h.runClaudeEphemeralWithFailover
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    .mockResolvedValue({ text: 'New account' })
  const image = toolOutputImages(
    modelOutputToChatToolOutput({
      type: 'content',
      value: [{ type: 'file', data: { type: 'data', data: 'FFFF' }, mediaType: 'image/png' }],
    })
  )[0]!
  const args = { image, conversationId: 'c', cwd: '/tmp/w', signal: new AbortController().signal }
  try {
    const old = describeEphemeralToolImage(args)
    await vi.waitFor(() => expect(h.runClaudeEphemeralWithFailover).toHaveBeenCalledTimes(1))
    snapshot.mockReturnValue({ accountFingerprint: 'b', accountEpoch: 2 } as any)
    await expect(describeEphemeralToolImage(args)).resolves.toMatchObject({ text: 'New account' })
    setImageInterpreter({ providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'vision-model' })
    release({ text: 'Old account' })
    await old
    await expect(describeEphemeralToolImage(args)).resolves.toMatchObject({ text: 'New account' })
    expect(h.runClaudeEphemeralWithFailover).toHaveBeenCalledTimes(3)
  } finally {
    snapshot.mockRestore()
  }
})

it('changes the in-flight key when only a Claude fallback identity changes', async () => {
  const { CLAUDE_SUBSCRIPTION_PROVIDER_ID, addSubscriptionAccount } = await import('../../src/main/chat/catalog')
  const { setFailoverRoute } = await import('../../src/main/chat/subscription-failover/config')
  const { getClaudeSubscriptionManager } = await import('../../src/main/chat/claude-agent-sdk/manager')
  const account = addSubscriptionAccount('claude-subscription', 'B')
  setFailoverRoute({
    primaryProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    enabled: true,
    fallbackProviderIds: [`${CLAUDE_SUBSCRIPTION_PROVIDER_ID}@${account.id}`],
  })
  const primary = vi
    .spyOn(getClaudeSubscriptionManager(), 'getStatusSnapshot')
    .mockReturnValue({ accountFingerprint: 'A', accountEpoch: 1 } as any)
  const fallback = vi
    .spyOn(getClaudeSubscriptionManager(account.id), 'getStatusSnapshot')
    .mockReturnValue({ accountFingerprint: 'B-old', accountEpoch: 1 } as any)
  setImageInterpreter({ providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, modelId: 'vision-model' })
  let release!: (value: { text: string }) => void
  h.runClaudeEphemeralWithFailover
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    .mockResolvedValue({ text: 'New fallback identity' })
  const image = toolOutputImages(
    modelOutputToChatToolOutput({
      type: 'content',
      value: [{ type: 'file', data: { type: 'data', data: 'FFFF' }, mediaType: 'image/png' }],
    })
  )[0]!
  const args = { image, conversationId: 'c', cwd: '/tmp/w', signal: new AbortController().signal }
  try {
    const old = describeEphemeralToolImage(args)
    await vi.waitFor(() => expect(h.runClaudeEphemeralWithFailover).toHaveBeenCalledTimes(1))
    fallback.mockReturnValue({ accountFingerprint: 'B-new', accountEpoch: 2 } as any)
    await expect(describeEphemeralToolImage(args)).resolves.toMatchObject({ text: 'New fallback identity' })
    release({ text: 'Old fallback identity' })
    await old
    expect(h.runClaudeEphemeralWithFailover).toHaveBeenCalledTimes(2)
  } finally {
    primary.mockRestore()
    fallback.mockRestore()
  }
})
