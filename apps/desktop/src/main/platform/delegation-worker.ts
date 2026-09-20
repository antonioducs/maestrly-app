/**
 * Delegation stage worker.
 *
 * It reuses the interactive-chat loop (lease renewal, event upload, cancellation, journal) and replaces only
 * what a stage needs: where the work is claimed, which workspace and conversation it runs in, the exact
 * account/model it must use, and the receipt that reports what the runtime actually did.
 */
import type {
  ProjectChatClaim,
  ProjectChatDelegationClaim,
  ProjectChatSession,
  StageExecutionReceipt,
} from '@maestrly/protocol'
import { getConvUiPrefs, patchConvUiPrefs } from '../store'
import { listMcpServers } from '../chat/mcp'
import type { PlatformProjectBinding } from '../../shared/platform'
import { buildDelegationCatalog } from './delegation-catalog'
import { buildStageReceipt, type ObservedRuntimeSelection } from './delegation-receipt'
import { DelegationWorkspaces, isReadOnlyStage, type PreparedStageWorkspace } from './delegation-workspace'
import type { DesktopModelCatalog } from './desktop-executor'
import type { DesktopExecutorSettings } from './executor-settings'
import type { DesktopProjectChatClient } from './project-chat-client'
import { ProjectChatWorker, chatWorkspaceKey, projectChatPreferences } from './project-chat-worker'
import * as journal from './project-chat-store'

export const DELEGATION_STAGE_INSTRUCTIONS =
  'This is an authorized Maestrly delegation stage. No person is available during this execution: do not ' +
  'open a plan review, ask a question or wait for an approval, and do not start an interactive command. ' +
  'Resolve ordinary technical uncertainty by inspecting the project and making a documented choice. Never ' +
  'invent missing credentials, permissions or business requirements — stop with a concrete blocker instead. ' +
  'Use only the account and model this stage was configured with. Finish with what changed, what you ' +
  'verified and any unresolved blocker; describing a plan is not completion.'

export interface DelegationWorkerOptions {
  client: DesktopProjectChatClient
  catalog: DesktopModelCatalog
  settings: DesktopExecutorSettings
  bindings: PlatformProjectBinding[]
  instanceId: string
  url: string
  reviewBaseDirectory?: string
  workspaces?: DelegationWorkspaces
}

/** Delegation stages never queue interactive plan or permission prompts; nobody is waiting at a screen. */
export class DelegationWorker extends ProjectChatWorker {
  private readonly workspaces: DelegationWorkspaces
  private prepared = new Map<string, PreparedStageWorkspace>()

  constructor(options: DelegationWorkerOptions) {
    super(
      options.client,
      options.catalog,
      options.settings,
      options.bindings,
      options.instanceId,
      options.url
    )
    this.workspaces =
      options.workspaces ??
      new DelegationWorkspaces({
        instanceId: options.instanceId,
        bindings: options.bindings,
        workspaceKeyFor: chatWorkspaceKey,
        reviewBaseDirectory: options.reviewBaseDirectory,
      })
  }

  protected override async publishInventory(): Promise<void> {
    const catalog = await buildDelegationCatalog({
      catalog: this.catalog,
      settings: this.settings,
      bindings: this.bindings,
    })
    await this.client.delegationInventory(catalog)
  }

  protected override claimNext(): Promise<ProjectChatClaim | null> {
    return this.client.claimDelegationStage()
  }

  private delegationOf(claim: ProjectChatClaim): ProjectChatDelegationClaim {
    if (!claim.delegation) throw new Error('This claim is not a delegation stage.')
    return claim.delegation
  }

