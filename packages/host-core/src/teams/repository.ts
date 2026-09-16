import type { DatabaseSync } from 'node:sqlite'
import {
  TEAM_EVENTS_PAGE_BUDGET,
  TEAM_RUN_TERMINAL,
  TEAM_TASK_ACTIVE,
  teamArtifactGrantSchema,
  teamArtifactSchema,
  teamConversationSchema,
  teamEventSchema,
  teamMemberSchema,
  teamMemorySchema,
  teamMessageSchema,
  teamOperationSchema,
  teamRunSchema,
  teamSchema,
  teamTaskAttemptSchema,
  teamTaskSchema,
  teamTransferStateSchema,
  type Team,
  type TeamArtifact,
  type TeamArtifactGrant,
  type TeamConversation,
  type TeamEvent,
  type TeamMember,
  type TeamMemory,
  type TeamMessage,
  type TeamOperation,
  type TeamRun,
  type TeamTask,
  type TeamTaskAttempt,
  type TeamTransferState,
} from '@maestrly/host-protocol'
import { z } from 'zod'
import { HostError } from '../errors.js'
import type { HostStore } from '../persistence/store.js'

export const now = () => new Date().toISOString()
const parseRow = <T>(schema: { parse(value: unknown): T }, row: unknown): T => schema.parse(JSON.parse((row as { body: string }).body))
/** A recorded answer to a guest collaboration request; replayed instead of acted on twice. */
export const collaborationReceiptSchema = z.strictObject({
  turnId: z.string(),
  requestId: z.string(),
  method: z.string(),
  fingerprint: z.string(),
  response: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})
export type CollaborationReceipt = z.infer<typeof collaborationReceiptSchema>

/**
 * Durable state of the teams domain. It shares the HostStore connection and transaction so
 * a delegation, its tasks, its outbox work and its budget reservation commit together or
 * not at all. No bytes of a shared file are ever stored here: artifacts live as verified
 * files under the Host state directory and are referenced by identity, version and digest.
 */
