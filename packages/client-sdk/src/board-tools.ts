import type { CardPatch, MoveCardRequest } from '@maestrly/protocol'
import type { MaestrlyClient } from './client.js'

export class BoardToolsClient {
  constructor(
    private readonly client: MaestrlyClient,
    private readonly organizationId: string,
    private readonly runId: string,
  ) {}

  listCards(projectId: string) {
    return this.client.transport.request('GET', `/api/v1/agent-tools/projects/${projectId}/cards`, {
      headers: { 'x-maestrly-organization-id': this.organizationId, 'x-maestrly-run-id': this.runId },
    })
  }

  updateAssignedCard(cardId: string, patch: CardPatch, idempotencyKey: string) {
    return this.client.transport.request('PATCH', `/api/v1/agent-tools/cards/${cardId}`, {
      body: patch,
      idempotencyKey,
      headers: { 'x-maestrly-organization-id': this.organizationId, 'x-maestrly-run-id': this.runId },
    })
  }

  comment(cardId: string, body: string, idempotencyKey: string) {
    return this.client.transport.request('POST', `/api/v1/agent-tools/cards/${cardId}/comments`, {
      body: { body },
      idempotencyKey,
      headers: { 'x-maestrly-organization-id': this.organizationId, 'x-maestrly-run-id': this.runId },
    })
  }

  createSubtask(cardId: string, input: { title: string; description?: string }, idempotencyKey: string) {
    return this.client.transport.request('POST', `/api/v1/agent-tools/cards/${cardId}/subtasks`, {
      body: input,
      idempotencyKey,
      headers: { 'x-maestrly-organization-id': this.organizationId, 'x-maestrly-run-id': this.runId },
    })
  }

  move(cardId: string, move: MoveCardRequest, idempotencyKey: string) {
    return this.client.transport.request('POST', `/api/v1/agent-tools/cards/${cardId}/move`, {
      body: move,
      idempotencyKey,
      headers: { 'x-maestrly-organization-id': this.organizationId, 'x-maestrly-run-id': this.runId },
    })
  }
}
