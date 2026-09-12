import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import type {
  ChatSubscriptionProviderKind,
  ChatSubscriptionUsage,
  ChatSubscriptionUsageWindow,
  ChatSubscriptionUsageWindowKind,
} from '../../shared/chat'
import type { CodexAccountRateLimits } from './codex-subscription'
import { getCodexSubscriptionManager } from './codex-subscription'
import { getClaudeSubscriptionManager } from './claude-agent-sdk'

const FIVE_HOUR_MINS = 5 * 60
const WEEK_MINS = 7 * 24 * 60

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'string' && !value.trim()) return null
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(number) ? number : null
}

function usedPercent(value: unknown): number | null {
  const number = finiteNumber(value)
  return number === null ? null : Math.min(100, Math.max(0, number))
}

function durationMins(value: unknown): number | null {
  const number = finiteNumber(value)
  return number !== null && number >= 0 ? number : null
}

function resetTimestamp(value: unknown): number | null {
  if (value == null) return null
  const numeric = finiteNumber(value)
  if (numeric !== null) {
    const rounded = Math.round(numeric)
    return rounded < 1e12 ? rounded * 1000 : rounded
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function classifyDuration(minutes: number | null): ChatSubscriptionUsageWindowKind {
  if (minutes === FIVE_HOUR_MINS) return 'five-hour'
  if (minutes === WEEK_MINS) return 'weekly'
  return 'other'
}

function safeId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'window'
}

function codexWindow(id: string, value: unknown): ChatSubscriptionUsageWindow | null {
  if (!isRecord(value)) return null
  const percent = usedPercent(value.usedPercent)
  if (percent === null) return null
  const minutes = durationMins(value.windowDurationMins)
  return {
    id: safeId(id),
    kind: classifyDuration(minutes),
    usedPercent: percent,
    resetsAt: resetTimestamp(value.resetsAt),
    durationMins: minutes,
  }
}

/** Normalizes the app-server account-wide snapshot without assuming primary/secondary always mean 5h/7d. */
export function normalizeCodexSubscriptionUsage(value: unknown): ChatSubscriptionUsageWindow[] {
  if (!isRecord(value)) return []
  const windows: ChatSubscriptionUsageWindow[] = []
  const seen = new Set<string>()
  const append = (id: string, candidate: unknown) => {
    const window = codexWindow(id, candidate)
    if (!window || seen.has(window.id)) return
    seen.add(window.id)
    windows.push(window)
  }

  append('primary', value.primary)
  append('secondary', value.secondary)
  for (const [id, candidate] of Object.entries(value)) {
    if (id === 'primary' || id === 'secondary') continue
    append(id, candidate)
  }
  return windows
}

function claudeWindow(
  id: string,
  kind: ChatSubscriptionUsageWindowKind,
  value: unknown,
  label?: string
): ChatSubscriptionUsageWindow | null {
  if (!isRecord(value)) return null
  const percent = usedPercent(value.utilization)
  if (percent === null) return null
  return {
    id: safeId(id),
    kind,
    usedPercent: percent,
    resetsAt: resetTimestamp(value.resets_at),
    durationMins:
      kind === 'five-hour' ? FIVE_HOUR_MINS : kind === 'weekly' || kind === 'weekly-model' ? WEEK_MINS : null,
    ...(label?.trim() ? { label: label.trim() } : {}),
  }
}

function dynamicClaudeLabel(id: string): string | undefined {
  const suffix = id.replace(/^seven_day_/, '').trim()
  if (!suffix) return undefined
  if (suffix === 'oauth_apps') return 'OAuth apps'
  return suffix
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Defensive parser for the experimental SDK method. Preserve future `seven_day_*` fields as weekly
 * buckets by model/scope; ignore windows without an official percentage.
 */
export function normalizeClaudeSubscriptionUsage(value: unknown): ChatSubscriptionUsageWindow[] {
  if (!isRecord(value) || value.rate_limits_available === false || !isRecord(value.rate_limits)) return []
  const limits = value.rate_limits
  const windows: ChatSubscriptionUsageWindow[] = []
  const seen = new Set<string>()
  const append = (window: ChatSubscriptionUsageWindow | null) => {
    if (!window || seen.has(window.id)) return
    seen.add(window.id)
    windows.push(window)
  }

  append(claudeWindow('five-hour', 'five-hour', limits.five_hour))
  append(claudeWindow('weekly', 'weekly', limits.seven_day))

  for (const [id, candidate] of Object.entries(limits)) {
    if (id === 'five_hour' || id === 'seven_day' || id === 'model_scoped' || id === 'extra_usage') continue
    if (id.startsWith('seven_day_')) {
      append(claudeWindow(`weekly-${id.slice('seven_day_'.length)}`, 'weekly-model', candidate, dynamicClaudeLabel(id)))
    }
  }

  if (Array.isArray(limits.model_scoped)) {
    for (const [index, candidate] of limits.model_scoped.entries()) {
      if (!isRecord(candidate)) continue
      const label = typeof candidate.display_name === 'string' ? candidate.display_name.trim() : ''
      append(claudeWindow(`weekly-model-${safeId(label || String(index + 1))}`, 'weekly-model', candidate, label))
    }
  }

  return windows
}

interface CodexUsageManager {
  getRateLimits(force?: boolean): Promise<CodexAccountRateLimits | null>
}

interface ClaudeUsageManager {
  getUsage(force?: boolean): Promise<SDKControlGetUsageResponse>
}

export interface SubscriptionUsageDependencies {
  getCodexManager: (accountId: string | null) => CodexUsageManager
  getClaudeManager: (accountId: string | null) => ClaudeUsageManager
  now: () => number
}

const DEFAULT_DEPENDENCIES: SubscriptionUsageDependencies = {
  getCodexManager: getCodexSubscriptionManager,
  getClaudeManager: getClaudeSubscriptionManager,
  now: Date.now,
}

export interface ReadSubscriptionUsageInput {
  providerKind: ChatSubscriptionProviderKind
  accountId?: string | null
  force?: boolean
}

function unsupported(
  providerKind: ChatSubscriptionProviderKind,
  accountId: string | null,
  reason: 'provider' | 'excluded' | 'unavailable'
): ChatSubscriptionUsage {
  return { state: 'unsupported', providerKind, accountId, reason }
}

function publicUsageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|sess-|oauth-)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|id_token|token|code)=)[^&\s]+/gi, '$1[REDACTED]')
}

