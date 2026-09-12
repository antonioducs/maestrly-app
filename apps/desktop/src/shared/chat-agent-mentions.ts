import { normalizeSubagentProfileKey } from './subagent-profiles'
import type { MessagePart } from './chat'

export interface AgentMentionMatch {
  /** Raw matched text including '#' (e.g. '#testing'). */
  raw: string

  name: string

  index: number
}

export interface StructuredAgentMentionDraft {
  id: string

  name: string

  start: number

  end: number
}

const AGENT_MENTION_RE = /(?<![\w#])#([A-Za-z][\w-]*)/g

export function findAgentMentions(text: string, availableNames?: readonly string[]): AgentMentionMatch[] {
  if (typeof text !== 'string' || !text.includes('#')) return []
  const allowed = availableNames
    ? new Set(availableNames.map((name) => normalizeSubagentProfileKey(name)).filter(Boolean))
    : null
  const out: AgentMentionMatch[] = []
  for (const m of text.matchAll(AGENT_MENTION_RE)) {
    const name = normalizeSubagentProfileKey(m[1])
    if (!name) continue
    if (allowed && !allowed.has(name)) continue
    out.push({ raw: m[0], name, index: m.index ?? 0 })
  }
  return out
}

export function filterAgentMentionNames(
  names: readonly unknown[] | undefined,
  availableNames?: readonly string[]
): string[] {
  if (!Array.isArray(names) || names.length === 0) return []
  const available = availableNames
    ? new Set(availableNames.map((name) => normalizeSubagentProfileKey(name)).filter(Boolean))
    : null
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    if (typeof raw !== 'string') continue
    const name = normalizeSubagentProfileKey(raw)
    if (!name || seen.has(name)) continue
    if (available && !available.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

export function extractAgentMentionNames(
  parts: readonly { type: string; name?: unknown }[] | undefined,
  availableNames?: readonly string[]
): string[] {
  if (!Array.isArray(parts) || parts.length === 0) return []
  const names: unknown[] = []
  for (const part of parts) {
    if (part?.type === 'agent-mention') names.push(part.name)
  }
  return filterAgentMentionNames(names, availableNames)
}

function isStructuredAgentMentionDraft(value: unknown): value is StructuredAgentMentionDraft {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.name === 'string' &&
    typeof candidate.start === 'number' &&
    Number.isFinite(candidate.start) &&
    Number.isInteger(candidate.start) &&
    typeof candidate.end === 'number' &&
    Number.isFinite(candidate.end) &&
    Number.isInteger(candidate.end)
  )
}

export function validateStructuredAgentMentions(
  mentions: readonly unknown[] | undefined,
  text: string,
  availableNames: readonly string[]
): StructuredAgentMentionDraft[] {
  if (!Array.isArray(mentions) || mentions.length === 0 || typeof text !== 'string') return []
  const available = new Set(availableNames.map((name) => normalizeSubagentProfileKey(name)).filter(Boolean))

  const sanitized = mentions.filter(isStructuredAgentMentionDraft)
  if (sanitized.length === 0) return []
  const out: StructuredAgentMentionDraft[] = []
  let lastEnd = 0
  for (const m of [...sanitized].sort((a, b) => a.start - b.start)) {
    const name = normalizeSubagentProfileKey(m.name)
    if (!name || !available.has(name)) continue
    if (m.start < 0 || m.end > text.length || m.end <= m.start) continue
    if (m.start < lastEnd) continue
    const slice = text.slice(m.start, m.end)
    if (!slice.startsWith('#') || normalizeSubagentProfileKey(slice.slice(1)) !== name) continue
    lastEnd = m.end
    out.push({ id: m.id, name, start: m.start, end: m.end })
  }
  return out
}

export function dedupeAgentMentionNames(mentions: readonly StructuredAgentMentionDraft[] | undefined): string[] {
  if (!Array.isArray(mentions)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of mentions) {
    if (!m || typeof m.name !== 'string') continue
    const name = normalizeSubagentProfileKey(m.name)
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

export function buildAgentMentionParts(
  mentions: readonly unknown[] | undefined,
  text: string,
  availableNames: readonly string[]
): Extract<MessagePart, { type: 'agent-mention' }>[] {
  if (!Array.isArray(mentions) || mentions.length === 0 || typeof text !== 'string') return []
  return validateStructuredAgentMentions(mentions, text, availableNames).map((m) => ({
    type: 'agent-mention',
    id: m.id,
    name: m.name,
    start: m.start,
    end: m.end,
  }))
}

export function shouldReloadOnUserSaved(args: {
  streaming: boolean
  compacted?: boolean
  imagesDescribed?: number
  localSlash: boolean
  localAgentMentions: boolean

  localImages: boolean
}): boolean {
  return (
    !args.streaming ||
    args.compacted === true ||
    (args.imagesDescribed ?? 0) > 0 ||
    args.localSlash ||
    args.localAgentMentions ||
    args.localImages
  )
}
