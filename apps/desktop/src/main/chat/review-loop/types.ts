import type {
  FrozenChatSelection,
  InternalTurnHandle,
  MessagePart,
  ReviewLoopInfo as PublicReviewLoopInfo,
} from '../../../shared/chat'
export type { FrozenChatExecutionProfile, FrozenChatSelection } from '../../../shared/chat'

export const DEFAULT_MAX_ITERATIONS = 5
export const HARD_MAX_ITERATIONS = 10
export const MAX_FINDINGS = 50
export const MAX_FINDINGS_TOTAL_CHARS = 80_000
export const MAX_FINDING_ID_CHARS = 128
export const MAX_FINDING_TITLE_CHARS = 200
export const MAX_FINDING_DETAILS_CHARS = 4_000
export const MAX_FINDING_PATHS = 20
export const MAX_FINDING_PATH_CHARS = 300
export const MAX_REVIEWER_NOTES_CHARS = 4_000
export const MAX_FINISH_SUMMARY_CHARS = 8_000
export const MAX_REMAINING_FINDINGS = 50
export const MAX_REMAINING_TOTAL_CHARS = 40_000
export const MAX_EXECUTOR_SUMMARY_CHARS = 2_000
export const MAX_WAIT_SECONDS = 60

export type ReviewLoopSeverityThreshold = 'blocking' | 'important'
export type ReviewFindingSeverity = 'blocking' | 'important' | 'optional'

export type ReviewLoopStatus =
  | 'reviewing'
  | 'executing'
  | 'finishing'
  | 'cancelling'
  | 'finished'
  | 'cancelled'
  | 'interrupted'

export type ReviewLoopFinishReason =
  | 'clean'
  | 'max_iterations'
  | 'no_progress'
  | 'failed'
  | 'cancelled'
  | 'executor_unavailable'
  | 'reviewer_unavailable'
  | 'review-decision-missing'
  | 'workspace_changed_externally'
  | 'session_ended'
  | 'interrupted'

export type ReviewFixJobStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface ReviewFindingInput {
  id: string
  severity: ReviewFindingSeverity
  title: string
  details: string
  paths?: string[]
}

export interface WorkspaceSnapshot {
  branch: string
  head: string
  /** Tracked unstaged diff (`git diff`), bounded for hashing. */
  unstaged: string
  /** Staged diff (`git diff --cached`), bounded for hashing. */
  staged: string
  /** Untracked files with content hashes (safe limits). */
  untracked: Array<{ path: string; hash: string }>
}

/** Evidence is intentionally transport-neutral; bridges and local drivers can both populate it. */
export interface ReviewLoopEvidence {
  contextLoaded: boolean
  byIteration: Record<
    number,
    {
      diff: number
      search: number
      read: number
      browserSnapshot?: number
      browserScreenshot?: number
      browserNavigation?: number
      browserInteraction?: number
    }
  >
  checks: string[]
}

/** Backward-compatible name used by the ChatGPT Web bridge. */
export type BridgeReviewEvidence = ReviewLoopEvidence

/**
 * The core only needs lifecycle and sanitized-state operations from visual support. Concrete browser and
 * preview implementations remain adapter-owned and flow through the generic parameters opaquely.
 */
export interface ReviewLoopVisualInfo {
  state: 'starting' | 'ready' | 'inspecting' | 'error'
  url?: string
}

export interface ReviewLoopVisualBrowser<TInfo extends ReviewLoopVisualInfo = ReviewLoopVisualInfo> {
  info(): TInfo
  show(): boolean
  dispose(): void | Promise<void>
}

export interface ReviewLoopVisualPreview {
  url: string
  waitForExit?(): Promise<unknown>
  dispose(): void | Promise<void>
}

export interface ReviewFixJob {
  jobId: string
  /** Loop owning the job (wait/completion resolution for historical loops). */
  loopId: string
  iteration: number
  startedAt: number
  finishedAt?: number
  executionId: string
  /** Job cancellation BEFORE runner admission (preflight): the signal is passed to startTurn. */
  controller: AbortController
  status: ReviewFixJobStatus
  beforeFingerprint: string
  afterFingerprint?: string
  afterSnapshot?: WorkspaceSnapshot
  madeProgress: boolean
  findingsFingerprint: string
  assistantMessageId?: string
  executorSummary?: string
  completion: Promise<void>
  settleCompletion: () => void
  /** Canonical transition applied; `wait` awaits this before building the terminal result. */
  stateApplied: Promise<void>
  settleStateApplied: () => void
}

