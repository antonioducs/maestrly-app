import type { ExecutionEnvelope } from '@maestrly/protocol'
import type { DeliveryArtifact } from './delivery.js'
import type {
  ExecutionContext,
  ExecutionHandle,
  ExecutionOutcome,
  ExecutorAdapter,
  PreparedEnvironment,
} from './executor.js'
import type { RunnerJournal } from './journal.js'
import { LeaseController } from './lease.js'
import { repositoryEvidence, type WorkspaceManager } from './workspace.js'
import { startOrchestration } from './orchestration.js'
import type { CommandRunner } from './sandbox/commands.js'

export interface RunnerClaim {
  envelope: ExecutionEnvelope
  executionToken: string
}
export interface RunnerServer {
  claim(): Promise<RunnerClaim | null>
  renew(runId: string, leaseId: string): Promise<{ leaseExpiresAt: string; cancellationRequested: boolean }>
  event(
    runId: string,
    leaseId: string,
    event: { eventId: string; type: string; data: Record<string, unknown> }
  ): Promise<void>
  complete(runId: string, leaseId: string, completion: Record<string, unknown>): Promise<void>
  reconcile(run: { runId: string; leaseId: string }): Promise<'active' | 'terminal' | 'unknown'>
  uploadArtifact(
    runId: string,
    leaseId: string,
    artifact: import('./executor.js').ExecutionArtifact
  ): Promise<DeliveryArtifact>
}
export class RunnerEngine {
  private stopped = false
  // Runs execute concurrently without a local cap; the server decides how many jobs it hands out.
  private readonly active = new Map<string, { cancel(reason: string): Promise<void> }>()
  private readonly background = new Set<Promise<void>>()
  constructor(
    private readonly server: RunnerServer,
    private readonly executors: Map<string, ExecutorAdapter>,
    private readonly workspace: WorkspaceManager,
    private readonly journal: RunnerJournal,
    private readonly options: { commandRunner?: CommandRunner } = {}
  ) {}
  async recover() {
    for (const run of (await this.journal.read()).runs) {
      const state = await this.server.reconcile(run)
      if (state !== 'active')
        await this.journal.update((current) => {
          current.runs = current.runs.filter((entry) => entry.runId !== run.runId)
        })
    }
  }
  /** Number of runs currently executing on this engine. */
  get activeRuns(): number {
    return this.active.size
  }
  /** Claims one job and executes it to completion. Resolves with `true` when a job was processed. */
  async runOnce(): Promise<boolean> {
    if (this.stopped) return false
    const claim = await this.server.claim()
    if (!claim) return false
    await this.execute(claim)
    return true
  }
  /**
   * Claims one job and executes it in the background so the caller can immediately claim the next one.
   * Resolves with `true` when a job was claimed. Execution failures are reported through `onError`.
   */
  async poll(onError?: (error: unknown) => void): Promise<boolean> {
    if (this.stopped) return false
    const claim = await this.server.claim()
    if (!claim) return false
    const pending: Promise<void> = this.execute(claim)
      .catch((error) => onError?.(error))
      .finally(() => this.background.delete(pending))
    this.background.add(pending)
    return true
  }
  private async execute(claim: RunnerClaim): Promise<void> {
    const envelope = claim.envelope
    const adapter = this.executors.get(envelope.snapshot.provider)
    if (!adapter) {
      await this.server.complete(envelope.runId, envelope.leaseId, {
        state: 'failed',
        failure: 'Executor unavailable.',
        artifacts: [],
      })
      return
    }
    let handle: ExecutionHandle | undefined, environment: PreparedEnvironment | undefined, cancelled: string | undefined
    let logBytes = 0,
      truncated = false,
      events = Promise.resolve()
    const maxLogBytes = envelope.snapshot.maxLogBytes ?? 10485760
    const emit = (event: { type: string; data: Record<string, unknown> }): Promise<void> => {
      const bytes = Buffer.byteLength(JSON.stringify(event))
      if (logBytes + bytes > maxLogBytes) {
        if (truncated) return Promise.resolve()
        truncated = true
        event = { type: 'run.logs_truncated', data: { limit: maxLogBytes } }
      } else logBytes += bytes
      events = events.then(async () => {
        const eventId = crypto.randomUUID()
        await this.journal.update((current) => {
          const run = current.runs.find((r) => r.runId === envelope.runId)
          if (run) run.unacknowledgedEvents.push({ id: eventId, ...event })
        })
        await this.server.event(envelope.runId, envelope.leaseId, { eventId, ...event })
        await this.journal.update((current) => {
          const run = current.runs.find((r) => r.runId === envelope.runId)
          if (run) run.unacknowledgedEvents = run.unacknowledgedEvents.filter((e) => e.id !== eventId)
        })
      })
      // Expose transport errors to awaited emit calls; keep later events deliverable.
      const pending = events
      events = events.catch(() => undefined)
      return pending
    }
    const abort = new AbortController()
    const cancel = async (reason: string) => {
      cancelled ??= reason
      abort.abort(reason)
      await handle?.cancel(reason)
    }
    this.active.set(envelope.runId, { cancel })
    if (this.stopped) void cancel('Runner is stopping.')
    const lease = new LeaseController(
      envelope.leaseExpiresAt,
      () => this.server.renew(envelope.runId, envelope.leaseId),
      cancel
    )
    lease.start()
    const timer = setTimeout(
      () => void cancel('Execution timeout exceeded.'),
      (envelope.snapshot.maxDurationSeconds ?? 3600) * 1000
    )
    timer.unref?.()
    try {
      environment = await this.workspace.prepare(envelope)
      await this.journal.update((current) => {
        current.runs.push({
          runId: envelope.runId,
          jobId: envelope.jobId,
          leaseId: envelope.leaseId,
          state: 'claimed',
          workspacePath: environment!.workspacePath,
          unacknowledgedEvents: [],
          updatedAt: new Date().toISOString(),
        })
      })
      const context: ExecutionContext = { envelope, environment, emit, signal: abort.signal }
      for (const [index, command] of (envelope.snapshot.automation?.preCommands ?? []).entries()) {
        if (cancelled) break
        const runner = this.options.commandRunner
        if (!runner || !(await runner.available()))
          throw new Error('An isolated command sandbox is required for pre-commands.')
        await emit({ type: 'pre_command.started', data: { index, command } })
        handle = await runner.start(context, command)
        if (cancelled) await handle.cancel(cancelled)
        const result = await handle.done
        await emit({ type: 'pre_command.finished', data: { index, state: result.state } })
        if (result.state !== 'succeeded') throw new Error(result.failure ?? 'Pre-command cancelled.')
      }
      let outcome: ExecutionOutcome
      if (cancelled) outcome = { state: 'cancelled', failure: cancelled }
      else {
        handle = await (adapter.managesOrchestration?adapter.start(context):startOrchestration(adapter, context))
        if (cancelled) await handle.cancel(cancelled)
        outcome = await handle.done
      }
      if (cancelled)
        outcome = {
          ...outcome,
          state: cancelled === 'Execution timeout exceeded.' ? 'failed' : 'cancelled',
          failure: cancelled,
        }
      if (environment.gitBaseCommit)
        outcome.artifacts = [...(outcome.artifacts ?? []), ...(await repositoryEvidence(environment))]
      await emit({
        type: 'run.execution_limits',
        data: { logBytes, logsTruncated: truncated, timeoutSeconds: envelope.snapshot.maxDurationSeconds ?? 3600 },
      })
      await events
      await this.finish(envelope, outcome)
    } catch (error) {
      await events
      await this.finish(envelope, {
        state: cancelled && cancelled !== 'Execution timeout exceeded.' ? 'cancelled' : 'failed',
        failure: cancelled ?? (error instanceof Error ? error.message : String(error)),
      })
    } finally {
      clearTimeout(timer)
      lease.stop()
      this.active.delete(envelope.runId)
      await environment?.cleanup()
      await this.journal.update((current) => {
        current.runs = current.runs.filter((entry) => entry.runId !== envelope.runId)
      })
    }
  }
  async stop(reason = 'Runner is stopping.') {
    this.stopped = true
    await Promise.all([...this.active.values()].map((run) => run.cancel(reason)))
    await Promise.allSettled([...this.background])
  }
  private async finish(envelope: ExecutionEnvelope, outcome: ExecutionOutcome) {
    const artifacts: DeliveryArtifact[] = []
    for (const artifact of outcome.artifacts ?? [])
      artifacts.push(
        await retryLostResponse(() => this.server.uploadArtifact(envelope.runId, envelope.leaseId, artifact))
      )
    await retryLostResponse(() => this.server.complete(envelope.runId, envelope.leaseId, { ...outcome, artifacts }))
  }
}
async function retryLostResponse<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (first) {
    try {
      return await operation()
    } catch {
      throw first
    }
  }
}
