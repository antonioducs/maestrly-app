/**
 * Delegation stage worker.
 *
 * It reuses the interactive-chat loop (lease renewal, event upload, cancellation, journal) and replaces only
 * what a stage needs: where the work is claimed, which workspace and conversation it runs in, the exact
 * account/model it must use, and the receipt that reports what the runtime actually did.
 */
import type {
  CheckResult,
  CodeRevision,
  DelegationHostAction,
  ProjectChatClaim,
  ProjectChatDelegationClaim,
  ProjectChatSession,
  ReviewResult,
  StageExecutionReceipt,
} from '@maestrly/protocol'
import { getConvUiPrefs, patchConvUiPrefs } from '../store'
import { listChatMessages } from '../chat/chat-store'
import { listMcpServers } from '../chat/mcp'
import type { PlatformProjectBinding } from '../../shared/platform'
import { buildDelegationCatalog } from './delegation-catalog'
import { buildStageReceipt, type ObservedRuntimeSelection } from './delegation-receipt'
import { parseReviewResult, reviewContract } from './delegation-review'
import { captureCodeRevision } from './delegation-snapshot'
import { DelegationWorkspaces, isReadOnlyStage, type PreparedStageWorkspace } from './delegation-workspace'
import type { DesktopModelCatalog } from './desktop-executor'
import type { DesktopExecutorSettings } from './executor-settings'
import type { DesktopProjectChatClient } from './project-chat-client'
import { uploadEvidence, type ArtifactUploader } from './delegation-artifacts'
import { runNamedCheck } from './delegation-checks'
import {
  authorizedCommitPatch,
  commitAuthorizedRevision,
  deliveryBranchName,
  existingAuthorizedCommit,
  pushDeliveryBranch,
} from './delegation-git'
import {
  GitHubDeliveryError,
  mergePullRequest,
  observedAccount,
  openOrUpdatePullRequest,
  pullRequestBody,
  readPullRequest,
  type GhRunner,
  type GitHubContext,
} from './delegation-github'
import {
  ProjectChatWorker,
  nativeRemoteChatHost,
  projectChatPreferences,
  type RemoteChatHost,
} from './project-chat-worker'
import * as journal from './project-chat-store'

export const DELEGATION_STAGE_INSTRUCTIONS =
  'This is an authorized Maestrly delegation stage. No person is available during this execution: do not ' +
  'open a plan review, ask a question or wait for an approval, and do not start an interactive command. ' +
  'Resolve ordinary technical uncertainty by inspecting the project and making a documented choice. Never ' +
  'invent missing credentials, permissions or business requirements — stop with a concrete blocker instead. ' +
  'Use only the account and model this stage was configured with. Finish with what changed, what you ' +
  'verified and any unresolved blocker; describing a plan is not completion.'

/** A host stage runs on this computer instead of a model; the chat turn only carries its lease. */
interface HostStageRun {
  run(signal: AbortSignal): Promise<{ status: string; error?: string }>
  cancel(): void
}

export interface DelegationWorkerOptions {
  client: DesktopProjectChatClient
  catalog: DesktopModelCatalog
  settings: DesktopExecutorSettings
  bindings: PlatformProjectBinding[]
  instanceId: string
  url: string
  reviewBaseDirectory?: string
  workspaces?: DelegationWorkspaces
  /** Injected in tests; production uses this computer's own `gh` login. */
  githubRunner?: GhRunner
}

/** Delegation stages never queue interactive plan or permission prompts; nobody is waiting at a screen. */
export class DelegationWorker extends ProjectChatWorker {
  private readonly reviewBaseDirectory: string | undefined
  private readonly workspaces: DelegationWorkspaces
  private readonly githubRunner: GhRunner | undefined
  private prepared = new Map<string, PreparedStageWorkspace>()
  /** Host actions pending per conversation; set by prepare, consumed by the injected host. */
  private readonly hostStages: Map<string, HostStageRun>
  /** Check results collected by a host stage, keyed by attempt for the pull request body. */
  private checkOutcomes = new Map<string, CheckResult[]>()
  /** Last remote head this computer observed per task, so a push never overwrites someone else's work. */
  private knownRemoteSha = new Map<string, string>()
  /** Review contract per conversation, appended to the prompt of a read-only stage. */
  private reviewContracts = new Map<string, string>()

