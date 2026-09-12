import type { ModelMessage } from 'ai'
import type { ToolOutput } from '../../../shared/chat'
import type {
  OpenAILedgerEntry,
  OpenAILedgerObject,
  OpenAILedgerReplayIssue,
  OpenAILedgerReplayResult,
  OpenAILedgerValue,
  OpenAIResponsesLedger,
  OpenAIStreamEventLike,
  OpenAIToolResultOutput,
} from './types'
import { isOpenAINativeToolName, openAINativeFailureOutput } from './native-tools'
import {
  chatToolOutputToAiSdkOutput,
  hasEphemeralToolImage,
  mergeToolOutputImageDescriptions,
  modelOutputToChatToolOutput,
  sanitizeStructuredContentForPersistence,
  sanitizeToolOutputForPersistence,
  sanitizeToolTextForPersistence,
} from '../tool-output'
import { toolOutputImages } from '../../../shared/chat'

export const OPENAI_RESPONSES_LEDGER_VERSION = 1 as const

export function createOpenAIResponsesLedger(): OpenAIResponsesLedger {
  return { version: OPENAI_RESPONSES_LEDGER_VERSION, provider: 'openai-responses', store: false, entries: [] }
}

/** Copy and validate a value before adding it to the persistable ledger. */
export function toOpenAILedgerValue(value: unknown, path = '$'): OpenAILedgerValue {
  const seen = new Set<object>()

  const visit = (current: unknown, currentPath: string): OpenAILedgerValue => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError(`${currentPath} must be a finite JSON number`)
      return current
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) throw new TypeError(`${currentPath} contains a circular reference`)
      seen.add(current)
      const result = current.map((item, index) => visit(item === undefined ? null : item, `${currentPath}[${index}]`))
      seen.delete(current)
      return result
    }
    if (typeof current === 'object') {
      if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
        throw new TypeError(`${currentPath} must contain only plain JSON objects`)
      }
      if (seen.has(current)) throw new TypeError(`${currentPath} contains a circular reference`)
      seen.add(current)
      const result: OpenAILedgerObject = {}
      for (const [key, item] of Object.entries(current)) {
        // JSON.stringify omits undefined object properties. Do so explicitly and reject other
        // non-JSON values to avoid falsely promising lossless replay.
        if (item !== undefined) result[key] = visit(item, `${currentPath}.${key}`)
      }
      seen.delete(current)
      return result
    }
    throw new TypeError(`${currentPath} is not JSON-serializable`)
  }

  return visit(value, path)
}

function metadata(value: unknown): OpenAILedgerObject | undefined {
  if (value == null) return undefined
  const result = toOpenAILedgerValue(value, '$.providerMetadata')
  if (Array.isArray(result) || result === null || typeof result !== 'object') {
    throw new TypeError('$.providerMetadata must be a JSON object')
  }
  return result
}

function mergeObjects(left?: OpenAILedgerObject, right?: OpenAILedgerObject): OpenAILedgerObject | undefined {
  if (!left) return right
  if (!right) return left
  const result: OpenAILedgerObject = { ...left }
  for (const [key, value] of Object.entries(right)) {
    const previous = result[key]
    if (
      previous !== null &&
      value !== null &&
      typeof previous === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(previous) &&
      !Array.isArray(value)
    ) {
      result[key] = mergeObjects(previous, value)!
    } else {
      result[key] = value
    }
  }
  return result
}

function updateStreamEntry(
  ledger: OpenAIResponsesLedger,
  type: 'assistant-text' | 'assistant-reasoning',
  streamId: string,
  update: (
    entry: Extract<OpenAILedgerEntry, { type: typeof type }>
  ) => Extract<OpenAILedgerEntry, { type: typeof type }>
): OpenAIResponsesLedger {
  let index = -1
  for (let candidate = ledger.entries.length - 1; candidate >= 0; candidate--) {
    const entry = ledger.entries[candidate]
    if (entry.type === type && entry.streamId === streamId) {
      index = candidate
      break
    }
  }
  if (index < 0) {
    const empty = { type, streamId, text: '', status: 'streaming' as const } as Extract<
      OpenAILedgerEntry,
      { type: typeof type }
    >
    return { ...ledger, entries: [...ledger.entries, update(empty)] }
  }
  const entries = ledger.entries.slice()
  entries[index] = update(entries[index] as Extract<OpenAILedgerEntry, { type: typeof type }>)
  return { ...ledger, entries }
}

