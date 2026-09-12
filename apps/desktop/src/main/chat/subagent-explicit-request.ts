/**
 * Conservative detector for explicit subagent requests in user text.
 *
 * Quotes/backticks alone never count as delegation intent: a request requires
 * an operational signal — an imperative delegation verb or a first-person
 * desire phrase ("Quero utilizar o X") — in the SAME action segment as the
 * agent name. Negated segments are ignored (a negation in one coordinated
 * segment does not discard positive requests in others) and question
 * sentences are skipped. Prefer missing an ambiguous mention over blocking a
 * legitimate free choice.
 */
import { normalizeSubagentProfileKey } from '../../shared/subagent-profiles'

export interface ExplicitSubagentRequest {
  agentNames: string[]
}

/** Delegation verbs signaling a request in the same clause as the name. */
const VERB_SRC =
  'use|usa|usar|utilize|utiliza|utilizar|chame|chama|chamar|delegue|delega|delegar|delegate|call|invoke|run|rode|roda|rodar'

/** First-person desires/plans turning infinitives into requests ("Quero utilizar o X"). */
const FIRST_PERSON_AUX = /\b(?:quero|queremos|queria|preciso|precisamos|gostaria|gostaríamos|vou|vamos)\b/i

/** Markers that may precede an imperative verb at clause start. */
const LEADING_MARKERS =
  /^(?:(?:por favor|please)\s*,?\s*|(?:primeiro|primeiramente|então|entao|depois|agora|antes\b[^,;]*?|first|then|next|now)\s*,?\s*)$/i

/** Negation terms — applied per action segment, not entire clause. */
const NEGATION_SRC =
  "não|nao|nunca|jamais|don'?t|do\\s+not|never|avoid|without|sem|em\\s+vez\\s+de|instead\\s+of|rather\\s+than"

/** Negation invalidates the entire action segment (conservative). */
const NEGATION = new RegExp(`\\b(?:${NEGATION_SRC})\\b`, 'i')

/**
 * Recognizable start of a new delegation action after a coordinating
 * conjunction: [optional negation] + verb from VERB_SRC.
 */
const DELEGATION_ACTION_START = new RegExp(
  `^\\s*(?:(?:${NEGATION_SRC})\\s+)?(?:${VERB_SRC})\\b`,
  'i'
)

/** Conjunctions that may coordinate a new delegation action. */
const ACTION_COORDINATOR = /\b(?:e|and|mas|but)\b/gi

/** Names colliding with common words count only with an adjacent verb. */
const AMBIGUOUS_NAMES = new Set(['explore', 'general-purpose'])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function catalogIndex(availableAgentNames: readonly string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const name of availableAgentNames) {
    const key = normalizeSubagentProfileKey(name)
    if (key) map.set(key, name)
  }
  return map
}

function resolveAvailable(raw: string, available: Map<string, string>): string | null {
  const key = normalizeSubagentProfileKey(raw)
  return key ? available.get(key) ?? null : null
}

/** Removes fenced code blocks and long code spans (preserves short backtick-quoted names). */
function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, (match) => {
      const inner = match.slice(1, -1).trim()
      return /^[A-Za-z0-9_./:-]+$/.test(inner) && inner.length <= 80 ? match : ' '
    })
}

/**
 * A clause is a request only if a delegation verb appears:
 * - At the start (after courtesy/ordering markers), or
 * - Immediately after a first-person desire ("Quero utilizar o X").
 * "O X usa o Y" (subject before verb) never counts as a request.
 */
function hasRequestVerb(clause: string): boolean {
  const verbRe = new RegExp(`\\b(?:${VERB_SRC})\\b`, 'gi')
  for (const match of clause.matchAll(verbRe)) {
    let prefix = clause.slice(0, match.index).trim()
    if (!prefix) return true
    // Coordinated segments retain the initial conjunction ("e use ...") —
    // it is not a subject, so it does not prevent request detection.
    prefix = prefix.replace(/^(?:e|and|mas|but)\b\s*/i, '')
    if (!prefix) return true
    if (LEADING_MARKERS.test(prefix)) return true
    if (FIRST_PERSON_AUX.test(prefix.slice(-48))) return true
  }
  return false
}

/**
 * Splits a clause into coordinated action segments only when a
 * conjunction (e/and/mas/but) introduces a recognizable new delegation action
 * (`DELEGATION_ACTION_START`). Generic splitting on "e"/"and" would break
 * descriptions and ordinary text; return the entire clause when no
 * action coordination exists.
 */
function splitCoordinatedSegments(clause: string): string[] {
  const segments: string[] = []
  let cursor = 0
  for (const match of clause.matchAll(ACTION_COORDINATOR)) {
    if (match.index <= cursor) continue
    const after = clause.slice(match.index + match[0].length)
    if (!DELEGATION_ACTION_START.test(after)) continue
    const head = clause.slice(cursor, match.index).trim()
    if (!head) continue
    segments.push(head)
    cursor = match.index
  }
  const tail = clause.slice(cursor).trim()
  if (tail) segments.push(tail)
  return segments
}

function collectMentions(clause: string, available: Map<string, string>): string[] {
  const found = new Set<string>()
  // Quoted mentions (backticks/quotes): strong marker, but still require a clause verb.
  for (const re of [/`([A-Za-z0-9_./:-]+)`/g, /"([A-Za-z0-9_./:-]+)"/g, /'([A-Za-z0-9_./:-]+)'/g]) {
    for (const match of clause.matchAll(re)) {
      const name = resolveAvailable(match[1], available)
      if (name) found.add(name)
    }
  }
  // Bare mentions: distinctive names require a clause verb; ambiguous names
  // (explore, general-purpose) require the verb immediately before them.
  for (const [key, original] of available) {
    if (AMBIGUOUS_NAMES.has(key)) {
      const adjacent = new RegExp(
        `\\b(?:${VERB_SRC})\\b\\s+(?:(?:o|a|the|to|para)\\s+)?${escapeRegExp(key)}(?![A-Za-z0-9_-])`,
        'i'
      )
      if (adjacent.test(clause)) found.add(original)
    } else {
      const token = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(key)}(?![A-Za-z0-9_-])`, 'i')
      if (token.test(clause)) found.add(original)
    }
  }
  return [...found]
}

/**
 * Detects explicit subagent requests in user text.
 * Returns only names in the current catalog (canonical spelling).
 */
export function detectExplicitSubagentRequests(
  userText: string,
  availableAgentNames: readonly string[]
): ExplicitSubagentRequest {
  if (!userText.trim() || !availableAgentNames.length) return { agentNames: [] }
  const available = catalogIndex(availableAgentNames)
  const text = stripCodeBlocks(userText)
  const found = new Set<string>()
  // Preserve sentence terminators: splitting removed '?' and defeated question
  // checks — now discard questions before analysis.
  for (const match of text.matchAll(/([^.!?\n]+)([.!?]?)/g)) {
    const sentence = match[1].trim()
    const terminator = match[2]

    if (!sentence || terminator === '?') continue
    for (const rawClause of sentence.split(/[,;]/)) {
      const clause = rawClause.trim()
      if (!clause) continue
      // Evaluate negation per action segment: "Do not use X and use Y." retains Y.
      for (const segment of splitCoordinatedSegments(clause)) {
        if (!segment || NEGATION.test(segment)) continue
        if (!hasRequestVerb(segment)) continue
        for (const name of collectMentions(segment, available)) found.add(name)
      }
    }
  }
  return { agentNames: [...found] }
}
