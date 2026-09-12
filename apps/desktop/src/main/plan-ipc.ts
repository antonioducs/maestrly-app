import path from 'node:path'
import { isWebManagedConversation } from './chat/remote-policy'
import { constants as fsConstants, promises as fsp } from 'node:fs'
import * as floatingManager from './floating-manager'
import { excludeFromGitInfo } from './git-service'
import { commitPlanDecision, decidePlan, getPending as getPendingPlan, type PlanDecision } from './plan-broker'
import { toForwardSlashes } from './platform'
import { getConversation, type Conversation } from './store'
import { runApprovedPlan, runPlanRevision, setChatMode } from './chat/service'
import { OPEN_FILE_FILE } from './vscode/vscode-ext-source'
import type { IpcRegistrar } from './ipc-registrar'

export interface PlanIpcDeps {
  sendToWindow: (ch: string, payload?: unknown) => void
  createMaestroSibling?: (
    sourceConversationId: string,
    options: { experience: 'maestro'; name: string }
  ) => Promise<Conversation>
  deleteConversation?: (conversationId: string) => Promise<void>
  isConversationReserved?: (conversationId: string) => boolean
  applyMaestroStrategyProfile?: (
    conversationId: string,
    profileId: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  markMaestroStrategyProfileUsed?: (profileId: string) => void
  resolveChatGptWebPlanReview?: (
    conversationId: string,
    reviewId: string,
    outcome: { status: 'revise'; feedbackText: string } | { status: 'approved' } | { status: 'discarded' }
  ) => { ok: boolean; error?: string }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function discardUnstartedSibling(deps: PlanIpcDeps, conversationId: string): Promise<string | null> {
  if (!deps.deleteConversation) return 'plan-maestro-rollback-unavailable'
  try {
    await deps.deleteConversation(conversationId)
    return null
  } catch (error) {
    return `plan-maestro-rollback-failed: ${errorText(error)}`
  }
}

function positiveLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function registerPlanIpc(reg: IpcRegistrar, deps: PlanIpcDeps): void {
  reg.mhandle('plan:decide', (_e, agentId: string, decision: PlanDecision) => {
    if(isWebManagedConversation(agentId))return {ok:false,error:'Decide this plan in the Kanban web chat.'}
    if (
      decision.implementationTarget !== undefined &&
      decision.implementationTarget !== 'source' &&
      decision.implementationTarget !== 'maestro'
    ) {
      return { ok: false, error: 'plan-implementation-target-invalid' }
    }
    if (decision.implementationTarget === 'maestro' && decision.action !== 'approve') {
      return { ok: false, error: 'plan-implementation-target-invalid' }
    }
    if (
      decision.maestroStrategyProfileId !== undefined &&
      (decision.implementationTarget !== 'maestro' ||
        typeof decision.maestroStrategyProfileId !== 'string' ||
        !decision.maestroStrategyProfileId.trim() ||
        decision.maestroStrategyProfileId.length > 120)
    ) {
      return { ok: false, error: 'plan-maestro-strategy-profile-invalid' }
    }
    // Prepare the decision, then commit immediately for local Chat or after external confirmation for Web.
    // Failed external confirmation preserves the visible pending plan for retry. Start a new turn when
    // applicable.
    const result = decidePlan(agentId, decision, { deferCommit: true })
    if (!result) return
    const sourceConversation = getConversation(agentId)
    if (!sourceConversation) {
      commitPlanDecision(agentId, decision.action)
      return
    }
    const webRoute = result.route?.kind === 'chatgpt-web' ? result.route : null
    const resolveWeb = (
      outcome: { status: 'revise'; feedbackText: string } | { status: 'approved' } | { status: 'discarded' }
    ) =>
      deps.resolveChatGptWebPlanReview?.(agentId, webRoute!.reviewId, outcome) ?? {
        ok: false,
        error: 'plan-review-unavailable',
      }

    if (result.action === 'approve' && result.approvedPlan && decision.implementationTarget === 'maestro') {
      const approvedPlan = result.approvedPlan
      return (async () => {
        if (sourceConversation.experience !== 'standard') {
          return { ok: false, error: 'plan-maestro-source-must-be-standard' }
        }
        if (deps.isConversationReserved?.(agentId)) {
          return { ok: false, error: 'plan-maestro-source-reserved' }
        }
        if (!deps.createMaestroSibling || !deps.deleteConversation || !deps.applyMaestroStrategyProfile) {
          return { ok: false, error: 'plan-maestro-handoff-unavailable' }
        }

        let maestroConversation: Conversation
        try {
          maestroConversation = await deps.createMaestroSibling(agentId, {
            experience: 'maestro',
            name: `${sourceConversation.name} · Maestro`,
          })
        } catch (error) {
          // Keep the staged decision so the user can resolve the blocker and retry.
          return { ok: false, error: errorText(error) }
        }

        const profileId = decision.maestroStrategyProfileId?.trim() || 'global'
        const profileApplied = await deps.applyMaestroStrategyProfile(maestroConversation.id, profileId)
        if (!profileApplied.ok) {
          const rollbackError = await discardUnstartedSibling(deps, maestroConversation.id)
          return { ok: false, error: rollbackError ?? profileApplied.error }
        }

        if (webRoute) {
          const reviewResolution = resolveWeb({ status: 'approved' })
          if (!reviewResolution.ok) {
            const rollbackError = await discardUnstartedSibling(deps, maestroConversation.id)
            return rollbackError ? { ok: false, error: rollbackError } : reviewResolution
          }
        }

        if (!commitPlanDecision(agentId, result.action)) {
          const rollbackError = await discardUnstartedSibling(deps, maestroConversation.id)
          return { ok: false, error: rollbackError ?? 'plan-decision-stale' }
        }

        // Preserve the source mode; only the Maestro sibling receives and implements the plan.
        deps.markMaestroStrategyProfileUsed?.(profileId)
        deps.sendToWindow('conversation:open', { conversation: maestroConversation, focus: true })
        void runApprovedPlan(maestroConversation.id, approvedPlan)
        return { ok: true, conversationId: maestroConversation.id }
      })()
    }

    let reviewResolution: { ok: boolean; error?: string } | undefined
    if (webRoute) {
      reviewResolution =
        result.action === 'approve'
          ? resolveWeb({ status: 'approved' })
          : result.action === 'revise' && result.feedbackText
            ? resolveWeb({ status: 'revise', feedbackText: result.feedbackText })
            : resolveWeb({ status: 'discarded' })
      if (!reviewResolution.ok) return reviewResolution
    }

    if (!commitPlanDecision(agentId, result.action)) {
      return { ok: false, error: 'plan-decision-stale' }
    }
    if (result.action === 'approve' && result.approvedPlan) {
      // Approval switches the conversation to Agent mode, notifies UI, and starts implementation.
      setChatMode(agentId, 'agent')
      deps.sendToWindow(`chat:mode:${agentId}`, 'agent')
      void runApprovedPlan(agentId, result.approvedPlan)
    } else if (result.action === 'revise' && result.feedbackText && !webRoute) {
      // Revision starts a feedback turn so the model revises and resubmits through review_plan.
      if (result.revisionVersion === undefined) void runPlanRevision(agentId, result.feedbackText)
      else void runPlanRevision(agentId, result.feedbackText, result.revisionVersion)
    }
    // Discard needs no further action; pending state is already cleared.
    return reviewResolution
  })
  // Hydrate the plan panel on mount after plan:received may already have broadcast.
  reg.handle('plan:get', (_e, convId: string) => getPendingPlan(convId))

  // Open a Plan file chip through the .maestrly/agent-open-file.json sidecar watched by the VS Code bridge
  // extension.
  reg.mhandle(
    'plan:open-file',
    async (_e, convId: string, filePath: string, line?: number, requestedEndLine?: number) => {
      const cwd = getConversation(convId)?.cwd
      if (!cwd || typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) return
      // Web VS Code opens through its workspace provider. Write a cwd-relative path for joinPath(ws.uri,
      // rel); absolute Uri.file does not work.
      const root = path.resolve(cwd)
      const target = path.resolve(root, filePath)
      let rel = path.relative(root, target)
      // Use path.relative to reject other-volume absolute paths and traversal outside the workspace without
      // rejecting legitimate names beginning with two dots.
      if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return
      // Reject symlink escapes, missing files, and directories before focusing the drawer.
      let canonicalRoot: string
      try {
        const [resolvedRoot, canonicalTarget, targetStat] = await Promise.all([
          fsp.realpath(root),
          fsp.realpath(target),
          fsp.stat(target),
        ])
        canonicalRoot = resolvedRoot
        const canonicalRel = path.relative(resolvedRoot, canonicalTarget)
        if (
          !targetStat.isFile() ||
          !canonicalRel ||
          path.isAbsolute(canonicalRel) ||
          canonicalRel === '..' ||
          canonicalRel.startsWith(`..${path.sep}`)
        )
          return
        rel = canonicalRel
      } catch {
        return
      }
      rel = toForwardSlashes(rel) // Use forward-slash path segments for the workspace provider.
      const startLine = positiveLine(line)
      const endLineCandidate = positiveLine(requestedEndLine)
      const endLine = startLine && endLineCandidate && endLineCandidate >= startLine ? endLineCandidate : undefined
      const dir = path.join(root, '.maestrly')
      try {
        await fsp.mkdir(dir, { recursive: true })
        const [dirStat, canonicalDir] = await Promise.all([fsp.lstat(dir), fsp.realpath(dir)])
        if (
          dirStat.isSymbolicLink() ||
          !dirStat.isDirectory() ||
          path.relative(canonicalRoot, canonicalDir) !== '.maestrly'
        )
          return

        const sidecar = path.join(dir, OPEN_FILE_FILE)
        const existing = await fsp.lstat(sidecar).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (existing && (existing.isSymbolicLink() || !existing.isFile())) return
        const handle = await fsp.open(
          sidecar,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
          0o600
        )
        try {
          await handle.writeFile(
            JSON.stringify({ rel, line: startLine ?? null, endLine: endLine ?? null, ts: Date.now() })
          )
        } finally {
          await handle.close()
        }
        await excludeFromGitInfo(cwd, [`.maestrly/${OPEN_FILE_FILE}`])
      } catch {
        return // without a valid sidecar there is no editor target to focus.
      }
      // Raise floating VS Code or ask App to open the docked Code tab so the requested file is visible.
      if (!floatingManager.focusFloatIfAny(convId, 'vscode')) deps.sendToWindow('debug:ensure-vscode', convId)
    }
  )
}
