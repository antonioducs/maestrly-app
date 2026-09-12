import {
  estimatedCostOfUsage,
  totalTokensOf,
  type ChatModelMeta,
  type SubagentRunMeta,
  type SubagentSessionSummary,
} from '../../shared/chat'
import type { SubagentExecutionSnapshotV1, SubagentProfileDiagnostic } from '../../shared/subagent-profiles'

const EFFORT_LABEL_KEYS: Record<string, string> = {
  off: 'effortOff',
  none: 'effortNone',
  minimal: 'effortMinimal',
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXhigh',
  max: 'effortMax',
  ultra: 'effortUltra',
}

export function subagentEffortLabel(effort: string, translate?: (key: string) => string): string {
  const key = EFFORT_LABEL_KEYS[effort]
  return key && translate ? translate(`subagentProfiles.${key}`) : effort
}

export interface SubagentRunDisplay {
  profile: SubagentExecutionSnapshotV1 | null
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  totalTokens: number
  runtimeEstimatedCostUsd: number | null
  startedAt: number | null
  durationMs: number | null
}

function validTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export type SubagentRunSessionSource = Pick<
  SubagentSessionSummary,
  'usage' | 'runtimeEstimatedCostUsd' | 'durationMs' | 'startedAt' | 'profile'
>

function validCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * `session` is the persisted observable session. Maestro `delegate` returns before the worker finishes, so the
 * tool-part snapshot (`meta`) never receives the final usage — the session is the source of truth when present.
 */
export function subagentRunDisplay(
  meta: SubagentRunMeta | undefined,
  session?: SubagentRunSessionSource | null
): SubagentRunDisplay {
  const usage = session?.usage ?? meta?.usage
  const input = usage?.input ?? Math.max(0, meta?.inputTokens ?? 0)
  const output = usage?.output ?? Math.max(0, meta?.outputTokens ?? 0)
  const cacheRead = usage?.cacheRead ?? 0
  const cacheCreate = usage?.cacheCreate ?? 0
  return {
    profile: meta?.profile ?? session?.profile ?? null,
    input,
    output,
    cacheRead,
    cacheCreate,
    totalTokens: totalTokensOf({ input, output, cacheRead, cacheCreate }),
    runtimeEstimatedCostUsd: validCost(session?.runtimeEstimatedCostUsd) ?? validCost(meta?.runtimeEstimatedCostUsd),
    // `routedAt` keeps already-persisted Maestro runs correct after this field was introduced.
    startedAt:
      validTimestamp(session?.startedAt) ?? validTimestamp(meta?.startedAt) ?? validTimestamp(meta?.maestro?.routedAt),
    durationMs:
      typeof session?.durationMs === 'number'
        ? session.durationMs
        : typeof meta?.durationMs === 'number'
          ? meta.durationMs
          : null,
  }
}

export function subagentRunCost(
  display: Pick<SubagentRunDisplay, 'input' | 'output' | 'cacheRead' | 'cacheCreate' | 'runtimeEstimatedCostUsd'>,
  metadata: ChatModelMeta | null
): number | null {
  return estimatedCostOfUsage(display, metadata, display.runtimeEstimatedCostUsd)
}

export function subagentCompactProfileLabel(
  profile: SubagentExecutionSnapshotV1 | null,
  effortLabel: (effort: string) => string = (effort) => effort
): string | null {
  const effective = profile?.effective
  return effective
    ? `${effective.modelId} · ${effortLabel(effective.sentEffort ?? 'off')}${effective.fastMode === true ? ' · ⚡ Fast' : ''}`
    : null
}

export function subagentProfileLabel(
  profile: SubagentExecutionSnapshotV1 | null,
  effortLabel: (effort: string) => string = (effort) => effort
): string | null {
  const effective = profile?.effective
  if (!effective) return null
  const configured = effortLabel(effective.configuredEffort)
  const sent = effective.sentEffort == null ? effortLabel('off') : effortLabel(effective.sentEffort)

  const effort =
    effective.sentEffort == null
      ? effective.configuredEffort === 'off'
        ? configured
        : `${configured} → ${sent}`
      : effective.sentEffort === effective.configuredEffort
        ? sent
        : `${configured} → ${sent}`
  return `${effective.providerId} · ${effective.modelId} · ${effort}${effective.fastMode === true ? ' · ⚡ Fast' : ''}`
}

export function subagentProfileDiagnostics(profile: SubagentExecutionSnapshotV1 | null): SubagentProfileDiagnostic[] {
  if (!profile) return []
  const diagnostics = Array.isArray(profile.diagnostics) ? profile.diagnostics : []
  const attempts = Array.isArray(profile.attempts) ? profile.attempts : []
  return [
    ...diagnostics,
    ...attempts.flatMap((attempt) => (Array.isArray(attempt.diagnostics) ? attempt.diagnostics : [])),
  ]
}