  constructor(options: DelegationWorkerOptions) {
    // Host stages (checks, delivery, inspection) are executed by this worker itself, so they never consume a
    // model. Agent stages keep using the native chat engine.
    const hostStages = new Map<string, HostStageRun>()
    const hostActions: RemoteChatHost = {
      async start(conversationId, prompt, signal) {
        const pending = hostStages.get(conversationId)
        if (!pending) return nativeRemoteChatHost.start(conversationId, prompt, signal)
        const done = pending.run(signal).catch((error) => ({
          status: 'error' as const,
          error: (error as Error).message,
        }))
        return { done, cancel: () => pending.cancel() }
      },
      async decide() {},
    }
    super(
      options.client,
      options.catalog,
      options.settings,
      options.bindings,
      options.instanceId,
      options.url,
      hostActions
    )
    this.hostStages = hostStages
    this.reviewBaseDirectory = options.reviewBaseDirectory
    this.githubRunner = options.githubRunner
    this.workspaces =
      options.workspaces ??
      new DelegationWorkspaces({
        instanceId: options.instanceId,
        bindings: options.bindings,
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

  /** Only stage attempts admitted on this computer; an interactive chat turn belongs to the other loop. */
  protected override ownsTurn(turnId: string): boolean {
    return !!journal.delegationAttemptFor(turnId)
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
    if (delegation.stageType === 'review' && workspace.revision)
      this.reviewContracts.set(
        workspace.conversationId,
        reviewContract(workspace.revision, this.acceptanceCriteria(delegation))
      )

    const action = (delegation.snapshot as { action?: DelegationHostAction | null }).action ?? null
    if (action) {
      // A host stage carries a structured action, not a model selection.
      this.hostStages.set(workspace.conversationId, this.hostStageRun(delegation, workspace, action))
      return workspace.conversationId
    }

    const settings = (
      delegation.snapshot as { settings?: { selectionId: string; reasoning: string | null; fastMode: boolean } }
    ).settings
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
        ...projectChatPreferences(
          claim.session,
          this.settings,
          listMcpServers().map((server) => server.id)
        ),
        // A read-only stage keeps read-only tools whatever the session advertises.
        ...(workspace.readOnly ? { mode: 'ask' as const } : {}),
        subagentsEnabled: (settings as { delegationProfiles?: string[] }).delegationProfiles?.length !== 0,
      },
    })
    const { primeChatTurnSelection, publishConvChatSettings } = await import('../chat/service')
    primeChatTurnSelection(workspace.conversationId, {
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoning: settings.reasoning ?? undefined,
      fastMode: settings.fastMode,
    })
    // The stage replaced this conversation's settings wholesale, so the composer has to read them again.
    publishConvChatSettings(workspace.conversationId)
    return workspace.conversationId
  }

  /**
   * A stage runs unattended: nobody is available to approve a plan or answer a question, so the prompt says
   * so explicitly and the stage must end with a concrete result or a concrete blocker.
   */
  protected override renderPrompt(conversationId: string, _session: ProjectChatSession, prompt: string): string {
    const contract = this.reviewContracts.get(conversationId)
    return [DELEGATION_STAGE_INSTRUCTIONS, prompt, contract ?? ''].filter(Boolean).join('\n\n')
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
      settings?: {
        selectionId: string
        reasoning: string | null
        fastMode: boolean
        executionMode: string
        delegationProfiles: string[]
      }
    }
    const admitted = snapshot.settings ?? null
    const workspace = this.prepared.get(claim.turn.id) ?? null
    let result = completion.state
    let blocker = completion.state === 'succeeded' ? null : completion.error
    let review: ReviewResult | undefined
    let codeRevision: CodeRevision | undefined

    if (completion.state === 'succeeded' && workspace) {
      if (delegation.stageType === 'review') {
        // The reviewed revision is the one the stable copy represents, never a later edit.
        const revision = workspace.revision
        const outcome = revision
          ? parseReviewResult(this.finalText(context.conversationId), revision)
          : ({ ok: false, failure: 'missing-block', detail: 'No reviewed revision was captured.' } as const)
        if (outcome.ok) {
          review = outcome.result
          codeRevision = revision ?? undefined
        } else {
          // A review without a valid, bound verdict is a failure, not an approval.
          result = 'failed'
          blocker = `The review verdict could not be accepted (${outcome.failure}): ${outcome.detail}`
        }
      } else if (!workspace.readOnly && !this.hostStages.has(workspace.conversationId)) {
        try {
          codeRevision = (await captureCodeRevision({ cwd: workspace.cwd })).revision
        } catch (error) {
          result = 'failed'
          blocker = `The produced revision could not be captured in full: ${(error as Error).message}`
        }
      }
    }