export interface ReviewLoopState<
  TVisualInfo extends ReviewLoopVisualInfo = ReviewLoopVisualInfo,
  TVisualBrowser extends ReviewLoopVisualBrowser<TVisualInfo> = ReviewLoopVisualBrowser<TVisualInfo>,
  TVisualPreview extends ReviewLoopVisualPreview = ReviewLoopVisualPreview,
> {
  loopId: string
  conversationId: string
  sessionKeyHash: string
  status: ReviewLoopStatus
  /** Round the reviewer must submit NOW (1-based; advances after each job). */
  iteration: number
  maxIterations: number
  severityThreshold: ReviewLoopSeverityThreshold
  reviewScope: 'code' | 'frontend'
  selection: FrozenChatSelection
  baseline: WorkspaceSnapshot
  expectedWorkspace: WorkspaceSnapshot
  activeJob?: ReviewFixJob
  noProgressCount: number
  roundsExecuted: number
  roundsCompleted: number
  roundsFailed: number
  roundsCancelled: number
  startedAt: number
  finishedAt?: number
  finishReason?: ReviewLoopFinishReason
  /** Canonical finalization: the first valid finish call attempts to persist the summary exactly ONCE. */
  finalization?: {
    result: FinishReviewLoopResult
    fingerprint: string
    summaryMarkdown: string
    summaryMessageId?: string
    summaryPersisted: boolean
    persistenceError?: string
  }
  /** Main-only opaque handles. Only sanitized visual state is projected by `info()`. */
  visualEnvironment?: {
    ownership: 'managed' | 'attached'
    url: string
    preview?: TVisualPreview
    browser: TVisualBrowser
    abort: AbortController
    info: TVisualInfo
    disposed: boolean
    teardown?: Promise<void>
  }
}

/** Result of persisting the auditable summary (upsert by loop_id). */
export type PersistSummaryResult = { ok: true; messageId: string } | { ok: false; error: string }

export interface ReviewLoopControllerDeps<
  TVisualInfo extends ReviewLoopVisualInfo = ReviewLoopVisualInfo,
  TVisualBrowser extends ReviewLoopVisualBrowser<TVisualInfo> = ReviewLoopVisualBrowser<TVisualInfo>,
  TVisualPreview extends ReviewLoopVisualPreview = ReviewLoopVisualPreview,
  TVisualTarget = unknown,
> {
  conversationId: string
  cwd: string
  /** Opaque hash of session_key (audit; the key never enters state). */
  sessionKeyHash: string
  now?: () => number
  /** Injectable for tests: run `git <args>` in cwd. */
  runGit?: (args: string[], signal?: AbortSignal) => Promise<string>
  /** Active reviewer session (arming or live) for this conversation. */
  sessionActive: () => boolean
  /** Eligible executor conversation, with no active turn/operation or pending plan. */
  validateStart: () => Promise<{ ok: true } | { ok: false; error: string }>
  /** Provider/model available NOW (selection is frozen immediately afterward). */
  resolveSelection: () => Promise<{ ok: true; selection: FrozenChatSelection } | { ok: false; error: string }>
  /** Revalidate frozen profile identity between rounds (fingerprint/epoch). Absent means skip. */
  revalidateSelection?: (selection: FrozenChatSelection) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Start EXACTLY one internal execution turn. The signal aborts turns still in preflight. */
  startTurn: (input: {
    prompt: string
    hiddenParts: MessagePart[]
    selection: FrozenChatSelection
    loopId: string
    iteration: number
    maxIterations: number
    signal: AbortSignal
  }) => Promise<{ ok: true; handle: InternalTurnHandle } | { ok: false; error: string }>
  cancelTurn: (executionId: string) => void
  /** Sanitized evidence for the specified loop (per-iteration checkpoints + checks from that loop). */
  getReviewEvidence: (loopId: string) => ReviewLoopEvidence
  setReviewIteration: (loopId: string | null, iteration: number | null) => void
  clearReviewIteration: (loopId: string) => void
  forgetReviewLoop: (loopId: string) => void
  persistSummary: (input: { loopId: string; markdown: string }) => Promise<PersistSummaryResult>
  forceAgentMode: () => void
  /** Optional neutral process-wide reservation hooks used by concrete drivers. */
  reserveParticipants?: (loopId: string) => { ok: true } | { ok: false; error: string }
  releaseParticipants?: (loopId: string) => void
  discoverFrontendPreviews?: () => TVisualTarget[] | Promise<TVisualTarget[]>
  prepareFrontendEnvironment?: (input: {
    loopId: string
    previewId: string
    signal: AbortSignal
    onStateChange: (info: TVisualInfo) => void
  }) => Promise<{ preview: TVisualPreview; browser: TVisualBrowser }>
  prepareAttachedFrontendEnvironment?: (input: {
    loopId: string
    browserId: string
    signal: AbortSignal
    onStateChange: (info: TVisualInfo) => void
  }) => Promise<{ browser: TVisualBrowser; url: string; ownership: 'attached' }>
  /** Internal outer deadline so a remote reviewer call never waits indefinitely. */
  frontendStartupTimeoutMs?: number
  /** Adapter hook for runtime-specific, sanitized visual startup diagnostics. */
  formatVisualStartupError?: (error: unknown, cwd: string) => string
  onChange?: () => void
}

