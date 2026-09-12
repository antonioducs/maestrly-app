import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LeaseController,
  RunnerEngine,
  RunnerJournal,
  type WorkspaceManager,
  type ExecutionContext,
  type ExecutorAdapter,
  type RunnerServer,
} from '../src/index.js'

const temporary: string[] = []
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  vi.useRealTimers()
})

async function temp() {
  const { mkdtemp } = await import('node:fs/promises')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'maestrly-runner-test-'))
  temporary.push(directory)
  return directory
}

const envelope = {
  protocolVersion: '1.0', organizationId: 'org', projectId: 'project', boardId: 'board', cardId: 'card', jobId: 'job', runId: 'run',
  attempt: 1, leaseId: 'lease', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), sourceEventId: 'event', cardVersion: 1,
  policyVersion: 1, executionProfileId: 'profile', snapshot: {
    title: 'Task', description: 'Do it', acceptanceCriteria: ['Pass'], taskType: 'code', provider: 'deterministic' as const,
    model: 'fixture', repositoryBindingId: null, delivery: { mode: 'patch' as const, requireHumanApproval: true },
  },
}

describe('RunnerEngine', () => {
  it('waits for executor finalization before releasing the run and workspace', async () => {
    const directory = await temp()
    let finish!: () => void
    let cleaned = false
    const executor: ExecutorAdapter = {
      capabilities: async () => ({ executor: 'deterministic', capabilities: [] }),
      start: async (_context: ExecutionContext) => ({
        done: new Promise((resolve) => { finish = () => resolve({ state: 'succeeded', summary: 'done', artifacts: [{ kind: 'patch', name: 'changes.patch', contentType: 'text/x-diff', bytes: new Uint8Array([1, 2, 3]) }] }) }),
        cancel: async () => undefined,
      }),
    }
    let claimCount = 0
    const server: RunnerServer = {
      claim: async () => claimCount++ === 0 ? { envelope, executionToken: 'token' } : null,
      renew: async () => ({ leaseExpiresAt: envelope.leaseExpiresAt, cancellationRequested: false }),
      event: async () => undefined,
      complete: vi.fn(async () => undefined),
      uploadArtifact: vi.fn(async () => ({ kind: 'patch', name: 'changes.patch', contentType: 'text/x-diff', sizeBytes: 3, digest: 'abc', storageKey: 'runs/run/abc/changes.patch' })),
      reconcile: async () => 'terminal',
    }
    const workspace = {
      prepare: async () => ({ workspacePath: directory, isolated: true, environment: {}, cleanup: async () => { cleaned = true } }),
    } as unknown as WorkspaceManager
    const engine = new RunnerEngine(server, new Map([['deterministic', executor]]), workspace, new RunnerJournal(path.join(directory, 'journal.json')))
    const running = engine.runOnce()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(cleaned).toBe(false)
    finish()
    await running
    expect(cleaned).toBe(true)
    expect(server.complete).toHaveBeenCalledWith('run', 'lease', expect.objectContaining({ state: 'succeeded' }))
    expect(server.uploadArtifact).toHaveBeenCalledOnce()
  })

  it('reconciles journaled attempts before accepting new work', async () => {
    const directory = await temp()
    const journal = new RunnerJournal(path.join(directory, 'journal.json'))
    await journal.update((current) => {
      current.runs.push({ runId: 'old', jobId: 'job', leaseId: 'lease', state: 'running', unacknowledgedEvents: [], updatedAt: new Date().toISOString() })
    })
    const server = { reconcile: vi.fn(async () => 'terminal' as const) } as unknown as RunnerServer
    const engine = new RunnerEngine(server, new Map(), {} as WorkspaceManager, journal)
    await engine.recover()
    expect(server.reconcile).toHaveBeenCalledWith(expect.objectContaining({ runId: 'old' }))
    expect((await journal.read()).runs).toEqual([])
  })
})

describe('RunnerJournal', () => {
  it('ignores a partially written temporary file and retains the last atomic state', async () => {
    const directory = await temp()
    const file = path.join(directory, 'journal.json')
    const journal = new RunnerJournal(file)
    await journal.update((current) => { current.runs = [] })
    await writeFile(`${file}.tmp`, '{partial', 'utf8')
    expect(await journal.read()).toEqual({ version: 1, runs: [] })
    expect(await readFile(`${file}.tmp`, 'utf8')).toBe('{partial')
  })
})

describe('LeaseController', () => {
  it('cancels before the safe authorization margin after renewal failures', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(async () => undefined)
    const lease = new LeaseController(
      new Date(Date.now() + 50).toISOString(),
      async () => { throw new Error('offline') }, cancel,
      { renewalIntervalMs: 20, safetyMarginMs: 40 },
    )
    lease.start()
    await vi.advanceTimersByTimeAsync(25)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
