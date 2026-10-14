import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createFindingsCollector,
  normalizeFindingPath,
  parseSubmission,
  parseSubmissionFromText,
} from '../../src/main/chat/review/findings'
import { lensTask, numberedPlan, verifierTask } from '../../src/main/chat/review/prompts'

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

  it('keeps the last valid submission and explains rejected ones', async () => {
    const collector = createFindingsCollector(cwd)
    const execute = collector.tool.execute as (input: unknown, options: unknown) => Promise<string>
    expect(await execute({ findings: [{ ...raw, severity: 'nit' }] }, {})).toMatch(/^Findings rejected:/)
    expect(collector.submission()).toBeNull()
    expect(await execute({ findings: [raw] }, {})).toMatch(/Recorded 1 finding/)
    expect(await execute({ findings: [] }, {})).toMatch(/no findings/)
    expect(collector.submission()).toEqual({ findings: [] })
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
    expect(verify).toContain('candidate_id')
  })
})
