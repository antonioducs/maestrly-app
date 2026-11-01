import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  inverseDocumentFrequency,
  normalizeForSearch,
  queryStems,
  searchTokens,
  stemToken,
} from '../../memory/relevance'
import { getDb } from '../../store'
import { searchConversationHistory } from '../chat-store'
import { parseParts } from '../message'
import { conversationToken, extractHistoryDocument, historyEligible, historyVisibleText } from './extract'
import { historyIndexUnsupported, prepareHistoryConversations, withHistoryIndex } from './store'

export type HistorySearchMode = 'relevance' | 'exact'

export interface HistorySearchHit {
  messageId: string
  conversationId: string
  seq: number
  role: 'user' | 'assistant'
  createdAt: number
  snippet: string
  /** Relevance mode only: 0–1, higher is better. */
  score?: number
  kind?: 'compaction'
}

export interface HistorySearchResult {
  mode: HistorySearchMode
  hits: HistorySearchHit[]
  /** Some messages in scope are not indexed yet: results may be incomplete (or come from a plain scan). */
  building?: boolean
}

/** Relevance of candidates by meaning; returns a 0–1 score per candidate key, or nothing within its budget. */
export type HistoryReranker = (
  query: string,
  candidates: ReadonlyArray<{ key: number; text: string }>
) => Promise<ReadonlyMap<number, number>>

export interface HistorySearchOptions {
  /** Conversations in scope; the first is the caller's. */
  conversationIds: readonly string[]
  query: string
  mode?: HistorySearchMode
  limit?: number
  /** Only messages before this position of the (single) conversation; pages exact results. */
  beforeSeq?: number
  rerank?: HistoryReranker
}

export const HISTORY_SEARCH = {
  defaultLimit: 8,
  maxLimit: 30,
  snippetChars: 240,
  prepareBudgetMs: 250,
  wordCandidates: 80,
  trigramCandidates: 100,
  maxTerms: 12,
  perConversation: 3,
  relativeFloor: 0.35,
  recencyHalfLifeDays: 30,
  weights: { relevance: 0.65, bm25: 0.2, recency: 0.15 },
  toolOnlyCredit: 0.6,
  unknownPenalty: 0.25,
  semanticSummaries: 10,
  semanticWindowChars: 512,
  /** A candidate that shares no word with the query needs at least this semantic relevance (as memory search). */
  semanticFloor: 0.34,
} as const

const S = 'history_index'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

type TermKind = 'stem' | 'cjk' | 'literal' | 'infix'
interface Term {
  kind: TermKind
  /** Normalized text the term stands for. */
  value: string
  /** The query word a stem came from, for a substring retry when no word starts with it. */
  word?: string
  df: number
}

/** Quoted phrases stay literal; CJK runs become bigram phrases; other words become stems. */
export function parseHistoryQuery(query: string): Term[] {
  const terms: Term[] = []
  const add = (term: Omit<Term, 'df'>) => {
    if (terms.length >= HISTORY_SEARCH.maxTerms) return
    if (!terms.some((other) => other.kind === term.kind && other.value === term.value)) terms.push({ ...term, df: 0 })
  }
  const rest = query.replace(/"([^"]*)"/g, (_, phrase: string) => {
    const value = normalizeForSearch(phrase).replace(/\s+/g, ' ').trim()
    if (value.length >= 2) add({ kind: 'literal', value })
    return ' '
  })
  const normalized = normalizeForSearch(rest)
  for (const [run] of normalized.matchAll(CJK_RUN)) add({ kind: 'cjk', value: run })
  const latin = normalized.replace(CJK_RUN, ' ')
  const words = searchTokens(latin)
  const stems = queryStems(latin)
  if (stems.length) {
    for (const stem of stems) add({ kind: 'stem', value: stem, word: words.find((word) => stemToken(word) === stem) })
  } else {
    // Short words only ("ui", "pr"): still searchable, as whole-word prefixes.
    for (const word of words) if (word.length >= 2) add({ kind: 'stem', value: word, word })
  }
  return terms
}

function cjkExpression(run: string): string {
  const chars = [...run]
  if (chars.length === 1) return `${quote(run)}*`
  return quote(
    chars
      .slice(0, -1)
      .map((char, index) => char + chars[index + 1])
      .join(' ')
  )
}

