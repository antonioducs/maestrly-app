import { createHash, randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import { getConversation } from '../../store/conversations'
import { getDb, transaction } from '../../store/db'
import { type PlanEntry, type PlanStatus, planRef, planTitleFrom, stripProposedPlanTag } from './context'

interface PlanRow {
  id: string
  conversation_id: string
  version: number
  title: string | null
  content: string
  content_hash: string
  status: string
  created_at: number
  decided_at: number | null
}

const STATUSES: ReadonlySet<string> = new Set(['proposed', 'approved', 'revised', 'discarded', 'superseded'])
const APPROVED_PLAN_BLOCK = /<approved_plan>\n?([\s\S]*?)\n?<\/approved_plan>/g
/** Conversations whose transcript was already reconciled with the store in this process. */
const reconciled = new Set<string>()

const hashPlan = (content: string): string => createHash('sha256').update(content.trim()).digest('hex')

function toEntry(row: PlanRow): PlanEntry {
  return {
    id: row.id,
    version: row.version,
    ...(row.title ? { title: row.title } : {}),
    content: row.content,
    status: (STATUSES.has(row.status) ? row.status : 'proposed') as PlanStatus,
    createdAt: row.created_at,
  }
}

function rows(conversationId: string): PlanRow[] {
  return getDb()
    .prepare('SELECT * FROM chat_plans WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(conversationId) as unknown as PlanRow[]
}

function insertPlan(
  conversationId: string,
  plan: { version: number; title?: string; content: string; status: PlanStatus; createdAt: number }
): void {
  const content = plan.content.trim()
  getDb()
    .prepare(
      `INSERT INTO chat_plans (id, conversation_id, version, title, content, content_hash, status, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      conversationId,
      plan.version,
      plan.title?.trim() || planTitleFrom(content) || null,
      content,
      hashPlan(content),
      plan.status,
      plan.createdAt,
      plan.status === 'proposed' ? null : plan.createdAt
    )
}

/** A plan submitted with `review_plan`; a version still awaiting a decision is superseded by it. */
export function recordStagedPlan(
  conversationId: string,
  plan: { version: number; title?: string; content: string },
  now = Date.now()
): void {
  if (!getConversation(conversationId) || !plan.content.trim()) return
  transaction(() => {
    getDb()
      .prepare(
        "UPDATE chat_plans SET status = 'superseded', decided_at = ? WHERE conversation_id = ? AND status = 'proposed'"
      )
      .run(now, conversationId)
    insertPlan(conversationId, { ...plan, status: 'proposed', createdAt: now })
  })
}

/** The person's decision on the latest proposed plan. An approval stores the final text, edits included. */
export function recordPlanDecision(
  conversationId: string,
  decision: { action: 'approve' | 'revise' | 'discard'; content: string },
  now = Date.now()
): void {
  if (!getConversation(conversationId)) return
  const db = getDb()
  const latest = db
    .prepare(
      "SELECT id FROM chat_plans WHERE conversation_id = ? AND status = 'proposed' ORDER BY created_at DESC, rowid DESC LIMIT 1"
    )
    .get(conversationId) as { id: string } | undefined
  if (!latest) {
    if (decision.action === 'approve') recordApprovedPlan(conversationId, decision.content, undefined, now)
    return
  }
  const status: PlanStatus =
    decision.action === 'approve' ? 'approved' : decision.action === 'revise' ? 'revised' : 'discarded'
  const content = decision.content.trim()
  if (decision.action === 'approve' && content) {
    db.prepare('UPDATE chat_plans SET status = ?, decided_at = ?, content = ?, content_hash = ? WHERE id = ?').run(
      status,
      now,
      content,
      hashPlan(content),
      latest.id
    )
  } else {
    db.prepare('UPDATE chat_plans SET status = ?, decided_at = ? WHERE id = ?').run(status, now, latest.id)
  }
}

/**
 * An approved plan this conversation implements, such as one approved elsewhere and handed to it. Recording the plan
 * it already implements again does nothing.
 */
export function recordApprovedPlan(conversationId: string, content: string, title?: string, now = Date.now()): void {
  const text = content.trim()
  if (!text || !getConversation(conversationId)) return
  const newest = rows(conversationId).at(-1)
  if (newest?.status === 'approved' && newest.content_hash === hashPlan(text)) return
  insertPlan(conversationId, {
    version: 1,
    ...(title ? { title } : {}),
    content: text,
    status: 'approved',
    createdAt: now,
  })
}

interface TranscriptPlan {
  kind: 'proposed' | 'approved'
  content: string
  title?: string
  createdAt: number
}

function transcriptPlans(conversationId: string, where = '', ...params: SQLInputValue[]): TranscriptPlan[] {
  const messages = getDb()
    .prepare(
      `SELECT role, parts_json, created_at FROM chat_messages m
       WHERE m.conversation_id = ? ${where}
         AND (m.parts_json LIKE '%review_plan%' OR m.parts_json LIKE '%<approved_plan>%')
       ORDER BY m.seq ASC`
    )
    .all(conversationId, ...params) as Array<{ role: string; parts_json: string; created_at: number }>
  const found: TranscriptPlan[] = []
  for (const message of messages) {
    let parts: unknown
    try {
      parts = JSON.parse(message.parts_json)
    } catch {
      continue
    }
    if (!Array.isArray(parts)) continue
    for (const part of parts as Array<Record<string, unknown>>) {
      if (part?.type === 'tool' && String(part.toolName ?? '').replace(/^mcp__maestrly__/, '') === 'review_plan') {
        const input = part.input as { plan?: unknown; title?: unknown } | null
        if (typeof input?.plan !== 'string' || !input.plan.trim()) continue
        found.push({
          kind: 'proposed',
          content: stripProposedPlanTag(input.plan),
          ...(typeof input.title === 'string' && input.title.trim() ? { title: input.title } : {}),
          createdAt: message.created_at,
        })
      } else if (message.role === 'user' && part?.type === 'text' && typeof part.text === 'string') {
        for (const match of part.text.matchAll(APPROVED_PLAN_BLOCK)) {
          if (match[1].trim()) found.push({ kind: 'approved', content: match[1], createdAt: message.created_at })
        }
      }
    }
  }
  return found
}

/**
 * Adds the plans the transcript holds but the store does not: conversations from before plans were stored, moved
 * from another host, or started from an approved plan. Their decisions are inferred: an approval names its plan, and
 * an undecided proposal followed by another plan was replaced.
 */
function reconcileWithTranscript(conversationId: string): void {
  if (reconciled.has(conversationId)) return
  reconciled.add(conversationId)
  const found = transcriptPlans(conversationId)
  if (found.length === 0) return
  transaction(() => {
    const known = new Map(rows(conversationId).map((row) => [row.content_hash, row]))
    const added: string[] = []
    for (const plan of found) {
      const hash = hashPlan(plan.content)
      const existing = known.get(hash)
      if (existing) {
        if (plan.kind === 'approved' && existing.status === 'proposed') {
          getDb()
            .prepare("UPDATE chat_plans SET status = 'approved', decided_at = ? WHERE id = ?")
            .run(plan.createdAt, existing.id)
          existing.status = 'approved'
        }
        continue
      }
      insertPlan(conversationId, {
        version: 1,
        ...(plan.title ? { title: plan.title } : {}),
        content: plan.content,
        status: plan.kind,
        createdAt: plan.createdAt,
      })
      const inserted = rows(conversationId).find((row) => row.content_hash === hash)
      if (inserted) {
        known.set(hash, inserted)
        added.push(inserted.id)
      }
    }
    const all = rows(conversationId)
    const newest = all.at(-1)?.id
    for (const row of all)
      if (added.includes(row.id) && row.status === 'proposed' && row.id !== newest)
        getDb()
          .prepare("UPDATE chat_plans SET status = 'superseded', decided_at = ? WHERE id = ?")
          .run(row.created_at, row.id)
  })
}

/** Every plan of the conversation, oldest first. */
export function listConversationPlans(conversationId: string): PlanEntry[] {
  reconcileWithTranscript(conversationId)
  return rows(conversationId).map(toEntry)
}

/** One plan by its id or `plan_` reference; without one, the plan being implemented, else the latest. */
export function getConversationPlan(conversationId: string, ref?: string): PlanEntry | null {
  const plans = listConversationPlans(conversationId)
  // The plan being implemented is always the latest one.
  if (!ref?.trim()) return plans.at(-1) ?? null
  const wanted = ref.trim().toLowerCase()
  return plans.find((plan) => plan.id === wanted || planRef(plan.id) === wanted) ?? null
}

/**
 * Forgets the plans held by messages about to be deleted (`where` filters `chat_messages m`), so a cleared or rewritten
 * history does not keep listing them. Call it before deleting the messages.
 */
export function forgetPlansOfMessages(conversationId: string, where: string, ...params: SQLInputValue[]): void {
  // A plan another remaining message also holds (its approval, say) comes back from the transcript on the next read.
  reconciled.delete(conversationId)
  const hashes = [...new Set(transcriptPlans(conversationId, where, ...params).map((plan) => hashPlan(plan.content)))]
  for (let index = 0; index < hashes.length; index += 200) {
    const chunk = hashes.slice(index, index + 200)
    getDb()
      .prepare(
        `DELETE FROM chat_plans WHERE conversation_id = ? AND content_hash IN (${chunk.map(() => '?').join(',')})`
      )
      .run(conversationId, ...chunk)
  }
}

/** Forgets every plan of a conversation whose history is cleared. */
export function forgetConversationPlans(conversationId: string): void {
  getDb().prepare('DELETE FROM chat_plans WHERE conversation_id = ?').run(conversationId)
  reconciled.delete(conversationId)
}

/** Test seam: forget which conversations were reconciled in this process. */
export function resetPlanReconciliation(): void {
  reconciled.clear()
}
