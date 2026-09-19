import type { RunResult, SDKMessage } from '@cursor/sdk'

export const CURSOR_RUN_WATCHDOG_TIMEOUT_MS = 45 * 60_000

export const CURSOR_RUN_CANCEL_GRACE_MS = 30_000
export const CURSOR_RUN_DEADLINE_MS = 4 * 60 * 60_000

export type CursorRunStallPhase = 'stream' | 'wait'

export interface CursorRunWatchdogOptions {
  stream?: () => AsyncGenerator<SDKMessage, void>

  wait?: () => Promise<RunResult>
  cancel: () => Promise<void>
  onMessage: (message: SDKMessage) => void
  signal: AbortSignal

  timeoutMs?: number
  /** Active wall time across the complete stream and wait, even with continuous output. */
  deadlineMs?: number
  /** Only a pending host permission or question suspends these budgets. */
  isHostPending?: () => boolean

  graceMs?: number
}

export interface CursorRunWatchdogOutcome {
  waitResult: RunResult | undefined

  stalled: CursorRunStallPhase | null

  cancelInvoked: boolean

  aborted: boolean

  abortGraceExpired: CursorRunStallPhase | null
  timeoutKind: 'inactivity' | 'deadline' | null
}

type RaceSettled<T> = { timedOut: true } | { timedOut: false; value: T }

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<RaceSettled<T>> {
  let timer: NodeJS.Timeout | undefined
  const wrapped = promise.then((value) => ({ timedOut: false as const, value }))
  void wrapped.catch(() => undefined)
  const deadline = new Promise<RaceSettled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms)
    timer.unref()
  })
  return Promise.race([wrapped, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

type RaceWithAbortSettled<T> = { kind: 'operation'; value: T } | { kind: 'timeout' } | { kind: 'abort' }

function raceTimeoutWithAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortSignal: Promise<void>,
  budget?: { remaining: () => number; paused: () => boolean; expired: (kind: 'inactivity' | 'deadline') => void }
): Promise<RaceWithAbortSettled<T>> {
  let timer: NodeJS.Timeout | undefined
  const wrapped = promise.then((value) => ({ kind: 'operation' as const, value }))
  void wrapped.catch(() => undefined)
  const deadline = new Promise<RaceWithAbortSettled<T>>((resolve) => {
    let remaining = timeoutMs
    let previous = Date.now()
    let wasPaused = budget?.paused() ?? false
    const tick = (): void => {
      const now = Date.now()
      const paused = budget?.paused() ?? false
      if (!wasPaused && !paused) remaining -= now - previous
      previous = now
      wasPaused = paused
      const absolute = budget?.remaining() ?? Infinity
      if (!paused && (remaining <= 0 || absolute <= 0)) {
        budget?.expired(absolute <= 0 ? 'deadline' : 'inactivity')
        resolve({ kind: 'timeout' })
        return
      }
      timer = setTimeout(tick, paused ? 100 : Math.max(1, Math.min(100, remaining, absolute)))
      timer.unref()
    }
    tick()
  })
  const abort = abortSignal.then(() => ({ kind: 'abort' as const }))
  return Promise.race([wrapped, deadline, abort]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function settleOrAbandon<T>(promise: Promise<T>, graceMs: number, drain: (value: T) => void): Promise<boolean> {
  const grace = await raceTimeout(promise, graceMs)
  if (grace.timedOut) {
    void promise.catch(() => undefined)
    return false
  }
  drain(grace.value)
  return true
}

export async function runCursorRunWithWatchdog(options: CursorRunWatchdogOptions): Promise<CursorRunWatchdogOutcome> {
  const timeoutMs = options.timeoutMs ?? CURSOR_RUN_WATCHDOG_TIMEOUT_MS
  const graceMs = options.graceMs ?? CURSOR_RUN_CANCEL_GRACE_MS
  let timeoutKind: CursorRunWatchdogOutcome['timeoutKind'] = null
  let activeTime = 0
  let previous = Date.now()
  let wasPaused = options.isHostPending?.() ?? false
  const budget = {
    paused: () => options.isHostPending?.() ?? false,
    remaining: () => {
      const now = Date.now()
      const paused = options.isHostPending?.() ?? false
      if (!paused && !wasPaused) activeTime += now - previous
      previous = now
      wasPaused = paused
      return (options.deadlineMs ?? CURSOR_RUN_DEADLINE_MS) - activeTime
    },
    expired: (kind: 'inactivity' | 'deadline') => {
      timeoutKind = kind
    },
  }

  let cancelInvoked = false
  const invokeCancel = (): void => {
    if (cancelInvoked) return
    cancelInvoked = true
    void options.cancel().catch(() => undefined)
  }

  let aborted = false
  let listenerAdded = false
  let resolveAbort!: () => void
  const abortSignal = new Promise<void>((resolve) => {
    resolveAbort = resolve
  })
  const onAbort = (): void => {
    aborted = true
    invokeCancel()
    resolveAbort()
  }
  if (options.signal.aborted) {
    onAbort()
  } else {
    options.signal.addEventListener('abort', onAbort, { once: true })
    listenerAdded = true
  }

  let stalled: CursorRunStallPhase | null = null
  let abortGraceExpired: CursorRunStallPhase | null = null
  try {
    let streamDone = !options.stream
    if (options.stream) {
      const iterator = options.stream()[Symbol.asyncIterator]()
      for (;;) {
        const nextPromise = iterator.next()
        const settled = await raceTimeoutWithAbort(nextPromise, timeoutMs, abortSignal, budget)
        if (settled.kind === 'abort') {
          const drained = await settleOrAbandon(nextPromise, graceMs, (result) => {
            if (!result.done) options.onMessage(result.value)
          })
          if (!drained) abortGraceExpired = 'stream'
          void iterator.return?.().catch(() => undefined)
          break
        }
        if (settled.kind === 'timeout') {
          stalled = 'stream'
          invokeCancel()

          await settleOrAbandon(nextPromise, graceMs, (result) => {
            if (!result.done) options.onMessage(result.value)
          })
          void iterator.return?.().catch(() => undefined)
          break
        }
        if (settled.value.done) {
          streamDone = true
          break
        }
        options.onMessage(settled.value.value)
      }
    }

    let waitResult: RunResult | undefined
    if (options.wait && streamDone && !stalled) {
      const waitPromise = options.wait()
      const settled = await raceTimeoutWithAbort(waitPromise, timeoutMs, abortSignal, budget)
      if (settled.kind === 'abort') {
        const drained = await settleOrAbandon(waitPromise, graceMs, (value) => {
          waitResult = value
        })
        if (!drained) abortGraceExpired = 'wait'
      } else if (settled.kind === 'timeout') {
        stalled = 'wait'
        invokeCancel()
        await settleOrAbandon(waitPromise, graceMs, (value) => {
          waitResult = value
        })
      } else {
        waitResult = settled.value
      }
    }

    return { waitResult, stalled, cancelInvoked, aborted, abortGraceExpired, timeoutKind }
  } finally {
    if (listenerAdded) options.signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Startup/send have no run handle to cancel yet. The caller transfers ownership on abandonment;
 * late completion must close that handle before releasing its store lease, including rejection.
 */
export async function awaitCursorOperation<T>(
  operation: Promise<T>,
  options: {
    signal: AbortSignal
    timeoutMs?: number
    isHostPending?: () => boolean
    onAbandon?: () => void
    onLateSettled: (value: T | undefined) => Promise<void>
  }
): Promise<T> {
  let resolveAbort!: () => void
  const abort = new Promise<void>((resolve) => {
    resolveAbort = resolve
  })
  const onAbort = (): void => resolveAbort()
  options.signal.addEventListener('abort', onAbort, { once: true })
  if (options.signal.aborted) onAbort()
  try {
    const result = await raceTimeoutWithAbort(operation, options.timeoutMs ?? CURSOR_RUN_WATCHDOG_TIMEOUT_MS, abort, {
      remaining: () => Infinity,
      paused: () => options.isHostPending?.() ?? false,
      expired: () => undefined,
    })
    if (result.kind === 'operation' && !options.signal.aborted) return result.value
    options.onAbandon?.()
    void operation
      .then(
        (value) => options.onLateSettled(value),
        () => options.onLateSettled(undefined)
      )
      .catch(() => undefined)
    throw options.signal.aborted
      ? (options.signal.reason ?? new Error('Cursor operation aborted'))
      : new Error('Cursor operation deadline exceeded')
  } finally {
    options.signal.removeEventListener('abort', onAbort)
  }
}

/** Closing the SDK handle stops access to its store; a failed close must retain that lease. */
export async function closeCursorLease(lease: {
  agent: { close(): void }
  release(): void | Promise<void>
}): Promise<void> {
  lease.agent.close()
  await lease.release()
}

export async function cancelLateCursorRun(
  run: { cancel(): Promise<void> } | undefined,
  graceMs?: number
): Promise<void> {
  if (run)
    await raceTimeout(
      Promise.resolve()
        .then(() => run.cancel())
        .catch(() => undefined),
      graceMs ?? CURSOR_RUN_CANCEL_GRACE_MS
    )
}
