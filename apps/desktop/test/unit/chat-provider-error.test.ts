import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APICallError } from '@ai-sdk/provider'
import { streamText } from 'ai'
import { net } from 'electron'
import type { ChatProviderKind } from '../../src/shared/chat'
import { addProvider } from '../../src/main/chat/catalog'
import { resolveChatModel, invalidateProvider } from '../../src/main/chat/provider'
import { describeProviderError, providerErrorContext } from '../../src/main/chat/provider-error'
import { closeDb, freshDb } from '../helpers/db'
import { startFakeProvider, type FakeProviderServer } from '../helpers/fake-provider'

const keys = vi.hoisted(() => new Map<string, string>())
vi.mock('../../src/main/chat/credentials', () => ({
  getApiKey: (providerId: string) => keys.get(providerId) ?? null,
  hasApiKey: (providerId: string) => keys.has(providerId),
}))

const KEY = 'sk-test-fake-0123456789abcdef'
const CREDITS = 'Your prepayment credits are depleted. Please go to AI Studio to manage your billing.'
/** Gemini's OpenAI-compatible endpoint wraps the error in an array, which no adapter schema accepts. */
const GEMINI_402 = [{ error: { code: 402, message: CREDITS, status: 'RESOURCE_EXHAUSTED' } }]

function apiCallError(init: { statusCode?: number; message?: string; responseBody?: string }): APICallError {
  return new APICallError({
    message: init.message ?? '',
    url: 'https://provider.test/v1/chat/completions',
    requestBodyValues: { messages: [{ role: 'user', content: 'private prompt' }] },
    statusCode: init.statusCode,
    responseBody: init.responseBody,
  })
}

