import type { DatabaseSync } from 'node:sqlite'
import {
  botSchema,
  botConversationSchema,
  botMessageSchema,
  botTurnSchema,
  botInteractionSchema,
  botMemorySchema,
  botEventSchema,
  botOperationSchema,
  botSetupPreviewSchema,
  networkPolicySchema,
  transferStateSchema,
  TURN_TERMINAL,
  botSessionSchema,
  sessionCapacitySchema,
  type BotSession,
  type SessionCapacity,
  type Bot,
  type BotConversation,
  type BotMessage,
  type BotTurn,
  type BotInteraction,
  type BotMemory,
  type BotEvent,
  type BotOperation,
  type BotSetupPreview,
  type NetworkPolicy,
  type TransferState,
} from '@maestrly/host-protocol'
import { z } from 'zod'
import { HostError } from '../errors.js'
import type { HostStore } from '../persistence/store.js'

export const now = () => new Date().toISOString()
/** Per-VM Bot binding: profile and guest capabilities live here, never inside the v1 Vm shape. */
export const bindingSchema = z.strictObject({
  botId: z.string(),
  vmId: z.string(),
  templateId: z.string(),
  profile: z.literal('bot'),
  guestGeneration: z.number().int().nonnegative().default(0),
  runtimeVersion: z.string().max(60).optional(),
  createdAt: z.string(),
})
export type BotBinding = z.infer<typeof bindingSchema>
export const outboxSchema = z.strictObject({
  id: z.string(),
  botId: z.string(),
  turnId: z.string(),
  kind: z.enum(['turn.start', 'turn.cancel', 'interaction.resolve']),
  body: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  attempts: z.number().int().nonnegative().default(0),
})
export type OutboxItem = z.infer<typeof outboxSchema>
const parseRow = <T>(schema: { parse(value: unknown): T }, row: unknown): T => schema.parse(JSON.parse((row as { body: string }).body))

