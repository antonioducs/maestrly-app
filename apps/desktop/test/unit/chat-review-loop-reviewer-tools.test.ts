import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReviewerRoundRecorder } from '../../src/main/chat/review-loop/reviewer-runtime'
import { gitDiffTool } from '../../src/main/chat/tools/git-diff'
import { submitReviewTool } from '../../src/main/chat/tools/submit-review'
import { readTool } from '../../src/main/chat/tools/read'
import type { ToolContext } from '../../src/main/chat/tools/util'
import { builtinToolNamesForMode, REVIEWER_READONLY_TOOL_NAMES } from '../../src/main/chat/tools'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function context(cwd: string, reviewer?: ToolContext['reviewer']): ToolContext {
  return {
    conversationId: 'reviewer',
    projectId: 'project',
    messageId: 'message',
    toolCallId: 'tool',
    cwd,
    signal: new AbortController().signal,
    ask: async () => undefined,
    askQuestion: async () => [],
    ...(reviewer ? { reviewer } : {}),
  }
}

describe('reviewer round recorder', () => {
  it('requires fresh diff, search and read evidence and accepts one idempotent decision', () => {
    const recorder = createReviewerRoundRecorder({
      searchExecutionContext: vi.fn(),
      readExecutionContext: vi.fn(),
    })
    const decision = { result: 'clean' as const, summary: 'Everything is clean.' }
    expect(recorder.submitReview(decision)).toEqual({ ok: false, error: 'insufficient-investigation' })
    recorder.recordEvidence('diff')
    recorder.recordEvidence('search')
    recorder.recordEvidence('read')
    expect(recorder.submitReview(decision)).toEqual({ ok: true })
    expect(recorder.submitReview(decision)).toEqual({ ok: true, idempotent: true })
    expect(
      recorder.submitReview({
        result: 'findings',
        summary: 'Different',
        findings: [
          {
            id: 'x',
            severity: 'important',
            title: 'Issue',
            details: 'Details',
          },
        ],
      })
    ).toEqual({ ok: false, error: 'review-decision-conflict' })
  })

  it('rejects unsafe paths and clean with remaining important findings', () => {
    const recorder = createReviewerRoundRecorder({ searchExecutionContext: vi.fn(), readExecutionContext: vi.fn() })
    for (const kind of ['diff', 'search', 'read'] as const) recorder.recordEvidence(kind)
    expect(
      recorder.submitReview({
        result: 'findings',
        summary: 'Issue',
        findings: [{ id: 'x', severity: 'important', title: 'Escape', details: 'No', paths: ['../secret'] }],
      })
    ).toMatchObject({ ok: false })
    expect(
      recorder.submitReview({
        result: 'clean',
        summary: 'Not clean',
        findings: [{ id: 'x', severity: 'important', title: 'Issue', details: 'Still open' }],
      })
    ).toMatchObject({ ok: false })
  })
})

describe('internal reviewer tools', () => {
  it('uses the exact seven-tool allowlist and keeps internal tools out of normal turns', () => {
    expect([...REVIEWER_READONLY_TOOL_NAMES].sort()).toEqual([
      'git_diff',
      'glob',
      'grep',
      'read',
      'read_execution_context',
      'search_execution_context',
      'submit_review',
    ])
    const normal = builtinToolNamesForMode('agent')
    for (const internal of ['git_diff', 'read_execution_context', 'search_execution_context', 'submit_review']) {
      expect(normal.has(internal)).toBe(false)
    }
  })

  it('submit_review is unavailable in a normal turn', async () => {
    await expect(
      submitReviewTool.execute({ result: 'clean', summary: 'clean' }, context(process.cwd()))
    ).resolves.toEqual({ ok: false, error: 'submit_review is available only internally' })
  })

  it('git_diff has no user-controlled ref/path and returns bounded structured sections', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'review-git-diff-'))
    roots.push(root)
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
    writeFileSync(path.join(root, 'tracked.txt'), 'base\n')
    execFileSync('git', ['add', '--', 'tracked.txt'], { cwd: root })
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root })
    writeFileSync(path.join(root, 'tracked.txt'), 'changed\n')
    writeFileSync(path.join(root, 'new.txt'), 'new\n')
    const recorder = createReviewerRoundRecorder({ searchExecutionContext: vi.fn(), readExecutionContext: vi.fn() })

    expect(gitDiffTool.parameters.safeParse({ ref: 'HEAD; rm -rf .', path: '..' }).success).toBe(false)
    const result = await gitDiffTool.execute({}, context(root, recorder))
    expect(result.unstaged).toContain('changed')
    expect(result.untracked).toContain('new.txt')
    expect(result.truncated).toBe(false)
    expect(recorder.evidence().diff).toBe(1)
  })

  it('does not follow an in-checkout symlink to read outside the reviewer checkout', async () => {
    if (process.platform === 'win32') return
    const root = mkdtempSync(path.join(os.tmpdir(), 'review-read-jail-'))
    const outside = mkdtempSync(path.join(os.tmpdir(), 'review-read-outside-'))
    roots.push(root, outside)
    writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
    const recorder = createReviewerRoundRecorder({ searchExecutionContext: vi.fn(), readExecutionContext: vi.fn() })

    await expect(readTool.execute({ path: 'link.txt' }, context(root, recorder))).rejects.toThrow(/escapes/i)
    expect(recorder.evidence().read).toBe(0)
  })
})
