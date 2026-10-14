import path from 'node:path'
import { tool, type Tool } from 'ai'
import { z } from 'zod'
import type { ReviewCheckResult, ReviewSeverity, ReviewVerdictKind } from '../../../shared/review'

export const MAX_FINDINGS_PER_SUBMISSION = 25

const severity = z.enum(['blocking', 'important', 'minor'])

const findingSchema = z.object({
  severity,
  title: z.string().trim().min(1).max(200),
  details: z.string().trim().min(1).max(4_000),
  evidence: z.string().trim().min(1).max(3_000),
  suggestion: z.string().trim().max(1_500).optional(),
  path: z.string().trim().max(400).optional(),
  line: z.number().int().positive().optional(),
  plan_line: z.number().int().positive().optional(),
})

export const submitFindingsSchema = z.object({
  summary: z.string().trim().max(2_000).optional(),
  findings: z.array(findingSchema).max(MAX_FINDINGS_PER_SUBMISSION),
})

/** A finding as one reviewer submitted it, before verification and numbering. */
export interface SubmittedFinding {
  severity: ReviewSeverity
  title: string
  details: string
  evidence: string
  suggestion?: string
  path?: string
  line?: number
  planLine?: number
}

export interface FindingsSubmission {
  summary?: string
  findings: SubmittedFinding[]
}

/** Repository-relative path without traversal; absolute paths inside the checkout are made relative. */
export function normalizeFindingPath(raw: string | undefined, cwd: string): string | undefined {
  const value = raw?.trim().replaceAll('\\', '/')
  if (!value) return undefined
  const relative = path.isAbsolute(value) ? path.relative(cwd, value).replaceAll('\\', '/') : value
  const normalized = path.posix.normalize(relative).replace(/^\.\//, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined
  if (path.posix.isAbsolute(normalized)) return undefined
  return normalized
}

function issuesText(error: z.ZodError): string {
  return (
    error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('; ') || 'Invalid input.'
  )
}

export function parseSubmission(
  raw: unknown,
  cwd: string
): { ok: true; value: FindingsSubmission } | { ok: false; error: string } {
  const parsed = submitFindingsSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: issuesText(parsed.error) }
  return {
    ok: true,
    value: {
      ...(parsed.data.summary ? { summary: parsed.data.summary } : {}),
      findings: parsed.data.findings.map((finding) => {
        const findingPath = normalizeFindingPath(finding.path, cwd)
        return {
          severity: finding.severity,
          title: finding.title,
          details: finding.details,
          evidence: finding.evidence,
          ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
          ...(findingPath ? { path: findingPath } : {}),
          ...(findingPath && finding.line ? { line: finding.line } : {}),
          ...(finding.plan_line ? { planLine: finding.plan_line } : {}),
        }
      }),
    },
  }
}

/**
 * Last JSON object in a reviewer's final text that looks like a submission. Used only when the model answered in
 * prose instead of calling the tool.
 */
export function parseSubmissionFromText(text: string, cwd: string): FindingsSubmission | null {
  const candidates: string[] = []
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(match[1])
  const lastBrace = text.lastIndexOf('{"findings"')
  if (lastBrace >= 0) candidates.push(text.slice(lastBrace))
  for (const candidate of candidates.reverse()) {
    let value: unknown
    try {
      value = JSON.parse(candidate.trim())
    } catch {
      continue
    }
    const parsed = parseSubmission(value, cwd)
    if (parsed.ok) return parsed.value
  }
  return null
}

/**
 * One reviewer's `submit_findings` tool; the last valid call wins so the model can correct itself. `onSubmit` sees each
 * accepted submission as it happens, so the person can watch candidates appear.
 */
