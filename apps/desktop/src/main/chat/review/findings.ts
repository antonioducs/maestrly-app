import path from 'node:path'
import { tool, type Tool } from 'ai'
import { z } from 'zod'
import type { ReviewSeverity } from '../../../shared/review'

export const MAX_FINDINGS_PER_SUBMISSION = 25

const findingSchema = z.object({
  severity: z.enum(['blocking', 'important', 'minor']),
  title: z.string().trim().min(1).max(200),
  details: z.string().trim().min(1).max(4_000),
  evidence: z.string().trim().min(1).max(3_000),
  suggestion: z.string().trim().max(1_500).optional(),
  path: z.string().trim().max(400).optional(),
  line: z.number().int().positive().optional(),
  plan_line: z.number().int().positive().optional(),
  candidate_id: z.string().trim().max(32).optional(),
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
  /** Verifier submissions: the candidate this finding confirms. */
  candidateId?: string
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

export function parseSubmission(
  raw: unknown,
  cwd: string
): { ok: true; value: FindingsSubmission } | { ok: false; error: string } {
  const parsed = submitFindingsSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('; ')
    return { ok: false, error: issues || 'Invalid findings.' }
  }
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
          ...(finding.candidate_id ? { candidateId: finding.candidate_id } : {}),
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

/** One reviewer's `submit_findings` tool; the last valid call wins so the model can correct itself. */
export function createFindingsCollector(cwd: string): { tool: Tool; submission: () => FindingsSubmission | null } {
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
        return parsed.value.findings.length
          ? `Recorded ${parsed.value.findings.length} finding(s). Your review is complete; stop now.`
          : 'Recorded: no findings. Your review is complete; stop now.'
      },
    }),
    submission: () => submission,
  }
}
