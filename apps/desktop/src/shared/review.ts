/**
 * Independent, read-only review of a conversation's code changes or of its pending plan. Several reviewers look at
 * the work in parallel through different lenses and a verifier rules on every candidate they raise. While a review
 * runs and until the person hands its result off (or discards it), the conversation is paused; the person decides
 * each finding, and the review then continues in the conversation as a receipt that can check the fixes.
 */

export type ReviewTarget = 'code' | 'plan'

/** blocking: must be fixed before merging or implementing; important: a real defect worth fixing; minor: low impact. */
export type ReviewSeverity = 'blocking' | 'important' | 'minor'

export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ['blocking', 'important', 'minor']

export type ReviewLensId = 'correctness' | 'integration' | 'security' | 'feasibility' | 'completeness'

export const CODE_REVIEW_LENSES: readonly ReviewLensId[] = ['correctness', 'integration', 'security']
export const PLAN_REVIEW_LENSES: readonly ReviewLensId[] = ['feasibility', 'completeness']

/** Who did something in a review: one of the lenses, or the verifier (which also checks fixes). */
export type ReviewLane = ReviewLensId | 'verifier'

/** One thing a reviewer did, as the person follows it: reading, searching, or a note between tool calls. */
export interface ReviewActivity {
  id: string
  kind: 'diff' | 'read' | 'grep' | 'glob' | 'note' | 'submit' | 'tool'
  /** The file read, the pattern searched, the tool used or the note itself. */
  text: string
  /** Repository-relative file a read touched. */
  path?: string
  /** Lines read, such as "18–26". */
  range?: string
  /** Matches a search found, files a listing returned, or findings, verdicts or results submitted. */
  count?: number
  /** Files a search matched. */
  files?: string[]
  status: 'running' | 'done' | 'failed'
}

/** A finding one lens raised, before the verifier rules on it. */
export interface ReviewCandidate {
  /** C1, C2… in the order they were raised. */
  id: string
  lens: ReviewLensId
  severity: ReviewSeverity
  title: string
  path?: string
  line?: number
  planLine?: number
}

/** confirmed: real (possibly with a corrected severity); discarded: not reproducible or out of scope; merged: a duplicate. */
export type ReviewVerdictKind = 'confirmed' | 'discarded' | 'merged'

export interface ReviewVerdict {
  candidateId: string
  verdict: ReviewVerdictKind
  /** Why it was discarded, merged or re-rated. */
  reason?: string
  /** merged: the candidate it duplicates. */
  into?: string
  /** confirmed: the severity after verification. */
  severity?: ReviewSeverity
}

/** Lines around a finding, so the person can judge it without opening the file. */
export interface ReviewSnippet {
  source: 'file' | 'plan'
  path?: string
  /** 1-based number of the first line. */
  start: number
  lines: string[]
  /** 1-based number of the line the finding is about. */
  highlight: number
}

export interface ReviewFinding {
  /** Display id within one report: F1, F2… */
  id: string
  severity: ReviewSeverity
  title: string
  /** What is wrong, why it matters and the concrete scenario where it breaks. */
  details: string
  /** Concrete evidence: the code path, lines or input that shows the problem. */
  evidence?: string
  suggestion?: string
  /** Repository-relative file the finding is about. */
  path?: string
  /** 1-based line in `path`. */
  line?: number
  /** Plan reviews: 1-based line of the plan the finding is anchored to. */
  planLine?: number
  lens: ReviewLensId
  /** The candidate this finding confirms. */
  candidateId?: string
  /** The severity the reviewer gave before the verifier corrected it. */
  fromSeverity?: ReviewSeverity
  /** Candidates the verifier merged into this one. */
  merged?: string[]
  /** The verifier did not rule on it, so it is not confirmed. */
  unverified?: boolean
  snippet?: ReviewSnippet
}

export type ReviewStageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface ReviewLensState {
  id: ReviewLensId
  status: ReviewStageStatus
  /** Findings this lens raised before verification. */
  candidates?: number
}

/** A file in the change under review. Binary files have no line counts. */
export interface ReviewScopeFile {
  path: string
  added?: number
  deleted?: number
  /** Not in the base: a new or untracked file. */
  isNew?: boolean
}

export interface ReviewCodeScope {
  kind: 'code'
  branch: string
  head: string
  /** Files listed, largest changes first; `filesTotal` counts all of them. */
  files: ReviewScopeFile[]
  filesTotal: number
  added: number
  deleted: number
}

export interface ReviewPlanScope {
  kind: 'plan'
  version: number
  title?: string
  /** Top-level steps of the plan, for the overview. */
  steps: string[]
}