    const receipt: StageExecutionReceipt = buildStageReceipt({
      requested: admitted as never,
      admitted: admitted as never,
      observed: this.observe(context.conversationId),
      conversationId: context.conversationId,
      result,
      summary: blocker ?? '',
      blocker,
      durationMs: Date.now() - context.startedAt,
    })
    journal.recordDelegationReceipt(delegation.attemptId, receipt)
    await this.client.delegationReceipt(delegation.attemptId, {
      leaseId,
      receipt,
      ...(codeRevision ? { codeRevision } : {}),
      ...(review ? { review } : {}),
    })
    journal.finishDelegationAttempt(delegation.attemptId)
  }

  /**
   * Build the runnable host action for a stage. Checks are executed by the host with the resolved command and
   * their logs are uploaded as evidence; a delivery action is handled by the delivery module.
   */
  private hostStageRun(
    delegation: ProjectChatDelegationClaim,
    workspace: PreparedStageWorkspace,
    action: DelegationHostAction
  ): HostStageRun {
    const controller = new AbortController()
    return {
      cancel: () => controller.abort(),
      run: async (signal) => {
        signal.addEventListener('abort', () => controller.abort(), { once: true })
        if (action.kind === 'deliver') return this.runDelivery(delegation, workspace, action)
        if (action.kind === 'pull_request_status') return this.runPullRequestStatus(delegation, workspace)
        const configured = (await this.client.delegationChecks(delegation.taskId)).items
        const captured = await captureCodeRevision({ cwd: workspace.cwd })
        const results: CheckResult[] = []
        for (const checkId of action.checkIds) {
          if (controller.signal.aborted) return { status: 'cancelled' }
          const config = configured.find((candidate) => candidate.id === checkId)
          if (!config) return { status: 'error', error: `Check "${checkId}" is not configured for this project.` }
          const outcome = await runNamedCheck(config, {
            cwd: workspace.cwd,
            revision: captured.revision,
            copyBaseDirectory: this.reviewBaseDirectory,
          })
          let logArtifactId: string | null = null
          if (outcome.log.byteLength > 0) {
            const artifact = await uploadEvidence(this.uploader, {
              taskId: delegation.taskId,
              kind: 'log',
              name: `${config.id}.log`,
              contentType: 'text/plain; charset=utf-8',
              bytes: outcome.log,
              attemptId: delegation.attemptId,
              codeRevisionDigest: captured.revision.contentDigest,
            })
            logArtifactId = artifact.id
          }
          const result = { ...outcome.result, logArtifactId }
          await this.client.delegationCheckResult(delegation.taskId, {
            attemptId: delegation.attemptId,
            result,
          })
          results.push(result)
        }
        this.checkOutcomes.set(delegation.attemptId, results)
        const failed = results.filter((result) => !result.passed)
        return failed.length
          ? {
              status: 'error',
              error: `Check(s) failed on this revision: ${failed.map((result) => result.checkId).join(', ')}.`,
            }
          : { status: 'success' }
      },
    }
  }

  /**
   * Git and GitHub delivery. The intention is recorded on the server first; the external effect then happens,
   * and only an observed fact confirms it. A previously confirmed delivery is never repeated.
   */
  private async runDelivery(
    delegation: ProjectChatDelegationClaim,
    workspace: PreparedStageWorkspace,
    action: Extract<DelegationHostAction, { kind: 'deliver' }>
  ): Promise<{ status: string; error?: string }> {
    const captured = await captureCodeRevision({ cwd: workspace.cwd })
    const expected = action.expectedCodeRevision ?? captured.revision.contentDigest
    // Delivery modes accumulate on one authorized revision: the commit this task already created is reused
    // instead of being demanded again, so push, pull request and merge work with nothing new to commit.
    const alreadyCommitted = await existingAuthorizedCommit({
      cwd: workspace.cwd,
      taskId: delegation.taskId,
      authorizedDigest: expected,
      observedDigest: captured.revision.contentDigest,
    })
    if (!alreadyCommitted && expected !== captured.revision.contentDigest)
      return {
        status: 'error',
        error: 'The workspace changed after this delivery was authorized. Re-review the current revision first.',
      }
    const intention = await this.client.recordDeliveryIntention(delegation.taskId, {
      attemptId: delegation.attemptId,
      mode: action.mode,
      expectedRevision: expected,
    })
    if (intention.alreadyConfirmed) return { status: 'success' }

    const context: GitHubContext = { cwd: workspace.cwd, ...(this.githubRunner ? { run: this.githubRunner } : {}) }
    try {
      if (action.mode === 'patch') {
        // Once the content is committed the workspace has no pending diff; the patch then comes from the
        // commit itself, so the evidence is the real change instead of an empty file.
        const bytes = alreadyCommitted
          ? await authorizedCommitPatch({ cwd: workspace.cwd, commitSha: alreadyCommitted.commitSha })
          : captured.patch
        await uploadEvidence(this.uploader, {
          taskId: delegation.taskId,
          kind: 'patch',
          name: 'delivery.patch',
          contentType: 'text/x-diff',
          bytes,
          attemptId: delegation.attemptId,
          codeRevisionDigest: captured.revision.contentDigest,
        })
        await this.client.confirmDelivery(delegation.taskId, {
          deliveryId: intention.deliveryId,
          state: 'confirmed',
        })
        return { status: 'success' }
      }
      const committed =
        alreadyCommitted ??
        (await commitAuthorizedRevision({
          cwd: workspace.cwd,
          taskId: delegation.taskId,
          expectedRevision: captured.revision,
          title: action.title ?? delegation.stageType,
        }))
      if (action.mode === 'commit') {
        await this.client.confirmDelivery(delegation.taskId, {
          deliveryId: intention.deliveryId,
          state: 'confirmed',
          commitSha: committed.commitSha,
          branch: committed.branch,
        })
        return { status: 'success' }
      }
      const pushed = await pushDeliveryBranch({
        cwd: workspace.cwd,
        branch: committed.branch,
        knownRemoteSha: this.knownRemoteSha.get(delegation.taskId) ?? null,
      })
      this.knownRemoteSha.set(delegation.taskId, pushed.remoteSha)
      const account = await observedAccount(context).catch(() => null)
      if (action.mode === 'push') {
        await this.client.confirmDelivery(delegation.taskId, {
          deliveryId: intention.deliveryId,
          state: 'confirmed',
          commitSha: committed.commitSha,
          branch: committed.branch,
          observedAccount: account,
        })
        return { status: 'success' }
      }
      if (action.mode === 'merge') {
        const current = await readPullRequest(context, { branch: committed.branch })
        if (!current) return { status: 'error', error: 'There is no pull request to merge for this branch.' }
        // The merge is bound to the commit this delivery authorized, never to whatever head the branch shows
        // now: another actor can advance it between the push and this read, and that newer head was never
        // reviewed. The same identity decides whether an already merged pull request is this task's own work.
        if (current.headSha !== committed.commitSha)
          throw new GitHubDeliveryError(
            'head-mismatch',
            `The pull request head is ${current.headSha ?? 'unknown'}, not the authorized ${committed.commitSha}.`
          )
        // A merge that already happened is reconciled with what GitHub reports, never attempted twice.
        const merged =
          current.state === 'merged'
            ? current
            : await mergePullRequest(context, {
                number: current.number,
                expectedHeadSha: committed.commitSha,
                method: 'squash',
              })
        await this.client.confirmDelivery(delegation.taskId, {
          deliveryId: intention.deliveryId,
          state: 'confirmed',
          commitSha: committed.commitSha,
          branch: committed.branch,
          observedAccount: account,
          pullRequest: merged as unknown as Record<string, unknown>,
        })
        return { status: 'success' }
      }
      const observed = await openOrUpdatePullRequest(context, {
        branch: committed.branch,
        baseBranch: delegation.baseBranch,
        title: action.title ?? `Delegated change ${delegation.taskId.slice(0, 8)}`,
        body: pullRequestBody({
          taskId: delegation.taskId,
          objective: (delegation.snapshot as { prompt?: string }).prompt ?? '',
          acceptanceCriteria: this.acceptanceCriteria(delegation),
          checks: (this.checkOutcomes.get(delegation.attemptId) ?? []).map((result) => ({
            checkId: result.checkId,
            passed: result.passed,
            exitCode: result.exitCode,
          })),
          reviewVerdict: null,
          evidenceUrl: `${this.url}/`,
          taskUrl: `${this.url}/`,
        }),
        draft: action.mode === 'draft_pr',
      })
      await this.client.confirmDelivery(delegation.taskId, {
        deliveryId: intention.deliveryId,
        state: 'confirmed',
        commitSha: committed.commitSha,
        branch: committed.branch,
        observedAccount: account,
        pullRequest: observed as unknown as Record<string, unknown>,
      })
      return { status: 'success' }
    } catch (error) {
      const reason = (error as { reason?: string }).reason
      // A diverged remote or a head mismatch preserves both sides and asks for a person.
      const needsAttention = reason === 'remote-diverged' || reason === 'head-mismatch' || reason === 'revision-changed'
      await this.client
        .confirmDelivery(delegation.taskId, {
          deliveryId: intention.deliveryId,
          state: needsAttention ? 'needs_attention' : 'failed',
          error: (error as Error).message.slice(0, 4000),
        })
        .catch(() => undefined)
      return { status: 'error', error: (error as Error).message }
    }
  }

  /** Read the pull request with this computer's own credentials and record what was observed. */
  private async runPullRequestStatus(
    delegation: ProjectChatDelegationClaim,
    workspace: PreparedStageWorkspace
  ): Promise<{ status: string; error?: string }> {
    try {
      const context: GitHubContext = {
        cwd: workspace.cwd,
        ...(this.githubRunner ? { run: this.githubRunner } : {}),
      }
      const observed = await readPullRequest(context, { branch: deliveryBranchName(delegation.taskId) })
      if (!observed) return { status: 'error', error: 'No pull request is linked to this task yet.' }
      await this.client.recordPullRequest(delegation.taskId, observed as unknown as Record<string, unknown>)
      return { status: 'success' }
    } catch (error) {
      return { status: 'error', error: (error as Error).message }
    }
  }

  private get uploader(): ArtifactUploader {
    return {
      start: (input) =>
        this.client.startArtifactUpload(input.taskId, {
          kind: input.kind,
          name: input.name,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          ...(input.attemptId ? { attemptId: input.attemptId } : {}),
          ...(input.codeRevisionDigest ? { codeRevisionDigest: input.codeRevisionDigest } : {}),
        }),
      chunk: (input) =>
        this.client.uploadArtifactChunk(input.taskId, input.uploadId, {
          index: input.index,
          contentBase64: input.contentBase64,
        }),
      complete: (input) => this.client.completeArtifactUpload(input.taskId, input.uploadId, { digest: input.digest }),
    }
  }

  /** Acceptance criteria the stage prompt already carries, extracted for the review contract. */
  private acceptanceCriteria(delegation: ProjectChatDelegationClaim): string[] {
    const prompt = (delegation.snapshot as { prompt?: string }).prompt ?? ''
    const section = /### Acceptance criteria\n([\s\S]*?)(\n\n|$)/.exec(prompt)
    if (!section) return []
    return section[1]!
      .split('\n')
      .map((line) => line.replace(/^-\s*/, '').trim())
      .filter(Boolean)
  }

  /** Text of the final assistant message, where the structured verdict must appear. */
  private finalText(conversationId: string | null): string {
    if (!conversationId) return ''
    const messages = listChatMessages(conversationId).filter(
      (message) => message.role === 'assistant' && !message.internal
    )
    const last = messages.at(-1)
    if (!last) return ''
    return last.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n')
  }

  protected override async afterTurn(claim: ProjectChatClaim): Promise<void> {
    const workspace = this.prepared.get(claim.turn.id)
    if (workspace) {
      this.reviewContracts.delete(workspace.conversationId)
      this.hostStages.delete(workspace.conversationId)
    }
    if (claim.delegation) this.checkOutcomes.delete(claim.delegation.attemptId)
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