export class TeamRepository {
  readonly db: DatabaseSync
  constructor(readonly store: HostStore) {
    this.db = store.db
  }
  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn)
  }
  // Teams and members
  teams(includeArchived = false): Team[] {
    return this.db
      .prepare(includeArchived ? 'SELECT body FROM teams ORDER BY rowid' : "SELECT body FROM teams WHERE status!='archived' ORDER BY rowid")
      .all()
      .map((row) => parseRow(teamSchema, row))
  }
  team(id: string): Team {
    const row = this.db.prepare('SELECT body FROM teams WHERE id=?').get(id)
    if (!row) throw new HostError('TEAM_NOT_FOUND', 'Esta equipe não existe neste Host')
    return parseRow(teamSchema, row)
  }
  teamsOfBot(botId: string): Team[] {
    return this.db
      .prepare('SELECT t.body FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.bot_id=? ORDER BY t.rowid')
      .all(botId)
      .map((row) => parseRow(teamSchema, row))
  }
  saveTeam(team: Team) {
    teamSchema.parse(team)
    this.db
      .prepare(
        'INSERT INTO teams(id,host_id,status,coordinator_bot_id,conversation_id,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,coordinator_bot_id=excluded.coordinator_bot_id,body=excluded.body'
      )
      .run(team.id, team.hostId, team.status, team.coordinatorBotId, team.conversationId, JSON.stringify(team))
    this.store.event('team.changed', { id: team.id, status: team.status, revision: team.revision })
  }
  members(teamId: string, activeOnly = false): TeamMember[] {
    return this.db
      .prepare('SELECT body FROM team_members WHERE team_id=? ORDER BY rowid')
      .all(teamId)
      .map((row) => parseRow(teamMemberSchema, row))
      .filter((member) => !activeOnly || member.active)
  }
  member(teamId: string, botId: string): TeamMember | undefined {
    const row = this.db.prepare('SELECT body FROM team_members WHERE team_id=? AND bot_id=?').get(teamId, botId)
    return row ? parseRow(teamMemberSchema, row) : undefined
  }
  saveMember(member: TeamMember) {
    teamMemberSchema.parse(member)
    try {
      this.db
        .prepare('INSERT INTO team_members(id,team_id,bot_id,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
        .run(member.id, member.teamId, member.botId, JSON.stringify(member))
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new HostError('TEAM_MEMBER_INVALID', 'Este bot já participa da equipe')
      throw error
    }
  }
  removeMember(id: string) {
    this.db.prepare('DELETE FROM team_members WHERE id=?').run(id)
  }
  // Conversation and messages
  conversation(id: string): TeamConversation {
    const row = this.db.prepare('SELECT body FROM team_conversations WHERE id=?').get(id)
    if (!row) throw new HostError('TEAM_NOT_FOUND', 'A conversa desta equipe não existe')
    return parseRow(teamConversationSchema, row)
  }
  saveConversation(conversation: TeamConversation) {
    teamConversationSchema.parse(conversation)
    this.db
      .prepare('INSERT INTO team_conversations(id,team_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(conversation.id, conversation.teamId, JSON.stringify(conversation))
  }
  messages(conversationId: string, before: number | undefined, limit: number): TeamMessage[] {
    return this.db
      .prepare('SELECT body FROM team_messages WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?')
      .all(conversationId, before ?? Number.MAX_SAFE_INTEGER, limit)
      .map((row) => parseRow(teamMessageSchema, row))
      .reverse()
  }
  messageById(id: string): TeamMessage {
    const row = this.db.prepare('SELECT body FROM team_messages WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Esta mensagem de equipe não existe')
    return parseRow(teamMessageSchema, row)
  }
  messageByClientId(conversationId: string, clientMessageId: string): TeamMessage | undefined {
    const row = this.db.prepare('SELECT body FROM team_messages WHERE conversation_id=? AND client_message_id=?').get(conversationId, clientMessageId)
    return row ? parseRow(teamMessageSchema, row) : undefined
  }
  saveMessage(message: TeamMessage) {
    teamMessageSchema.parse(message)
    this.db
      .prepare(
        'INSERT INTO team_messages(id,conversation_id,client_message_id,sequence,run_id,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body'
      )
      .run(message.id, message.conversationId, message.clientMessageId, message.sequence, message.runId ?? null, JSON.stringify(message))
  }
  // Runs
  run(id: string): TeamRun {
    const row = this.db.prepare('SELECT body FROM team_runs WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Este trabalho de equipe não existe')
    return parseRow(teamRunSchema, row)
  }
  runsByIds(ids: readonly string[]): TeamRun[] {
    if (!ids.length) return []
    return this.db
      .prepare(`SELECT body FROM team_runs WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids)
      .map((row) => parseRow(teamRunSchema, row))
  }
  activeRun(conversationId: string): TeamRun | undefined {
    const row = this.db
      .prepare(
        "SELECT body FROM team_runs WHERE conversation_id=? AND status IN ('queued','planning','working','reviewing','waiting_user','paused','needs_attention','cancelling')"
      )
      .get(conversationId)
    return row ? parseRow(teamRunSchema, row) : undefined
  }
  activeRuns(): TeamRun[] {
    return this.db
      .prepare(
        "SELECT body FROM team_runs WHERE status IN ('queued','planning','working','reviewing','waiting_user','paused','needs_attention','cancelling') ORDER BY rowid"
      )
      .all()
      .map((row) => parseRow(teamRunSchema, row))
  }
  activeRunsOfTeam(teamId: string): TeamRun[] {
    return this.activeRuns().filter((run) => run.teamId === teamId)
  }
  saveRun(run: TeamRun) {
    teamRunSchema.parse(run)
    try {
      this.db
        .prepare(
          'INSERT INTO team_runs(id,team_id,conversation_id,message_id,status,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body'
        )
        .run(run.id, run.teamId, run.conversationId, run.messageId, run.status, JSON.stringify(run))
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new HostError('TEAM_RUN_ACTIVE', 'Esta equipe já está trabalhando em um pedido')
      throw error
    }
    this.store.event('team.run.changed', { id: run.id, teamId: run.teamId, status: run.status, revision: run.revision })
  }
  // Tasks
  task(id: string): TeamTask {
    const row = this.db.prepare('SELECT body FROM team_tasks WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Esta tarefa de equipe não existe')
    return parseRow(teamTaskSchema, row)
  }
  tasks(runId: string): TeamTask[] {
    return this.db
      .prepare('SELECT body FROM team_tasks WHERE run_id=? ORDER BY rowid')
      .all(runId)
      .map((row) => parseRow(teamTaskSchema, row))
  }
  taskByKey(runId: string, round: number, localKey: string): TeamTask | undefined {
    const row = this.db.prepare('SELECT body FROM team_tasks WHERE run_id=? AND round=? AND local_task_key=?').get(runId, round, localKey)
    return row ? parseRow(teamTaskSchema, row) : undefined
  }
  /** Tasks that currently occupy a bot, across every run and team of this Host. */
  activeTasksOfBot(botId: string): TeamTask[] {
    return this.db
      .prepare(`SELECT body FROM team_tasks WHERE assignee_bot_id=? AND status IN (${[...TEAM_TASK_ACTIVE].map(() => '?').join(',')})`)
      .all(botId, ...TEAM_TASK_ACTIVE)
      .map((row) => parseRow(teamTaskSchema, row))
  }
  activeTaskCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM team_tasks WHERE status IN (${[...TEAM_TASK_ACTIVE].map(() => '?').join(',')})`)
      .get(...TEAM_TASK_ACTIVE) as { total: number }
    return row.total
  }
  saveTask(task: TeamTask) {
    teamTaskSchema.parse(task)
    this.db
      .prepare(
        'INSERT INTO team_tasks(id,run_id,team_id,round,local_task_key,assignee_bot_id,status,body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body'
      )
      .run(task.id, task.runId, task.teamId, task.round, task.localKey, task.assigneeBotId, task.status, JSON.stringify(task))
    for (const dependency of task.dependsOn)
      this.db.prepare('INSERT OR IGNORE INTO team_task_dependencies(task_id,depends_on_task_id) VALUES(?,?)').run(task.id, dependency)
    this.store.event('team.task.changed', { id: task.id, runId: task.runId, status: task.status })
  }
  // Attempts: one task, many physical turns
  attempt(id: string): TeamTaskAttempt {
    const row = this.db.prepare('SELECT body FROM team_task_turns WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Esta tentativa não existe')
    return parseRow(teamTaskAttemptSchema, row)
  }
  attemptByTurn(turnId: string): TeamTaskAttempt | undefined {
    const row = this.db.prepare('SELECT body FROM team_task_turns WHERE turn_id=?').get(turnId)
    return row ? parseRow(teamTaskAttemptSchema, row) : undefined
  }
  attempts(taskId: string): TeamTaskAttempt[] {
    return this.db
      .prepare('SELECT body FROM team_task_turns WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map((row) => parseRow(teamTaskAttemptSchema, row))
  }
  attemptsOfRun(runId: string): TeamTaskAttempt[] {
    return this.db
      .prepare('SELECT body FROM team_task_turns WHERE run_id=? ORDER BY rowid')
      .all(runId)
      .map((row) => parseRow(teamTaskAttemptSchema, row))
  }
  saveAttempt(attempt: TeamTaskAttempt) {
    teamTaskAttemptSchema.parse(attempt)
    try {
      this.db
        .prepare(
          'INSERT INTO team_task_turns(id,task_id,run_id,turn_id,bot_id,settled,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET settled=excluded.settled,body=excluded.body'
        )
        .run(attempt.id, attempt.taskId, attempt.runId, attempt.turnId, attempt.botId, attempt.settled ? 1 : 0, JSON.stringify(attempt))
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new HostError('TEAM_BUSY', 'Este turno já pertence a outra tarefa de equipe')
      throw error
    }
  }
  // Events
  appendEvent(event: Omit<TeamEvent, 'seq'>): TeamEvent {
    const result = this.db.prepare('INSERT INTO team_events(team_id,run_id,body) VALUES(?,?,?)').run(event.teamId, event.runId ?? null, JSON.stringify(event))
    return teamEventSchema.parse({ seq: Number(result.lastInsertRowid), ...event })
  }
  events(teamId: string, after: number, limit: number): { events: TeamEvent[]; hasMore: boolean } {
    const rows = this.db
      .prepare('SELECT seq,body FROM team_events WHERE team_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(teamId, after, limit + 1) as { seq: number; body: string }[]
    const events: TeamEvent[] = []
    let bytes = 0
    for (const row of rows.slice(0, limit)) {
      bytes += Buffer.byteLength(row.body) + 32
      if (events.length && bytes > TEAM_EVENTS_PAGE_BUDGET) return { events, hasMore: true }
      events.push(teamEventSchema.parse({ seq: row.seq, ...JSON.parse(row.body) }))
    }
    return { events, hasMore: rows.length > limit }
  }
  // Collaboration receipts (guest → Host requests)
  receipt(turnId: string, requestId: string): CollaborationReceipt | undefined {
    const row = this.db.prepare('SELECT turn_id,request_id,method,fingerprint,response,created_at FROM team_requests WHERE turn_id=? AND request_id=?').get(turnId, requestId) as
      | { turn_id: string; request_id: string; method: string; fingerprint: string; response: string; created_at: string }
      | undefined
    return row
      ? collaborationReceiptSchema.parse({
          turnId: row.turn_id,
          requestId: row.request_id,
          method: row.method,
          fingerprint: row.fingerprint,
          response: JSON.parse(row.response),
          createdAt: row.created_at,
        })
      : undefined
  }
  saveReceipt(receipt: CollaborationReceipt) {
    collaborationReceiptSchema.parse(receipt)
    this.db
      .prepare('INSERT INTO team_requests(id,turn_id,request_id,method,fingerprint,response,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(
        `${receipt.turnId}:${receipt.requestId}`,
        receipt.turnId,
        receipt.requestId,
        receipt.method,
        receipt.fingerprint,
        JSON.stringify(receipt.response),
        receipt.createdAt
      )
  }
  // Team memory
  memories(teamId: string, includeInactive: boolean): TeamMemory[] {
    return this.db
      .prepare('SELECT body FROM team_memory WHERE team_id=? ORDER BY rowid')
      .all(teamId)
      .map((row) => parseRow(teamMemorySchema, row))
      .filter((memory) => (includeInactive ? memory.status !== 'removed' : memory.status === 'active'))
  }
  memory(id: string): TeamMemory {
    const row = this.db.prepare('SELECT body FROM team_memory WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Esta memória de equipe não existe')
    return parseRow(teamMemorySchema, row)
  }
  proposals(teamId: string): TeamMemory[] {
    return this.db
      .prepare("SELECT body FROM team_memory WHERE team_id=? AND status='proposed' ORDER BY rowid")
      .all(teamId)
      .map((row) => parseRow(teamMemorySchema, row))
  }
  saveMemory(memory: TeamMemory) {
    teamMemorySchema.parse(memory)
    this.db
      .prepare('INSERT INTO team_memory(id,team_id,status,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body')
      .run(memory.id, memory.teamId, memory.status, JSON.stringify(memory))
  }
  // Artifacts and grants
  artifact(id: string): TeamArtifact {
    const row = this.db.prepare('SELECT body FROM team_artifacts WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Este arquivo compartilhado não existe')
    return parseRow(teamArtifactSchema, row)
  }
  artifacts(teamId: string, includeRevoked = false): TeamArtifact[] {
    return this.db
      .prepare('SELECT body FROM team_artifacts WHERE team_id=? ORDER BY rowid')
      .all(teamId)
      .map((row) => parseRow(teamArtifactSchema, row))
      .filter((artifact) => includeRevoked || artifact.state === 'available')
  }
  /** Bytes already committed to this team's shared copies, staging included. */
  sharedBytes(teamId: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(size),0) AS total FROM team_artifacts WHERE team_id=? AND state!='revoked'").get(teamId) as { total: number }
    return Number(row.total)
  }
  saveArtifact(artifact: TeamArtifact) {
    teamArtifactSchema.parse(artifact)
    this.db
      .prepare(
        'INSERT INTO team_artifacts(id,team_id,state,size,digest,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,size=excluded.size,digest=excluded.digest,body=excluded.body'
      )
      .run(artifact.id, artifact.teamId, artifact.state, artifact.size, artifact.digest, JSON.stringify(artifact))
  }
  grant(artifactId: string, botId: string, runId: string): TeamArtifactGrant | undefined {
    const row = this.db.prepare('SELECT body FROM team_artifact_grants WHERE artifact_id=? AND bot_id=? AND run_id=?').get(artifactId, botId, runId)
    return row ? parseRow(teamArtifactGrantSchema, row) : undefined
  }
  grantsOfArtifact(artifactId: string): TeamArtifactGrant[] {
    return this.db
      .prepare('SELECT body FROM team_artifact_grants WHERE artifact_id=? ORDER BY rowid')
      .all(artifactId)
      .map((row) => parseRow(teamArtifactGrantSchema, row))
  }
  grantsOfRun(runId: string): TeamArtifactGrant[] {
    return this.db
      .prepare('SELECT body FROM team_artifact_grants WHERE run_id=? ORDER BY rowid')
      .all(runId)
      .map((row) => parseRow(teamArtifactGrantSchema, row))
  }
  saveGrant(grant: TeamArtifactGrant) {
    teamArtifactGrantSchema.parse(grant)
    this.db
      .prepare(
        'INSERT INTO team_artifact_grants(id,artifact_id,team_id,bot_id,run_id,state,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body'
      )
      .run(grant.id, grant.artifactId, grant.teamId, grant.botId, grant.runId, grant.state, JSON.stringify(grant))
  }
  // Transfers between the app and the Host copy of an artifact
  transfer(id: string): TeamTransferState {
    const row = this.db.prepare('SELECT body FROM team_transfers WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Transferência não encontrada')
    return parseRow(teamTransferStateSchema, row)
  }
  saveTransfer(transfer: TeamTransferState) {
    teamTransferStateSchema.parse(transfer)
    const { dataBase64: _chunk, artifact: _artifact, ...durable } = transfer
    this.db
      .prepare('INSERT INTO team_transfers(id,team_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(transfer.transferId, transfer.teamId, JSON.stringify(durable))
  }
  deleteTransfer(id: string) {
    this.db.prepare('DELETE FROM team_transfers WHERE id=?').run(id)
  }
  // Operations and idempotency
  operation(id: string): TeamOperation {
    const row = this.db.prepare('SELECT body FROM team_operations WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Operação de equipe não encontrada')
    return parseRow(teamOperationSchema, row)
  }
  operationByKey(key: string): { fingerprint: string; operation: TeamOperation } | undefined {
    const row = this.db.prepare('SELECT fingerprint,body FROM team_operations WHERE key=?').get(key) as { fingerprint: string; body: string } | undefined
    return row ? { fingerprint: row.fingerprint, operation: teamOperationSchema.parse(JSON.parse(row.body)) } : undefined
  }
  insertOperation(operation: TeamOperation, key: string, fingerprint: string, request: unknown) {
    teamOperationSchema.parse(operation)
    this.db
      .prepare('INSERT INTO team_operations(id,key,fingerprint,team_id,run_id,request,body) VALUES(?,?,?,?,?,?,?)')
      .run(operation.id, key, fingerprint, operation.teamId ?? null, operation.runId ?? null, JSON.stringify(request), JSON.stringify(operation))
    this.store.event('team.operation.changed', { id: operation.id, kind: operation.kind, status: operation.status })
  }
  saveOperation(operation: TeamOperation) {
    teamOperationSchema.parse(operation)
    this.db.prepare('UPDATE team_operations SET body=? WHERE id=?').run(JSON.stringify(operation), operation.id)
    this.store.event('team.operation.changed', { id: operation.id, kind: operation.kind, status: operation.status })
  }
  /** True when no run of this team can still start, change or finish work. */
  quiet(teamId: string) {
    return this.activeRunsOfTeam(teamId).every((run) => TEAM_RUN_TERMINAL.has(run.status))
  }
}