export type ReviewScope = ReviewCodeScope | ReviewPlanScope

/** What happens with a finding: fix or discuss it (code), comment on the plan, or dismiss it. */
export type ReviewDecision = 'fix' | 'discuss' | 'comment' | 'dismiss'

export const CODE_REVIEW_DECISIONS: readonly ReviewDecision[] = ['fix', 'discuss', 'dismiss']
export const PLAN_REVIEW_DECISIONS: readonly ReviewDecision[] = ['comment', 'dismiss']

/** The person's decisions while a review is open; main keeps them so leaving and coming back loses nothing. */
export interface ReviewDraft {
  decisions: Record<string, ReviewDecision>
  /** Why a finding was dismissed, sent along so the agent does not raise it again. */
  notes: Record<string, string>
  /** Plan reviews: the comment each commented finding becomes. */
  comments: Record<string, string>
}

/** resolved: the fix or revision holds up; open: it does not yet; unknown: the check could not tell. */
export type ReviewCheckState = 'resolved' | 'open' | 'unknown'

export interface ReviewCheckResult {
  findingId: string
  state: ReviewCheckState
  note?: string
}

/** A review open in a conversation (kind `review`) or a check of the fixes it asked for (kind `check`). */
export type ReviewJobKind = 'review' | 'check'

/**
 * running → verifying → ready (findings waiting for the person's decisions) → completed (handed off). A check goes
 * running → completed. discarded, failed and cancelled end either one without handing anything off.
 */
export type ReviewJobStatus = 'running' | 'verifying' | 'ready' | 'completed' | 'discarded' | 'failed' | 'cancelled'

export interface ReviewModelInfo {
  providerId: string
  modelId: string
  reasoning?: string
  fastMode?: boolean
}

/** Live and last state of a conversation's review or check. */
export interface ReviewJobInfo {
  reviewId: string
  conversationId: string
  kind: ReviewJobKind
  target: ReviewTarget
  status: ReviewJobStatus
  startedAt: number
  finishedAt?: number
  model?: ReviewModelInfo
  lenses: ReviewLensState[]
  verification: ReviewStageStatus
  /** Recent activity per lane, oldest first. */
  activity: Partial<Record<ReviewLane, ReviewActivity[]>>
  /** Every candidate raised so far. */
  candidateList: ReviewCandidate[]
  /** The verifier's rulings so far. */
  verdicts: ReviewVerdict[]
  /** Number of candidates raised by all lenses. */
  candidates?: number
  scope?: ReviewScope
  /** Plan reviews: the version of the plan that was reviewed. */
  planVersion?: number
  /** Ready reviews: the findings waiting for decisions (confirmed first, then unconfirmed). */
  findings?: ReviewFinding[]
  draft?: ReviewDraft
  failedLenses?: ReviewLensId[]
  /** The verifier did not finish, so some or all findings are unconfirmed. */
  unverified?: boolean
  /** The receipt in the conversation: written at hand-off, and the one a check updates. */
  messageId?: string
  /** Checks: the results recorded so far. */
  checks?: ReviewCheckResult[]
  error?: string
}

/** Whether a review or check holds the conversation: nothing runs or is sent there until it ends. */
export function reviewLocksConversation(info: Pick<ReviewJobInfo, 'status'> | null | undefined): boolean {
  return info?.status === 'running' || info?.status === 'verifying' || info?.status === 'ready'
}

/** What the person did with a finished review: kept it, sent it to the agent, or decided the plan with it. */
export type ReviewHandoffState = 'saved' | 'sent' | 'revised' | 'approved'

export interface ReviewHandoff {
  state: ReviewHandoffState
  at: number
  /** Code reviews: the message to the agent the report goes with. */
  message?: string
  /** When the report reached the model, attached to the person's message. */
  deliveredAt?: number
  /** Plan reviews: the version the comments were sent on. */
  planVersion?: number
}

/** A candidate the verifier did not keep, still shown with its reason. */
export interface ReviewDroppedCandidate {
  id: string
  lens: ReviewLensId
  severity: ReviewSeverity
  title: string
  verdict: 'discarded' | 'merged'
  reason?: string
  into?: string
}

export interface ReviewCheck {
  status: 'completed' | 'failed'
  startedAt: number
  finishedAt: number
  results: ReviewCheckResult[]
  /** Plan reviews: the revision that was checked. */
  planVersion?: number
  error?: string
}

