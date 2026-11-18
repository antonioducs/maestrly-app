import fs from 'node:fs'
import { shell } from 'electron'
import { z } from 'zod'
import { permissionScopeKey } from '../../shared/conversation-scope'
import {
  ROUTINE_LIMITS,
  routineDraftSchema,
  routineIdSchema,
  routineListRunsSchema,
  routineOriginSchema,
  routineRunsInRangeSchema,
  routineSettingsSchema,
  routineUpdateSchema,
} from '../../shared/routines'
import { copySavedPermissions, deleteSavedPermission, listSavedPermissions } from '../chat/permission'
import { tMain } from '../i18n'
import type { IpcRegistrar } from '../ipc-registrar'
import { getConversation } from '../store'
import { deleteRoutineRunConversation, deleteRoutineWithData, type RoutineRunner } from './runner'
import {
  createRoutine,
  duplicateRoutine,
  getProposal,
  getRoutine,
  getRoutineSettings,
  getRun,
  listRoutines,
  listRuns,
  runsInRange,
  setProposalState,
  setRoutineEnabled,
  setRoutineSettings,
  updateRoutine,
  updateRun,
} from './store'

export interface RoutinesIpcDeps {
  getRunner?: () => Pick<RoutineRunner, 'start' | 'stop'> | null
  applyLoginItem?: (openAtLogin: boolean) => void
  onEnabledChanged?: () => void
  openFolder?: (folder: string) => Promise<string>
  onRunSeen?: (runId: string) => void
}

const DUPLICATE_SUFFIX_FALLBACK = ' (copy)'

function buildCopyTitle(sourceTitle: string): string {
  const suffix = tMain('main')('routines.copySuffix') || DUPLICATE_SUFFIX_FALLBACK
  const maxBase = Math.max(1, ROUTINE_LIMITS.titleMax - suffix.length)
  return `${sourceTitle.slice(0, maxBase)}${suffix}`
}

