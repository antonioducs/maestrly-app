import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { codeScope, fileSnippet, planScope, planSnippet, withSnippets } from '../../src/main/chat/review/scope'
import type { ReviewFinding } from '../../src/shared/review'

const root = mkdtempSync(path.join(os.tmpdir(), 'review-scope-'))
const repo = path.join(root, 'repo')
mkdirSync(path.join(repo, 'src'), { recursive: true })
writeFileSync(path.join(repo, 'src', 'a.ts'), Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n'))
writeFileSync(path.join(repo, 'src', 'bin.dat'), Buffer.from([65, 0, 66]))
writeFileSync(path.join(root, 'secret.txt'), 'outside\nthe checkout')
symlinkSync(path.join(root, 'secret.txt'), path.join(repo, 'escape.txt'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const finding = (overrides: Partial<ReviewFinding>): ReviewFinding => ({
  id: 'F1',
  severity: 'minor',
  title: 't',
  details: 'd',
  lens: 'correctness',
  ...overrides,
})

describe('review scope', () => {
  it('lists the largest changes first, with totals over every file', () => {
    const scope = codeScope({
      repository: true,
      branch: 'feat/x',
      head: 'abc',
      files: [
        { path: 'b.ts', added: 1, deleted: 1 },
        { path: 'img.png' },
        { path: 'a.ts', added: 40, deleted: 2, isNew: true },
      ],
    })
    expect(scope).toEqual({
      kind: 'code',
      branch: 'feat/x',
      head: 'abc',
      files: [
        { path: 'a.ts', added: 40, deleted: 2, isNew: true },
        { path: 'b.ts', added: 1, deleted: 1 },
        { path: 'img.png' },
      ],
      filesTotal: 3,
      added: 41,
      deleted: 3,
    })
  })

  it('summarizes a plan by its title and top-level steps, outside code blocks', () => {
    expect(
      planScope(
        [
          '# Rate limit **exports**',
          '',
          '## Steps',
          '1. Add a bucket',
          '   - nested detail',
          '2. Wire it in',
          '```',
          '- not a step',
          '```',
          '- Out of scope',
        ].join('\n'),
        3
      )
    ).toEqual({
      kind: 'plan',
      version: 3,
      title: 'Rate limit exports',
      steps: ['Add a bucket', 'Wire it in', 'Out of scope'],
    })
    expect(planScope('# Plan\n## Context\n## Approach', 1)).toEqual({
      kind: 'plan',
      version: 1,
      title: 'Plan',
      steps: ['Context', 'Approach'],
    })
  })

  it('reads the lines around a finding, only inside the checkout and only from text files', async () => {
    expect(await fileSnippet(repo, 'src/a.ts', 5)).toEqual({
      source: 'file',
      path: 'src/a.ts',
      start: 2,
      lines: ['line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8'],
      highlight: 5,
    })
    expect((await fileSnippet(repo, 'src/a.ts', 1))?.lines).toHaveLength(4)
    expect(await fileSnippet(repo, 'src/a.ts', 99)).toBeNull()
    expect(await fileSnippet(repo, 'src/bin.dat', 1)).toBeNull()
    expect(await fileSnippet(repo, 'missing.ts', 1)).toBeNull()
    expect(await fileSnippet(repo, '../secret.txt', 1)).toBeNull()
    // A link that leads out of the checkout is not followed.
    expect(await fileSnippet(repo, 'escape.txt', 1)).toBeNull()
    expect(planSnippet('a\nb\nc', 2)).toMatchObject({ source: 'plan', start: 1, lines: ['a', 'b', 'c'], highlight: 2 })
  })

  it('attaches plan lines for plan reviews and file lines for code reviews', async () => {
    const [plan] = await withSnippets([finding({ planLine: 1, path: 'src/a.ts', line: 5 })], {
      cwd: repo,
      plan: 'step',
    })
    expect(plan.snippet).toMatchObject({ source: 'plan', lines: ['step'] })
    const [code, none] = await withSnippets([finding({ path: 'src/a.ts', line: 5 }), finding({ id: 'F2' })], {
      cwd: repo,
    })
    expect(code.snippet).toMatchObject({ source: 'file', highlight: 5 })
    expect(none.snippet).toBeUndefined()
  })
})
