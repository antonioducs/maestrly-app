import { randomUUID } from 'node:crypto'
import {
  isAlerting,
  ROUTINE_LIMITS,
  type LocalRoutine,
  type LocalRoutineRun,
  type RoutineRunTrigger,
} from '../../shared/routines'
import type { ChatRoutineRunMeta, InternalTurnHandle, InternalTurnOutcome } from '../../shared/chat'
import type { StandaloneConversation } from '../../shared/conversation'
import { permissionScopeKey } from '../../shared/conversation-scope'
import { getChatMessage } from '../chat/chat-store'
import { deleteAllSavedPermissions } from '../chat/permission'
import { primeChatTurnSelection, setChatMode, startExecutorChatTurn } from '../chat/service'
import { holdAwake } from '../power-manager'
import { createRoutineRunConversation } from '../standalone-conversation-service'
import { getConversation, getConvUiPrefs, patchConvUiPrefs } from '../store'
import { deleteConversation } from '../workspace-service'
import { getMainWebContents } from '../window-ipc'
import { buildRoutinePrompt, formatRunConversationName } from './prompt'
import { keepRoutineRunFiles } from './run-files'
import {
  deleteRoutine,
  getRoutine,
  getRun,
  insertRun,
  latestReports,
  listActiveRuns,
  listRuns,
  updateRun,
} from './store'

export interface RoutineToastEvent {
  kind: 'started' | 'skipped-busy' | 'result'
  routine: LocalRoutine
  run: LocalRoutineRun
}

export interface RoutineRunnerDeps {
  now?: () => number
  createRunConversation?: (input: {
    routineId: string
    runId: string
    name: string
    folder: string
  }) => Promise<StandaloneConversation>
  configureRunConversation?: (conversationId: string, routine: LocalRoutine) => void
  startExecutorChatTurn?: (input: {
    conversationId: string
    prompt: string
    skipMemory?: boolean
    routineRun: ChatRoutineRunMeta
    signal: AbortSignal
  }) => Promise<InternalTurnHandle>
  getMainWebContents?: () => unknown | null
  holdAwake?: (key: string) => () => void
  onAlert?: (run: LocalRoutineRun, routine: LocalRoutine) => void
  onToast?: (event: RoutineToastEvent) => void
  assistantText?: (conversationId: string, messageId: string | null) => string | null
  waitWindowRetryMs?: number
  waitWindowTimeoutMs?: number
  waitSlotTimeoutMs?: number
}

export interface RoutineRunner {
  start(routineId: string, trigger: RoutineRunTrigger, scheduledAt: number): Promise<LocalRoutineRun>
  stop(runId: string): void
  isBusy(routineId: string): boolean
  handlesConversation(conversationId: string): boolean
  onConversationStatus(conversationId: string, status: string): void
  waitForRun(runId: string): Promise<LocalRoutineRun | null>
  dispose(): void
}

const FALLBACK_SUMMARY_MAX = 200

function defaultAssistantText(conversationId: string, messageId: string | null): string | null {
  if (!messageId) return null
  const message = getChatMessage(conversationId, messageId)
  if (message?.role !== 'assistant') return null
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
  return text ? text.slice(0, FALLBACK_SUMMARY_MAX) : null
}