describe('describeProviderError', () => {
  it('reads the message from an array-wrapped body when the SDK message is empty (HTTP/2)', () => {
    const failure = describeProviderError(apiCallError({ statusCode: 402, responseBody: JSON.stringify(GEMINI_402) }), {
      providerName: 'Gemini',
    })
    expect(failure).toEqual({
      message: `Gemini returned HTTP 402 Payment Required: ${CREDITS}`,
      detail: CREDITS,
      status: 402,
    })
  })

  it('ignores an SDK message that only repeats the reason phrase', () => {
    const failure = describeProviderError(
      apiCallError({ statusCode: 402, message: 'Payment Required', responseBody: JSON.stringify(GEMINI_402) }),
      { providerName: 'Gemini' }
    )
    expect(failure.message).toBe(`Gemini returned HTTP 402 Payment Required: ${CREDITS}`)
  })

  it('keeps the message the adapter already parsed', () => {
    const failure = describeProviderError(apiCallError({ statusCode: 429, message: 'Slow down' }), {
      providerName: 'Groq',
    })
    expect(failure.message).toBe('Groq returned HTTP 429 Too Many Requests: Slow down')
  })

  it.each([
    ['no body', undefined],
    ['an empty body', '  '],
    ['an HTML error page', '<!DOCTYPE html><html><body>Bad gateway</body></html>'],
    ['a body without a message', JSON.stringify({ error: { code: 500 } })],
  ])('names the status when the provider returns %s', (_label, responseBody) => {
    const failure = describeProviderError(apiCallError({ statusCode: 502, responseBody }), { providerName: 'Proxy' })
    expect(failure).toEqual({
      message: 'Proxy returned HTTP 502 Bad Gateway without an error message.',
      detail: '',
      status: 502,
    })
  })

  it('reads plain-text bodies and nested detail fields', () => {
    expect(describeProviderError(apiCallError({ statusCode: 401, responseBody: 'bad key' })).message).toBe(
      'The provider returned HTTP 401 Unauthorized: bad key'
    )
    expect(
      describeProviderError(apiCallError({ statusCode: 422, responseBody: JSON.stringify({ detail: [{ msg: 'x' }] }) }))
        .detail
    ).toBe('x')
  })

  it('redacts the configured key and token patterns, wherever the provider echoes them', () => {
    const body = JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. Bearer abc.def-123` } })
    const failure = describeProviderError(apiCallError({ statusCode: 401, responseBody: body }), {
      providerName: 'OpenAI',
      secrets: ['custom-literal-secret-value', null],
    })
    expect(failure.message).not.toContain(KEY)
    expect(failure.message).not.toContain('abc.def-123')
    // Not a configured secret here, so the token pattern masks it (taking the trailing period with it).
    expect(failure.message).toBe('OpenAI returned HTTP 401 Unauthorized: Incorrect API key provided: sk-*** Bearer ***')
    const literal = describeProviderError(
      apiCallError({ statusCode: 401, message: 'key custom-literal-secret-value' }),
      {
        secrets: ['custom-literal-secret-value'],
      }
    )
    expect(literal.message).toBe('The provider returned HTTP 401 Unauthorized: key ***')
  })

  it('clips very long provider messages', () => {
    const failure = describeProviderError(apiCallError({ statusCode: 400, message: 'x'.repeat(5_000) }))
    expect(failure.detail.length).toBeLessThanOrEqual(1_001)
    expect(failure.detail.endsWith('…')).toBe(true)
  })

  it('finds the provider response behind retry and cause wrappers', () => {
    const inner = apiCallError({ statusCode: 401, message: 'invalid x-api-key' })
    const wrapped = Object.assign(new Error('Failed after 1 attempts'), { lastError: inner })
    expect(describeProviderError(wrapped, { providerName: 'Anthropic' }).message).toBe(
      'Anthropic returned HTTP 401 Unauthorized: invalid x-api-key'
    )
    expect(describeProviderError(new Error('outer', { cause: inner }), { providerName: 'Anthropic' }).status).toBe(401)
  })

  it('keeps errors without an HTTP status as they are, and never returns an empty message', () => {
    expect(describeProviderError(new Error('fetch failed'), { providerName: 'Gemini' })).toEqual({
      message: 'fetch failed',
      detail: 'fetch failed',
    })
    expect(describeProviderError(apiCallError({ message: 'Cannot connect to API: ECONNREFUSED' })).message).toBe(
      'Cannot connect to API: ECONNREFUSED'
    )
    expect(describeProviderError(new Error(''), { providerName: 'Gemini' }).message).toBe(
      'Gemini failed without an error message.'
    )
    expect(describeProviderError(undefined).message).toBe('The provider failed without an error message.')
  })
})

describe('API-key presets against a fake provider', () => {
  let server: FakeProviderServer | null = null

  beforeEach(() => {
    freshDb()
    keys.clear()
    invalidateProvider()
    // Electron's net.fetch is the transport in the app; plain fetch reaches the local fake provider here.
    vi.spyOn(net, 'fetch').mockImplementation(((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init)) as never)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await server?.close()
    server = null
    closeDb()
  })

  async function failedCall(input: {
    name: string
    kind?: ChatProviderKind
    modelId: string
    reply: Parameters<typeof startFakeProvider>[0]
  }) {
    server = await startFakeProvider(input.reply)
    const provider = addProvider({ name: input.name, baseURL: server.baseURL, kind: input.kind })
    keys.set(provider.id, KEY)
    const { model } = resolveChatModel(provider.id, input.modelId)
    const result = streamText({ model, prompt: 'hello', maxRetries: 0, onError: () => undefined })
    let error: unknown = null
    for await (const part of result.fullStream) if (part.type === 'error') error = part.error
    expect(error).not.toBeNull()
    return { failure: describeProviderError(error, providerErrorContext(provider.id)), requests: server.requests }
  }

  const presets = [
    {
      label: 'OpenAI-compatible',
      name: 'Gemini',
      kind: undefined,
      modelId: 'models/gemini-3-flash-preview',
      path: '/v1/chat/completions',
    },
    { label: 'OpenAI', name: 'OpenAI', kind: 'openai-responses' as const, modelId: 'gpt-5.5', path: '/v1/responses' },
    {
      label: 'Anthropic',
      name: 'Anthropic',
      kind: 'anthropic' as const,
      modelId: 'claude-opus-5',
      path: '/v1/messages',
    },
  ]

  it.each(presets)('$label: shows a 402 that only the body explains, over HTTP/2', async (preset) => {
    const { failure, requests } = await failedCall({
      ...preset,
      reply: { status: 402, reason: '', body: GEMINI_402 },
    })
    expect(requests.map((request) => request.path)).toEqual([preset.path])
    expect(failure).toEqual({
      message: `${preset.name} returned HTTP 402 Payment Required: ${CREDITS}`,
      detail: CREDITS,
      status: 402,
    })
  })

  it.each([
    {
      ...presets[0],
      body: { error: { message: `Incorrect API key provided: ${KEY}`, type: 'invalid_request_error', code: 401 } },
      expected: 'Incorrect API key provided: ***',
    },
    {
      ...presets[1],
      body: {
        error: {
          message: `Incorrect API key provided: ${KEY}.`,
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_api_key',
        },
      },
      expected: 'Incorrect API key provided: ***.',
    },
    {
      ...presets[2],
      body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      expected: 'invalid x-api-key',
    },
  ])('$label: shows a 401 without echoing the key', async (preset) => {
    const { failure } = await failedCall({ ...preset, reply: { status: 401, body: preset.body } })
    expect(failure.status).toBe(401)
    expect(failure.message).toBe(`${preset.name} returned HTTP 401 Unauthorized: ${preset.expected}`)
    expect(failure.message).not.toContain(KEY)
  })
})
