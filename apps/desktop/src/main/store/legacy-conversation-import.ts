import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { LegacyCliKind, Turn } from '../transcript-reader'
import { getDb, transaction } from './db'

export const CHAT_ONLY_CONVERSATIONS_MIGRATION = '2026-08-13-chat-only-conversations-v1'

interface LegacyConversationRow {
  id: string
  cli: string
  cwd: string
  created_at: number
  cli_sessions: string | null
  session_anchors: string | null
}

interface LegacySession {
  cli: string
  sessionId?: string
  cwd: string
}

interface ImportedSegment {
  row: LegacyConversationRow
  cli: string
  sessionId?: string
  turns: Turn[]
  readFailure: boolean
  sourceKey: string
  source: 'external-cli-transcript' | 'legacy-unified-handoff' | 'legacy-active-cli-tail'
  fallbackReason?: 'unified-handoff-unavailable' | 'unified-handoff-invalid'
  placement?: 'append' | 'before-existing-chat'
  turnIndexes?: number[]
}

interface LegacyHandoffStateCandidate {
  unified?: unknown
  lastRead?: unknown
  seen?: unknown
}

interface LegacyHandoffState {
  unified: Turn[]
  lastRead: Record<string, number>
  seen: Record<string, number>
}

export type LegacyTranscriptReader = (
  cli: LegacyCliKind,
  cwd: string,
  sessionId: string,
  opts: { strict: boolean; cliSessionId?: string; requireExactSession: boolean }
) => Promise<Turn[]>

const LEGACY_TRANSCRIPT_CLIS = new Set<LegacyCliKind>(['claude', 'codex', 'opencode'])

function columns(): Set<string> {
  return new Set(
    (getDb().prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map((column) => column.name)
  )
}

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function nativeSessionEntries(raw: string | null): Array<[string, string]> {
  return Object.entries(parseObject(raw)).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0
  )
}

function handoffFile(conversationId: string): string {
  return path.join(app.getPath('userData'), 'handoff', `${conversationId}.json`)
}

function isLegacyTurn(value: unknown): value is Turn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const turn = value as { role?: unknown; text?: unknown }
  return (
    (turn.role === 'user' || turn.role === 'assistant') && typeof turn.text === 'string' && turn.text.trim().length > 0
  )
}

/**
 * Legacy handoff uniquely records cross-CLI ordering such as A-B-A. Missing/invalid handoff falls back
 * to exact CLI transcripts with explicit degraded metadata; valid unified:[] is an empty checkpoint,
 * not failure.
 */
function readWatermarks(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, watermark]) => typeof watermark === 'number' && Number.isInteger(watermark) && watermark >= 0
    )
  ) as Record<string, number>
}

async function readLegacyHandoffState(
  conversationId: string
): Promise<
  | { state: LegacyHandoffState; fallbackReason?: never }
  | { state: undefined; fallbackReason: ImportedSegment['fallbackReason'] }
> {
  let raw: string
  try {
    raw = await fsp.readFile(handoffFile(conversationId), 'utf8')
  } catch {
    return { state: undefined, fallbackReason: 'unified-handoff-unavailable' }
  }

  let candidate: LegacyHandoffStateCandidate
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid handoff state')
    candidate = parsed as LegacyHandoffStateCandidate
  } catch {
    return { state: undefined, fallbackReason: 'unified-handoff-invalid' }
  }

  if (!Array.isArray(candidate.unified) || !candidate.unified.every(isLegacyTurn)) {
    return { state: undefined, fallbackReason: 'unified-handoff-invalid' }
  }
  return {
    state: {
      unified: candidate.unified,
      lastRead: readWatermarks(candidate.lastRead),
      seen: readWatermarks(candidate.seen),
    },
  }
}

/**
 * cli_sessions JSON preserves capture order per CLI. Without unified handoff, retain that only
 * available historical order instead of choosing sessions by cwd/recency.
 */
