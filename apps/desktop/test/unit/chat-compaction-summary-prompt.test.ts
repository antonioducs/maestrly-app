import { describe, expect, it, vi } from 'vitest'
import {
  auditCompactionSummary,
  COMPACTION_SUMMARY_SECTIONS,
  COMPACTION_SYSTEM_PROMPT,
  compactionSummaryTargetTokens,
} from '../../src/main/chat/compaction/summary-prompt'
import { summarizePortableTranscript, type PortableSummaryCallResult } from '../../src/main/chat/portable-context'

const structured = (body = 'fact') =>
  COMPACTION_SUMMARY_SECTIONS.map((section) => `## ${section}\n- ${body}`).join('\n\n')

describe('structured compaction summary', () => {
  it('asks for every section in order, literal identifiers and incremental updates', () => {
    let last = -1
    for (const section of COMPACTION_SUMMARY_SECTIONS) {
      const index = COMPACTION_SYSTEM_PROMPT.indexOf(`## ${section}`)
      expect(index).toBeGreaterThan(last)
      last = index
    }
    expect(COMPACTION_SYSTEM_PROMPT).toContain('(none)')
    expect(COMPACTION_SYSTEM_PROMPT).toContain('Previous summary:')
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/literally/)
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/Do not answer or continue the last message/)
  })

  it('passes a complete summary in any language and tolerates heading levels, colons and case', () => {
    expect(auditCompactionSummary(structured('Corrigir o login'))).toEqual([])
    const variant = COMPACTION_SUMMARY_SECTIONS.map((section, index) =>
      index % 2 ? `### ${section.toUpperCase()}:\n(none)` : `## **${section}**\n- x`
    ).join('\n')
    expect(auditCompactionSummary(variant)).toEqual([])
  })

  it('reports missing sections and empty output without a model call', () => {
    expect(auditCompactionSummary('   ')).toEqual(['the summary is empty'])
    const partial = structured().replace('## Exact identifiers', 'Exact identifiers').replace('## Decisions', '')
    expect(auditCompactionSummary(partial)).toEqual([
      'missing section "## Decisions"',
      'missing section "## Exact identifiers"',
    ])
  })

  it('targets 20% of the source between 2k and min(10k, 5% of the window)', () => {
    expect(compactionSummaryTargetTokens(1_000, 200_000)).toBe(2_000)
    expect(compactionSummaryTargetTokens(30_000, 200_000)).toBe(6_000)
    expect(compactionSummaryTargetTokens(500_000, 200_000)).toBe(10_000)
    expect(compactionSummaryTargetTokens(500_000, 100_000)).toBe(5_000)
    expect(compactionSummaryTargetTokens(500_000, 32_000)).toBe(1_600)
    expect(compactionSummaryTargetTokens(500_000)).toBe(10_000)
  })
})

describe('final summary audit in the map-reduce compactor', () => {
  it('retries a malformed final summary once with the issues and accepts the corrected one', async () => {
    const summarize = vi
      .fn<(prompt: string) => Promise<PortableSummaryCallResult>>()
      .mockResolvedValueOnce({ text: 'free-form summary' })
      .mockResolvedValueOnce({ text: structured() })
    const result = await summarizePortableTranscript('User: hello', 10_000, summarize, {
      auditFinal: auditCompactionSummary,
    })
    expect(result).toMatchObject({ summary: structured(), calls: 2 })
    expect(result.qualityDegraded).toBeUndefined()
    expect(summarize.mock.calls[1][0]).toContain('missing section "## Objective"; missing section "## Requirements')
    expect(summarize.mock.calls[1][0]).toContain('User: hello')
  })

  it('accepts the better attempt as degraded when the retry still fails, and bills both attempts', async () => {
    const usage = { input: 10, output: 2, cacheRead: 0, cacheCreate: 0, totalInput: 10 }
    const almost = structured().replace('## Next steps', '')
    const summarize = vi
      .fn<(prompt: string) => Promise<PortableSummaryCallResult>>()
      .mockResolvedValueOnce({ text: 'free-form summary', usage })
      .mockResolvedValueOnce({ text: almost, usage })
    const result = await summarizePortableTranscript('User: hello', 10_000, summarize, {
      auditFinal: auditCompactionSummary,
    })
    expect(result).toMatchObject({ summary: almost, qualityDegraded: true, calls: 2, usage: { input: 20 } })
  })

  it('keeps the first summary when the corrective attempt fails, and never blocks compaction', async () => {
    const summarize = vi
      .fn<(prompt: string) => Promise<PortableSummaryCallResult>>()
      .mockResolvedValueOnce({ text: 'free-form summary' })
      .mockRejectedValueOnce(Object.assign(new Error('Invalid request'), { status: 400 }))
    const result = await summarizePortableTranscript('User: hello', 10_000, summarize, {
      auditFinal: auditCompactionSummary,
    })
    expect(result).toMatchObject({ summary: 'free-form summary', qualityDegraded: true, calls: 2 })
  })

  it('audits only the final output, and checkpoints only the accepted text', async () => {
    const prompts: string[] = []
    const checkpoints: string[][] = []
    const summarize = vi.fn(async (prompt: string, phase: 'chunk' | 'consolidate') => {
      prompts.push(prompt)
      if (phase === 'chunk') return { text: 'partial chunk notes' }
      return { text: prompts.filter((item) => item.startsWith('Summary group')).length === 1 ? 'bad' : structured() }
    })
    const result = await summarizePortableTranscript(`${'a'.repeat(1_500)}\n${'b'.repeat(1_500)}`, 1_000, summarize, {
      auditFinal: auditCompactionSummary,
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint.completed),
    })
    expect(result.summary).toBe(structured())
    expect(prompts.filter((prompt) => prompt.startsWith('Source chunk'))).toHaveLength(4)
    expect(prompts.filter((prompt) => prompt.startsWith('Summary group'))).toHaveLength(2)
    expect(checkpoints.at(-1)).toEqual([structured()])
    expect(checkpoints.flat()).not.toContain('bad')
  })

  it('does not swallow cancellation during the corrective attempt', async () => {
    const controller = new AbortController()
    const summarize = vi
      .fn<
        (prompt: string, phase: 'chunk' | 'consolidate', signal?: AbortSignal) => Promise<PortableSummaryCallResult>
      >()
      .mockResolvedValueOnce({ text: 'free-form summary' })
      .mockImplementationOnce(async () => {
        controller.abort(new DOMException('stopped', 'AbortError'))
        throw new DOMException('stopped', 'AbortError')
      })
    await expect(
      summarizePortableTranscript('User: hello', 10_000, summarize, {
        auditFinal: auditCompactionSummary,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
