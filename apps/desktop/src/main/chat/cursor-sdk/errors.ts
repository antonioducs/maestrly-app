/**
 * Cursor SDK error boundary.
 * Keep classification + redaction here so no runtime error reaches UI/logs unsanitized.
 */

export type CursorSdkErrorCode =
  | 'cursor-not-authenticated'
  | 'cursor-auth-failed'
  | 'cursor-rate-limited'
  | 'cursor-configuration'
  | 'cursor-agent-busy'
  | 'cursor-agent-not-found'
  | 'cursor-network'
  | 'cursor-cancelled'
  | 'cursor-runtime-failed'
  | 'cursor-platform-unsupported'

export class CursorSdkError extends Error {
  readonly code: CursorSdkErrorCode

  constructor(code: CursorSdkErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CursorSdkError'
    this.code = code
  }
}

export const CURSOR_AUTHENTICATION_REQUIRED_MESSAGE =
  'Cursor authentication expired or became invalid. Sign in again to continue.'

const REDACTED = '[REDACTED]'

/**
 * Removes credential-shaped values from Cursor SDK diagnostics before they can
 * reach chat events, logs, or durable cleanup records.
 */
export function redactCursorCredentials(message: string): string {
  return (
    message
      .replace(
        /(\b(?:authorization|proxy-authorization)\s*[:=]\s*bearer\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        `$1${REDACTED}`
      )
      .replace(
        /(\b(?:CURSOR_API_KEY|CURSOR_AUTH_TOKEN|CURSOR_SDK_API_KEY|apiKey)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        `$1${REDACTED}`
      )
      .replace(
        /(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|oauth[_-]?token|session[_-]?token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
        `$1${REDACTED}`
      )
      .replace(
        /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|oauth[_-]?token|session[_-]?token)=)[^&#\s]*/gi,
        `$1${REDACTED}`
      )
      // Cursor user API keys observed in SDK docs / auth store (key_… shape).
      .replace(/\bkey_[A-Za-z0-9_-]{16,}\b/g, REDACTED)
      .replace(/\bcrsr_[A-Za-z0-9_-]{16,}\b/g, REDACTED)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorName(error: unknown): string {
  if (error instanceof Error && error.name) return error.name
  if (isRecord(error) && typeof error.name === 'string') return error.name
  return ''
}

function errorCode(error: unknown): string | number | undefined {
  if (!isRecord(error)) return undefined
  const code = error.code ?? error.status ?? error.statusCode
  if (typeof code === 'string' || typeof code === 'number') return code
  return undefined
}

function diagnosticText(error: unknown, seen = new Set<unknown>()): string {
  if (error == null || seen.has(error)) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) {
    seen.add(error)
    const cause = 'cause' in error ? diagnosticText((error as { cause?: unknown }).cause, seen) : ''
    return [error.message, cause].filter(Boolean).join('\n')
  }
  if (!isRecord(error)) return String(error)
  seen.add(error)
  const parts: string[] = []
  for (const key of ['message', 'error', 'detail', 'body', 'stderr']) {
    const nested = diagnosticText(error[key], seen)
    if (nested) parts.push(nested)
  }
  return parts.join('\n')
}

/** True when the caller must re-authenticate (interactive login or new API key). */
export function isCursorAuthenticationRequired(error: unknown): boolean {
  const name = errorName(error)
  if (name === 'AuthenticationError') return true
  const code = errorCode(error)
  if (code === 401 || code === '401' || code === 'unauthenticated' || code === 'authentication_error') {
    return true
  }
  const text = diagnosticText(error)
  if (!text) return false
  return [
    /\bauthentication[_\s-]*error\b/i,
    /\binvalid\s+api\s*key\b/i,
    /\bapi\s*key\b[^\n]{0,40}\b(?:invalid|expired|revoked|missing)\b/i,
    /\b(?:not\s+logged\s+in|logged\s*out|sign\s*in\s+again|log\s*in\s+again)\b/i,
    /\bunauthenticated\b/i,
  ].some((pattern) => pattern.test(text))
}

/**
 * Maps unknown Cursor SDK / runtime failures into a stable product code.
 * Prefer instanceof checks against SDK classes when available; fall back to name/code/message.
 */
export function classifyCursorSdkError(error: unknown): CursorSdkErrorCode {
  if (error instanceof CursorSdkError) return error.code

  const name = errorName(error)
  switch (name) {
    case 'AuthenticationError':
      return 'cursor-not-authenticated'
    case 'RateLimitError':
      return 'cursor-rate-limited'
    case 'ConfigurationError':
      return 'cursor-configuration'
    case 'AgentBusyError':
      return 'cursor-agent-busy'
    case 'AgentNotFoundError':
      return 'cursor-agent-not-found'
    case 'NetworkError':
      return 'cursor-network'
    case 'IntegrationNotConnectedError':
      return 'cursor-configuration'
    default:
      break
  }

  if (isCursorAuthenticationRequired(error)) return 'cursor-not-authenticated'

  const code = errorCode(error)
  if (code === 429 || code === '429' || code === 'rate_limit' || code === 'resource_exhausted') {
    return 'cursor-rate-limited'
  }
  if (code === 409 || code === '409' || code === 'agent_busy' || code === 'aborted') {
    return code === 'aborted' ? 'cursor-cancelled' : 'cursor-agent-busy'
  }
  if (code === 'agent_not_found' || code === 404 || code === '404') {
    return 'cursor-agent-not-found'
  }
  if (code === 'cancelled' || code === 'canceled' || code === 'ABORT_ERR') {
    return 'cursor-cancelled'
  }

  const text = diagnosticText(error).toLowerCase()
  if (/\bcancel(?:led|ed)\b/.test(text) || /\baborted\b/.test(text)) return 'cursor-cancelled'
  if (/\brate\s*limit|\btoo many requests\b/.test(text)) return 'cursor-rate-limited'
  if (/\bnetwork\b|\btimeout\b|\bECONN|\bENOTFOUND\b|\b503\b|\b504\b/.test(text)) {
    return 'cursor-network'
  }
  if (/\bunsupported\s+platform\b|\bplatform\s+package\b.*\bnot found\b/.test(text)) {
    return 'cursor-platform-unsupported'
  }
  if (/\binvalid\b|\bconfiguration\b|\bunknown tool\b|\bmodel\b.*\binvalid\b/.test(text)) {
    return 'cursor-configuration'
  }

  return 'cursor-runtime-failed'
}

/** Converts unknown runtime failures to a safe user/persistence-facing string. */
export function cursorSdkErrorMessage(error: unknown): string {
  if (error instanceof CursorSdkError) return redactCursorCredentials(error.message)
  if (isCursorAuthenticationRequired(error)) {
    return CURSOR_AUTHENTICATION_REQUIRED_MESSAGE
  }
  const text = diagnosticText(error).trim()
  if (text) return redactCursorCredentials(text)
  return 'Cursor Agent SDK failed unexpectedly.'
}
