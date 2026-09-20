/**
 * The host runs named checks. A model never supplies the command line, a check that writes runs in a
 * disposable copy, and truncation, timeouts and missing setup are reported instead of hidden.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { delegationCheckConfigSchema, type CodeRevision } from '@maestrly/protocol'
import { MAX_CHECK_LOG_BYTES, runNamedCheck } from '../../src/main/platform/delegation-checks'
import { uploadEvidence } from '../../src/main/platform/delegation-artifacts'

let scratch = ''
const revision: CodeRevision = {
  id: 'revision-1',
  baseCommit: 'a'.repeat(40),
  headCommit: 'a'.repeat(40),
  contentDigest: 'd'.repeat(64),
  snapshotArtifactId: null,
  capturedAt: '2026-09-20T00:00:00.000Z',
}

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'delegation-checks-'))
})
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})

const check = (overrides: Record<string, unknown> = {}) =>
  delegationCheckConfigSchema.parse({
    id: 'unit',
    label: 'Unit tests',
    command: process.execPath,
    args: ['-e', 'console.log("ok")'],
    timeoutSeconds: 30,
    ...overrides,
  })

it('records the resolved command, exit code and revision under test', async () => {
  const outcome = await runNamedCheck(check(), { cwd: scratch, revision })
  expect(outcome.result.passed).toBe(true)
  expect(outcome.result.exitCode).toBe(0)
  expect(outcome.result.codeRevisionDigest).toBe(revision.contentDigest)
  expect(outcome.result.resolvedCommand).toContain(process.execPath)
  expect(outcome.log.toString('utf8')).toContain('ok')
  expect(outcome.result.truncated).toBe(false)
  expect(outcome.result.setupIssue).toBeNull()
})

it('fails a non-zero exit and never reports it as passing', async () => {
  const outcome = await runNamedCheck(
    check({ args: ['-e', 'console.error("boom"); process.exit(3)'] }),
    { cwd: scratch, revision }
  )
  expect(outcome.result.passed).toBe(false)
  expect(outcome.result.exitCode).toBe(3)
  expect(outcome.log.toString('utf8')).toContain('boom')
})

it('reports a missing program as an explicit setup issue rather than a failure to interpret', async () => {
  const outcome = await runNamedCheck(check({ command: 'maestrly-not-installed', args: [] }), {
    cwd: scratch,
    revision,
  })
  expect(outcome.result.passed).toBe(false)
  expect(outcome.result.setupIssue).toContain('not installed')
})

it('stops with a setup issue when a setup step fails', async () => {
  const outcome = await runNamedCheck(
    check({ setup: [`${process.execPath} -e process.exit(9)`] }),
    { cwd: scratch, revision }
  )
  expect(outcome.result.passed).toBe(false)
  expect(outcome.result.setupIssue).toContain('exited with 9')
  expect(outcome.result.checkId).toBe('unit')
})

it('signals truncation instead of silently dropping output', async () => {
  const outcome = await runNamedCheck(
    check({ args: ['-e', `process.stdout.write("x".repeat(${MAX_CHECK_LOG_BYTES + 5000}))`] }),
    { cwd: scratch, revision }
  )
  expect(outcome.result.truncated).toBe(true)
  expect(outcome.log.byteLength).toBeLessThanOrEqual(MAX_CHECK_LOG_BYTES)
})

it('runs a mutating check in a disposable copy and leaves the workspace untouched', async () => {
  const workspace = path.join(scratch, 'workspace')
  mkdirSync(workspace)
  writeFileSync(path.join(workspace, 'state.txt'), 'original')
  let disposed = false
  const copy = path.join(scratch, 'copy')
  mkdirSync(copy)
  writeFileSync(path.join(copy, 'state.txt'), 'original')
  const outcome = await runNamedCheck(
    check({
      mutatesWorkspace: true,
      args: ['-e', 'require("node:fs").writeFileSync("state.txt", "mutated")'],
    }),
    {
      cwd: workspace,
      revision,
      reviewCopy: async () => ({
        path: copy,
        revision,
        dispose: async () => {
          disposed = true
        },
      }),
    }
  )
  expect(outcome.result.passed).toBe(true)
  expect(readFileSync(path.join(copy, 'state.txt'), 'utf8')).toBe('mutated')
  // The implementer's workspace is not changed by verification.
  expect(readFileSync(path.join(workspace, 'state.txt'), 'utf8')).toBe('original')
  expect(disposed).toBe(true)
})

it('forwards only the allowlisted environment variables', async () => {
  const outcome = await runNamedCheck(
    check({
      args: ['-e', 'console.log(JSON.stringify({allowed: process.env.ALLOWED ?? null, secret: process.env.SECRET ?? null}))'],
      environmentAllowlist: ['ALLOWED'],
    }),
    { cwd: scratch, revision, environment: { ...process.env, ALLOWED: 'yes', SECRET: 'no' } }
  )
  const parsed = JSON.parse(outcome.log.toString('utf8').trim())
  expect(parsed).toEqual({ allowed: 'yes', secret: null })
})

it('uploads evidence in chunks and refuses a mismatched acknowledgement', async () => {
  const chunks: string[] = []
  const artifact = await uploadEvidence(
    {
      start: async () => ({ uploadId: 'upload-1', chunkBytes: 4 }),
      chunk: async (input) => {
        chunks.push(input.contentBase64)
        return { nextIndex: input.index + 1 }
      },
      complete: async (input) => ({
        id: 'artifact-1',
        taskId: input.taskId,
        attemptId: null,
        kind: 'log',
        name: 'unit.log',
        contentType: 'text/plain',
        sizeBytes: 10,
        digest: input.digest,
        codeRevisionDigest: null,
        createdAt: '2026-09-20T00:00:00.000Z',
      }),
    },
    {
      taskId: 'task-1',
      kind: 'log',
      name: 'unit.log',
      contentType: 'text/plain',
      bytes: Buffer.from('0123456789'),
    }
  )
  expect(chunks).toHaveLength(3)
  expect(artifact.digest).toMatch(/^[0-9a-f]{64}$/)

  await expect(
    uploadEvidence(
      {
        start: async () => ({ uploadId: 'upload-2', chunkBytes: 4 }),
        chunk: async () => ({ nextIndex: 5 }),
        complete: async () => {
          throw new Error('should not complete')
        },
      },
      { taskId: 'task-1', kind: 'log', name: 'unit.log', contentType: 'text/plain', bytes: Buffer.from('0123456789') }
    )
  ).rejects.toThrow(/acknowledged chunk/)
})
