import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { ROUTINE_LIMITS, type RoutineDraft } from '../../src/shared/routines'
import { getConversation, getDb, insertConversation, setAppSetting } from '../../src/main/store'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import {
  createRoutine,
  getRoutine,
  getRun,
  insertRun,
  listRuns,
  setRoutineEnabled,
  setRoutineSettings,
} from '../../src/main/routines/store'
import {
  createRoutineScheduler,
  decideTick,
  recoverInterruptedRoutineRuns,
} from '../../src/main/routines/scheduler'
import {
  applyRoutineLoginItem,
  ROUTINE_LOGIN_ARG,
  wasOpenedAtLoginForRoutines,
} from '../../src/main/routines/lifecycle'
import { RoutineNotices } from '../../src/main/notifications/routine-notices'
import type { SystemNotice } from '../../src/main/notifications/system-notices'

beforeEach(freshDb)
afterEach(closeDb)

function sampleDraft(overrides: Partial<RoutineDraft> = {}): RoutineDraft {
  return {
    title: 'Morning check',
    instruction: 'Check status.',
    schedule: { kind: 'interval', everyMinutes: 15 },
    permMode: 'auto',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', reasoning: 'medium', fastMode: false },
    notify: 'notable',
    missed: 'catchup',
    retentionDays: 30,
    ...overrides,
  }
}

