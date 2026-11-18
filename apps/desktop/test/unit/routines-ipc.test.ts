import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { closeDb, freshDb } from '../helpers/db'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import type { LocalRoutineRun, RoutineDraft, RoutineRunTrigger } from '../../src/shared/routines'
import { permissionScopeKey } from '../../src/shared/conversation-scope'
import type { StandaloneConversation } from '../../src/shared/conversation'
import { insertConversation, getDb } from '../../src/main/store'
import {
  createProposal,
  createRoutine,
  getProposal,
  getRoutine,
  getRun,
  insertRun,
  updateRun,
} from '../../src/main/routines/store'
import { registerRoutinesIpc } from '../../src/main/routines/ipc'

function makeHarness() {
  const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const mhandles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const reg: IpcRegistrar = {
    handle: (ch, fn) => void handles.set(ch, fn),
    mhandle: (ch, fn) => void mhandles.set(ch, fn),
    on: () => {},
    mon: () => {},
  }
  const applyLoginItem = vi.fn()
  const onEnabledChanged = vi.fn()
  const openFolder = vi.fn(async () => '')
  const onRunSeen = vi.fn()
  const runner = {
    start: vi.fn(async (routineId: string, trigger: RoutineRunTrigger, scheduledAt: number): Promise<LocalRoutineRun> => ({
      id: 'run-mock',
      routineId,
      scheduledAt,
      startedAt: scheduledAt,
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
    })),
    stop: vi.fn(),
  }
  registerRoutinesIpc(reg, {
    getRunner: () => runner,
    applyLoginItem,
    onEnabledChanged,
    openFolder,
    onRunSeen,
  })
  const ev = {} as IpcMainInvokeEvent
  const invoke = async <T = unknown>(ch: string, ...args: unknown[]): Promise<T> => {
    const fn = handles.get(ch) ?? mhandles.get(ch)
    if (!fn) throw new Error(`Missing handler for ${ch}`)
    return (await fn(ev, ...args)) as T
  }
  return { handles, mhandles, invoke, applyLoginItem, onEnabledChanged, openFolder, onRunSeen, runner }
}

function sampleDraft(overrides: Partial<RoutineDraft> = {}): RoutineDraft {
  return {
    title: 'Price watch',
    instruction: 'Check flight prices.',
    schedule: { kind: 'weekly', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'America/Sao_Paulo' },
    permMode: 'auto',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', reasoning: 'medium', fastMode: false },
    notify: 'notable',
    missed: 'catchup',
    retentionDays: 30,
    ...overrides,
  }
}

function makeConv(id = 'conv-1'): StandaloneConversation {
  const conv: StandaloneConversation = {
    id,
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    name: 'Trip to Lisbon',
    cwd: '/tmp/trip',
    status: 'idle',
    createdAt: 1000,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 1000,
  }
  insertConversation(conv)
  return conv
}

beforeEach(freshDb)
afterEach(() => {
  closeDb()
})

