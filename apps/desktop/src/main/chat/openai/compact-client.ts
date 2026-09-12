import { randomUUID } from 'node:crypto'
import { net } from 'electron'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, type ModelMessage } from 'ai'
import { getProvider, getProviderKind } from '../catalog'
import { getApiKey } from '../credentials'
import { buildOpenAIProviderFingerprint, ChatConfigError } from '../provider'
import { toOpenAILedgerValue } from './ledger'
import { prependOpenAIRawResponseItems } from './raw-input'
import type { OpenAICanonicalCompactionWindow, OpenAILedgerObject, OpenAILedgerValue } from './types'

export interface OpenAICompactUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

export interface OpenAICompactResult {
  canonicalWindow: OpenAICanonicalCompactionWindow
  usage?: OpenAICompactUsage
  requestId?: string
}

/**
 * Endpoint and credential stay fixed during compaction, preventing ciphertext from being tagged with another
 * identity.
 */
export interface OpenAICompactTransportSnapshot {
  providerId: string
  baseURL: string
  apiKey: string
  providerFingerprint: string
}

export class OpenAICompactError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly requestId?: string
  ) {
    super(message)
    this.name = 'OpenAICompactError'
  }
}

export function isOpenAICompactUnsupported(error: unknown): boolean {
  return (
    error instanceof OpenAICompactError &&
    error.status !== undefined &&
    [400, 404, 405, 413, 415, 422, 501].includes(error.status)
  )
}

/** Endpoint failures must not block the legacy summary; auth and rate-limit errors remain visible. */
export function canFallbackFromOpenAICompact(error: unknown): boolean {
  return (
    error instanceof OpenAICompactError &&
    (error.status === undefined || isOpenAICompactUnsupported(error) || error.status >= 500)
  )
}

export function resolveOpenAICompactTransport(providerId: string): OpenAICompactTransportSnapshot {
  const descriptor = getProvider(providerId)
  if (!descriptor) throw new ChatConfigError(`Unknown provider: ${providerId}`, 'unknown-provider')
  const transport = getProviderKind(descriptor)
  if (transport !== 'openai-responses') {
    throw new OpenAICompactError('Provider does not use the OpenAI Responses API')
  }
  const apiKey = getApiKey(providerId)
  if (!apiKey) throw new ChatConfigError(`No API key configured for ${descriptor.name}.`, 'no-key')
  return {
    providerId,
    baseURL: descriptor.baseURL,
    apiKey,
    providerFingerprint: buildOpenAIProviderFingerprint(descriptor, transport, apiKey),
  }
}

function jsonObject(value: unknown, path: string): OpenAILedgerObject {
  const json = toOpenAILedgerValue(value, path)
  if (json === null || Array.isArray(json) || typeof json !== 'object') {
    throw new OpenAICompactError(`${path} must be a JSON object`)
  }
  return json
}

function compactUsage(response: OpenAILedgerObject): OpenAICompactUsage | undefined {
  const usage = response.usage
  if (usage === null || Array.isArray(usage) || typeof usage !== 'object') return undefined
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
  const details = usage.input_tokens_details
  const cachedInputTokens =
    details !== null &&
    !Array.isArray(details) &&
    typeof details === 'object' &&
    typeof details.cached_tokens === 'number'
      ? details.cached_tokens
      : 0
  return inputTokens || outputTokens || cachedInputTokens ? { inputTokens, outputTokens, cachedInputTokens } : undefined
}

/** Validate the envelope while preserving every field and output item verbatim. */
export function parseOpenAICompactResponse(value: unknown): OpenAICompactResult {
  const response = jsonObject(value, '$.compactResponse')
  if (response.object !== undefined && response.object !== 'response.compaction') {
    throw new OpenAICompactError('Unexpected /responses/compact object')
  }
  if (!Array.isArray(response.output)) throw new OpenAICompactError('/responses/compact output must be an array')
  const checkpoints = response.output.filter(
    (item): item is OpenAILedgerObject =>
      item !== null && !Array.isArray(item) && typeof item === 'object' && item.type === 'compaction'
  )
  if (
    checkpoints.length !== 1 ||
    typeof checkpoints[0].encrypted_content !== 'string' ||
    checkpoints[0].encrypted_content.length === 0
  ) {
    throw new OpenAICompactError('/responses/compact must return exactly one encrypted compaction item')
  }
  const usage = compactUsage(response)
  return {
    canonicalWindow: { kind: 'responses.compact', response },
    ...(usage ? { usage } : {}),
  }
}