/** The review receipt stored on its conversation message, outside the model's context. */
export interface ChatReviewReport {
  reviewId: string
  target: ReviewTarget
  findings: ReviewFinding[]
  candidates: number
  unverified?: boolean
  failedLenses?: ReviewLensId[]
  model?: ReviewModelInfo
  startedAt: number
  finishedAt: number
  /** The checkout that was reviewed. */
  scope?: { branch?: string; head?: string }
  /** Plan reviews: the version that was reviewed. */
  planVersion?: number
  decisions?: Record<string, ReviewDecision>
  notes?: Record<string, string>
  comments?: Record<string, string>
  dropped?: ReviewDroppedCandidate[]
  handoff?: ReviewHandoff
  /** The last check of the fixes or of the revision. */
  check?: ReviewCheck
}

/** A model chosen to run a review instead of the conversation's own. */
export interface ReviewModelChoice {
  providerId: string
  modelId: string
  /** `off` uses the provider's default effort. */
  reasoning: string
  fastMode: boolean
}

/** The reviewer last used, offered first the next time: the conversation's model or a chosen one. */
export type ReviewerPreference = { kind: 'conversation' } | ({ kind: 'model' } & ReviewModelChoice)

/** The model the conversation would use, and the reviewer used last time. */
export interface ReviewReviewerOptions {
  conversation: (ReviewModelChoice & { providerName?: string }) | null
  last: ReviewerPreference | null
}

/** What the review's first stage shows before anything runs. */
export type ReviewPrepareResult =
  | { ok: true; scope: ReviewScope; reviewer: ReviewReviewerOptions; lenses: ReviewLensId[] }
  | { ok: false; error: string }

/** Without `reviewer`, the review runs on the conversation's model, effort and Fast setting. */
export type ReviewStartInput = { target: ReviewTarget; reviewer?: ReviewModelChoice }

export type ReviewStartResult = { ok: true; review: ReviewJobInfo } | { ok: false; error: string }

export interface ReviewDraftInput {
  reviewId: string
  decisions?: Record<string, ReviewDecision | null>
  notes?: Record<string, string>
  comments?: Record<string, string>
}

/** send/save: code reviews; revise/approve: plan reviews (the plan decision itself follows from the renderer). */
export type ReviewHandoffAction = 'send' | 'save' | 'revise' | 'approve'

export interface ReviewHandoffInput {
  reviewId: string
  action: ReviewHandoffAction
  /** send: the message to the agent, as the person edited it. */
  message?: string
}

export type ReviewHandoffResult = { ok: true; messageId: string } | { ok: false; error: string }

/** Sending a saved report: the message to send with it. */
export type ReviewSendReportResult = { ok: true; message: string } | { ok: false; error: string }

const LENS_IDS = new Set<string>([...CODE_REVIEW_LENSES, ...PLAN_REVIEW_LENSES])
const DECISIONS = new Set<string>(['fix', 'discuss', 'comment', 'dismiss'])
const CHECK_STATES = new Set<string>(['resolved', 'open', 'unknown'])
const HANDOFF_STATES = new Set<string>(['saved', 'sent', 'revised', 'approved'])
const SEVERITY_RANK: Record<ReviewSeverity, number> = { blocking: 0, important: 1, minor: 2 }

export function compareReviewSeverity(a: ReviewSeverity, b: ReviewSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b]
}

export function isReviewSeverity(value: unknown): value is ReviewSeverity {
  return value === 'blocking' || value === 'important' || value === 'minor'
}

export function isReviewDecision(value: unknown): value is ReviewDecision {
  return typeof value === 'string' && DECISIONS.has(value)
}

