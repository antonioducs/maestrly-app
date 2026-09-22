import { createHash } from 'node:crypto'
import { getDb } from '../store'

interface ReceiptRow {
  conversation_id: string
  kind: string
  fingerprint: string
  state: 'admitted' | 'completed'
  result: string | null
  native_started: number
}

export interface BotCommandReceipt {
  conversationId: string
  kind: string
  state: 'admitted' | 'completed'
  result: Record<string, unknown> | null
  nativeStarted: boolean
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Separate from conversation lifetime: deleted conversations must never cause a prompt replay. */
export class BotCommandJournal {
  constructor(private readonly instanceId: string) {}

  admit(commandId: string, conversationId: string, kind: string, payload: unknown): boolean {
    const fingerprint = createHash('sha256').update(canonical(payload)).digest('hex')
    const row = this.row(commandId)
    if (row) {
      if (row.conversation_id !== conversationId || row.kind !== kind || row.fingerprint !== fingerprint)
        throw new Error('The bot command was already admitted with different input.')
      return false
    }
    getDb()
      .prepare(`INSERT INTO bot_command_receipts
      (instance_id,command_id,conversation_id,kind,fingerprint,state)
      VALUES(?,?,?,?,?,'admitted')`)
      .run(this.instanceId, commandId, conversationId, kind, fingerprint)
    return true
  }

  receipt(commandId: string): BotCommandReceipt | null {
    const row = this.row(commandId)
    return row
      ? {
          conversationId: row.conversation_id,
          kind: row.kind,
          state: row.state,
          result: row.result ? (JSON.parse(row.result) as Record<string, unknown>) : null,
          nativeStarted: row.native_started === 1,
        }
      : null
  }

  complete(commandId: string, result: Record<string, unknown>): void {
    getDb()
      .prepare(`UPDATE bot_command_receipts SET state='completed',result=?
      WHERE instance_id=? AND command_id=?`)
      .run(JSON.stringify(result), this.instanceId, commandId)
  }

  markNativeStart(commandId: string): void {
    getDb()
      .prepare(`UPDATE bot_command_receipts SET native_started=1
      WHERE instance_id=? AND command_id=?`)
      .run(this.instanceId, commandId)
  }

  enqueue(commandId: string, eventId: string, payload: unknown): void {
    const size = getDb()
      .prepare(`SELECT coalesce(sum(length(payload)),0) AS bytes
      FROM bot_command_outbox WHERE instance_id=? AND command_id=?`)
      .get(this.instanceId, commandId) as { bytes: number }
    const encoded = JSON.stringify(payload)
    if (size.bytes + encoded.length > 8_000_000)
      throw new Error('Bot result buffer is full. The native transcript is preserved.')
    getDb()
      .prepare(`INSERT INTO bot_command_outbox(instance_id,command_id,event_id,payload)
      VALUES(?,?,?,?) ON CONFLICT(instance_id,command_id,event_id) DO NOTHING`)
      .run(this.instanceId, commandId, eventId, encoded)
  }

  outbox(commandId: string): Array<{ eventId: string; payload: Record<string, unknown> }> {
    const rows = getDb()
      .prepare(`SELECT event_id,payload FROM bot_command_outbox
      WHERE instance_id=? AND command_id=? ORDER BY seq LIMIT 40`)
      .all(this.instanceId, commandId) as Array<{ event_id: string; payload: string }>
    return rows.map((row) => ({ eventId: row.event_id, payload: JSON.parse(row.payload) as Record<string, unknown> }))
  }

  acknowledge(commandId: string, eventIds: string[]): void {
    const statement = getDb().prepare(`DELETE FROM bot_command_outbox
      WHERE instance_id=? AND command_id=? AND event_id=?`)
    for (const eventId of eventIds) statement.run(this.instanceId, commandId, eventId)
  }

  bindQuestion(questionId: string, conversationId: string, requestId: string): void {
    getDb()
      .prepare(`INSERT INTO bot_question_bindings(instance_id,question_id,conversation_id,request_id)
      VALUES(?,?,?,?) ON CONFLICT(instance_id,question_id) DO NOTHING`)
      .run(this.instanceId, questionId, conversationId, requestId)
  }

  question(questionId: string, conversationId: string): string | null {
    const row = getDb()
      .prepare(`SELECT request_id FROM bot_question_bindings
      WHERE instance_id=? AND question_id=? AND conversation_id=?`)
      .get(this.instanceId, questionId, conversationId) as { request_id: string } | undefined
    return row?.request_id ?? null
  }

  private row(commandId: string): ReceiptRow | undefined {
    return getDb()
      .prepare('SELECT * FROM bot_command_receipts WHERE instance_id=? AND command_id=?')
      .get(this.instanceId, commandId) as ReceiptRow | undefined
  }
}