function defaultConfigureRunConversation(conversationId: string, routine: LocalRoutine): void {
  const previous = getConvUiPrefs(conversationId).chat ?? {}
  patchConvUiPrefs(conversationId, {
    autoName: false,
    chat: {
      ...previous,
      mode: 'agent',
      permMode: routine.permMode,
    },
  })
  setChatMode(conversationId, 'agent')
  primeChatTurnSelection(conversationId, {
    providerId: routine.model.providerId,
    modelId: routine.model.modelId,
    reasoning: routine.model.reasoning,
    fastMode: routine.model.fastMode,
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface ActiveRunState {
  runId: string
  routineId: string
  conversationId: string | null
  controller: AbortController
  handle: InternalTurnHandle | null
  releaseAwake: (() => void) | null
  stopped: boolean
  done: Promise<LocalRoutineRun | null>
}

interface SlotWaiter {
  resolve: (acquired: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export function createRoutineRunner(deps: RoutineRunnerDeps = {}): RoutineRunner {
  const now = deps.now ?? (() => Date.now())
  const createRunConversation = deps.createRunConversation ?? createRoutineRunConversation
  const configureRunConversation = deps.configureRunConversation ?? defaultConfigureRunConversation
  const startTurn = deps.startExecutorChatTurn ?? startExecutorChatTurn
  const mainWebContents = deps.getMainWebContents ?? getMainWebContents
  const acquireAwake = deps.holdAwake ?? holdAwake
  const onAlert = deps.onAlert
  const onToast = deps.onToast
  const getAssistantText = deps.assistantText ?? defaultAssistantText
  const waitWindowRetryMs = deps.waitWindowRetryMs ?? 5_000
  const waitWindowTimeoutMs = deps.waitWindowTimeoutMs ?? 60_000
  const waitSlotTimeoutMs = deps.waitSlotTimeoutMs ?? 15 * 60_000

  const busyRoutines = new Set<string>()
  const activeByRun = new Map<string, ActiveRunState>()
  const activeByConv = new Map<string, ActiveRunState>()
  const slotWaiters: SlotWaiter[] = []
  let activeSlots = 0
  let disposed = false

  function acquireSlot(): Promise<boolean> {
    if (disposed) return Promise.resolve(false)
    if (activeSlots < ROUTINE_LIMITS.concurrentRuns && slotWaiters.length === 0) {
      activeSlots++
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      const waiter: SlotWaiter = {
        resolve,
        timer: setTimeout(() => {
          const index = slotWaiters.indexOf(waiter)
          if (index >= 0) slotWaiters.splice(index, 1)
          resolve(false)
        }, waitSlotTimeoutMs),
      }
      slotWaiters.push(waiter)
    })
  }

  function releaseSlot(): void {
    const next = slotWaiters.shift()
    if (next) {
      clearTimeout(next.timer)
      next.resolve(true)
      return
    }
    activeSlots = Math.max(0, activeSlots - 1)
  }

  async function waitForMainWindow(signal: AbortSignal): Promise<'ready' | 'timeout' | 'aborted'> {
    if (mainWebContents()) return 'ready'
    const deadline = Date.now() + waitWindowTimeoutMs
    while (!signal.aborted && !disposed) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return 'timeout'
      await sleep(Math.min(waitWindowRetryMs, remaining), signal)
      if (signal.aborted || disposed) return 'aborted'
      if (mainWebContents()) return 'ready'
    }
    return 'aborted'
  }

  function isBusy(routineId: string): boolean {
    if (busyRoutines.has(routineId)) return true
    return listActiveRuns().some((run) => run.routineId === routineId)
  }

  function handlesConversation(conversationId: string): boolean {
    return activeByConv.has(conversationId)
  }

  function cleanupRun(state: ActiveRunState): void {
    state.releaseAwake?.()
    state.releaseAwake = null
    activeByRun.delete(state.runId)
    if (state.conversationId) activeByConv.delete(state.conversationId)
    busyRoutines.delete(state.routineId)
    releaseSlot()
  }

  function settleRun(
    state: ActiveRunState,
    routineSnapshot: LocalRoutine,
    outcome: InternalTurnOutcome | { status: 'skipped_closed' } | { status: 'error'; error: string }
  ): LocalRoutineRun | null {
    const routine = getRoutine(state.routineId) ?? routineSnapshot
    const finishedAt = now()
    let settled: LocalRoutineRun | null

    if (outcome.status === 'skipped_closed') {
      settled = updateRun(state.runId, {
        status: 'skipped_closed',
        finishedAt,
        unread: false,
      })
    } else if (state.stopped || outcome.status === 'cancelled') {
      settled = updateRun(state.runId, {
        status: 'stopped',
        finishedAt,
        unread: false,
      })
    } else if (outcome.status === 'error') {
      settled = updateRun(state.runId, {
        status: 'failed',
        error: outcome.error,
        finishedAt,
        unread: true,
      })
    } else {
      const latest = getRun(state.runId)
      const report = latest?.report ?? null
      const status = report ? report.outcome : 'done'
      const summary =
        report?.summary ??
        (state.conversationId
          ? getAssistantText(state.conversationId, outcome.assistantMessageId)?.slice(0, FALLBACK_SUMMARY_MAX) ?? null
          : null)
      const unread = isAlerting({ status }, routine.notify)
      settled = updateRun(state.runId, {
        status,
        summary,
        finishedAt,
        unread,
      })
    }

    cleanupRun(state)

    if (settled && isAlerting(settled, routine.notify)) {
      onAlert?.(settled, routine)
      onToast?.({ kind: 'result', routine, run: settled })
    }
    return settled
  }

  async function start(
    routineId: string,
    trigger: RoutineRunTrigger,
    scheduledAt: number
  ): Promise<LocalRoutineRun> {
    const routine = getRoutine(routineId)
    if (!routine) throw new Error('Routine not found.')

    if (isBusy(routineId)) {
      const skipped = insertRun({
        routineId,
        scheduledAt,
        startedAt: null,
        finishedAt: now(),
        trigger,
        status: 'skipped_busy',
        summary: null,
        report: null,
        error: null,
        conversationId: null,
        conversationDeleted: false,
        pinned: false,
        unread: false,
      })
      if (trigger === 'manual') onToast?.({ kind: 'skipped-busy', routine, run: skipped })
      return skipped
    }

    busyRoutines.add(routineId)
    const gotSlot = await acquireSlot()
    if (!gotSlot || disposed) {
      busyRoutines.delete(routineId)
      const skipped = insertRun({
        routineId,
        scheduledAt,
        startedAt: null,
        finishedAt: now(),
        trigger,
        status: 'skipped_busy',
        summary: null,
        report: null,
        error: null,
        conversationId: null,
        conversationDeleted: false,
        pinned: false,
        unread: false,
      })
      if (trigger === 'manual') onToast?.({ kind: 'skipped-busy', routine, run: skipped })
      return skipped
    }

    const runId = randomUUID()
    const startedAt = now()
    const controller = new AbortController()
    const state: ActiveRunState = {
      runId,
      routineId,
      conversationId: null,
      controller,
      handle: null,
      releaseAwake: null,
      stopped: false,
      done: Promise.resolve(null),
    }

    let run: LocalRoutineRun | null = null
    try {
      const conv = await createRunConversation({
        routineId,
        runId,
        name: formatRunConversationName(routine.title, startedAt),
        folder: routine.folder,
      })
      state.conversationId = conv.id
      configureRunConversation(conv.id, routine)

      run = insertRun({
        id: runId,
        routineId,
        scheduledAt,
        startedAt,
        finishedAt: null,
        trigger,
        status: 'running',
        summary: null,
        report: null,
        error: null,
        conversationId: conv.id,
        conversationDeleted: false,
        pinned: false,
        unread: false,
      })
      const createdRun = run

      state.releaseAwake = acquireAwake(`routine-run:${runId}`)
      activeByRun.set(runId, state)
      activeByConv.set(conv.id, state)

      const previousReports = latestReports(routineId, ROUTINE_LIMITS.previousReports)
      const prompt = buildRoutinePrompt({
        routine,
        trigger,
        scheduledAt,
        previousReports,
      })
      const routineRun: ChatRoutineRunMeta = {
        routineId,
        runId,
        title: routine.title,
        instruction: routine.instruction,
        schedule: routine.schedule,
        trigger,
        scheduledAt,
        startedAt,
        hasPreviousReport: previousReports.length > 0,
      }

      const launchAndTrack = async (): Promise<LocalRoutineRun | null> => {
        try {
          if (!state.handle) {
            const winState = await waitForMainWindow(controller.signal)
            if (winState === 'timeout') return settleRun(state, routine, { status: 'skipped_closed' })
            if (winState === 'aborted' || state.stopped) {
              return settleRun(state, routine, { status: 'cancelled', assistantMessageId: null })
            }
            state.handle = await startTurn({
              conversationId: conv.id,
              prompt,
              skipMemory: true,
              routineRun,
              signal: controller.signal,
            })
            if (state.stopped) {
              state.handle.cancel()
            } else if (trigger === 'manual') {
              onToast?.({ kind: 'started', routine, run: createdRun })
            }
          }
          const outcome = await state.handle.done
          return settleRun(state, routine, outcome)
        } catch (err) {
          if (state.stopped || controller.signal.aborted) {
            return settleRun(state, routine, { status: 'cancelled', assistantMessageId: null })
          }
          return settleRun(state, routine, {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Start synchronously when the window is already ready so callers see the active turn immediately.
      if (mainWebContents()) {
        state.handle = await startTurn({
          conversationId: conv.id,
          prompt,
          skipMemory: true,
          routineRun,
          signal: controller.signal,
        })
        if (state.stopped) {
          state.handle.cancel()
        } else if (trigger === 'manual') {
          onToast?.({ kind: 'started', routine, run: createdRun })
        }
      }

      state.done = launchAndTrack()
      return createdRun
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (run) {
        const settled = settleRun(
          state,
          routine,
          state.stopped || controller.signal.aborted
            ? { status: 'cancelled', assistantMessageId: null }
            : { status: 'error', error }
        )
        state.done = Promise.resolve(settled)
        return settled ?? run
      }
      cleanupRun(state)
      const failedRun = insertRun({
        id: runId,
        routineId,
        scheduledAt,
        startedAt,
        finishedAt: now(),
        trigger,
        status: 'failed',
        summary: null,
        report: null,
        error,
        conversationId: state.conversationId,
        conversationDeleted: false,
        pinned: false,
        unread: true,
      })
      const currentRoutine = getRoutine(routineId) ?? routine
      onAlert?.(failedRun, currentRoutine)
      onToast?.({ kind: 'result', routine: currentRoutine, run: failedRun })
      return failedRun
    }
  }

  function stop(runId: string): void {
    const state = activeByRun.get(runId)
    if (!state) return
    state.stopped = true
    state.controller.abort()
    state.handle?.cancel()
  }

  function onConversationStatus(conversationId: string, status: string): void {
    const state = activeByConv.get(conversationId)
    if (!state) return
    const run = getRun(state.runId)
    if (!run || (run.status !== 'running' && run.status !== 'waiting')) return

    if (status === 'waiting') {
      state.releaseAwake?.()
      state.releaseAwake = null
      if (run.status !== 'waiting') {
        const updated = updateRun(state.runId, { status: 'waiting', unread: true })
        const routine = getRoutine(state.routineId)
        if (updated && routine) {
          onAlert?.(updated, routine)
          onToast?.({ kind: 'result', routine, run: updated })
        }
      }
      return
    }

    if (status === 'working' && run.status === 'waiting') {
      if (!state.releaseAwake) state.releaseAwake = acquireAwake(`routine-run:${state.runId}`)
      updateRun(state.runId, { status: 'running' })
    }
  }

  async function waitForRun(runId: string): Promise<LocalRoutineRun | null> {
    const state = activeByRun.get(runId)
    if (state) return state.done
    return getRun(runId)
  }

  function dispose(): void {
    disposed = true
    for (const waiter of slotWaiters.splice(0, slotWaiters.length)) {
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    for (const state of activeByRun.values()) {
      state.stopped = true
      state.controller.abort()
      state.handle?.cancel()
      state.releaseAwake?.()
      state.releaseAwake = null
    }
  }

  return {
    start,
    stop,
    isBusy,
    handlesConversation,
    onConversationStatus,
    waitForRun,
    dispose,
  }
}

export async function deleteRoutineRunConversation(runId: string): Promise<boolean> {
  const run = getRun(runId)
  if (!run) return false
  if (run.status === 'running' || run.status === 'waiting') {
    throw new Error('The routine run is working; stop it first.')
  }
  const routine = getRoutine(run.routineId)
  if (run.conversationId && getConversation(run.conversationId)) {
    if (routine) await keepRoutineRunFiles(routine, run)
    await deleteConversation(run.conversationId)
  }
  updateRun(run.id, { conversationDeleted: true })
  return true
}

export async function deleteRoutineWithData(routineId: string, runner?: RoutineRunner): Promise<boolean> {
  const routine = getRoutine(routineId)
  if (!routine) return false

  for (const run of listActiveRuns()) {
    if (run.routineId !== routineId) continue
    runner?.stop(run.id)
    if (runner) await runner.waitForRun(run.id)
  }

  let cursor: number | undefined
  for (;;) {
    const page = listRuns({ routineId, filter: 'all', limit: 200, before: cursor })
    for (const run of page.runs) {
      if (run.conversationId && !run.conversationDeleted && getConversation(run.conversationId)) {
        await keepRoutineRunFiles(routine, run)
        await deleteConversation(run.conversationId)
      }
    }
    if (!page.hasMore || page.runs.length === 0) break
    cursor = page.runs[page.runs.length - 1].scheduledAt
  }

  deleteAllSavedPermissions(permissionScopeKey({ kind: 'routine', id: routineId }))
  return deleteRoutine(routineId)
}
