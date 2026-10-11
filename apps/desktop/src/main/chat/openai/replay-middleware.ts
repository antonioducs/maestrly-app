/**
 * Stateless replay of native OpenAI Responses assistant messages.
 *
 * With `store: false`, AI SDK 7 serializes an assistant text part carrying a native `itemId` as an easy input message
 * (`{ role: 'assistant', content: string, phase }`), dropping the item ID and the typed `output_text` content. The
 * middleware records, per model invocation, the assistant text metadata the SDK is about to serialize; the Responses
 * fetch then restores exactly those items. Alignment is positional and content-checked: IDs are never inferred from
 * equal text alone, and any disagreement fails the request instead of guessing.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { LanguageModelV4, LanguageModelV4Prompt } from '@ai-sdk/provider'
import { type LanguageModelMiddleware, wrapLanguageModel } from 'ai'
import type { OpenAILedgerObject, OpenAILedgerValue } from './types'

export class OpenAIReplayMetadataError extends Error {
  constructor(message: string) {
    super(`Cannot replay native OpenAI assistant messages: ${message}`)
    this.name = 'OpenAIReplayMetadataError'
  }
}

/** One assistant text part exactly as the SDK receives it, in prompt order. */
export interface OpenAIAssistantTextReplay {
  text: string
  /** Native message item ID. Absent for unannotated text (another provider, a user-authored message, ...). */
  itemId?: string
  phase?: string
}

interface ReplayInvocation {
  readonly texts: readonly OpenAIAssistantTextReplay[]
  /** The first `/responses` create request of this invocation consumed the capture. */
  claimed: boolean
  /** The model call returned or failed; later requests on the inherited async chain (tools, subagents) are not its. */
  settled: boolean
}

const replayStorage = new AsyncLocalStorage<ReplayInvocation>()

/** Mirrors @ai-sdk/openai: Azure-named providers read part metadata from `azure`, every other name from `openai`. */
export function openAIResponsesProviderOptionsName(provider: string): 'azure' | 'openai' {
  return provider.includes('azure') ? 'azure' : 'openai'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Assistant text parts in the order the SDK converts them, with the metadata stored under its options namespace. */
export function captureOpenAIAssistantTexts(
  prompt: LanguageModelV4Prompt,
  providerOptionsName: string
): OpenAIAssistantTextReplay[] {
  const texts: OpenAIAssistantTextReplay[] = []
  for (const message of prompt) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type !== 'text') continue
      const options = part.providerOptions?.[providerOptionsName]
      const itemId =
        isObject(options) && typeof options.itemId === 'string' && options.itemId.length > 0
          ? options.itemId
          : undefined
      const phase = isObject(options) && typeof options.phase === 'string' ? options.phase : undefined
      texts.push({ text: part.text, ...(itemId ? { itemId } : {}), ...(phase ? { phase } : {}) })
    }
  }
  return texts
}

async function runReplayInvocation<T>(
  model: LanguageModelV4,
  prompt: LanguageModelV4Prompt,
  run: () => PromiseLike<T>
): Promise<T> {
  const invocation: ReplayInvocation = {
    texts: captureOpenAIAssistantTexts(prompt, openAIResponsesProviderOptionsName(model.provider)),
    claimed: false,
    settled: false,
  }
  try {
    // A fresh store per call isolates concurrent chats, subagents, and every step of a tool loop.
    return await replayStorage.run(invocation, run)
  } finally {
    invocation.settled = true
  }
}

export const openAIResponsesReplayMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  wrapGenerate: ({ doGenerate, params, model }) => runReplayInvocation(model, params.prompt, doGenerate),
  wrapStream: ({ doStream, params, model }) => runReplayInvocation(model, params.prompt, doStream),
}

/** Wrap a Responses model whose provider fetch is `openAIResponsesFetch`. */
export function withOpenAIResponsesReplay(model: LanguageModelV4): LanguageModelV4 {
  return wrapLanguageModel({ model, middleware: openAIResponsesReplayMiddleware })
}

/**
 * Capture of the model invocation that owns the current async chain, consumed by its first `/responses` request.
 * Requests made after the call settled, or a second request, receive nothing and are sent unchanged.
 */
