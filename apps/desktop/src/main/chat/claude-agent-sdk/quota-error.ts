import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import type { MarkExhaustedInfo } from '../subscription-failover/router'

export type ClaudeQuotaClassification =
  | { kind: 'quota'; info: MarkExhaustedInfo }
  | { kind: 'suspect' }
  | { kind: 'other' }

// SDK 0.3.263's official error-path prefixes, kept local so classification does not bootstrap the SDK.
const USAGE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  'Your org is out of usage · add funds to continue',
  'Your org is out of usage · contact your admin',
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  'Your usage allocation has been disabled by your admin',
  "Your group's usage limit is set to $0",
  'Fable 5 requires usage credits',
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
] as const satisfies typeof import('@anthropic-ai/claude-agent-sdk').USAGE_LIMIT_ERROR_PREFIXES

function resetTime(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const milliseconds = value < 1e12 ? value * 1000 : value
  return Number.isFinite(milliseconds) ? milliseconds : undefined
}

function quota(reason: string, source: MarkExhaustedInfo['source'], reset?: unknown): ClaudeQuotaClassification {
  const resetsAt = resetTime(reset)
  return { kind: 'quota', info: { reason, source, ...(resetsAt === undefined ? {} : { resetsAt }) } }
}

/** Only transport diagnostics are inspected; never descend into prompt, assistant, or tool content. */
export function classifyClaudeQuotaFailure(
  error: unknown,
  rateLimitInfo?: SDKRateLimitInfo
): ClaudeQuotaClassification {
  if (rateLimitInfo?.errorCode === 'credits_required') {
    return quota(
      'Claude subscription credits required',
      'rate-limits',
      rateLimitInfo.overageResetsAt ?? rateLimitInfo.resetsAt
    )
  }
  if (rateLimitInfo?.status === 'rejected') {
    if (rateLimitInfo.overageStatus === 'allowed' || rateLimitInfo.overageStatus === 'allowed_warning') {
      return { kind: 'other' }
    }
    if ((rateLimitInfo.isUsingOverage || rateLimitInfo.overageInUse) && rateLimitInfo.overageStatus !== 'rejected') {
      return { kind: 'suspect' }
    }
    return quota(
      'Claude subscription usage limit reached',
      'rate-limits',
      rateLimitInfo.overageStatus === 'rejected'
        ? (rateLimitInfo.overageResetsAt ?? rateLimitInfo.resetsAt)
        : rateLimitInfo.resetsAt
    )
  }
  if (!error || typeof error !== 'object' || Array.isArray(error)) return { kind: 'other' }
  const record = error as Record<string, unknown>
  if (record.type === 'user' || record.type === 'tool' || record.type === 'tool_result') return { kind: 'other' }
  if (record.type === 'result' && record.subtype !== 'error_during_execution') return { kind: 'other' }
  if (record.type === 'assistant' && record.error !== 'rate_limit' && record.error !== 'billing_error')
    return { kind: 'other' }
  const assistantMessage =
    record.type === 'assistant' && record.message && typeof record.message === 'object'
      ? (record.message as Record<string, unknown>)
      : undefined
  const assistantDiagnostics = Array.isArray(assistantMessage?.content)
    ? assistantMessage.content.flatMap((block: unknown) => {
        if (!block || typeof block !== 'object') return []
        const entry = block as Record<string, unknown>
        return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
      })
    : []
  if (record.code === 'credits_required' || record.errorCode === 'credits_required') {
    return quota('Claude subscription credits required', 'structured-error', record.resetsAt)
  }
  const messages =
    error instanceof Error || record.type === 'error'
      ? [record.message]
      : record.type === 'result' && record.subtype === 'error_during_execution' && Array.isArray(record.errors)
        ? record.errors
        : assistantDiagnostics
  for (const message of messages) {
    if (typeof message !== 'string') continue
    // Anchored official CLI diagnostics avoid matching quoted user/tool text or generic rate limits.
    if (
      USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => message.trim().startsWith(prefix)) ||
      /^(?:You've hit your (?:usage )?limit|You have reached your (?:Claude )?usage limit|Claude (?:AI )?usage limit reached)(?:[. ·:—-]|$)/i.test(
        message.trim()
      )
    ) {
      return quota('Claude subscription usage limit reached', 'usage-limit-marker', record.resetsAt)
    }
  }
  if (
    record.status === 429 ||
    record.statusCode === 429 ||
    record.code === 'rate_limit' ||
    record.type === 'rate_limit_error' ||
    record.error === 'rate_limit'
  )
    return { kind: 'suspect' }
  return { kind: 'other' }
}