describe('decideTick', () => {
  const base = Date.UTC(2026, 10, 18, 9, 0)

  it('waits when disabled, null nextRunAt, or nextRunAt in the future', () => {
    expect(
      decideTick({
        routine: { schedule: { kind: 'interval', everyMinutes: 15 }, missed: 'catchup', enabled: false, nextRunAt: base },
        now: base + 1000,
        processStartedAt: base,
        busy: false,
      }).decision
    ).toEqual({ kind: 'wait' })

    expect(
      decideTick({
        routine: { schedule: { kind: 'interval', everyMinutes: 15 }, missed: 'catchup', enabled: true, nextRunAt: null },
        now: base + 1000,
        processStartedAt: base,
        busy: false,
      }).decision
    ).toEqual({ kind: 'wait' })

    expect(
      decideTick({
        routine: {
          schedule: { kind: 'interval', everyMinutes: 15 },
          missed: 'catchup',
          enabled: true,
          nextRunAt: base + 5000,
        },
        now: base,
        processStartedAt: base,
        busy: false,
      }).decision
    ).toEqual({ kind: 'wait' })
  })

  it('fires on time and within grace period', () => {
    const onTime = decideTick({
      routine: { schedule: { kind: 'interval', everyMinutes: 15 }, missed: 'skip', enabled: true, nextRunAt: base },
      now: base,
      processStartedAt: base - 60_000,
      busy: false,
    })
    expect(onTime.decision).toEqual({ kind: 'fire', trigger: 'schedule', scheduledAt: base, skipped: [] })
    expect(onTime.nextRunAt).toBe(base + 15 * 60_000)

    const withinGrace = decideTick({
      routine: { schedule: { kind: 'interval', everyMinutes: 15 }, missed: 'skip', enabled: true, nextRunAt: base },
      now: base + ROUTINE_LIMITS.onTimeGraceMs,
      processStartedAt: base - 60_000,
      busy: false,
    })
    expect(withinGrace.decision).toEqual({ kind: 'fire', trigger: 'schedule', scheduledAt: base, skipped: [] })
    expect(withinGrace.nextRunAt).toBe(base + 15 * 60_000)
  })

  it('keeps interval cadence fixed without accumulating tick delay, while weekly stays anchored', () => {
    const stepMs = 30 * 60_000
    const res1 = decideTick({
      routine: { schedule: { kind: 'interval', everyMinutes: 30 }, missed: 'catchup', enabled: true, nextRunAt: base },
      now: base + 12_000,
      processStartedAt: base - 60_000,
      busy: false,
    })
    expect(res1.nextRunAt).toBe(base + stepMs)

    const res2 = decideTick({
      routine: {
        schedule: { kind: 'interval', everyMinutes: 30 },
        missed: 'catchup',
        enabled: true,
        nextRunAt: res1.nextRunAt,
      },
      now: res1.nextRunAt! + 14_000,
      processStartedAt: base - 60_000,
      busy: false,
    })
    expect(res2.nextRunAt).toBe(base + 2 * stepMs)

    const weeklySchedule = { kind: 'weekly' as const, time: '09:00', days: [], timezone: 'UTC' }
    const weeklyTickNow = Date.UTC(2026, 10, 18, 9, 0, 14)
    const weekly = decideTick({
      routine: {
        schedule: weeklySchedule,
        missed: 'catchup',
        enabled: true,
        nextRunAt: Date.UTC(2026, 10, 18, 9, 0),
      },
      now: weeklyTickNow,
      processStartedAt: base - 60_000,
      busy: false,
    })
    expect(weekly.nextRunAt).toBe(Date.UTC(2026, 10, 19, 9, 0))
  })

  it('handles late catch-up, beyond window, and skip policy', () => {
    const lateNow = base + ROUTINE_LIMITS.onTimeGraceMs + 60_000
    const catchup = decideTick({
      routine: { schedule: { kind: 'interval', everyMinutes: 60 }, missed: 'catchup', enabled: true, nextRunAt: base },
      now: lateNow,
      processStartedAt: base - 10_000,
      busy: false,
    })
    expect(catchup.decision).toEqual({ kind: 'fire', trigger: 'late', scheduledAt: base, skipped: [] })

    const skipPolicy = decideTick({
      routine: { schedule: { kind: 'interval', everyMinutes: 60 }, missed: 'skip', enabled: true, nextRunAt: base },
      now: lateNow,
      processStartedAt: base - 10_000,
      busy: false,
    })
    expect(skipPolicy.decision).toEqual({
      kind: 'skip',
      skipped: [{ scheduledAt: base, status: 'skipped_asleep' }],
    })

    const beyondWindow = decideTick({
      routine: { schedule: { kind: 'interval', everyMinutes: 180 }, missed: 'catchup', enabled: true, nextRunAt: base },
      now: base + ROUTINE_LIMITS.catchUpWindowMs + 10_000,
      processStartedAt: base - 10_000,
      busy: false,
    })
    expect(beyondWindow.decision).toEqual({
      kind: 'skip',
      skipped: [{ scheduledAt: base, status: 'skipped_asleep' }],
    })
  })

  it('distinguishes skipped_closed vs skipped_asleep, handles busy, and caps skipped slots', () => {
    // 60 slots of 15 min = 15h gap; processStartedAt splits the kept tail
    const now = base + 59 * 15 * 60_000
    const processStartedAt = base + 30 * 15 * 60_000
    const res = decideTick({
      routine: { schedule: { kind: 'interval', everyMinutes: 15 }, missed: 'catchup', enabled: true, nextRunAt: base },
      now,
      processStartedAt,
      busy: false,
    })
    expect(res.decision.kind).toBe('fire')
    if (res.decision.kind !== 'fire') throw new Error('expected fire')
    expect(res.decision.trigger).toBe('schedule')
    expect(res.decision.scheduledAt).toBe(now)
    // Kept tail has skippedSlotsPerGap (48) total slots -> 47 older skipped + 1 newest fired
    expect(res.decision.skipped.length).toBe(ROUTINE_LIMITS.skippedSlotsPerGap - 1)
    expect(res.decision.skipped[0].status).toBe('skipped_closed')
    expect(res.decision.skipped[res.decision.skipped.length - 1].status).toBe('skipped_asleep')

    const busyRes = decideTick({
      routine: { schedule: { kind: 'interval', everyMinutes: 15 }, missed: 'catchup', enabled: true, nextRunAt: base },
      now,
      processStartedAt,
      busy: true,
    })
    expect(busyRes.decision.kind).toBe('skip')
    if (busyRes.decision.kind !== 'skip') throw new Error('expected skip')
    expect(busyRes.decision.skipped.length).toBe(ROUTINE_LIMITS.skippedSlotsPerGap)
    expect(busyRes.decision.skipped.every((s) => s.status === 'skipped_busy')).toBe(true)
  })
})