function termExpression(term: Term): { column: 'text' | 'cjk'; expression: string } | null {
  if (term.kind === 'stem') return { column: 'text', expression: `${quote(term.value)}*` }
  if (term.kind === 'literal') return { column: 'text', expression: quote(term.value) }
  if (term.kind === 'cjk') return { column: 'cjk', expression: cjkExpression(term.value) }
  return null
}

function wordsMatch(tokens: readonly string[], terms: readonly Term[]): string | null {
  const text: string[] = []
  const cjk: string[] = []
  for (const term of terms) {
    const expression = termExpression(term)
    if (expression) (expression.column === 'cjk' ? cjk : text).push(expression.expression)
  }
  const branches = [
    ...(text.length ? [`({body tools} : (${text.join(' OR ')}))`] : []),
    ...(cjk.length ? [`(cjk : (${cjk.join(' OR ')}))`] : []),
  ]
  if (!branches.length) return null
  return `conv : (${tokens.map(quote).join(' OR ')}) AND (${branches.join(' OR ')})`
}

const marks = (values: readonly unknown[]) => values.map(() => '?').join(',')
const codePoints = (value: string) => [...value].length

/**
 * A substring as the trigram index can match it: the AND of its distinct trigrams. The index keeps no positions, so
 * this is a superset (the trigrams may be apart); every caller checks candidates against the text.
 */
export function trigramQuery(value: string): string {
  const chars = [...value]
  if (chars.length <= 3) return quote(value)
  const grams = new Set<string>()
  for (let index = 0; index + 3 <= chars.length; index++) grams.add(chars.slice(index, index + 3).join(''))
  return [...grams].map(quote).join(' AND ')
}

function trigramCount(db: DatabaseSync, value: string, conversationIds: readonly string[]): number {
  return Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${S}.history_trigram JOIN ${S}.history_docs d ON d.doc_id = history_trigram.rowid
           WHERE history_trigram MATCH ? AND d.conversation_id IN (${marks(conversationIds)})`
        )
        .get(trigramQuery(value), ...conversationIds) as { n: number }
    ).n
  )
}

/** Document frequency of each term in scope; a stem no word starts with retries as a substring of its word. */
function countTerms(db: DatabaseSync, terms: Term[], conversationIds: readonly string[], tokens: readonly string[]) {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM ${S}.history_words WHERE history_words MATCH ?`)
  for (const term of terms) {
    const match = wordsMatch(tokens, [term])
    term.df = match ? Number((count.get(match) as { n: number }).n) : 0
    if (term.df > 0) continue
    const substring = term.kind === 'stem' ? term.word : term.kind === 'literal' ? term.value : undefined
    if (!substring || codePoints(substring) < 3) continue
    const df = trigramCount(db, substring, conversationIds)
    if (df > 0) Object.assign(term, { kind: 'infix' as const, value: substring, df })
  }
}

interface CandidateRow {
  doc_id: number
  id: string
  conversation_id: string
  role: string
  seq: number
  created_at: number
  parts_json: string | null
  meta_json: string | null
}

