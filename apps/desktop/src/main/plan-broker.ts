import { autonomousPolicy,AutonomousInteractionError } from './chat/autonomous'
import { emitChatHost } from './chat/host-events'
import * as windowIpc from './window-ipc'
import { getLocale } from './store'
import { tFor } from './i18n'
import type { StandardPlanHandoff } from '../shared/conversation-dispatch'
import { stripProposedPlanTag } from './chat/plans/context'

/**
 * Chat plan-review broker. review_plan stages the plan without blocking the turn; the user's IPC
 * decision starts a new turn.
 */

export interface PlanLineComment {
  line: number
  text: string
}

export interface PlanDecision {
  action: 'approve' | 'revise' | 'discard'
  /**
   * Omission keeps approval in the current conversation; Maestro creates a sibling for implementation; Standard
   * starts a new Standard conversation with the settings in `standardHandoff`.
   */
  implementationTarget?: 'source' | 'maestro' | 'standard'
  /** Opaque Maestro strategy-profile ID resolved only in main. */
  maestroStrategyProfileId?: string
  /** Destination model/effort/Fast and placement; validated in main, only with implementationTarget 'standard'. */
  standardHandoff?: StandardPlanHandoff
  editedPlan?: string
  feedback?: string
  lineComments?: PlanLineComment[]
}

/** Decision result returned to IPC, which starts an approval/revision turn. */
export interface PlanDecisionResult {
  action: 'approve' | 'revise' | 'discard'
  /** Final approved plan, with edits taking priority; present only for approve. */
  approvedPlan?: string
  /** Version and title of the decided plan; present only for approve (names and keys a handoff). */
  version?: number
  title?: string
  /** Feedback for the model to revise the plan; present only for revise. */
  feedbackText?: string
  /** Version whose next submission should release the review's source reservation. */
  revisionVersion?: number
}

export interface PlanSubmitInput {
  agentId: string
  cwd: string
  plan: string
  sessionId?: string
  planFilePath?: string
  title?: string
}

/** Renderer payload when a plan arrives for review. */
export interface PlanReceived {
  agentId: string
  cwd: string
  plan: string
  planFilePath?: string
  title?: string
  version: number
  previousPlan: string | null
}

interface Pending extends PlanSubmitInput {
  version: number
  done: boolean
  /** Previous plan for revision diff, frozen at submission to reconstruct PlanReceived. */
  previousPlan: string | null
  /** Final text of a prepared approval (edits applied), recorded once the decision commits. */
  approvedPlan?: string
}

/** Durable record of staged plans and their decisions; the broker itself only holds the review in progress. */
export interface PlanRecorder {
  staged(agentId: string, plan: { version: number; title?: string; content: string }): void
  decided(agentId: string, decision: { action: PlanDecision['action']; content: string }): void
}

let recorder: PlanRecorder | null = null

export function setPlanRecorder(next: PlanRecorder | null): void {
  recorder = next
}

function record(write: (target: PlanRecorder) => void): void {
  if (!recorder) return
  try {
    write(recorder)
  } catch {
    // The record serves later compactions; a failed write never blocks the review itself.
  }
}

interface RevisionReservation {
  version: number
}

// Notify through a callback when a new plan arrives so an alert can play without coupling to AgentRegistry.
let onPlanReceived: ((agentId: string) => void) | null = null
const pending = new Map<string, Pending>() // agentId to plan awaiting a decision
const lastPlan = new Map<string, { plan: string; version: number }>() // p/ versionar (diff)
/** Reserve the source between revise and the next version, independently of visible pending plans. */
const revisionReservations = new Map<string, RevisionReservation>()

function emitPlanEvent(agentId: string, channel: string, payload: unknown): void {
  emitChatHost(agentId,channel,payload)
  // The main renderer still needs the event to focus the conversation; the plan panel receives the
  // same event directly so an unrelated conversation does not wake every panel renderer.
  if (typeof windowIpc.sendToConversation === 'function') {
    windowIpc.sendToConversation(agentId, channel, payload, { panel: 'plan' })
  } else {
    // Legacy/unit harnesses only expose broadcast.
    windowIpc.broadcast(channel, payload)
  }
}

export function initPlanBroker(onReceived?: (agentId: string) => void): void {
  onPlanReceived = onReceived ?? null
}

/** Stage a plan, replacing a still-pending earlier version. */
function registerPlan(input: PlanSubmitInput): void {
  if(autonomousPolicy(input.agentId))throw new AutonomousInteractionError()
  const old = pending.get(input.agentId)
  const prev = lastPlan.get(input.agentId)
  const version = (prev?.version ?? 0) + 1

  // Resubmission before the previous decision cancels the old version.
  if (old && !old.done) old.done = true

  const previousPlan = prev?.plan ?? null
  const entry: Pending = { ...input, version, done: false, previousPlan }
  pending.set(input.agentId, entry)
  lastPlan.set(input.agentId, { plan: input.plan, version })
  record((target) => target.staged(input.agentId, { version, title: input.title, content: input.plan }))
  // The next accepted version resumes the cycle and consumes the reservation.
  revisionReservations.delete(input.agentId)
  const payload: PlanReceived = {
    agentId: input.agentId,
    cwd: input.cwd,
    plan: input.plan,
    planFilePath: input.planFilePath,
    title: input.title,
    version,
    previousPlan,
  }
  // Broadcast to mainWindow for App indicators/drawer opening and to the docked/floating plan panel.
  emitPlanEvent(input.agentId, 'plan:received', payload)
  onPlanReceived?.(input.agentId) // alert respects sound settings and registry deduplication
}

