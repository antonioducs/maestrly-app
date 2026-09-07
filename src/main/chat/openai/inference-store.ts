import { getDb, transaction } from '../../store'
import { updateChatMessageParts, upsertChatMessage, type StoredChatMessage } from '../chat-store'
import {
  OPENAI_DEFAULT_MODEL_HARNESS_PROFILE,
  type ModelHarnessProfileId,
} from '../model-harness-profile'
import { parseOpenAIResponsesLedger, toOpenAILedgerValue } from './ledger'
import type { OpenAICanonicalCompactionWindow, OpenAILedgerObject, OpenAIResponsesLedger } from './types'
import type { MessagePart } from '../../../shared/chat'

export const OPENAI_INFERENCE_STATE_VERSION = 4 as const

export interface OpenAIInferenceState {
  /** v2/v3 remain readable and normalize to the pre-Astra model profile. */
  version: 2 | 3 | typeof OPENAI_INFERENCE_STATE_VERSION
  providerId: string
  modelId: string
  /** SHA-256 of endpoint + protocol + credential hash; prevents opaque replay on another backend/account. */
  providerFingerprint: string
  modelHarnessProfileId?: ModelHarnessProfileId
  /** @deprecated v2/v3 compatibility fixture; parsed as openai-default-v1. */
  harnessProfile?: 'openai-responses-v1'
  /** Provider-generated items in order; never includes the caller's input messages. */
  ledger: OpenAIResponsesLedger
  /** Raw standalone window. ModelMessage is not a lossless codec for this payload. */
  canonicalWindow?: OpenAICanonicalCompactionWindow
}

function parseCanonicalWindow(value: unknown): OpenAICanonicalCompactionWindow | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<OpenAICanonicalCompactionWindow>
  if (candidate.kind !== 'responses.compact') return null
  let response: OpenAILedgerObject
  try {
    const json = toOpenAILedgerValue(candidate.response, '$.canonicalWindow.response')
    if (json === null || Array.isArray(json) || typeof json !== 'object') return null
    response = json
  } catch {
    return null
  }
  if (!Array.isArray(response.output)) return null
  const checkpoints = response.output.filter(
    (item): item is OpenAILedgerObject =>
      item !== null && !Array.isArray(item) && typeof item === 'object' && item.type === 'compaction'
  )
  if (
    checkpoints.length !== 1 ||
    typeof checkpoints[0].encrypted_content !== 'string' ||
    checkpoints[0].encrypted_content.length === 0
  )
    return null
  return { kind: 'responses.compact', response }
}

export function parseOpenAIInferenceState(value: unknown): OpenAIInferenceState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<OpenAIInferenceState> & { harnessProfile?: unknown }
  // v2 had no canonicalWindow; v2/v3 used the transport profile as their sidecar identity.
  if (![2, 3, OPENAI_INFERENCE_STATE_VERSION].includes(Number(state.version))) return null
  const modelHarnessProfileId =
    typeof state.modelHarnessProfileId === 'string'
      ? state.modelHarnessProfileId
      : state.harnessProfile === 'openai-responses-v1'
        ? OPENAI_DEFAULT_MODEL_HARNESS_PROFILE
        : null
  if (
    modelHarnessProfileId !== 'openai-default-v1' &&
    modelHarnessProfileId !== 'openai-gpt-5.6-sol-v1' &&
    modelHarnessProfileId !== 'openai-gpt-6-astra-v1'
  )
    return null
  if (typeof state.providerId !== 'string' || !state.providerId) return null
  if (typeof state.modelId !== 'string' || !state.modelId) return null
  if (typeof state.providerFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(state.providerFingerprint)) return null
  try {
    const canonicalWindow =
      state.canonicalWindow === undefined ? undefined : parseCanonicalWindow(state.canonicalWindow)
    if (state.canonicalWindow !== undefined && !canonicalWindow) return null
    return {
      version:
        Number(state.version) === 2 ? 2 : Number(state.version) === 3 ? 3 : OPENAI_INFERENCE_STATE_VERSION,
      providerId: state.providerId,
      modelId: state.modelId,
      providerFingerprint: state.providerFingerprint,
      ...(typeof state.modelHarnessProfileId === 'string'
        ? { modelHarnessProfileId }
        : { harnessProfile: 'openai-responses-v1' as const }),
      ledger: parseOpenAIResponsesLedger(state.ledger),
      ...(canonicalWindow ? { canonicalWindow } : {}),
    }
  } catch {
    return null
  }
}

/** Minimum identity required before inserting opaque items into another request's input. */
export function canReplayOpenAIInferenceState(
  state: OpenAIInferenceState,
  current: Pick<OpenAIInferenceState, 'providerId' | 'modelId' | 'providerFingerprint' | 'modelHarnessProfileId'>
): boolean {
  return (
    state.providerId === current.providerId &&
    state.modelId === current.modelId &&
    state.providerFingerprint === current.providerFingerprint &&
    (state.modelHarnessProfileId ?? OPENAI_DEFAULT_MODEL_HARNESS_PROFILE) ===
      (current.modelHarnessProfileId ?? OPENAI_DEFAULT_MODEL_HARNESS_PROFILE)
  )
}

