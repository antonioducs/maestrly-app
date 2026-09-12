import type { StructuredAgentMentionDraft } from './chat-agent-mentions'

/** Limits are expressed in UTF-8 bytes so renderer and main can apply the same contract. */
export const MAESTRO_LIVE_MAX_MESSAGE_BYTES = 16 * 1024
export const MAESTRO_LIVE_MAX_PENDING_MESSAGES = 50
export const MAESTRO_LIVE_MAX_PENDING_BYTES = 128 * 1024
export const MAESTRO_LIVE_DEFAULT_CLAIM_MESSAGES = MAESTRO_LIVE_MAX_PENDING_MESSAGES
export const MAESTRO_LIVE_DEFAULT_CLAIM_BYTES = 24 * 1024

export type MaestroLiveRunStatus = 'active' | 'completed' | 'error' | 'aborted' | 'interrupted'
export type MaestroLiveMessageStatus = 'pending' | 'embedded' | 'rolled_over' | 'cancelled'

/** Renderer-safe projection of one user message posted while a Maestro run is active. */
export interface MaestroLiveMessage {
  id: string
  runId: string
  seq: number
  text: string
  agentMentions: StructuredAgentMentionDraft[]
  status: MaestroLiveMessageStatus
  checkpointId: string | null
  createdAt: number
  embeddedAt: number | null
}

/** Run identity plus cheap counters used to keep the composer/banner in sync without returning the whole queue. */
export interface MaestroLiveRunSnapshot {
  id: string
  conversationId: string
  assistantMessageId: string | null
  status: MaestroLiveRunStatus
  startedAt: number
  finishedAt: number | null
  messageCount: number
  pendingCount: number
  embeddedCount: number
  rolledOverCount: number
  cancelledCount: number
  lastMessageSeq: number | null
}

export interface MaestroLiveState {
  run: MaestroLiveRunSnapshot
  messages: MaestroLiveMessage[]
}

export interface MaestroLivePostInput {
  /** Stale-run guard: a post must target the exact active host run shown by the renderer. */
  runId: string
  text: string
  agentMentions?: readonly StructuredAgentMentionDraft[]
}

export type MaestroLivePostError =
  | 'invalid-input'
  | 'run-not-active'
  | 'message-too-large'
  | 'pending-count-limit'
  | 'pending-bytes-limit'

export type MaestroLivePostResult =
  | { ok: true; message: MaestroLiveMessage; run: MaestroLiveRunSnapshot }
  | { ok: false; error: MaestroLivePostError }

/** All variants contain only structured-clone/IPC-safe values. */
export type MaestroLiveEvent =
  | { kind: 'run-updated'; run: MaestroLiveRunSnapshot }
  | { kind: 'message-posted'; run: MaestroLiveRunSnapshot; message: MaestroLiveMessage }
  | { kind: 'messages-updated'; run: MaestroLiveRunSnapshot; messages: MaestroLiveMessage[] }

export interface MaestroLiveCheckpointDelivery {
  deliveryId: string
  messageIds: string[]
  output: string
}

export const MAESTRO_LIVE_ENVELOPE_START = '<maestrly-user-updates version="1" delivery='
export const MAESTRO_LIVE_ENVELOPE_END = '</maestrly-user-updates>'
// Stays below MAX_PERSISTED_TOOL_OUTPUT_CHARS (50k) so replay keeps the complete trailing update envelope.
const MAESTRO_LIVE_CHECKPOINT_MAX_CHARS = 49_000

/** Adds host-authenticated user updates to the model-facing root delegate output. */
export function appendMaestroLiveEnvelope(
  workerOutput: string,
  deliveryId: string,
  messages: readonly MaestroLiveMessage[]
): string {
  if (messages.length === 0) return workerOutput
  const payload = messages.map((message) => ({
    id: message.id,
    sentAt: message.createdAt,
    selectedAgents: [...new Set(message.agentMentions.map((mention) => mention.name))],
    text: message.text,
  }))
  const envelope = `\n\n${MAESTRO_LIVE_ENVELOPE_START}${JSON.stringify(deliveryId)}>\n${JSON.stringify(payload)}\n${MAESTRO_LIVE_ENVELOPE_END}`
  const available = Math.max(0, MAESTRO_LIVE_CHECKPOINT_MAX_CHARS - envelope.length)
  const clipped =
    workerOutput.length > available
      ? `${workerOutput.slice(0, Math.max(0, available - 30))}\n… worker output truncated …`
      : workerOutput
  return `${clipped}${envelope}`
}

/** Renderer-only projection: persisted/model history intentionally retains the envelope. */
export function stripMaestroLiveEnvelope(text: string): string {
  const start = text.lastIndexOf(`\n\n${MAESTRO_LIVE_ENVELOPE_START}`)
  if (start < 0 || !text.endsWith(MAESTRO_LIVE_ENVELOPE_END)) return text
  return text.slice(0, start).trimEnd()
}