function loadCandidates(db: DatabaseSync, docIds: readonly number[]): CandidateRow[] {
  if (!docIds.length) return []
  return db
    .prepare(
      `SELECT d.doc_id, m.id, m.conversation_id, m.role, m.seq, m.created_at, m.parts_json, m.meta_json
       FROM ${S}.history_docs d JOIN main.chat_messages m ON m.id = d.message_id
       WHERE d.doc_id IN (${marks(docIds)}) AND d.indexed = 1`
    )
    .all(...docIds) as unknown as CandidateRow[]
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Position of a term in normalized text: a stem at a word start, anything else as a substring. */
function termPosition(normalized: string, term: Pick<Term, 'kind' | 'value'>): number {
  if (term.kind !== 'stem') return normalized.indexOf(term.value)
  const match = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term.value)}`, 'u').exec(normalized)
  return match ? match.index + (match[0].length - term.value.length) : -1
}

/** Where normalized position `at` falls in the original text (normalization can change lengths, as for Hangul). */
function rawPosition(raw: string, normalized: string, at: number): number {
  if (normalized.length === raw.length) return at
  let used = 0
  let index = 0
  for (const char of raw) {
    used += normalizeForSearch(char).length
    if (used > at) return index
    index += char.length
  }
  return raw.length
}

function snippetAround(raw: string, at: number, chars: number = HISTORY_SEARCH.snippetChars, lead = 60): string {
  const start = Math.max(0, at - lead)
  const flat = raw
    .slice(start, start + chars + lead)
    .replace(/\s+/g, ' ')
    .trim()
  return `${start > 0 ? '…' : ''}${flat}`.slice(0, chars)
}

/** The visible text (or else the tool text) around the first matched term. */
function snippetFor(
  bodyRaw: string,
  toolsRaw: string,
  terms: readonly Pick<Term, 'kind' | 'value'>[],
  chars: number = HISTORY_SEARCH.snippetChars,
  lead = 60
): string {
  for (const raw of [bodyRaw, toolsRaw]) {
    if (!raw) continue
    const normalized = normalizeForSearch(raw)
    const positions = terms.map((term) => termPosition(normalized, term)).filter((at) => at >= 0)
    if (positions.length) return snippetAround(raw, rawPosition(raw, normalized, Math.min(...positions)), chars, lead)
  }
  return snippetAround(bodyRaw || toolsRaw, 0, chars, lead)
}

const role = (value: string): 'user' | 'assistant' => (value === 'assistant' ? 'assistant' : 'user')

interface Scored {
  row: CandidateRow
  hit: HistorySearchHit
  relevance: number
  lexical: number
  /** No query word matched: kept only if meaning alone is close enough. */
  semanticOnly: boolean
  bm25: number
  /** Text around the match, for the semantic reranker. */
  window: string
  fingerprint: string
}

/** IDF-weighted share of the query terms a message covers (body counts fully, tool text partially). */
function coverage(terms: readonly Term[], total: number, body: string, tools: string) {
  const bodyTokens = searchTokens(body)
  const toolTokens = searchTokens(tools)
  const bodyWords = bodyTokens.join(' ')
  const toolWords = toolTokens.join(' ')
  let known = 0
  let found = 0
  let unknown = 0
  const matched: Term[] = []
  const hits = (text: string, tokens: string[], words: string, term: Term) =>
    term.kind === 'stem'
      ? tokens.some((token) => token.startsWith(term.value))
      : text.includes(term.value) || (term.kind === 'literal' && words.includes(searchTokens(term.value).join(' ')))
  for (const term of terms) {
    const inBody = hits(body, bodyTokens, bodyWords, term)
    const credit = inBody ? 1 : hits(tools, toolTokens, toolWords, term) ? HISTORY_SEARCH.toolOnlyCredit : 0
    if (term.df === 0 && credit === 0) {
      unknown += 1
      continue
    }
    const weight = inverseDocumentFrequency(total, Math.max(term.df, 1))
    known += weight
    found += weight * credit
    if (credit > 0) matched.push(term)
  }
  if (!known) return { value: 0, matched }
  return { value: (found / known) * (1 - HISTORY_SEARCH.unknownPenalty * (unknown / terms.length)), matched }
}

function recency(createdAt: number, now: number): number {
  const days = Math.max(0, now - createdAt) / 86_400_000
  return 0.5 ** (days / HISTORY_SEARCH.recencyHalfLifeDays)
}

/** The same text said twice (a resent prompt, a repeated plan) and next-door hits collapse to one. */
function dedupe(scored: Scored[], limit: number, perConversation: number): Scored[] {
  const newestByText = new Map<string, Scored>()
  for (const item of scored) {
    const current = newestByText.get(item.fingerprint)
    if (!current) newestByText.set(item.fingerprint, item)
    else {
      const newer =
        (item.row.created_at - current.row.created_at || item.row.seq - current.row.seq) > 0 ? item : current
      const score = Math.max(item.hit.score ?? 0, current.hit.score ?? 0)
      newestByText.set(item.fingerprint, { ...newer, hit: { ...newer.hit, score } })
    }
  }
  const ranked = [...newestByText.values()].sort(
    (a, b) => (b.hit.score ?? 0) - (a.hit.score ?? 0) || b.row.created_at - a.row.created_at || b.row.seq - a.row.seq
  )
  const kept: Scored[] = []
  const counts = new Map<string, number>()
  for (const item of ranked) {
    if (kept.length >= limit) break
    const conversation = item.row.conversation_id
    if ((counts.get(conversation) ?? 0) >= perConversation) continue
    // history_read already shows the neighbours.
    if (kept.some((other) => other.row.conversation_id === conversation && Math.abs(other.row.seq - item.row.seq) <= 1))
      continue
    kept.push(item)
    counts.set(conversation, (counts.get(conversation) ?? 0) + 1)
  }
  return kept
}

/** Lexical candidates with their coverage and bm25 share; every database read of a relevance search happens here. */
function relevanceCandidates(db: DatabaseSync, options: HistorySearchOptions): Scored[] {
  const terms = parseHistoryQuery(options.query)
  if (!terms.length) return []
  const conversationIds = options.conversationIds
  const tokens = conversationIds.map(conversationToken)
  const total = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${S}.history_docs WHERE indexed = 1 AND conversation_id IN (${marks(conversationIds)})`
        )
        .get(...conversationIds) as { n: number }
    ).n
  )
  if (!total) return []
  countTerms(db, terms, conversationIds, tokens)

  const bm25 = new Map<number, number>()
  const match = wordsMatch(tokens, terms)
  if (match) {
    const rows = db
      .prepare(
        `SELECT rowid, bm25(history_words, 1.0, 0.35, 0.8, 0.0) AS score FROM ${S}.history_words
         WHERE history_words MATCH ? ORDER BY score LIMIT ${HISTORY_SEARCH.wordCandidates}`
      )
      .all(match) as Array<{ rowid: number; score: number }>
    // bm25() is negative, better matches lower: the best candidate gets 1.
    const best = Math.min(...rows.map((row) => row.score), -Number.EPSILON)
    for (const row of rows) bm25.set(Number(row.rowid), Math.max(0, Math.min(1, row.score / best)))
  }
  const substrings = terms.filter(
    (term) => term.kind === 'infix' || (term.kind === 'literal' && codePoints(term.value) >= 3)
  )
  const docIds = new Set(bm25.keys())
  if (substrings.length) {
    const rows = db
      .prepare(
        `SELECT history_trigram.rowid AS rowid FROM ${S}.history_trigram
         JOIN ${S}.history_docs d ON d.doc_id = history_trigram.rowid
         WHERE history_trigram MATCH ? AND d.conversation_id IN (${marks(conversationIds)})
         ORDER BY history_trigram.rowid DESC LIMIT ${HISTORY_SEARCH.trigramCandidates}`
      )
      .all(substrings.map((term) => `(${trigramQuery(term.value)})`).join(' OR '), ...conversationIds) as Array<{
      rowid: number
    }>
    for (const row of rows) docIds.add(Number(row.rowid))
  }

  // Compaction summaries say in other words what earlier turns did: worth a semantic look even without a shared word.
  const summaries = options.rerank
    ? (
        db
          .prepare(
            `SELECT d.doc_id FROM main.chat_messages m JOIN ${S}.history_docs d ON d.message_id = m.id
             WHERE m.conversation_id IN (${marks(conversationIds)}) AND d.indexed = 1
               AND m.parts_json LIKE '%"type":"compaction"%'
             ORDER BY m.created_at DESC LIMIT ${HISTORY_SEARCH.semanticSummaries}`
          )
          .all(...conversationIds) as Array<{ doc_id: number }>
      ).map((row) => Number(row.doc_id))
    : []
  for (const docId of summaries) docIds.add(docId)

  const scope = new Set(conversationIds)
  const before = conversationIds.length === 1 ? (options.beforeSeq ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
  const scored: Scored[] = []
  for (const row of loadCandidates(db, [...docIds])) {
    if (!scope.has(row.conversation_id) || Number(row.seq) >= before) continue
    const document = extractHistoryDocument(row.parts_json, row.meta_json)
    if (!document.eligible) continue
    const cover = coverage(terms, total, document.body, document.tools)
    const semanticOnly = !cover.matched.length
    if (semanticOnly && !summaries.includes(row.doc_id)) continue
    scored.push({
      row,
      relevance: cover.value,
      lexical: cover.value,
      semanticOnly,
      bm25: bm25.get(row.doc_id) ?? 0,
      window: snippetFor(document.bodyRaw, document.toolsRaw, cover.matched, HISTORY_SEARCH.semanticWindowChars, 128),
      fingerprint: createHash('sha1')
        .update(document.body.slice(0, 4_000))
        .update(document.tools.slice(0, 1_000))
        .digest('hex'),
      hit: {
        messageId: row.id,
        conversationId: row.conversation_id,
        seq: Number(row.seq),
        role: role(row.role),
        createdAt: Number(row.created_at),
        snippet: snippetFor(document.bodyRaw, document.toolsRaw, cover.matched),
        ...(document.hasCompaction ? { kind: 'compaction' as const } : {}),
      },
    })
  }
  return scored
}

