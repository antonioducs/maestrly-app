import { z } from 'zod'
import { defineTool } from './util'

const finding = z.object({
  id: z.string().trim().min(1).max(128),
  severity: z.enum(['blocking', 'important', 'optional']),
  title: z.string().trim().min(1).max(200),
  details: z.string().trim().min(1).max(4_000),
  paths: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
})

export const submitReviewParameters = z
  .object({
    result: z.enum(['clean', 'findings']),
    summary: z.string().trim().min(1).max(8_000),
    findings: z.array(finding).max(50).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.result === 'findings' && (!value.findings || value.findings.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['findings'], message: 'findings requires a non-empty array' })
    }
    if (
      value.result === 'clean' &&
      value.findings?.some((item) => item.severity === 'blocking' || item.severity === 'important')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message: 'clean cannot include blocking or important findings',
      })
    }
  })

export const submitReviewTool = defineTool({
  name: 'submit_review',
  description:
    'Submits the single structured terminal decision for this internal review round. The host enforces fresh evidence and idempotency.',
  parameters: submitReviewParameters,
  execute: async (input, ctx) => {
    if (!ctx.reviewer) return { ok: false as const, error: 'submit_review is available only internally' }
    return ctx.reviewer.submitReview(input)
  },
  toModelText: (_input, result) =>
    result.ok
      ? result.idempotent
        ? 'Review decision already accepted (idempotent retry). The turn will now stop.'
        : 'Review decision accepted. The turn will now stop.'
      : `Review decision rejected: ${result.error}`,
})