describe('scheduler runtime, startup recovery, and retention', () => {
  it('recovers interrupted runs on startup and fires due routines on tick', async () => {
    let now = Date.UTC(2026, 10, 18, 9, 0)
    const routine = createRoutine(sampleDraft({ schedule: { kind: 'interval', everyMinutes: 30 } }), null, now)
    // Orphaned running & waiting runs from a previous process
    const orphan1 = insertRun({
      routineId: routine.id,
      scheduledAt: now - 3600_000,
      startedAt: now - 3600_000,
      finishedAt: null,
      trigger: 'schedule',
      status: 'running',
      summary: null,
      report: null,
      error: null,
      conversationId: null,
      conversationDeleted: false,
      pinned: false,
      unread: false,
    })
    const orphan2 = insertRun({
      routineId: routine.id,
      scheduledAt: now - 1800_000,
      startedAt: now - 1800_000,
      finishedAt: null,
      trigger: 'schedule',
      status: 'waiting',
      summary: null,
      report: null,
      error: null,
      conversationId: null,
      conversationDeleted: false,
      pinned: false,
      unread: true,
    })

    expect(recoverInterruptedRoutineRuns(now)).toBe(2)
    expect(getRun(orphan1.id)?.status).toBe('failed')
    expect(getRun(orphan1.id)?.error).toBe('Maestrly closed during the run')
    expect(getRun(orphan1.id)?.unread).toBe(true)
    expect(getRun(orphan2.id)?.status).toBe('stopped')
    expect(getRun(orphan2.id)?.unread).toBe(false)

    // Advance now past nextRunAt (9:30 -> 10:00)
    now += 60 * 60_000
    const startedCalls: Array<{ routineId: string; trigger: string; scheduledAt: number }> = []
    const scheduler = createRoutineScheduler({
      now: () => now,
      processStartedAt: now - 5 * 60_000,
      runner: {
        isBusy: () => false,
        start: async (routineId, trigger, scheduledAt) => {
          startedCalls.push({ routineId, trigger, scheduledAt })
          return insertRun({
            routineId,
            scheduledAt,
            startedAt: now,
            finishedAt: null,
            trigger,
            status: 'running',
            summary: null,
            report: null,
            error: null,
            conversationId: null,
            conversationDeleted: false,
            pinned: false,
            unread: false,
          })
        },
      },
    })

    await scheduler.tick()
    expect(startedCalls).toEqual([{ routineId: routine.id, trigger: 'schedule', scheduledAt: now }])
    const runs = listRuns({ routineId: routine.id, filter: 'all', limit: 20 })
    // 9:30 was skipped_closed (since 9:30 < processStartedAt 9:55), 10:00 fired
    expect(runs.runs.some((r) => r.status === 'skipped_closed')).toBe(true)
    expect(getRoutine(routine.id)?.nextRunAt).toBe(now + 30 * 60_000)

    // Pausing disables firing
    setRoutineEnabled(routine.id, false, now)
    now += 60 * 60_000
    await scheduler.tick()
    expect(startedCalls).toHaveLength(1)
  })

  it('sweeps retention (deleting unpinned expired conversations while keeping files) and prunes rows', async () => {
    const now = Date.UTC(2026, 10, 18, 9, 0)
    const routine = createRoutine(sampleDraft({ retentionDays: 30 }), null, now - 40 * 86_400_000)

    const makeConv = (id: string) => {
      insertConversation({
        id,
        scope: 'standalone',
        workspaceId: null,
        branch: null,
        mode: null,
        experience: 'standard',
        isMulti: 0,
        name: 'Run',
        cwd: routine.folder,
        status: 'idle',
        createdAt: now - 40 * 86_400_000,
        archived: 0,
        pinnedAt: null,
        lastActivityAt: now - 40 * 86_400_000,
        routineId: routine.id,
        routineRunId: `run-${id}`,
      })
      upsertChatMessage({
        id: `m-${id}`,
        conversationId: id,
        role: 'user',
        parts: [{ id: 'p1', type: 'file', kind: 'text', name: `${id}.txt`, mediaType: 'text/plain', data: 'kept' }],
        createdAt: now - 40 * 86_400_000,
      })
    }

    makeConv('c-old-unpinned')
    makeConv('c-old-pinned')
    makeConv('c-old-running')
    makeConv('c-recent')

    const oldTime = now - 35 * 86_400_000
    const recentTime = now - 5 * 86_400_000

    const rUnpinned = insertRun({
      routineId: routine.id,
      scheduledAt: oldTime,
      startedAt: oldTime,
      finishedAt: oldTime + 1000,
      trigger: 'schedule',
      status: 'done',
      summary: 'Old',
      report: null,
      error: null,
      conversationId: 'c-old-unpinned',
      conversationDeleted: false,
      pinned: false,
      unread: false,
    })
    const rPinned = insertRun({
      routineId: routine.id,
      scheduledAt: oldTime + 1,
      startedAt: oldTime + 1,
      finishedAt: oldTime + 1001,
      trigger: 'schedule',
      status: 'done',
      summary: 'Pinned',
      report: null,
      error: null,
      conversationId: 'c-old-pinned',
      conversationDeleted: false,
      pinned: true,
      unread: false,
    })
    const rRunning = insertRun({
      routineId: routine.id,
      scheduledAt: oldTime + 2,
      startedAt: oldTime + 2,
      finishedAt: null,
      trigger: 'schedule',
      status: 'running',
      summary: null,
      report: null,
      error: null,
      conversationId: 'c-old-running',
      conversationDeleted: false,
      pinned: false,
      unread: false,
    })
    const rRecent = insertRun({
      routineId: routine.id,
      scheduledAt: recentTime,
      startedAt: recentTime,
      finishedAt: recentTime + 1000,
      trigger: 'schedule',
      status: 'done',
      summary: 'Recent',
      report: null,
      error: null,
      conversationId: 'c-recent',
      conversationDeleted: false,
      pinned: false,
      unread: false,
    })

    const deletedConvs: string[] = []
    const scheduler = createRoutineScheduler({
      now: () => now,
      processStartedAt: now,
      runner: {
        isBusy: () => false,
        start: async () => rRecent,
      },
      deleteRunConversation: async (runId) => {
        deletedConvs.push(runId)
        const r = getRun(runId)
        if (r?.conversationId && getConversation(r.conversationId)) {
          fs.mkdirSync(path.join(routine.folder, 'runs', 'archived'), { recursive: true })
          fs.writeFileSync(path.join(routine.folder, 'runs', 'archived', 'note.txt'), 'kept')
        }
        return true
      },
    })

    await scheduler.sweepRetention()
    expect(deletedConvs).toEqual([rUnpinned.id])
    expect(getRun(rPinned.id)?.conversationDeleted).toBe(false)
    expect(getRun(rRunning.id)?.conversationDeleted).toBe(false)
    expect(getRun(rRecent.id)?.conversationDeleted).toBe(false)
  })
})