async function rankCandidates(
  scored: Scored[],
  options: HistorySearchOptions,
  limit: number
): Promise<HistorySearchHit[]> {
  const now = Date.now()
  if (options.rerank && scored.length) {
    // The reranker may look at only the first few: summaries without a shared word, then the best lexical matches.
    const ordered = [...scored].sort(
      (a, b) => Number(b.semanticOnly) - Number(a.semanticOnly) || b.lexical + 0.3 * b.bm25 - (a.lexical + 0.3 * a.bm25)
    )
    const semantic = await options.rerank(
      options.query,
      ordered.map((item) => ({ key: item.row.doc_id, text: item.window }))
    )
    for (const item of scored) item.relevance = Math.max(item.lexical, semantic.get(item.row.doc_id) ?? 0)
  }
  const kept = scored.filter((item) => !item.semanticOnly || item.relevance >= HISTORY_SEARCH.semanticFloor)
  const { weights } = HISTORY_SEARCH
  for (const item of kept) {
    const score =
      weights.relevance * item.relevance +
      weights.bm25 * item.bm25 +
      weights.recency * recency(item.row.created_at, now)
    item.hit.score = Math.round(score * 100) / 100
  }
  const top = Math.max(0, ...kept.map((item) => item.hit.score ?? 0))
  const floored = kept.filter((item) => (item.hit.score ?? 0) >= top * HISTORY_SEARCH.relativeFloor)
  const perConversation = options.conversationIds.length > 1 ? HISTORY_SEARCH.perConversation : Number.POSITIVE_INFINITY
  return dedupe(floored, limit, perConversation).map((item) => item.hit)
}

