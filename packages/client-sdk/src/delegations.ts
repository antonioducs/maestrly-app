import {
  delegationEventSchema,
  delegationPresetSchema,
  delegationTaskSchema,
  delegationTaskViewSchema,
  stageAttemptSchema,
  type DelegationCommand,
  type DelegationCommandResult,
  type DelegationCreate,
  type DelegationEvent,
  type DelegationExecutor,
  type DelegationPreset,
  type DelegationPresetInput,
  type DelegationPresetPatch,
  type DelegationTask,
  type DelegationTaskState,
  type DelegationTaskView,
  type StageAttempt,
} from '@maestrly/protocol'
import type { HttpTransport } from './transport.js'

export interface DelegationListItem {
  task: DelegationTask
  links: { task: string; card: string }
}

/** Typed client for the delegation domain, shared by the web app and any other authorized caller. */
export class DelegationsApi {
  constructor(private readonly transport: HttpTransport) {}

  private root(organizationId: string, projectId: string) {
    return `/api/v1/organizations/${organizationId}/projects/${projectId}`
  }

  async catalog(organizationId: string, projectId: string): Promise<DelegationExecutor[]> {
    const value = await this.transport.request<{ executors: DelegationExecutor[] }>(
      'GET',
      `${this.root(organizationId, projectId)}/delegation-catalog`
    )
    return value.executors
  }

  async list(
    organizationId: string,
    projectId: string,
    filter: { state?: DelegationTaskState; cardId?: string; after?: string; limit?: number } = {}
  ): Promise<{ items: DelegationListItem[]; more: boolean }> {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(filter)) if (value !== undefined) query.set(key, String(value))
    const suffix = query.size ? `?${query.toString()}` : ''
    const value = await this.transport.request<{ items: DelegationListItem[]; more: boolean }>(
      'GET',
      `${this.root(organizationId, projectId)}/delegations${suffix}`
    )
    return {
      items: value.items.map((item) => ({ task: delegationTaskSchema.parse(item.task), links: item.links })),
      more: value.more,
    }
  }

  async create(
    organizationId: string,
    projectId: string,
    input: DelegationCreate,
    idempotencyKey: string
  ): Promise<DelegationTaskView> {
    return delegationTaskViewSchema.parse(
      await this.transport.request('POST', `${this.root(organizationId, projectId)}/delegations`, {
        body: input,
        idempotencyKey,
      })
    )
  }

  async get(organizationId: string, projectId: string, taskId: string): Promise<DelegationTaskView> {
    return delegationTaskViewSchema.parse(
      await this.transport.request('GET', `${this.root(organizationId, projectId)}/delegations/${taskId}`)
    )
  }

  command(
    organizationId: string,
    projectId: string,
    taskId: string,
    command: DelegationCommand,
    idempotencyKey: string
  ): Promise<DelegationCommandResult> {
    return this.transport.request('POST', `${this.root(organizationId, projectId)}/delegations/${taskId}/commands`, {
      body: command,
      idempotencyKey,
    })
  }

  async attempts(organizationId: string, projectId: string, taskId: string): Promise<StageAttempt[]> {
    const value = await this.transport.request<{ items: unknown[] }>(
      'GET',
      `${this.root(organizationId, projectId)}/delegations/${taskId}/attempts`
    )
    return value.items.map((item) => stageAttemptSchema.parse(item))
  }

  async events(
    organizationId: string,
    projectId: string,
    taskId: string,
    cursor = 0
  ): Promise<DelegationEvent[]> {
    const value = await this.transport.request<{ items: unknown[] }>(
      'GET',
      `${this.root(organizationId, projectId)}/delegations/${taskId}/events?cursor=${cursor}`,
      { headers: { accept: 'application/json' } }
    )
    return value.items.map((item) => delegationEventSchema.parse(item))
  }

  async presets(organizationId: string, projectId: string): Promise<DelegationPreset[]> {
    const value = await this.transport.request<{ items: unknown[] }>(
      'GET',
      `${this.root(organizationId, projectId)}/delegation-presets`
    )
    return value.items.map((item) => delegationPresetSchema.parse(item))
  }

  async createPreset(
    organizationId: string,
    projectId: string,
    input: DelegationPresetInput,
    idempotencyKey: string
  ): Promise<DelegationPreset> {
    return delegationPresetSchema.parse(
      await this.transport.request('POST', `${this.root(organizationId, projectId)}/delegation-presets`, {
        body: input,
        idempotencyKey,
      })
    )
  }

  async patchPreset(
    organizationId: string,
    projectId: string,
    presetId: string,
    patch: DelegationPresetPatch,
    idempotencyKey: string
  ): Promise<DelegationPreset> {
    return delegationPresetSchema.parse(
      await this.transport.request(
        'PATCH',
        `${this.root(organizationId, projectId)}/delegation-presets/${presetId}`,
        { body: patch, idempotencyKey }
      )
    )
  }
}

/** Parses complete SSE frames from the delegation event stream across chunk boundaries. */
export async function* readDelegationEvents(response: Response): AsyncGenerator<DelegationEvent> {
  if (!response.ok || !response.body) throw new Error('Delegation stream unavailable: ' + response.status)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > 4_000_000) throw new Error('Delegation stream frame too large.')
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        if (/^event: access_revoked$/m.test(frame)) throw new Error('Project access was removed.')
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) yield delegationEventSchema.parse(JSON.parse(data))
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
