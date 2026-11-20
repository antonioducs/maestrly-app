import type { ChatErrorCode } from '../../../shared/chat'
import { AcpProcessExitedError, AcpRpcError } from '../acp/client'
import { ACP_AUTH_REQUIRED_CODE } from '../acp/protocol'

export class AntigravityAuthRequiredError extends Error {
  constructor(message = 'Google AI sign-in is missing or expired. Sign in again in Settings > Providers.') {
    super(message)
    this.name = 'AntigravityAuthRequiredError'
  }
}

export class AntigravityAccountChangedError extends Error {
  constructor(message = 'The Google AI account changed during this request. Send the message again.') {
    super(message)
    this.name = 'AntigravityAccountChangedError'
  }
}

export class AntigravityModelUnavailableError extends Error {
  constructor(modelId: string) {
    super(`The Google AI model "${modelId}" is not available for this account. Choose another model.`)
    this.name = 'AntigravityModelUnavailableError'
  }
}

export class AntigravityToolsUnavailableError extends Error {
  constructor(
    message = "Google Antigravity could not connect to Maestrly's tools. Send the message again; if it keeps failing, restart Maestrly."
  ) {
    super(message)
    this.name = 'AntigravityToolsUnavailableError'
  }
}

export class AntigravityRuntimeStoppedError extends Error {
  constructor(message = 'The Google Antigravity ACP server stopped unexpectedly. Send the message again.') {
    super(message)
    this.name = 'AntigravityRuntimeStoppedError'
  }
}

/**
 * What exceeds the limit: the conversation (compacting helps), Maestrly's instructions and tool list, or the
 * message with its attachments (neither can be compacted).
 */
export type AntigravityPromptOverflow = 'conversation' | 'setup' | 'message'

const PROMPT_OVERFLOW_ADVICE: Record<AntigravityPromptOverflow, string> = {
  conversation: 'Compact the conversation or shorten the message, then try again.',
  setup:
    "Maestrly's instructions and tool list alone exceed it, so compacting cannot help. Turn off MCP servers this conversation does not need, or choose another model.",
  message: 'The message alone exceeds it. Shorten the message or its attachments, then try again.',
}

export class AntigravityPromptTooLargeError extends Error {
  constructor(
    bytes: number,
    readonly overflow: AntigravityPromptOverflow = 'conversation'
  ) {
    super(
      `This request is too large for Google Antigravity (${bytes.toLocaleString('en-US')} bytes of text; the runtime drops everything after 192,000). Nothing was sent. ${PROMPT_OVERFLOW_ADVICE[overflow]}`
    )
    this.name = 'AntigravityPromptTooLargeError'
  }
}

const QUOTA_PATTERN = /RESOURCE_EXHAUSTED|quota|rate.?limit|usage limit/i
const QUOTA_MESSAGE =
  'Google AI usage limit reached for this model. Wait for the limit to reset or choose another model.'

/** OAuth access/refresh tokens and client secrets must never reach chat transcripts or logs. */
export function redactAntigravityCredentials(text: string): string {
  return text
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/1\/\/[A-Za-z0-9._-]{10,}/g, '[redacted]')
    .replace(/GOCSPX-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/("?(?:refresh_token|access_token|client_secret|id_token)"?\s*[:=]\s*)"?[^",\s}]+"?/gi, '$1[redacted]')
}

export function isAntigravityAuthRequired(error: unknown): boolean {
  return (
    error instanceof AntigravityAuthRequiredError ||
    (error instanceof AcpRpcError && error.code === ACP_AUTH_REQUIRED_CODE)
  )
}

const EXECUTION_ERROR_PREFIX = 'Agent execution error: '

/** A turn the server ended with an error it reported as the turn's text. */
export class AntigravityExecutionError extends Error {
  constructor(message: string) {
    super(redactAntigravityCredentials(message))
    this.name = 'AntigravityExecutionError'
  }
}

/**
 * The server answers `session/prompt` normally when the turn fails and sends the failure as a final message chunk
 * (`Agent execution error: ...`), so a caller that only reads text would take it for the model's answer.
 */
export function antigravityExecutionErrorChunk(text: string): AntigravityExecutionError | null {
  return text.startsWith(EXECUTION_ERROR_PREFIX) ? new AntigravityExecutionError(text.trim()) : null
}

/**
 * The default messages Google's API front end attaches to each `google.rpc.Status`. Since ACP 1.4 the server reports a
 * failed model call by sending only that message as the turn's last text, without the `Agent execution error:` prefix.
 */
const GOOGLE_API_MESSAGES: Record<string, string> = {
  'Request contains an invalid argument.': 'INVALID_ARGUMENT',
  'Precondition check failed.': 'FAILED_PRECONDITION',
  'The caller does not have permission': 'PERMISSION_DENIED',
  'Requested entity was not found.': 'NOT_FOUND',
  'Resource has been exhausted (e.g. check quota).': 'RESOURCE_EXHAUSTED',
  'Internal error encountered.': 'INTERNAL',
  'The service is currently unavailable.': 'UNAVAILABLE',
  'Deadline expired before operation could complete.': 'DEADLINE_EXCEEDED',
}
const GOOGLE_UNAUTHENTICATED = /^Request had invalid authentication credentials\./
const GOOGLE_TOKEN_LIMIT = /^The input token count(?: \(\d+\))? exceeds the maximum number of tokens allowed/
// The server's own wording for an exhausted Google AI quota (`quota_errors.py`).
const SERVER_QUOTA = /^Usage Limit Reached\n\nYou have reached your current quota for this period\.(?: (.+))?$/s