function legacySessions(row: LegacyConversationRow): LegacySession[] {
  const anchors = parseObject(row.session_anchors)
  const sessions: LegacySession[] = []
  const seen = new Set<string>()

  const add = (cli: string, sessionId: string | undefined): void => {
    const key = `${cli}\0${sessionId ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    const anchor = anchors[cli]
    const anchoredSessionId =
      anchor && typeof anchor === 'object' && typeof (anchor as { sessionId?: unknown }).sessionId === 'string'
        ? (anchor as { sessionId: string }).sessionId
        : undefined
    const sourceCwd =
      sessionId &&
      anchoredSessionId === sessionId &&
      anchor &&
      typeof anchor === 'object' &&
      typeof (anchor as { sourceCwd?: unknown }).sourceCwd === 'string'
        ? (anchor as { sourceCwd: string }).sourceCwd
        : row.cwd
    sessions.push({ cli, sessionId, cwd: sourceCwd })
  }

  // Claude's legacy session id is the conversation id and historically was not stored in cli_sessions. It
  // is the first known segment whenever Claude is the active legacy CLI, before the native ids captured later.
  if (row.cli === 'claude') add('claude', row.id)

  for (const [cli, sessionId] of nativeSessionEntries(row.cli_sessions)) {
    if (cli === 'chat' || !LEGACY_TRANSCRIPT_CLIS.has(cli as LegacyCliKind)) continue
    add(cli, sessionId)
  }

  // Keep the old degraded marker for an active CLI whose exact id was never captured. This also preserves
  // unknown legacy values instead of silently dropping their envelope before the user sees the gap.
  if (row.cli !== 'chat' && !sessions.some((session) => session.cli === row.cli)) {
    add(row.cli, row.cli === 'claude' ? row.id : undefined)
  }

  return sessions
}

function activeLegacySession(row: LegacyConversationRow): LegacySession | undefined {
  if (row.cli === 'chat') return { cli: 'chat', sessionId: row.id, cwd: row.cwd }
  return legacySessions(row).find((session) => session.cli === row.cli)
}

/**
 * Handoff is incremental: with a marker, only the current transcript suffix is new. Older unified
 * state without lastRead uses the largest verifiable prefix subsequence to avoid replaying checkpoints
 * without inventing offsets.
 */
function freshTail(state: LegacyHandoffState, cli: string, turns: Turn[]): Turn[] {
  const watermark = state.lastRead[cli]
  if (watermark !== undefined) return watermark <= turns.length ? turns.slice(watermark) : []

  let searchFrom = 0
  let represented = 0
  for (const turn of turns) {
    const match = state.unified.findIndex(
      (candidate, index) => index >= searchFrom && candidate.role === turn.role && candidate.text === turn.text
    )
    if (match < 0) break
    represented += 1
    searchFrom = match + 1
  }
  return turns.slice(represented)
}

interface ExistingChatProjection {
  hasRows: boolean
  messages: Array<{ turns: Turn[]; handoffContext: boolean }>
}

function contextTurns(text: string): Turn[] {
  const chunks = text.split('\n\n---\n\n')
  const turns: Turn[] = []
  for (const chunk of chunks) {
    const match = chunk.match(/^\*\*(Usuário|Assistente|User|Assistant):\*\*\n\n([\s\S]+)$/)
    if (!match) return []
    turns.push({ role: match[1] === 'Usuário' || match[1] === 'User' ? 'user' : 'assistant', text: match[2] })
  }
  return turns
}

/**
 * Project only text needed to detect an existing Chat checkpoint. Do not rewrite native rows
 * containing tools, usage, or rich parts.
 */
function existingChatProjection(conversationId: string): ExistingChatProjection {
  const rows = getDb()
    .prepare('SELECT role, parts_json FROM chat_messages WHERE conversation_id = ? ORDER BY seq ASC')
    .all(conversationId) as Array<{ role: string; parts_json: string }>
  const messages: Array<{ turns: Turn[]; handoffContext: boolean }> = []
  for (const row of rows) {
    let parts: unknown[] = []
    try {
      const parsed: unknown = JSON.parse(row.parts_json)
      parts = Array.isArray(parsed) ? parsed : []
    } catch {
      parts = []
    }
    const contextParts = parts
      .map((part): { text: string; turns: Turn[] } | null => {
        if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'context') return null
        const text = (part as { text?: unknown }).text
        const source = (part as { source?: unknown }).source
        if (typeof text !== 'string' || typeof source !== 'string' || !source.trim()) return null
        const turns = contextTurns(text)
        return turns.length > 0 ? { text, turns } : null
      })
      .filter((part): part is { text: string; turns: Turn[] } => part !== null)
    if (contextParts.length > 0) {
      messages.push({
        handoffContext: true,
        turns: contextParts.flatMap((part) => {
          // The switch into Chat stores one wrapper message, while a later switch out reads that wrapper as
          // one assistant Turn. Keep both views in the projection: the raw turns cover the original unified
          // checkpoint and the wrapper covers the turn Chat itself contributed back to unified.
          return [...part.turns, { role: 'assistant' as const, text: part.text }]
        }),
      })
      continue
    }
    const text = parts
      .filter(
        (part): part is { type: 'text' | 'compaction'; text: string } =>
          !!part &&
          typeof part === 'object' &&
          ((part as { type?: unknown }).type === 'text' || (part as { type?: unknown }).type === 'compaction') &&
          typeof (part as { text?: unknown }).text === 'string'
      )
      .map((part) => (part.type === 'compaction' ? `(context summary)\n${part.text}` : part.text))
      .join('\n')
      .trim()
    if (text && (row.role === 'user' || row.role === 'assistant')) {
      messages.push({ turns: [{ role: row.role, text }], handoffContext: false })
    }
  }
  return { hasRows: rows.length > 0, messages }
}

function chatCheckpointTurns(state: LegacyHandoffState, chat: ExistingChatProjection, activeCli: string): Turn[] {
  const messageLimit = state.lastRead.chat
  const chatHasConsumedHandoff = activeCli === 'chat' && state.seen.chat !== undefined
  const incorporated =
    messageLimit !== undefined ? chat.messages.slice(0, messageLimit) : chatHasConsumedHandoff ? [] : chat.messages
  return chat.messages
    .filter((message, index) => index < (messageLimit ?? 0) || message.handoffContext || incorporated.includes(message))
    .flatMap((message) => message.turns)
}

/**
 * Return content missing from Chat projection in handoff order. Subsequence matching permits
 * intervening native messages without reordering the checkpoint.
 */
function missingFromChat(checkpoint: Turn[], chatTurns: Turn[]): Array<{ turn: Turn; index: number }> {
  if (chatTurns.length === 0) return checkpoint.map((turn, index) => ({ turn, index }))
  let searchFrom = 0
  const missing: Array<{ turn: Turn; index: number }> = []
  checkpoint.forEach((turn, index) => {
    const match = chatTurns.findIndex(
      (candidate, index) => index >= searchFrom && candidate.role === turn.role && candidate.text === turn.text
    )
    if (match < 0) missing.push({ turn, index })
    else searchFrom = match + 1
  })
  return missing
}

function messageId(conversationId: string, source: string, index: number, text: string): string {
  return `legacy-${createHash('sha256')
    .update(`${conversationId}\0${source}\0${index}\0${text}`)
    .digest('hex')
    .slice(0, 32)}`
}

function importedPartId(messageIdValue: string, partIndex: number): string {
  return `${messageIdValue}:part-${partIndex}`
}

function sourceLabel(cli: string): string {
  if (cli === 'claude') return 'Claude Code'
  if (cli === 'codex') return 'Codex'
  if (cli === 'opencode') return 'OpenCode'
  return 'Legacy tool'
}

function legacyMeta(
  source: ImportedSegment['source'],
  cli: string,
  sessionId: string | undefined,
  degradedReason?: string
): string {
  return JSON.stringify({
    legacyImport: {
      version: 1,
      provenance: source,
      cli: source === 'legacy-unified-handoff' ? null : cli,
      sessionId: sessionId ?? null,
      exactSession: source !== 'legacy-unified-handoff',
      degraded: degradedReason !== undefined,
      ...(degradedReason ? { degradedReason } : {}),
    },
  })
}

function importedTurns(cli: string, sessionId: string | undefined, turns: Turn[]): Turn[] {
  const label = sourceLabel(cli)
  return [
    { role: 'assistant', text: `Imported from ${label}.` },
    ...(turns.length
      ? turns
      : [
          {
            role: 'assistant' as const,
            text: sessionId
              ? `[${label} history is unavailable for exact session ${sessionId}.]`
              : `[${label} history was not imported: exact session identifier is missing.]`,
          },
        ]),
  ]
}

function insertSegments(segments: ImportedSegment[]): void {
  const db = getDb()
  const nextSeq = new Map<string, number>()
  const beforeSeq = new Map<string, number>()
  const beforeCounts = new Map<string, number>()
  for (const segment of segments) {
    if (segment.placement !== 'before-existing-chat') continue
    beforeCounts.set(segment.row.id, (beforeCounts.get(segment.row.id) ?? 0) + segment.turns.length)
  }
  for (const [conversationId, count] of beforeCounts) {
    const minSeq = (
      db.prepare('SELECT MIN(seq) AS n FROM chat_messages WHERE conversation_id = ?').get(conversationId) as {
        n: number | null
      }
    ).n
    beforeSeq.set(conversationId, (minSeq ?? 0) - count)
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO chat_messages
       (id, conversation_id, role, parts_json, meta_json, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )

  transaction(() => {
    for (const segment of segments) {
      const currentSeq =
        segment.placement === 'before-existing-chat'
          ? (beforeSeq.get(segment.row.id) ?? 0)
          : (nextSeq.get(segment.row.id) ??
            (
              db
                .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM chat_messages WHERE conversation_id = ?')
                .get(segment.row.id) as { n: number }
            ).n)
      const imported =
        segment.source === 'legacy-unified-handoff' || segment.source === 'legacy-active-cli-tail'
          ? segment.turns
          : importedTurns(segment.cli, segment.sessionId, segment.turns)
      const degradedReason =
        segment.source === 'legacy-unified-handoff'
          ? undefined
          : segment.readFailure
            ? 'transcript-read-failed'
            : segment.sessionId
              ? segment.turns.length === 0
                ? 'transcript-empty-or-unavailable'
                : segment.fallbackReason
              : 'session-id-missing'
      imported.forEach((turn, index) => {
        const seq = currentSeq + index
        const messageIndex = segment.turnIndexes?.[index] ?? index
        const id = messageId(segment.row.id, segment.sourceKey, messageIndex, turn.text)
        insert.run(
          id,
          segment.row.id,
          turn.role,
          JSON.stringify([{ type: 'text', id: importedPartId(id, 0), text: turn.text }]),
          legacyMeta(segment.source, segment.cli, segment.sessionId, degradedReason),
          seq,
          segment.row.created_at + seq
        )
      })
      if (segment.placement === 'before-existing-chat') beforeSeq.set(segment.row.id, currentSeq + imported.length)
      else nextSeq.set(segment.row.id, currentSeq + imported.length)
    }
  })
}

/**
 * One-time pre-Chat transcript import before removing compatibility columns. Require exact persisted
 * session IDs; never choose the newest cwd session. External transcripts remain read-only on disk.
 */
export async function migrateLegacyConversationsToChat(reader: LegacyTranscriptReader): Promise<void> {
  const db = getDb()
  const alreadyApplied = db
    .prepare('SELECT 1 FROM schema_migrations WHERE id = ?')
    .get(CHAT_ONLY_CONVERSATIONS_MIGRATION)
  if (alreadyApplied) return

  const legacyColumns = columns()
  const segments: ImportedSegment[] = []
  if (legacyColumns.has('cli')) {
    const sessionProjection = legacyColumns.has('cli_sessions') ? 'cli_sessions' : 'NULL AS cli_sessions'
    const anchorProjection = legacyColumns.has('session_anchors') ? 'session_anchors' : 'NULL AS session_anchors'
    const rows = db
      .prepare(
        `SELECT id, cli, cwd, created_at, ${sessionProjection}, ${anchorProjection}
         FROM conversations
         ORDER BY created_at ASC, id ASC`
      )
      .all() as unknown as LegacyConversationRow[]

    for (const row of rows) {
      const handoff = await readLegacyHandoffState(row.id)
      if (handoff.state) {
        const chat = existingChatProjection(row.id)
        const missingCheckpoint = missingFromChat(
          handoff.state.unified,
          chatCheckpointTurns(handoff.state, chat, row.cli)
        )

        // Chat rows are already the native transcript, including context parts injected when a CLI handed
        // off to Chat. Keep them (tools/usage included) and only materialize a checkpoint that is genuinely
        // absent. When rows exist, put that missing prefix before them so the active Chat tail stays last.
        if (missingCheckpoint.length > 0) {
          segments.push({
            row,
            cli: 'handoff',
            turns: missingCheckpoint.map(({ turn }) => turn),
            turnIndexes: missingCheckpoint.map(({ index }) => index),
            readFailure: false,
            sourceKey: 'unified-handoff',
            source: 'legacy-unified-handoff',
            placement: chat.hasRows ? 'before-existing-chat' : 'append',
          })
        }

        // The current Chat runtime has no external file tail to recover: every native turn is already in
        // chat_messages. For an active CLI, however, `unified` is only the last switch checkpoint; append the
        // exact suffix after lastRead[active], preserving A→B→A chronology.
        if (row.cli !== 'chat') {
          const session = activeLegacySession(row)
          let turns: Turn[] = []
          let readFailure = false
          if (session?.sessionId && LEGACY_TRANSCRIPT_CLIS.has(row.cli as LegacyCliKind)) {
            try {
              turns = await reader(row.cli as LegacyCliKind, session.cwd, row.id, {
                strict: true,
                ...(row.cli === 'claude' ? {} : { cliSessionId: session.sessionId }),
                requireExactSession: true,
              })
            } catch {
              readFailure = true
            }
          }
          const tail = session?.sessionId ? freshTail(handoff.state, row.cli, turns) : []
          if (tail.length > 0) {
            segments.push({
              row,
              cli: row.cli,
              sessionId: session?.sessionId,
              turns: tail,
              readFailure,
              sourceKey: `active-cli-tail:${row.cli}`,
              source: 'legacy-active-cli-tail',
            })
          } else if (!session?.sessionId || readFailure) {
            // Preserve the visible degraded marker used by the old fallback path when the final active
            // runtime cannot be resolved. A valid checkpoint must not make this loss silent.
            segments.push({
              row,
              cli: row.cli,
              sessionId: session?.sessionId,
              turns: [],
              readFailure,
              sourceKey: `active-cli-tail:${row.cli}:unavailable`,
              source: 'external-cli-transcript',
            })
          }
        }
        continue
      }

      // No trustworthy handoff file: retain the previous exact-session fallback for every known native
      // session, with the explicit degradation marker in metadata. This path cannot recover chronology that
      // the missing/invalid handoff used to carry, but it must not discard readable transcripts.
      const sessions = legacySessions(row)
      const sourceCounts = new Map<string, number>()
      for (const session of sessions) sourceCounts.set(session.cli, (sourceCounts.get(session.cli) ?? 0) + 1)

      for (const session of sessions) {
        let turns: Turn[] = []
        let readFailure = false
        if (session.sessionId && LEGACY_TRANSCRIPT_CLIS.has(session.cli as LegacyCliKind)) {
          try {
            turns = await reader(session.cli as LegacyCliKind, session.cwd, row.id, {
              strict: true,
              ...(session.cli === 'claude' ? {} : { cliSessionId: session.sessionId }),
              requireExactSession: true,
            })
          } catch {
            readFailure = true
          }
        }
        // The normal shape has at most one session per CLI. Include the id in the key only for malformed or
        // hand-edited envelopes that contain duplicate entries, so existing deterministic ids stay compatible.
        const sourceKey =
          (sourceCounts.get(session.cli) ?? 0) > 1 ? `${session.cli}:${session.sessionId ?? 'missing'}` : session.cli
        segments.push({
          ...session,
          row,
          turns,
          readFailure,
          sourceKey,
          source: 'external-cli-transcript',
          fallbackReason: handoff.fallbackReason,
        })
      }
    }
  }

  // All recoverable segments are persisted before the compatibility envelope is removed. Existing Chat rows
  // are intentionally untouched; missing checkpoint turns are placed before them, while the active CLI tail
  // continues after the current maximum for that conversation.
  insertSegments(segments)
  transaction(() => {
    // SQLite migrations are forward-only. Compatibility with these columns ends at the importer above.
    for (const column of ['session_anchors', 'cli_sessions', 'started', 'cli']) {
      if (columns().has(column)) db.exec(`ALTER TABLE conversations DROP COLUMN ${column};`)
    }
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
      CHAT_ONLY_CONVERSATIONS_MIGRATION,
      Date.now()
    )
  })
}
