/**
 * Independent, read-only review of a conversation's code changes or of its pending plan. Several reviewers look at
 * the work in parallel through different lenses, a verifier keeps only the findings it can confirm, and the result is
 * handed back to the person, who decides with the conversation's model what to do. Nothing here changes code.
 */

export type ReviewTarget = 'code' | 'plan'

/** blocking: must be fixed before merging or implementing; important: a real defect worth fixing; minor: low impact. */
export type ReviewSeverity = 'blocking' | 'important' | 'minor'

export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ['blocking', 'important', 'minor']

export type ReviewLensId = 'correctness' | 'integration' | 'security' | 'feasibility' | 'completeness'

export const CODE_REVIEW_LENSES: readonly ReviewLensId[] = ['correctness', 'integration', 'security']
export const PLAN_REVIEW_LENSES: readonly ReviewLensId[] = ['feasibility', 'completeness']

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
}

export type ReviewStageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface ReviewLensState {
  id: ReviewLensId
  status: ReviewStageStatus
  /** Findings this lens raised before verification. */
  candidates?: number
}

export type ReviewJobStatus = 'running' | 'verifying' | 'completed' | 'failed' | 'cancelled'

export interface ReviewModelInfo {
  providerId: string
  modelId: string
  reasoning?: string
  fastMode?: boolean
}

/** Live and last-terminal state of a conversation's review. */
export interface ReviewJobInfo {
  reviewId: string
  conversationId: string
  target: ReviewTarget
  status: ReviewJobStatus
  startedAt: number
  finishedAt?: number
  model?: ReviewModelInfo
  lenses: ReviewLensState[]
  verification: ReviewStageStatus
  /** Plan reviews: the version of the plan that was reviewed. */
  planVersion?: number
  /** Findings raised by all lenses before verification. */
  candidates?: number
  /** Terminal plan reviews carry their findings; a code review stores them in a conversation message instead. */
  findings?: ReviewFinding[]
  /** Code reviews: the conversation message holding the report. */
  messageId?: string
  /** The verifier did not finish, so the findings were not confirmed. */
  unverified?: boolean
  error?: string
}

/** The code review report stored on its conversation message. */
export interface ChatReviewReport {
  reviewId: string
  target: 'code'
  findings: ReviewFinding[]
  candidates: number
  unverified?: boolean
  failedLenses?: ReviewLensId[]
  model?: ReviewModelInfo
  startedAt: number
  finishedAt: number
  /** The checkout that was reviewed. */
  scope?: { branch?: string; head?: string }
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

/** What the review dialog offers: the model the conversation would use, and the reviewer used last time. */
export interface ReviewReviewerOptions {
  conversation: (ReviewModelChoice & { providerName?: string }) | null
  last: ReviewerPreference | null
}

/** Without `reviewer`, the review runs on the conversation's model, effort and Fast setting. */
export type ReviewStartInput = { target: ReviewTarget; reviewer?: ReviewModelChoice }

export type ReviewStartResult = { ok: true; review: ReviewJobInfo } | { ok: false; error: string }

const LENS_IDS = new Set<string>([...CODE_REVIEW_LENSES, ...PLAN_REVIEW_LENSES])
const SEVERITY_RANK: Record<ReviewSeverity, number> = { blocking: 0, important: 1, minor: 2 }

export function compareReviewSeverity(a: ReviewSeverity, b: ReviewSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b]
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function positiveLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** A reviewer model from the renderer or from storage; null when anything is missing or malformed. */
export function parseReviewModelChoice(raw: unknown): ReviewModelChoice | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : ''
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : ''
  const reasoning = typeof value.reasoning === 'string' ? value.reasoning.trim() : ''
  if (!providerId || providerId.length > 300 || !modelId || modelId.length > 300) return null
  if (!reasoning || reasoning.length > 40 || typeof value.fastMode !== 'boolean') return null
  return { providerId, modelId, reasoning, fastMode: value.fastMode }
}

export function parseReviewerPreference(raw: unknown): ReviewerPreference | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const kind = (raw as { kind?: unknown }).kind
  if (kind === 'conversation') return { kind: 'conversation' }
  const choice = kind === 'model' ? parseReviewModelChoice(raw) : null
  return choice ? { kind: 'model', ...choice } : null
}

/** Defensive parse of a stored finding; anything malformed is dropped rather than rendered. */
export function parseReviewFinding(raw: unknown): ReviewFinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const id = boundedString(value.id, 32)
  const title = boundedString(value.title, 300)
  const details = boundedString(value.details, 6_000)
  const severity = value.severity
  const lens = value.lens
  if (!id || !title || !details) return null
  if (severity !== 'blocking' && severity !== 'important' && severity !== 'minor') return null
  if (typeof lens !== 'string' || !LENS_IDS.has(lens)) return null
  const evidence = boundedString(value.evidence, 4_000)
  const suggestion = boundedString(value.suggestion, 2_000)
  const path = boundedString(value.path, 500)
  const line = positiveLine(value.line)
  const planLine = positiveLine(value.planLine)
  return {
    id,
    severity,
    title,
    details,
    ...(evidence ? { evidence } : {}),
    ...(suggestion ? { suggestion } : {}),
    ...(path ? { path } : {}),
    ...(line ? { line } : {}),
    ...(planLine ? { planLine } : {}),
    lens: lens as ReviewLensId,
  }
}

function parseModel(raw: unknown): ReviewModelInfo | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
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

/** Defensive parse of the report stored in a message's metadata. */
export function parseChatReviewReport(raw: unknown): ChatReviewReport | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const reviewId = boundedString(value.reviewId, 200)
  if (!reviewId || value.target !== 'code' || !Array.isArray(value.findings)) return undefined
  const findings = value.findings.flatMap((item) => {
    const finding = parseReviewFinding(item)
    return finding ? [finding] : []
  })
  const failedLenses = Array.isArray(value.failedLenses)
    ? value.failedLenses.filter((lens): lens is ReviewLensId => typeof lens === 'string' && LENS_IDS.has(lens))
    : []
  const model = parseModel(value.model)
  const scopeRaw = value.scope && typeof value.scope === 'object' ? (value.scope as Record<string, unknown>) : null
  const branch = boundedString(scopeRaw?.branch, 300)
  const head = boundedString(scopeRaw?.head, 80)
  const number = (key: string) =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) ? (value[key] as number) : 0
  return {
    reviewId,
    target: 'code',
    findings,
    candidates: Math.max(findings.length, Math.floor(number('candidates'))),
    ...(value.unverified === true ? { unverified: true } : {}),
    ...(failedLenses.length ? { failedLenses } : {}),
    ...(model ? { model } : {}),
    startedAt: number('startedAt'),
    finishedAt: number('finishedAt'),
    ...(branch || head ? { scope: { ...(branch ? { branch } : {}), ...(head ? { head } : {}) } } : {}),
  }
}
