import { HttpTransport } from '@maestrly/client-sdk'
import type { ChatInventory, ChatUpload, ProjectChatClaim, ProjectChatInteraction } from '@maestrly/protocol'
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
  claim() {
    return this.transport.request<ProjectChatClaim | null>('POST', '/api/v1/runners/chat/claim', { body: {} })
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
