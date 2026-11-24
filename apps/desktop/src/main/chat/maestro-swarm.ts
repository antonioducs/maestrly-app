import { randomUUID } from 'node:crypto'
import type { MessagePart } from '../../shared/chat'
import type { ChatBehavior } from '../../shared/conversation-experience'
import { transaction } from '../store/db'
import { getConversation } from '../store/conversations'
import {
  findMaestroSwarmTaskByConversation,
  getMaestroSwarmTask,
  listMaestroSwarmTasks,
  upsertMaestroSwarmTask,
} from '../store/maestro-swarm'
import {
  renderMaestroSwarmState,
  type MaestroSwarmChangesReason,
  type MaestroSwarmPhase,
  type MaestroSwarmTask,
  type MaestroSwarmTaskUpdate,
} from '../../shared/maestro-swarm'

const AGENT_OWNED_PHASES = new Set<string>(['queued', 'reviewing', 'changes', 'blocked'])
const VALID_CHANGES_REASONS = new Set<string>(['review', 'conflict'])
const WORKER_TURN_RESTARTABLE_PHASES = new Set<MaestroSwarmPhase>(['changes', 'delivered', 'reviewing', 'blocked'])

let swarmListener: ((orchestratorId: string) => void) | null = null

export function setMaestroSwarmListener(listener: ((orchestratorId: string) => void) | null): void {
  swarmListener = listener
}