/** A model call Google's API rejected, reported by the server as the turn's last text. */
export class AntigravityApiError extends AntigravityExecutionError {
  constructor(
    message: string,
    readonly status: string
  ) {
    super(message)
    this.name = 'AntigravityApiError'
  }
}

/**
 * Reads text that has the exact shape of the server's report of a rejected model call: Google's message alone, or
 * followed by the action link the server appends. Callers must still check that nothing followed it in the turn,
 * because a model could write the same words.
 */
export function antigravityApiErrorText(text: string): AntigravityApiError | null {
  const trimmed = text.trim()
  const quota = SERVER_QUOTA.exec(trimmed)
  if (quota) return new AntigravityApiError(`${QUOTA_MESSAGE}${quota[1] ? ` ${quota[1]}` : ''}`, 'RESOURCE_EXHAUSTED')
  const [first = '', ...rest] = trimmed.split('\n\n')
  if (rest.length > 1 || (rest.length === 1 && !/^[^\n]+: https:\/\/\S+$/.test(rest[0]))) return null
  const status =
    GOOGLE_API_MESSAGES[first] ??
    (GOOGLE_UNAUTHENTICATED.test(first) ? 'UNAUTHENTICATED' : GOOGLE_TOKEN_LIMIT.test(first) ? 'TOKEN_LIMIT' : null)
  return status ? new AntigravityApiError(trimmed, status) : null
}

/**
 * Withholds a message chunk that reads as a rejected model call until the turn shows whether anything follows it:
 * the server sends that report last, while a model that merely wrote the same words keeps going or the text is
 * part of a longer reply. Usage and tool-closing updates the server sends after a failure do not release it.
 */
export function createAntigravityApiFailureHold<T>() {
  let held: { item: T; error: AntigravityApiError } | null = null
  return {
    /** Withholds the chunk when it reads as a failure; returns whether it did. Release earlier held text first. */
    hold(text: string, item: T): boolean {
      const error = antigravityApiErrorText(text)
      if (!error) return false
      held = { item, error }
      return true
    },
    /** The withheld chunk, now known to be ordinary text, or null. */
    release(): T | null {
      const item = held?.item ?? null
      held = null
      return item
    },
    /** At the end of the turn: the failure the withheld chunk reported, or null. */
    settle(): AntigravityApiError | null {
      const error = held?.error ?? null
      held = null
      return error
    },
  }
}

const API_ERROR_ADVICE =
  "The error comes from Google's servers, not from Maestrly. Send the message again; if it keeps failing, choose another model or reasoning level."

function apiErrorMessage(error: AntigravityApiError): string {
  if (error.status === 'RESOURCE_EXHAUSTED') {
    return error.message.startsWith(QUOTA_MESSAGE) ? error.message : QUOTA_MESSAGE
  }
  if (error.status === 'TOKEN_LIMIT') return `Google AI rejected this request as too long: ${error.message}`
  if (error.status === 'INVALID_ARGUMENT') {
    return `Google AI rejected this request as invalid (400 INVALID_ARGUMENT: "${error.message}"). ${API_ERROR_ADVICE}`
  }
  return `Google AI failed this request (${error.status}: "${error.message}"). ${API_ERROR_ADVICE}`
}

/**
 * The server lost a session's harness: it crashed, or the server stalled past the harness WebSocket keepalive (close
 * code 1011), which drops every open session at once. A fresh session on a healthy process can succeed.
 */
export function isAntigravityHarnessLost(error: unknown): boolean {
  return error instanceof Error && /Harness process exited/i.test(error.message)
}

export function isAntigravityQuotaError(error: unknown): boolean {
  return error instanceof Error && QUOTA_PATTERN.test(error.message)
}

export function isAntigravityPeriodQuotaError(error: unknown): boolean {
  return (
    error instanceof AntigravityApiError &&
    error.status === 'RESOURCE_EXHAUSTED' &&
    error.message.startsWith(QUOTA_MESSAGE)
  )
}

export function antigravityErrorMessage(error: unknown): { message: string; code?: ChatErrorCode } {
  if (
    isAntigravityAuthRequired(error) ||
    (error instanceof AntigravityApiError && error.status === 'UNAUTHENTICATED')
  ) {
    return { message: new AntigravityAuthRequiredError().message }
  }
  if (error instanceof AntigravityApiError) return { message: apiErrorMessage(error) }
  if (error instanceof AcpProcessExitedError) return { message: new AntigravityRuntimeStoppedError().message }
  if (isAntigravityHarnessLost(error)) {
    // The first line names the cause; the harness stderr that follows is startup noise.
    const cause = (error as Error).message.replace(EXECUTION_ERROR_PREFIX, '').split('\n')[0].trim()
    return { message: `Google Antigravity lost this session: ${cause} Send the message again.` }
  }
  if (isAntigravityQuotaError(error)) return { message: QUOTA_MESSAGE }
  if (error instanceof Error && error.message.trim()) return { message: redactAntigravityCredentials(error.message) }
  if (typeof error === 'string' && error.trim()) return { message: redactAntigravityCredentials(error) }
  return { message: 'Google Antigravity failed unexpectedly.' }
}