export function createFindingsCollector(
  cwd: string,
  onSubmit?: (submission: FindingsSubmission) => void
): { tool: Tool; submission: () => FindingsSubmission | null } {
  let submission: FindingsSubmission | null = null
  return {
    tool: tool({
      description:
        'Submits your final review findings. Call it exactly once when you are done; pass an empty findings array ' +
        'when you found nothing worth reporting. Every finding needs concrete evidence.',
      metadata: { readOnly: true, parallelSafe: false },
      inputSchema: submitFindingsSchema,
      execute: async (input: unknown) => {
        const parsed = parseSubmission(input, cwd)
        if (!parsed.ok) return `Findings rejected: ${parsed.error}. Fix them and call submit_findings again.`
        submission = parsed.value
        onSubmit?.(parsed.value)
        return parsed.value.findings.length
          ? `Recorded ${parsed.value.findings.length} finding(s). Your review is complete; stop now.`
          : 'Recorded: no findings. Your review is complete; stop now.'
      },
    }),
    submission: () => submission,
  }
}

const verdictSchema = z.object({
  candidate_id: z.string().trim().min(1).max(32),
  verdict: z.enum(['confirmed', 'discarded', 'merged']),
  reason: z.string().trim().max(1_000).optional(),
  merged_into: z.string().trim().max(32).optional(),
  severity: severity.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  details: z.string().trim().min(1).max(4_000).optional(),
  evidence: z.string().trim().min(1).max(3_000).optional(),
  suggestion: z.string().trim().max(1_500).optional(),
  path: z.string().trim().max(400).optional(),
  line: z.number().int().positive().optional(),
  plan_line: z.number().int().positive().optional(),
})

export const recordVerdictsSchema = z.object({ verdicts: z.array(verdictSchema).min(1).max(40) })

/** The verifier's ruling on one candidate; a confirmed one may correct the candidate's fields. */
export interface RecordedVerdict {
  candidateId: string
  verdict: ReviewVerdictKind
  reason?: string
  into?: string
  severity?: ReviewSeverity
  title?: string
  details?: string
  evidence?: string
  suggestion?: string
  path?: string
  line?: number
  planLine?: number
}

/**
 * The verifier's `record_verdicts` tool. Verdicts accumulate across calls (a later verdict for the same candidate
 * replaces the earlier one), so the person sees each ruling as soon as it is made. Unknown candidates, merges without
 * a valid target and rejections without a reason are refused with an explanation the model can act on.
 */
export function createVerdictCollector(
  cwd: string,
  candidateIds: readonly string[],
  onVerdicts?: (verdicts: RecordedVerdict[]) => void
): { tool: Tool; verdicts: () => RecordedVerdict[] } {
  const known = new Set(candidateIds)
  const verdicts = new Map<string, RecordedVerdict>()
  return {
    tool: tool({
      description:
        'Records your verdict on one or more candidate findings. Call it as you rule on candidates, a few at a time, ' +
        'until every candidate has a verdict: confirmed (optionally correcting severity and wording), discarded ' +
        '(with the reason) or merged (a duplicate, with merged_into set to the candidate it duplicates).',
      metadata: { readOnly: true, parallelSafe: false },
      inputSchema: recordVerdictsSchema,
      execute: async (input: unknown) => {
        const parsed = recordVerdictsSchema.safeParse(input)
        if (!parsed.success)
          return `Verdicts rejected: ${issuesText(parsed.error)}. Fix them and call record_verdicts again.`
        const accepted: RecordedVerdict[] = []
        const problems: string[] = []
        for (const item of parsed.data.verdicts) {
          const id = item.candidate_id
          if (!known.has(id)) {
            problems.push(`${id} is not a candidate`)
            continue
          }
          if (
            item.verdict === 'merged' &&
            (!item.merged_into || item.merged_into === id || !known.has(item.merged_into))
          ) {
            problems.push(`${id}: merged_into must name another candidate`)
            continue
          }
          if (item.verdict !== 'confirmed' && !item.reason) {
            problems.push(`${id}: give the reason it is ${item.verdict}`)
            continue
          }
          const findingPath = normalizeFindingPath(item.path, cwd)
          const verdict: RecordedVerdict = {
            candidateId: id,
            verdict: item.verdict,
            ...(item.reason ? { reason: item.reason } : {}),
            ...(item.verdict === 'merged' ? { into: item.merged_into } : {}),
            ...(item.verdict === 'confirmed' && item.severity ? { severity: item.severity } : {}),
            ...(item.verdict === 'confirmed' && item.title ? { title: item.title } : {}),
            ...(item.verdict === 'confirmed' && item.details ? { details: item.details } : {}),
            ...(item.verdict === 'confirmed' && item.evidence ? { evidence: item.evidence } : {}),
            ...(item.verdict === 'confirmed' && item.suggestion ? { suggestion: item.suggestion } : {}),
            ...(item.verdict === 'confirmed' && findingPath ? { path: findingPath } : {}),
            ...(item.verdict === 'confirmed' && findingPath && item.line ? { line: item.line } : {}),
            ...(item.verdict === 'confirmed' && item.plan_line ? { planLine: item.plan_line } : {}),
          }
          verdicts.set(id, verdict)
          accepted.push(verdict)
        }
        if (accepted.length) onVerdicts?.(accepted)
        const remaining = candidateIds.filter((id) => !verdicts.has(id))
        return [
          accepted.length
            ? `Recorded ${accepted.map((verdict) => verdict.candidateId).join(', ')}.`
            : 'Nothing recorded.',
          problems.length ? `Not recorded: ${problems.join('; ')}.` : '',
          remaining.length
            ? `Still without a verdict: ${remaining.join(', ')}.`
            : 'Every candidate has a verdict. You are done; stop now.',
        ]
          .filter(Boolean)
          .join(' ')
      },
    }),
    verdicts: () => [...verdicts.values()],
  }
}