function notify(orchestratorId: string): void {
  if (!swarmListener) return
  try {
    swarmListener(orchestratorId)
  } catch {
    // A throwing listener must never break the state transition.
  }
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function listSwarm(orchestratorId: string): MaestroSwarmTask[] {
  return listMaestroSwarmTasks(orchestratorId)
}

export function declareSwarmTasks(
  orchestratorId: string,
  updates: MaestroSwarmTaskUpdate[]
): { ok: true; tasks: MaestroSwarmTask[] } | { ok: false; error: string } {
  if (updates.length === 0) {
    return { ok: true, tasks: listMaestroSwarmTasks(orchestratorId) }
  }

  let error: string | null = null
  let changed = false

  transaction(() => {
    const staged = new Map<string, MaestroSwarmTask>()
    for (const task of listMaestroSwarmTasks(orchestratorId)) {
      staged.set(task.key, task)
    }

    const touched: string[] = []
    const touchedSet = new Set<string>()
    const markTouched = (key: string): void => {
      if (!touchedSet.has(key)) {
        touchedSet.add(key)
        touched.push(key)
      }
    }

    const now = Date.now()

    for (const update of updates) {
      const key = typeof update.key === 'string' ? update.key.trim() : ''
      if (!key) {
        error = 'key is required'
        return
      }

      if (update.phase !== undefined && !AGENT_OWNED_PHASES.has(update.phase)) {
        error = `${update.phase} is set by the host`
        return
      }

      const existing = staged.get(key)

      if (existing && existing.phase === 'merged') {
        const nextResourceId = update.agent !== undefined ? update.agent || null : existing.resourceId
        const mutatesNonNote =
          update.phase !== undefined ||
          update.reason !== undefined ||
          (update.title !== undefined && update.title !== existing.title) ||
          nextResourceId !== existing.resourceId ||
          (update.dependsOn !== undefined && !sameStringArray(update.dependsOn, existing.dependsOn))
        if (mutatesNonNote) {
          error = `${key} is already merged`
          return
        }
        if (update.note !== undefined) {
          const nextNote = update.note || null
          if (nextNote !== existing.note) {
            staged.set(key, { ...existing, note: nextNote, updatedAt: now })
            markTouched(key)
          }
        }
        continue
      }

      if (update.phase === 'changes' && (!update.reason || !VALID_CHANGES_REASONS.has(update.reason))) {
        error = 'changes requires a reason (review or conflict)'
        return
      }

      if (!existing) {
        if (!update.title?.trim()) {
          error = 'title is required for a new task'
          return
        }
        const phase: MaestroSwarmPhase = update.phase ?? 'queued'
        const changesReason: MaestroSwarmChangesReason | null =
          phase === 'changes' ? (update.reason as MaestroSwarmChangesReason) : null
        const created: MaestroSwarmTask = {
          orchestratorConversationId: orchestratorId,
          key,
          title: update.title,
          resourceId: update.agent ? update.agent : null,
          dependsOn: update.dependsOn ? [...update.dependsOn] : [],
          conversationId: null,
          branch: null,
          baseCommit: null,
          phase,
          changesReason,
          reviewRound: phase === 'changes' ? 1 : 0,
          note: update.note ? update.note : null,
          mergedCommit: null,
          createdAt: now,
          updatedAt: now,
        }
        staged.set(key, created)
        markTouched(key)
        continue
      }

      const nextTitle = update.title !== undefined ? update.title : existing.title
      const nextResourceId = update.agent !== undefined ? update.agent || null : existing.resourceId
      const nextDependsOn = update.dependsOn !== undefined ? [...update.dependsOn] : existing.dependsOn
      const nextNote = update.note !== undefined ? update.note || null : existing.note

      let nextPhase: MaestroSwarmPhase = existing.phase
      let nextChangesReason: MaestroSwarmChangesReason | null = existing.changesReason
      let nextReviewRound = existing.reviewRound

      if (update.phase === 'changes') {
        nextPhase = 'changes'
        nextChangesReason = update.reason as MaestroSwarmChangesReason
        nextReviewRound = existing.reviewRound + 1
      } else if (update.phase !== undefined) {
        nextPhase = update.phase
        nextChangesReason = null
      }

      const didChange =
        nextTitle !== existing.title ||
        nextResourceId !== existing.resourceId ||
        !sameStringArray(nextDependsOn, existing.dependsOn) ||
        nextNote !== existing.note ||
        nextPhase !== existing.phase ||
        nextChangesReason !== existing.changesReason ||
        nextReviewRound !== existing.reviewRound

      if (didChange) {
        staged.set(key, {
          ...existing,
          title: nextTitle,
          resourceId: nextResourceId,
          dependsOn: nextDependsOn,
          note: nextNote,
          phase: nextPhase,
          changesReason: nextChangesReason,
          reviewRound: nextReviewRound,
          updatedAt: now,
        })
        markTouched(key)
      }
    }

    for (const key of touched) {
      const task = staged.get(key)
      if (task) {
        upsertMaestroSwarmTask(task)
        changed = true
      }
    }
  })

  if (error !== null) {
    return { ok: false, error }
  }

  if (changed) notify(orchestratorId)
  return { ok: true, tasks: listMaestroSwarmTasks(orchestratorId) }
}

export function ensureSwarmTasks(
  orchestratorId: string,
  items: { key: string; title: string; resourceId: string }[]
): void {
  if (items.length === 0) return

  let changed = false
  transaction(() => {
    const now = Date.now()
    for (const item of items) {
      const existing = getMaestroSwarmTask(orchestratorId, item.key)
      const nextResourceId = item.resourceId || null
      if (!existing) {
        upsertMaestroSwarmTask({
          orchestratorConversationId: orchestratorId,
          key: item.key,
          title: item.title,
          resourceId: nextResourceId,
          dependsOn: [],
          conversationId: null,
          branch: null,
          baseCommit: null,
          phase: 'queued',
          changesReason: null,
          reviewRound: 0,
          note: null,
          mergedCommit: null,
          createdAt: now,
          updatedAt: now,
        })
        changed = true
      } else if (existing.phase !== 'merged' && existing.resourceId !== nextResourceId) {
        upsertMaestroSwarmTask({
          ...existing,
          resourceId: nextResourceId,
          updatedAt: now,
        })
        changed = true
      }
    }
  })

  if (changed) notify(orchestratorId)
}

export function onSwarmDispatchStarted(input: {
  orchestratorId: string
  requestKey: string
  conversationId: string
  branch: string | null
  baseCommit?: string | null
  title: string
}): void {
  const existing = getMaestroSwarmTask(input.orchestratorId, input.requestKey)
  if (!existing || existing.phase === 'merged') return

  upsertMaestroSwarmTask({
    ...existing,
    conversationId: input.conversationId,
    branch: input.branch,
    baseCommit: input.baseCommit ?? null,
    phase: 'implementing',
    changesReason: null,
    updatedAt: Date.now(),
  })
  notify(input.orchestratorId)
}

export function onSwarmWorkerTurnStarted(input: { fromConversationId: string; toConversationId: string }): void {
  const existing = findMaestroSwarmTaskByConversation(input.toConversationId, input.fromConversationId)
  if (!existing || !WORKER_TURN_RESTARTABLE_PHASES.has(existing.phase)) return

  upsertMaestroSwarmTask({
    ...existing,
    phase: 'implementing',
    changesReason: null,
    updatedAt: Date.now(),
  })
  notify(input.fromConversationId)
}

export function onSwarmWorkerResult(input: {
  orchestratorId: string
  workerConversationId: string
  status: string
}): void {
  const existing = findMaestroSwarmTaskByConversation(input.workerConversationId, input.orchestratorId)
  if (!existing || existing.phase === 'merged') return

  const isSuccess = input.status === 'success'
  upsertMaestroSwarmTask({
    ...existing,
    phase: isSuccess ? 'delivered' : 'failed',
    changesReason: null,
    note: isSuccess ? existing.note : input.status,
    updatedAt: Date.now(),
  })
  notify(input.orchestratorId)
}

export async function reconcileSwarmMerges(
  orchestratorId: string,
  git: {
    branchTip(branch: string): Promise<string | null>
    isAncestor(commit: string): Promise<boolean | null>
  }
): Promise<void> {
  const candidates = listMaestroSwarmTasks(orchestratorId).filter(
    (task) => task.branch && task.phase !== 'merged' && task.phase !== 'queued' && task.phase !== 'implementing'
  )
  if (candidates.length === 0) return

  const mergedCommits: { key: string; tip: string }[] = []
  for (const task of candidates) {
    if (!task.branch) continue
    const tip = await git.branchTip(task.branch)
    // A branch still at its dispatch base is trivially an ancestor of HEAD: the worker committed nothing to merge.
    if (!tip || tip === task.baseCommit) continue
    const ancestor = await git.isAncestor(tip)
    if (ancestor === true) {
      mergedCommits.push({ key: task.key, tip })
    }
  }

  if (mergedCommits.length === 0) return

  let changed = false
  transaction(() => {
    const now = Date.now()
    for (const { key, tip } of mergedCommits) {
      const current = getMaestroSwarmTask(orchestratorId, key)
      if (!current || current.phase === 'merged') continue
      upsertMaestroSwarmTask({
        ...current,
        phase: 'merged',
        changesReason: null,
        mergedCommit: tip,
        updatedAt: now,
      })
      changed = true
    }
  })

  if (changed) notify(orchestratorId)
}

export function stopSwarm(orchestratorId: string): { workerConversationIds: string[] } {
  const workerConversationIds: string[] = []
  let changed = false

  transaction(() => {
    const now = Date.now()
    for (const task of listMaestroSwarmTasks(orchestratorId)) {
      if (task.phase !== 'implementing') continue
      if (task.conversationId !== null) {
        workerConversationIds.push(task.conversationId)
      }
      upsertMaestroSwarmTask({
        ...task,
        phase: 'blocked',
        changesReason: null,
        note: 'stopped',
        updatedAt: now,
      })
      changed = true
    }
  })

  if (changed) notify(orchestratorId)
  return { workerConversationIds }
}

/** Hidden per-turn swarm state table for Maestro orchestrator conversations; null for non-Maestro or empty swarms. */
export function maestroSwarmStatePart(conversationId: string, behavior?: ChatBehavior): MessagePart | null {
  const isMaestro =
    behavior !== undefined ? behavior === 'maestro' : getConversation(conversationId)?.experience === 'maestro'
  if (!isMaestro) return null
  const data = renderMaestroSwarmState(listSwarm(conversationId))
  if (!data) return null
  return {
    type: 'file',
    id: randomUUID(),
    name: 'maestro-swarm.md',
    mediaType: 'text/markdown',
    kind: 'text',
    data,
    hidden: true,
  }
}
