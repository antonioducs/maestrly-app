import { autonomousPolicy,AutonomousInteractionError } from './chat/autonomous'
import { emitChatHost } from './chat/host-events'
import * as windowIpc from './window-ipc'
import { getLocale } from './store'
import { tFor } from './i18n'

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
  /** Omission keeps approval in the current conversation; Maestro creates a sibling for implementation. */
  implementationTarget?: 'source' | 'maestro'
  /** Opaque Maestro strategy-profile ID resolved only in main. */
  maestroStrategyProfileId?: string
  editedPlan?: string
  feedback?: string
  lineComments?: PlanLineComment[]
}

/** Decision result returned to IPC, which starts an approval/revision turn. */
export interface PlanDecisionResult {
  action: 'approve' | 'revise' | 'discard'
  /** Final approved plan, with edits taking priority; present only for approve. */
  approvedPlan?: string
  /** Feedback for the model to revise the plan; present only for revise. */
  feedbackText?: string
  /** Version whose next submission should release the review's source reservation. */
  revisionVersion?: number
  /** External routing frozen with the decided version; absent means legacy Maestrly Chat flow. */
  route?: ChatGptWebPlanOrigin
}

export interface MaestrlyChatPlanOrigin {
  kind: 'maestrly-chat'
}

export interface ChatGptWebPlanOrigin {
  kind: 'chatgpt-web'
  reviewId: string
}

export type PlanOrigin = MaestrlyChatPlanOrigin | ChatGptWebPlanOrigin
export type PlanLifecycleOutcome = 'superseded' | 'cancelled'

export interface PlanSubmitInput {
  agentId: string
  cwd: string
  plan: string
  sessionId?: string
  planFilePath?: string
  title?: string
  /** Omission preserves historical Maestrly Chat behavior. */
  origin?: PlanOrigin
  /**
   * Generic sink closes external channels on supersession/clear without coupling the broker to
   * Companion.
   */
  onLifecycle?: (outcome: PlanLifecycleOutcome) => void
}

export type PlanSubmitResult = { ok: true } | { ok: false; error: 'plan-origin-conflict' }

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
  origin: PlanOrigin
  version: number
  done: boolean
  /** Previous plan for revision diff, frozen at submission to reconstruct PlanReceived. */
  previousPlan: string | null
}

interface RevisionReservation {
  originKind: PlanOrigin['kind']
  version: number
}

// Notify through a callback when a new plan arrives so an alert can play without coupling to AgentRegistry.
let onPlanReceived: ((agentId: string) => void) | null = null
const pending = new Map<string, Pending>() // agentId to plan awaiting a decision
const lastPlan = new Map<string, { plan: string; version: number; originKind: PlanOrigin['kind'] }>() // p/ versionar (diff)
/** Reserve the source between revise and the next version, independently of visible pending plans. */
const revisionReservations = new Map<string, RevisionReservation>()

function notifyLifecycle(entry: Pending, outcome: PlanLifecycleOutcome): void {
  try {
    entry.onLifecycle?.(outcome)
  } catch {
    // A broken external sink must not prevent plan replacement or clearing.
  }
}

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
function registerPlan(input: PlanSubmitInput): PlanSubmitResult {
  if(autonomousPolicy(input.agentId))throw new AutonomousInteractionError()
  const origin: PlanOrigin = input.origin ?? { kind: 'maestrly-chat' }
  const reservation = revisionReservations.get(input.agentId)
  if (reservation && reservation.originKind !== origin.kind) {
    // The review cycle remains owned by the source that received revise, even without a visible pending
    // plan.
    return { ok: false, error: 'plan-origin-conflict' }
  }
  const old = pending.get(input.agentId)
  if (old && !old.done && old.origin.kind !== origin.kind) {
    // Channels share the visual surface but own separate decision cycles. Rejecting here preserves the
    // original pending plan and lets the caller return a recoverable error.
    return { ok: false, error: 'plan-origin-conflict' }
  }

  const previousCycle = lastPlan.get(input.agentId)
  const prev = previousCycle?.originKind === origin.kind ? previousCycle : undefined
  const version = (prev?.version ?? 0) + 1

  // Resubmission before the previous decision cancels the old version.
  if (old && !old.done) {
    old.done = true
    notifyLifecycle(old, 'superseded')
  }

  const previousPlan = prev?.plan ?? null
  const entry: Pending = { ...input, origin, version, done: false, previousPlan }
  pending.set(input.agentId, entry)
  lastPlan.set(input.agentId, { plan: input.plan, version, originKind: origin.kind })
  // The next accepted version from the reserved source resumes the cycle and consumes the reservation.
  if (reservation?.originKind === origin.kind) revisionReservations.delete(input.agentId)
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
  return { ok: true }
}

/**
 * Chat review_plan stages and notifies UI immediately; the runner ends at the step boundary. The
 * user's decision starts a new turn with current model/mode through decidePlan and plan-ipc. No
 * pending Promise or timeout is held here.
 */
export function stagePlan(input: PlanSubmitInput): PlanSubmitResult {
  return registerPlan(input)
}

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
  const route = entry.origin.kind === 'chatgpt-web' ? { route: entry.origin } : {}
  const result =
    decision.action === 'approve'
      ? { action: 'approve' as const, approvedPlan: finalApprovedPlan(entry, decision), ...route }
      : decision.action === 'revise'
        ? {
            action: 'revise' as const,
            feedbackText: buildFeedback(entry, decision),
            revisionVersion: entry.version,
            ...route,
          }
        : { action: 'discard' as const, ...route }
  if (!options?.deferCommit) commitPlanDecision(agentId, decision.action)
  return result
}

/**
 * Finalize a prepared decision after the web Companion confirms it, preserving pending state and
 * lifecycle callbacks if the external channel is unavailable.
 */
export function commitPlanDecision(agentId: string, action: PlanDecision['action']): boolean {
  const entry = pending.get(agentId)
  if (!entry || entry.done) return false
  entry.done = true
  pending.delete(agentId)
  if (action === 'revise') {
    // Clear pending state while retaining source ownership until the next accepted version.
    revisionReservations.set(agentId, { originKind: entry.origin.kind, version: entry.version })
  } else {
    // Approval/discard ends the cycle; reset versions so a later unrelated plan starts without a stale
    // diff.
    revisionReservations.delete(agentId)
    lastPlan.delete(agentId)
  }
  emitPlanEvent(agentId, 'plan:cleared', { agentId })
  return true
}

/** Release a failed/canceled revision before its next version, only for the owning source. */
export function releasePlanRevision(
  agentId: string,
  originKind: PlanOrigin['kind'],
  expectedVersion?: number
): boolean {
  const reservation = revisionReservations.get(agentId)
  if (
    !reservation ||
    reservation.originKind !== originKind ||
    (expectedVersion !== undefined && reservation.version !== expectedVersion)
  )
    return false
  revisionReservations.delete(agentId)
  lastPlan.delete(agentId)
  return true
}

/** Clear the staged plan when the conversation closes, archives, or is deleted. */
export function clearPlan(agentId: string): void {
  const entry = pending.get(agentId)
  if (entry && !entry.done) {
    entry.done = true
    notifyLifecycle(entry, 'cancelled')
  }
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
