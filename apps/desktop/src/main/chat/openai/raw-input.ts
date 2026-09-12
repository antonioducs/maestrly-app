import { AsyncLocalStorage } from 'node:async_hooks'
import { net } from 'electron'
import type { OpenAILedgerObject, OpenAILedgerValue } from './types'

const rawPrefixStorage = new AsyncLocalStorage<readonly OpenAILedgerValue[]>()
type FetchInput = Parameters<typeof globalThis.fetch>[0]

export class OpenAIRawInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenAIRawInputError'
  }
}

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function isResponsesCreate(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').endsWith('/responses')
  } catch {
    return false
  }
}

function isSystemItem(value: OpenAILedgerValue): boolean {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === 'object' &&
    (value.role === 'system' || value.role === 'developer')
  )
}

function isEncryptedCompactionItem(value: OpenAILedgerValue): boolean {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === 'object' &&
    value.type === 'compaction' &&
    typeof value.encrypted_content === 'string' &&
    value.encrypted_content.length > 0
  )
}

/** Insert the canonical window after inline instructions and before the AI SDK suffix. */
export function prependOpenAIRawResponseItems(
  body: OpenAILedgerObject,
  rawPrefix: readonly OpenAILedgerValue[]
): OpenAILedgerObject {
  if (rawPrefix.length === 0) return body
  if (!Array.isArray(body.input)) {
    throw new OpenAIRawInputError('Cannot replay the canonical OpenAI window: /responses body has no input array')
  }
  let insertion = 0
  while (insertion < body.input.length && isSystemItem(body.input[insertion])) insertion++
  return {
    ...body,
    input: [...body.input.slice(0, insertion), ...rawPrefix, ...body.input.slice(insertion)],
  }
}

/**
 * Compaction from an earlier step of the SAME invocation already encapsulates everything before it. Search only
 * the SDK's original input: retained items from an injected standalone window remain raw and complete in the first
 * request; a later automatic checkpoint replaces that window entirely.
 */
export function prepareOpenAIResponsesBody(
  body: OpenAILedgerObject,
  rawPrefix: readonly OpenAILedgerValue[]
): OpenAILedgerObject {
  if (!Array.isArray(body.input)) {
    if (rawPrefix.length > 0) {
      throw new OpenAIRawInputError('Cannot replay the canonical OpenAI window: /responses body has no input array')
    }
    return body
  }

  let lastCompactionIndex = -1
  for (let index = body.input.length - 1; index >= 0; index--) {
    if (!isEncryptedCompactionItem(body.input[index])) continue
    lastCompactionIndex = index
    break
  }
  if (lastCompactionIndex < 0) return prependOpenAIRawResponseItems(body, rawPrefix)

  let instructionsEnd = 0
  while (instructionsEnd < body.input.length && isSystemItem(body.input[instructionsEnd])) instructionsEnd++
  return {
    ...body,
    input: [...body.input.slice(0, instructionsEnd), ...body.input.slice(lastCompactionIndex)],
  }
}

function patchedBody(body: RequestInit['body'], rawPrefix: readonly OpenAILedgerValue[]): string {
  if (typeof body !== 'string') {
    throw new OpenAIRawInputError('Cannot replay the canonical OpenAI window: unsupported request body')
  }
  try {
    const parsed = JSON.parse(body) as OpenAILedgerValue
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new OpenAIRawInputError('Cannot replay the canonical OpenAI window: request body is not an object')
    }
    return JSON.stringify(prepareOpenAIResponsesBody(parsed, rawPrefix))
  } catch (error) {
    if (error instanceof OpenAIRawInputError) throw error
    throw new OpenAIRawInputError('Cannot replay the canonical OpenAI window: request body is not valid JSON')
  }
}

/**
 * Async context per invocation. Conversations and subagents can stream in parallel without sharing the compacted
 * window; provider fetch reads only the prefix associated with the async chain that started that request.
 */
export function withOpenAIRawResponsesPrefix<T>(rawPrefix: readonly OpenAILedgerValue[] | undefined, run: () => T): T {
  // An empty store explicitly masks any prefix inherited from a parent caller.
  return rawPrefixStorage.run(rawPrefix ?? [], run)
}

/** Isolate auxiliary/subagent inferences running within the main stream's async context. */
export function withoutOpenAIRawResponsesPrefix<T>(run: () => T): T {
  return withOpenAIRawResponsesPrefix(undefined, run)
}

/** OpenAI adapter fetch with a minimal seam for ResponseItem[] that ModelMessage cannot represent. */
export const openAIResponsesFetch: typeof globalThis.fetch = async (input, init) => {
  const rawPrefix = rawPrefixStorage.getStore() ?? []
  const netInput = input instanceof URL ? input.toString() : input
  if (!isResponsesCreate(requestUrl(input))) return net.fetch(netInput, init)

  if (init?.body != null) {
    return net.fetch(netInput, { ...init, body: patchedBody(init.body, rawPrefix) })
  }

  if (typeof Request !== 'undefined' && input instanceof Request && input.method !== 'GET' && input.method !== 'HEAD') {
    const original = await input.clone().text()
    return net.fetch(new Request(input, { body: patchedBody(original, rawPrefix) }), init)
  }

  if (rawPrefix.length > 0) {
    // The history builder already removed the visual prefix. Sending without the canonical window would lose context.
    throw new OpenAIRawInputError('Cannot replay the canonical OpenAI window: request body is unavailable')
  }
  return net.fetch(netInput, init)
}