/** Decisions a target allows. */
export function reviewDecisionsFor(target: ReviewTarget): readonly ReviewDecision[] {
  return target === 'code' ? CODE_REVIEW_DECISIONS : PLAN_REVIEW_DECISIONS
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function positiveLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

/** A reviewer model from the renderer or from storage; null when anything is missing or malformed. */
export function parseReviewModelChoice(raw: unknown): ReviewModelChoice | null {
  const value = record(raw)
  if (!value) return null
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : ''
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : ''
  const reasoning = typeof value.reasoning === 'string' ? value.reasoning.trim() : ''
  if (!providerId || providerId.length > 300 || !modelId || modelId.length > 300) return null
  if (!reasoning || reasoning.length > 40 || typeof value.fastMode !== 'boolean') return null
  return { providerId, modelId, reasoning, fastMode: value.fastMode }
}

export function parseReviewerPreference(raw: unknown): ReviewerPreference | null {
  const value = record(raw)
  if (!value) return null
  if (value.kind === 'conversation') return { kind: 'conversation' }
  const choice = value.kind === 'model' ? parseReviewModelChoice(raw) : null
  return choice ? { kind: 'model', ...choice } : null
}

function parseSnippet(raw: unknown): ReviewSnippet | undefined {
  const value = record(raw)
  if (!value || (value.source !== 'file' && value.source !== 'plan') || !Array.isArray(value.lines)) return undefined
  const start = positiveLine(value.start)
  const highlight = positiveLine(value.highlight)
  if (!start || !highlight) return undefined
  const lines = value.lines.slice(0, 40).map((line) => (typeof line === 'string' ? line.slice(0, 500) : ''))
  const path = boundedString(value.path, 500)
  return { source: value.source, ...(path ? { path } : {}), start, lines, highlight }
}

/** Defensive parse of a stored finding; anything malformed is dropped rather than rendered. */
export function parseReviewFinding(raw: unknown): ReviewFinding | null {
  const value = record(raw)
  if (!value) return null
  const id = boundedString(value.id, 32)
  const title = boundedString(value.title, 300)
  const details = boundedString(value.details, 6_000)
  const lens = value.lens
  if (!id || !title || !details || !isReviewSeverity(value.severity)) return null
  if (typeof lens !== 'string' || !LENS_IDS.has(lens)) return null
  const evidence = boundedString(value.evidence, 4_000)
  const suggestion = boundedString(value.suggestion, 2_000)
  const path = boundedString(value.path, 500)
  const line = positiveLine(value.line)
  const planLine = positiveLine(value.planLine)
  const candidateId = boundedString(value.candidateId, 32)
  const merged = Array.isArray(value.merged)
    ? value.merged.flatMap((item) => {
        const merged = boundedString(item, 32)
        return merged ? [merged] : []
      })
    : []
  const snippet = parseSnippet(value.snippet)
  return {
    id,
    severity: value.severity,
    title,
    details,
    ...(evidence ? { evidence } : {}),
    ...(suggestion ? { suggestion } : {}),
    ...(path ? { path } : {}),
    ...(line ? { line } : {}),
    ...(planLine ? { planLine } : {}),
    lens: lens as ReviewLensId,
    ...(candidateId ? { candidateId } : {}),
    ...(isReviewSeverity(value.fromSeverity) ? { fromSeverity: value.fromSeverity } : {}),
    ...(merged.length ? { merged } : {}),
    ...(value.unverified === true ? { unverified: true } : {}),
    ...(snippet ? { snippet } : {}),
  }
}

function parseModel(raw: unknown): ReviewModelInfo | undefined {
  const value = record(raw)
  if (!value) return undefined
  const providerId = boundedString(value.providerId, 200)
  const modelId = boundedString(value.modelId, 200)
  if (!providerId || !modelId) return undefined
  const reasoning = boundedString(value.reasoning, 40)
  return {
    providerId,
    modelId,
    ...(reasoning ? { reasoning } : {}),
    ...(value.fastMode === true ? { fastMode: true } : {}),
  }
}

/** String values keyed by finding id, limited to the findings that exist. */
function parseTextMap(raw: unknown, ids: ReadonlySet<string>, max: number): Record<string, string> | undefined {
  const value = record(raw)
  if (!value) return undefined
  const out: Record<string, string> = {}
  for (const [id, text] of Object.entries(value)) {
    const bounded = ids.has(id) ? boundedString(text, max) : undefined
    if (bounded) out[id] = bounded
  }
  return Object.keys(out).length ? out : undefined
}

function parseDropped(raw: unknown): ReviewDroppedCandidate[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 60).flatMap((item) => {
    const value = record(item)
    const id = boundedString(value?.id, 32)
    const title = boundedString(value?.title, 300)
    const lens = value?.lens
    if (!value || !id || !title || typeof lens !== 'string' || !LENS_IDS.has(lens) || !isReviewSeverity(value.severity))
      return []
    if (value.verdict !== 'discarded' && value.verdict !== 'merged') return []
    const reason = boundedString(value.reason, 1_000)
    const into = boundedString(value.into, 32)
    return [
      {
        id,
        lens: lens as ReviewLensId,
        severity: value.severity,
        title,
        verdict: value.verdict,
        ...(reason ? { reason } : {}),
        ...(into ? { into } : {}),
      },
    ]
  })
}

function parseHandoff(raw: unknown): ReviewHandoff | undefined {
  const value = record(raw)
  const at = finiteNumber(value?.at)
  if (!value || typeof value.state !== 'string' || !HANDOFF_STATES.has(value.state) || at === undefined)
    return undefined
  const message = boundedString(value.message, 20_000)
  const deliveredAt = finiteNumber(value.deliveredAt)
  const planVersion = positiveLine(value.planVersion)
  return {
    state: value.state as ReviewHandoffState,
    at,
    ...(message ? { message } : {}),
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(planVersion ? { planVersion } : {}),
  }
}

