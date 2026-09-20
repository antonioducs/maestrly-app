/**
 * The reviewer must not be able to edit the implementer's workspace, and a revision identity must cover the
 * whole captured content.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  MAX_REVISION_BYTES,
  captureCodeRevision,
  directoryUsable,
  materializeReviewCopy,
} from '../../src/main/platform/delegation-snapshot'
import { isReadOnlyStage, READ_ONLY_STAGE_TYPES } from '../../src/main/platform/delegation-workspace'

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
  scratch = mkdtempSync(path.join(os.tmpdir(), 'delegation-snapshot-'))
  repository = path.join(scratch, 'repo')
  mkdirSync(repository)
  git(['init', '--initial-branch=main'])
  git(['config', 'user.email', 'fixture@example.test'])
  git(['config', 'user.name', 'Fixture'])
  writeFileSync(path.join(repository, 'index.ts'), 'export const value = 1\n')
  git(['add', '.'])
  git(['commit', '-m', 'base'])
})
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})

it('treats plan, review and inspect as read-only stages', () => {
  expect([...READ_ONLY_STAGE_TYPES]).toEqual(['plan', 'review', 'inspect'])
  for (const type of READ_ONLY_STAGE_TYPES) expect(isReadOnlyStage(type)).toBe(true)
  for (const type of ['implement', 'fix', 'qa', 'verify', 'deliver']) expect(isReadOnlyStage(type)).toBe(false)
})

it('isolates the review copy from the implementer workspace in both directions', async () => {
  writeFileSync(path.join(repository, 'index.ts'), 'export const value = 2\n')
  const copy = await materializeReviewCopy({ cwd: repository, baseDirectory: scratch })
  try {
    expect(await directoryUsable(copy.path)).toBe(true)
    expect(readFileSync(path.join(copy.path, 'index.ts'), 'utf8')).toContain('value = 2')

    // An edit inside the review copy never reaches the implementer's workspace.
    writeFileSync(path.join(copy.path, 'index.ts'), 'export const value = 999\n')
    expect(readFileSync(path.join(repository, 'index.ts'), 'utf8')).toContain('value = 2')

    // And an edit in the implementer's workspace never reaches the reviewed copy.
    writeFileSync(path.join(repository, 'index.ts'), 'export const value = 3\n')
    expect(readFileSync(path.join(copy.path, 'index.ts'), 'utf8')).toContain('value = 999')
  } finally {
    await copy.dispose()
  }
  expect(await directoryUsable(copy.path)).toBe(false)
})

it('binds every capture to a digest over the whole content and keeps the limit explicit', async () => {
  const first = await captureCodeRevision({ cwd: repository })
  writeFileSync(path.join(repository, 'index.ts'), 'export const value = 1\n// trailing comment\n')
  const second = await captureCodeRevision({ cwd: repository })
  expect(second.revision.contentDigest).not.toBe(first.revision.contentDigest)
  // Reverting the content restores the identity, so the digest is a property of the content only.
  writeFileSync(path.join(repository, 'index.ts'), 'export const value = 1\n')
  const third = await captureCodeRevision({ cwd: repository })
  expect(third.revision.contentDigest).toBe(first.revision.contentDigest)
  expect(MAX_REVISION_BYTES).toBeGreaterThan(1024 * 1024)
})

it('captures new files and nested directories as part of the revision', async () => {
  mkdirSync(path.join(repository, 'src', 'nested'), { recursive: true })
  writeFileSync(path.join(repository, 'src', 'nested', 'added.ts'), 'export const added = true\n')
  const captured = await captureCodeRevision({ cwd: repository })
  expect(captured.untracked).toEqual(['src/nested/added.ts'])
  const copy = await materializeReviewCopy({ cwd: repository, captured, baseDirectory: scratch })
  try {
    expect(readFileSync(path.join(copy.path, 'src', 'nested', 'added.ts'), 'utf8')).toContain('added = true')
  } finally {
    await copy.dispose()
  }
})
