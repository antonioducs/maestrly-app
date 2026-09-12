import type { ModelMessage } from 'ai'

/** Strict JSON: can cross SQLite/JSON without Date, bigint, Buffer, or undefined. */
export type OpenAILedgerValue =
  | null
  | string
  | number
  | boolean
  | OpenAILedgerValue[]
  | { [key: string]: OpenAILedgerValue }

export type OpenAILedgerObject = { [key: string]: OpenAILedgerValue }

/**
 * Standalone response kept raw: its `output` must return to the next /responses without passing through
 * ModelMessage.
 */
export interface OpenAICanonicalCompactionWindow {
  kind: 'responses.compact'
  response: OpenAILedgerObject
}

export type OpenAIToolResultOutput =
  | { type: 'text'; value: string; providerOptions?: OpenAILedgerObject }
  | { type: 'json'; value: OpenAILedgerValue; providerOptions?: OpenAILedgerObject }
  | { type: 'execution-denied'; reason?: string; providerOptions?: OpenAILedgerObject }
  | { type: 'error-text'; value: string; providerOptions?: OpenAILedgerObject }
  | { type: 'error-json'; value: OpenAILedgerValue; providerOptions?: OpenAILedgerObject }
  /** Safe host-owned projection of a multimodal result. `value` contains opaque image refs, never bytes. */
  | { type: 'maestrly-output'; value: OpenAILedgerValue; providerOptions?: OpenAILedgerObject }

interface OpenAILedgerEntryBase {
  /** Provider-returned metadata. Replayed as AI SDK providerOptions. */
  providerMetadata?: OpenAILedgerObject
}

export type OpenAILedgerEntry =
  | ({
      type: 'input-message'
      role: 'system' | 'user'
      content: OpenAILedgerValue
    } & OpenAILedgerEntryBase)
  | ({
      type: 'assistant-text'
      streamId: string
      text: string
      status: 'streaming' | 'complete'
    } & OpenAILedgerEntryBase)
  | ({
      type: 'assistant-reasoning'
      streamId: string
      text: string
      status: 'streaming' | 'complete'
    } & OpenAILedgerEntryBase)
  | ({
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: OpenAILedgerValue
      providerExecuted?: boolean
    } & OpenAILedgerEntryBase)
  | ({
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: OpenAIToolResultOutput
      providerExecuted?: boolean
    } & OpenAILedgerEntryBase)
  | ({
      type: 'step-boundary'
      finishReason?: string
      responseId?: string
    } & OpenAILedgerEntryBase)
  | ({
      /** Opaque server-side context checkpoint emitted by Responses context_management. */
      type: 'compaction'
      itemId: string
      encryptedContent: string
    } & OpenAILedgerEntryBase)
  | ({
      /**
       * An item AI SDK 7 ModelMessage cannot represent losslessly. It stays in the database, and replay tells the
       * caller to use raw ResponseItem transport instead of silently dropping it.
       */
      type: 'opaque-response-item'
      itemType: string
      item: OpenAILedgerValue
    } & OpenAILedgerEntryBase)

export interface OpenAIResponsesLedger {
  version: 1
  provider: 'openai-responses'
  /** The ledger supports complete local replay; it never depends on OpenAI Responses storage. */
  store: false
  entries: OpenAILedgerEntry[]
}

export type OpenAILedgerReplayIssueCode =
  | 'opaque-item-requires-raw-responses-input'
  | 'reasoning-missing-encrypted-content'
  | 'compaction-missing-encrypted-content'
  | 'incomplete-stream-item'
  | 'orphaned-tool-call'
  | 'ephemeral-image-unavailable'

export interface OpenAILedgerReplayIssue {
  entryIndex: number
  code: OpenAILedgerReplayIssueCode
  message: string
  /** The represented output is semantically incomplete and must use the persisted transcript fallback. */
  requiresFallback?: boolean
}

export interface OpenAILedgerReplayResult {
  messages: ModelMessage[]
  issues: OpenAILedgerReplayIssue[]
  /** false means ModelMessage cannot express the entire ledger; the caller must not ignore `issues`. */
  lossless: boolean
  requiresRawResponsesInput: boolean
}

/** Structural subset consumed from AI SDK 7 `result.fullStream`. */
export type OpenAIStreamEventLike =
  | { type: 'text-start' | 'text-end'; id: string; providerMetadata?: unknown }
  | { type: 'text-delta'; id: string; text: string; providerMetadata?: unknown }
  | { type: 'reasoning-start' | 'reasoning-end'; id: string; providerMetadata?: unknown }
  | { type: 'reasoning-delta'; id: string; text: string; providerMetadata?: unknown }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: unknown
      providerExecuted?: boolean
      providerMetadata?: unknown
    }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      providerExecuted?: boolean
      providerMetadata?: unknown
    }
  | {
      type: 'tool-error'
      toolCallId: string
      toolName: string
      error: unknown
      providerExecuted?: boolean
      providerMetadata?: unknown
    }
  | {
      type: 'finish-step'
      finishReason?: unknown
      response?: { id?: unknown }
      providerMetadata?: unknown
    }
  | { type: 'custom'; kind: string; providerMetadata?: unknown }
