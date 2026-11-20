import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { getDb } from '../../src/main/store/db'
import {
  insertConversation,
  listConversationAttention,
  listStandaloneConversations,
  markConversationAttention,
} from '../../src/main/store/conversations'
import type { StandaloneConversation } from '../../src/shared/conversation'
import { isAlerting, ROUTINE_LIMITS, type RoutineDraft } from '../../src/shared/routines'
import {
  createProposal,
  createRoutine,
  deleteRoutine,
  getProposal,
  getRoutine,
  getRoutineHealthSummary,
  getRoutineSettings,
  getRun,
  insertRun,
  latestReports,
  listRuns,
  listRoutines,
  pruneRuns,
  runByConversation,
  runsInRange,
  setNextRunAt,
  setProposalState,
  setRoutineEnabled,
  setRoutineSettings,
  subscribeRoutinesChanged,
  updateRoutine,
  updateRun,
} from '../../src/main/routines/store'

beforeEach(freshDb)
afterEach(closeDb)

function sampleDraft(overrides: Partial<RoutineDraft> = {}): RoutineDraft {
  return {
    title: 'Check flights',
    instruction: 'Check flight prices GRU -> LIS.',
    schedule: { kind: 'weekly', time: '08:00', days: [1, 3, 5], timezone: 'UTC' },
    permMode: 'auto',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', reasoning: 'medium', fastMode: false },
    notify: 'notable',
    missed: 'catchup',
    retentionDays: 30,
    ...overrides,
  }
}

function makeStandalone(id: string, extra: Partial<StandaloneConversation> = {}): StandaloneConversation {
  return {
    id,
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    name: id,
    cwd: `/tmp/${id}`,
    status: 'idle',
    createdAt: 1000,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 1000,
    ...extra,
  }
}