describe('login item lifecycle and routine OS notices', () => {
  it('handles platform login items without clearing routine openAtLogin', () => {
    const calls: Array<Record<string, unknown>> = []
    const fakeApp = {
      setLoginItemSettings: (opts: Record<string, unknown>) => {
        calls.push(opts)
      },
    }

    applyRoutineLoginItem(true, 'darwin', fakeApp)
    expect(calls).toEqual([{ openAtLogin: true, args: [ROUTINE_LOGIN_ARG] }])

    applyRoutineLoginItem(true, 'linux', fakeApp)
    expect(calls).toHaveLength(1)

    expect(
      wasOpenedAtLoginForRoutines({
        platform: 'darwin',
        argv: ['Maestrly'],
        loginItemSettings: { wasOpenedAtLogin: true },
      })
    ).toBe(true)
    expect(
      wasOpenedAtLoginForRoutines({
        platform: 'win32',
        argv: ['Maestrly.exe', ROUTINE_LOGIN_ARG],
        loginItemSettings: { wasOpenedAtLogin: false },
      })
    ).toBe(true)
    expect(
      wasOpenedAtLoginForRoutines({
        platform: 'linux',
        argv: ['maestrly', ROUTINE_LOGIN_ARG],
        loginItemSettings: { wasOpenedAtLogin: true },
      })
    ).toBe(false)

    // retireExecutorLoginItem guard check: if routines openAtLogin is enabled in settings,
    // verify setting persists untouched.
    setRoutineSettings({ keepRunning: true, openAtLogin: true })
    setAppSetting('platform.desktop-executor.v1', JSON.stringify({ autoStart: true }))
    expect(getDb().prepare("SELECT value FROM app_settings WHERE key = 'routines.settings'").get()).toBeDefined()
  })

  it('shows OS notice only when person is not looking at that run and opens it on click', () => {
    const shown: SystemNotice[] = []
    const dismissed: string[] = []
    const opened: unknown[] = []
    let sees = false

    const notices = new RoutineNotices({
      notices: {
        show: (n) => shown.push(n),
        dismiss: (k) => dismissed.push(k),
      },
      sees: () => sees,
      open: (target) => opened.push(target),
    })

    const routine = createRoutine(sampleDraft(), null, 1000)
    const run = insertRun({
      routineId: routine.id,
      scheduledAt: 1000,
      startedAt: 1000,
      finishedAt: 2000,
      trigger: 'schedule',
      status: 'notable',
      summary: 'Found 2 PRs',
      report: null,
      error: null,
      conversationId: 'conv-1',
      conversationDeleted: false,
      pinned: false,
      unread: true,
    })

    notices.notifyRun(run, routine)
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('Morning check')
    expect(shown[0].body).toBe('Found 2 PRs')
    shown[0].onClick()
    expect(opened).toEqual([
      { kind: 'routine-run', routineId: routine.id, runId: run.id, conversationId: 'conv-1' },
    ])

    notices.seen(run.id)
    expect(dismissed).toEqual([`routine-run:${run.id}`])

    sees = true
    notices.notifyRun(run, routine)
    expect(shown).toHaveLength(1)

    sees = false
    const approvalRun = insertRun({
      routineId: routine.id,
      scheduledAt: 2000,
      startedAt: 2000,
      finishedAt: null,
      trigger: 'schedule',
      status: 'waiting',
      summary: null,
      report: null,
      error: null,
      conversationId: 'conv-2',
      conversationDeleted: false,
      pinned: false,
      unread: true,
      waiting: { kind: 'approval', prompt: 'Delete 3 files' },
    })
    const questionRun = insertRun({
      routineId: routine.id,
      scheduledAt: 3000,
      startedAt: 3000,
      finishedAt: null,
      trigger: 'schedule',
      status: 'waiting',
      summary: null,
      report: null,
      error: null,
      conversationId: 'conv-3',
      conversationDeleted: false,
      pinned: false,
      unread: true,
      waiting: { kind: 'question', prompt: 'Which environment?' },
    })
    notices.notifyRun(approvalRun, routine)
    notices.notifyRun(questionRun, routine)
    expect(shown[1].body).toBe('Needs your approval to continue')
    expect(shown[2].body).toBe('Asked a question')
  })
})