describe('registerRoutinesIpc', () => {
  it('registers reads on handle and mutations on mhandle and supports full CRUD + duplicate', async () => {
    const h = makeHarness()
    expect(h.handles.has('routines:list')).toBe(true)
    expect(h.handles.has('routines:get')).toBe(true)
    expect(h.mhandles.has('routines:create')).toBe(true)
    expect(h.mhandles.has('routines:update')).toBe(true)
    expect(h.mhandles.has('routines:delete')).toBe(true)
    expect(h.mhandles.has('routines:duplicate')).toBe(true)
    expect(h.mhandles.has('routines:createFromProposal')).toBe(true)

    const created = await h.invoke<ReturnType<typeof createRoutine>>('routines:create', sampleDraft())
    expect(created.title).toBe('Price watch')
    expect(created.enabled).toBe(true)
    expect(h.onEnabledChanged).toHaveBeenCalledTimes(1)

    const list = await h.invoke<ReturnType<typeof createRoutine>[]>('routines:list')
    expect(list.map((r) => r.id)).toEqual([created.id])

    const updated = await h.invoke<ReturnType<typeof createRoutine>>('routines:update', created.id, {
      title: 'Updated watch',
    })
    expect(updated.title).toBe('Updated watch')

    // Seed saved permission and verify duplicate starts paused + copies saved permissions
    getDb()
      .prepare('INSERT INTO permission_saved (id, project_id, action, resource) VALUES (?, ?, ?, ?)')
      .run('perm-1', permissionScopeKey({ kind: 'routine', id: created.id }), 'bash', 'npm test')

    const copy = await h.invoke<ReturnType<typeof createRoutine>>('routines:duplicate', created.id)
    expect(copy.id).not.toBe(created.id)
    expect(copy.enabled).toBe(false)
    expect(copy.origin).toBeNull()
    expect(copy.title).toContain('Updated watch')

    const copyPerms = await h.invoke<Array<{ id: string; resource: string }>>(
      'routines:listSavedPermissions',
      copy.id
    )
    expect(copyPerms).toHaveLength(1)
    expect(copyPerms[0].resource).toBe('npm test')

    expect(await h.invoke('routines:removeSavedPermission', copy.id, copyPerms[0].id)).toBe(true)
    expect(await h.invoke('routines:listSavedPermissions', copy.id)).toEqual([])

    const paused = await h.invoke<ReturnType<typeof createRoutine>>('routines:setEnabled', created.id, false)
    expect(paused.enabled).toBe(false)

    await h.invoke('routines:openFolder', created.id)
    expect(h.openFolder).toHaveBeenCalledWith(created.folder)

    expect(await h.invoke('routines:delete', created.id)).toBe(true)
    expect(getRoutine(created.id)).toBeNull()
  })

  it('enforces pending-only proposal transitions and marks runs seen except waiting runs', async () => {
    const h = makeHarness()
    const conv = makeConv('conv-origin')
    const proposal = createProposal(conv.id, sampleDraft({ title: 'Proposed watch' }), 1000)

    const fetched = await h.invoke<ReturnType<typeof getProposal>>('routines:getProposal', proposal.id)
    expect(fetched?.state).toBe('pending')

    await h.invoke('routines:discardProposal', proposal.id)
    expect(getProposal(proposal.id)?.state).toBe('discarded')

    // Discarded proposal cannot create directly
    await expect(h.invoke('routines:createFromProposal', proposal.id)).rejects.toThrow()

    await h.invoke('routines:restoreProposal', proposal.id)
    expect(getProposal(proposal.id)?.state).toBe('pending')

    const routine = await h.invoke<ReturnType<typeof createRoutine>>(
      'routines:createFromProposal',
      proposal.id,
      sampleDraft({ title: 'Adjusted watch' })
    )
    expect(routine.title).toBe('Adjusted watch')
    expect(routine.origin).toEqual({ conversationId: conv.id, title: 'Trip to Lisbon', via: 'proposal' })
    expect(getProposal(proposal.id)?.state).toBe('created')
    expect(getProposal(proposal.id)?.routineId).toBe(routine.id)

    // Cannot create twice from the same proposal
    await expect(h.invoke('routines:createFromProposal', proposal.id)).rejects.toThrow()

    const waitingRun = insertRun({
      routineId: routine.id,
      scheduledAt: 2000,
      startedAt: 2000,
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
    const doneRun = insertRun({
      routineId: routine.id,
      scheduledAt: 3000,
      startedAt: 3000,
      finishedAt: 3100,
      trigger: 'manual',
      status: 'notable',
      summary: 'Found deal',
      report: null,
      error: null,
      conversationId: null,
      conversationDeleted: false,
      pinned: false,
      unread: true,
    })

    // Waiting run keeps unread=true
    await h.invoke('routines:markRunSeen', waitingRun.id)
    expect(getRun(waitingRun.id)?.unread).toBe(true)
    expect(h.onRunSeen).toHaveBeenCalledWith(waitingRun.id)

    // Non-waiting run becomes unread=false
    await h.invoke('routines:markRunSeen', doneRun.id)
    expect(getRun(doneRun.id)?.unread).toBe(false)

    await h.invoke('routines:runNow', routine.id)
    expect(h.runner.start).toHaveBeenCalledWith(routine.id, 'manual', expect.any(Number))
    await h.invoke('routines:stopRun', doneRun.id)
    expect(h.runner.stop).toHaveBeenCalledWith(doneRun.id)

    await h.invoke('routines:setSettings', { keepRunning: false, openAtLogin: true })
    expect(h.applyLoginItem).toHaveBeenCalledWith(true)
    expect(await h.invoke('routines:getSettings')).toEqual({ keepRunning: false, openAtLogin: true })
  })

  it('returns run details with its linked conversation when not deleted', async () => {
    const h = makeHarness()
    const routine = createRoutine(sampleDraft(), null)
    const runConv = makeConv('conv-run-1')
    getDb()
      .prepare('UPDATE conversations SET routine_id = ?, routine_run_id = ? WHERE id = ?')
      .run(routine.id, 'pending-run', runConv.id)
    const run = insertRun({
      routineId: routine.id,
      scheduledAt: 4000,
      startedAt: 4000,
      finishedAt: 4500,
      trigger: 'schedule',
      status: 'notable',
      summary: 'Price dropped',
      report: null,
      error: null,
      conversationId: runConv.id,
      conversationDeleted: false,
      pinned: false,
      unread: true,
    })
    getDb().prepare('UPDATE conversations SET routine_run_id = ? WHERE id = ?').run(run.id, runConv.id)

    expect(await h.invoke('routines:getRun', 'missing-run')).toBeNull()

    const details = await h.invoke<{ run: LocalRoutineRun; conversation: StandaloneConversation | null }>(
      'routines:getRun',
      run.id
    )
    expect(details.run.id).toBe(run.id)
    expect(details.conversation?.id).toBe(runConv.id)
    expect(details.conversation?.routineRunId).toBe(run.id)

    updateRun(run.id, { conversationDeleted: true })
    const deletedDetails = await h.invoke<{ run: LocalRoutineRun; conversation: StandaloneConversation | null }>(
      'routines:getRun',
      run.id
    )
    expect(deletedDetails.run.conversationDeleted).toBe(true)
    expect(deletedDetails.conversation).toBeNull()
  })
})