/**
 * Use the provider's public converter to materialize ModelMessage -> ResponseItem without inference. The local
 * fetch returns a valid empty response; only the converted body is used.
 */
export async function materializeOpenAIResponsesInput(args: {
  modelId: string
  messages: readonly ModelMessage[]
  rawPrefix?: readonly OpenAILedgerValue[]
  signal?: AbortSignal
}): Promise<OpenAILedgerValue[]> {
  let captured: OpenAILedgerValue[] | null = null
  const captureFetch: typeof globalThis.fetch = async (_input, init) => {
    if (typeof init?.body !== 'string') throw new OpenAICompactError('OpenAI SDK produced a non-JSON request body')
    const body = jsonObject(JSON.parse(init.body), '$.responsesRequest')
    const withPrefix = args.rawPrefix?.length ? prependOpenAIRawResponseItems(body, args.rawPrefix) : body
    if (!Array.isArray(withPrefix.input)) throw new OpenAICompactError('OpenAI SDK request is missing input items')
    captured = withPrefix.input
    return new Response(
      JSON.stringify({
        id: 'resp_compact_input_capture',
        object: 'response',
        output: [],
        usage: {
          input_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
  const captureProvider = createOpenAI({
    name: 'maestrly-compact-input-capture',
    baseURL: 'https://capture.invalid/v1',
    apiKey: 'capture-only',
    fetch: captureFetch,
  })
  await generateText({
    model: captureProvider.responses(args.modelId),
    messages: [...args.messages],
    abortSignal: args.signal,
    maxRetries: 0,
    providerOptions: {
      openai: {
        store: false,
        include: ['reasoning.encrypted_content'],
        truncation: 'disabled',
      },
    },
  })
  if (!captured) throw new OpenAICompactError('OpenAI SDK did not materialize a Responses input')
  return captured
}

function endpoint(baseURL: string): string {
  return `${baseURL.trim().replace(/\/+$/, '')}/responses/compact`
}

function providerErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string' && message.trim()) return message.trim()
  } catch {
    /* Non-JSON response. */
  }
  return `OpenAI compact request failed with HTTP ${status}`
}

export async function compactOpenAIResponses(args: {
  transport: OpenAICompactTransportSnapshot
  modelId: string
  input: readonly OpenAILedgerValue[]
  promptCacheKey?: string
  signal?: AbortSignal
}): Promise<OpenAICompactResult> {
  const clientRequestId = randomUUID()
  const body: OpenAILedgerObject = {
    model: args.modelId,
    input: [...args.input],
    ...(args.promptCacheKey ? { prompt_cache_key: args.promptCacheKey } : {}),
  }
  let response: Response
  try {
    response = await net.fetch(endpoint(args.transport.baseURL), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.transport.apiKey}`,
        'content-type': 'application/json',
        'x-client-request-id': clientRequestId,
      },
      body: JSON.stringify(body),
      signal: args.signal,
    })
  } catch (error) {
    if (args.signal?.aborted) throw error
    const reason = error instanceof Error && error.message ? `: ${error.message}` : ''
    throw new OpenAICompactError(`OpenAI compact request could not reach the endpoint${reason}`)
  }
  const requestId = response.headers.get('x-request-id') ?? undefined
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    if (args.signal?.aborted) throw error
    const reason = error instanceof Error && error.message ? `: ${error.message}` : ''
    throw new OpenAICompactError(
      `OpenAI compact response body could not be read${reason}`,
      response.ok ? undefined : response.status,
      requestId
    )
  }
  if (!response.ok) {
    throw new OpenAICompactError(providerErrorMessage(text, response.status), response.status, requestId)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // HTTP 200 with an incompatible body means an unusable endpoint, not a caller auth/input failure.
    throw new OpenAICompactError('/responses/compact returned invalid JSON', undefined, requestId)
  }
  const result = parseOpenAICompactResponse(parsed)
  return { ...result, requestId }
}
