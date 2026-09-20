import { HttpTransport } from '@maestrly/client-sdk'
import type {
  ChatInventory,
  ChatUpload,
  DelegationModelCatalog,
  ProjectChatClaim,
  ProjectChatInteraction,
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
  delegationReceipt(attemptId: string, body: { leaseId: string; receipt: StageExecutionReceipt }) {
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
