import { HttpTransport } from '@maestrly/client-sdk'
import type {
  ChatInventory,
  ChatUpload,
  CheckResult,
  CodeRevision,
  DelegationArtifact,
  DelegationArtifactKind,
  DelegationCheckConfig,
  DelegationInspection,
  DelegationModelCatalog,
  DeliveryMode,
  ProjectChatClaim,
  ProjectChatInteraction,
  ReviewResult,
  StageExecutionReceipt,
} from '@maestrly/protocol'
export class DesktopProjectChatClient {
  private transport: HttpTransport
  constructor(url: string, identity: { organizationId: string; runnerId: string; credential: string }) {
    this.transport = new HttpTransport({
      baseUrl: url,
      fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15000) }),
      authentication: {
        headers: () => ({
          authorization: 'Runner ' + identity.credential,
          'x-maestrly-organization-id': identity.organizationId,
          'x-maestrly-runner-id': identity.runnerId,
        }),
      },
    })
  }
  inventory(body: ChatInventory) {
    return this.transport.request('POST', '/api/v1/runners/chat/inventory', { body })
  }
  /**
   * Publish the delegation inventory. A server without the capability answers 404; the caller treats that
   * as "delegation unavailable" instead of failing the executor.
   */
  async delegationInventory(body: DelegationModelCatalog): Promise<{ accepted: boolean }> {
    try {
      await this.transport.request('POST', '/api/v1/runners/delegations/inventory', { body })
      return { accepted: true }
    } catch (error) {
      if ((error as { status?: number }).status === 404) return { accepted: false }
      throw error
    }
  }
  claim() {
    return this.transport.request<ProjectChatClaim | null>('POST', '/api/v1/runners/chat/claim', { body: {} })
  }
  /** Claim the next delegation stage. Lease, controls, events and completion reuse the chat machine routes. */
  claimDelegationStage() {
    return this.transport.request<ProjectChatClaim | null>('POST', '/api/v1/runners/delegations/claim', { body: {} })
  }
  /** Named checks this project configured, resolved by the server for the task's project. */
  delegationChecks(taskId: string) {
    return this.transport.request<{ items: DelegationCheckConfig[] }>(
      'GET',
      `/api/v1/runners/delegations/checks?taskId=${encodeURIComponent(taskId)}`
    )
  }
  delegationCheckResult(taskId: string, body: { attemptId: string | null; result: CheckResult }) {
    return this.transport.request<CheckResult>('POST', `/api/v1/runners/delegations/tasks/${taskId}/checks`, { body })
  }
  startArtifactUpload(
    taskId: string,
    body: {
      kind: DelegationArtifactKind
      name: string
      contentType: string
      sizeBytes: number
      attemptId?: string
      codeRevisionDigest?: string
    }
  ) {
    return this.transport.request<{ uploadId: string; chunkBytes: number }>(
      'POST',
      `/api/v1/runners/delegations/tasks/${taskId}/artifacts/uploads`,
      { body }
    )
  }
  uploadArtifactChunk(taskId: string, uploadId: string, body: { index: number; contentBase64: string }) {
    return this.transport.request<{ receivedBytes: number; nextIndex: number }>(
      'POST',
      `/api/v1/runners/delegations/tasks/${taskId}/artifacts/uploads/${uploadId}/chunks`,
      { body }
    )
  }
  completeArtifactUpload(taskId: string, uploadId: string, body: { digest: string }) {
    return this.transport.request<DelegationArtifact>(
      'POST',
      `/api/v1/runners/delegations/tasks/${taskId}/artifacts/uploads/${uploadId}/complete`,
      { body }
    )
  }
  /** Durable delivery intention recorded before any external effect. */
  recordDeliveryIntention(
    taskId: string,
    body: { attemptId: string | null; mode: DeliveryMode; expectedRevision: string }
  ) {
    return this.transport.request<{
      deliveryId: string
      mode: DeliveryMode
      expectedRevision: string
      alreadyConfirmed: { deliveryId: string; pullRequestNumber: number | null; commitSha: string | null } | null
    }>('POST', `/api/v1/runners/delegations/tasks/${taskId}/deliveries`, { body })
  }
  confirmDelivery(
    taskId: string,
    body: {
      deliveryId: string
      state: 'confirmed' | 'failed' | 'needs_attention'
      commitSha?: string | null
      branch?: string | null
      observedAccount?: string | null
      error?: string | null
      pullRequest?: Record<string, unknown>
    }
  ) {
    return this.transport.request('POST', `/api/v1/runners/delegations/tasks/${taskId}/deliveries/confirm`, { body })
  }
  recordPullRequest(taskId: string, snapshot: Record<string, unknown>) {
    return this.transport.request('POST', `/api/v1/runners/delegations/tasks/${taskId}/pull-request`, {
      body: { snapshot },
    })
  }
  claimInspection() {
    return this.transport.request<{
      inspection: DelegationInspection
      leaseId: string
      taskId: string
      workspaceKey: string
    } | null>('POST', '/api/v1/runners/delegations/inspections/claim', { body: {} })
  }
  completeInspection(
    inspectionId: string,
    body: {
      leaseId: string
      state: 'succeeded' | 'failed'
      result: Record<string, unknown> | null
      artifactId: string | null
      error: string | null
      codeRevisionDigest: string | null
    }
  ) {
    return this.transport.request<DelegationInspection>(
      'POST',
      `/api/v1/runners/delegations/inspections/${inspectionId}/complete`,
      { body }
    )
  }
  delegationReceipt(
    attemptId: string,
    body: { leaseId: string; receipt: StageExecutionReceipt; codeRevision?: CodeRevision; review?: ReviewResult }
  ) {
    return this.transport.request('POST', `/api/v1/runners/delegations/attempts/${attemptId}/receipt`, { body })
  }
  controls(turnId: string, leaseId: string) {
    return this.transport.request<{ cancellationRequested: boolean; interactions: ProjectChatInteraction[] }>(
      'GET',
      `/api/v1/runners/chat/turns/${turnId}/controls?leaseId=${leaseId}`
    )
  }
  renew(turnId: string, leaseId: string) {
    return this.transport.request<{ leaseExpiresAt: string; cancellationRequested: boolean }>(
      'POST',
      `/api/v1/runners/chat/turns/${turnId}/lease`,
      { body: { leaseId } }
    )
  }
  events(turnId: string, leaseId: string, events: ChatUpload[]) {
    return this.transport.request<{ accepted: string[] }>('POST', `/api/v1/runners/chat/turns/${turnId}/events`, {
      body: { leaseId, events },
    })
  }
  complete(
    turnId: string,
    body: { leaseId: string; state: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; error?: string | null }
  ) {
    return this.transport.request('POST', `/api/v1/runners/chat/turns/${turnId}/complete`, { body })
  }
}
