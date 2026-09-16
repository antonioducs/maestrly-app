import { z } from 'zod'
import {
  desktopGenerationSchema,
  desktopModeSchema,
  desktopOperationSchema,
  isoDate,
  sessionIdSchema,
  type BotSession,
  type DesktopMode,
  type DesktopOperation,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { type BotRepository, now } from '../bots/repository.js'

const id = z.string().min(1).max(128)
/** Durable control state of one session. Public projections are derived from it. */
export const desktopRecordSchema = z.strictObject({
  botId: id,
  sessionId: sessionIdSchema,
  revision: z.number().int().nonnegative(),
  controlEpoch: z.number().int().nonnegative(),
  mode: desktopModeSchema,
  desktopGeneration: desktopGenerationSchema.optional(),
  width: z.number().int().min(0).max(4096),
  height: z.number().int().min(0).max(4096),
  interruptedTurnId: id.optional(),
  reasonCode: z.string().regex(/^[A-Z_]{1,64}$/).optional(),
  /** Cumulative budget of a task across handoffs, so takeovers never extend it. */
  chain: z.strictObject({ rootTurnId: id, lastTurnId: id, activeMs: z.number().int().nonnegative(), tools: z.number().int().nonnegative() }).optional(),
  updatedAt: isoDate,
})
export type DesktopRecord = z.infer<typeof desktopRecordSchema>
export type TransitionIntent = {
  kind: DesktopOperation['kind']
  mode: DesktopMode
  viewId?: string
  continueTask?: boolean
  interruptedTurnId?: string
  resumeOfTurnId?: string
}
const parse = <T>(schema: { parse(value: unknown): T }, row: unknown) => schema.parse(JSON.parse((row as { body: string }).body))

/** Shares the Host transaction; no I/O happens while a transaction is open. */
export class DesktopRepository {
  constructor(private readonly repo: BotRepository) {}
  private get db() {
    return this.repo.db
  }
  transaction<T>(fn: () => T): T {
    return this.repo.transaction(fn)
  }
  get(sessionId: string): DesktopRecord | undefined {
    const row = this.db.prepare('SELECT body FROM bot_desktop_control WHERE session_id=?').get(sessionId)
    return row ? parse(desktopRecordSchema, row) : undefined
  }
  forBot(botId: string): DesktopRecord | undefined {
    const row = this.db.prepare('SELECT body FROM bot_desktop_control WHERE bot_id=?').get(botId)
    return row ? parse(desktopRecordSchema, row) : undefined
  }
  all(): DesktopRecord[] {
    return this.db.prepare('SELECT body FROM bot_desktop_control ORDER BY rowid').all().map((row) => parse(desktopRecordSchema, row))
  }
  /** Modes that must keep every new bot action out. */
  held(botId: string) {
    const mode = this.forBot(botId)?.mode
    return mode !== undefined && mode !== 'bot'
  }
  ensure(session: BotSession): DesktopRecord {
    const existing = this.get(session.id)
    if (existing) return existing
    const record: DesktopRecord = { botId: session.botId, sessionId: session.id, revision: 0, controlEpoch: 0, mode: 'bot', width: 0, height: 0, updatedAt: now() }
    this.save(record)
    return record
  }
  save(value: DesktopRecord) {
    const record = desktopRecordSchema.parse(value)
    const old = this.get(record.sessionId)
    if (old && (old.botId !== record.botId || record.controlEpoch < old.controlEpoch))
      throw new HostError('HANDOFF_UNCERTAIN', 'O controle da tela não pode voltar a um estado anterior')
    this.db
      .prepare('INSERT INTO bot_desktop_control(session_id,bot_id,mode,body) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode,body=excluded.body')
      .run(record.sessionId, record.botId, record.mode, JSON.stringify(record))
  }
  operation(operationId: string): DesktopOperation {
    const row = this.db.prepare('SELECT body FROM bot_desktop_operations WHERE id=?').get(operationId)
    if (!row) throw new HostError('NOT_FOUND', 'Operação da tela não encontrada')
    return parse(desktopOperationSchema, row)
  }
  operationByKey(key: string): { fingerprint: string; operation: DesktopOperation } | undefined {
    const row = this.db.prepare('SELECT fingerprint,body FROM bot_desktop_operations WHERE key=?').get(key) as { fingerprint: string; body: string } | undefined
    return row ? { fingerprint: row.fingerprint, operation: desktopOperationSchema.parse(JSON.parse(row.body)) } : undefined
  }
  running(): DesktopOperation[] {
    return this.db.prepare('SELECT body FROM bot_desktop_operations ORDER BY rowid').all().map((row) => parse(desktopOperationSchema, row)).filter((op) => op.status === 'running')
  }
  /**
   * Starts a handoff step atomically: idempotency, revision check, a strictly larger
   * epoch and the new mode are one transaction. A repeated key returns the operation.
   */
  beginTransition(sessionId: string, expectedRevision: number | undefined, key: string, fingerprint: string, intent: TransitionIntent, during?: (record: DesktopRecord) => void) {
    return this.transaction(() => {
      const previous = this.operationByKey(key)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new HostError('IDEMPOTENCY_CONFLICT', 'A chave já foi usada com outros parâmetros')
        return { operation: previous.operation, record: this.get(sessionId)!, existing: true }
      }
      const record = this.get(sessionId)
      if (!record) throw new HostError('DESKTOP_UNAVAILABLE', 'A tela deste bot ainda não está disponível')
      if (expectedRevision !== undefined && record.revision !== expectedRevision)
        throw new HostError('REVISION_CONFLICT', 'O estado da tela mudou; atualize antes de continuar')
      const next: DesktopRecord = {
        ...record,
        mode: intent.mode,
        controlEpoch: record.controlEpoch + 1,
        revision: record.revision + 1,
        reasonCode: undefined,
        ...(intent.interruptedTurnId !== undefined ? { interruptedTurnId: intent.interruptedTurnId } : {}),
        updatedAt: now(),
      }
      const operation: DesktopOperation = desktopOperationSchema.parse({
        id: crypto.randomUUID(),
        botId: record.botId,
        sessionId,
        kind: intent.kind,
        status: 'running',
        phase: 'intent',
        controlEpoch: next.controlEpoch,
        ...(intent.viewId ? { viewId: intent.viewId } : {}),
        ...(intent.continueTask !== undefined ? { continueTask: intent.continueTask } : {}),
        ...(intent.interruptedTurnId ? { interruptedTurnId: intent.interruptedTurnId } : {}),
        createdAt: now(),
        updatedAt: now(),
      })
      this.save(next)
      this.db
        .prepare('INSERT INTO bot_desktop_operations(id,key,fingerprint,session_id,kind,resume_of_turn_id,body) VALUES(?,?,?,?,?,?,?)')
        .run(operation.id, key, fingerprint, sessionId, operation.kind, intent.resumeOfTurnId ?? null, JSON.stringify(operation))
      during?.(next)
      return { operation, record: next, existing: false }
    })
  }
  /** Records a step's result and, optionally, the new control state in one transaction. */
  commitTransition(operationId: string, patch: TransitionPatch, record?: (current: DesktopRecord) => DesktopRecord) {
    return this.transaction(() => this.applyTransition(operationId, patch, record))
  }
  /** Same as commitTransition, for callers already inside a Host transaction. */
  applyTransition(operationId: string, patch: TransitionPatch, record?: (current: DesktopRecord) => DesktopRecord) {
    {
      const operation = desktopOperationSchema.parse({ ...this.operation(operationId), ...patch, updatedAt: now() })
      this.db
        .prepare('UPDATE bot_desktop_operations SET body=?, continuation_turn_id=COALESCE(?, continuation_turn_id) WHERE id=?')
        .run(JSON.stringify(operation), patch.continuationTurnId ?? null, operationId)
      if (record) {
        const current = this.get(operation.sessionId)!
        this.save({ ...record(current), revision: current.revision + 1, updatedAt: now() })
      }
      return operation
    }
  }
}
export type TransitionPatch = Partial<Pick<DesktopOperation, 'phase' | 'status' | 'failureCode' | 'continuationTurnId' | 'interruptedTurnId'>>
