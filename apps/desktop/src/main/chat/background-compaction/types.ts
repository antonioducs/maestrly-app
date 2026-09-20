import type { BackgroundCompactionConfig, BackgroundCompactionStatus } from '../../../shared/background-compaction'
import type { ChatMessage, FrozenChatSelection } from '../../../shared/chat'
import type { PortableSummaryCheckpoint } from '../portable-context'

export const BACKGROUND_COMPACTION_PERSISTENCE_VERSION = 1 as const

export interface BackgroundCompactionSafeBoundary {
  messageId: string
  partId: string
}

export interface BackgroundCompactionBoundary extends BackgroundCompactionSafeBoundary {
  partIndex: number
}

export interface BackgroundCompactionCandidate {
  version: typeof BACKGROUND_COMPACTION_PERSISTENCE_VERSION
  id: string
  generation: number
  configIdentity: string
  boundary: BackgroundCompactionBoundary
  /** Exact hash of the active portable summary and source through boundary. */
  sourceHash: string
  summary: string
  summaryTokens: number
  /** Portable source only; excludes the active/prepared summary. */
  coveredTokens: number
  selection: FrozenChatSelection
  createdAt: number
}

export interface BackgroundCompactionWork {
  version: typeof BACKGROUND_COMPACTION_PERSISTENCE_VERSION
  id: string
  generation: number
  configIdentity: string
  boundary: BackgroundCompactionBoundary
  sourceHash: string
  selection: FrozenChatSelection
  baseCandidateId?: string
  coveredTokens: number
  newTokens: number
  intervalTokens: number
  conversationWindow: number
  contextWindow: number
  maxSummaryTokens: number
  attemptSequence: number
  resume?: PortableSummaryCheckpoint
  createdAt: number
  updatedAt: number
}

export type BackgroundCompactionPauseReason = 'stopped' | 'archived' | 'selection' | 'disabled'

export interface BackgroundCompactionRecord {
  conversationId: string
  version: typeof BACKGROUND_COMPACTION_PERSISTENCE_VERSION
  generation: number
  configIdentity?: string
  conversationWindow?: number
  pauseReason?: BackgroundCompactionPauseReason
  state: BackgroundCompactionStatus
  ready: BackgroundCompactionCandidate | null
  work: BackgroundCompactionWork | null
  updatedAt: number
}

export interface BackgroundCompactionAttemptResult {
  outcome: 'success' | 'error' | 'cancelled'
  usage?: {
    input: number
    output: number
    cacheRead: number
    cacheCreate: number
  }
  runtimeEstimatedCostUsd?: number
  error?: unknown
  durationMs?: number
}

export interface BackgroundCompactionAttemptHandle {
  id: string
  /** Idempotent. It remains live after cancellation/consumption so late bills are not lost. */
  settle(result: BackgroundCompactionAttemptResult): void
}

export interface BackgroundCompactionSummarizeInput {
  conversationId: string
  history: ChatMessage[]
  selection: FrozenChatSelection
  contextWindow: number
  maxSummaryTokens: number
  stepTimeoutMs: number
  retryDelayMs: number
  maxRetries: number
  signal: AbortSignal
  onAttempt: (phase?: 'chunk' | 'consolidate') => BackgroundCompactionAttemptHandle
  onCheckpoint: (checkpoint: PortableSummaryCheckpoint) => void
  resume?: PortableSummaryCheckpoint
}

export interface BackgroundCompactionConversation {
  id: string
  archived?: boolean
}

export interface BackgroundCompactionDiagnostic {
  kind: 'scheduled' | 'started' | 'completed' | 'discarded' | 'failed' | 'attempt-accounting-failed'
  conversationId: string
  durationMs?: number
  coveredTokens?: number
  newTokens?: number
  reusedTokens?: number
  reason?: string
}

export interface BackgroundCompactionCoordinatorDeps {
  getConfig(): BackgroundCompactionConfig | unknown
  getConversation(id: string): BackgroundCompactionConversation | null | undefined
  getMessages(id: string): ChatMessage[]
  resolveSelection(
    id: string,
    selection: NonNullable<BackgroundCompactionConfig['selection']>,
    signal: AbortSignal
  ): Promise<{ selection: FrozenChatSelection; contextWindow: number } | null>
  summarize(input: BackgroundCompactionSummarizeInput): Promise<{ summary: string }>
  publish(id: string, state: BackgroundCompactionStatus): void
  recordAttempt(
    id: string,
    selection: FrozenChatSelection,
    attempt: BackgroundCompactionAttemptResult
  ): void | Promise<void>
  revalidate(selection: FrozenChatSelection): boolean
  diagnostic?(event: BackgroundCompactionDiagnostic): void
  now?(): number
  randomId?(): string
}

export interface BackgroundCompactionNotification {
  boundary?: BackgroundCompactionSafeBoundary
  /** Top-level boundary form accepted for direct runner callback adaptation. */
  messageId?: string
  partId?: string
  conversationWindow: number
}
