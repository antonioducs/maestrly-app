import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ChatSubscriptionUsageWindow } from '../../../shared/chat'

/** Subscription tier the ACP server reports in `_meta.antigravity.tier` (runtime 1.4.0 and later). */
export interface AntigravityTier {
  name: string
  id: string
}

/** Slash command the ACP server answers itself, without a model turn, with token usage and quota limits. */
export const ANTIGRAVITY_USAGE_COMMAND = 'usage'

const ACCOUNT_INFO_FILE = 'maestrly-account.json'
const WEEK_MINS = 7 * 24 * 60
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function parseAntigravityTier(meta: unknown): AntigravityTier | null {
  const tier = isRecord(meta) && isRecord(meta.antigravity) ? meta.antigravity.tier : undefined
  if (!isRecord(tier)) return null
  const name = text(tier.name)
  const id = text(tier.id)
  return name || id ? { name, id } : null
}

export function sameAntigravityTier(a: AntigravityTier | null, b: AntigravityTier | null): boolean {
  return a?.name === b?.name && a?.id === b?.id
}

/** Non-secret facts about the signed-in account, kept beside its private home so the card needs no running server. */
export function readAntigravityAccountTier(root: string): AntigravityTier | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, ACCOUNT_INFO_FILE), 'utf8')) as unknown
    return isRecord(parsed) ? parseAntigravityTier({ antigravity: { tier: parsed.tier } }) : null
  } catch {
    return null
  }
}

export async function writeAntigravityAccountTier(root: string, tier: AntigravityTier | null): Promise<void> {
  const target = path.join(root, ACCOUNT_INFO_FILE)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ tier }), { mode: 0o600 })
  await rename(temporary, target)
}

function resetTimestamp(raw: string | undefined): number | null {
  const value = raw?.trim()
  if (!value) return null
  // The server formats ISO-8601 reset times as `Oct 02, 2026, 08:22 UTC` and passes anything else through unchanged.
  const formatted = /^([A-Za-z]{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) UTC$/.exec(value)
  if (formatted) {
    const month = MONTHS.indexOf(formatted[1].toLowerCase())
    if (month < 0) return null
    return Date.UTC(Number(formatted[3]), month, Number(formatted[2]), Number(formatted[4]), Number(formatted[5]))
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null
  const parsed = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`)
  return Number.isFinite(parsed) ? parsed : null
}

function safeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'window'
  )
}

/**
 * Quota windows from the Markdown report of `/usage`: a `### Quota Limits` section listing model groups
 * (`- **Gemini Models**`) and their buckets (`  - **Weekly Limit Remaining:** 91% remaining (resets ...)`).
 * Buckets reported as absolute units, disabled, or in an unknown shape are skipped. `error` carries the reason
 * the server gave when it could not read the quota.
 */
export function parseAntigravityUsageReport(report: string): {
  windows: ChatSubscriptionUsageWindow[]
  error: string | null
} {
  const windows: ChatSubscriptionUsageWindow[] = []
  const seen = new Set<string>()
  let error: string | null = null
  let inLimits = false
  let group = ''
  for (const line of report.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) {
      inLimits = /^#{1,6}\s+quota limits\s*$/i.test(line)
      group = ''
      continue
    }
    if (!inLimits) continue
    const failure = /^- Unable to retrieve quota status \((.*)\)\s*$/i.exec(line)
    if (failure) {
      error = `Google AI could not read the quota: ${failure[1].trim().slice(0, 200) || 'unknown error'}`
      continue
    }
    const groupMatch = /^- \*\*(.+?)\*\*\s*$/.exec(line)
    if (groupMatch) {
      group = groupMatch[1].trim()
      continue
    }
    const bucket = /^\s+- \*\*(.+?):\*\*\s+(\d+(?:\.\d+)?)% remaining(?:\s+\(resets (.+)\))?\s*$/i.exec(line)
    if (!bucket) continue
    const remaining = Number(bucket[2])
    if (!Number.isFinite(remaining)) continue
    const bucketName = bucket[1].replace(/\s+remaining$/i, '').trim()
    const weekly = /\bweekly\b/i.test(bucketName)
    const id = safeId(`${group}-${bucketName}`)
    if (seen.has(id)) continue
    seen.add(id)
    windows.push({
      id,
      kind: weekly ? 'weekly-model' : 'other',
      usedPercent: Math.min(100, Math.max(0, 100 - remaining)),
      resetsAt: resetTimestamp(bucket[3]),
      durationMins: weekly ? WEEK_MINS : null,
      label: weekly ? group || bucketName : [group, bucketName].filter(Boolean).join(' · '),
    })
  }
  return { windows, error: windows.length ? null : error }
}