/** Read the main-only sidecar. Missing/corrupt rows fall back to the legacy codec without breaking chat. */
export function getOpenAIInferenceState(messageId: string): OpenAIInferenceState | null {
  const row = getDb().prepare('SELECT state_json FROM chat_inference_state WHERE message_id = ?').get(messageId) as
    | { state_json: string }
    | undefined
  if (!row) return null
  try {
    return parseOpenAIInferenceState(JSON.parse(row.state_json))
  } catch {
    return null
  }
}

/** Atomically replace the assistant message's complete checkpoint. */
export function putOpenAIInferenceState(messageId: string, state: OpenAIInferenceState): void {
  getDb()
    .prepare(
      `INSERT INTO chat_inference_state
         (message_id, provider_id, model_id, harness_profile, state_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         provider_id = excluded.provider_id,
         model_id = excluded.model_id,
         harness_profile = excluded.harness_profile,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`
    )
    .run(
      messageId,
      state.providerId,
      state.modelId,
      state.modelHarnessProfileId ?? OPENAI_DEFAULT_MODEL_HARNESS_PROFILE,
      JSON.stringify(state),
      Date.now()
    )
}

/** Visual message + sidecar form one logical checkpoint; either statement failing rolls back both. */
export function putChatMessageWithOpenAIInferenceState(
  message: StoredChatMessage,
  state: OpenAIInferenceState,
  beforeWrite?: () => void,
): void {
  transaction(() => {
    beforeWrite?.()
    upsertChatMessage(message)
    putOpenAIInferenceState(message.id, state)
  })
}

export function deleteOpenAIInferenceState(messageId: string): void {
  getDb().prepare('DELETE FROM chat_inference_state WHERE message_id = ?').run(messageId)
}

/**
 * Post-turn enrichment of the OpenAI checkpoint (visual message + sidecar): UPDATE-only and atomic within one
 * BEGIN/COMMIT. Never inserts: if the message row was removed (clear/delete/truncate), the sidecar is not
 * recreated and the function returns false. The caller must reread CURRENT state (not a stale snapshot) and patch
 * it.
 */
export function updateChatMessageWithOpenAIInferenceState(
  conversationId: string,
  messageId: string,
  parts: MessagePart[],
  state: OpenAIInferenceState
): boolean {
  let updated = false
  transaction(() => {
    // UPDATE-only: removed message means `changes === 0`; no sidecar is written or resurrected.
    if (!updateChatMessageParts(conversationId, messageId, parts)) return
    putOpenAIInferenceState(messageId, state)
    updated = true
  })
  return updated
}

export interface ToolExecutionRecord {
  conversationId: string
  /** Assistant message owning the execution; clear/edit/delete remove the checkpoint via FK CASCADE. */
  messageId: string
  callId: string
  toolName: string
  inputHash: string
  status: 'running' | 'completed' | 'error' | 'denied' | 'uncertain'
  output?: unknown
}

export function getToolExecution(conversationId: string, callId: string): ToolExecutionRecord | null {
  const row = getDb()
    .prepare(
      `SELECT conversation_id, message_id, call_id, tool_name, input_hash, status, output_json
       FROM chat_tool_executions WHERE conversation_id = ? AND call_id = ?`
    )
    .get(conversationId, callId) as
    | {
        conversation_id: string
        message_id: string
        call_id: string
        tool_name: string
        input_hash: string
        status: ToolExecutionRecord['status']
        output_json: string | null
      }
    | undefined
  if (!row) return null
  let output: unknown
  try {
    output = row.output_json == null ? undefined : JSON.parse(row.output_json)
  } catch {
    output = undefined
  }
  return {
    conversationId: row.conversation_id,
    messageId: row.message_id,
    callId: row.call_id,
    toolName: row.tool_name,
    inputHash: row.input_hash,
    status: row.status,
    ...(row.output_json != null ? { output } : {}),
  }
}

export function putToolExecution(record: ToolExecutionRecord): void {
  getDb()
    .prepare(
      `INSERT INTO chat_tool_executions
         (conversation_id, message_id, call_id, tool_name, input_hash, status, output_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, call_id) DO UPDATE SET
         message_id = excluded.message_id,
         tool_name = excluded.tool_name,
         input_hash = excluded.input_hash,
         status = excluded.status,
         output_json = excluded.output_json,
         updated_at = excluded.updated_at`
    )
    .run(
      record.conversationId,
      record.messageId,
      record.callId,
      record.toolName,
      record.inputHash,
      record.status,
      record.output === undefined ? null : JSON.stringify(record.output),
      Date.now()
    )
}
