/**
 * MCP bridge for the ChatGPT Web companion integration.
 *
 * The user chats directly in ChatGPT and calls these tools to inspect the local repository. To bring
 * an artifact back, they call `send_to_maestrly`. Read tools remain read-only; the bridge ceases to be
 * strictly read-only only when the user EXPLICITLY enables the review loop (`start_review_loop`):
 * `submit_review_fix` then starts ONE local Maestrly agent execution at a time, tracked through
 * `wait_review_fix` (server-side long-poll) and concluded through `finish_review_loop`.
 * Loop reasoning (review, convergence decisions) belongs to ChatGPT; this module validates, enforces
 * limits, counts per-iteration investigation checkpoints, and audits only sanitized metadata.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ChatGptWebBrowserCapability } from '../../../shared/chat'
import type { BrowserSurface } from '../browser-surface'
import { globToRegExp, shouldSkipSearchDir } from '../tools/grep'
import { isBinaryExt, isProbablyBinary, resolveInside } from '../tools/util'
import { buildRepositoryMap } from './repository-map'
import type { RepositoryScope } from '../../repository-scope'
import {
  CHATGPT_WEB_TOOL_CATALOG_META_KEY,
  CHATGPT_WEB_TOOL_CATALOG_VERSION,
  completeMcpResult,
  createLegacyInitializeResult,
  createMcpDiscoverResult,
  isStatelessMcpRequest,
} from './bridge-protocol'
import {
  DEFAULT_MAX_ITERATIONS,
  HARD_MAX_ITERATIONS,
  MAX_FINDINGS,
  MAX_FINDING_DETAILS_CHARS,
  MAX_FINDING_ID_CHARS,
  MAX_FINDING_PATH_CHARS,
  MAX_FINDING_PATHS,
  MAX_FINDING_TITLE_CHARS,
  MAX_FINISH_SUMMARY_CHARS,
  MAX_REMAINING_FINDINGS,
  MAX_REVIEWER_NOTES_CHARS,
  MAX_WAIT_SECONDS,
  validateFindingsShape,
  validateRemainingFindingsShape,
  type BridgeReviewEvidence,
  type ReviewLoopController,
} from './review-loop'
import { CHATGPT_WEB_MCP_QUERY_MAX_CHARS, CHATGPT_WEB_MCP_SEARCH_MAX_RESULTS } from './mcp-gateway'
import type { DrawerBrowserSession, CompanionBrowserTab } from './drawer-browser-session'
import type { ProjectEnvironmentJobController } from './project-environment'
import {
  CONVERSATION_QUERY_MAX_CHARS,
  CONVERSATION_RESULT_DEFAULT_LIMIT,
  CONVERSATION_RESULT_MAX_LIMIT,
} from './conversation-context'
import { MAX_PLAN_REVIEW_WAIT_SECONDS, type PlanReviewController, type PlanReviewOutcome } from './plan-review'

const DEFAULT_GIT_BASE = 'origin/main'
const MAX_READ_LINES = 1200
const MAX_LINE_LENGTH = 2000
const MAX_READ_BYTES = 4 * 1024 * 1024
const MAX_DIFF_CHARS = 180_000
const MAX_GREP_MATCHES = 200
const MAX_GREP_PATTERN_CHARS = 2048
const MAX_GREP_INCLUDE_CHARS = 512
const GREP_REGEX_TIMEOUT_MS = 300
const MAX_GLOB_RESULTS = 300
const MAX_UNTRACKED_FILES = 100
const GIT_TIMEOUT_MS = 20_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const GET_CONTEXT_TIMEOUT_MS = 25_000
const MAX_DELIVERY_CHARS = 180_000
const MAX_DELIVERY_TITLE_CHARS = 160
const MAX_DELIVERY_KEYS = 256
const MAX_COMPLETION_KEYS = 256
const MAX_COVERAGE_ITEMS = 40
const MAX_TRACKED_EVIDENCE = 200
const MAX_DISCLOSURE_ITEMS = 20
const MAX_DISCLOSURE_ITEM_CHARS = 500
const IDEMPOTENCY_KEY_MIN_CHARS = 8
const IDEMPOTENCY_KEY_MAX_CHARS = 128
const IDEMPOTENCY_KEY_PATTERN = '^[A-Za-z0-9._:-]{8,128}$'
const IDEMPOTENCY_KEY_REGEX = new RegExp(IDEMPOTENCY_KEY_PATTERN)
const NON_WHITESPACE_PATTERN = '\\S'
const IDEMPOTENCY_KEY_CONSTRAINTS = {
  type: 'string',
  minLength: IDEMPOTENCY_KEY_MIN_CHARS,
  maxLength: IDEMPOTENCY_KEY_MAX_CHARS,
  pattern: IDEMPOTENCY_KEY_PATTERN,
} as const

export interface BridgeToolCallEvent {
  kind: 'tool-call'
  name: string
  args: Record<string, unknown>
  ok: boolean
  durationMs: number
}

export type BridgeEvent =
  | BridgeToolCallEvent
  | { kind: 'client-initialized'; clientName?: string; protocolVersion?: string }
  | {
      kind: 'delivery'
      destination: 'chat' | 'plan'
      idempotencyKey: string
      chars: number
      deduplicated: boolean
    }
  | { kind: 'turn-completed'; idempotencyKey: string; deduplicated: boolean }
  | { kind: 'review-loop-started'; loopId: string; maxIterations: number }
  | { kind: 'review-fix-started'; jobId: string; iteration: number; findings: number }
  | {
      kind: 'review-fix-finished'
      jobId: string
      iteration: number
      status: string
      madeProgress: boolean
    }
  | { kind: 'review-loop-finished'; loopId: string; result: string; iterations: number; finishReason?: string }
  | { kind: 'session-ended' }

/** Allowed check (allowlist): the model selects the NAME, never the command line. */
export interface BridgeCheck {
  name: string
  description: string
}

export interface BridgeCheckResult {
  exitCode: number | null
  output: string
  timedOut?: boolean
  aborted?: boolean
}

export interface BridgeDelivery {
  destination: 'chat' | 'plan'
  markdown: string
  title?: string
  idempotencyKey: string
  /** Present only for destination="plan". */
  planReviewId?: string
}

