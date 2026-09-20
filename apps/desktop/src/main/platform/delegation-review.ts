/**
 * Reviewer contract for a delegation review stage.
 *
 * The reviewer reads a stable copy of one revision and must end its turn with a structured verdict that
 * echoes the digest it reviewed. A missing, malformed or unbound verdict fails the stage: an approval is
 * never inferred from prose, and it can never be attributed to code the reviewer did not read.
 */
import { reviewResultSchema, type CodeRevision, type ReviewResult } from '@maestrly/protocol'

export const REVIEW_RESULT_BLOCK = 'maestrly-review'

export function reviewContract(revision: CodeRevision, acceptanceCriteria: string[]): string {
  const criteria = acceptanceCriteria.length
    ? acceptanceCriteria.map((item) => `- ${item}`).join('\n')
    : '- (no explicit acceptance criteria were recorded)'
  return [
    '## Review contract',
    'You are reviewing a stable copy of one exact code revision. You have read-only access: report findings',
    'instead of editing. Inspect the change, run the read-only evidence you need, and judge it against the',
    'objective and the acceptance criteria below.',
    '',
    `Reviewed revision digest: ${revision.contentDigest}`,
    revision.headCommit ? `Reviewed head commit: ${revision.headCommit}` : '',
    '',
    '### Acceptance criteria',
    criteria,
    '',
    'End your reply with exactly one fenced block tagged `' + REVIEW_RESULT_BLOCK + '` containing JSON:',
    '```' + REVIEW_RESULT_BLOCK,
    '{',
    '  "verdict": "approved" | "changes_requested" | "blocked",',
    `  "codeRevisionDigest": "${revision.contentDigest}",`,
    '  "findings": [',
    '    {"id": "stable-id", "severity": "blocking" | "important" | "optional", "title": "…",',
    '     "details": "…", "paths": ["path/to/file.ts"], "recommendation": "…"}',
    '  ],',
    '  "criteriaCoverage": [{"criterion": "…", "satisfied": true, "evidence": "…"}],',
    '  "notes": "…"',
    '}',
    '```',
    'Reuse a finding id you were given so a fix can be tracked. Do not approve while a blocking or important',
    'finding is open, or while an acceptance criterion is unsatisfied.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export type ReviewParseFailure =
  | 'missing-block'
  | 'invalid-json'
  | 'invalid-shape'
  | 'revision-mismatch'
  | 'approved-with-findings'
  | 'approved-with-unsatisfied-criteria'

export type ReviewParseOutcome =
  | { ok: true; result: ReviewResult }
  | { ok: false; failure: ReviewParseFailure; detail: string }

const BLOCK_PATTERN = new RegExp('```' + REVIEW_RESULT_BLOCK + '\\s*\\n([\\s\\S]*?)```', 'g')

/** Parse and validate the reviewer's verdict against the revision it was given. */
export function parseReviewResult(text: string, revision: CodeRevision): ReviewParseOutcome {
  const blocks = [...text.matchAll(BLOCK_PATTERN)]
  if (!blocks.length)
    return { ok: false, failure: 'missing-block', detail: 'The review did not report a structured verdict.' }
  // The last block wins; an earlier draft never overrides the final decision.
  const raw = blocks[blocks.length - 1]![1]!.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, failure: 'invalid-json', detail: (error as Error).message.slice(0, 500) }
  }
  const validated = reviewResultSchema.safeParse(parsed)
  if (!validated.success)
    return {
      ok: false,
      failure: 'invalid-shape',
      detail: validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 900),
    }
  const result = validated.data
  if (result.codeRevisionDigest !== revision.contentDigest)
    return {
      ok: false,
      failure: 'revision-mismatch',
      detail: 'The verdict names a different revision than the one that was reviewed.',
    }
  if (result.verdict === 'approved' && result.findings.some((finding) => finding.severity !== 'optional'))
    return {
      ok: false,
      failure: 'approved-with-findings',
      detail: 'The verdict approves while a blocking or important finding is open.',
    }
  if (result.verdict === 'approved' && result.criteriaCoverage.some((item) => !item.satisfied))
    return {
      ok: false,
      failure: 'approved-with-unsatisfied-criteria',
      detail: 'The verdict approves while an acceptance criterion is unsatisfied.',
    }
  return { ok: true, result }
}
