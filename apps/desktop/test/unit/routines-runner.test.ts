import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import {
  conversationPermissionScope,
  permissionScopeKey,
} from '../../src/shared/conversation-scope'
import { ROUTINE_LIMITS, type LocalRoutine, type RoutineDraft } from '../../src/shared/routines'
import type { InternalTurnHandle, InternalTurnOutcome } from '../../src/shared/chat'
import type { StandaloneConversation } from '../../src/shared/conversation'
import { getDb, getConversation, insertConversation } from '../../src/main/store'
import {
  deleteAllSavedPermissions,
  deleteSavedPermission,
  listSavedPermissions,
} from '../../src/main/chat/permission'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { createRoutine, getRun, insertRun, updateRun } from '../../src/main/routines/store'
import { buildRoutinePrompt } from '../../src/main/routines/prompt'
import { createRoutineRunner, type RoutineRunnerDeps } from '../../src/main/routines/runner'
import { keepRoutineRunFiles } from '../../src/main/routines/run-files'

beforeEach(freshDb)
afterEach(closeDb)

function sampleDraft(overrides: Partial<RoutineDraft> = {}): RoutineDraft {
  return {
    title: 'Daily digest',
    instruction: 'Summarize open PRs.',
    schedule: { kind: 'weekly', time: '09:00', days: [], timezone: 'UTC' },
    permMode: 'auto',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', reasoning: 'medium', fastMode: false },
    notify: 'notable',
    missed: 'catchup',
    retentionDays: 30,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeDeps(overrides: Partial<RoutineRunnerDeps> = {}) {
  let currentNow = Date.UTC(2026, 10, 18, 9, 0)
  const awakeKeys = new Set<string>()
  const alerts: Array<{ runId: string; status: string }> = []
  const toasts: Array<{ kind: string; runId: string }> = []
  const startedTurns: Array<{
    conversationId: string
    prompt: string
    signal: AbortSignal
    done: ReturnType<typeof deferred<InternalTurnOutcome>>
    assistantMessageId: string | null
  }> = []

  const deps: RoutineRunnerDeps = {
    now: () => currentNow,
    createRunConversation: async ({ routineId, runId, name, folder }) => {
      fs.mkdirSync(folder, { recursive: true })
      const conv: StandaloneConversation = {
        id: `conv-${runId}`,
        scope: 'standalone',
        workspaceId: null,
        branch: null,
        mode: null,
        experience: 'standard',
        isMulti: 0,
        name,
        cwd: folder,
        status: 'idle',
        createdAt: currentNow,
        archived: 0,
        pinnedAt: null,
        lastActivityAt: currentNow,
        routineId,
        routineRunId: runId,
      }
      insertConversation(conv)
      return conv
    },
    configureRunConversation: () => {},
    startExecutorChatTurn: async ({ conversationId, prompt, signal }) => {
      const done = deferred<InternalTurnOutcome>()
      const turn = { conversationId, prompt, signal, done, assistantMessageId: null as string | null }
      startedTurns.push(turn)
      const handle: InternalTurnHandle = {
        executionId: conversationId,
        conversationId,
        assistantMessageId: () => turn.assistantMessageId,
        done: done.promise,
        cancel: () => {
          done.resolve({ status: 'cancelled', assistantMessageId: turn.assistantMessageId })
        },
      }
      signal.addEventListener('abort', () => handle.cancel(), { once: true })
      return handle
    },
    getMainWebContents: () => ({ id: 1 }),
    holdAwake: (key: string) => {
      awakeKeys.add(key)
      return () => {
        awakeKeys.delete(key)
      }
    },
    onAlert: (run) => {
      alerts.push({ runId: run.id, status: run.status })
    },
    onToast: (event) => {
      toasts.push({ kind: event.kind, runId: event.run.id })
    },
    assistantText: (conversationId, messageId) => {
      if (!messageId) return null
      return `${conversationId}:${messageId}:`.padEnd(250, 'x')
    },
    waitWindowRetryMs: 5,
    waitWindowTimeoutMs: 25,
    waitSlotTimeoutMs: 50,
    ...overrides,
  }

  return {
    deps,
    now: () => currentNow,
    awakeKeys,
    alerts,
    toasts,
    startedTurns,
    advanceNow: (ms: number) => {
      currentNow += ms
    },
  }
}

describe('routine permission scope and saved permissions', () => {
  it('uses routine:<id> scope for run conversations and lists/deletes saved rules', () => {
    const conv: StandaloneConversation = {
      id: 'conv-run-1',
      scope: 'standalone',
      workspaceId: null,
      branch: null,
      mode: null,
      experience: 'standard',
      isMulti: 0,
      name: 'Run 1',
      cwd: '/tmp/r-1',
      status: 'idle',
      createdAt: 1,
      archived: 0,
      pinnedAt: null,
      lastActivityAt: 1,
      routineId: 'routine-123',
      routineRunId: 'run-1',
    }
    const scope = conversationPermissionScope(conv)
    expect(scope).toEqual({ kind: 'routine', id: 'routine-123' })
    const key = permissionScopeKey(scope)
    expect(key).toBe('routine:routine-123')

    getDb()
      .prepare('INSERT INTO permission_saved (id, project_id, action, resource) VALUES (?, ?, ?, ?)')
      .run('perm-1', key, 'bash', 'git status*')
    getDb()
      .prepare('INSERT INTO permission_saved (id, project_id, action, resource) VALUES (?, ?, ?, ?)')
      .run('perm-2', key, 'read', '/tmp/other/*')

    expect(listSavedPermissions(key)).toHaveLength(2)
    expect(deleteSavedPermission('perm-1', key)).toBe(true)
    expect(listSavedPermissions(key).map((p) => p.id)).toEqual(['perm-2'])
    deleteAllSavedPermissions(key)
    expect(listSavedPermissions(key)).toEqual([])
  })
})

describe('routine prompt builder', () => {
  it('includes late note and previous reports or first-run note', () => {
    const routine = createRoutine(sampleDraft(), null, 1000)
    const first = buildRoutinePrompt({
      routine,
      trigger: 'schedule',
      scheduledAt: Date.UTC(2026, 10, 18, 9, 0),
      previousReports: [],
    })
    expect(first).toContain('Scheduled routine "Daily digest"')
    expect(first).toContain('Summarize open PRs.')
    expect(first).toContain('This is the first run of this routine.')
    expect(first).not.toContain('This run is late:')
    expect(first).toContain('Ask the person only when you cannot continue without them')
    expect(first).toContain('asking pauses the run')

    const late = buildRoutinePrompt({
      routine,
      trigger: 'late',
      scheduledAt: Date.UTC(2026, 10, 18, 9, 0),
      previousReports: [
        {
          run: { startedAt: Date.UTC(2026, 10, 17, 9, 0), scheduledAt: Date.UTC(2026, 10, 17, 9, 0), status: 'notable' },
          report: { outcome: 'notable', summary: '2 PRs waiting', pending: 'Review #4', notes: 'Watch #5' },
        },
      ],
    })
    expect(late).toContain('This run is late:')
    expect(late).toContain('Previous runs of this routine, newest first:')
    expect(late).toContain('Did: 2 PRs waiting · Pending: Review #4 · Notes for this run: Watch #5')
  })
})

describe('routine runner', () => {
  it('maps report outcomes, fallback summary, error, and cancel while managing wake lock', async () => {
    const routine = createRoutine(sampleDraft(), null, 1000)
    const env = makeDeps()
    const runner = createRoutineRunner(env.deps)

    // 1. Report outcome -> notable + alerts
    const run1 = await runner.start(routine.id, 'schedule', env.now())
    expect(run1.status).toBe('running')
    expect(runner.isBusy(routine.id)).toBe(true)
    expect(env.awakeKeys.has(`routine-run:${run1.id}`)).toBe(true)

    updateRun(run1.id, {
      report: { outcome: 'notable', summary: 'Found 3 PRs', pending: null, notes: null },
    })
    env.startedTurns[0].done.resolve({ status: 'success', assistantMessageId: 'm1' })
    const settled1 = await runner.waitForRun(run1.id)
    expect(settled1?.status).toBe('notable')
    expect(settled1?.summary).toBe('Found 3 PRs')
    expect(settled1?.unread).toBe(true)
    expect(env.awakeKeys.has(`routine-run:${run1.id}`)).toBe(false)
    expect(env.alerts).toContainEqual({ runId: run1.id, status: 'notable' })

    // 2. No report -> done with first 200 chars of assistant text
    const run2 = await runner.start(routine.id, 'manual', env.now())
    expect(env.toasts.some((t) => t.kind === 'started' && t.runId === run2.id)).toBe(true)
    env.startedTurns[1].assistantMessageId = 'm2'
    env.startedTurns[1].done.resolve({ status: 'success', assistantMessageId: 'm2' })
    const settled2 = await runner.waitForRun(run2.id)
    expect(settled2?.status).toBe('done')
    expect(settled2?.summary?.length).toBe(200)
    expect(settled2?.unread).toBe(false) // notify='notable' does not alert on done

    // 3. Error -> failed + alerts
    const run3 = await runner.start(routine.id, 'schedule', env.now())
    env.startedTurns[2].done.resolve({ status: 'error', error: 'Rate limit', assistantMessageId: null })
    const settled3 = await runner.waitForRun(run3.id)
    expect(settled3?.status).toBe('failed')
    expect(settled3?.error).toBe('Rate limit')
    expect(settled3?.unread).toBe(true)

    // 4. Stop -> stopped
    const run4 = await runner.start(routine.id, 'schedule', env.now())
    runner.stop(run4.id)
    const settled4 = await runner.waitForRun(run4.id)
    expect(settled4?.status).toBe('stopped')
    expect(runner.isBusy(routine.id)).toBe(false)
  })

  it('tracks waiting status, releases wake lock while waiting, and skips busy runs', async () => {
    const routine = createRoutine(sampleDraft(), null, 1000)
    const env = makeDeps()
    const runner = createRoutineRunner(env.deps)

    const run = await runner.start(routine.id, 'schedule', env.now())
    expect(env.awakeKeys.has(`routine-run:${run.id}`)).toBe(true)

    // Waiting for approval
    runner.onConversationStatus(run.conversationId!, 'waiting')
    expect(getRun(run.id)?.status).toBe('waiting')
    expect(getRun(run.id)?.unread).toBe(true)
    expect(env.awakeKeys.has(`routine-run:${run.id}`)).toBe(false)
    expect(env.alerts).toContainEqual({ runId: run.id, status: 'waiting' })

    // Busy run skipped
    const skipped = await runner.start(routine.id, 'manual', env.now())
    expect(skipped.status).toBe('skipped_busy')
    expect(env.toasts.some((t) => t.kind === 'skipped-busy' && t.runId === skipped.id)).toBe(true)

    // Back to working
    runner.onConversationStatus(run.conversationId!, 'working')
    expect(getRun(run.id)?.status).toBe('running')
    expect(env.awakeKeys.has(`routine-run:${run.id}`)).toBe(true)

    env.startedTurns[0].done.resolve({ status: 'success', assistantMessageId: null })
    await runner.waitForRun(run.id)

    // Later human turns in the same conversation do NOT alter run status
    runner.onConversationStatus(run.conversationId!, 'waiting')
    expect(getRun(run.id)?.status).toBe('done')
  })

  it('enforces concurrency queue (FIFO) and skips if waiting too long or if main window is missing', async () => {
    const routines: LocalRoutine[] = []
    for (let i = 0; i < ROUTINE_LIMITS.concurrentRuns + 1; i++) {
      routines.push(createRoutine(sampleDraft({ title: `R${i}` }), null, 1000 + i))
    }
    const env = makeDeps({ waitSlotTimeoutMs: 40 })
    const runner = createRoutineRunner(env.deps)

    // Fill all concurrent slots
    for (let i = 0; i < ROUTINE_LIMITS.concurrentRuns; i++) {
      const r = await runner.start(routines[i].id, 'schedule', env.now())
      expect(r.status).toBe('running')
    }
    // Next one waits in queue and times out as skipped_busy
    const queued = await runner.start(routines[ROUTINE_LIMITS.concurrentRuns].id, 'schedule', env.now())
    expect(queued.status).toBe('skipped_busy')

    // Clean up active turns
    for (const turn of env.startedTurns) {
      turn.done.resolve({ status: 'success', assistantMessageId: null })
    }
    await Promise.all(
      env.startedTurns.map((t) => {
        const conv = getConversation(t.conversationId) as StandaloneConversation
        return runner.waitForRun(conv.routineRunId!)
      })
    )

    // Missing main window becomes skipped_closed
    const noWindowEnv = makeDeps({
      getMainWebContents: () => null,
      waitWindowRetryMs: 5,
      waitWindowTimeoutMs: 20,
    })
    const noWindowRunner = createRoutineRunner(noWindowEnv.deps)
    const closedRun = await noWindowRunner.start(routines[0].id, 'schedule', noWindowEnv.now())
    const settledClosed = await noWindowRunner.waitForRun(closedRun.id)
    expect(settledClosed?.status).toBe('skipped_closed')
  })

  it('copies attachments into <routine folder>/runs/<YYYY-MM-DD HHmm>/ before deleting conversation', async () => {
    const routine = createRoutine(sampleDraft(), null, 1000)
    const convId = 'conv-keep-1'
    insertConversation({
      id: convId,
      scope: 'standalone',
      workspaceId: null,
      branch: null,
      mode: null,
      experience: 'standard',
      isMulti: 0,
      name: 'Run',
      cwd: routine.folder,
      status: 'idle',
      createdAt: 1000,
      archived: 0,
      pinnedAt: null,
      lastActivityAt: 1000,
      routineId: routine.id,
      routineRunId: 'run-keep-1',
    })
    const run = insertRun({
      id: 'run-keep-1',
      routineId: routine.id,
      scheduledAt: new Date(2026, 10, 18, 8, 5).getTime(),
      startedAt: new Date(2026, 10, 18, 8, 5).getTime(),
      finishedAt: new Date(2026, 10, 18, 8, 6).getTime(),
      trigger: 'schedule',
      status: 'done',
      summary: 'Saved note',
      report: null,
      error: null,
      conversationId: convId,
      conversationDeleted: false,
      pinned: false,
      unread: false,
    })
    upsertChatMessage({
      id: 'msg-1',
      conversationId: convId,
      role: 'user',
      parts: [{ id: 'p1', type: 'file', kind: 'text', name: 'notes.txt', mediaType: 'text/plain', data: 'hello world' }],
      createdAt: 1000,
    })

    const kept = await keepRoutineRunFiles(routine, run)
    expect(kept.files).toEqual([{ name: 'notes.txt', kind: 'file', byteSize: 11 }])
    const keptDir = path.join(routine.folder, 'runs', '2026-11-18 0805')
    expect(fs.readFileSync(path.join(keptDir, 'notes.txt'), 'utf8')).toBe('hello world')
  })

  it('settles run as failed and releases busy/slot when startTurn or createRunConversation rejects', async () => {
    const routine = createRoutine(sampleDraft(), null, 1000)

    // 1. startTurn rejects with main window already ready
    let attempt = 0
    const env = makeDeps({
      startExecutorChatTurn: async (args) => {
        attempt++
        if (attempt === 1) throw new Error('Provider disconnected')
        const done = deferred<InternalTurnOutcome>()
        env.startedTurns.push({
          conversationId: args.conversationId,
          prompt: args.prompt,
          signal: args.signal,
          done,
          assistantMessageId: null,
        })
        return {
          executionId: args.conversationId,
          conversationId: args.conversationId,
          assistantMessageId: () => null,
          cancel: () => done.resolve({ status: 'cancelled', assistantMessageId: null }),
          done: done.promise,
        }
      },
    })
    const runner = createRoutineRunner(env.deps)

    const failedRun = await runner.start(routine.id, 'manual', env.now())
    expect(failedRun.status).toBe('failed')
    expect(failedRun.error).toBe('Provider disconnected')
    expect(failedRun.unread).toBe(true)
    expect(getRun(failedRun.id)?.status).toBe('failed')
    expect(runner.isBusy(routine.id)).toBe(false)
    expect(env.awakeKeys.size).toBe(0)
    expect(env.toasts.some((t) => t.kind === 'started' && t.runId === failedRun.id)).toBe(false)
    expect(env.toasts.some((t) => t.kind === 'result' && t.runId === failedRun.id)).toBe(true)
    expect(env.alerts).toContainEqual({ runId: failedRun.id, status: 'failed' })

    // Next start works cleanly and emits started only after turn starts
    const okRun = await runner.start(routine.id, 'manual', env.now())
    expect(okRun.status).toBe('running')
    expect(env.toasts.some((t) => t.kind === 'started' && t.runId === okRun.id)).toBe(true)
    env.startedTurns[0].done.resolve({ status: 'success', assistantMessageId: null })
    await runner.waitForRun(okRun.id)

    // 2. createRunConversation rejects -> records failed row and frees slot/busy
    const convFailEnv = makeDeps({
      createRunConversation: async () => {
        throw new Error('Disk full')
      },
    })
    const convFailRunner = createRoutineRunner(convFailEnv.deps)
    const convFailedRun = await convFailRunner.start(routine.id, 'schedule', convFailEnv.now())
    expect(convFailedRun.status).toBe('failed')
    expect(convFailedRun.error).toBe('Disk full')
    expect(convFailedRun.unread).toBe(true)
    expect(getRun(convFailedRun.id)?.status).toBe('failed')
    expect(convFailRunner.isBusy(routine.id)).toBe(false)
    expect(convFailEnv.alerts).toContainEqual({ runId: convFailedRun.id, status: 'failed' })
  })

  it('treats asking status like waiting, notifies, releases awake, and resumes on working', async () => {
    const routine = createRoutine(sampleDraft(), null, 1000)
    const env = makeDeps({
      pendingInteractions: () => ({
        permissions: [],
        questions: [{ messageId: 'm-1', toolCallId: 'tc-1', questions: [{ header: 'Alvo', question: 'Which environment?', options: [] }] }],
      }),
    })
    const runner = createRoutineRunner(env.deps)

    const run = await runner.start(routine.id, 'schedule', env.now())
    expect(env.awakeKeys.has(`routine-run:${run.id}`)).toBe(true)

    runner.onConversationStatus(run.conversationId!, 'asking')
    const paused = getRun(run.id)
    expect(paused?.status).toBe('waiting')
    expect(paused?.unread).toBe(true)
    expect(paused?.waiting).toEqual({ kind: 'question', prompt: 'Which environment?' })
    expect(env.awakeKeys.has(`routine-run:${run.id}`)).toBe(false)
    expect(env.alerts).toContainEqual({ runId: run.id, status: 'waiting' })
    expect(env.toasts.some((t) => t.kind === 'result' && t.runId === run.id)).toBe(true)

    runner.onConversationStatus(run.conversationId!, 'working')
    const resumed = getRun(run.id)
    expect(resumed?.status).toBe('running')
    expect(resumed?.waiting).toBeNull()
    expect(env.awakeKeys.has(`routine-run:${run.id}`)).toBe(true)

    env.startedTurns[0].done.resolve({ status: 'success', assistantMessageId: null })
    await runner.waitForRun(run.id)
  })

  it('releases concurrency slots while runs are waiting and resumes them without re-queuing', async () => {
    const routines = Array.from({ length: 6 }, (_, i) =>
      createRoutine(sampleDraft({ title: `Routine ${i + 1}` }), null, 1000 + i)
    )
    const env = makeDeps({ waitSlotTimeoutMs: 30 })
    const runner = createRoutineRunner(env.deps)

    const r1 = await runner.start(routines[0].id, 'schedule', env.now())
    const r2 = await runner.start(routines[1].id, 'schedule', env.now())
    const r3 = await runner.start(routines[2].id, 'schedule', env.now())

    runner.onConversationStatus(r1.conversationId!, 'waiting')
    runner.onConversationStatus(r2.conversationId!, 'asking')
    runner.onConversationStatus(r3.conversationId!, 'waiting')

    // All 3 slots are released while waiting, so 3 new runs can start without timing out to skipped_busy.
    const r4 = await runner.start(routines[3].id, 'schedule', env.now())
    const r5 = await runner.start(routines[4].id, 'schedule', env.now())
    const r6 = await runner.start(routines[5].id, 'schedule', env.now())
    expect(r4.status).toBe('running')
    expect(r5.status).toBe('running')
    expect(r6.status).toBe('running')

    // Waiting run resumes directly on working without waiting for a queued slot.
    runner.onConversationStatus(r1.conversationId!, 'working')
    expect(getRun(r1.id)?.status).toBe('running')

    // Stopping a waiting run must not double-release slots.
    runner.stop(r2.id)
    await runner.waitForRun(r2.id)

    for (const turn of env.startedTurns) {
      turn.done.resolve({ status: 'success', assistantMessageId: null })
    }
    await Promise.all([r1, r3, r4, r5, r6].map((r) => runner.waitForRun(r.id)))
    expect(getRun(r1.id)?.status).toBe('done')
    expect(getRun(r4.id)?.status).toBe('done')
  })
})