/** Session-owned adapter. The bridge knows schemas/lifecycle only; stores and credentials stay in main. */
export interface BridgeExternalCapabilities {
  listCapabilities(signal?: AbortSignal): Promise<unknown> | unknown
  searchMcpTools(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> | unknown
  callMcpRead(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> | unknown
  callMcpWrite(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> | unknown
  gitRead(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> | unknown
  ghRead(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> | unknown
  dispose?(): Promise<void> | void
}

/** Read-only adapter already bound by the manager to this session's Maestrly conversation. */
export interface BridgeConversationCapabilities {
  getContext(signal?: AbortSignal): Promise<unknown> | unknown
  getRevision(signal?: AbortSignal): Promise<string | null> | string | null
  search(args: { query: string; limit?: number }, signal?: AbortSignal): Promise<unknown> | unknown
  read(args: { around_seq: number; limit?: number }, signal?: AbortSignal): Promise<unknown> | unknown
}

/** Read-only, session-bound memory adapter. Local records may be hidden while shared repo knowledge remains. */
export interface BridgeMemoryCapabilities {
  status(signal?: AbortSignal): Promise<unknown> | unknown
  search(args: { query: string; limit?: number; repo?: string }, signal?: AbortSignal): Promise<unknown> | unknown
  read(
    args: { kind: 'local' | 'shared'; id: string; repo?: string; path?: string },
    signal?: AbortSignal
  ): Promise<unknown> | unknown
}

function conversationRevisionFromBrief(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const revision = (value as { revision?: unknown }).revision
  if (typeof revision === 'string' && revision.length > 0) return revision
  return undefined
}

type InvestigationConfidence = 'low' | 'medium' | 'high'

interface InvestigationDisclosure {
  confidence: InvestigationConfidence
  uninspectedAreas: string[]
  assumptions: string[]
}

export interface BridgeOptions {
  /** Repository root exposed to tools (jail). */
  cwd: string
  /** Diff base (`git diff <base>...HEAD`). */
  gitBase?: string
  onEvent?: (event: BridgeEvent) => void
  /** Injectable for tests: run `git <args>` in cwd and return stdout. */
  runGit?: (args: string[], signal?: AbortSignal) => Promise<string>
  /** Project context (AGENTS.md, memory, rules), included in get_context, not kickoff. */
  projectContext?: () => Promise<string> | string
  /** Injectable deadline for tests; production uses a backstop longer than the individual Git timeout. */
  getContextTimeoutMs?: number
  /** Available project skills (name + description), with on-demand body reads. */
  listSkills?: () => Promise<BridgeCheck[]> | BridgeCheck[]
  readSkill?: (name: string) => Promise<string | null> | string | null
  /** Allowed checks (tests/lint/typecheck) and their executor; user-defined allowlist. */
  listChecks?: () => BridgeCheck[]
  runCheck?: (name: string, signal?: AbortSignal) => Promise<BridgeCheckResult>
  /** Only permitted write: publish an artifact to the originating conversation or Plan tab. */
  deliver?: (delivery: BridgeDelivery) => Promise<void> | void
  /** Human Plan-tab channel, separate from the automatic code/frontend review loop. */
  planReview?: Pick<PlanReviewController, 'create' | 'isDelivered' | 'markDelivered' | 'wait'>
  /**
   * Review-loop controller for this conversation. If absent, reject review tools in `tools/call` with
   * `review-loop-unavailable` (the stable, complete `tools/list` catalog ALWAYS advertises them).
   */
  reviewLoop?: ReviewLoopController
  /** Embedded browser tabs owned by this conversation; all public IDs are session-scoped and opaque. */
  browserSession?: Pick<DrawerBrowserSession, 'list' | 'attach' | 'detach' | 'active' | 'attachedId' | 'dispose'>
  /** Local executor bootstrap. The bridge resolves enabled skills before crossing this boundary. */
  projectEnvironment?: ProjectEnvironmentJobController
  external?: BridgeExternalCapabilities
  conversation?: BridgeConversationCapabilities
  memory?: BridgeMemoryCapabilities
  /** Persisted multi-root jail; the aggregator directory itself is never an authorized root. */
  repositoryScope?: RepositoryScope
  /** Applies the conversation capability to legacy Git-backed tools too. Default true for compatibility. */
  gitReadEnabled?: boolean
  /** Frozen conversation capability. Browser defaults to off and is checked again on every call. */
  browserCapability?: ChatGptWebBrowserCapability
  now?: () => number
}

export interface BridgeStats {
  lastToolCallAt: number | null
  toolCalls: number
  deliveries: number
  /** Explicit completion signals accepted by the companion (not deliveries). */
  completedTurns: number
  /** Accepted fix jobs (no findings/prompts, only sanitized counters). */
  reviewJobs: number
  /** Highest iteration submitted to the executor. */
  reviewIterations: number
  ended: boolean
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string }
}

const escapeRegex = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')

/**
 * PATH glob (chat tools use `globToRegExp`, which matches filenames only): `*` and `?` cannot cross
 * slashes; `**` can. A slash-delimited `**` also matches ZERO directories: "src/(**)/*.ts" must find
 * `src/alpha.ts`, not just `src/sub/alpha.ts`.
 */
export function globPathToRegExp(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (re.endsWith('/') && glob[i + 2] === '/') {
          re = `${re.slice(0, -1)}(?:/|/.*/)`
          i += 3
          continue
        }
        re += '.*'
        i += 2
        continue
      }
      re += '[^/]*'
      i++
      continue
    }
    if (char === '?') {
      re += '[^/]'
      i++
      continue
    }
    if (char === '{') {
      const end = glob.indexOf('}', i)
      if (end > i) {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map(escapeRegex)
          .join('|')})`
        i = end + 1
        continue
      }
    }
    re += escapeRegex(char)
    i++
  }
  return new RegExp(`^${re}$`)
}

/**
 * Every tool requires `session_key`: the SAME ChatGPT app (and tunnel) serves N Maestrly conversations
 * concurrently. The key, delivered in each kickoff, identifies the conversation that owns the call.
 * The router never guesses the session when the key is omitted.
 */
export const SESSION_KEY_PROPERTY = {
  session_key: {
    type: 'string',
    minLength: 32,
    maxLength: 32,
    pattern: '^[a-f0-9]{32}$',
    description:
      'Maestrly session key supplied at the start of this conversation. ALWAYS send the same value in all ' +
      'calls; without it, the app cannot identify your conversation when multiple conversations are open.',
  },
} as const

function withSessionKey<
  T extends { inputSchema: { properties?: Record<string, unknown>; required?: readonly string[] } },
>(tool: T): T {
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...(tool.inputSchema.properties ?? {}), ...SESSION_KEY_PROPERTY },
      required: [...new Set([...(tool.inputSchema.required ?? []), 'session_key'])],
    },
  }
}

const TEXT = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const ERR = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true as const })
export interface BridgeToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>
  isError?: boolean
  [key: string]: unknown
}

/**
 * RegExp.test can monopolize the event loop with catastrophic backtracking. The pattern comes from
 * ChatGPT, so evaluate it outside the main process and terminate the worker on timeout.
 * Pass the pattern as data through postMessage (never interpolate it into worker code).
 */
const GREP_WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
let regex

parentPort.on('message', (message) => {
  if (message?.type === 'init') {
    try {
      regex = new RegExp(message.pattern)
      parentPort.postMessage({ type: 'ready' })
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  if (message?.type !== 'test' || !regex) return
  try {
    const matches = []
    const lines = Array.isArray(message.lines) ? message.lines : []
    const maxMatches = Number.isInteger(message.maxMatches) ? Math.max(0, message.maxMatches) : lines.length
    for (let index = 0; index < lines.length && matches.length < maxMatches; index++) {
      regex.lastIndex = 0
      if (regex.test(lines[index])) matches.push(index)
    }
    parentPort.postMessage({ type: 'matches', id: message.id, matches })
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
})
`

interface RegexWorkerMatcher {
  ready: Promise<void>
  test: (lines: string[], maxMatches: number) => Promise<number[]>
  close: () => Promise<void>
}

function createRegexWorkerMatcher(pattern: string, signal: AbortSignal): RegexWorkerMatcher {
  const worker = new Worker(GREP_WORKER_SOURCE, { eval: true })
  let closed = false
  let nextRequestId = 1
  let readySettled = false
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  let resolveReady!: () => void
  let rejectReady!: (reason?: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const pending = new Map<
    number,
    { resolve: (matches: number[]) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >()

  const settle = (id: number, error?: Error, matches: number[] = []) => {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    clearTimeout(request.timeout)
    if (error) request.reject(error)
    else request.resolve(matches)
  }

  const terminate = () => {
    if (closed) return
    closed = true
    void worker.terminate().catch(() => undefined)
  }

  const fail = (error: Error) => {
    if (closed) return
    if (!readySettled) {
      readySettled = true
      clearTimeout(readyTimer)
      rejectReady(error)
    }
    for (const [id, request] of pending) {
      pending.delete(id)
      clearTimeout(request.timeout)
      request.reject(error)
    }
    terminate()
  }

  const onAbort = () => fail(new Error('grep canceled.'))
  signal.addEventListener('abort', onAbort, { once: true })

  worker.on('message', (raw: unknown) => {
    const message = raw as { type?: string; id?: number; message?: string; matches?: unknown }
    if (message.type === 'ready') {
      if (readySettled) return
      readySettled = true
      clearTimeout(readyTimer)
      resolveReady()
      return
    }
    if (message.type === 'error') {
      const error = new Error(message.message || 'Failed to evaluate the regex')
      if (typeof message.id === 'number') settle(message.id, error)
      else fail(error)
      return
    }
    if (message.type === 'matches' && typeof message.id === 'number') {
      const matches = Array.isArray(message.matches)
        ? message.matches.filter((value): value is number => Number.isInteger(value))
        : []
      settle(message.id, undefined, matches)
    }
  })
  worker.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))))
  worker.on('exit', (code) => {
    if (!closed && code !== 0) fail(new Error(`Regex worker exited with code ${code}`))
  })
  readyTimer = setTimeout(
    () => fail(new Error('Regex worker startup exceeded 5000 ms.')),
    5_000
  )
  try {
    worker.postMessage({ type: 'init', pattern })
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
  }

  const test = async (lines: string[], maxMatches: number): Promise<number[]> => {
    if (signal.aborted) throw new Error('grep canceled.')
    await ready
    if (closed) throw new Error('Regex worker unavailable')
    const id = nextRequestId++
    return await new Promise<number[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(`Regex exceeded the timeout of ${GREP_REGEX_TIMEOUT_MS} ms.`)
        settle(id, error)
        fail(error)
      }, GREP_REGEX_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timeout })
      try {
        worker.postMessage({ type: 'test', id, lines, maxMatches })
      } catch (error) {
        settle(id, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const close = async (): Promise<void> => {
    signal.removeEventListener('abort', onAbort)
    clearTimeout(readyTimer)
    if (!readySettled) {
      readySettled = true
      rejectReady(new Error('regex worker stopped'))
    }
    for (const [id, request] of pending) {
      pending.delete(id)
      clearTimeout(request.timeout)
      request.reject(new Error('regex worker stopped'))
    }
    if (closed) return
    closed = true
    await worker.terminate()
  }

  return { ready, test, close }
}

function disclosureList(args: Record<string, unknown>, field: string): string[] | null {
  const value = args[field]
  if (!Array.isArray(value) || value.length > MAX_DISCLOSURE_ITEMS) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const normalized = item.trim().replace(/\s+/g, ' ')
    if (!normalized || normalized.length > MAX_DISCLOSURE_ITEM_CHARS) return null
    out.push(normalized)
  }
  return out
}

function reportItem(value: string): string {
  return value.replace(/\s+/g, ' ').replaceAll('`', "'").slice(0, MAX_DISCLOSURE_ITEM_CHARS)
}

/** MCP server instructions read by ChatGPT when attaching the app to a conversation. */
export const CHATGPT_WEB_SERVER_INSTRUCTIONS = [
  'Maestrly companion connected to the local user repository.',
  'Converse normally, but investigate before recommending code changes: call get_context, locate definitions',
  'and callers with grep/glob, then read the relevant implementation, contracts and tests. Never claim to have',
  'reviewed the entire repository. Distinguish the structural map from files actually read; state gaps, assumptions and confidence.',
  'Only when explicitly asked to send results back, call send_to_maestrly with destination="chat" or destination="plan".',
  'The bridge requires basic investigation and attaches observed coverage. Reuse idempotency_key on retries;',
  'never invent another session_key. For plans, capture plan_review_id and call wait_plan_review until a terminal',
  'outcome. On waiting, wait again; on revise, revise and resend with a new key. Do not use the automatic review',
  'loop for plans in the Plan tab or complete the turn between plan versions.',
  'For GitHub or external systems, use list_external_capabilities. Discover unfamiliar MCP tools with',
  'search_mcp_tools; never invent server/tool names. MCP write requires a user-requested mutation and write scope.',
  'There is no remote shell: git_read and gh_read are read-only. In gh_read, search-* and api-get are global',
  'and may query any resource visible to the local gh login.',
  'After pairing, end each normal message with exactly one notify_turn_complete after all other tools; it delivers no content.',
  'For requested automatic fixes, follow start_review_loop → submit_review_fix → wait_review_fix → finish_review_loop',
  'as described in the pairing prompt. Each round starts a local execution and requires fresh diff, search and read',
  'evidence before the next submission. Do not finish an active loop merely because the current response is ending;',
  'cancelled requires actual user cancellation. For frontend review, prefer an existing loopback tab through',
  'browser_list_tabs/browser_attach; fall back to a managed preview. Only bootstrap through a skill after an',
  'explicit request; never scan ports. Capture a fresh snapshot and screenshot each iteration after rereading',
  'the code. Screenshots do not replace implementation investigation.',
].join(' ')

export function createChatGptWebBridge(options: BridgeOptions) {
  const cwd = options.cwd
  const gitBase = options.gitBase || DEFAULT_GIT_BASE
  const now = options.now ?? (() => Date.now())
  const SESSION_ENDED_MESSAGE = 'The companion session ended. Start a new session in Maestrly.'
  const emit = (event: BridgeEvent) => {
    try {
      options.onEvent?.(event)
    } catch {
      /* observer failures never terminate the bridge */
    }
  }

  let ended = false
  const lifecycleController = new AbortController()
  let lastToolCallAt: number | null = null
  let toolCalls = 0
  let deliveries = 0
  let completedTurns = 0
  let reviewJobs = 0
  let reviewIterations = 0
  const deliveredKeys = new Map<string, string>()
  const deliveryPromises = new Map<string, { fingerprint: string; promise: Promise<void> }>()
  /** Per-session completion-signal deduplication; bounded to prevent indefinite growth. */
  const completedKeys = new Set<string>()
  let canonicalCwdPromise: Promise<string> | null = null
  let contextLoaded = false
  let conversationContextLoaded = false
  let conversationContextRevision: string | undefined
  /** Idempotent retries of a successful start go through the controller, which validates the key/fingerprint. */
  const startedReviewKeys = new Set<string>()
  const readFiles = new Set<string>()
  const searches: string[] = []
  const inspectedDiffs = new Set<string>()
  const executedChecks = new Set<string>()
  const readSkills = new Set<string>()
  /**
   * Investigation checkpoints SCOPED by loop_id + iteration. Sequential loops restart at iteration=1
   * without reusing evidence from the previous loop.
   *
   * Capture each tool owner AT ADMISSION (before the first await); ownership remains immutable until
   * completion, even if the active pointer advances, cancels, or switches loops while the tool runs.
   */
  interface ReviewEvidenceOwner {
    loopId: string
    iteration: number
  }
  let activeReviewCheckpoint: ReviewEvidenceOwner | null = null
  type ReviewEvidenceKind =
    | 'diff'
    | 'search'
    | 'read'
    | 'browserSnapshot'
    | 'browserScreenshot'
    | 'browserNavigation'
    | 'browserInteraction'
  const emptyReviewEvidence = () => ({
    diff: 0,
    search: 0,
    read: 0,
  })
  type ReviewEvidenceEntry = ReturnType<typeof emptyReviewEvidence> &
    Partial<Record<Exclude<ReviewEvidenceKind, 'diff' | 'search' | 'read'>, number>>
  const reviewCheckpoints = new Map<string, Map<number, ReviewEvidenceEntry>>()
  /** Checks run DURING a loop (final-summary audit); the global send_to_maestrly report stays in executedChecks. */
  const checksByLoop = new Map<string, Set<string>>()

  /** Immutable copy of the current pointer; NEVER pass the mutable activeReviewCheckpoint reference. */
  const captureReviewEvidenceOwner = (): ReviewEvidenceOwner | null =>
    activeReviewCheckpoint
      ? { loopId: activeReviewCheckpoint.loopId, iteration: activeReviewCheckpoint.iteration }
      : null

  /**
   * Record evidence under the owner captured at admission. Read/update-only: do NOT create a bucket
   * (only setReviewIteration does that) or consult the global pointer; forgetReviewLoop is final.
   */
  const checkpointFor = (owner: ReviewEvidenceOwner | null, kind: ReviewEvidenceKind): void => {
    if (!owner) return
    const byIteration = reviewCheckpoints.get(owner.loopId)
    if (!byIteration) return // loop forgotten or never activated: no-op, never resurrect it
    const entry: ReviewEvidenceEntry = byIteration.get(owner.iteration) ?? emptyReviewEvidence()
    entry[kind] = (entry[kind] ?? 0) + 1
    byIteration.set(owner.iteration, entry)
  }

  /** Same rules as checkpointFor: record only if the loop bucket still exists. */
  const rememberCheckFor = (owner: ReviewEvidenceOwner | null, name: string): void => {
    if (!owner) return
    const bucket = checksByLoop.get(owner.loopId)
    if (!bucket) return
    bucket.add(name)
  }

  const remember = (target: string[], value: string) => {
    if (target.includes(value)) return
    target.push(value)
    if (target.length > MAX_COVERAGE_ITEMS) target.shift()
  }

  const rememberSet = (target: Set<string>, value: string) => {
    if (target.has(value)) return
    target.add(value)
    if (target.size > MAX_TRACKED_EVIDENCE) {
      const oldest = target.values().next().value
      if (typeof oldest === 'string') target.delete(oldest)
    }
  }

  const limited = (values: Iterable<string>) => [...values].slice(0, MAX_COVERAGE_ITEMS)

  function investigationReport(disclosure: InvestigationDisclosure): string {
    const confidence = { low: 'low', medium: 'medium', high: 'high' }[disclosure.confidence]
    const lines = [
      '---',
      '## Investigation coverage',
      '_Automatically generated by Maestrly Bridge from tools actually executed._',
      '',
      `- Repository context and map loaded: ${contextLoaded ? 'yes' : 'no'}`,
      `- Confidence reported by the model: **${confidence}**`,
      '',
      `### Files actually read (${readFiles.size})`,
      ...(readFiles.size ? limited(readFiles).map((item) => `- \`${reportItem(item)}\``) : ['- (none)']),
      '',
      `### Searches executed (${searches.length})`,
      ...(searches.length ? limited(searches).map((item) => `- \`${reportItem(item)}\``) : ['- (none)']),
    ]
    if (inspectedDiffs.size) {
      lines.push('', '### Diffs inspected', ...limited(inspectedDiffs).map((item) => `- \`${reportItem(item)}\``))
    }
    if (executedChecks.size) {
      lines.push('', '### Checks executed', ...limited(executedChecks).map((item) => `- \`${reportItem(item)}\``))
    }
    if (readSkills.size) {
      lines.push('', '### Skills read', ...limited(readSkills).map((item) => `- \`${reportItem(item)}\``))
    }
    lines.push(
      '',
      '### Relevant uninspected areas (reported by the model)',
      ...(disclosure.uninspectedAreas.length
        ? disclosure.uninspectedAreas.map((item) => `- ${reportItem(item)}`)
        : ['- No additional relevant areas were reported.']),
      '',
      '### Model assumptions',
      ...(disclosure.assumptions.length
        ? disclosure.assumptions.map((item) => `- ${reportItem(item)}`)
        : ['- No additional assumptions were reported.'])
    )
    return lines.join('\n')
  }

  const canonicalCwd = () => (canonicalCwdPromise ??= fs.realpath(cwd))

  const isInsideCanonicalRoot = (root: string, target: string): boolean => {
    const relative = path.relative(root, target)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  }

  /** Resolve paths lexically and canonically; `realpath` blocks symlink/junction escapes. */
  const canonicalPathInside = async (
    rel: string
  ): Promise<{ root: string; target: string; displayPath: string; repo?: string }> => {
    if (options.repositoryScope) {
      const resolved = await options.repositoryScope.resolveBridgePath(rel)
      const displayPath = resolved.repository.linkName
        ? `${resolved.repository.linkName}/${resolved.relativePath}`.replace(/\/$/, '')
        : resolved.relativePath
      return {
        root: resolved.repository.realWorktreePath,
        target: resolved.absolutePath,
        displayPath: displayPath || resolved.repository.linkName || '.',
        ...(resolved.repository.linkName ? { repo: resolved.repository.linkName } : {}),
      }
    }
    const { abs, external } = resolveInside(cwd, rel)
    if (external) throw new Error('Path is outside the repository exposed by the bridge.')

    let root: string
    let target: string
    try {
      const resolved = await Promise.all([canonicalCwd(), fs.realpath(abs)])
      root = resolved[0]
      target = resolved[1]
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`Path does not exist: ${rel}`)
      throw new Error(`Could not access ${rel}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isInsideCanonicalRoot(root, target)) {
      throw new Error('Path is outside the repository exposed by the bridge (symlink/junction).')
    }
    return { root, target, displayPath: path.relative(root, target).split(path.sep).join('/') || '.' }
  }

  const runGit =
    options.runGit ??
    ((args: string[], signal?: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          'git',
          args,
          { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8', signal },
          (error, stdout) => {
            if (error) reject(error instanceof Error ? error : new Error(String(error)))
            else resolve(stdout)
          }
        )
      }))

  const git = async (
    args: string[],
    fallback = '',
    signal: AbortSignal = lifecycleController.signal
  ): Promise<string> => {
    try {
      const output = await runGit(args, signal)
      if (signal.aborted) throw new Error(SESSION_ENDED_MESSAGE)
      return output.trim()
    } catch (error) {
      if (signal.aborted) throw error
      return fallback
    }
  }

  /** End the session and cancel in-flight operations. The router revokes the key immediately afterward. */
  function endSession(): void {
    if (ended) return
    ended = true
    lifecycleController.abort()
    options.projectEnvironment?.stop()
    void Promise.resolve(options.browserSession?.dispose()).catch(() => undefined)
    void Promise.resolve(options.external?.dispose?.()).catch(() => undefined)
    emit({ kind: 'session-ended' })
  }

  function stats(): BridgeStats {
    return {
      lastToolCallAt,
      toolCalls,
      deliveries,
      completedTurns,
      reviewJobs,
      reviewIterations,
      ended,
    }
  }

  /**
   * Activate the current loop investigation checkpoint. `setReviewIteration(null, null)` clears the
   * pointer without deleting buckets. Compare-and-clear by loopId only clears a pointer still owned
   * by that loop; a late finish/cancel from loop A never clears loop B's pointer.
   */
  function setReviewIteration(loopId: string | null, iteration: number | null): void {
    if (loopId == null || iteration == null) {
      activeReviewCheckpoint = null
      return
    }
    activeReviewCheckpoint = { loopId, iteration }
    // Create an empty bucket if the loop has no evidence yet (start of a sequential loop).
    if (!reviewCheckpoints.has(loopId)) reviewCheckpoints.set(loopId, new Map())
    if (!checksByLoop.has(loopId)) checksByLoop.set(loopId, new Set())
  }

  /** Clear the ACTIVE pointer only if it still belongs to this loopId (guard against late responses). */
  function clearReviewIteration(loopId: string): void {
    if (activeReviewCheckpoint?.loopId === loopId) activeReviewCheckpoint = null
  }

  /** Remove a loop’s evidence/check buckets along with history eviction. */
  function forgetReviewLoop(loopId: string): void {
    reviewCheckpoints.delete(loopId)
    checksByLoop.delete(loopId)
    if (activeReviewCheckpoint?.loopId === loopId) activeReviewCheckpoint = null
  }

  /** Sanitized evidence for the specified LOOP, used by the controller for round validation and summaries. */
  function getReviewEvidence(loopId: string): BridgeReviewEvidence {
    const byIteration = reviewCheckpoints.get(loopId)
    return {
      contextLoaded,
      byIteration: byIteration ? Object.fromEntries(byIteration) : {},
      checks: [...(checksByLoop.get(loopId) ?? [])],
    }
  }

  // ---------------------------------------------------------------- tools

  async function toolNotifyTurnComplete(args: Record<string, unknown>) {
    const idempotencyKey = requireIdempotencyKey(args.idempotency_key)
    if (!idempotencyKey) {
      return ERR('idempotency_key must contain 8 to 128 safe characters and be reused on retries.')
    }
    if (ended) return ERR(SESSION_ENDED_MESSAGE)

    const deduplicated = completedKeys.has(idempotencyKey)
    if (!deduplicated) {
      completedKeys.add(idempotencyKey)
      while (completedKeys.size > MAX_COMPLETION_KEYS) {
        const oldest = completedKeys.values().next().value
        if (typeof oldest === 'string') completedKeys.delete(oldest)
        else break
      }
      completedTurns++
    }
    emit({ kind: 'turn-completed', idempotencyKey, deduplicated })
    return TEXT(
      deduplicated ? 'Completion was already received; the duplicate was safely ignored.' : 'Completion recorded.'
    )
  }

  async function toolSendToMaestrly(args: Record<string, unknown>) {
    const destination = args.destination === 'chat' || args.destination === 'plan' ? args.destination : null
    const markdown = typeof args.markdown === 'string' ? args.markdown.trim() : ''
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined
    const idempotencyKey = typeof args.idempotency_key === 'string' ? args.idempotency_key.trim() : ''
    const confidence =
      args.confidence === 'low' || args.confidence === 'medium' || args.confidence === 'high' ? args.confidence : null
    const uninspectedAreas = disclosureList(args, 'uninspected_areas')
    const assumptions = disclosureList(args, 'assumptions')
    if (!destination) return ERR('send_to_maestrly requires destination="chat" or destination="plan".')
    if (!markdown) return ERR('send_to_maestrly requires nonempty markdown.')
    if (title && title.length > MAX_DELIVERY_TITLE_CHARS) {
      return ERR(`Title is too long (limit ${MAX_DELIVERY_TITLE_CHARS} characters).`)
    }
    if (!IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
      return ERR('idempotency_key must contain 8 to 128 safe characters and be reused on retries.')
    }
    if (!options.deliver) return ERR('Delivery to Maestrly is unavailable in this session.')
    if (!confidence) return ERR('send_to_maestrly requires confidence="low", "medium" or "high".')
    if (!uninspectedAreas) {
      return ERR(
        `send_to_maestrly requires uninspected_areas as an array of up to ${MAX_DISCLOSURE_ITEMS} nonempty strings.`
      )
    }
    if (!assumptions) {
      return ERR(`send_to_maestrly requires assumptions as an array of up to ${MAX_DISCLOSURE_ITEMS} nonempty strings.`)
    }
    if (!contextLoaded) {
      return ERR('Insufficient investigation: call get_context before publishing any analysis in Maestrly.')
    }
    if (searches.length === 0) {
      return ERR('Insufficient investigation: use grep or glob to locate the relevant scope before publishing.')
    }
    if (readFiles.size === 0) {
      return ERR(
        'Insufficient investigation: read at least one relevant file with read_file before publishing; maps and diffs do not replace this read.'
      )
    }

    const disclosure: InvestigationDisclosure = { confidence, uninspectedAreas, assumptions }
    const finalMarkdown = `${markdown}\n\n${investigationReport(disclosure)}`
    if (finalMarkdown.length > MAX_DELIVERY_CHARS) {
      return ERR(
        `Delivery and coverage report are too large (${finalMarkdown.length} characters; limit ${MAX_DELIVERY_CHARS}).`
      )
    }

    const fingerprint = createHash('sha256')
      .update(destination)
      .update('\0')
      .update(title ?? '')
      .update('\0')
      .update(markdown)
      .update('\0')
      .update(JSON.stringify(disclosure))
      .digest('hex')

    const deliveredFingerprint = deliveredKeys.get(idempotencyKey)
    if (deliveredFingerprint && deliveredFingerprint !== fingerprint) {
      return ERR('idempotency_key was already used with different content; generate a new key for this delivery.')
    }
    let planReviewId: string | undefined
    if (destination === 'plan') {
      if (!options.planReview) return ERR('Plan review is unavailable in this session.')
      try {
        planReviewId = options.planReview.create(idempotencyKey, fingerprint)
      } catch (error) {
        if (error instanceof Error && error.message === 'plan-review-delivery-conflict') {
          return ERR('idempotency_key was already used with different content; generate a new key for this delivery.')
        }
        throw error
      }
    }
    const deliveredMessage = (deduplicated = false) =>
      destination === 'plan'
        ? `Plan ${deduplicated ? 'already received' : 'sent'} in the Maestrly Plan tab. plan_review_id: ${planReviewId}`
        : deduplicated
          ? 'Delivery was already received; the duplicate was safely ignored.'
          : 'Content sent to the originating conversation in Maestrly.'
    if (planReviewId && options.planReview?.isDelivered(planReviewId)) {
      emit({ kind: 'delivery', destination, idempotencyKey, chars: finalMarkdown.length, deduplicated: true })
      return TEXT(deliveredMessage(true))
    }
    if (deliveredFingerprint) {
      emit({ kind: 'delivery', destination, idempotencyKey, chars: finalMarkdown.length, deduplicated: true })
      return TEXT(deliveredMessage(true))
    }

    const inFlight = deliveryPromises.get(idempotencyKey)
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        return ERR('idempotency_key is already in use with different content; generate a new key for this delivery.')
      }
      await inFlight.promise
      if (ended) return ERR(SESSION_ENDED_MESSAGE)
      emit({ kind: 'delivery', destination, idempotencyKey, chars: finalMarkdown.length, deduplicated: true })
      return TEXT(deliveredMessage(true))
    }

    const delivery: BridgeDelivery = {
      destination,
      markdown: finalMarkdown,
      idempotencyKey,
      ...(planReviewId ? { planReviewId } : {}),
      ...(title ? { title } : {}),
    }
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    const promise = Promise.resolve(options.deliver(delivery))
    deliveryPromises.set(idempotencyKey, { fingerprint, promise })
    try {
      await promise
      // Delivery may have completed just as the session was revoked. Record manager-owned state first so
      // rearming cannot redeliver/stage the same plan; only then suppress the stale response.
      if (planReviewId) {
        const marked = options.planReview?.markDelivered(planReviewId)
        if (!marked?.ok) throw new Error(marked?.error ?? 'plan-review-delivery-state-failed')
      }
      if (ended) return ERR(SESSION_ENDED_MESSAGE)
      deliveredKeys.set(idempotencyKey, fingerprint)
      while (deliveredKeys.size > MAX_DELIVERY_KEYS) {
        const oldest = deliveredKeys.keys().next().value
        if (typeof oldest === 'string') deliveredKeys.delete(oldest)
        else break
      }
      deliveries++
      emit({ kind: 'delivery', destination, idempotencyKey, chars: finalMarkdown.length, deduplicated: false })
      return TEXT(deliveredMessage())
    } finally {
      deliveryPromises.delete(idempotencyKey)
    }
  }

  async function toolWaitPlanReview(args: Record<string, unknown>) {
    const reviewId = typeof args.plan_review_id === 'string' ? args.plan_review_id.trim() : ''
    const waitSeconds = args.wait_seconds === undefined ? undefined : args.wait_seconds
    if (!reviewId || reviewId.length > 128) return ERR('Invalid plan_review_id.')
    if (
      waitSeconds !== undefined &&
      (typeof waitSeconds !== 'number' ||
        !Number.isSafeInteger(waitSeconds) ||
        waitSeconds < 1 ||
        waitSeconds > MAX_PLAN_REVIEW_WAIT_SECONDS)
    ) {
      return ERR(`wait_seconds must be an integer between 1 and ${MAX_PLAN_REVIEW_WAIT_SECONDS}.`)
    }
    if (!options.planReview) return ERR('Plan review is unavailable in this session.')
    try {
      const outcome: PlanReviewOutcome = await options.planReview.wait(
        reviewId,
        lifecycleController.signal,
        waitSeconds as number | undefined
      )
      return TEXT(JSON.stringify({ plan_review_id: reviewId, ...outcome }))
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error)
      if (code === 'plan-review-not-found') {
        return ERR('plan-review-not-found: review does not exist or belongs to another conversation.')
      }
      if (code === 'plan-review-wait-aborted' || code === 'plan-review-controller-disposed') {
        return ERR('plan-review-wait-cancelled: the session or conversation ended.')
      }
      throw error
    }
  }

  // ---------------------------------------------------------------- review loop

  /** Controller errors → readable messages (the tool returns text for the model to act on). */
  const REVIEW_LOOP_ERRORS: Record<string, string> = {
    'review-loop-active':
      'A review loop is already active in this conversation. Finish with finish_review_loop or wait for the user to ' +
      'stop it (Stop button) before starting another.',
    'review-loop-inactive': 'The review loop ended before the turn started. Do not start another round.',
    'review-loop-cancelled': 'The review loop was cancelled.',
    'review-loop-stopping':
      'The review loop is shutting down (the agent is still stopping). Wait for the job to finish with ' +
      'wait_review_fix before starting another loop.',
    'project-environment-active':
      'The project environment is still being prepared. Wait with wait_project_environment before starting the review loop.',
    'summary-persist-failed':
      'The audit summary could not be saved. Call finish_review_loop again with the same result ' +
      'to retry; the message will not be duplicated.',
    'session-not-active': 'The companion session is inactive. Ask the user to start a session in Maestrly.',
    'invalid-max-iterations': `max_iterations must be an integer between 1 and ${HARD_MAX_ITERATIONS}.`,
    'invalid-review-scope': 'review_scope must be "code" or "frontend".',
    'preview-options-require-frontend': 'preview_id/browser_id can only be used with review_scope="frontend".',
    'frontend-environment-required':
      'Frontend review requires exactly one browser_id from browser_list_tabs or preview_id from discover_frontend_previews.',
    'frontend-environment-conflict':
      'Pass only one frontend source: browser_id for an existing tab OR preview_id for a managed preview.',
    'target-url-not-allowed':
      'target_url is not accepted. Use browser_list_tabs/browser_id or discover_frontend_previews/preview_id.',
    'frontend-preview-unavailable': 'The frontend preview runtime is unavailable in this session.',
    'frontend-browser-unavailable': 'The built-in browser is unavailable in this session.',
    'browser-capability-off':
      "Browser / Visual review is Off. In this conversation's ChatGPT tab in Maestrly, click Access, choose Inspect or Interact, then Restart to apply.",
    'idempotency-conflict': 'idempotency_key was already used with different content; generate a new key.',
    'no-turn-or-operation': 'Cannot start the review loop now: a turn or operation is active in this conversation.',
    'pending-plan':
      'A pending plan is awaiting a decision in the Plan tab. Resolve it before starting the review loop.',
    'no-provider': 'No provider/model is available to run the loop.',
    'no-model': 'The executor model is unavailable; the loop ended (executor_unavailable).',
    'no-key': 'The executor is not authenticated; the loop ended (executor_unavailable).',
    'executor-unavailable': 'The executor became unavailable; the loop ended (executor_unavailable).',
    'review-loop-failed':
      'The executor agent failed during the round; the review loop ended. Read the job result ' +
      'and finish with finish_review_loop(result="failed").',
    'review-loop-unavailable': 'The review loop is unavailable in this session.',
    'conversation-context-stale':
      'The main conversation context became stale before review started. ' +
      'Run get_conversation_context again and try starting the review loop.',
    'job-active': 'A fix job is already running. Wait with wait_review_fix before submitting another round.',
    'wrong-iteration': 'The supplied iteration does not match the current loop iteration.',
    'below-threshold': 'No finding meets the loop severity_threshold; adjust the round or finish.',
    'no-progress-repeat':
      'You resubmitted the same findings after a round with no changes; the loop ended due to lack of progress.',
    'no-progress-limit': 'Two consecutive rounds made no workspace changes; the loop ended due to lack of progress.',
    'max-iterations-reached': 'The iteration limit was reached; the loop ended.',
    'workspace-changed-externally': 'The workspace changed outside the loop between rounds; the loop ended.',
    'insufficient-investigation':
      'Insufficient investigation for this round: the bridge requires git_diff + grep/glob + read_file of the ' +
      'relevant implementation AFTER the latest execution.',
    'insufficient-browser-snapshot':
      'Insufficient visual evidence for this round: call browser_snapshot again after the latest execution.',
    'insufficient-browser-screenshot':
      'Insufficient visual evidence for this round: call browser_screenshot again after the latest execution.',
    'loop-not-found': 'No review loop found for this loop_id.',
    'unknown-job': 'Unknown job for this loop_id.',
    'session-ended': 'The companion session ended; the review loop was cancelled.',
    'inconsistent-result':
      'The supplied result is inconsistent with the actual loop state (an idempotent retry returns the original).',
    'loop-not-terminal':
      'The review loop is still active. Do not use failed, no_progress or cancelled merely to end this ' +
      'response: investigate with git_diff + grep/glob + read_file and submit the round. cancelled is only valid ' +
      'after the user clicks Stop and the bridge confirms cancellation.',
    'max-not-reached': 'The iteration limit has not been reached; submit more rounds or finish as clean.',
    'remaining-blocking-findings': 'Cannot finish as "clean" with remaining blocking/important findings.',
    'invalid-result': 'result must be "clean", "max_iterations", "no_progress", "failed" or "cancelled".',
    'empty-summary': 'finish_review_loop requires a nonempty summary.',
  }

  const reviewLoopError = (code: string): string => {
    const direct = REVIEW_LOOP_ERRORS[code]
    if (direct) return direct
    if (code.startsWith('frontend-preview-start-failed:')) {
      const detail = code.slice('frontend-preview-start-failed:'.length).trim()
      return `Visual Review could not start.${detail ? `\n\nDiagnostics:\n${detail}` : ''}`
    }
    if (code.startsWith('review-loop-')) return 'The review loop has already ended.'
    return `Review loop error: ${code}`
  }

  const requireIdempotencyKey = (value: unknown): string | null => {
    const key = typeof value === 'string' ? value.trim() : ''
    return IDEMPOTENCY_KEY_REGEX.test(key) ? key : null
  }

  async function toolDiscoverFrontendPreviews() {
    if (!options.reviewLoop) return ERR(reviewLoopError('review-loop-unavailable'))
    const previews = await options.reviewLoop.discoverFrontendPreviews()
    return TEXT(JSON.stringify(previews, null, 2))
  }

  function requireBrowserCapability(interaction = false): string | null {
    const capability = options.browserCapability ?? 'off'
    if (capability === 'off') return reviewLoopError('browser-capability-off')
    if (interaction && capability !== 'interact') {
      return 'Browser Interact is not authorized; this session only permits inspection.'
    }
    return null
  }

  async function toolBrowserListTabs() {
    const denied = requireBrowserCapability()
    if (denied) return ERR(denied)
    const tabs: CompanionBrowserTab[] = options.browserSession?.list() ?? []
    return TEXT(JSON.stringify(tabs, null, 2))
  }

  async function toolBrowserAttach(args: Record<string, unknown>) {
    const denied = requireBrowserCapability()
    if (denied) return ERR(denied)
    const browserId = typeof args.browser_id === 'string' ? args.browser_id.trim() : ''
    if (!browserId) return ERR('browser_attach requires a browser_id returned by browser_list_tabs.')
    if (!options.browserSession) return ERR('Embedded browser unavailable for this companion session.')
    try {
      const browser = await options.browserSession.attach(browserId)
      return TEXT(JSON.stringify({ browser_id: browserId, ...browser.info() }, null, 2))
    } catch (error) {
      return ERR(error instanceof Error ? error.message : String(error))
    }
  }

  async function toolBrowserDetach() {
    const denied = requireBrowserCapability()
    if (denied) return ERR(denied)
    await options.browserSession?.detach()
    return TEXT(JSON.stringify({ detached: true }))
  }

  const activeVisualBrowser = (interaction = false) => {
    const denied = requireBrowserCapability(interaction)
    if (denied) return { error: denied } as const
    const browser: BrowserSurface | null =
      options.reviewLoop?.visualBrowser() ?? options.browserSession?.active() ?? null
    if (!browser) {
      return {
        error: 'No browser attached. Use browser_list_tabs + browser_attach, or start a frontend review.',
      } as const
    }
    return { browser } as const
  }

  async function toolStartProjectEnvironment(args: Record<string, unknown>) {
    const denied = requireBrowserCapability(true)
    if (denied) return ERR(denied)
    if (!options.projectEnvironment) return ERR('Project environment bootstrap is unavailable.')
    const idempotencyKey = requireIdempotencyKey(args.idempotency_key)
    if (!idempotencyKey) {
      return ERR('idempotency_key must contain 8 to 128 safe characters and be reused on retries.')
    }
    const skillName = typeof args.skill === 'string' ? args.skill.trim() : ''
    if (!skillName) return ERR('start_project_environment requires skill.')
    const skills = (await options.listSkills?.()) ?? []
    if (!skills.some((skill) => skill.name === skillName)) {
      return ERR('Skill does not exist or is disabled in this conversation. Use get_context to list enabled skills.')
    }
    const skillBody = await options.readSkill?.(skillName)
    if (!skillBody) return ERR('Could not read the selected enabled skill.')
    const result = await options.projectEnvironment.start({ skillName, skillBody, idempotencyKey })
    return 'error' in result ? ERR(`Project environment: ${result.error}`) : TEXT(JSON.stringify(result, null, 2))
  }

  async function toolWaitProjectEnvironment(args: Record<string, unknown>) {
    if (!options.projectEnvironment) return ERR('Project environment bootstrap is unavailable.')
    const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : ''
    if (!jobId) return ERR('wait_project_environment requires job_id.')
    const waitSeconds = args.wait_seconds === undefined ? undefined : Number(args.wait_seconds)
    const result = await options.projectEnvironment.wait(
      { jobId, ...(waitSeconds === undefined ? {} : { waitSeconds }) },
      lifecycleController.signal
    )
    return 'error' in result ? ERR(`Project environment: ${result.error}`) : TEXT(JSON.stringify(result, null, 2))
  }

  function toolCancelProjectEnvironment(args: Record<string, unknown>) {
    if (!options.projectEnvironment) return ERR('Project environment bootstrap is unavailable.')
    const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : ''
    if (!jobId) return ERR('cancel_project_environment requires job_id.')
    const result = options.projectEnvironment.cancel({ jobId })
    return 'error' in result ? ERR(`Project environment: ${result.error}`) : TEXT(JSON.stringify(result, null, 2))
  }

  async function toolBrowserSnapshot() {
    const active = activeVisualBrowser()
    if ('error' in active) return ERR(active.error ?? 'Visual review browser unavailable.')
    const owner = captureReviewEvidenceOwner()
    const result = await active.browser.snapshot()
    checkpointFor(owner, 'browserSnapshot')
    return TEXT(JSON.stringify(result, null, 2))
  }

  async function toolBrowserScreenshot(): Promise<BridgeToolResult> {
    const active = activeVisualBrowser()
    if ('error' in active) return ERR(active.error ?? 'Visual review browser unavailable.')
    const owner = captureReviewEvidenceOwner()
    const result = await active.browser.screenshot()
    checkpointFor(owner, 'browserScreenshot')
    return {
      content: [
        { type: 'image', data: result.data, mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify(result.metadata) },
      ],
    }
  }

  async function toolBrowserReadText() {
    const active = activeVisualBrowser()
    if ('error' in active) return ERR(active.error ?? 'Visual review browser unavailable.')
    return TEXT(await active.browser.readText())
  }

  async function toolBrowserWait(args: Record<string, unknown>) {
    const active = activeVisualBrowser()
    if ('error' in active) return ERR(active.error ?? 'Visual review browser unavailable.')
    const timeoutMs = args.timeout_ms === undefined ? undefined : Number(args.timeout_ms)
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)) {
      return ERR('timeout_ms must be an integer between 1 and 60000.')
    }
    const result = await active.browser.waitFor({
      ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
      ...(typeof args.text === 'string' ? { text: args.text } : {}),
      ...(typeof args.network_idle === 'boolean' ? { networkIdle: args.network_idle } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    })
    return TEXT(JSON.stringify(result))
  }

  async function toolBrowserNavigate(args: Record<string, unknown>) {
    const active = activeVisualBrowser(true)
    if ('error' in active) return ERR(active.error ?? 'Visual review browser unavailable.')
    if (typeof args.url !== 'string' || !args.url.trim()) return ERR('browser_navigate requires url.')
    const owner = captureReviewEvidenceOwner()
    const result = await active.browser.navigate(args.url.trim())
    checkpointFor(owner, 'browserNavigation')
    return TEXT(JSON.stringify(result))
  }

  async function toolBrowserReload() {
    const active = activeVisualBrowser(true)
    if ('error' in active) return ERR(active.error ?? 'Visual review browser unavailable.')
    const owner = captureReviewEvidenceOwner()
    const result = await active.browser.reload()
    checkpointFor(owner, 'browserNavigation')
    return TEXT(JSON.stringify(result))
  }

  async function toolBrowserScroll(args: Record<string, unknown>) {
    const active = activeVisualBrowser()
    if ('error' in active) return ERR(active.error ?? 'Visual review browser unavailable.')
    const number = (key: string): number | undefined =>
      typeof args[key] === 'number' && Number.isFinite(args[key]) ? (args[key] as number) : undefined
    const to = args.to === 'top' || args.to === 'bottom' ? args.to : undefined
    const owner = captureReviewEvidenceOwner()
    const result = await active.browser.scroll({
      dx: number('dx'),
      dy: number('dy'),
      x: number('x'),
      y: number('y'),
      ...(to ? { to } : {}),
      ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
      ...(typeof args.container === 'string' ? { container: args.container } : {}),
    })
    checkpointFor(owner, 'browserNavigation')
    return TEXT(JSON.stringify(result))
  }

  async function toolBrowserConsoleLogs(args: Record<string, unknown>) {
    const active = activeVisualBrowser()
    if ('error' in active) return ERR(active.error ?? 'Visual review browser unavailable.')
    const logs = await active.browser.consoleLogs(
      typeof args.level === 'string' ? args.level : undefined,
      typeof args.limit === 'number' ? args.limit : undefined
    )
    return TEXT(JSON.stringify(logs, null, 2))
  }

  async function toolBrowserNetworkLogs(args: Record<string, unknown>) {
    const active = activeVisualBrowser()
    if ('error' in active) return ERR(active.error ?? 'Visual review browser unavailable.')
    const logs = await active.browser.networkLogs(
      args.only_errors === true,
      typeof args.limit === 'number' ? args.limit : undefined
    )
    return TEXT(JSON.stringify(logs, null, 2))
  }

  async function toolBrowserInteraction(name: string, args: Record<string, unknown>) {
    const active = activeVisualBrowser(true)
    if ('error' in active) return ERR(active.error ?? 'Visual review browser unavailable.')
    const owner = captureReviewEvidenceOwner()
    if (name === 'browser_click' || name === 'browser_double_click') {
      const ref = Number(args.ref)
      if (!Number.isInteger(ref) || ref < 0) return ERR(`${name} requires an integer ref >= 0.`)
      if (name === 'browser_click') await active.browser.click(ref)
      else await active.browser.doubleClick(ref)
    } else if (name === 'browser_type') {
      const ref = Number(args.ref)
      if (!Number.isInteger(ref) || ref < 0 || typeof args.text !== 'string') {
        return ERR('browser_type requires an integer ref >= 0 and text.')
      }
      await active.browser.type(ref, args.text, args.clear === true)
    } else if (name === 'browser_press_key') {
      if (typeof args.key !== 'string' || !args.key) return ERR('browser_press_key requires key.')
      const modifiers = Array.isArray(args.modifiers)
        ? args.modifiers.filter((item): item is string => ['Control', 'Meta', 'Alt', 'Shift'].includes(String(item)))
        : undefined
      await active.browser.pressKey(args.key, modifiers)
    } else if (name === 'browser_drag') {
      const fromRef = Number(args.from_ref)
      const toRef = Number(args.to_ref)
      if (!Number.isInteger(fromRef) || fromRef < 0 || !Number.isInteger(toRef) || toRef < 0) {
        return ERR('browser_drag requires integer from_ref and to_ref >= 0.')
      }
      await active.browser.drag(fromRef, toRef)
    }
    checkpointFor(owner, 'browserInteraction')
    return TEXT(JSON.stringify({ ok: true }))
  }

  async function toolStartReviewLoop(args: Record<string, unknown>) {
    if (!options.reviewLoop) return ERR(reviewLoopError('review-loop-unavailable'))
    const idempotencyKey = requireIdempotencyKey(args.idempotency_key)
    if (!idempotencyKey) {
      return ERR('idempotency_key must contain 8 to 128 safe characters and be reused on retries.')
    }
    const knownStartRetry = startedReviewKeys.has(idempotencyKey)
    if (options.conversation && !conversationContextLoaded && !knownStartRetry) {
      return ERR(
        'Conversation=Read requires loading the main conversation decisions. ' +
          'Run get_conversation_context before starting the review.'
      )
    }
    let maxIterations = DEFAULT_MAX_ITERATIONS
    if (args.max_iterations !== undefined && args.max_iterations !== null) {
      const raw = Number(args.max_iterations)
      if (!Number.isInteger(raw) || raw < 1 || raw > HARD_MAX_ITERATIONS) {
        return ERR(reviewLoopError('invalid-max-iterations'))
      }
      maxIterations = raw
    }
    let severityThreshold: 'blocking' | 'important' = 'important'
    if (args.severity_threshold !== undefined && args.severity_threshold !== null) {
      if (args.severity_threshold !== 'blocking' && args.severity_threshold !== 'important') {
        return ERR('severity_threshold must be "blocking" or "important".')
      }
      severityThreshold = args.severity_threshold
    }
    const reviewScope = args.review_scope === undefined ? 'code' : args.review_scope
    if (reviewScope !== 'code' && reviewScope !== 'frontend') return ERR(reviewLoopError('invalid-review-scope'))
    if (Object.hasOwn(args, 'target_url')) {
      return ERR(reviewLoopError('target-url-not-allowed'))
    }
    const previewId = typeof args.preview_id === 'string' ? args.preview_id.trim() : ''
    const browserId = typeof args.browser_id === 'string' ? args.browser_id.trim() : ''
    if (
      reviewScope === 'frontend' &&
      options.browserCapability !== 'inspect' &&
      options.browserCapability !== 'interact'
    ) {
      return ERR(reviewLoopError('browser-capability-off'))
    }
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    if (options.conversation && !knownStartRetry) {
      const currentRevision = await options.conversation.getRevision(lifecycleController.signal)
      if (currentRevision !== conversationContextRevision) {
        conversationContextLoaded = false
        conversationContextRevision = undefined
        return ERR(reviewLoopError('conversation-context-stale'))
      }
    }
    const result = await options.reviewLoop.start({
      reviewScope,
      ...(previewId ? { previewId } : {}),
      ...(browserId ? { browserId } : {}),
      maxIterations,
      severityThreshold,
      idempotencyKey,
    })
    if ('error' in result) return ERR(reviewLoopError(result.error))
    if (options.conversation) {
      startedReviewKeys.add(idempotencyKey)
      while (startedReviewKeys.size > MAX_COMPLETION_KEYS) {
        const oldest = startedReviewKeys.values().next().value
        if (typeof oldest === 'string') startedReviewKeys.delete(oldest)
        else break
      }
      // A brief authorizes one review start only. Consume it immediately so a cancelled/ended loop
      // cannot start again with stale context; retries remain allowed by startedReviewKeys above.
      conversationContextLoaded = false
      conversationContextRevision = undefined
    }
    emit({ kind: 'review-loop-started', loopId: result.loopId, maxIterations: result.maxIterations })
    return TEXT(JSON.stringify(result, null, 2))
  }

  async function toolSubmitReviewFix(args: Record<string, unknown>) {
    if (!options.reviewLoop) return ERR(reviewLoopError('review-loop-unavailable'))
    const loopId = typeof args.loop_id === 'string' ? args.loop_id.trim() : ''
    const idempotencyKey = requireIdempotencyKey(args.idempotency_key)
    if (!loopId) return ERR('submit_review_fix requires loop_id returned by start_review_loop.')
    if (!idempotencyKey) {
      return ERR('idempotency_key must contain 8 to 128 safe characters and be reused on retries.')
    }
    const iteration = Number(args.iteration)
    if (!Number.isInteger(iteration) || iteration < 1) {
      return ERR('submit_review_fix requires iteration (integer >= 1).')
    }
    const shaped = validateFindingsShape(args.findings)
    if (!shaped.ok) return ERR(shaped.error)
    let reviewerNotes: string | undefined
    if (args.reviewer_notes !== undefined && args.reviewer_notes !== null) {
      if (typeof args.reviewer_notes !== 'string' || args.reviewer_notes.length > MAX_REVIEWER_NOTES_CHARS) {
        return ERR(`reviewer_notes must be text of up to ${MAX_REVIEWER_NOTES_CHARS} characters.`)
      }
      reviewerNotes = args.reviewer_notes.trim()
    }
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    const result = await options.reviewLoop.submit({
      loopId,
      iteration,
      findings: shaped.findings,
      ...(reviewerNotes ? { reviewerNotes } : {}),
      idempotencyKey,
    })
    if ('error' in result) return ERR(reviewLoopError(result.error))
    reviewJobs += 1
    reviewIterations = Math.max(reviewIterations, result.iteration)
    emit({
      kind: 'review-fix-started',
      jobId: result.jobId,
      iteration: result.iteration,
      findings: shaped.findings.length,
    })
    return TEXT(JSON.stringify(result, null, 2))
  }

  async function toolWaitReviewFix(args: Record<string, unknown>) {
    if (!options.reviewLoop) return ERR(reviewLoopError('review-loop-unavailable'))
    const loopId = typeof args.loop_id === 'string' ? args.loop_id.trim() : ''
    const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : ''
    if (!loopId || !jobId) return ERR('wait_review_fix requires loop_id and job_id returned by submit_review_fix.')
    let waitSeconds = 45
    if (args.wait_seconds !== undefined && args.wait_seconds !== null) {
      const raw = Number(args.wait_seconds)
      if (!Number.isInteger(raw) || raw < 1 || raw > MAX_WAIT_SECONDS) {
        return ERR(`wait_seconds must be an integer between 1 and ${MAX_WAIT_SECONDS}.`)
      }
      waitSeconds = raw
    }
    // Server-side long-poll: bridge lifecycle (session end) aborts the wait.
    const result = await options.reviewLoop.wait({ loopId, jobId, waitSeconds }, lifecycleController.signal)
    if ('error' in result) {
      if (ended) return ERR(SESSION_ENDED_MESSAGE)
      return ERR(reviewLoopError(result.error))
    }
    if (result.status !== 'running') {
      emit({
        kind: 'review-fix-finished',
        jobId,
        iteration: result.iteration,
        status: result.status,
        madeProgress: result.madeProgress,
      })
    }
    return TEXT(JSON.stringify(result, null, 2))
  }

  async function toolFinishReviewLoop(args: Record<string, unknown>) {
    if (!options.reviewLoop) return ERR(reviewLoopError('review-loop-unavailable'))
    const loopId = typeof args.loop_id === 'string' ? args.loop_id.trim() : ''
    const idempotencyKey = requireIdempotencyKey(args.idempotency_key)
    if (!loopId) return ERR('finish_review_loop requires loop_id.')
    if (!idempotencyKey) {
      return ERR('idempotency_key must contain 8 to 128 safe characters and be reused on retries.')
    }
    const result =
      args.result === 'clean' ||
      args.result === 'max_iterations' ||
      args.result === 'no_progress' ||
      args.result === 'failed' ||
      args.result === 'cancelled'
        ? args.result
        : null
    if (!result) return ERR(reviewLoopError('invalid-result'))
    if (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > MAX_FINISH_SUMMARY_CHARS) {
      return ERR(reviewLoopError('empty-summary'))
    }
    const remaining = validateRemainingFindingsShape(args.remaining_findings)
    if (!remaining.ok) return ERR(remaining.error)
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    const finished = await options.reviewLoop.finish({
      loopId,
      result,
      summary: args.summary.trim(),
      ...(remaining.items.length ? { remainingFindings: remaining.items } : {}),
      idempotencyKey,
    })
    if ('error' in finished) {
      // The controller archives the loop before a summary-persist failure; consume the brief now so a
      // new loop cannot start with stale context while the same finish is retried idempotently.
      if (options.conversation && finished.error === 'summary-persist-failed') {
        conversationContextLoaded = false
        conversationContextRevision = undefined
      }
      return ERR(reviewLoopError(finished.error))
    }
    // A successful completion consumes the brief authorization. A later review in this session must
    // reread the main conversation; retries of this finish remain idempotent because they do not gate
    // on the authorization and the controller owns the canonical finish result.
    if (options.conversation) {
      conversationContextLoaded = false
      conversationContextRevision = undefined
    }
    emit({
      kind: 'review-loop-finished',
      loopId: finished.loopId,
      result: finished.result,
      iterations: finished.iterations,
      ...(finished.finishReason ? { finishReason: finished.finishReason } : {}),
    })
    return TEXT(JSON.stringify(finished, null, 2))
  }

  async function buildContext(signal: AbortSignal, pendingStages: Set<string>): Promise<BridgeToolResult> {
    const stage = async <T>(name: string, promise: Promise<T>): Promise<T> => {
      pendingStages.add(name)
      try {
        return await promise
      } finally {
        pendingStages.delete(name)
      }
    }
    const projectContext = () =>
      stage(
        'project-context',
        Promise.resolve()
          .then(() => options.projectContext?.() ?? '')
          .catch(() => '')
      )
    const projectSkills = () =>
      stage(
        'skills',
        Promise.resolve()
          .then(() => options.listSkills?.() ?? [])
          .catch(() => [] as BridgeCheck[])
      )
    const memoryStatus = () =>
      stage(
        'memory-status',
        Promise.resolve()
          .then(() => options.memory?.status(signal) ?? { enabled: false, reason: 'memory-unavailable' })
          .catch((error) => ({
            enabled: false,
            reason: error instanceof Error ? error.message : String(error),
          }))
      )

    if (options.repositoryScope?.isMulti) {
      const repositories = await stage(
        'git-repositories',
        Promise.all(
          options.repositoryScope.repositories.map(async (repository) => {
            if (options.gitReadEnabled === false) return { repo: repository.linkName, git: '(Git desabilitado)' }
            try {
              const git = await options.external?.gitRead({ operation: 'status', repo: repository.linkName }, signal)
              return { repo: repository.linkName, branch: repository.branch, base: repository.base, git }
            } catch (error) {
              if (signal.aborted) throw error
              return { repo: repository.linkName, error: error instanceof Error ? error.message : String(error) }
            }
          })
        )
      )
      const [project, skills, memory] = await Promise.all([projectContext(), projectSkills(), memoryStatus()])
      return TEXT(
        [
          '# Contexto multi-repo',
          'Each prefix below resolves directly to the persisted worktree; the aggregator is not a trusted root.',
          '',
          JSON.stringify(repositories, null, 2),
          ...(skills.length
            ? ['', '## Project skills', ...skills.map((skill) => `- \`${skill.name}\` — ${skill.description}`)]
            : []),
          ...(project.trim() ? ['', '## Project instructions', project.trim()] : []),
          '',
          '## Memory Center',
          JSON.stringify(memory, null, 2),
          'Use search_project_memory to retrieve content on demand.',
        ].join('\n')
      )
    }
    if (options.gitReadEnabled === false) {
      const [project, memory] = await Promise.all([projectContext(), memoryStatus()])
      return TEXT(
        `# Repository context\nGit disabled for this session.\n\n${project}\n\n## Memory Center\n${JSON.stringify(memory, null, 2)}\nUse search_project_memory to retrieve content on demand.`
      )
    }
    const [branch, stat, files, commits, status, indexedFiles, project, skills, memory] = await Promise.all([
      stage('git-branch', git(['rev-parse', '--abbrev-ref', 'HEAD'], '(desconhecida)', signal)),
      stage('git-diff-stat', git(['diff', '--stat', `${gitBase}...HEAD`], '', signal)),
      stage('git-diff-files', git(['diff', '--name-status', `${gitBase}...HEAD`], '', signal)),
      stage('git-log', git(['log', '--oneline', '-10'], '', signal)),
      stage('git-status', git(['status', '--porcelain'], '', signal)),
      stage('git-index', git(['ls-files', '--cached', '--others', '--exclude-standard'], '', signal)),
      projectContext(),
      projectSkills(),
      memoryStatus(),
    ])
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    const repositoryMap = await stage(
      'repository-map',
      buildRepositoryMap(cwd, indexedFiles).catch(
        () => '## Automatic repository map\n(unavailable; use `glob` to discover the structure)'
      )
    )
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    const checks = options.listChecks?.() ?? []
    const sections = [
      `# Repository context`,
      `root: ${cwd}`,
      `branch: ${branch} (diff base: ${gitBase})`,
      'integration: manual ChatGPT Web companion',
      '',
      repositoryMap,
      '',
      '## Diff stat vs base',
      stat || '(no differences from the base)',
      '',
      '## Changed files vs base',
      files || '(none)',
      '',
      '## Working tree (git status --porcelain)',
      status || '(clean)',
      '',
      '## Latest commits',
      commits || '(no commits)',
    ]
    if (checks.length) {
      sections.push(
        '',
        '## Available checks (`run_check` tool)',
        ...checks.map((check) => `- \`${check.name}\` — ${check.description}`)
      )
    }
    if (skills.length) {
      sections.push(
        '',
        '## Project skills (use `read_skill` for content)',
        ...skills.map((skill) => `- \`${skill.name}\` — ${skill.description}`)
      )
    }
    if (project.trim()) {
      sections.push('', '## Project instructions', project.trim())
    }
    sections.push(
      '',
      '## Memory Center',
      JSON.stringify(memory, null, 2),
      'Use search_project_memory to retrieve relevant memories; the corpus is not included in this brief.'
    )
    return TEXT(sections.join('\n'))
  }

  async function toolGetContext(): Promise<BridgeToolResult> {
    const timeoutMs = Math.max(1, options.getContextTimeoutMs ?? GET_CONTEXT_TIMEOUT_MS)
    const pendingStages = new Set<string>()
    const contextController = new AbortController()
    const forwardLifecycleAbort = () => contextController.abort()
    lifecycleController.signal.addEventListener('abort', forwardLifecycleAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<BridgeToolResult>((resolve) => {
        timer = setTimeout(() => {
          contextController.abort()
          const pending = [...pendingStages].sort()
          resolve(
            TEXT(
              [
                '# Repository context (partial)',
                `root: ${cwd}`,
                '',
                `Detailed bootstrap exceeded ${timeoutMs} ms and was stopped to avoid blocking the conversation.`,
                ...(pending.length ? [`Omitted stages: ${pending.join(', ')}.`] : []),
                'Continue investigating with `glob`, `grep`, and `read_file`.',
              ].join('\n')
            )
          )
        }, timeoutMs)
        timer.unref?.()
      })
      const result = await Promise.race([buildContext(contextController.signal, pendingStages), deadline])
      if (ended) return ERR(SESSION_ENDED_MESSAGE)
      contextLoaded = true
      return result
    } finally {
      if (timer) clearTimeout(timer)
      lifecycleController.signal.removeEventListener('abort', forwardLifecycleAbort)
    }
  }

  async function toolRunCheck(args: Record<string, unknown>) {
    // Capture the owner BEFORE any await: the check belongs to the loop/iteration at admission.
    const evidenceOwner = captureReviewEvidenceOwner()
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    const checks = options.listChecks?.() ?? []
    if (!options.runCheck || checks.length === 0) {
      return ERR('No checks are enabled for this project (Settings › Maestrly Chat).')
    }
    if (!name || !checks.some((check) => check.name === name)) {
      // The model selects known names; arbitrary commands never reach the executor.
      return ERR(`Unknown check: "${name}". Available: ${checks.map((c) => c.name).join(', ')}.`)
    }
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    const result = await options.runCheck(name, lifecycleController.signal)
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    rememberSet(executedChecks, name)
    // Loop auditing uses the captured owner, never the active pointer at completion.
    rememberCheckFor(evidenceOwner, name)
    const head = result.timedOut
      ? `\`${name}\` exceeded the timeout`
      : result.aborted
        ? `\`${name}\` was cancelled`
        : `\`${name}\` finished with exit code ${result.exitCode ?? 'null'}`
    return TEXT(`${head}\n\n${result.output || '(no output)'}`)
  }

  async function toolReadSkill(args: Record<string, unknown>) {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) return ERR('read_skill requires "name" (see the list in get_context).')
    const body = await options.readSkill?.(name)
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    if (!body) return ERR(`Skill not found: "${name}".`)
    rememberSet(readSkills, name)
    return TEXT(body)
  }

  async function toolReadFile(args: Record<string, unknown>) {
    // Capture the owner BEFORE the first await: evidence belongs to the loop/iteration at admission.
    const evidenceOwner = captureReviewEvidenceOwner()
    const rel = typeof args.path === 'string' ? args.path : ''
    if (!rel) return ERR('read_file requires "path" (relative to the repository root).')
    let target: string
    let displayPath = rel
    try {
      const resolved = await canonicalPathInside(rel)
      target = resolved.target
      displayPath = resolved.displayPath
    } catch (error) {
      return ERR(error instanceof Error ? error.message : String(error))
    }
    if (isBinaryExt(target)) return ERR(`Unsupported binary file: ${rel}`)

    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    let buf: Buffer
    try {
      // O_NOFOLLOW narrows the realpath/open race for swapping the final component with a symlink.
      handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const stat = await handle.stat()
      if (!stat.isFile()) return ERR(`Could not read ${rel}: the path is not a regular file.`)
      if (stat.size > MAX_READ_BYTES) {
        return ERR(`File too large for read_file: ${rel} has ${stat.size} bytes (limit ${MAX_READ_BYTES} bytes).`)
      }
      // Read at most the already validated size; concurrent growth cannot bypass the cap.
      buf = Buffer.alloc(stat.size)
      let bytesRead = 0
      while (bytesRead < buf.length) {
        if (ended) return ERR(SESSION_ENDED_MESSAGE)
        const chunk = await handle.read(buf, bytesRead, buf.length - bytesRead, bytesRead)
        if (chunk.bytesRead === 0) break
        bytesRead += chunk.bytesRead
      }
      buf = buf.subarray(0, bytesRead)
    } catch (error) {
      return ERR(`Could not read ${rel}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await handle?.close().catch(() => undefined)
    }
    if (isProbablyBinary(buf)) return ERR(`Unsupported binary file: ${rel}`)
    const lines = buf.toString('utf8').split('\n')
    const offset = Math.max(1, Number(args.offset) || 1)
    const limit = Math.min(MAX_READ_LINES, Math.max(1, Number(args.limit) || MAX_READ_LINES))
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    if (slice.length === 0) return ERR(`offset ${offset} outside the file (${lines.length} lines).`)
    const body = slice
      .map((line, i) => {
        const clipped = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… (line truncated)` : line
        return `${String(offset + i).padStart(5)}| ${clipped}`
      })
      .join('\n')
    const end = offset + slice.length - 1
    const more = end < lines.length ? `\n\n… (truncated; continue with offset=${end + 1})` : ''
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    rememberSet(readFiles, displayPath)
    checkpointFor(evidenceOwner, 'read')
    return TEXT(`${rel} (lines ${offset}-${end} of ${lines.length})\n${body}${more}`)
  }

  async function toolGitDiff(args: Record<string, unknown>) {
    // Capture the owner BEFORE the first await: evidence belongs to the loop/iteration at admission.
    const evidenceOwner = captureReviewEvidenceOwner()
    if (options.gitReadEnabled === false) return ERR('git-read-disabled')
    const target = typeof args.path === 'string' && args.path ? args.path : ''
    if (options.repositoryScope?.isMulti) {
      const scope = options.repositoryScope
      const normalizedTarget = target.replaceAll('\\', '/')
      const repoFromPath = normalizedTarget ? normalizedTarget.split('/')[0] : undefined
      const explicitRepo = typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : undefined
      const inferredRepository = repoFromPath
        ? scope.repositories.find((repository) => repository.linkName === repoFromPath)
        : undefined
      const selectedRepository =
        explicitRepo || inferredRepository
          ? scope.resolveRepository(explicitRepo ?? inferredRepository?.linkName)
          : undefined
      const repositories = selectedRepository ? [selectedRepository] : scope.repositories

      const extractDiff = (value: unknown): string => {
        if (typeof value === 'string') return value
        if (value && typeof value === 'object') {
          const data = (value as { data?: unknown }).data
          if (typeof data === 'string') return data
          if (data && typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string') {
            const text = (data as { text: string; truncated?: boolean }).text
            return (data as { truncated?: boolean }).truncated ? `${text}\n… [diff truncated]` : text
          }
        }
        return JSON.stringify(value ?? null, null, 2)
      }

      let out = ''
      let clipped = false
      const append = (piece: string) => {
        if (!piece) return
        if (out.length >= MAX_DIFF_CHARS) {
          clipped = true
          return
        }
        const separator = out ? '\n\n' : ''
        const available = MAX_DIFF_CHARS - out.length - separator.length
        if (available <= 0) {
          clipped = true
          return
        }
        out += separator + piece.slice(0, available)
        if (piece.length > available) clipped = true
      }

      for (const repository of repositories) {
        const innerPath =
          repoFromPath === repository.linkName ? normalizedTarget.slice((repoFromPath?.length ?? 0) + 1) : target
        const result = await options.external?.gitRead(
          {
            operation: 'diff',
            repo: repository.linkName,
            ref: repository.base,
            ...(innerPath ? { path: innerPath } : {}),
          },
          lifecycleController.signal
        )
        if (!result) return ERR('external-capabilities-unavailable')
        const diff = extractDiff(result)
        if (!diff) continue
        append(repositories.length > 1 ? `## ${repository.linkName}\n${diff}` : diff)
        if (out.length >= MAX_DIFF_CHARS) break
      }

      rememberSet(inspectedDiffs, target || '(all repositories)')
      checkpointFor(evidenceOwner, 'diff')
      if (!out) return TEXT('(empty diff)')
      return TEXT(clipped ? `${out}\n… [diff truncated]` : out)
    }
    if (target) {
      const { external } = resolveInside(cwd, target)
      if (external) return ERR('Path is outside the repository exposed by the bridge.')
    }

    let out = ''
    let clipped = false
    const append = (piece: string) => {
      if (!piece) return
      if (out.length >= MAX_DIFF_CHARS) {
        clipped = true
        return
      }
      const separator = out ? '\n\n' : ''
      const available = MAX_DIFF_CHARS - out.length - separator.length
      if (available <= 0) {
        clipped = true
        return
      }
      out += separator + piece.slice(0, available)
      if (piece.length > available) clipped = true
    }

    const pathArgs = target ? ['--', target] : []
    const committed = await git(['diff', `${gitBase}...HEAD`, ...pathArgs])
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    append(committed)

    // `git diff <base>...HEAD` omits the index and working tree. HEAD includes both staged and unstaged
    // tracked changes, so keep the two sections distinct and combine them for the companion view.
    const workingTree = await git(['diff', 'HEAD', ...pathArgs])
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    append(workingTree)

    // Git deliberately leaves untracked files out of `diff`; add bounded text patches where the file is
    // still inside the canonical repository jail. Symlinks are read with O_NOFOLLOW and skipped on races.
    const untracked = await git(['ls-files', '--others', '--exclude-standard'])
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    const targetAbs = target ? resolveInside(cwd, target).abs : null
    const candidates = untracked
      .split('\n')
      .map((item) => item.trim())
      .filter((item) => item && !item.includes('\0') && !/[\r\n]/.test(item))
    let untrackedCount = 0
    for (const relative of candidates) {
      if (ended) return ERR(SESSION_ENDED_MESSAGE)
      if (out.length >= MAX_DIFF_CHARS) break
      if (untrackedCount >= MAX_UNTRACKED_FILES) break
      const candidate = resolveInside(cwd, relative)
      if (candidate.external) continue
      if (targetAbs) {
        const distance = path.relative(targetAbs, candidate.abs)
        if (
          distance !== '' &&
          (distance.startsWith(`..${path.sep}`) || distance === '..' || path.isAbsolute(distance))
        ) {
          continue
        }
      }
      let safeFile: string
      try {
        safeFile = (await canonicalPathInside(relative)).target
      } catch {
        continue
      }
      untrackedCount++
      if (isBinaryExt(safeFile)) {
        append(
          `diff --git a/${relative} b/${relative}\nnew file mode 100644\nBinary files /dev/null and b/${relative} differ`
        )
        continue
      }

      let handle: Awaited<ReturnType<typeof fs.open>> | undefined
      let buf: Buffer | undefined
      try {
        handle = await fs.open(safeFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
        const stat = await handle.stat()
        if (!stat.isFile()) continue
        if (stat.size > MAX_READ_BYTES) {
          append(`Untracked file omitted because it exceeds the limit of ${MAX_READ_BYTES} bytes: ${relative}`)
          continue
        }
        buf = Buffer.alloc(stat.size)
        let bytesRead = 0
        while (bytesRead < buf.length) {
          if (ended) return ERR(SESSION_ENDED_MESSAGE)
          const chunk = await handle.read(buf, bytesRead, buf.length - bytesRead, bytesRead)
          if (chunk.bytesRead === 0) break
          bytesRead += chunk.bytesRead
        }
        buf = buf.subarray(0, bytesRead)
      } catch {
        continue
      } finally {
        await handle?.close().catch(() => undefined)
      }
      if (isProbablyBinary(buf ?? Buffer.alloc(0))) {
        append(
          `diff --git a/${relative} b/${relative}\nnew file mode 100644\nBinary files /dev/null and b/${relative} differ`
        )
        continue
      }
      const text = (buf ?? Buffer.alloc(0)).toString('utf8')
      const bodyLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
      const lineCount = text ? bodyLines.length : 0
      const body = text ? bodyLines.map((line) => `+${line}`).join('\n') : ''
      append(
        [
          `diff --git a/${relative} b/${relative}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${relative}`,
          `@@ -0,0 +1,${lineCount} @@`,
          body,
        ]
          .filter(Boolean)
          .join('\n') + (text.endsWith('\n') ? '\n' : '')
      )
    }

    rememberSet(inspectedDiffs, target || '(entire repository)')
    checkpointFor(evidenceOwner, 'diff')
    if (!out) return TEXT('(empty diff)')
    return TEXT(clipped ? `${out}\n… [diff truncated]` : out)
  }

  /** Shared grep/glob traversal: skip .git/node_modules/dist… (same list as chat tools). */
  async function* walk(root: string): AsyncGenerator<string> {
    if (ended) return
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (ended) return
      const full = path.join(root, entry.name)
      if (entry.isDirectory()) {
        if (shouldSkipSearchDir(entry.name)) continue
        yield* walk(full)
      } else if (entry.isFile()) {
        yield full
      }
    }
  }

  async function toolGrep(args: Record<string, unknown>) {
    // Capture the owner BEFORE the first await: evidence belongs to the loop/iteration at admission.
    const evidenceOwner = captureReviewEvidenceOwner()
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    if (!pattern) return ERR('grep requires "pattern" (JavaScript regex).')
    if (pattern.length > MAX_GREP_PATTERN_CHARS) {
      return ERR(`Regex too large (limit ${MAX_GREP_PATTERN_CHARS} characters).`)
    }
    const sub = typeof args.path === 'string' && args.path ? args.path : '.'
    let roots: Array<{ root: string; repoRoot: string; prefix: string }>
    try {
      if (options.repositoryScope?.isMulti && sub === '.') {
        roots = await Promise.all(
          options.repositoryScope.repositories.map(async (repository) => {
            const resolved = await options.repositoryScope!.resolvePath(repository.linkName, '')
            return { root: resolved.absolutePath, repoRoot: repository.realWorktreePath, prefix: repository.linkName }
          })
        )
      } else {
        const resolved = await canonicalPathInside(sub)
        roots = [{ root: resolved.target, repoRoot: resolved.root, prefix: resolved.repo ?? '' }]
      }
    } catch (error) {
      return ERR(error instanceof Error ? error.message : String(error))
    }
    const includePattern = typeof args.include === 'string' && args.include ? args.include : ''
    if (includePattern.length > MAX_GREP_INCLUDE_CHARS) {
      return ERR(`Include filter too large (limit ${MAX_GREP_INCLUDE_CHARS} characters).`)
    }
    const include = includePattern ? globToRegExp(includePattern) : null
    const limit = Math.min(MAX_GREP_MATCHES, Math.max(1, Number(args.limit) || MAX_GREP_MATCHES))

    const hits: string[] = []
    const matcher = createRegexWorkerMatcher(pattern, lifecycleController.signal)
    try {
      await matcher.ready
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await matcher.close()
      return ERR(message.startsWith('Regex excedeu') ? message : `Invalid regex: ${message}`)
    }
    try {
      for (const rootContext of roots) {
        for await (const file of walk(rootContext.root)) {
          if (ended || hits.length >= limit) break
          if (include && !include.test(path.basename(file))) continue
          if (isBinaryExt(file)) continue
          let content: string
          try {
            // The entry may have changed since `readdir`: repeat realpath before reading and apply the read_file
            // size cap so a huge artifact cannot exhaust main-process memory.
            const rel = path.relative(rootContext.repoRoot, file).split(path.sep).join('/')
            const bridgePath = rootContext.prefix ? `${rootContext.prefix}/${rel}` : rel
            const safeFile = (await canonicalPathInside(bridgePath)).target
            const stat = await fs.stat(safeFile)
            if (!stat.isFile() || stat.size > MAX_READ_BYTES) continue
            const buf = await fs.readFile(safeFile)
            if (isProbablyBinary(buf)) continue
            content = buf.toString('utf8')
          } catch {
            continue
          }
          if (ended) break
          const rel = path.relative(rootContext.repoRoot, file).split(path.sep).join('/')
          const displayRel = rootContext.prefix ? `${rootContext.prefix}/${rel}` : rel
          const lines = content.split('\n')
          let matches: number[]
          try {
            matches = await matcher.test(lines, limit - hits.length)
          } catch (error) {
            if (ended) return ERR(SESSION_ENDED_MESSAGE)
            const message = error instanceof Error ? error.message : String(error)
            return ERR(message.startsWith('Regex excedeu') ? message : `Could not evaluate the regex: ${message}`)
          }
          for (const index of matches) {
            if (hits.length >= limit) break
            const text = lines[index].length > 240 ? `${lines[index].slice(0, 240)}…` : lines[index]
            hits.push(`${displayRel}:${index + 1}: ${text.trim()}`)
          }
        }
        if (hits.length >= limit) break
      }
    } finally {
      await matcher.close()
    }
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    remember(searches, `grep /${pattern}/ in ${sub}${includePattern ? ` (include ${includePattern})` : ''}`)
    checkpointFor(evidenceOwner, 'search')
    if (hits.length === 0) return TEXT('(no matches)')
    const more = hits.length >= limit ? `\n… (limit of ${limit} matches reached)` : ''
    return TEXT(`${hits.length} match(es):\n${hits.join('\n')}${more}`)
  }

  async function toolGlob(args: Record<string, unknown>) {
    // Capture the owner BEFORE the first await: evidence belongs to the loop/iteration at admission.
    const evidenceOwner = captureReviewEvidenceOwner()
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    if (!pattern) return ERR('glob requires "pattern" (e.g. "src/**/*.ts").')
    const limit = Math.min(MAX_GLOB_RESULTS, Math.max(1, Number(args.limit) || MAX_GLOB_RESULTS))
    const regex = globPathToRegExp(pattern)
    const found: string[] = []
    let roots: Array<{ root: string; prefix: string }>
    try {
      if (options.repositoryScope?.isMulti) {
        roots = options.repositoryScope.repositories.map((repository) => ({
          root: repository.realWorktreePath,
          prefix: repository.linkName,
        }))
      } else {
        roots = [{ root: (await canonicalPathInside('.')).root, prefix: '' }]
      }
    } catch (error) {
      return ERR(error instanceof Error ? error.message : String(error))
    }
    for (const rootContext of roots) {
      for await (const file of walk(rootContext.root)) {
        if (ended) return ERR(SESSION_ENDED_MESSAGE)
        if (found.length >= limit) break
        const rel = path.relative(rootContext.root, file).split(path.sep).join('/')
        const displayRel = rootContext.prefix ? `${rootContext.prefix}/${rel}` : rel
        if (regex.test(displayRel) || (!!rootContext.prefix && regex.test(rel))) found.push(displayRel)
      }
      if (found.length >= limit) break
    }
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    remember(searches, `glob ${pattern}`)
    checkpointFor(evidenceOwner, 'search')
    if (found.length === 0) return TEXT('(no files)')
    const more = found.length >= limit ? `\n… (limit of ${limit} files reached)` : ''
    return TEXT(`${found.length} file(s):\n${found.join('\n')}${more}`)
  }

  const externalUnavailable = () => ERR('external-capabilities-unavailable')
  const sanitizeExternalCapabilities = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const capabilities = value as Record<string, unknown>
    if (!Array.isArray(capabilities.mcpServers)) return value
    return {
      ...capabilities,
      mcpServers: capabilities.mcpServers.flatMap((server) => {
        if (!server || typeof server !== 'object' || Array.isArray(server)) return []
        const item = server as Record<string, unknown>
        if (item.scope !== 'read' && item.scope !== 'write') return []
        return [{ serverId: item.serverId, name: item.name, scope: item.scope }]
      }),
    }
  }
  const externalResult = (value: unknown): BridgeToolResult => {
    if (value && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content)) {
      return value as BridgeToolResult
    }
    if (typeof value === 'string') return TEXT(value)
    return TEXT(JSON.stringify(value ?? null, null, 2))
  }
  const runExternal = async (invoke: ((signal: AbortSignal) => Promise<unknown> | unknown) | undefined) => {
    if (!invoke) return externalUnavailable()
    return externalResult(await invoke(lifecycleController.signal))
  }

  const toolListExternalCapabilities = () =>
    runExternal(
      options.external &&
        (async (signal) => sanitizeExternalCapabilities(await options.external!.listCapabilities(signal)))
    )
  const toolSearchMcpTools = (args: Record<string, unknown>) =>
    runExternal(options.external && ((signal) => options.external!.searchMcpTools(args, signal)))
  const toolCallMcpRead = (args: Record<string, unknown>) =>
    runExternal(options.external && ((signal) => options.external!.callMcpRead(args, signal)))
  const toolCallMcpWrite = (args: Record<string, unknown>) =>
    runExternal(options.external && ((signal) => options.external!.callMcpWrite(args, signal)))
  const toolGitRead = (args: Record<string, unknown>) =>
    runExternal(options.external && ((signal) => options.external!.gitRead(args, signal)))
  const toolGhRead = (args: Record<string, unknown>) =>
    runExternal(options.external && ((signal) => options.external!.ghRead(args, signal)))
  const toolSearchProjectMemory = (args: Record<string, unknown>) => {
    if (!options.memory) return ERR('memory-disabled')
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query || query.length > 4_000) return ERR('query must contain 1 to 4000 characters after trimming.')
    const limit = args.limit === undefined ? undefined : Number(args.limit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 10)) {
      return ERR('limit must be an integer between 1 and 10.')
    }
    return runExternal((signal) =>
      options.memory!.search(
        {
          query,
          ...(limit ? { limit } : {}),
          ...(typeof args.repo === 'string' && args.repo ? { repo: args.repo } : {}),
        },
        signal
      )
    )
  }
  const toolReadProjectMemorySource = (args: Record<string, unknown>) => {
    if (!options.memory) return ERR('memory-disabled')
    if ((args.kind !== 'local' && args.kind !== 'shared') || typeof args.id !== 'string' || !args.id.trim()) {
      return ERR('Valid kind and id are required.')
    }
    return runExternal((signal) =>
      options.memory!.read(
        {
          kind: args.kind as 'local' | 'shared',
          id: args.id as string,
          ...(typeof args.repo === 'string' && args.repo ? { repo: args.repo } : {}),
          ...(typeof args.path === 'string' && args.path ? { path: args.path } : {}),
        },
        signal
      )
    )
  }
  const CONVERSATION_OFF_MESSAGE =
    'Conversation access is Off. Enable Read in Maestrly › ChatGPT › Access and restart the companion session.'
  const validConversationLimit = (value: unknown): value is number | undefined =>
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= CONVERSATION_RESULT_MAX_LIMIT)
  const toolGetConversationContext = async () => {
    if (!options.conversation) return ERR(CONVERSATION_OFF_MESSAGE)
    const value = await options.conversation.getContext(lifecycleController.signal)
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    const revision = conversationRevisionFromBrief(value)
    if (revision === undefined) return ERR('get_conversation_context returned a brief without a valid revision.')
    conversationContextRevision = revision
    conversationContextLoaded = true
    return externalResult(value)
  }
  const toolSearchConversation = (args: Record<string, unknown>) => {
    if (!options.conversation) return ERR(CONVERSATION_OFF_MESSAGE)
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query || query.length > CONVERSATION_QUERY_MAX_CHARS) {
      return ERR(`query must contain 1 to ${CONVERSATION_QUERY_MAX_CHARS} characters after trimming.`)
    }
    if (!validConversationLimit(args.limit)) {
      return ERR(`limit must be an integer between 1 and ${CONVERSATION_RESULT_MAX_LIMIT}.`)
    }
    return runExternal((signal) =>
      options.conversation!.search({ query, ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) }, signal)
    )
  }
  const toolReadConversation = (args: Record<string, unknown>) => {
    if (!options.conversation) return ERR(CONVERSATION_OFF_MESSAGE)
    if (typeof args.around_seq !== 'number' || !Number.isInteger(args.around_seq) || args.around_seq < 0) {
      return ERR('around_seq must be an integer greater than or equal to 0.')
    }
    if (!validConversationLimit(args.limit)) {
      return ERR(`limit must be an integer between 1 and ${CONVERSATION_RESULT_MAX_LIMIT}.`)
    }
    return runExternal((signal) =>
      options.conversation!.read(
        {
          around_seq: args.around_seq as number,
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        },
        signal
      )
    )
  }

  /** ChatGPT caches `tools/list`; the wizard prompts an app refresh after this experimental pivot. */
  const TOOLS = [
    {
      name: 'discover_frontend_previews',
      description: 'Discover allowlisted frontend previews in the workspace. Returns opaque IDs, never commands.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolDiscoverFrontendPreviews,
    },
    {
      name: 'browser_list_tabs',
      description: 'List only loopback tabs in the built-in browser for this conversation, with opaque IDs.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolBrowserListTabs,
    },
    {
      name: 'browser_attach',
      description: 'Attach browser tools to a local tab returned by browser_list_tabs without taking ownership.',
      inputSchema: {
        type: 'object',
        properties: { browser_id: { type: 'string', minLength: 1, description: 'Opaque ID from browser_list_tabs' } },
        required: ['browser_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolBrowserAttach,
    },
    {
      name: 'browser_detach',
      description: 'Release control of the attached tab without closing it, deleting cookies or stopping services.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolBrowserDetach,
    },
    {
      name: 'browser_snapshot',
      description: 'Semantic snapshot of the active Visual Review page, including interaction refs.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolBrowserSnapshot,
    },
    {
      name: 'browser_screenshot',
      description: 'Bounded real PNG screenshot of the active Visual Review page, with sanitized metadata.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolBrowserScreenshot,
    },
    {
      name: 'browser_read_text',
      description: 'Read visible text from the active Visual Review page.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolBrowserReadText,
    },
    {
      name: 'browser_wait_for',
      description: 'Wait for a selector, text or network idle on the visual page.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          network_idle: { type: 'boolean' },
          timeout_ms: { type: 'integer', minimum: 1, maximum: 60000 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolBrowserWait,
    },
    {
      name: 'browser_console_logs',
      description: 'Read bounded console logs from the visual page.',
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['log', 'info', 'warning', 'error', 'debug', 'exception'] },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolBrowserConsoleLogs,
    },
    {
      name: 'browser_network_logs',
      description: 'Read bounded network logs from the visual page.',
      inputSchema: {
        type: 'object',
        properties: { only_errors: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 500 } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolBrowserNetworkLogs,
    },
    {
      name: 'browser_navigate',
      description: 'Navigate only within the frozen Visual Review loopback origin.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', minLength: 1 } },
        required: ['url'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: toolBrowserNavigate,
    },
    {
      name: 'browser_reload',
      description: 'Reload the current Visual Review page.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: toolBrowserReload,
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the Visual Review page or a container.',
      inputSchema: {
        type: 'object',
        properties: {
          dx: { type: 'number' },
          dy: { type: 'number' },
          x: { type: 'number' },
          y: { type: 'number' },
          to: { type: 'string', enum: ['top', 'bottom'] },
          selector: { type: 'string' },
          container: { type: 'string' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: toolBrowserScroll,
    },
    ...(['browser_click', 'browser_double_click'] as const).map((name) => ({
      name,
      description: `${name === 'browser_click' ? 'Click' : 'Double-click'} a visual snapshot ref. Requires Interact.`,
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'integer', minimum: 0 } },
        required: ['ref'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: (args: Record<string, unknown>) => toolBrowserInteraction(name, args),
    })),
    {
      name: 'browser_type',
      description: 'Type into a visual snapshot ref. Requires Interact.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'integer', minimum: 0 }, text: { type: 'string' }, clear: { type: 'boolean' } },
        required: ['ref', 'text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: (args: Record<string, unknown>) => toolBrowserInteraction('browser_type', args),
    },
    {
      name: 'browser_press_key',
      description: 'Press a key on the visual page. Requires Interact.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['Control', 'Meta', 'Alt', 'Shift'] } },
        },
        required: ['key'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: (args: Record<string, unknown>) => toolBrowserInteraction('browser_press_key', args),
    },
    {
      name: 'browser_drag',
      description: 'Drag between two visual snapshot refs. Requires Interact.',
      inputSchema: {
        type: 'object',
        properties: { from_ref: { type: 'integer', minimum: 0 }, to_ref: { type: 'integer', minimum: 0 } },
        required: ['from_ref', 'to_ref'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: (args: Record<string, unknown>) => toolBrowserInteraction('browser_drag', args),
    },
    {
      name: 'list_external_capabilities',
      description:
        'List a brief summary of the repositories, Git/GitHub CLI, and MCP servers authorized in this session. Use repositories[].id as repo in git_read/gh_read, never owner/repo. gh=read also allows global search-* and API GET within the local login access. Does not expose schemas, configuration, or credentials.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      run: toolListExternalCapabilities,
    },
    {
      name: 'search_mcp_tools',
      description:
        'Search downstream tools by name/title/description before calling an unfamiliar MCP tool. Returns classification and input schema without changing the static app catalog.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            maxLength: CHATGPT_WEB_MCP_QUERY_MAX_CHARS,
            pattern: NON_WHITESPACE_PATTERN,
            description: 'Search terms for tool name, title or description',
          },
          server_id: {
            type: 'string',
            minLength: 1,
            description:
              'Exact serverId returned by list_external_capabilities.mcpServers[]; not the display name. Optional.',
          },
          limit: { type: 'integer', minimum: 1, maximum: CHATGPT_WEB_MCP_SEARCH_MAX_RESULTS },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      run: toolSearchMcpTools,
    },
    {
      name: 'call_mcp_read_tool',
      description:
        'Call an MCP tool confirmed read-only by the server annotations. Rejects missing, invalid or contradictory annotations. Use the exact IDs returned by search_mcp_tools.',
      inputSchema: {
        type: 'object',
        properties: {
          server_id: {
            type: 'string',
            minLength: 1,
            description: 'Exact serverId returned by search_mcp_tools',
          },
          tool_name: {
            type: 'string',
            minLength: 1,
            description: 'Exact toolName returned by search_mcp_tools',
          },
          arguments: { type: 'object', additionalProperties: true },
        },
        required: ['server_id', 'tool_name', 'arguments'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      run: toolCallMcpRead,
    },
    {
      name: 'call_mcp_write_tool',
      description:
        'Call a mutating MCP tool only on a server explicitly authorized for Read & write. May create, update or delete resources; use only for user-requested mutations with exact IDs returned by search_mcp_tools.',
      inputSchema: {
        type: 'object',
        properties: {
          server_id: {
            type: 'string',
            minLength: 1,
            description: 'Exact serverId returned by search_mcp_tools',
          },
          tool_name: {
            type: 'string',
            minLength: 1,
            description: 'Exact toolName returned by search_mcp_tools',
          },
          arguments: { type: 'object', additionalProperties: true },
        },
        required: ['server_id', 'tool_name', 'arguments'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      run: toolCallMcpWrite,
    },
    {
      name: 'git_read',
      description:
        'Run a structured, strictly read-only Git operation in the authorized repository. No arbitrary subcommands or shell. repo is the internal ID from list_external_capabilities, never owner/repo. For a single repository, use repository or omit; for multiple repositories, supply the ID. operation=diff is a generic Git read and does not replace git_diff as required review-loop evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['status', 'log', 'show', 'blame', 'branches', 'remotes', 'diff', 'ls-files'],
            description:
              'blame requires path; log uses limit/ref/path; show uses ref/path; diff uses ref/path; status and ls-files ' +
              'accept path. branches/remotes ignore other fields.',
          },
          repo: {
            type: 'string',
            description:
              'Internal ID from list_external_capabilities.repositories[].id; not owner/repo. ' +
              'For one repository, use "repository" or omit; required for multiple repositories.',
          },
          ref: {
            type: 'string',
            minLength: 1,
            description: 'ref/revision for log, show or blame; for diff, optional base compared with HEAD',
          },
          path: {
            type: 'string',
            minLength: 1,
            description: 'Path relative to the selected repository; required for blame',
          },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum commits in log' },
          line_start: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'Blame start line' },
          line_end: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'Blame end line' },
        },
        required: ['operation'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolGitRead,
    },
    {
      name: 'gh_read',
      description:
        'Run a structured read-only GitHub CLI operation using the local user login. No gh writes or shell; API calls always use GET. Repository/PR/issue/run/workflow/release operations use the authorized local repository internal ID, never owner/repo. search-* and api-get are GLOBAL and can read any resource visible to the local gh login; query/endpoint selects the target and repo is optional.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: [
              'repo-view',
              'pr-list',
              'pr-view',
              'pr-diff',
              'pr-checks',
              'pr-status',
              'issue-list',
              'issue-view',
              'run-list',
              'run-view',
              'workflow-list',
              'workflow-view',
              'release-list',
              'release-view',
              'search-issues',
              'search-prs',
              'search-code',
              'search-commits',
              'search-repos',
              'api-get',
            ],
            description:
              'Local operations use repo; pr-view/pr-diff/pr-checks/issue-view require number; ' +
              'run-view/workflow-view/release-view require id; search-* requires query; api-get requires endpoint.',
          },
          repo: {
            type: 'string',
            description:
              'Internal ID from list_external_capabilities.repositories[].id; not owner/repo. ' +
              'For one repository, use "repository" or omit. For multiple repositories, required only for local ' +
              'operations; optional for global operations and never restricts search/API scope.',
          },
          number: {
            type: 'integer',
            minimum: 1,
            description: 'PR or issue number for *-view/diff/checks operations',
          },
          id: {
            type: ['string', 'integer'],
            description: 'Run, workflow or release ID for corresponding operations; must not start with "-"',
          },
          query: {
            type: 'string',
            minLength: 1,
            pattern: NON_WHITESPACE_PATTERN,
            description:
              'GLOBAL GitHub query for search-*; include qualifiers such as repo:owner/name to narrow the scope',
          },
          endpoint: {
            type: 'string',
            minLength: 1,
            description:
              'Relative GLOBAL GitHub API endpoint, without URL/scheme (e.g. repos/owner/name); always called with GET',
          },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Limit for list/search operations' },
        },
        required: ['operation'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      run: toolGhRead,
    },
    {
      name: 'get_context',
      description:
        'Repository briefing and automatic structural map: languages, directories, manifests, likely entrypoints, branch, changes, commits, rules and memory. Use before discussing code. The map does not count as reading content; investigate relevant files afterward.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      run: toolGetContext,
    },
    {
      name: 'search_project_memory',
      description:
        'Search authorized local durable memory and shared .agents/knowledge narrowly when previous decisions, constraints, preferences, procedures or lessons could affect substantive work. Skip trivial or self-contained requests. Does not replace grep/read_file for implementation investigation.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 4_000, pattern: NON_WHITESPACE_PATTERN },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
          repo: {
            type: 'string',
            description: 'Repository ID for multiple repositories; omit for a single repository.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolSearchProjectMemory,
    },
    {
      name: 'read_project_memory_source',
      description:
        'Read a source returned by search_project_memory, respecting capabilities and repository boundaries.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['local', 'shared'] },
          id: { type: 'string', minLength: 1, maxLength: 500 },
          repo: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['kind', 'id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolReadProjectMemorySource,
    },
    {
      name: 'get_conversation_context',
      description:
        'Load a bounded brief of the main Maestrly conversation bound to this session_key once. Excludes reasoning, tool I/O, binary content, internal messages and other conversations.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolGetConversationContext,
    },
    {
      name: 'search_conversation',
      description:
        'Search sanitized text in the main conversation context to find earlier decisions on demand. Results are bounded and ordered newest first.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            maxLength: CONVERSATION_QUERY_MAX_CHARS,
            pattern: NON_WHITESPACE_PATTERN,
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: CONVERSATION_RESULT_MAX_LIMIT,
            default: CONVERSATION_RESULT_DEFAULT_LIMIT,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolSearchConversation,
    },
    {
      name: 'read_conversation',
      description:
        'Read a bounded window before/after a seq returned by search_conversation, in this conversation only.',
      inputSchema: {
        type: 'object',
        properties: {
          around_seq: { type: 'integer', minimum: 0 },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: CONVERSATION_RESULT_MAX_LIMIT,
            default: CONVERSATION_RESULT_DEFAULT_LIMIT,
          },
        },
        required: ['around_seq'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolReadConversation,
    },
    {
      name: 'read_file',
      description:
        'Read a repository file relative to its root with line numbers. Use offset/limit for large files. For multiple repositories, prefix path with <repo-id>/ using the ID from list_external_capabilities.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            description: 'Relative path; for multiple repositories use "<repo-id>/path/to/file"',
          },
          offset: { type: 'integer', minimum: 1, description: 'Starting line (1-based, default 1)' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_READ_LINES,
            description: `Maximum lines (default/limit ${MAX_READ_LINES})`,
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: toolReadFile,
    },
    {
      name: 'grep',
      description:
        'Search repository file content with a JavaScript regex. Accepts a subdirectory and simple filename glob, such as *.ts. For multiple repositories, omit path to search all or prefix it with <repo-id>/.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_GREP_PATTERN_CHARS,
            description: `JavaScript regex (limit ${MAX_GREP_PATTERN_CHARS} characters)`,
          },
          path: {
            type: 'string',
            minLength: 1,
            description: 'Relative subdirectory; for multiple repositories use "<repo-id>/subdirectory" (default: all)',
          },
          include: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_GREP_INCLUDE_CHARS,
            description: 'Filename glob, e.g. "*.{ts,tsx}"',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_GREP_MATCHES,
            description: `Maximum matches (limit ${MAX_GREP_MATCHES})`,
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: toolGrep,
    },
    {
      name: 'glob',
      description: 'List repository files matching a path pattern, such as src/**/*.ts.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', minLength: 1, description: 'Path pattern relative to the root' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_GLOB_RESULTS,
            description: `Maximum files (limit ${MAX_GLOB_RESULTS})`,
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: toolGlob,
    },
    {
      name: 'git_diff',
      description:
        'Unified diff of the current branch against the repository base. Without arguments, returns the full diff; path restricts it to one file. Records the diff checkpoint required by the review loop.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            minLength: 1,
            description:
              'Exact ID from list_external_capabilities.repositories[].id; not owner/repo. For multiple repositories, ' +
              'omit to aggregate all.',
          },
          path: {
            type: 'string',
            minLength: 1,
            description: 'Path relative to the selected repository; without repo, use "<repo-id>/path" to select one',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: toolGitDiff,
    },
    {
      name: 'run_check',
      description:
        'Run a project check (tests, lint, typecheck) and return output. Only user-authorized names listed in get_context are available. The bridge accepts no arbitrary commands and opens no shell, but an authorized command may create files, caches or other local effects. Cancelled when the companion session ends.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            description: 'Exact name listed by get_context (e.g. "test", "lint")',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      run: toolRunCheck,
    },
    {
      name: 'read_skill',
      description:
        'Read a project skill (team-maintained procedure/checklist). Available skills are listed in get_context.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, description: 'Exact name listed by get_context' } },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: toolReadSkill,
    },
    {
      name: 'start_project_environment',
      description:
        'Only after an explicit user request, start a local executor following an ENABLED bootstrap skill. Does not accept arbitrary commands or prompts.',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', minLength: 1, description: 'Exact name of an enabled skill from get_context' },
          idempotency_key: {
            ...IDEMPOTENCY_KEY_CONSTRAINTS,
            description: 'Unique key for this bootstrap; reuse on retry',
          },
        },
        required: ['skill', 'idempotency_key'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: toolStartProjectEnvironment,
    },
    {
      name: 'wait_project_environment',
      description: 'Wait for a bounded interval for the local executor preparing the project environment.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', minLength: 1 },
          wait_seconds: { type: 'integer', minimum: 1, maximum: 60 },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolWaitProjectEnvironment,
    },
    {
      name: 'cancel_project_environment',
      description: 'Cancel the specified bootstrap job; services already detached by the skill may remain active.',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string', minLength: 1 } },
        required: ['job_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: toolCancelProjectEnvironment,
    },
    {
      name: 'notify_turn_complete',
      description:
        'Signal completion of a normal interaction. Call once, as the last tool before the final response. Publishes no content and writes nothing to the repository. Reuse the same idempotency_key only for retries.',
      inputSchema: {
        type: 'object',
        properties: {
          idempotency_key: {
            ...IDEMPOTENCY_KEY_CONSTRAINTS,
            description: 'New identifier for this interaction; reuse only on retry',
          },
        },
        required: ['idempotency_key'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: toolNotifyTurnComplete,
    },
    {
      name: 'send_to_maestrly',
      description:
        'Publish the final artifact in the originating Maestrly conversation ONLY when explicitly requested by the user. destination=chat inserts a history message; destination=plan sends a plan for review in the Plan tab. Requires prior get_context, search and file reads; the bridge attaches actual coverage. Declare gaps, assumptions and confidence. Reuse the same idempotency_key on retries.',
      inputSchema: {
        type: 'object',
        properties: {
          destination: { type: 'string', enum: ['chat', 'plan'], description: 'Delivery destination' },
          markdown: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_DELIVERY_CHARS,
            pattern: NON_WHITESPACE_PATTERN,
            description: 'Full Markdown content',
          },
          title: {
            type: 'string',
            maxLength: MAX_DELIVERY_TITLE_CHARS,
            description: 'Short title, recommended for plans',
          },
          idempotency_key: {
            ...IDEMPOTENCY_KEY_CONSTRAINTS,
            description: 'Unique delivery identifier; reuse on every retry',
          },
          confidence: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Confidence in the conclusion based only on evidence actually inspected',
          },
          uninspected_areas: {
            type: 'array',
            maxItems: MAX_DISCLOSURE_ITEMS,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_DISCLOSURE_ITEM_CHARS,
              pattern: NON_WHITESPACE_PATTERN,
            },
            description: 'Potentially relevant areas not inspected; use [] if none',
          },
          assumptions: {
            type: 'array',
            maxItems: MAX_DISCLOSURE_ITEMS,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_DISCLOSURE_ITEM_CHARS,
              pattern: NON_WHITESPACE_PATTERN,
            },
            description: 'Unconfirmed assumptions used in the analysis; use [] if none',
          },
        },
        required: ['destination', 'markdown', 'idempotency_key', 'confidence', 'uninspected_areas', 'assumptions'],
        additionalProperties: false,
      },
      run: toolSendToMaestrly,
    },
    {
      name: 'wait_plan_review',
      description:
        'Wait for a bounded interval for a human decision on a plan sent to the Plan tab. Call again on waiting; revise includes feedbackText and requires a new plan version. The outcome remains readable on retry.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_review_id: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description: 'Opaque ID returned by send_to_maestrly(destination="plan")',
          },
          wait_seconds: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_PLAN_REVIEW_WAIT_SECONDS,
            description: 'Maximum duration of this call; waiting allows continuation with another call',
          },
        },
        required: ['plan_review_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: toolWaitPlanReview,
    },
    {
      name: 'start_review_loop',
      description:
        'Start an automatic review loop: the Maestrly agent executes fixes locally, one round at a time. review_scope=frontend accepts a managed preview or attached local tab. The executor provider/model is frozen.',
      inputSchema: {
        type: 'object',
        properties: {
          max_iterations: {
            type: 'integer',
            minimum: 1,
            maximum: HARD_MAX_ITERATIONS,
            description: `Maximum cycles (default ${DEFAULT_MAX_ITERATIONS}, limit ${HARD_MAX_ITERATIONS})`,
          },
          severity_threshold: {
            type: 'string',
            enum: ['blocking', 'important'],
            description: 'Minimum severity that keeps the loop active (default "important")',
          },
          review_scope: {
            type: 'string',
            enum: ['code', 'frontend'],
            description: 'Defaults to code; frontend requires exactly one opaque preview_id or browser_id',
          },
          preview_id: { type: 'string', minLength: 1, description: 'Opaque ID from discover_frontend_previews' },
          browser_id: { type: 'string', minLength: 1, description: 'Opaque ID from browser_list_tabs' },
          idempotency_key: {
            ...IDEMPOTENCY_KEY_CONSTRAINTS,
            description: 'Unique start key; reuse the SAME key on every retry',
          },
        },
        required: ['idempotency_key'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: toolStartReviewLoop,
    },
    {
      name: 'submit_review_fix',
      description:
        'Submit structured findings and start ONE local Maestrly agent execution. Requires FRESH investigation in this iteration (git_diff + grep/glob + read_file of the changed implementation) after the latest execution. Findings below the threshold do not keep the loop active.',
      inputSchema: {
        type: 'object',
        properties: {
          loop_id: { type: 'string', minLength: 1, description: 'Loop ID returned by start_review_loop' },
          iteration: { type: 'integer', minimum: 1, description: 'Current loop round' },
          findings: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_FINDINGS,
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  minLength: 1,
                  maxLength: MAX_FINDING_ID_CHARS,
                  pattern: NON_WHITESPACE_PATTERN,
                  description: 'Stable finding identifier',
                },
                severity: { type: 'string', enum: ['blocking', 'important', 'optional'] },
                title: {
                  type: 'string',
                  minLength: 1,
                  maxLength: MAX_FINDING_TITLE_CHARS,
                  pattern: NON_WHITESPACE_PATTERN,
                  description: `Short title (up to ${MAX_FINDING_TITLE_CHARS} characters)`,
                },
                details: {
                  type: 'string',
                  minLength: 1,
                  maxLength: MAX_FINDING_DETAILS_CHARS,
                  pattern: NON_WHITESPACE_PATTERN,
                  description: `Details and evidence (up to ${MAX_FINDING_DETAILS_CHARS} characters)`,
                },
                paths: {
                  type: 'array',
                  maxItems: MAX_FINDING_PATHS,
                  items: { type: 'string', minLength: 1, maxLength: MAX_FINDING_PATH_CHARS },
                  description: 'RELATIVE paths, for information only (optional)',
                },
              },
              required: ['id', 'severity', 'title', 'details'],
              additionalProperties: false,
            },
          },
          reviewer_notes: {
            type: 'string',
            maxLength: MAX_REVIEWER_NOTES_CHARS,
            description: `Reviewer notes for the agent (optional, up to ${MAX_REVIEWER_NOTES_CHARS} characters)`,
          },
          idempotency_key: {
            ...IDEMPOTENCY_KEY_CONSTRAINTS,
            description: 'Unique submission key; reuse the SAME key on retries',
          },
        },
        required: ['loop_id', 'iteration', 'findings', 'idempotency_key'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      run: toolSubmitReviewFix,
    },
    {
      name: 'wait_review_fix',
      description:
        `Wait for the executor job to finish (long poll up to ${MAX_WAIT_SECONDS}s). If still running, returns ` +
        'status "running" — call again with the SAME job_id. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          loop_id: { type: 'string', minLength: 1, description: 'Loop ID' },
          job_id: { type: 'string', minLength: 1, description: 'Job ID returned by submit_review_fix' },
          wait_seconds: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_WAIT_SECONDS,
            description: `Maximum wait time (default 45, limit ${MAX_WAIT_SECONDS})`,
          },
        },
        required: ['loop_id', 'job_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: toolWaitReviewFix,
    },
    {
      name: 'finish_review_loop',
      description:
        'Formally finish a review loop with result (clean | max_iterations | no_progress | failed | cancelled), summary and remaining_findings. Maestrly persists an audit summary in the conversation. Call only when the loop is terminal or clean after fresh investigation. cancelled requires bridge-confirmed cancellation; never use it merely because the current response is ending.',
      inputSchema: {
        type: 'object',
        properties: {
          loop_id: { type: 'string', minLength: 1, description: 'Loop ID' },
          result: {
            type: 'string',
            enum: ['clean', 'max_iterations', 'no_progress', 'failed', 'cancelled'],
            description:
              'clean after investigation with no relevant findings; other values only after the bridge ' +
              'places the loop in that terminal state. cancelled requires actual user/session cancellation.',
          },
          summary: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_FINISH_SUMMARY_CHARS,
            pattern: NON_WHITESPACE_PATTERN,
            description: `Completion summary (up to ${MAX_FINISH_SUMMARY_CHARS} characters)`,
          },
          remaining_findings: {
            type: 'array',
            maxItems: MAX_REMAINING_FINDINGS,
            items: {
              type: 'object',
              properties: {
                severity: { type: 'string', enum: ['blocking', 'important', 'optional'] },
                title: {
                  type: 'string',
                  minLength: 1,
                  maxLength: MAX_FINDING_TITLE_CHARS,
                  pattern: NON_WHITESPACE_PATTERN,
                },
                details: {
                  type: 'string',
                  minLength: 1,
                  maxLength: MAX_FINDING_DETAILS_CHARS,
                  pattern: NON_WHITESPACE_PATTERN,
                },
              },
              required: ['severity', 'title', 'details'],
              additionalProperties: false,
            },
            description: 'Findings that could not be fixed (optional)',
          },
          idempotency_key: {
            ...IDEMPOTENCY_KEY_CONSTRAINTS,
            description: 'Unique completion key; reuse the SAME key on retries',
          },
        },
        required: ['loop_id', 'result', 'summary', 'idempotency_key'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: toolFinishReviewLoop,
    },
  ] as const

  const REVIEW_LOOP_TOOL_NAMES = new Set([
    'start_review_loop',
    'submit_review_fix',
    'wait_review_fix',
    'finish_review_loop',
  ])
  const REVIEW_LOOP_TOOL_ARG_KEYS = [
    'loop_id',
    'job_id',
    'iteration',
    'max_iterations',
    'severity_threshold',
    'wait_seconds',
    'result',
    'review_scope',
  ]
  const BROWSER_TOOL_NAMES = new Set([
    'browser_snapshot',
    'browser_screenshot',
    'browser_read_text',
    'browser_wait_for',
    'browser_console_logs',
    'browser_network_logs',
    'browser_navigate',
    'browser_reload',
    'browser_scroll',
    'browser_click',
    'browser_double_click',
    'browser_type',
    'browser_press_key',
    'browser_drag',
  ])

  /** Sanitized events: review tools NEVER expose findings/notes/prompts in tool-call events. */
  function sanitizedArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (BROWSER_TOOL_NAMES.has(name)) {
      return {
        ...(typeof args.ref === 'number' ? { ref: args.ref } : {}),
        ...(typeof args.from_ref === 'number' ? { from_ref: args.from_ref } : {}),
        ...(typeof args.to_ref === 'number' ? { to_ref: args.to_ref } : {}),
        ...(typeof args.key === 'string' ? { key: args.key.slice(0, 64) } : {}),
        ...(Array.isArray(args.modifiers) ? { modifiers: args.modifiers.slice(0, 4) } : {}),
        ...(name === 'browser_navigate' && typeof args.url === 'string'
          ? {
              origin: (() => {
                try {
                  return new URL(args.url).origin
                } catch {
                  return 'invalid'
                }
              })(),
            }
          : {}),
        argument_keys: Object.keys(args).filter((key) => key !== 'session_key' && key !== 'text').length,
      }
    }
    if (name === 'call_mcp_read_tool' || name === 'call_mcp_write_tool') {
      return {
        server_id: typeof args.server_id === 'string' ? args.server_id.slice(0, 128) : '',
        tool_name: typeof args.tool_name === 'string' ? args.tool_name.slice(0, 160) : '',
        access: name === 'call_mcp_write_tool' ? 'write' : 'read',
        argument_keys:
          args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
            ? Object.keys(args.arguments as Record<string, unknown>).length
            : 0,
      }
    }
    if (name === 'search_mcp_tools') {
      return {
        ...(typeof args.server_id === 'string' ? { server_id: args.server_id.slice(0, 128) } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      }
    }
    if (name === 'search_conversation') {
      return { ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) }
    }
    if (name === 'search_project_memory') {
      return {
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(typeof args.repo === 'string' ? { repo: args.repo.slice(0, 128) } : {}),
      }
    }
    if (name === 'read_project_memory_source') {
      return {
        ...(args.kind === 'local' || args.kind === 'shared' ? { kind: args.kind } : {}),
        ...(typeof args.id === 'string' ? { id: args.id.slice(0, 500) } : {}),
        ...(typeof args.repo === 'string' ? { repo: args.repo.slice(0, 128) } : {}),
        ...(typeof args.path === 'string' ? { path: args.path.slice(0, 2_000) } : {}),
      }
    }
    if (name === 'read_conversation') {
      return {
        ...(typeof args.around_seq === 'number' ? { around_seq: args.around_seq } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      }
    }
    if (name === 'git_read' || name === 'gh_read') {
      return {
        operation: typeof args.operation === 'string' ? args.operation.slice(0, 64) : '',
        ...(typeof args.repo === 'string' ? { repo: args.repo.slice(0, 128) } : {}),
      }
    }
    if (!REVIEW_LOOP_TOOL_NAMES.has(name)) return args
    const out: Record<string, unknown> = {}
    for (const key of REVIEW_LOOP_TOOL_ARG_KEYS) {
      if (args[key] !== undefined) out[key] = args[key]
    }
    return out
  }

  /**
   * STABLE, complete catalog: ChatGPT caches `tools/list` when creating/updating the app, so schemas
   * must never vary by session or controller presence. Validate availability/ownership in `tools/call`
   * (each review tool requires `options.reviewLoop` in the session), NEVER by hiding schemas here.
   */
  function listTools() {
    return TOOLS.map(({ run: _run, ...tool }) => withSessionKey(tool))
  }

  /** Execute a tool by name (entry point for the multi-session router). */
  async function callTool(name: string, args: Record<string, unknown>): Promise<BridgeToolResult> {
    if (ended) return ERR(SESSION_ENDED_MESSAGE)
    const tool = TOOLS.find((candidate) => candidate.name === name)
    if (!tool) throw Object.assign(new Error(`tool desconhecida: ${name}`), { code: -32602 })
    const startedAt = now()
    toolCalls++
    lastToolCallAt = startedAt
    let onLifecycleAbort: (() => void) | undefined
    try {
      const lifecycleAbort = new Promise<never>((_, reject) => {
        onLifecycleAbort = () => reject(new Error(SESSION_ENDED_MESSAGE))
        lifecycleController.signal.addEventListener('abort', onLifecycleAbort, { once: true })
      })
      const result = await Promise.race([tool.run(args), lifecycleAbort])
      // A tool may have crossed the lifecycle boundary while awaiting git, I/O, a worker or delivery. Its
      // completed value is no longer valid for the revoked session, even if the operation itself succeeded.
      if (ended) return ERR(SESSION_ENDED_MESSAGE)
      const ok = !(result as { isError?: boolean }).isError
      emit({ kind: 'tool-call', name, args: sanitizedArgs(name, args), ok, durationMs: now() - startedAt })
      return result
    } catch (error) {
      if (ended) return ERR(SESSION_ENDED_MESSAGE)
      emit({ kind: 'tool-call', name, args: sanitizedArgs(name, args), ok: false, durationMs: now() - startedAt })
      return ERR(`Error in tool ${name}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (onLifecycleAbort) lifecycleController.signal.removeEventListener('abort', onLifecycleAbort)
    }
  }

  // ---------------------------------------------------------------- JSON-RPC (MCP)

  async function handleRequest(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const { id, method, params } = message
    const stateless = isStatelessMcpRequest(params)
    const respond = (result: unknown, cacheable = false): JsonRpcResponse | undefined =>
      id === undefined ? undefined : { jsonrpc: '2.0', id, result: completeMcpResult(result, { stateless, cacheable }) }

    switch (method) {
      case 'server/discover':
        return id === undefined
          ? undefined
          : { jsonrpc: '2.0', id, result: createMcpDiscoverResult(CHATGPT_WEB_SERVER_INSTRUCTIONS) }
      case 'initialize': {
        const clientInfo = params?.clientInfo as { name?: string } | undefined
        const result = createLegacyInitializeResult(params?.protocolVersion, CHATGPT_WEB_SERVER_INSTRUCTIONS)
        emit({ kind: 'client-initialized', clientName: clientInfo?.name, protocolVersion: result.protocolVersion })
        return respond(result)
      }
      case 'tools/list':
        return respond(
          {
            tools: await listTools(),
            _meta: { [CHATGPT_WEB_TOOL_CATALOG_META_KEY]: CHATGPT_WEB_TOOL_CATALOG_VERSION },
          },
          true
        )
      case 'tools/call': {
        const name = typeof params?.name === 'string' ? params.name : ''
        const args = (params?.arguments as Record<string, unknown>) ?? {}
        try {
          return respond(await callTool(name, args))
        } catch (error) {
          const code = (error as { code?: number }).code ?? -32000
          return id === undefined
            ? undefined
            : { jsonrpc: '2.0', id, error: { code, message: error instanceof Error ? error.message : String(error) } }
        }
      }
      case 'ping':
        return respond({})
      case 'prompts/list':
        return respond({ prompts: [] }, true)
      case 'resources/list':
        return respond({ resources: [] }, true)
      case 'resources/templates/list':
        return respond({ resourceTemplates: [] }, true)
      default:
        // Absorb notifications (no id); unknown requests become standard JSON-RPC errors.
        if (id === undefined) return undefined
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } }
    }
  }

  /** Transport entry point: accept a JSON-RPC object or batch. */
  async function handleMessage(raw: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (Array.isArray(raw)) {
      const out: JsonRpcResponse[] = []
      for (const item of raw) {
        const response = await handleRequest((item ?? {}) as JsonRpcRequest)
        if (response) out.push(response)
      }
      return out.length ? out : undefined
    }
    if (!raw || typeof raw !== 'object') return undefined
    return handleRequest(raw as JsonRpcRequest)
  }

  return {
    handleMessage,
    listTools,
    callTool,
    endSession,
    stats,
    setReviewIteration,
    clearReviewIteration,
    forgetReviewLoop,
    getReviewEvidence,
  }
}

export type ChatGptWebBridge = ReturnType<typeof createChatGptWebBridge>