function append(ledger: OpenAIResponsesLedger, entry: OpenAILedgerEntry): OpenAIResponsesLedger {
  return { ...ledger, entries: [...ledger.entries, entry] }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function resultOutput(output: unknown): OpenAIToolResultOutput {
  return typeof output === 'string'
    ? { type: 'text', value: sanitizeToolTextForPersistence(output) }
    : {
        type: 'json',
        value: toOpenAILedgerValue(
          sanitizeStructuredContentForPersistence(output === undefined ? null : output) ?? null,
          '$.toolResult'
        ),
      }
}

/** Safe terminal result for a client-side function call whose result was lost with the process/stream. */
export function interruptedOpenAIToolResultOutput(toolCallId: string): OpenAIToolResultOutput {
  return {
    type: 'error-text',
    value:
      `The previous run stopped before tool call ${toolCallId} produced a recoverable result. ` +
      'Treat it as failed; inspect state before retrying a mutating operation.',
  }
}

/**
 * `response.messages` already contains ToolResultOutput, not the raw `execute` return value. Results containing
 * bytes pass through the host-owned contract and enter the ledger only as ephemeral refs; content without bytes
 * retains JSON compatibility with older v1 ledgers.
 */
function outputProviderOptions(output: Record<string, unknown>): OpenAILedgerObject | undefined {
  if (!Object.hasOwn(output, 'providerOptions')) return undefined
  return metadata(output.providerOptions)
}

function hostToolResultOutput(
  output: ReturnType<typeof modelOutputToChatToolOutput>,
  path: string,
  providerOptions?: OpenAILedgerObject
): OpenAIToolResultOutput {
  if (typeof output === 'string')
    return {
      type: 'text',
      value: sanitizeToolTextForPersistence(output),
      ...(providerOptions ? { providerOptions } : {}),
    }
  const safe = sanitizeToolOutputForPersistence(output)
  return {
    type: 'maestrly-output',
    value: toOpenAILedgerValue(safe, `${path}.maestrly`),
    ...(providerOptions ? { providerOptions } : {}),
  }
}

function isModelToolOutput(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.type === 'text' ||
    candidate.type === 'json' ||
    candidate.type === 'execution-denied' ||
    candidate.type === 'error-text' ||
    candidate.type === 'error-json' ||
    candidate.type === 'content' ||
    Object.hasOwn(candidate, '__maestrlyToolOutput') ||
    (typeof candidate.text === 'string' &&
      (Array.isArray(candidate.images) || candidate.structuredContent !== undefined || candidate.isError !== undefined))
  )
}

