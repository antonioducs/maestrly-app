import type { ChatUpload } from '@maestrly/protocol'
import { getDb } from '../store'
export function chatConversation(instanceId: string, sessionId: string): string | null {
  return (
    (
      getDb()
        .prepare('select conversation_id from platform_chat_sessions where instance_id=? and session_id=?')
        .get(instanceId, sessionId) as { conversation_id: string } | undefined
    )?.conversation_id ?? null
  )
}
export function bindChatConversation(instanceId: string, sessionId: string, conversationId: string) {
  getDb()
    .prepare('insert into platform_chat_sessions(instance_id,session_id,conversation_id) values(?,?,?)')
    .run(instanceId, sessionId, conversationId)
}
export function admitChatTurn(instanceId: string, turnId: string, leaseId: string): boolean {
  return (
    getDb()
      .prepare("insert or ignore into platform_chat_turns(turn_id,instance_id,lease_id,state) values(?,?,?,'running')")
      .run(turnId, instanceId, leaseId).changes > 0
  )
}
export interface StoredChatTurn {
  turn_id: string
  lease_id: string
  state: string
  completion: string | null
}
export function pendingChatTurns(instanceId: string): StoredChatTurn[] {
  return getDb()
    .prepare("select * from platform_chat_turns where instance_id=? and state<>'done'")
    .all(instanceId) as unknown as StoredChatTurn[]
}
export function queueChatEvent(turnId: string, event: ChatUpload) {
  const size = (
    getDb()
      .prepare('select coalesce(sum(length(payload)),0) as bytes from platform_chat_outbox where turn_id=?')
      .get(turnId) as { bytes: number }
  ).bytes
  if (size > 8_000_000) throw new Error('Chat upload buffer is full; generation stopped to preserve the transcript.')
  getDb()
    .prepare('insert into platform_chat_outbox(turn_id,event_id,payload) values(?,?,?)')
    .run(turnId, event.eventId, JSON.stringify(event.payload))
}
export function chatOutbox(turnId: string): ChatUpload[] {
  return (
    getDb()
      .prepare('select event_id,payload from platform_chat_outbox where turn_id=? order by seq limit 40')
      .all(turnId) as Array<{ event_id: string; payload: string }>
  ).map((r) => ({ eventId: r.event_id, payload: JSON.parse(r.payload) }))
}
export function ackChatEvents(ids: string[]) {
  const stmt = getDb().prepare('delete from platform_chat_outbox where event_id=?')
  for (const id of ids) stmt.run(id)
}
export function recordChatCompletion(turnId: string, completion: unknown) {
  getDb()
    .prepare("update platform_chat_turns set state='finishing',completion=? where turn_id=?")
    .run(JSON.stringify(completion), turnId)
}
export function finishLocalChatTurn(turnId: string) {
  getDb().prepare("update platform_chat_turns set state='done' where turn_id=?").run(turnId)
  getDb().prepare('delete from platform_chat_outbox where turn_id=?').run(turnId)
}