  /**
   * Resolve the workspace and conversation for the stage, then freeze the account/model the snapshot names.
   * The executor never falls back to another account or effort.
   */
  protected override async prepare(claim: ProjectChatClaim): Promise<string> {
    const delegation = this.delegationOf(claim)
    if (
      !journal.admitDelegationAttempt({
        instanceId: this.instanceId,
        attemptId: delegation.attemptId,
        taskId: delegation.taskId,
        stageId: delegation.stageId,
        turnId: claim.turn.id,
        leaseId: claim.turn.leaseId!,
      })
    ) {
      const recorded = journal.delegationAttemptFor(claim.turn.id)
      if (recorded && recorded.attempt_id !== delegation.attemptId)
        throw new Error('This turn already belongs to another recorded attempt on this computer.')
    }
    const workspace = await this.workspaces.prepare(claim.session, delegation)
    this.prepared.set(claim.turn.id, workspace)

    const settings = (delegation.snapshot as { settings?: { selectionId: string; reasoning: string | null; fastMode: boolean } })
      .settings
    if (!settings) throw new Error('This stage snapshot has no agent settings.')
    const selection = await this.catalog.resolve(settings.selectionId)
    if (!this.settings.providerIds.includes(selection.providerId))
      throw new Error('The account this stage was configured with is not enabled on this executor.')
    if (settings.reasoning && !selection.reasoningEfforts.includes(settings.reasoning))
      throw new Error('The reasoning effort this stage was configured with is no longer available.')
    if (settings.fastMode && !selection.fastMode)
      throw new Error('Fast mode is no longer available for the account this stage was configured with.')

    patchConvUiPrefs(workspace.conversationId, {
      chat: {
        ...projectChatPreferences(claim.session, this.settings, listMcpServers().map((server) => server.id)),
        // A read-only stage keeps read-only tools whatever the session advertises.
        ...(workspace.readOnly ? { mode: 'ask' as const } : {}),
        subagentsEnabled: (settings as { delegationProfiles?: string[] }).delegationProfiles?.length !== 0,
      },
    })
    const { primeChatTurnSelection } = await import('../chat/service')
    primeChatTurnSelection(workspace.conversationId, {
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoning: settings.reasoning ?? undefined,
      fastMode: settings.fastMode,
    })
    return workspace.conversationId
  }

  /**
   * A stage runs unattended: nobody is available to approve a plan or answer a question, so the prompt says
   * so explicitly and the stage must end with a concrete result or a concrete blocker.
   */
  protected override renderPrompt(_conversationId: string, _session: ProjectChatSession, prompt: string): string {
    return DELEGATION_STAGE_INSTRUCTIONS + '\n\n' + prompt
  }

  /** Observe what the conversation actually used, without assuming the request was honored. */
  private observe(conversationId: string | null): ObservedRuntimeSelection | null {
    if (!conversationId) return null
    const preferences = getConvUiPrefs(conversationId).chat
    if (!preferences?.providerId || !preferences.modelId) return null
    const reasoning = preferences.reasoning && preferences.reasoning !== 'off' ? preferences.reasoning : null
    return {
      selectionId: this.catalog.selectionIdFor(preferences.providerId, preferences.modelId),
      modelId: preferences.modelId,
      accountLabel: preferences.providerId,
      reasoning,
      fastMode: preferences.fastMode === true,
      harnessProfileId: null,
      harnessHash: null,
    }
  }

  protected override async beforeComplete(
    claim: ProjectChatClaim,
    leaseId: string,
    completion: { state: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; error: string | null },
    context: { conversationId: string | null; startedAt: number }
  ): Promise<void> {
    const delegation = claim.delegation
    if (!delegation) return
    const snapshot = delegation.snapshot as {
      settings?: { selectionId: string; reasoning: string | null; fastMode: boolean; executionMode: string; delegationProfiles: string[] }
    }
    const admitted = snapshot.settings ?? null
    const receipt: StageExecutionReceipt = buildStageReceipt({
      requested: admitted as never,
      admitted: admitted as never,
      observed: this.observe(context.conversationId),
      conversationId: context.conversationId,
      result: completion.state,
      summary: completion.error ?? '',
      blocker: completion.state === 'succeeded' ? null : completion.error,
      durationMs: Date.now() - context.startedAt,
    })
    journal.recordDelegationReceipt(delegation.attemptId, receipt)
    await this.client.delegationReceipt(delegation.attemptId, { leaseId, receipt })
    journal.finishDelegationAttempt(delegation.attemptId)
  }

  protected override async afterTurn(claim: ProjectChatClaim): Promise<void> {
    const workspace = this.prepared.get(claim.turn.id)
    this.prepared.delete(claim.turn.id)
    // Only the read-only copy is disposable; the task worktree survives for later stages and inspection.
    if (workspace && isReadOnlyStage(claim.delegation?.stageType ?? '')) await workspace.dispose()
  }

  /** Resend a receipt whose acknowledgement was lost before completing the turn again. */
  override async recover(): Promise<void> {
    for (const pending of journal.pendingDelegationReceipts(this.instanceId)) {
      if (!pending.receipt) continue
      try {
        await this.client.delegationReceipt(pending.attempt_id, {
          leaseId: pending.lease_id,
          receipt: JSON.parse(pending.receipt),
        })
        journal.finishDelegationAttempt(pending.attempt_id)
      } catch (error) {
        if ([401, 403, 404, 409].includes((error as { status?: number }).status ?? 0))
          journal.finishDelegationAttempt(pending.attempt_id)
        else throw error
      }
    }
    await super.recover()
  }
}