describe('routines store', () => {
  it('creates, reads, updates, toggles, and deletes routines while computing nextRunAt and emitting changes', () => {
    let changes = 0
    const unsub = subscribeRoutinesChanged(() => {
      changes += 1
    })

    const t0 = Date.UTC(2026, 10, 18, 7, 0) // Wednesday 07:00 UTC
    const created = createRoutine(sampleDraft(), { conversationId: 'c-1', title: 'Trip', via: 'proposal' }, t0)
    expect(created.enabled).toBe(true)
    expect(created.pausedAt).toBeNull()
    expect(created.nextRunAt).toBe(Date.UTC(2026, 10, 18, 8, 0))
    expect(created.folder).toContain(created.id)
    expect(getRoutine(created.id)).toEqual(created)
    expect(listRoutines()).toHaveLength(1)

    const pausedAt = Date.UTC(2026, 10, 18, 9, 0)
    const paused = setRoutineEnabled(created.id, false, pausedAt)
    expect(paused.enabled).toBe(false)
    expect(paused.pausedAt).toBe(pausedAt)
    expect(paused.nextRunAt).toBeNull()

    const resumedAt = Date.UTC(2026, 10, 18, 10, 0)
    const resumed = setRoutineEnabled(created.id, true, resumedAt)
    expect(resumed.enabled).toBe(true)
    expect(resumed.pausedAt).toBeNull()
    expect(resumed.nextRunAt).toBe(Date.UTC(2026, 10, 20, 8, 0)) // Friday 08:00 UTC

    const updated = updateRoutine(
      created.id,
      { title: 'Updated flights', schedule: { kind: 'interval', everyMinutes: 30 } },
      resumedAt + 1000
    )
    expect(updated.title).toBe('Updated flights')
    expect(updated.nextRunAt).toBe(resumedAt + 1000 + 30 * 60_000)

    setNextRunAt(created.id, resumedAt + 5000)
    expect(getRoutine(created.id)?.nextRunAt).toBe(resumedAt + 5000)

    expect(deleteRoutine(created.id)).toBe(true)
    expect(getRoutine(created.id)).toBeNull()
    expect(changes).toBeGreaterThanOrEqual(6)
    unsub()
  })

  it('enforces the maximum routine count limit', () => {
    for (let i = 0; i < ROUTINE_LIMITS.routinesMax; i++) {
      createRoutine(sampleDraft({ title: `Routine ${i}` }), null, 1000 + i)
    }
    expect(() => createRoutine(sampleDraft({ title: 'Overflow' }), null, 9999)).toThrow()
  })

  it('inserts, updates, filters, ranges, fetches latest reports, and prunes runs without deleting pinned or active ones', () => {
    const routine = createRoutine(sampleDraft(), null, 1000)
    const r1 = insertRun({
      routineId: routine.id,
      scheduledAt: 1000,
      startedAt: 1000,
      finishedAt: 2000,
      trigger: 'schedule',
      status: 'nothing_new',
      summary: 'No changes',
      report: { outcome: 'nothing_new', summary: 'No changes', pending: null, notes: 'Note 1' },
      error: null,
      conversationId: 'conv-r1',
      conversationDeleted: false,
      pinned: true,
      unread: false,
    })
    const r2 = insertRun({
      routineId: routine.id,
      scheduledAt: 2000,
      startedAt: 2000,
      finishedAt: 3000,
      trigger: 'schedule',
      status: 'notable',
      summary: 'Price dropped',
      report: { outcome: 'notable', summary: 'Price dropped', pending: 'Book', notes: 'Note 2' },
      error: null,
      conversationId: 'conv-r2',
      conversationDeleted: true,
      pinned: false,
      unread: true,
    })
    const r3 = insertRun({
      routineId: routine.id,
      scheduledAt: 3000,
      startedAt: null,
      finishedAt: null,
      trigger: 'schedule',
      status: 'skipped_closed',
      summary: null,
      report: null,
      error: null,
      conversationId: null,
      conversationDeleted: false,
      pinned: false,
      unread: false,
    })
    const r4 = insertRun({
      routineId: routine.id,
      scheduledAt: 4000,
      startedAt: 4000,
      finishedAt: null,
      trigger: 'manual',
      status: 'running',
      summary: null,
      report: null,
      error: null,
      conversationId: 'conv-r4',
      conversationDeleted: true,
      pinned: false,
      unread: false,
    })
    const updatedR4 = updateRun(r4.id, { status: 'failed', finishedAt: 4500, error: 'Timeout', unread: true })
    expect(updatedR4?.status).toBe('failed')
    expect(getRun(r4.id)?.error).toBe('Timeout')
    expect(runByConversation('conv-r2')?.id).toBe(r2.id)

    expect(listRuns({ routineId: routine.id, filter: 'all', limit: 10 }).runs.map((r) => r.id)).toEqual([
      r4.id,
      r3.id,
      r2.id,
      r1.id,
    ])
    expect(listRuns({ routineId: routine.id, filter: 'notable', limit: 10 }).runs.map((r) => r.id)).toEqual([r2.id])
    expect(listRuns({ routineId: routine.id, filter: 'issues', limit: 10 }).runs.map((r) => r.id)).toEqual([
      r4.id,
      r3.id,
    ])
    expect(listRuns({ routineId: routine.id, filter: 'all', limit: 2, before: 3000 }).runs.map((r) => r.id)).toEqual([
      r2.id,
      r1.id,
    ])
    expect(runsInRange(1500, 3500).map((r) => r.id)).toEqual([r2.id, r3.id])
    expect(latestReports(routine.id, 1).map((item) => item.run.id)).toEqual([r2.id])

    // Active running/waiting run and pinned run survive pruning even with keep = 1
    const r5 = insertRun({
      routineId: routine.id,
      scheduledAt: 5000,
      startedAt: 5000,
      finishedAt: null,
      trigger: 'schedule',
      status: 'waiting',
      summary: null,
      report: null,
      error: null,
      conversationId: 'conv-r5',
      conversationDeleted: false,
      pinned: false,
      unread: true,
    })
    const deleted = pruneRuns(routine.id, 1)
    expect(deleted).toBe(2) // r2 and r3 removed; r1 (pinned), r4 (newest unpinned finished), r5 (waiting) kept
    const remainingIds = listRuns({ routineId: routine.id, filter: 'all', limit: 20 }).runs.map((r) => r.id)
    expect(remainingIds).toEqual([r5.id, r4.id, r1.id])
  })

  it('never prunes runs whose conversation still exists beyond the cap', () => {
    const routine = createRoutine(sampleDraft(), null, 1000)
    const liveOld = insertRun({
      routineId: routine.id,
      scheduledAt: 1000,
      startedAt: 1000,
      finishedAt: 1500,
      trigger: 'schedule',
      status: 'done',
      summary: 'Old live',
      report: null,
      error: null,
      conversationId: 'conv-live-old',
      conversationDeleted: false,
      pinned: false,
      unread: false,
    })
    const deletedOld = insertRun({
      routineId: routine.id,
      scheduledAt: 2000,
      startedAt: 2000,
      finishedAt: 2500,
      trigger: 'schedule',
      status: 'done',
      summary: 'Old deleted',
      report: null,
      error: null,
      conversationId: 'conv-deleted-old',
      conversationDeleted: true,
      pinned: false,
      unread: false,
    })
    const skippedNull = insertRun({
      routineId: routine.id,
      scheduledAt: 3000,
      startedAt: null,
      finishedAt: 3000,
      trigger: 'schedule',
      status: 'skipped_closed',
      summary: null,
      report: null,
      error: null,
      conversationId: null,
      conversationDeleted: false,
      pinned: false,
      unread: false,
    })
    const deletedNew = insertRun({
      routineId: routine.id,
      scheduledAt: 4000,
      startedAt: 4000,
      finishedAt: 4500,
      trigger: 'schedule',
      status: 'done',
      summary: 'New deleted',
      report: null,
      error: null,
      conversationId: 'conv-deleted-new',
      conversationDeleted: true,
      pinned: false,
      unread: false,
    })

    const pruned = pruneRuns(routine.id, 1)
    expect(pruned).toBe(2)
    const remainingIds = listRuns({ routineId: routine.id, filter: 'all', limit: 20 }).runs.map((r) => r.id)
    expect(remainingIds).toEqual([deletedNew.id, liveOld.id])
    expect(getRun(deletedOld.id)).toBeNull()
    expect(getRun(skippedNull.id)).toBeNull()
  })

  it('persists proposals and routine settings with defaults across restart', () => {
    expect(getRoutineSettings()).toEqual({ keepRunning: true, openAtLogin: false })
    setRoutineSettings({ keepRunning: false, openAtLogin: true })

    insertConversation(makeStandalone('chat-1'))
    const proposal = createProposal('chat-1', sampleDraft(), 5000)
    expect(proposal.state).toBe('pending')

    const routine = createRoutine(sampleDraft(), { conversationId: 'chat-1', title: 'chat-1', via: 'proposal' }, 6000)
    const created = setProposalState(proposal.id, 'created', routine.id, 6100)
    expect(created?.state).toBe('created')
    expect(created?.routineId).toBe(routine.id)

    restartDb()
    expect(getRoutineSettings()).toEqual({ keepRunning: false, openAtLogin: true })
    expect(getProposal(proposal.id)?.state).toBe('created')
    expect(getDb().prepare('SELECT COUNT(*) as c FROM local_routines').get()).toEqual({ c: 1 })
  })

  it('hides routine run conversations from standalone lists and conversation attention', () => {
    insertConversation(makeStandalone('normal-chat'))
    insertConversation(
      makeStandalone('run-chat', {
        routineId: 'r-1',
        routineRunId: 'run-1',
      })
    )
    markConversationAttention('normal-chat')
    markConversationAttention('run-chat')

    expect(listStandaloneConversations().map((c) => c.id)).toEqual(['normal-chat'])
    expect(listConversationAttention()).toEqual(['normal-chat'])
  })

  it('computes alerting rules according to notify policy', () => {
    expect(isAlerting({ status: 'failed' }, 'none')).toBe(true)
    expect(isAlerting({ status: 'waiting' }, 'none')).toBe(true)
    expect(isAlerting({ status: 'notable' }, 'none')).toBe(false)
    expect(isAlerting({ status: 'notable' }, 'notable')).toBe(true)
    expect(isAlerting({ status: 'nothing_new' }, 'notable')).toBe(false)
    expect(isAlerting({ status: 'done' }, 'notable')).toBe(false)
    expect(isAlerting({ status: 'nothing_new' }, 'all')).toBe(true)
    expect(isAlerting({ status: 'done' }, 'all')).toBe(true)
    expect(isAlerting({ status: 'skipped_closed' }, 'all')).toBe(false)
    expect(isAlerting({ status: 'stopped' }, 'all')).toBe(false)
  })

  it('persists origin and proposal places, and computes routine health summary', () => {
    expect(getRoutineHealthSummary()).toEqual({ enabled: 0, nextRunAt: null })

    const routine = createRoutine(sampleDraft(), {
      conversationId: 'conv-origin',
      title: 'Origin chat',
      via: 'proposal',
      deviceId: 'device-1',
    })
    expect(getRoutine(routine.id)?.origin).toEqual({
      conversationId: 'conv-origin',
      title: 'Origin chat',
      via: 'proposal',
      deviceId: 'device-1',
    })

    const second = createRoutine(
      { ...sampleDraft(), title: 'Earlier routine' },
      null
    )
    setNextRunAt(routine.id, 20_000)
    setNextRunAt(second.id, 10_000)
    expect(getRoutineHealthSummary()).toEqual({ enabled: 2, nextRunAt: 10_000 })

    setRoutineEnabled(second.id, false)
    expect(getRoutineHealthSummary()).toEqual({ enabled: 1, nextRunAt: 20_000 })

    setRoutineEnabled(routine.id, false)
    expect(getRoutineHealthSummary()).toEqual({ enabled: 0, nextRunAt: null })

    insertConversation(makeStandalone('conv-origin'))
    const proposal = createProposal('conv-origin', sampleDraft())
    const updated = setProposalState(proposal.id, 'created', routine.id, Date.now(), { hostId: 'server-1/workspaces' })
    expect(updated?.state).toBe('created')
    expect(updated?.routineId).toBe(routine.id)
    expect(getProposal(proposal.id)?.routinePlace).toEqual({ hostId: 'server-1/workspaces' })
    setProposalState(proposal.id, 'created', routine.id, Date.now(), { deviceId: 'device-1' })
    expect(getProposal(proposal.id)?.routinePlace).toEqual({ deviceId: 'device-1' })
  })
})
