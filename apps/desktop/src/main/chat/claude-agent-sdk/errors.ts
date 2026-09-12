export type ClaudeSubscriptionErrorCode =
  | 'claude-not-installed'
  | 'claude-version-incompatible'
  | 'claude-not-authenticated'
  | 'claude-auth-failed'
  | 'claude-runtime-failed'

export class ClaudeSubscriptionError extends Error {
  readonly code: ClaudeSubscriptionErrorCode

  constructor(code: ClaudeSubscriptionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ClaudeSubscriptionError'
    this.code = code
  }
}

export const CLAUDE_AUTHENTICATION_REQUIRED_MESSAGE =
  'Claude authentication expired or became invalid. Sign in again to continue.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function authenticationDiagnosticEntries(value: unknown, seen = new Set<unknown>()): string[] {
  if (value == null || seen.has(value)) return []
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (value instanceof Error) {
    seen.add(value)
    return [
      ...(value.message.trim() ? [value.message.trim()] : []),
      ...authenticationDiagnosticEntries(value.cause, seen),
    ]
  }
  if (!isRecord(value)) return []
  seen.add(value)
  const entries: string[] = []
  for (const key of ['message', 'error', 'detail', 'body', 'stderr']) {
    entries.push(...authenticationDiagnosticEntries(value[key], seen))
  }
  if (Array.isArray(value.errors)) {
    for (const error of value.errors) entries.push(...authenticationDiagnosticEntries(error, seen))
  }
  return entries
}

/**
 * Terminal subscription authentication failures require an explicit login. Keep
 * this classification shared by probes and chat turns so stale CLI auth status
 * cannot make an expired credential admissible again.
 */
export function isClaudeAuthenticationRequired(error: unknown): boolean {
  if (isRecord(error)) {
    const status = error.status ?? error.statusCode ?? error.code
    if (status === 401 || status === '401') return true
  }
  const diagnostic = authenticationDiagnosticEntries(error).join('\n')
  if (!diagnostic) return false
  return [
    /\bauthentication[_\s-]*error\b/i,
    /\boauth\b[^\n]{0,80}\b(?:expired|invalid|revoked)\b/i,
    /\b(?:expired|invalid|revoked)\b[^\n]{0,80}\boauth\b/i,
    /\b(?:access|auth|bearer)\s+token\b[^\n]{0,80}\b(?:expired|invalid|revoked)\b/i,
    /\b(?:re-?authenticat(?:e|ion)|authenticate again|log\s*in again|sign\s*in again)\b/i,
    /\b(?:run|use)\b[^\n]{0,80}\bclaude\b[^\n]{0,40}\b(?:auth\s+login|login)\b/i,
  ].some((pattern) => pattern.test(diagnostic))
}

export function isClaudeModelUnavailable(error: unknown): boolean {
  const diagnostic = authenticationDiagnosticEntries(error).join('\n')
  if (!diagnostic) return false
  return [
    /\bmodel[_\s-]*not[_\s-]*found\b/i,
    /\bselected model\b[^\n]{0,160}\b(?:does not exist|not exist|not available|not have access|no access|not supported)\b/i,
    /\bmodel\b[^\n]{0,120}\b(?:is not available for|is unavailable to)\b/i,
    /\bunknown model\b/i,
  ].some((pattern) => pattern.test(diagnostic))
}

const REDACTED = '[REDACTED]'

/**
 * Removes credential-shaped values from runtime diagnostics before they can
 * reach chat events, logs, or durable cleanup records.
 */
export function redactClaudeCredentials(message: string): string {
  return message
    .replace(
      /(\b(?:authorization|proxy-authorization)\s*[:=]\s*bearer\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${REDACTED}`
    )
    .replace(
      /(\b(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_API_KEY)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${REDACTED}`
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|oauth[_-]?token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      `$1${REDACTED}`
    )
    .replace(/([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|oauth[_-]?token)=)[^&#\s]*/gi, `$1${REDACTED}`)
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/g, REDACTED)
}

export function claudeSubscriptionErrorMessage(error: unknown): string {
  if (error instanceof ClaudeSubscriptionError) return redactClaudeCredentials(error.message)
  if (error instanceof Error && error.message.trim()) return redactClaudeCredentials(error.message)
  if (typeof error === 'string' && error.trim()) return redactClaudeCredentials(error)
  return 'Claude Code failed unexpectedly.'
}

export function claudeRuntimeErrorMessage(error: unknown, modelId?: string): string {
  if (isClaudeModelUnavailable(error)) {
    const model = modelId?.trim() ? ` “${modelId.trim()}”` : ''
    return `Claude model${model} is not available for this account or Claude Code version. Update Claude Code or choose another model.`
  }
  return claudeSubscriptionErrorMessage(error)
}