/** Converts an AI SDK or host tool output to the ledger's JSON-safe representation. */
export function toOpenAIToolResultOutput(output: unknown, path = '$.toolResult'): OpenAIToolResultOutput {
  if (!isModelToolOutput(output)) return resultOutput(output)
  const candidate = output as Record<string, unknown>
  const providerOptions = outputProviderOptions(candidate)

  if (candidate.type === 'text' || candidate.type === 'error-text') {
    const value = typeof candidate.value === 'string' ? sanitizeToolTextForPersistence(candidate.value) : '(no output)'
    return { type: candidate.type, value, ...(providerOptions ? { providerOptions } : {}) }
  }
  if (candidate.type === 'execution-denied') {
    return {
      type: 'execution-denied',
      ...(typeof candidate.reason === 'string' ? { reason: sanitizeToolTextForPersistence(candidate.reason) } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    }
  }
  if (candidate.type === 'json' || candidate.type === 'error-json') {
    return {
      type: candidate.type,
      value: toOpenAILedgerValue(sanitizeStructuredContentForPersistence(candidate.value) ?? null, `${path}.value`),
      ...(providerOptions ? { providerOptions } : {}),
    }
  }
  if (candidate.type === 'content') {
    const normalized = modelOutputToChatToolOutput(output)
    if (typeof normalized !== 'string' && toolOutputImages(normalized).length > 0) {
      return hostToolResultOutput(normalized, path, providerOptions)
    }
    // Content made entirely of text/provider references is already JSON-safe. Keep it as JSON so old
    // reference/file-id outputs remain replay-compatible without pretending they are inline images.
    return {
      type: 'json',
      value: toOpenAILedgerValue(sanitizeStructuredContentForPersistence(candidate.value) ?? [], `${path}.value`),
      ...(providerOptions ? { providerOptions } : {}),
    }
  }

  const normalized = modelOutputToChatToolOutput(output)
  if (typeof normalized !== 'string') return hostToolResultOutput(normalized, path, providerOptions)
  return {
    type: 'text',
    value: sanitizeToolTextForPersistence(normalized),
    ...(providerOptions ? { providerOptions } : {}),
  }
}

/** Projects a persisted host-owned output back to the AI SDK shape at the model boundary. */
function replayToolResultOutput(output: OpenAIToolResultOutput, opts: { dropImages?: boolean } = {}): unknown {
  if (output.type !== 'maestrly-output') return output
  const normalized = modelOutputToChatToolOutput(output.value)
  const projected =
    typeof normalized === 'string'
      ? { type: 'text' as const, value: normalized || '(no output)' }
      : chatToolOutputToAiSdkOutput(normalized, { dropImages: opts.dropImages })
  return output.providerOptions ? { ...projected, providerOptions: output.providerOptions } : projected
}

function unavailableEphemeralImageCount(output: OpenAIToolResultOutput): number {
  if (output.type !== 'maestrly-output') return 0
  const normalized = modelOutputToChatToolOutput(output.value)
  if (typeof normalized === 'string') return 0
  return toolOutputImages(normalized).filter((image) => !hasEphemeralToolImage(image)).length
}

/**
 * Pure fold of `fullStream` semantic events. Merge start/delta/end metadata because the OpenAI adapter delivers
 * `reasoningEncryptedContent`, annotations, and some final fields only in the closing event.
 */
export function reduceOpenAIResponsesStreamEvent(
  ledger: OpenAIResponsesLedger,
  event: OpenAIStreamEventLike
): OpenAIResponsesLedger {
  switch (event.type) {
    case 'text-start':
      return append(ledger, {
        type: 'assistant-text',
        streamId: event.id,
        text: '',
        status: 'streaming',
        ...(metadata(event.providerMetadata) ? { providerMetadata: metadata(event.providerMetadata) } : {}),
      })
    case 'text-delta':
      return updateStreamEntry(ledger, 'assistant-text', event.id, (entry) => ({
        ...entry,
        text: entry.text + event.text,
        providerMetadata: mergeObjects(entry.providerMetadata, metadata(event.providerMetadata)),
      }))
    case 'text-end':
      return updateStreamEntry(ledger, 'assistant-text', event.id, (entry) => ({
        ...entry,
        status: 'complete',
        providerMetadata: mergeObjects(entry.providerMetadata, metadata(event.providerMetadata)),
      }))
    case 'reasoning-start':
      return append(ledger, {
        type: 'assistant-reasoning',
        streamId: event.id,
        text: '',
        status: 'streaming',
        ...(metadata(event.providerMetadata) ? { providerMetadata: metadata(event.providerMetadata) } : {}),
      })
    case 'reasoning-delta':
      return updateStreamEntry(ledger, 'assistant-reasoning', event.id, (entry) => ({
        ...entry,
        text: entry.text + event.text,
        providerMetadata: mergeObjects(entry.providerMetadata, metadata(event.providerMetadata)),
      }))
    case 'reasoning-end':
      return updateStreamEntry(ledger, 'assistant-reasoning', event.id, (entry) => ({
        ...entry,
        status: 'complete',
        providerMetadata: mergeObjects(entry.providerMetadata, metadata(event.providerMetadata)),
      }))
    case 'tool-call':
      return append(ledger, {
        type: 'tool-call',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: toOpenAILedgerValue(event.input === undefined ? {} : event.input, '$.toolCall.input'),
        ...(event.providerExecuted ? { providerExecuted: true } : {}),
        ...(metadata(event.providerMetadata) ? { providerMetadata: metadata(event.providerMetadata) } : {}),
      })
    case 'tool-result':
      return append(ledger, {
        type: 'tool-result',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: toOpenAIToolResultOutput(event.output),
        ...(event.providerExecuted ? { providerExecuted: true } : {}),
        ...(metadata(event.providerMetadata) ? { providerMetadata: metadata(event.providerMetadata) } : {}),
      })
    case 'tool-error': {
      const nativeOutput = isOpenAINativeToolName(event.toolName)
        ? openAINativeFailureOutput(event.toolName, event.error)
        : null
      return append(ledger, {
        type: 'tool-result',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output:
          nativeOutput == null ? { type: 'error-text', value: errorText(event.error) } : resultOutput(nativeOutput),
        ...(event.providerExecuted ? { providerExecuted: true } : {}),
        ...(metadata(event.providerMetadata) ? { providerMetadata: metadata(event.providerMetadata) } : {}),
      })
    }
    case 'finish-step': {
      const finishReason = typeof event.finishReason === 'string' ? event.finishReason : undefined
      const responseId = typeof event.response?.id === 'string' ? event.response.id : undefined
      return append(ledger, {
        type: 'step-boundary',
        ...(finishReason ? { finishReason } : {}),
        ...(responseId ? { responseId } : {}),
        ...(metadata(event.providerMetadata) ? { providerMetadata: metadata(event.providerMetadata) } : {}),
      })
    }
    case 'custom': {
      if (event.kind !== 'openai.compaction') {
        return appendOpenAIOpaqueResponseItem(ledger, event.kind, event, event.providerMetadata)
      }
      const providerMetadata = metadata(event.providerMetadata)
      const openai = providerMetadata?.openai
      const fields = openai !== null && typeof openai === 'object' && !Array.isArray(openai) ? openai : undefined
      const compaction: OpenAILedgerEntry = {
        type: 'compaction',
        itemId: typeof fields?.itemId === 'string' ? fields.itemId : '',
        encryptedContent: typeof fields?.encryptedContent === 'string' ? fields.encryptedContent : '',
        ...(providerMetadata ? { providerMetadata } : {}),
      }
      // A valid checkpoint already encapsulates the entire prefix. Pruning at capture limits disk, replay bytes, and
      // local exposure; retain invalid items without pruning so the fallback can still use the previous state.
      return compaction.itemId && compaction.encryptedContent
        ? { ...ledger, entries: [compaction] }
        : append(ledger, compaction)
    }
    default:
      // start/finish/abort/source and other UI events are not inputs to the next sample. Provider items that
      // ModelMessage cannot represent must be added explicitly via appendOpenAIOpaqueResponseItem.
      return ledger
  }
}

export function captureOpenAIResponsesStream(events: Iterable<OpenAIStreamEventLike>): OpenAIResponsesLedger {
  let ledger = createOpenAIResponsesLedger()
  for (const event of events) ledger = reduceOpenAIResponsesStreamEvent(ledger, event)
  return ledger
}

export function appendOpenAIOpaqueResponseItem(
  ledger: OpenAIResponsesLedger,
  itemType: string,
  item: unknown,
  providerMetadata?: unknown
): OpenAIResponsesLedger {
  return append(ledger, {
    type: 'opaque-response-item',
    itemType,
    item: toOpenAILedgerValue(item, '$.opaqueResponseItem'),
    ...(metadata(providerMetadata) ? { providerMetadata: metadata(providerMetadata) } : {}),
  })
}

/**
 * Capture messages already materialized by the AI SDK (`result.response.messages`). Preferred when the caller has
 * these messages because it respects `tool.toModelOutput`; the fullStream fold uses the default mapping.
 */
export function appendOpenAIResponsesModelMessages(
  ledger: OpenAIResponsesLedger,
  messages: readonly ModelMessage[]
): OpenAIResponsesLedger {
  let next = ledger
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      next = append(next, {
        type: 'input-message',
        role: message.role,
        content: toOpenAILedgerValue(message.content, '$.message.content'),
        ...(metadata(message.providerOptions) ? { providerMetadata: metadata(message.providerOptions) } : {}),
      })
      next = append(next, { type: 'step-boundary' })
      continue
    }

    if (message.role === 'assistant') {
      const content =
        typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
      for (let index = 0; index < content.length; index++) {
        const part = content[index]
        if (part.type === 'text' || part.type === 'reasoning') {
          next = append(next, {
            type: part.type === 'text' ? 'assistant-text' : 'assistant-reasoning',
            streamId: `${part.type}:${next.entries.length}:${index}`,
            text: part.text,
            status: 'complete',
            ...(metadata(part.providerOptions) ? { providerMetadata: metadata(part.providerOptions) } : {}),
          })
        } else if (part.type === 'tool-call') {
          next = append(next, {
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: toOpenAILedgerValue(part.input === undefined ? {} : part.input, '$.toolCall.input'),
            ...(part.providerExecuted ? { providerExecuted: true } : {}),
            ...(metadata(part.providerOptions) ? { providerMetadata: metadata(part.providerOptions) } : {}),
          })
        } else if (part.type === 'tool-result') {
          next = append(next, {
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: toOpenAIToolResultOutput(part.output, '$.toolResult.output'),
            providerExecuted: true,
            ...(metadata(part.providerOptions) ? { providerMetadata: metadata(part.providerOptions) } : {}),
          })
        } else if (part.type === 'custom' && part.kind === 'openai.compaction') {
          const openai = part.providerOptions?.openai
          next = append(next, {
            type: 'compaction',
            itemId: typeof openai?.itemId === 'string' ? openai.itemId : '',
            encryptedContent: typeof openai?.encryptedContent === 'string' ? openai.encryptedContent : '',
            ...(metadata(part.providerOptions) ? { providerMetadata: metadata(part.providerOptions) } : {}),
          })
        } else {
          next = appendOpenAIOpaqueResponseItem(
            next,
            part.type,
            part,
            'providerOptions' in part ? part.providerOptions : undefined
          )
        }
      }
      next = append(next, {
        type: 'step-boundary',
        ...(metadata(message.providerOptions) ? { providerMetadata: metadata(message.providerOptions) } : {}),
      })
      continue
    }

    for (const part of message.content) {
      if (part.type === 'tool-result') {
        next = append(next, {
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: toOpenAIToolResultOutput(part.output, '$.toolResult.output'),
          ...(metadata(part.providerOptions) ? { providerMetadata: metadata(part.providerOptions) } : {}),
        })
      } else {
        next = appendOpenAIOpaqueResponseItem(next, part.type, part)
      }
    }
    next = append(next, {
      type: 'step-boundary',
      ...(metadata(message.providerOptions) ? { providerMetadata: metadata(message.providerOptions) } : {}),
    })
  }
  return next
}