export const recordChecksSchema = z.object({
  results: z
    .array(
      z.object({
        finding_id: z.string().trim().min(1).max(32),
        state: z.enum(['resolved', 'open']),
        note: z.string().trim().min(1).max(1_500),
      })
    )
    .min(1)
    .max(40),
})

/** The checker's `record_checks` tool: one result per finding, accumulated across calls like verdicts. */
export function createCheckCollector(
  findingIds: readonly string[],
  onResults?: (results: ReviewCheckResult[]) => void
): { tool: Tool; results: () => ReviewCheckResult[] } {
  const known = new Set(findingIds)
  const results = new Map<string, ReviewCheckResult>()
  return {
    tool: tool({
      description:
        'Records whether the fix (or the plan revision) for one or more findings holds up: resolved or open, with a ' +
        'short note saying what you saw. Call it as you go until every finding has a result.',
      metadata: { readOnly: true, parallelSafe: false },
      inputSchema: recordChecksSchema,
      execute: async (input: unknown) => {
        const parsed = recordChecksSchema.safeParse(input)
        if (!parsed.success)
          return `Results rejected: ${issuesText(parsed.error)}. Fix them and call record_checks again.`
        const accepted: ReviewCheckResult[] = []
        const unknown: string[] = []
        for (const item of parsed.data.results) {
          if (!known.has(item.finding_id)) {
            unknown.push(item.finding_id)
            continue
          }
          const result: ReviewCheckResult = { findingId: item.finding_id, state: item.state, note: item.note }
          results.set(item.finding_id, result)
          accepted.push(result)
        }
        if (accepted.length) onResults?.(accepted)
        const remaining = findingIds.filter((id) => !results.has(id))
        return [
          accepted.length ? `Recorded ${accepted.map((result) => result.findingId).join(', ')}.` : 'Nothing recorded.',
          unknown.length ? `Not findings of this review: ${unknown.join(', ')}.` : '',
          remaining.length ? `Still to check: ${remaining.join(', ')}.` : 'Every finding is checked. Stop now.',
        ]
          .filter(Boolean)
          .join(' ')
      },
    }),
    results: () => findingIds.flatMap((id) => (results.has(id) ? [results.get(id)!] : [])),
  }
}