/** Shares the HostStore connection and transaction; never a second owner of the database. */
export class BotRepository {
  readonly db: DatabaseSync
  constructor(readonly store: HostStore) {
    this.db = store.db
  }
  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn)
  }
  // Bots
  bots(includeArchived = false): Bot[] {
    return this.db
      .prepare(includeArchived ? 'SELECT body FROM bots ORDER BY rowid' : "SELECT body FROM bots WHERE status!='archived' ORDER BY rowid")
      .all()
      .map((row) => parseRow(botSchema, row))
  }
  bot(id: string): Bot {
    const row = this.db.prepare('SELECT body FROM bots WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Bot not found')
    return parseRow(botSchema, row)
  }
  botByVm(vmId: string): Bot | undefined {
    const row = this.db.prepare("SELECT body FROM bots WHERE vm_id=? AND status!='archived'").get(vmId)
    return row ? parseRow(botSchema, row) : undefined
  }
  botsByVm(vmId: string, includeArchived = false): Bot[] {
    return this.db.prepare(includeArchived ? 'SELECT body FROM bots WHERE vm_id=? ORDER BY rowid' : "SELECT body FROM bots WHERE vm_id=? AND status!='archived' ORDER BY rowid")
      .all(vmId).map(row => parseRow(botSchema, row))
  }
  session(botId: string): BotSession | undefined {
    const row = this.db.prepare('SELECT body FROM bot_sessions WHERE bot_id=?').get(botId)
    return row ? parseRow(botSessionSchema, row) : undefined
  }
  sessionsByVm(vmId: string): BotSession[] {
    return this.db.prepare('SELECT body FROM bot_sessions WHERE vm_id=? ORDER BY rowid').all(vmId).map(row => parseRow(botSessionSchema, row))
  }
  saveSession(value: BotSession) {
    const session = botSessionSchema.parse(value)
    const old = this.session(session.botId)
    if (old && (old.id !== session.id || old.vmId !== session.vmId))
      throw new HostError('SESSION_CONFLICT', 'A identidade da área de trabalho não pode ser substituída')
    const bot = this.bot(session.botId)
    if (bot.vmId !== session.vmId) throw new HostError('SESSION_CONFLICT', 'A área de trabalho pertence a outro computador')
    this.db.prepare('INSERT INTO bot_sessions(id,bot_id,vm_id,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(session.id, session.botId, session.vmId, JSON.stringify(session))
  }
  sessionCapacity(vmId: string): SessionCapacity | undefined {
    const row = this.db.prepare('SELECT body FROM bot_vm_sessions WHERE vm_id=?').get(vmId)
    return row ? parseRow(sessionCapacitySchema, row) : undefined
  }
  sessionCapabilities(vmId: string): string[] {
    const row = this.db.prepare('SELECT capabilities FROM bot_vm_sessions WHERE vm_id=?').get(vmId)
    return row ? z.array(z.string().max(60)).max(32).parse(JSON.parse(String(row.capabilities))) : []
  }
  saveSessionCapabilities(vmId: string, capabilities: string[]) {
    this.db.prepare('UPDATE bot_vm_sessions SET capabilities=? WHERE vm_id=?').run(JSON.stringify(capabilities), vmId)
  }
  saveSessionCapacity(vmId: string, capacity: SessionCapacity) {
    this.db.prepare('INSERT INTO bot_vm_sessions(vm_id,body) VALUES(?,?) ON CONFLICT(vm_id) DO UPDATE SET body=excluded.body')
      .run(vmId, JSON.stringify(sessionCapacitySchema.parse(capacity)))
  }
  saveBot(bot: Bot) {
    botSchema.parse(bot)
    try {
      this.db
        .prepare(
          'INSERT INTO bots(id,vm_id,status,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET vm_id=excluded.vm_id,status=excluded.status,body=excluded.body'
        )
        .run(bot.id, bot.vmId ?? null, bot.status, JSON.stringify(bot))
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new HostError('VM_ALREADY_BOUND', 'This computer already belongs to another bot')
      throw error
    }
    this.store.event('bot.changed', { id: bot.id, status: bot.status, revision: bot.revision })
  }
  binding(botId: string): BotBinding | undefined {
    const row = this.db.prepare('SELECT body FROM bot_bindings WHERE bot_id=?').get(botId)
    return row ? parseRow(bindingSchema, row) : undefined
  }
  bindingByVm(vmId: string): BotBinding | undefined {
    const row = this.db.prepare('SELECT body FROM bot_bindings WHERE vm_id=?').get(vmId)
    return row ? parseRow(bindingSchema, row) : undefined
  }
  saveBinding(binding: BotBinding) {
    bindingSchema.parse(binding)
    this.db
      .prepare('INSERT INTO bot_bindings(bot_id,vm_id,body) VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE SET vm_id=excluded.vm_id,body=excluded.body')
      .run(binding.botId, binding.vmId, JSON.stringify(binding))
  }
  // Conversations and messages
  conversation(id: string): BotConversation {
    const row = this.db.prepare('SELECT body FROM bot_conversations WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Conversation not found')
    return parseRow(botConversationSchema, row)
  }
  saveConversation(conversation: BotConversation) {
    botConversationSchema.parse(conversation)
    this.db
      .prepare('INSERT INTO bot_conversations(id,bot_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(conversation.id, conversation.botId, JSON.stringify(conversation))
  }
  messages(conversationId: string, before: number | undefined, limit: number): BotMessage[] {
    return this.db
      .prepare('SELECT body FROM bot_messages WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?')
      .all(conversationId, before ?? Number.MAX_SAFE_INTEGER, limit)
      .map((row) => parseRow(botMessageSchema, row))
      .reverse()
  }
  messageByClientId(conversationId: string, clientMessageId: string): BotMessage | undefined {
    const row = this.db
      .prepare('SELECT body FROM bot_messages WHERE conversation_id=? AND client_message_id=?')
      .get(conversationId, clientMessageId)
    return row ? parseRow(botMessageSchema, row) : undefined
  }
  message(id: string): BotMessage {
    const row = this.db.prepare('SELECT body FROM bot_messages WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Message not found')
    return parseRow(botMessageSchema, row)
  }
  saveMessage(message: BotMessage) {
    botMessageSchema.parse(message)
    this.db
      .prepare('INSERT INTO bot_messages(id,conversation_id,client_message_id,sequence,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(message.id, message.conversationId, message.clientMessageId, message.sequence, JSON.stringify(message))
  }
  // Turns
  turn(id: string): BotTurn {
    const row = this.db.prepare('SELECT body FROM bot_turns WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Turn not found')
    return parseRow(botTurnSchema, row)
  }
  turns(conversationId: string, ids: readonly string[]): BotTurn[] {
    if (!ids.length) return []
    return this.db
      .prepare(`SELECT body FROM bot_turns WHERE conversation_id=? AND id IN (${ids.map(() => '?').join(',')})`)
      .all(conversationId, ...ids)
      .map((row) => parseRow(botTurnSchema, row))
  }
  activeTurn(botId: string): BotTurn | undefined {
    const row = this.db
      .prepare(
        "SELECT body FROM bot_turns WHERE bot_id=? AND status IN ('queued','starting','running','waiting_approval','waiting_input','cancelling','needs_attention')"
      )
      .get(botId)
    return row ? parseRow(botTurnSchema, row) : undefined
  }
  activeTurns(): BotTurn[] {
    return this.db
      .prepare(
        "SELECT body FROM bot_turns WHERE status IN ('queued','starting','running','waiting_approval','waiting_input','cancelling','needs_attention') ORDER BY rowid"
      )
      .all()
      .map((row) => parseRow(botTurnSchema, row))
  }
  saveTurn(turn: BotTurn) {
    botTurnSchema.parse(turn)
    try {
      this.db
        .prepare('INSERT INTO bot_turns(id,bot_id,conversation_id,status,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body')
        .run(turn.id, turn.botId, turn.conversationId, turn.status, JSON.stringify(turn))
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new HostError('BOT_BUSY', 'The bot is already working on a task')
      throw error
    }
    if (TURN_TERMINAL.has(turn.status)) this.db.prepare('DELETE FROM bot_outbox WHERE turn_id=?').run(turn.id)
  }
  // Interactions
  interaction(id: string): BotInteraction {
    const row = this.db.prepare('SELECT body FROM bot_interactions WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Interaction not found')
    return parseRow(botInteractionSchema, row)
  }
  interactions(botId: string, pendingOnly: boolean): BotInteraction[] {
    return this.db
      .prepare(pendingOnly ? "SELECT body FROM bot_interactions WHERE bot_id=? AND status='pending' ORDER BY rowid" : 'SELECT body FROM bot_interactions WHERE bot_id=? ORDER BY rowid DESC LIMIT 200')
      .all(botId)
      .map((row) => parseRow(botInteractionSchema, row))
  }
  /** Every request this turn made to the person, used to tell working time from waiting time. */
  interactionsOfTurn(turnId: string): BotInteraction[] {
    return this.db
      .prepare('SELECT body FROM bot_interactions WHERE turn_id=? ORDER BY rowid')
      .all(turnId)
      .map((row) => parseRow(botInteractionSchema, row))
  }
  interactionByAction(turnId: string, actionId: string): BotInteraction | undefined {
    const row = this.db.prepare('SELECT body FROM bot_interactions WHERE turn_id=? AND action_id=?').get(turnId, actionId)
    return row ? parseRow(botInteractionSchema, row) : undefined
  }
  saveInteraction(interaction: BotInteraction) {
    botInteractionSchema.parse(interaction)
    this.db
      .prepare('INSERT INTO bot_interactions(id,bot_id,turn_id,action_id,status,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body')
      .run(interaction.id, interaction.botId, interaction.turnId, interaction.actionId, interaction.status, JSON.stringify(interaction))
  }
  // Memory
  memories(botId: string, includeInactive: boolean): BotMemory[] {
    return this.db
      .prepare('SELECT body FROM bot_memory WHERE bot_id=? ORDER BY rowid')
      .all(botId)
      .map((row) => parseRow(botMemorySchema, row))
      .filter((memory) => includeInactive || memory.active)
  }
  memory(id: string): BotMemory {
    const row = this.db.prepare('SELECT body FROM bot_memory WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Memory not found')
    return parseRow(botMemorySchema, row)
  }
  saveMemory(memory: BotMemory) {
    botMemorySchema.parse(memory)
    this.db
      .prepare('INSERT INTO bot_memory(id,bot_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(memory.id, memory.botId, JSON.stringify(memory))
  }
  deleteMemory(id: string) {
    this.db.prepare('DELETE FROM bot_memory WHERE id=?').run(id)
  }
  // Events (append only, deduplicated by runtimeEventId per bot)
  appendEvent(event: Omit<BotEvent, 'seq'>): BotEvent | undefined {
    if (event.runtimeEventId) {
      const existing = this.db
        .prepare('SELECT seq FROM bot_events WHERE bot_id=? AND runtime_event_id=?')
        .get(event.botId, event.runtimeEventId)
      if (existing) return undefined
    }
    const result = this.db
      .prepare('INSERT INTO bot_events(bot_id,runtime_event_id,body) VALUES(?,?,?)')
      .run(event.botId, event.runtimeEventId ?? null, JSON.stringify(event))
    return botEventSchema.parse({ seq: Number(result.lastInsertRowid), ...event })
  }
  events(botId: string, after: number, limit: number, byteBudget: number): { events: BotEvent[]; hasMore: boolean } {
    const rows = this.db
      .prepare('SELECT seq,body FROM bot_events WHERE bot_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(botId, after, limit + 1) as { seq: number; body: string }[]
    const events: BotEvent[] = []
    let bytes = 0
    for (const row of rows.slice(0, limit)) {
      bytes += Buffer.byteLength(row.body) + 32
      if (events.length && bytes > byteBudget) return { events, hasMore: true }
      events.push(botEventSchema.parse({ seq: row.seq, ...JSON.parse(row.body) }))
    }
    return { events, hasMore: rows.length > limit }
  }
  // Outbox
  enqueue(item: OutboxItem) {
    outboxSchema.parse(item)
    this.db
      .prepare('INSERT INTO bot_outbox(id,bot_id,turn_id,kind,body,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(item.id, item.botId, item.turnId, item.kind, JSON.stringify(item), item.createdAt)
  }
  outbox(botId?: string): OutboxItem[] {
    return (botId
      ? this.db.prepare('SELECT body FROM bot_outbox WHERE bot_id=? ORDER BY rowid').all(botId)
      : this.db.prepare('SELECT body FROM bot_outbox ORDER BY rowid').all()
    ).map((row) => parseRow(outboxSchema, row))
  }
  dequeue(id: string) {
    this.db.prepare('DELETE FROM bot_outbox WHERE id=?').run(id)
  }
  // Operations
  operation(id: string): BotOperation {
    const row = this.db.prepare('SELECT body FROM bot_operations WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Bot operation not found')
    return parseRow(botOperationSchema, row)
  }
  operationByKey(key: string): { fingerprint: string; operation: BotOperation } | undefined {
    const row = this.db.prepare('SELECT fingerprint,body FROM bot_operations WHERE key=?').get(key) as
      | { fingerprint: string; body: string }
      | undefined
    return row ? { fingerprint: row.fingerprint, operation: botOperationSchema.parse(JSON.parse(row.body)) } : undefined
  }
  operationRequest(id: string): unknown {
    const row = this.db.prepare('SELECT request FROM bot_operations WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Bot operation not found')
    return JSON.parse(row.request as string)
  }
  operations(): BotOperation[] {
    return this.db
      .prepare('SELECT body FROM bot_operations ORDER BY rowid')
      .all()
      .map((row) => parseRow(botOperationSchema, row))
  }
  insertOperation(operation: BotOperation, key: string, fingerprint: string, request: unknown) {
    botOperationSchema.parse(operation)
    this.db
      .prepare('INSERT INTO bot_operations(id,key,fingerprint,request,body) VALUES(?,?,?,?,?)')
      .run(operation.id, key, fingerprint, JSON.stringify(request), JSON.stringify(operation))
    this.store.event('bot.operation.changed', { id: operation.id, kind: operation.kind, status: operation.status })
  }
  saveOperation(operation: BotOperation) {
    botOperationSchema.parse(operation)
    this.db.prepare('UPDATE bot_operations SET body=? WHERE id=?').run(JSON.stringify(operation), operation.id)
    this.store.event('bot.operation.changed', { id: operation.id, kind: operation.kind, status: operation.status })
  }
  // Network policy
  network(botId: string): NetworkPolicy {
    const row = this.db.prepare('SELECT body FROM bot_network WHERE bot_id=?').get(botId)
    return row ? parseRow(networkPolicySchema, row) : { mode: 'offline', domains: [], revision: 0 }
  }
  saveNetwork(botId: string, policy: NetworkPolicy) {
    networkPolicySchema.parse(policy)
    this.db
      .prepare('INSERT INTO bot_network(bot_id,body) VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET body=excluded.body')
      .run(botId, JSON.stringify(policy))
  }
  // Transfers
  transfer(id: string): TransferState & { botId: string } {
    const row = this.db.prepare('SELECT bot_id,body FROM bot_transfers WHERE id=?').get(id) as
      | { bot_id: string; body: string }
      | undefined
    if (!row) throw new HostError('NOT_FOUND', 'Transfer not found')
    return { ...transferStateSchema.parse(JSON.parse(row.body)), botId: row.bot_id }
  }
  saveTransfer(botId: string, transfer: TransferState) {
    transferStateSchema.parse(transfer)
    this.db
      .prepare('INSERT INTO bot_transfers(id,bot_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(transfer.transferId, botId, JSON.stringify(transfer))
  }
  deleteTransfer(id: string) {
    this.db.prepare('DELETE FROM bot_transfers WHERE id=?').run(id)
  }
  // Launch reservations: a vm.create idempotency key that belongs to a bot before the VM id exists.
  reserve(idempotencyKey: string, botId: string) {
    this.db.prepare('INSERT OR REPLACE INTO bot_reservations(key,bot_id) VALUES(?,?)').run(idempotencyKey, botId)
  }
  reservation(idempotencyKey: string): string | undefined {
    const row = this.db.prepare('SELECT bot_id FROM bot_reservations WHERE key=?').get(idempotencyKey) as { bot_id: string } | undefined
    return row?.bot_id
  }
  // Setup previews
  preview(id: string): BotSetupPreview | undefined {
    const row = this.db.prepare('SELECT body FROM bot_previews WHERE id=?').get(id)
    return row ? parseRow(botSetupPreviewSchema, row) : undefined
  }
  savePreview(preview: BotSetupPreview) {
    botSetupPreviewSchema.parse(preview)
    this.db.prepare('DELETE FROM bot_previews WHERE expires_at<?').run(now())
    this.db
      .prepare('INSERT INTO bot_previews(id,expires_at,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(preview.previewId, preview.expiresAt, JSON.stringify(preview))
  }
}