/** Every term (2+ characters) must appear in the visible text, as in the original history search; newest first. */
function exactTerms(query: string): string[] {
  return [
    ...new Set(
      normalizeForSearch(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length >= 2)
    ),
  ].slice(0, 8)
}

function exactSearch(db: DatabaseSync, options: HistorySearchOptions, limit: number): HistorySearchHit[] | null {
  const terms = exactTerms(options.query)
  if (!terms.length) return []
  const long = terms.filter((term) => codePoints(term) >= 3)
  // Trigrams cannot prefilter two-character words: the scan does it.
  if (!long.length) return null
  const ids = options.conversationIds
  const before = ids.length === 1 ? (options.beforeSeq ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
  const order = ids.length === 1 ? 'seq DESC' : 'created_at DESC, seq DESC'
  const candidates = db
    .prepare(
      `SELECT id, seq, created_at FROM (
         SELECT m.id, m.seq, m.created_at FROM ${S}.history_trigram
         JOIN ${S}.history_docs d ON d.doc_id = history_trigram.rowid
         JOIN main.chat_messages m ON m.id = d.message_id
         WHERE history_trigram MATCH ? AND d.conversation_id IN (${marks(ids)}) AND m.seq < ?
         UNION
         SELECT m.id, m.seq, m.created_at FROM ${S}.history_docs d JOIN main.chat_messages m ON m.id = d.message_id
         WHERE d.partial = 1 AND d.indexed = 1 AND d.conversation_id IN (${marks(ids)}) AND m.seq < ?
       ) ORDER BY ${order}`
    )
    .iterate(long.map(trigramQuery).join(' AND '), ...ids, before, ...ids, before) as Iterable<{ id: string }>
  const read = db.prepare(
    'SELECT conversation_id, role, seq, created_at, parts_json, meta_json FROM main.chat_messages WHERE id = ?'
  )
  const hits: HistorySearchHit[] = []
  for (const candidate of candidates) {
    const row = read.get(candidate.id) as Omit<CandidateRow, 'doc_id' | 'id'> | undefined
    if (!row) continue
    const text = historyVisibleText(parseParts(row.parts_json ?? '[]'))
    if (!historyEligible(row.meta_json, text)) continue
    const normalized = normalizeForSearch(text)
    if (!terms.every((term) => normalized.includes(term))) continue
    hits.push({
      messageId: candidate.id,
      conversationId: row.conversation_id,
      seq: Number(row.seq),
      role: role(row.role),
      createdAt: Number(row.created_at),
      snippet: snippetAround(text, rawPosition(text, normalized, normalized.indexOf(terms[0]))),
    })
    if (hits.length >= limit) break
  }
  return hits
}

export const HISTORY_BROWSE = { snippetChars: 160, pageSize: 200, maxScanned: 5_000 } as const

/**
 * The conversation's outline, newest first: what the person asked and where compactions summarized earlier turns.
 * Needs no index; pages with `beforeSeq`.
 */
export function browseHistory(
  conversationId: string,
  options: { beforeSeq?: number; limit?: number } = {}
): HistorySearchHit[] {
  const limit = Math.max(1, Math.min(options.limit ?? HISTORY_SEARCH.defaultLimit, HISTORY_SEARCH.maxLimit))
  const page = getDb().prepare(
    `SELECT id, role, parts_json, meta_json, seq, created_at FROM chat_messages
     WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ${HISTORY_BROWSE.pageSize}`
  )
  const hits: HistorySearchHit[] = []
  let cursor = options.beforeSeq ?? Number.MAX_SAFE_INTEGER
  let scanned = 0
  while (hits.length < limit && scanned < HISTORY_BROWSE.maxScanned) {
    const rows = page.all(conversationId, cursor) as unknown as Array<Omit<CandidateRow, 'doc_id'>>
    if (!rows.length) break
    for (const row of rows) {
      scanned += 1
      cursor = Number(row.seq)
      const parts = parseParts(row.parts_json ?? '[]')
      const compaction = parts.find((part) => part.type === 'compaction')
      const text = compaction ? compaction.text : row.role === 'user' ? historyVisibleText(parts) : ''
      if (!text.trim() || !historyEligible(row.meta_json, historyVisibleText(parts))) continue
      hits.push({
        messageId: row.id,
        conversationId,
        seq: Number(row.seq),
        role: role(row.role),
        createdAt: Number(row.created_at),
        snippet: snippetAround(text, 0, HISTORY_BROWSE.snippetChars),
        ...(compaction ? { kind: 'compaction' as const } : {}),
      })
      if (hits.length >= limit) break
    }
  }
  return hits
}

function scanFallback(options: HistorySearchOptions, limit: number): HistorySearchHit[] {
  const conversationId = options.conversationIds[0]
  return searchConversationHistory(conversationId, options.query, limit, { beforeSeq: options.beforeSeq }).map(
    (hit) => ({ ...hit, conversationId })
  )
}

/**
 * Searches persisted history through the index, bringing the conversations in scope up to date first. A single
 * conversation that cannot be fully indexed in time is scanned instead (the original behaviour); a wider scope
 * searches what is indexed and says so.
 */
export async function searchHistory(options: HistorySearchOptions): Promise<HistorySearchResult> {
  const mode = options.mode ?? 'relevance'
  const limit = Math.max(1, Math.min(options.limit ?? HISTORY_SEARCH.defaultLimit, HISTORY_SEARCH.maxLimit))
  const single = options.conversationIds.length === 1
  // This SQLite cannot host the index: the original scan, with nothing to wait for.
  if (historyIndexUnsupported()) return { mode, hits: single ? scanFallback(options, limit) : [] }
  const ready = prepareHistoryConversations(options.conversationIds, HISTORY_SEARCH.prepareBudgetMs)
  const building = !ready
  if (!ready && single) return { mode, hits: scanFallback(options, limit), building: true }
  if (mode === 'exact') {
    const hits = withHistoryIndex<HistorySearchHit[] | null>(null, (db) => exactSearch(db, options, limit))
    if (hits) return { mode, hits, ...(building ? { building } : {}) }
    return single ? { mode, hits: scanFallback(options, limit) } : { mode, hits: [], ...(building ? { building } : {}) }
  }
  const candidates = withHistoryIndex<Scored[] | null>(null, (db) => relevanceCandidates(db, options))
  if (!candidates)
    return single ? { mode, hits: scanFallback(options, limit), building: true } : { mode, hits: [], building: true }
  const hits = await rankCandidates(candidates, options, limit)
  return { mode, hits, ...(building ? { building } : {}) }
}