/** JSON-safe snapshot of `response.messages`; replace the previous snapshot when the SDK returns a cumulative list. */
export function captureOpenAIResponsesModelMessages(messages: readonly ModelMessage[]): OpenAIResponsesLedger {
  return appendOpenAIResponsesModelMessages(createOpenAIResponsesLedger(), messages)
}

function openAIMetadata(entry: OpenAILedgerEntry): OpenAILedgerObject | undefined {
  const value = entry.providerMetadata?.openai
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function providerOptions(entry: OpenAILedgerEntry) {
  return entry.providerMetadata as ModelMessage['providerOptions']
}

function providerOptionsField(entry: OpenAILedgerEntry) {
  return entry.providerMetadata ? { providerOptions: providerOptions(entry) } : {}
}

/** Convert only items representable by AI SDK 7 ModelMessage and make any loss explicit. */
export function replayOpenAIResponsesLedger(
  ledger: OpenAIResponsesLedger,
  opts: { dropImages?: boolean } = {}
): OpenAILedgerReplayResult {
  const messages: ModelMessage[] = []
  const issues: OpenAILedgerReplayIssue[] = []
  let assistant: Array<Record<string, unknown>> = []
  let tools: Array<Record<string, unknown>> = []
  let interruptedTools: Array<Record<string, unknown>> = []
  const completedClientCallIds = new Set(
    ledger.entries.filter((entry) => entry.type === 'tool-result').map((entry) => entry.toolCallId)
  )

  const flush = () => {
    if (assistant.length > 0) messages.push({ role: 'assistant', content: assistant } as ModelMessage)
    const toolContent = [...tools, ...interruptedTools]
    if (toolContent.length > 0) messages.push({ role: 'tool', content: toolContent } as ModelMessage)
    assistant = []
    tools = []
    interruptedTools = []
  }

  for (let index = 0; index < ledger.entries.length; index++) {
    const entry = ledger.entries[index]
    switch (entry.type) {
      case 'input-message':
        flush()
        messages.push({ role: entry.role, content: entry.content, ...providerOptionsField(entry) } as ModelMessage)
        break
      case 'assistant-text':
        if (tools.length > 0) flush()
        assistant.push({ type: 'text', text: entry.text, ...providerOptionsField(entry) })
        if (entry.status !== 'complete') {
          issues.push({
            entryIndex: index,
            code: 'incomplete-stream-item',
            message: `Text item ${entry.streamId} did not receive text-end`,
          })
        }
        break
      case 'assistant-reasoning': {
        if (tools.length > 0) flush()
        const incomplete = entry.status !== 'complete'
        const encrypted = openAIMetadata(entry)?.reasoningEncryptedContent
        if (typeof encrypted !== 'string' || encrypted.length === 0) {
          issues.push({
            entryIndex: index,
            code: 'reasoning-missing-encrypted-content',
            message: `Reasoning item ${entry.streamId} cannot be replayed losslessly with store:false`,
          })
          if (incomplete) {
            issues.push({
              entryIndex: index,
              code: 'incomplete-stream-item',
              message: `Reasoning item ${entry.streamId} did not receive reasoning-end`,
            })
          }
          break
        }
        assistant.push({ type: 'reasoning', text: entry.text, ...providerOptionsField(entry) })
        if (incomplete) {
          issues.push({
            entryIndex: index,
            code: 'incomplete-stream-item',
            message: `Reasoning item ${entry.streamId} did not receive reasoning-end`,
          })
        }
        break
      }
      case 'tool-call':
        if (tools.length > 0) flush()
        assistant.push({
          type: 'tool-call',
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          input: entry.input,
          ...(entry.providerExecuted ? { providerExecuted: true } : {}),
          ...providerOptionsField(entry),
        })
        if (!entry.providerExecuted && !completedClientCallIds.has(entry.toolCallId)) {
          interruptedTools.push({
            type: 'tool-result',
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
            output: interruptedOpenAIToolResultOutput(entry.toolCallId),
          })
          issues.push({
            entryIndex: index,
            code: 'orphaned-tool-call',
            message: `Tool call ${entry.toolCallId} has no result; replay inserted a terminal failure output`,
          })
        }
        break
      case 'tool-result': {
        const target = entry.providerExecuted ? assistant : tools
        if (!entry.providerExecuted && assistant.length > 0) {
          messages.push({ role: 'assistant', content: assistant } as ModelMessage)
          assistant = []
        }
        const unavailableImages = opts.dropImages ? 0 : unavailableEphemeralImageCount(entry.output)
        if (unavailableImages > 0) {
          issues.push({
            entryIndex: index,
            code: 'ephemeral-image-unavailable',
            requiresFallback: true,
            message:
              `Tool result ${entry.toolCallId} contains ${unavailableImages} ephemeral image ` +
              `${unavailableImages === 1 ? 'handle' : 'handles'} that cannot be resolved; replay is lossy`,
          })
        }
        target.push({
          type: 'tool-result',
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          output: replayToolResultOutput(entry.output, opts),
          ...providerOptionsField(entry),
        })
        break
      }
      case 'step-boundary':
        flush()
        break
      case 'compaction':
        if (!entry.itemId || !entry.encryptedContent) {
          issues.push({
            entryIndex: index,
            code: 'compaction-missing-encrypted-content',
            message: 'Compaction item cannot be replayed losslessly without itemId and encryptedContent',
          })
          break
        }
        if (tools.length > 0) flush()
        assistant.push({
          type: 'custom',
          kind: 'openai.compaction',
          providerOptions: {
            openai: {
              type: 'compaction',
              itemId: entry.itemId,
              encryptedContent: entry.encryptedContent,
            },
          },
        })
        break
      case 'opaque-response-item':
        issues.push({
          entryIndex: index,
          code: 'opaque-item-requires-raw-responses-input',
          message: `Response item ${entry.itemType} cannot be expressed through AI SDK 7 ModelMessage`,
        })
        break
    }
  }
  flush()

  const requiresRawResponsesInput = issues.some((issue) => issue.code === 'opaque-item-requires-raw-responses-input')
  return { messages, issues, lossless: issues.length === 0, requiresRawResponsesInput }
}

/**
 * Canonical output patch after tool-image enrichment. Merge descriptions MONOTONICALLY by image id (see
 * `mergeToolOutputImageDescriptions`) into the CURRENT output of each `tool-result` with a `maestrly-output`
 * projection and matching toolCallId. Preserve newer entry text/structuredContent/isError; copy only missing
 * descriptions for matching image ids. Reasoning, compaction, inputs, and other entries remain intact (same
 * reference if unchanged). Responses harness replay prefers the ledger over the visual transcript
 * (`buildOpenAIModelMessages`); without this patch, the new description appears in `parts_json` but the next
 * sample still emits the omission note from the old output.
 */
export function patchOpenAILedgerToolOutputs(
  ledger: OpenAIResponsesLedger,
  enriched: ReadonlyArray<{ toolCallId: string; output: ToolOutput }>
): OpenAIResponsesLedger {
  if (enriched.length === 0) return ledger
  const byCallId = new Map(enriched.map(({ toolCallId, output }) => [toolCallId, output]))
  let changed = false
  const entries = ledger.entries.map((entry) => {
    if (entry.type !== 'tool-result' || entry.output.type !== 'maestrly-output') return entry
    const output = byCallId.get(entry.toolCallId)
    if (output === undefined) return entry
    // Merge descriptions: the entry's CURRENT output is authoritative; unmatched ids (entry rewritten with
    // another version) are a no-op. No actual change means the same reference and no checkpoint update.
    const current = modelOutputToChatToolOutput(entry.output.value)
    const merged = mergeToolOutputImageDescriptions(current, output)
    if (merged === current) return entry
    const patched = toOpenAIToolResultOutput(merged, '$.toolResult.maestrly')
    // Enrichment only updates outputs with images, projected by the ledger as maestrly-output; any other
    // shape here indicates a broken contract, so do not force the change.
    if (patched.type !== 'maestrly-output') return entry
    const final: OpenAIToolResultOutput = entry.output.providerOptions
      ? { ...patched, providerOptions: entry.output.providerOptions }
      : patched
    // Same JSON means descriptions already exist (or enrichment is identical); leave the checkpoint unchanged.
    if (JSON.stringify(final) === JSON.stringify(entry.output)) return entry
    changed = true
    return { ...entry, output: final }
  })
  return changed ? { ...ledger, entries } : ledger
}

/** Last valid checkpoint; stateless callers may discard everything before it. */
export function latestOpenAICompactionIndex(ledger: OpenAIResponsesLedger): number {
  for (let index = ledger.entries.length - 1; index >= 0; index--) {
    const entry = ledger.entries[index]
    if (entry.type === 'compaction' && entry.itemId && entry.encryptedContent) return index
  }
  return -1
}

function invalidLedger(path: string, detail: string): never {
  throw new TypeError(`Invalid OpenAI Responses ledger: ${path} ${detail}`)
}

function ledgerObject(value: OpenAILedgerValue, path: string): OpenAILedgerObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    invalidLedger(path, 'must be a JSON object')
  }
  return value
}

