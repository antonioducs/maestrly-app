/**
 * Pull request watching from the executor.
 *
 * This is the default follow-up path: no inbound webhook and no GitHub token on the server. The executor reads
 * the pull request with its own local `gh` login at the interval the subscription asked for, reports what it
 * observed, and backs off when GitHub asks it to.
 */
import type { PullRequestObservation } from './delegation-github'

export interface PullRequestWatchTarget {
  taskId: string
  projectId: string
  subscriptionId: string
  intervalSeconds: number
}

export interface PullRequestWatchDeps {
  /** Tasks whose refresh is due, resolved by the server. */
  due(): Promise<PullRequestWatchTarget[]>
  /** Directory of the task workspace on this computer; null when it is not bound here. */
  workspaceFor(taskId: string): Promise<string | null>
  read(input: { cwd: string; branch: string }): Promise<PullRequestObservation | null>
  branchFor(taskId: string): string
  report(taskId: string, observation: PullRequestObservation): Promise<void>
  polled(input: { subscriptionId: string; intervalSeconds: number }): Promise<void>
  now?: () => number
}

export interface WatchOutcome {
  taskId: string
  state: 'observed' | 'not-linked' | 'no-workspace' | 'rate-limited' | 'failed'
  detail?: string
  retryAfterSeconds?: number
}

/** Seconds to wait when GitHub reports a rate limit, read from the error and never guessed below the hint. */
export function retryAfterSeconds(error: unknown, fallback: number): number {
  const message = error instanceof Error ? error.message : String(error)
  const explicit = /retry[- ]after[^0-9]{0,5}(\d{1,5})/i.exec(message)
  if (explicit) return Math.max(fallback, Number(explicit[1]))
  const reset = /rate limit[\s\S]{0,80}?(\d{2,5})\s*second/i.exec(message)
  if (reset) return Math.max(fallback, Number(reset[1]))
  return /rate limit|secondary rate/i.test(message) ? Math.max(fallback, 120) : fallback
}

/**
 * Run one watch pass. Every target is settled: an unlinked pull request or a missing workspace is reported as
 * such instead of being retried forever in silence.
 */
export async function runPullRequestWatch(deps: PullRequestWatchDeps): Promise<WatchOutcome[]> {
  const outcomes: WatchOutcome[] = []
  for (const target of await deps.due()) {
    const cwd = await deps.workspaceFor(target.taskId)
    if (!cwd) {
      await deps.polled({ subscriptionId: target.subscriptionId, intervalSeconds: target.intervalSeconds })
      outcomes.push({
        taskId: target.taskId,
        state: 'no-workspace',
        detail: 'This task is not bound to a workspace on this computer.',
      })
      continue
    }
    try {
      const observation = await deps.read({ cwd, branch: deps.branchFor(target.taskId) })
      if (!observation) {
        await deps.polled({ subscriptionId: target.subscriptionId, intervalSeconds: target.intervalSeconds })
        outcomes.push({ taskId: target.taskId, state: 'not-linked', detail: 'No pull request exists for this branch.' })
        continue
      }
      await deps.report(target.taskId, observation)
      await deps.polled({ subscriptionId: target.subscriptionId, intervalSeconds: target.intervalSeconds })
      outcomes.push({ taskId: target.taskId, state: 'observed' })
    } catch (error) {
      const wait = retryAfterSeconds(error, target.intervalSeconds)
      await deps.polled({ subscriptionId: target.subscriptionId, intervalSeconds: wait })
      const limited = wait > target.intervalSeconds
      outcomes.push({
        taskId: target.taskId,
        state: limited ? 'rate-limited' : 'failed',
        detail: (error as Error).message.slice(0, 500),
        retryAfterSeconds: wait,
      })
    }
  }
  return outcomes
}