/**
 * Chat review_plan stages and notifies UI immediately; the runner ends at the step boundary. The
 * user's decision starts a new turn with current model/mode through decidePlan and plan-ipc. No
 * pending Promise or timeout is held here.
 */
export function stagePlan(input: PlanSubmitInput): void {
  registerPlan({ ...input, plan: stripProposedPlanTag(input.plan) })
}

export { stripProposedPlanTag }

/**
 * Pending conversation plan or null, used to hydrate a panel that mounts after plan:received opens the
 * drawer.
 */
export function getPending(agentId: string): PlanReceived | null {
  const p = pending.get(agentId)
  if (!p || p.done) return null
  return {
    agentId: p.agentId,
    cwd: p.cwd,
    plan: p.plan,
    planFilePath: p.planFilePath,
    title: p.title,
    version: p.version,
    previousPlan: p.previousPlan,
  }
}

/** User decision whose result IPC uses to start the next turn. */
export function decidePlan(
  agentId: string,
  decision: PlanDecision,
  options?: { deferCommit?: boolean }
): PlanDecisionResult | null {
  const entry = pending.get(agentId)
  if (!entry || entry.done) return null
  const result =
    decision.action === 'approve'
      ? {
          action: 'approve' as const,
          approvedPlan: finalApprovedPlan(entry, decision),
          version: entry.version,
          ...(entry.title ? { title: entry.title } : {}),
        }
      : decision.action === 'revise'
        ? {
            action: 'revise' as const,
            feedbackText: buildFeedback(entry, decision),
            revisionVersion: entry.version,
          }
        : { action: 'discard' as const }
  entry.approvedPlan = result.action === 'approve' ? result.approvedPlan : undefined
  if (!options?.deferCommit) commitPlanDecision(agentId, decision.action)
  return result
}

/**
 * Finalize a prepared decision once the handoff it starts is ready, so a failed handoff leaves the plan pending.
 */
export function commitPlanDecision(agentId: string, action: PlanDecision['action']): boolean {
  const entry = pending.get(agentId)
  if (!entry || entry.done) return false
  entry.done = true
  pending.delete(agentId)
  const content = action === 'approve' ? (entry.approvedPlan ?? entry.plan) : entry.plan
  record((target) => target.decided(agentId, { action, content }))
  if (action === 'revise') {
    // Clear pending state while retaining source ownership until the next accepted version.
    revisionReservations.set(agentId, { version: entry.version })
  } else {
    // Approval/discard ends the cycle; reset versions so a later unrelated plan starts without a stale
    // diff.
    revisionReservations.delete(agentId)
    lastPlan.delete(agentId)
  }
  emitPlanEvent(agentId, 'plan:cleared', { agentId })
  return true
}

/** Release a failed/canceled revision before its next version. */
export function releasePlanRevision(agentId: string, expectedVersion?: number): boolean {
  const reservation = revisionReservations.get(agentId)
  if (!reservation || (expectedVersion !== undefined && reservation.version !== expectedVersion)) return false
  revisionReservations.delete(agentId)
  lastPlan.delete(agentId)
  return true
}

/** Clear the staged plan when the conversation closes, archives, or is deleted. */
export function clearPlan(agentId: string): void {
  const entry = pending.get(agentId)
  if (entry && !entry.done) entry.done = true
  pending.delete(agentId)
  revisionReservations.delete(agentId)
  lastPlan.delete(agentId)
  emitPlanEvent(agentId, 'plan:cleared', { agentId })
}

/** Effective approved plan: nonempty edits win; empty/unchanged edits retain the submission. */
function finalApprovedPlan(entry: Pending, d: PlanDecision): string {
  const edited = d.editedPlan?.trim()
  return edited && edited !== entry.plan.trim() ? edited : entry.plan.trim()
}

function buildFeedback(entry: Pending, d: PlanDecision): string {
  const t = tFor(getLocale(), 'prompts')
  const parts: string[] = [t('planBroker.feedbackIntro')]
  if (d.feedback?.trim()) parts.push(`\n${t('planBroker.feedbackGeneralHeading')}\n${d.feedback.trim()}`)
  if (d.lineComments?.length) {
    const lines = entry.plan.split('\n')
    parts.push(`\n${t('planBroker.feedbackLineHeading')}`)
    for (const c of d.lineComments) {
      const ref = lines[c.line - 1]?.trim() || t('planBroker.feedbackLineFallback', { line: c.line })
      parts.push(`- ${t('planBroker.feedbackLineItem', { ref, text: c.text })}`)
    }
  }
  const edited = d.editedPlan?.trim()
  if (edited && edited !== entry.plan.trim()) {
    parts.push(`\n${t('planBroker.feedbackEditedHeading')}\n${edited}`)
  }
  return parts.join('\n')
}
