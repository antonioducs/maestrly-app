/**
 * Portable context and revision identity across a model switch.
 *
 * A stage that changes account or provider cannot transplant opaque native state. It receives the objective,
 * the public decisions and the code, and the code identity is a full digest of the captured revision.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  captureCodeRevision,
  createGitRunner,
  materializeReviewCopy,
  RevisionCaptureError,
} from '../../src/main/platform/delegation-snapshot'
import { estimatePortableContextTokens, splitPortableTranscript } from '../../src/main/chat/portable-context'
import type { ChatMessage } from '../../src/shared/chat'

let scratch = ''
let repository = ''

function git(args: string[], cwd = repository) {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
}

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'delegation-context-'))
  repository = path.join(scratch, 'repo')
  mkdirSync(repository)
  git(['init', '--initial-branch=main'])
  git(['config', 'user.email', 'fixture@example.test'])
  git(['config', 'user.name', 'Fixture'])
  writeFileSync(path.join(repository, 'README.md'), '# base\n')
  git(['add', '.'])
  git(['commit', '-m', 'base'])
})
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})

it('captures a full revision identity that changes with any tracked or new file', async () => {
  const clean = await captureCodeRevision({ cwd: repository })
  expect(clean.revision.headCommit).toMatch(/^[0-9a-f]{40}$/)
  expect(clean.revision.baseCommit).toBe(clean.revision.headCommit)
  expect(clean.revision.contentDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(clean.patch.byteLength).toBe(0)

  writeFileSync(path.join(repository, 'README.md'), '# base\nchanged\n')
  const modified = await captureCodeRevision({ cwd: repository })
  expect(modified.revision.contentDigest).not.toBe(clean.revision.contentDigest)
  expect(modified.patch.toString('utf8')).toContain('changed')

  writeFileSync(path.join(repository, 'new-file.ts'), 'export const value = 1\n')
  const withUntracked = await captureCodeRevision({ cwd: repository })
  expect(withUntracked.untracked).toEqual(['new-file.ts'])
  expect(withUntracked.revision.contentDigest).not.toBe(modified.revision.contentDigest)
  expect(withUntracked.patch.toString('utf8')).toContain('new-file.ts')
  // The capture restores the index it borrowed for the intent-to-add.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' })
  expect(status).toContain('?? new-file.ts')

  // The same content twice yields the same identity.
  const again = await captureCodeRevision({ cwd: repository })
  expect(again.revision.contentDigest).toBe(withUntracked.revision.contentDigest)
})

it('refuses to capture a revision it cannot represent in full', async () => {
  const notRepository = path.join(scratch, 'plain')
  mkdirSync(notRepository)
  await expect(captureCodeRevision({ cwd: notRepository })).rejects.toBeInstanceOf(RevisionCaptureError)
  await expect(captureCodeRevision({ cwd: notRepository })).rejects.toThrow(/not a Git repository/)
})

it('materializes a stable review copy that later edits cannot change', async () => {
  writeFileSync(path.join(repository, 'README.md'), '# base\nreviewed content\n')
  writeFileSync(path.join(repository, 'added.ts'), 'export const added = true\n')
  const copy = await materializeReviewCopy({ cwd: repository, baseDirectory: scratch })
  try {
    expect(readFileSync(path.join(copy.path, 'README.md'), 'utf8')).toContain('reviewed content')
    expect(readFileSync(path.join(copy.path, 'added.ts'), 'utf8')).toContain('added = true')

    // The implementer keeps working; the review copy is unaffected.
    writeFileSync(path.join(repository, 'README.md'), '# base\nlater edit\n')
    expect(readFileSync(path.join(copy.path, 'README.md'), 'utf8')).toContain('reviewed content')
    const later = await captureCodeRevision({ cwd: repository })
    expect(later.revision.contentDigest).not.toBe(copy.revision.contentDigest)
  } finally {
    await copy.dispose()
  }
  expect(existsSync(copy.path)).toBe(false)
  // The temporary worktree is unregistered, so the repository stays clean for the next stage.
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repository, encoding: 'utf8' })
  expect(worktrees).not.toContain('maestrly-review')
})

it('reconstructs a transferable transcript without native opaque checkpoints', () => {
  const message = (role: 'user' | 'assistant', text: string, checkpoint?: 'openai-native'): ChatMessage =>
    ({
      id: crypto.randomUUID(),
      conversationId: 'conversation',
      role,
      createdAt: Date.now(),
      parts: [{ id: 'text', type: 'text', text, ...(checkpoint ? { checkpoint } : {}) }],
    }) as ChatMessage
  const portable = estimatePortableContextTokens([
    message('user', 'Implement the delegation panel'),
    message('assistant', 'Implemented and verified'),
  ])
  expect(portable).toBeGreaterThan(0)
  // An opaque native checkpoint is never counted as transferable context.
  const withNative = estimatePortableContextTokens([
    message('user', 'Implement the delegation panel'),
    message('assistant', 'x'.repeat(4000), 'openai-native'),
  ])
  expect(withNative).toBeLessThan(portable + 100)

  const chunks = splitPortableTranscript('a'.repeat(5_000), 1_000)
  expect(chunks.join('')).toBe('a'.repeat(5_000))
  expect(chunks.length).toBeGreaterThan(1)
})

it('uses an injected git runner so capture stays testable without touching the real repository', async () => {
  const calls: string[][] = []
  const real = createGitRunner(repository)
  const captured = await captureCodeRevision({
    cwd: repository,
    git: async (args, options) => {
      calls.push(args)
      return real(args, options)
    },
  })
  expect(captured.revision.headCommit).toMatch(/^[0-9a-f]{40}$/)
  expect(calls[0]).toEqual(['rev-parse', 'HEAD'])
})