function assertExactKeys(value: OpenAILedgerObject, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) invalidLedger(`${path}.${key}`, 'is not supported by ledger version 1')
  }
}

function requiredField(value: OpenAILedgerObject, key: string, path: string): OpenAILedgerValue {
  if (!Object.hasOwn(value, key)) invalidLedger(`${path}.${key}`, 'is required')
  return value[key]
}

function requiredString(value: OpenAILedgerObject, key: string, path: string): string {
  const field = requiredField(value, key, path)
  if (typeof field !== 'string') invalidLedger(`${path}.${key}`, 'must be a string')
  return field
}

function optionalString(value: OpenAILedgerObject, key: string, path: string): void {
  if (Object.hasOwn(value, key) && typeof value[key] !== 'string') {
    invalidLedger(`${path}.${key}`, 'must be a string when present')
  }
}

function optionalBoolean(value: OpenAILedgerObject, key: string, path: string): void {
  if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') {
    invalidLedger(`${path}.${key}`, 'must be a boolean when present')
  }
}

function optionalFiniteNumber(value: OpenAILedgerObject, key: string, path: string): void {
  if (Object.hasOwn(value, key) && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
    invalidLedger(`${path}.${key}`, 'must be a finite number when present')
  }
}

/** AI SDK provider options are a map of provider name -> JSON object, not arbitrary JSON. */
function optionalProviderMetadata(value: OpenAILedgerObject, key: string, path: string): void {
  if (!Object.hasOwn(value, key)) return
  const metadataObject = ledgerObject(value[key], `${path}.${key}`)
  for (const [provider, providerValue] of Object.entries(metadataObject)) {
    ledgerObject(providerValue, `${path}.${key}.${provider}`)
  }
}

