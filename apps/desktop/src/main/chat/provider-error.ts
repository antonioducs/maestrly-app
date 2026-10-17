/**
 * User-facing text for a failed API-key model call (OpenAI, Anthropic and OpenAI-compatible providers).
 *
 * `APICallError.message` alone is not enough: when an error body does not match the adapter's schema
 * (Gemini's OpenAI-compatible endpoint wraps errors in an array), the AI SDK falls back to the HTTP
 * reason phrase, which Chromium's network stack leaves empty over HTTP/2. The turn then failed with an
 * empty message and the conversation showed nothing. Name the provider and HTTP status, read the
 * provider's own message from the body, and redact credentials before the text is persisted, sent to
 * the renderer or written to diagnostics.
 */
import { STATUS_CODES } from 'node:http'
import { APICallError } from '@ai-sdk/provider'
import { tMain } from '../i18n'
import { buildRedactor } from '../pii-scrub'
import { getProvider } from './catalog'
import { getApiKey } from './credentials'

const MAX_DETAIL_CHARS = 1_000
const MAX_CAUSE_DEPTH = 4
const MESSAGE_KEYS = ['message', 'error', 'detail', 'error_description', 'msg'] as const

export interface ProviderErrorContext {
  /** Provider name as the user configured it; omitted when unknown. */
  providerName?: string
  /** Literal credentials of this call, masked wherever the provider echoes them back. */
  secrets?: readonly (string | null | undefined)[]
}

export interface ProviderErrorDescription {
  /** Redacted, never-empty text for the conversation, persistence and diagnostics. */
  message: string
  /** Redacted provider-supplied detail without the provider/status prefix; may be empty. */
  detail: string
  /** HTTP status when the provider answered the request. */
  status?: number
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error == null) return ''
  try {
    return JSON.stringify(error) ?? ''
  } catch {
    return String(error)
  }
}

/** The provider response behind a failure, also when wrapped by a retry or another error. */
function findApiCallError(error: unknown): APICallError | null {
  let current = error
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current != null; depth++) {
    if (APICallError.isInstance(current)) return current
    if (typeof current !== 'object') return null
    const wrapper = current as { lastError?: unknown; cause?: unknown }
    current = wrapper.lastError ?? wrapper.cause
  }
  return null
}

function messageFromJson(value: unknown, depth = 0): string {
  if (depth > MAX_CAUSE_DEPTH || value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = messageFromJson(item, depth + 1)
      if (message) return message
    }
    return ''
  }
  if (typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of MESSAGE_KEYS) {
    const message = messageFromJson(record[key], depth + 1)
    if (message) return message
  }
  return ''
}

function detailFromResponseBody(body: string | undefined): string {
  const text = body?.trim()
  if (!text) return ''
  try {
    return messageFromJson(JSON.parse(text))
  } catch {
    // Proxy and gateway error pages carry markup, not a message worth showing.
    return /^<(?:!doctype|html|\?xml)/i.test(text) ? '' : text
  }
}

function reasonPhrase(status: number): string | undefined {
  return STATUS_CODES[status]
}

/** The SDK falls back to the reason phrase when it cannot parse the body; that says nothing new. */
function isOnlyReasonPhrase(text: string, status: number): boolean {
  return !text || text.toLowerCase() === reasonPhrase(status)?.toLowerCase()
}

function clip(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS).trimEnd()}…` : text
}

export function describeProviderError(error: unknown, context: ProviderErrorContext = {}): ProviderErrorDescription {
  const redact = buildRedactor({
    paths: [],
    secrets: (context.secrets ?? []).filter((secret): secret is string => typeof secret === 'string'),
  })
  const t = tMain('main')
  const provider = context.providerName?.trim() || t('chatProviderError.unnamedProvider')
  const apiError = findApiCallError(error)
  const status = apiError?.statusCode

  if (apiError && status != null) {
    const sdkMessage = apiError.message.trim()
    const bodyMessage = detailFromResponseBody(apiError.responseBody)
    const chosen = isOnlyReasonPhrase(sdkMessage, status) ? bodyMessage : sdkMessage
    const detail = isOnlyReasonPhrase(chosen, status) ? '' : redact(clip(chosen))
    const statusLabel = [status, reasonPhrase(status)].filter(Boolean).join(' ')
    const message = detail
      ? t('chatProviderError.http', { provider, status: statusLabel, detail })
      : t('chatProviderError.httpWithoutDetail', { provider, status: statusLabel })
    return { message: redact(message), detail, status }
  }

  // Network failures and local errors keep their own text; prefixing the provider could misattribute them.
  const detail = redact(clip(errorText(apiError ?? error).trim()))
  return { message: detail || redact(t('chatProviderError.withoutDetail', { provider })), detail }
}

/** Provider name and credential of a model selection, resolved only when a call has already failed. */
export function providerErrorContext(providerId: string): ProviderErrorContext {
  let secret: string | null = null
  try {
    secret = getApiKey(providerId)
  } catch {
    // Secure storage may be unavailable; the token patterns still apply.
  }
  return { providerName: getProvider(providerId)?.name, secrets: [secret] }
}
