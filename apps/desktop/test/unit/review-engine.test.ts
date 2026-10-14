import { describe, expect, it, vi } from 'vitest'
import {
  ReviewEngineError,
  runReviewEngine,
  type ReviewerRunInput,
  type ReviewerRunResult,
} from '../../src/main/chat/review/engine'
import type { SubmittedFinding } from '../../src/main/chat/review/findings'
import type { ReviewPromptContext } from '../../src/main/chat/review/prompts'

const context: ReviewPromptContext = { target: 'code', conversation: '[]', language: 'English' }

function finding(overrides: Partial<SubmittedFinding> = {}): SubmittedFinding {
  return {
    severity: 'important',
    title: 'Off-by-one in pagination',
    details: 'The last page is skipped when the total is a multiple of the page size.',
    evidence: 'src/page.ts:12 uses `<` instead of `<=`.',
    path: 'src/page.ts',
    line: 12,
    ...overrides,
  }
}

function usage(input: number) {
  return { input, output: 1, cacheRead: 0, cacheCreate: 0, totalInput: input }
}

describe('review engine', () => {
  it('runs every lens in parallel, then keeps only the findings the verifier confirms', async () => {
    const started: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runReviewer = vi.fn(async (input: ReviewerRunInput): Promise<ReviewerRunResult> => {
      if (input.stage === 'lens') {
        started.push(input.lens!)
        // Every lens must have started before any finishes.
        if (started.length === 3) release()
        await gate
        if (input.lens === 'correctness') return { submission: { findings: [finding()] }, usage: usage(10) }
        if (input.lens === 'integration') {
          return {
            submission: { findings: [finding({ severity: 'blocking', title: 'Stored rows are not migrated' })] },
            usage: usage(20),
          }
        }
        return { submission: { findings: [finding({ severity: 'minor', title: 'Style nit' })] }, usage: usage(5) }
      }
      expect(input.task).toContain('"id": "C1"')
      expect(input.task).toContain('"id": "C3"')
      // The verifier confirms C2 twice (merged duplicate) and C1, and drops C3.
      return {
        submission: {
          findings: [
            finding({ candidateId: 'C1', severity: 'minor', title: 'Off-by-one (narrower than reported)' }),
            finding({ candidateId: 'C2', severity: 'blocking', title: 'Stored rows are not migrated' }),
            finding({ candidateId: 'C2', title: 'Duplicate of C2' }),
          ],
        },
        usage: usage(30),
        runtimeEstimatedCostUsd: 0.25,
      }
    })
    const progress = vi.fn()

    const result = await runReviewEngine({
      target: 'code',
      lenses: ['correctness', 'integration', 'security'],
      context,
      signal: new AbortController().signal,
      runReviewer,
      onProgress: progress,
    })

    expect(started.sort()).toEqual(['correctness', 'integration', 'security'])
    expect(runReviewer).toHaveBeenCalledTimes(4)
    expect(result.candidates).toBe(3)
    expect(result.verification).toBe('done')
    expect(result.unverified).toBe(false)
    expect(result.findings.map((item) => [item.id, item.severity, item.lens, item.title])).toEqual([
      ['F1', 'blocking', 'integration', 'Stored rows are not migrated'],
      ['F2', 'minor', 'correctness', 'Off-by-one (narrower than reported)'],
    ])
    expect(result.usage).toMatchObject({ input: 65, output: 4 })
    expect(result.runtimeEstimatedCostUsd).toBe(0.25)
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ verification: 'done', candidates: 3 }))
  })

  it('skips verification when no lens raised anything', async () => {
    const runReviewer = vi.fn(async (): Promise<ReviewerRunResult> => ({ submission: { findings: [] } }))
    const result = await runReviewEngine({
      target: 'plan',
      lenses: ['feasibility', 'completeness'],
      context: { ...context, target: 'plan', plan: '1. Do it' },
      signal: new AbortController().signal,
      runReviewer,
    })
    expect(runReviewer).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ findings: [], candidates: 0, verification: 'skipped', unverified: false })
  })

  it('tolerates a failed lens but fails when every lens fails', async () => {
    const partial = await runReviewEngine({
      target: 'code',
      lenses: ['correctness', 'security'],
      context,
      signal: new AbortController().signal,
      runReviewer: async (input) =>
        input.stage === 'verifier'
          ? { submission: { findings: [finding({ candidateId: 'C1' })] } }
          : input.lens === 'security'
            ? { submission: null, error: 'model unavailable' }
            : { submission: { findings: [finding()] } },
    })
    expect(partial.failedLenses).toEqual(['security'])
    expect(partial.lenses).toEqual([
      { id: 'correctness', status: 'done', candidates: 1 },
      { id: 'security', status: 'failed' },
    ])
    expect(partial.findings).toHaveLength(1)

    await expect(
      runReviewEngine({
        target: 'code',
        lenses: ['correctness', 'security'],
        context,
        signal: new AbortController().signal,
        runReviewer: async () => {
          throw new Error('quota exhausted')
        },
      })
    ).rejects.toMatchObject({ code: 'reviewers-failed', message: 'quota exhausted' })
  })

  it('returns the unconfirmed candidates, marked as such, when the verifier fails', async () => {
    const result = await runReviewEngine({
      target: 'code',
      lenses: ['correctness', 'integration'],
      context,
      signal: new AbortController().signal,
      runReviewer: async (input) =>
        input.stage === 'verifier'
          ? { submission: null, error: 'The reviewer finished without submitting findings.' }
          : {
              submission: {
                findings: [finding({ severity: input.lens === 'integration' ? 'blocking' : 'minor' })],
              },
            },
    })
    expect(result.unverified).toBe(true)
    expect(result.verification).toBe('failed')
    expect(result.findings.map((item) => [item.id, item.severity, item.lens])).toEqual([
      ['F1', 'blocking', 'integration'],
      ['F2', 'minor', 'correctness'],
    ])
  })

  it('stops with a cancellation when the signal aborts', async () => {
    const controller = new AbortController()
    const run = runReviewEngine({
      target: 'code',
      lenses: ['correctness'],
      context,
      signal: controller.signal,
      runReviewer: (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    })
    controller.abort()
    await expect(run).rejects.toBeInstanceOf(ReviewEngineError)
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
  })
})