function validateToolResultOutput(value: OpenAILedgerValue, path: string): void {
  const output = ledgerObject(value, path)
  const type = requiredString(output, 'type', path)
  optionalProviderMetadata(output, 'providerOptions', path)

  switch (type) {
    case 'text':
    case 'error-text':
      assertExactKeys(output, ['type', 'value', 'providerOptions'], path)
      requiredString(output, 'value', path)
      return
    case 'json':
    case 'error-json':
      assertExactKeys(output, ['type', 'value', 'providerOptions'], path)
      requiredField(output, 'value', path)
      return
    case 'execution-denied':
      assertExactKeys(output, ['type', 'reason', 'providerOptions'], path)
      optionalString(output, 'reason', path)
      return
    case 'maestrly-output': {
      assertExactKeys(output, ['type', 'value', 'providerOptions'], path)
      const host = ledgerObject(requiredField(output, 'value', path), `${path}.value`)
      assertExactKeys(host, ['text', 'images', 'structuredContent', 'isError'], `${path}.value`)
      requiredString(host, 'text', `${path}.value`)
      optionalBoolean(host, 'isError', `${path}.value`)
      if (Object.hasOwn(host, 'images')) {
        const images = host.images
        if (!Array.isArray(images)) invalidLedger(`${path}.value.images`, 'must be an array when present')
        for (let index = 0; index < images.length; index++) {
          const image = ledgerObject(images[index], `${path}.value.images[${index}]`)
          assertExactKeys(
            image,
            ['id', 'mediaType', 'name', 'byteSize', 'description', 'descriptionModel'],
            `${path}.value.images[${index}]`
          )
          requiredString(image, 'id', `${path}.value.images[${index}]`)
          requiredString(image, 'mediaType', `${path}.value.images[${index}]`)
          optionalString(image, 'name', `${path}.value.images[${index}]`)
          optionalFiniteNumber(image, 'byteSize', `${path}.value.images[${index}]`)
          optionalString(image, 'description', `${path}.value.images[${index}]`)
          optionalString(image, 'descriptionModel', `${path}.value.images[${index}]`)
        }
      }
      return
    }
    default:
      invalidLedger(`${path}.type`, `has unknown tool output type ${JSON.stringify(type)}`)
  }
}

