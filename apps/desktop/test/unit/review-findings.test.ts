import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createCheckCollector,
  createFindingsCollector,
  createVerdictCollector,
  normalizeFindingPath,
  parseSubmission,
  parseSubmissionFromText,
  type RecordedVerdict,
} from '../../src/main/chat/review/findings'
import { checkTask, lensTask, numberedPlan, verifierTask } from '../../src/main/chat/review/prompts'
import type { ReviewCheckResult } from '../../src/shared/review'

const cwd = path.resolve('/repo')

const raw = {
  severity: 'blocking',
  title: 'Race between cancel and admission',
  details: 'A cancel during preflight leaves the lease held.',
  evidence: 'service.ts:120 releases only on success.',
  path: './src/service.ts',
  line: 120,
}

describe('review findings', () => {
  it('normalizes repository-relative paths and rejects anything outside the checkout', () => {
    expect(normalizeFindingPath('./src/a.ts', cwd)).toBe('src/a.ts')
    expect(normalizeFindingPath(path.join(cwd, 'src', 'b.ts'), cwd)).toBe('src/b.ts')
    expect(normalizeFindingPath('src\\c.ts', cwd)).toBe('src/c.ts')
    expect(normalizeFindingPath('../outside.ts', cwd)).toBeUndefined()
    expect(normalizeFindingPath('/etc/passwd', cwd)).toBeUndefined()
    expect(normalizeFindingPath('   ', cwd)).toBeUndefined()
  })

  it('validates submissions and keeps lines only with a path', () => {
    const parsed = parseSubmission(
      { summary: 'One issue', findings: [raw, { ...raw, path: '../x', plan_line: 4 }] },
      cwd
    )
    expect(parsed).toEqual({
      ok: true,
      value: {
        summary: 'One issue',
        findings: [
          {
            severity: 'blocking',
            title: raw.title,
            details: raw.details,
            evidence: raw.evidence,
            path: 'src/service.ts',
            line: 120,
          },
          { severity: 'blocking', title: raw.title, details: raw.details, evidence: raw.evidence, planLine: 4 },
        ],
      },
    })
    expect(parseSubmission({ findings: [{ ...raw, severity: 'nit' }] }, cwd)).toMatchObject({ ok: false })
    expect(parseSubmission({ findings: [{ ...raw, evidence: '' }] }, cwd)).toMatchObject({ ok: false })
  })

  it('falls back to a JSON block in the final text', () => {
    const text = `Done.\n\n\`\`\`json\n${JSON.stringify({ findings: [raw] })}\n\`\`\``
    expect(parseSubmissionFromText(text, cwd)?.findings).toHaveLength(1)
    expect(parseSubmissionFromText('No JSON here', cwd)).toBeNull()
  })

  it('keeps the last valid submission, reports each one as it happens, and explains rejected ones', async () => {
    const seen: number[] = []
    const collector = createFindingsCollector(cwd, (submission) => seen.push(submission.findings.length))
    const execute = collector.tool.execute as (input: unknown, options: unknown) => Promise<string>
    expect(await execute({ findings: [{ ...raw, severity: 'nit' }] }, {})).toMatch(/^Findings rejected:/)
    expect(collector.submission()).toBeNull()
    expect(await execute({ findings: [raw] }, {})).toMatch(/Recorded 1 finding/)
    expect(await execute({ findings: [] }, {})).toMatch(/no findings/)
    expect(collector.submission()).toEqual({ findings: [] })
    expect(seen).toEqual([1, 0])
  })

  it('records verdicts as they come, refusing unknown candidates, bad merges and unexplained rejections', async () => {
    const batches: RecordedVerdict[][] = []
    const collector = createVerdictCollector(cwd, ['C1', 'C2', 'C3'], (batch) => batches.push(batch))
    const execute = collector.tool.execute as (input: unknown, options: unknown) => Promise<string>
    const first = await execute(
      {
        verdicts: [
          { candidate_id: 'C1', verdict: 'confirmed', severity: 'minor', path: './src/a.ts', line: 3 },
          { candidate_id: 'C9', verdict: 'confirmed' },
          { candidate_id: 'C2', verdict: 'merged', merged_into: 'C2', reason: 'dup' },
          { candidate_id: 'C3', verdict: 'discarded' },
        ],
      },
      {}
    )
    expect(first).toContain('Recorded C1.')
    expect(first).toContain('C9 is not a candidate')
    expect(first).toContain('C2: merged_into must name another candidate')
    expect(first).toContain('C3: give the reason it is discarded')
    expect(first).toContain('Still without a verdict: C2, C3.')
    const second = await execute(
      {
        verdicts: [
          { candidate_id: 'C2', verdict: 'merged', merged_into: 'C1', reason: 'Same root cause.' },
          { candidate_id: 'C3', verdict: 'discarded', reason: 'Not reproducible.', title: 'ignored on discard' },
        ],
      },
      {}
    )
    expect(second).toContain('Every candidate has a verdict')
    expect(collector.verdicts()).toEqual([
      { candidateId: 'C1', verdict: 'confirmed', severity: 'minor', path: 'src/a.ts', line: 3 },
      { candidateId: 'C2', verdict: 'merged', reason: 'Same root cause.', into: 'C1' },
      { candidateId: 'C3', verdict: 'discarded', reason: 'Not reproducible.' },
    ])
    expect(batches.map((batch) => batch.length)).toEqual([1, 2])
  })

  it('records check results for the findings it was given only', async () => {
    const batches: ReviewCheckResult[][] = []
    const collector = createCheckCollector(['F1', 'F2'], (batch) => batches.push(batch))
    const execute = collector.tool.execute as (input: unknown, options: unknown) => Promise<string>
    expect(
      await execute(
        {
          results: [
            { finding_id: 'F2', state: 'resolved', note: 'Fixed.' },
            { finding_id: 'F7', state: 'open', note: 'x' },
          ],
        },
        {}
      )
    ).toContain('Not findings of this review: F7')
    expect(await execute({ results: [{ finding_id: 'F1', state: 'open', note: 'Still shared.' }] }, {})).toContain(
      'Every finding is checked'
    )
    expect(collector.results()).toEqual([
      { findingId: 'F1', state: 'open', note: 'Still shared.' },
      { findingId: 'F2', state: 'resolved', note: 'Fixed.' },
    ])
    expect(batches).toHaveLength(2)
  })

  it('numbers plan lines and frames lens and verifier tasks', () => {
    expect(numberedPlan('a\nb')).toBe('1 | a\n2 | b')
    const planContext = {
      target: 'plan' as const,
      conversation: '[]',
      plan: '# Plan\n- step',
      language: 'Brazilian Portuguese',
    }
    const task = lensTask('feasibility', planContext)
    expect(task).toContain('Lens: feasibility')
    expect(task).toContain('1 | # Plan')
    expect(task).toContain('plan_line')
    expect(task).toContain('Brazilian Portuguese')
    const verify = verifierTask([{ id: 'C1' }], { target: 'code', conversation: '[]', language: 'English' })
    expect(verify).toContain('"id": "C1"')
    expect(verify).toContain('git_diff')
    expect(verify).toContain('record_verdicts')
    expect(verify).toContain('merged_into')
    const check = checkTask(
      [{ id: 'F1', severity: 'blocking', title: 'x', details: 'y', comment: 'Use Redis' }],
      planContext
    )
    expect(check).toContain('checking a plan revision')
    expect(check).toContain('record_checks')
    expect(check).toContain('"comment": "Use Redis"')
    expect(check).toContain('Do not raise new ones')
  })
})