export function claimOpenAIResponsesReplay(): readonly OpenAIAssistantTextReplay[] | undefined {
  const invocation = replayStorage.getStore()
  if (!invocation || invocation.settled || invocation.claimed) return undefined
  invocation.claimed = true
  return invocation.texts
}

/** Whether the capture carries native IDs that only a readable request body can restore. */
export function openAIReplayHasNativeIds(texts: readonly OpenAIAssistantTextReplay[] | undefined): boolean {
  return texts?.some((text) => text.itemId !== undefined) ?? false
}

function isAssistantMessage(value: OpenAILedgerValue): value is OpenAILedgerObject {
  return isObject(value) && value.role === 'assistant' && (value.type === undefined || value.type === 'message')
}

function messageText(item: OpenAILedgerObject): string | undefined {
  if (typeof item.content === 'string') return item.content
  if (!Array.isArray(item.content)) return undefined
  let text = ''
  for (const part of item.content) {
    if (!isObject(part) || part.type !== 'output_text' || typeof part.text !== 'string') return undefined
    text += part.text
  }
  return text
}

/**
 * Restore `id`, `phase`, and typed `output_text` on the assistant messages serialized from ID-bearing text parts.
 * Must run on the SDK body before any raw prefix is injected or compaction trims the input.
 */
export function restoreOpenAIAssistantTextReplay(
  body: OpenAILedgerObject,
  texts: readonly OpenAIAssistantTextReplay[] | undefined
): OpenAILedgerObject {
  if (!texts || !openAIReplayHasNativeIds(texts)) return body
  // With storage or a server conversation, the SDK already sends item references or omits ID-bearing items.
  if (body.store !== false || (body.conversation !== undefined && body.conversation !== null)) return body
  if (!Array.isArray(body.input)) throw new OpenAIReplayMetadataError('/responses body has no input array')

  const input: OpenAILedgerValue[] = []
  const restoredIds = new Set<string>()
  let previousId: string | undefined
  let cursor = 0
  for (const item of body.input) {
    if (!isAssistantMessage(item)) {
      input.push(item)
      previousId = undefined
      continue
    }
    const index = cursor++
    const expected = texts[index]
    if (!expected) {
      throw new OpenAIReplayMetadataError(`request has more assistant messages than the prompt (${texts.length})`)
    }
    const text = messageText(item)
    if (text !== expected.text) {
      throw new OpenAIReplayMetadataError(`assistant message ${index} does not match the prompt text`)
    }
    const itemId = expected.itemId
    if (itemId === undefined) {
      input.push(item)
      previousId = undefined
      continue
    }
    if (typeof item.content !== 'string') {
      // Already typed by the SDK: accept only the exact native item, never a different ID.
      if (item.id !== itemId) throw new OpenAIReplayMetadataError(`assistant message ${index} has a different ID`)
      if (restoredIds.has(itemId)) throw new OpenAIReplayMetadataError(`native item repeated at message ${index}`)
      restoredIds.add(itemId)
      input.push(item)
      previousId = itemId
      continue
    }
    const phase = expected.phase ?? (typeof item.phase === 'string' ? item.phase : undefined)
    const part: OpenAILedgerObject = { type: 'output_text', text }
    if (previousId === itemId) {
      // Several text parts of one native message: rebuild the multipart item instead of duplicating its ID.
      const last = input[input.length - 1] as OpenAILedgerObject
      if (last.phase !== phase || !Array.isArray(last.content)) {
        throw new OpenAIReplayMetadataError(`native item parts disagree at message ${index}`)
      }
      input[input.length - 1] = { ...last, content: [...last.content, part] }
      continue
    }
    if (restoredIds.has(itemId)) throw new OpenAIReplayMetadataError(`native item repeated at message ${index}`)
    restoredIds.add(itemId)
    input.push({
      type: 'message',
      role: 'assistant',
      id: itemId,
      content: [part],
      ...(phase !== undefined ? { phase } : {}),
    })
    previousId = itemId
  }
  if (cursor !== texts.length) {
    throw new OpenAIReplayMetadataError(`request has ${cursor} assistant messages; the prompt has ${texts.length}`)
  }
  return { ...body, input }
}
