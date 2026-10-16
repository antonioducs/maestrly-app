import { describe, expect, it, vi } from 'vitest'
import {
  ReviewEngineError,
  runReviewCheck,
  runReviewEngine,
  type ReviewProgress,
  type ReviewerRunInput,
  type ReviewerRunResult,
} from '../../src/main/chat/review/engine'
import type { RecordedVerdict, SubmittedFinding } from '../../src/main/chat/review/findings'
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
  it('runs every lens in parallel, shows candidates as they are raised, and rules on each one', async () => {
    const started: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const progress: ReviewProgress[] = []
    const runReviewer = vi.fn(async (input: ReviewerRunInput): Promise<ReviewerRunResult> => {
      if (input.stage === 'lens') {
        started.push(input.lens)
        // Every lens must have started before any finishes.
        if (started.length === 3) release()
        await gate
        const findings =
          input.lens === 'correctness'
            ? [finding()]
            : input.lens === 'integration'
              ? [finding({ severity: 'blocking', title: 'Stored rows are not migrated' })]
              : [finding({ severity: 'minor', title: 'Style nit' }), finding({ title: 'Same rows not migrated' })]
        // Candidates show up the moment the reviewer submits, before its run ends.
        input.onSubmission({ findings })
        return { submission: { findings }, usage: usage(10) }
      }
      if (input.stage !== 'verifier') throw new Error('unexpected stage')
      expect(input.candidateIds).toHaveLength(4)
      const id = (title: string) => progress.at(-1)!.candidates.find((candidate) => candidate.title === title)!.id
      const verdicts: RecordedVerdict[] = [
        {
          candidateId: id('Off-by-one in pagination'),
          verdict: 'confirmed',
          severity: 'minor',
          reason: 'Only the last page.',
        },
        { candidateId: id('Stored rows are not migrated'), verdict: 'confirmed' },
        { candidateId: id('Style nit'), verdict: 'discarded', reason: 'Style, not a defect.' },
        {
          candidateId: id('Same rows not migrated'),
          verdict: 'merged',
          into: id('Stored rows are not migrated'),
          reason: 'Same root cause.',
        },
      ]
      input.onVerdicts(verdicts.slice(0, 2))
      input.onVerdicts(verdicts.slice(2))
      return { verdicts, usage: usage(30), runtimeEstimatedCostUsd: 0.25 }
    })

    const result = await runReviewEngine({
      target: 'code',
      lenses: ['correctness', 'integration', 'security'],
      context,
      signal: new AbortController().signal,
      runReviewer,
      onProgress: (value) => progress.push(value),
    })

    expect(started.sort()).toEqual(['correctness', 'integration', 'security'])
    expect(runReviewer).toHaveBeenCalledTimes(4)
    expect(result.candidates).toHaveLength(4)
    expect(result.verification).toBe('done')
    expect(result.unverified).toBe(false)
    const merged = result.candidates.find((candidate) => candidate.title === 'Same rows not migrated')!.id
    expect(
      result.findings.map((item) => [item.id, item.severity, item.lens, item.title, item.fromSeverity, item.merged])
    ).toEqual([
      ['F1', 'blocking', 'integration', 'Stored rows are not migrated', undefined, [merged]],
      ['F2', 'minor', 'correctness', 'Off-by-one in pagination', 'important', undefined],
    ])
    expect(result.dropped.map((item) => [item.verdict, item.title, item.reason])).toEqual([
      ['discarded', 'Style nit', 'Style, not a defect.'],
      ['merged', 'Same rows not migrated', 'Same root cause.'],
    ])
    expect(result.usage).toMatchObject({ input: 60, output: 4 })
    expect(result.runtimeEstimatedCostUsd).toBe(0.25)
    // Candidates appeared lens by lens, and verdicts arrived in two batches.
    expect(progress.some((item) => item.candidates.length > 0 && item.verification === 'pending')).toBe(true)
    expect(progress.map((item) => item.verdicts.length).filter((count) => count > 0)).toEqual(
      expect.arrayContaining([2, 4])
    )
    expect(progress.at(-1)).toMatchObject({ verification: 'done' })
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
    expect(result).toMatchObject({ findings: [], candidates: [], verification: 'skipped', unverified: false })
  })

  it('tolerates a failed lens but fails when every lens fails', async () => {
    const partial = await runReviewEngine({
      target: 'code',
      lenses: ['correctness', 'security'],
      context,
      signal: new AbortController().signal,
      runReviewer: async (input) =>
        input.stage === 'verifier'
          ? { verdicts: [{ candidateId: 'C1', verdict: 'confirmed' }] }
          : input.stage === 'lens' && input.lens === 'security'
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

  it('keeps what a reviewer submitted even when its run fails afterwards', async () => {
    const result = await runReviewEngine({
      target: 'code',
      lenses: ['correctness'],
      context,
      signal: new AbortController().signal,
      runReviewer: async (input) => {
        if (input.stage === 'lens') {
          input.onSubmission({ findings: [finding()] })
          return { error: 'stream closed' }
        }
        return { verdicts: [{ candidateId: 'C1', verdict: 'confirmed' }] }
      },
    })
    expect(result.failedLenses).toEqual([])
    expect(result.findings.map((item) => item.title)).toEqual(['Off-by-one in pagination'])
  })

  it('marks candidates the verifier never ruled on as unconfirmed, after the confirmed ones', async () => {
    const result = await runReviewEngine({
      target: 'code',
      lenses: ['correctness', 'integration'],
      context,
      signal: new AbortController().signal,
      runReviewer: async (input) =>
        input.stage === 'verifier'
          ? { verdicts: [{ candidateId: 'C1', verdict: 'confirmed' }], error: 'stream closed' }
          : {
              submission: {
                findings: [
                  finding({ severity: input.stage === 'lens' && input.lens === 'integration' ? 'blocking' : 'minor' }),
                ],
              },
            },
    })
    expect(result.unverified).toBe(true)
    expect(result.verification).toBe('done')
    expect(result.findings.map((item) => [item.id, item.severity, item.unverified ?? false])).toEqual([
      ['F1', 'minor', false],
      ['F2', 'blocking', true],
    ])
  })

  it('returns every candidate unconfirmed when the verifier records nothing', async () => {
    const result = await runReviewEngine({
      target: 'code',
      lenses: ['correctness'],
      context,
      signal: new AbortController().signal,
      runReviewer: async (input) =>
        input.stage === 'verifier'
          ? { verdicts: [], error: 'The verifier finished without recording verdicts.' }
          : { submission: { findings: [finding()] } },
    })
    expect(result).toMatchObject({ verification: 'failed', unverified: true })
    expect(result.findings).toEqual([expect.objectContaining({ id: 'F1', unverified: true, candidateId: 'C1' })])
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

describe('review check', () => {
  const findings = [
    { id: 'F1', severity: 'blocking', title: 'Buckets per worker', details: 'Doubles the limit.' },
    { id: 'F2', severity: 'important', title: 'Header trusted', details: 'Spoofable key.' },
  ]

  it('reports each fix as it is checked and marks the ones it never got to as unknown', async () => {
    const seen: number[] = []
    const result = await runReviewCheck({
      findings,
      context,
      signal: new AbortController().signal,
      onResults: (results) => seen.push(results.length),
      runReviewer: async (input) => {
        if (input.stage !== 'check') throw new Error('unexpected stage')
        expect(input.task).toContain('checking fixes')
        expect(input.task).toContain('"id": "F2"')
        input.onResults([{ findingId: 'F1', state: 'open', note: 'The key is still shared.' }])
        return { results: [{ findingId: 'F1', state: 'open', note: 'The key is still shared.' }], usage: usage(7) }
      },
    })
    expect(seen).toEqual([1])
    expect(result.results).toEqual([
      { findingId: 'F1', state: 'open', note: 'The key is still shared.' },
      { findingId: 'F2', state: 'unknown' },
    ])
    expect(result.usage.input).toBe(7)
  })

  it('fails when the checker records nothing', async () => {
    await expect(
      runReviewCheck({
        findings,
        context,
        signal: new AbortController().signal,
        runReviewer: async () => ({ results: [], error: 'quota exhausted' }),
      })
    ).rejects.toMatchObject({ code: 'checker-failed', message: 'quota exhausted' })
  })
})