export interface StartReviewLoopInput {
  reviewScope?: 'code' | 'frontend'
  previewId?: string
  browserId?: string
  maxIterations: number
  severityThreshold: ReviewLoopSeverityThreshold
  idempotencyKey: string
}

export interface StartReviewLoopResult {
  loopId: string
  status: 'reviewing'
  iteration: number
  maxIterations: number
  severityThreshold: ReviewLoopSeverityThreshold
  reviewScope: 'code' | 'frontend'
  visual?: { url: string; managedPreview: boolean }
  baseline: { branch: string; head: string; workspaceFingerprint: string }
  executor: { providerId: string; modelId: string; reasoning?: string }
}

export interface SubmitReviewFixInput {
  loopId: string
  iteration: number
  findings: ReviewFindingInput[]
  reviewerNotes?: string
  idempotencyKey: string
}

export interface SubmitReviewFixResult {
  loopId: string
  jobId: string
  iteration: number
  status: 'running'
  startedAt: number
}

export type ReviewFixWaitResult =
  | { status: 'running'; iteration: number; startedAt: number }
  | {
      status: ReviewFixJobStatus
      iteration: number
      startedAt: number
      finishedAt: number
      assistantMessageId?: string
      executorSummary?: string
      madeProgress: boolean
      beforeFingerprint: string
      afterFingerprint: string
      nextIteration: number
      canContinue: boolean
      stopReason?: string
    }

export interface FinishReviewLoopInput {
  loopId: string
  result: 'clean' | 'max_iterations' | 'no_progress' | 'failed' | 'cancelled'
  summary: string
  remainingFindings?: Array<{ severity: ReviewFindingSeverity; title: string; details: string }>
  idempotencyKey: string
}

export interface FinishReviewLoopResult {
  loopId: string
  result: string
  iterations: number
  durationMs: number
  startedAt: number
  finishedAt: number
  baselineFingerprint: string
  finalFingerprint: string
  finishReason?: string
}

export type ResultOrError<T> = T | { error: string }

/** Legacy controller projection retained for the ChatGPT Web adapter. */
export interface ReviewLoopControllerInfo {
  loopId: string
  status: ReviewLoopStatus
  iteration: number
  maxIterations: number
  startedAt: number
  jobStartedAt?: number
  finishReason?: string
  modelId?: string
  reasoning?: string
  fastMode?: boolean
  contextPolicy?: 'isolated'
  roundsCompleted?: number
  roundsFailed?: number
  roundsCancelled?: number
  reviewScope?: 'code' | 'frontend'
  visual?: { state: ReviewLoopVisualInfo['state']; url?: string; managedPreview: boolean }
}

/** Neutral sanitized projection shared by all drivers. */
export type ReviewLoopInfo = PublicReviewLoopInfo
