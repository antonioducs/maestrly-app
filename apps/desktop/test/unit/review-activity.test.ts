import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import {
  createReviewActivityRecorder,
  finishedActivity,
  noteText,
  startedActivity,
} from '../../src/main/chat/review/activity'
import type { ReviewActivity } from '../../src/shared/review'

const cwd = path.resolve('/repo')

describe('review activity', () => {
  it('describes reads, searches and submissions the way the person follows them', () => {
    expect(startedActivity('read', { path: path.join(cwd, 'src/a.ts'), offset: 18, limit: 9 }, cwd)).toMatchObject({
      kind: 'read',
      text: 'src/a.ts',
      path: 'src/a.ts',
      range: '18–26',
      status: 'running',
    })
    expect(startedActivity('read', { path: 'src/a.ts', offset: 40 }, cwd)).toMatchObject({ range: '40–' })
    expect(startedActivity('read', { path: '../outside.ts' }, cwd)).toMatchObject({ text: '../outside.ts' })
    expect(startedActivity('read', { path: '../outside.ts' }, cwd).path).toBeUndefined()
    expect(startedActivity('grep', { pattern: 'Date.now(', include: '*.ts', path: 'src' }, cwd)).toMatchObject({
      kind: 'grep',
      text: 'Date.now( (*.ts) in src',
    })
    expect(startedActivity('git_diff', {}, cwd)).toMatchObject({ kind: 'diff' })
    expect(startedActivity('record_verdicts', {}, cwd)).toMatchObject({ kind: 'submit' })
    expect(startedActivity('subagent:abc:read', { path: 'x' }, cwd).kind).toBe('tool')

    const grep = startedActivity('grep', { pattern: 'x' }, cwd)
    expect(
      finishedActivity(grep, {}, '3 match(es):\n\nsrc/a.ts:\n  Line 1: x\n\nsrc/b.ts:\n  Line 2: x', cwd)
    ).toMatchObject({
      status: 'done',
      count: 3,
      files: ['src/a.ts', 'src/b.ts'],
    })
    expect(finishedActivity(grep, {}, 'No matches.', cwd)).toMatchObject({ count: 0 })
    const glob = startedActivity('glob', { pattern: '*.ts' }, cwd)
    expect(finishedActivity(glob, {}, 'a.ts\nb.ts', cwd)).toMatchObject({ count: 2 })
    expect(finishedActivity(glob, {}, 'No files found.', cwd)).toMatchObject({ count: 0 })
    const read = startedActivity('read', { path: 'src' }, cwd)
    // A directory listing is not evidence about a file.
    expect(finishedActivity(read, {}, 'src/\na.ts\nb.ts', cwd).path).toBeUndefined()
    const submit = startedActivity('submit_findings', {}, cwd)
    expect(finishedActivity(submit, { findings: [{}, {}] }, 'ok', cwd)).toMatchObject({ count: 2 })
  })

  it('keeps notes to the last paragraph, on one short line', () => {
    expect(noteText('Looking at it.\n\nNow  checking\nthe clock.')).toBe('Now checking the clock.')
    expect(noteText('x'.repeat(300))).toHaveLength(240)
  })

  it('reports tool calls and notes as they happen, without changing what the tools return', async () => {
    const events: ReviewActivity[] = []
    const recorder = createReviewActivityRecorder({ cwd, emit: (activity) => events.push({ ...activity }) })
    const tools = recorder.instrumentTools({
      read: { execute: async () => 'src/a.ts:\n1 one' },
      grep: {
        execute: async () => {
          throw new Error('bad regex')
        },
      },
      plain: { description: 'no execute' },
    } as unknown as ToolSet) as unknown as Record<
      string,
      { execute: (input: unknown, options: unknown) => Promise<unknown> }
    >
    recorder.text({ kind: 'append', text: 'Let me read ' })
    recorder.text({ kind: 'append', text: 'the limiter.' })
    expect(await tools.read.execute({ path: 'src/a.ts' }, {})).toBe('src/a.ts:\n1 one')
    await expect(tools.grep.execute({ pattern: '(' }, {})).rejects.toThrow('bad regex')
    recorder.text({ kind: 'replace', text: 'Done.' })
    recorder.complete({ status: 'completed' })
    expect(events.map((event) => [event.kind, event.status, event.text])).toEqual([
      ['note', 'running', 'Let me read'],
      ['note', 'running', 'Let me read the limiter.'],
      ['note', 'done', 'Let me read the limiter.'],
      ['read', 'running', 'src/a.ts'],
      ['read', 'done', 'src/a.ts'],
      ['grep', 'running', '('],
      ['grep', 'failed', '('],
      ['note', 'running', 'Done.'],
      ['note', 'done', 'Done.'],
    ])
    expect(recorder.available).toBe(false)
    expect(recorder.summary()).toBeNull()
  })

  it('never lets a failing observer break a reviewer', async () => {
    const recorder = createReviewActivityRecorder({
      cwd,
      emit: () => {
        throw new Error('renderer gone')
      },
    })
    const tools = recorder.instrumentTools({
      read: { execute: async () => 'ok' },
    } as unknown as ToolSet) as unknown as Record<
      string,
      { execute: (input: unknown, options: unknown) => Promise<unknown> }
    >
    expect(await tools.read.execute({ path: 'a' }, {})).toBe('ok')
  })
})