export function parseReviewCheckResults(raw: unknown, ids: ReadonlySet<string>): ReviewCheckResult[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((item) => {
    const value = record(item)
    const findingId = boundedString(value?.findingId, 32)
    if (!value || !findingId || !ids.has(findingId) || seen.has(findingId)) return []
    if (typeof value.state !== 'string' || !CHECK_STATES.has(value.state)) return []
    seen.add(findingId)
    const note = boundedString(value.note, 2_000)
    return [{ findingId, state: value.state as ReviewCheckState, ...(note ? { note } : {}) }]
  })
}

function parseCheck(raw: unknown, ids: ReadonlySet<string>): ReviewCheck | undefined {
  const value = record(raw)
  const startedAt = finiteNumber(value?.startedAt)
  const finishedAt = finiteNumber(value?.finishedAt)
  if (!value || (value.status !== 'completed' && value.status !== 'failed')) return undefined
  if (startedAt === undefined || finishedAt === undefined) return undefined
  const error = boundedString(value.error, 2_000)
  const planVersion = positiveLine(value.planVersion)
  return {
    status: value.status,
    startedAt,
    finishedAt,
    results: parseReviewCheckResults(value.results, ids),
    ...(planVersion ? { planVersion } : {}),
    ...(error ? { error } : {}),
  }
}

/** Defensive parse of the receipt stored in a message's metadata. */
export function parseChatReviewReport(raw: unknown): ChatReviewReport | undefined {
  const value = record(raw)
  if (!value) return undefined
  const reviewId = boundedString(value.reviewId, 200)
  if (!reviewId || (value.target !== 'code' && value.target !== 'plan') || !Array.isArray(value.findings)) {
    return undefined
  }
  const findings = value.findings.flatMap((item) => {
    const finding = parseReviewFinding(item)
    return finding ? [finding] : []
  })
  const ids = new Set(findings.map((finding) => finding.id))
  const failedLenses = Array.isArray(value.failedLenses)
    ? value.failedLenses.filter((lens): lens is ReviewLensId => typeof lens === 'string' && LENS_IDS.has(lens))
    : []
  const model = parseModel(value.model)
  const scopeRaw = record(value.scope)
  const branch = boundedString(scopeRaw?.branch, 300)
  const head = boundedString(scopeRaw?.head, 80)
  const decisionsRaw = record(value.decisions)
  const decisions: Record<string, ReviewDecision> = {}
  for (const [id, decision] of Object.entries(decisionsRaw ?? {})) {
    if (ids.has(id) && isReviewDecision(decision)) decisions[id] = decision
  }
  const notes = parseTextMap(value.notes, ids, 1_000)
  const comments = parseTextMap(value.comments, ids, 4_000)
  const dropped = parseDropped(value.dropped)
  const handoff = parseHandoff(value.handoff)
  const check = parseCheck(value.check, ids)
  const planVersion = positiveLine(value.planVersion)
  return {
    reviewId,
    target: value.target,
    findings,
    candidates: Math.max(findings.length, Math.floor(finiteNumber(value.candidates) ?? 0)),
    ...(value.unverified === true ? { unverified: true } : {}),
    ...(failedLenses.length ? { failedLenses } : {}),
    ...(model ? { model } : {}),
    startedAt: finiteNumber(value.startedAt) ?? 0,
    finishedAt: finiteNumber(value.finishedAt) ?? 0,
    ...(branch || head ? { scope: { ...(branch ? { branch } : {}), ...(head ? { head } : {}) } } : {}),
    ...(planVersion ? { planVersion } : {}),
    ...(Object.keys(decisions).length ? { decisions } : {}),
    ...(notes ? { notes } : {}),
    ...(comments ? { comments } : {}),
    ...(dropped.length ? { dropped } : {}),
    ...(handoff ? { handoff } : {}),
    ...(check ? { check } : {}),
  }
}

/** Findings the hand-off asked the agent to act on: fixes for code, comments for a plan. */
export function reviewActedFindings(
  report: Pick<ChatReviewReport, 'target' | 'findings' | 'decisions'>
): ReviewFinding[] {
  const wanted: ReviewDecision = report.target === 'code' ? 'fix' : 'comment'
  return report.findings.filter((finding) => report.decisions?.[finding.id] === wanted)
}