/** Single IPC adapter; each failure stays confined to the card/account that initiated the read. */
export async function readSubscriptionUsage(
  input: ReadSubscriptionUsageInput,
  dependencies: SubscriptionUsageDependencies = DEFAULT_DEPENDENCIES
): Promise<ChatSubscriptionUsage> {
  const accountId = input.accountId ?? null
  const force = input.force === true
  try {
    if (input.providerKind === 'codex-subscription') {
      const limits = await dependencies.getCodexManager(accountId).getRateLimits(force)
      if (!limits) return unsupported(input.providerKind, accountId, 'unavailable')
      return {
        state: 'ready',
        providerKind: input.providerKind,
        accountId,
        fetchedAt: dependencies.now(),
        windows: normalizeCodexSubscriptionUsage(limits),
      }
    }

    if (input.providerKind === 'claude-subscription') {
      const usage = await dependencies.getClaudeManager(accountId).getUsage(force)
      if (usage.rate_limits_available === false) return unsupported(input.providerKind, accountId, 'unavailable')
      return {
        state: 'ready',
        providerKind: input.providerKind,
        accountId,
        fetchedAt: dependencies.now(),
        windows: normalizeClaudeSubscriptionUsage(usage),
      }
    }

    return unsupported(input.providerKind, accountId, 'provider')
  } catch (error) {
    return {
      state: 'error',
      providerKind: input.providerKind,
      accountId,
      error: publicUsageError(error),
    }
  }
}