export function registerRoutinesIpc(reg: IpcRegistrar, deps: RoutinesIpcDeps = {}): void {
  reg.handle('routines:list', () => listRoutines())

  reg.handle('routines:get', (_event, id: unknown) => getRoutine(routineIdSchema.parse(id)))

  reg.mhandle('routines:create', (_event, draft: unknown, origin?: unknown) => {
    const parsedDraft = routineDraftSchema.parse(draft)
    const parsedOrigin = origin != null ? routineOriginSchema.parse(origin) : null
    const routine = createRoutine(parsedDraft, parsedOrigin)
    deps.onEnabledChanged?.()
    return routine
  })

  reg.mhandle('routines:update', (_event, id: unknown, patch: unknown) => {
    const routineId = routineIdSchema.parse(id)
    const parsedPatch = routineUpdateSchema.parse(patch)
    const updated = updateRoutine(routineId, parsedPatch)
    if (parsedPatch.schedule !== undefined) deps.onEnabledChanged?.()
    return updated
  })

  reg.mhandle('routines:delete', async (_event, id: unknown) => {
    const routineId = routineIdSchema.parse(id)
    const deleted = await deleteRoutineWithData(routineId, (deps.getRunner?.() as RoutineRunner | null) ?? undefined)
    if (deleted) deps.onEnabledChanged?.()
    return deleted
  })

  reg.mhandle('routines:duplicate', (_event, id: unknown) => {
    const sourceId = routineIdSchema.parse(id)
    const source = getRoutine(sourceId)
    if (!source) throw new Error('Routine not found.')
    const copy = duplicateRoutine(sourceId, buildCopyTitle(source.title))
    copySavedPermissions(
      permissionScopeKey({ kind: 'routine', id: sourceId }),
      permissionScopeKey({ kind: 'routine', id: copy.id })
    )
    deps.onEnabledChanged?.()
    return copy
  })

  reg.mhandle('routines:setEnabled', (_event, id: unknown, enabled: unknown) => {
    const routineId = routineIdSchema.parse(id)
    const nextEnabled = z.boolean().parse(enabled)
    const updated = setRoutineEnabled(routineId, nextEnabled)
    deps.onEnabledChanged?.()
    return updated
  })

  reg.mhandle('routines:runNow', async (_event, id: unknown) => {
    const routineId = routineIdSchema.parse(id)
    const runner = deps.getRunner?.()
    if (!runner) throw new Error('Routine runner unavailable.')
    return runner.start(routineId, 'manual', Date.now())
  })

  reg.mhandle('routines:stopRun', (_event, runId: unknown) => {
    const parsedRunId = routineIdSchema.parse(runId)
    deps.getRunner?.()?.stop(parsedRunId)
  })

  reg.handle('routines:listRuns', (_event, input: unknown) => listRuns(routineListRunsSchema.parse(input)))

  reg.handle('routines:runsInRange', (_event, input: unknown) => {
    const { from, to } = routineRunsInRangeSchema.parse(input)
    return runsInRange(from, to)
  })

  reg.handle('routines:getRun', (_event, runId: unknown) => {
    const id = routineIdSchema.parse(runId)
    const run = getRun(id)
    if (!run) return null
    if (!run.conversationId || run.conversationDeleted) return { run, conversation: null }
    const conv = getConversation(run.conversationId)
    const conversation = conv?.scope === 'standalone' && conv.routineRunId === run.id ? conv : null
    return { run, conversation }
  })

  reg.mhandle('routines:pinRun', (_event, runId: unknown, pinned: unknown) =>
    updateRun(routineIdSchema.parse(runId), { pinned: z.boolean().parse(pinned) })
  )

  reg.mhandle('routines:deleteRunConversation', (_event, runId: unknown) =>
    deleteRoutineRunConversation(routineIdSchema.parse(runId))
  )

  reg.mhandle('routines:markRunSeen', (_event, runId: unknown) => {
    const id = routineIdSchema.parse(runId)
    const run = getRun(id)
    if (!run) return null
    deps.onRunSeen?.(id)
    if (run.status === 'waiting') return run
    return updateRun(id, { unread: false })
  })

  reg.handle('routines:listSavedPermissions', (_event, routineId: unknown) => {
    const id = routineIdSchema.parse(routineId)
    return listSavedPermissions(permissionScopeKey({ kind: 'routine', id }))
  })

  reg.mhandle('routines:removeSavedPermission', (_event, routineId: unknown, permId: unknown) => {
    const id = routineIdSchema.parse(routineId)
    const permissionId = routineIdSchema.parse(permId)
    return deleteSavedPermission(permissionId, permissionScopeKey({ kind: 'routine', id }))
  })

  reg.mhandle('routines:openFolder', async (_event, routineId: unknown) => {
    const id = routineIdSchema.parse(routineId)
    const routine = getRoutine(id)
    if (!routine) throw new Error('Routine not found.')
    fs.mkdirSync(routine.folder, { recursive: true, mode: 0o700 })
    return (deps.openFolder ?? ((folder) => shell.openPath(folder)))(routine.folder)
  })

  reg.handle('routines:getProposal', (_event, proposalId: unknown) =>
    getProposal(routineIdSchema.parse(proposalId))
  )

  reg.mhandle('routines:createFromProposal', (_event, proposalId: unknown, draftOverride?: unknown) => {
    const id = routineIdSchema.parse(proposalId)
    const proposal = getProposal(id)
    if (!proposal) throw new Error('Routine proposal not found.')
    if (proposal.state !== 'pending') throw new Error('Routine proposal is not pending.')
    const draft = draftOverride !== undefined ? routineDraftSchema.parse(draftOverride) : proposal.draft
    const conv = getConversation(proposal.conversationId)
    const origin = conv
      ? { conversationId: conv.id, title: conv.name || 'Chat', via: 'proposal' as const }
      : { conversationId: proposal.conversationId, title: 'Chat', via: 'proposal' as const }
    const routine = createRoutine(draft, origin)
    setProposalState(proposal.id, 'created', routine.id)
    deps.onEnabledChanged?.()
    return routine
  })

  reg.mhandle('routines:discardProposal', (_event, proposalId: unknown) => {
    const id = routineIdSchema.parse(proposalId)
    const proposal = getProposal(id)
    if (!proposal) return null
    if (proposal.state !== 'pending') return proposal
    return setProposalState(id, 'discarded', null)
  })

  reg.mhandle('routines:restoreProposal', (_event, proposalId: unknown) => {
    const id = routineIdSchema.parse(proposalId)
    const proposal = getProposal(id)
    if (!proposal) return null
    if (proposal.state !== 'discarded') return proposal
    return setProposalState(id, 'pending', null)
  })

  reg.handle('routines:getSettings', () => getRoutineSettings())

  reg.mhandle('routines:setSettings', (_event, patch: unknown) => {
    const parsedPatch = routineSettingsSchema.partial().parse(patch)
    const next = setRoutineSettings({ ...getRoutineSettings(), ...parsedPatch })
    if (parsedPatch.openAtLogin !== undefined) deps.applyLoginItem?.(next.openAtLogin)
    deps.onEnabledChanged?.()
    return next
  })
}