function validateLedgerEntry(value: OpenAILedgerValue, index: number): OpenAILedgerEntry {
  const path = `$.ledger.entries[${index}]`
  const entry = ledgerObject(value, path)
  const type = requiredString(entry, 'type', path)
  optionalProviderMetadata(entry, 'providerMetadata', path)

  switch (type) {
    case 'input-message': {
      assertExactKeys(entry, ['type', 'role', 'content', 'providerMetadata'], path)
      const role = requiredString(entry, 'role', path)
      if (role !== 'system' && role !== 'user') {
        invalidLedger(`${path}.role`, 'must be system or user')
      }
      requiredField(entry, 'content', path)
      break
    }
    case 'assistant-text':
    case 'assistant-reasoning': {
      assertExactKeys(entry, ['type', 'streamId', 'text', 'status', 'providerMetadata'], path)
      requiredString(entry, 'streamId', path)
      requiredString(entry, 'text', path)
      const status = requiredString(entry, 'status', path)
      if (status !== 'streaming' && status !== 'complete') {
        invalidLedger(`${path}.status`, 'must be streaming or complete')
      }
      break
    }
    case 'tool-call':
      assertExactKeys(entry, ['type', 'toolCallId', 'toolName', 'input', 'providerExecuted', 'providerMetadata'], path)
      requiredString(entry, 'toolCallId', path)
      requiredString(entry, 'toolName', path)
      requiredField(entry, 'input', path)
      optionalBoolean(entry, 'providerExecuted', path)
      break
    case 'tool-result':
      assertExactKeys(entry, ['type', 'toolCallId', 'toolName', 'output', 'providerExecuted', 'providerMetadata'], path)
      requiredString(entry, 'toolCallId', path)
      requiredString(entry, 'toolName', path)
      validateToolResultOutput(requiredField(entry, 'output', path), `${path}.output`)
      optionalBoolean(entry, 'providerExecuted', path)
      break
    case 'step-boundary':
      assertExactKeys(entry, ['type', 'finishReason', 'responseId', 'providerMetadata'], path)
      optionalString(entry, 'finishReason', path)
      optionalString(entry, 'responseId', path)
      break
    case 'compaction':
      assertExactKeys(entry, ['type', 'itemId', 'encryptedContent', 'providerMetadata'], path)
      requiredString(entry, 'itemId', path)
      requiredString(entry, 'encryptedContent', path)
      break
    case 'opaque-response-item':
      assertExactKeys(entry, ['type', 'itemType', 'item', 'providerMetadata'], path)
      requiredString(entry, 'itemType', path)
      requiredField(entry, 'item', path)
      break
    default:
      invalidLedger(`${path}.type`, `has unknown entry type ${JSON.stringify(type)}`)
  }

  return entry as unknown as OpenAILedgerEntry
}

export function parseOpenAIResponsesLedger(value: unknown): OpenAIResponsesLedger {
  const copy = toOpenAILedgerValue(value, '$.ledger')
  if (
    copy === null ||
    Array.isArray(copy) ||
    typeof copy !== 'object' ||
    copy.version !== OPENAI_RESPONSES_LEDGER_VERSION ||
    copy.provider !== 'openai-responses' ||
    copy.store !== false ||
    !Array.isArray(copy.entries)
  ) {
    throw new TypeError('Invalid OpenAI Responses ledger')
  }
  assertExactKeys(copy, ['version', 'provider', 'store', 'entries'], '$.ledger')
  const entries = copy.entries.map(validateLedgerEntry)
  return { version: OPENAI_RESPONSES_LEDGER_VERSION, provider: 'openai-responses', store: false, entries }
}
