import {
  PROTOCOL_VERSION,
  cardSchema,
  instanceMetadataSchema,
  supportsProtocol,
  type PersonalDevice,
  type ProjectTeam,
  type ProjectRole,
  type Card,
  type Board,
  type RepositoryBinding,
  type ColumnAutomation,
  type ColumnAutomationView,
  type CardAutomationOverride,
  type CardPatch,
  type InstanceMetadata,
  type MoveCardRequest,
} from '@maestrly/protocol'
import { streamProjectEvents, type EventStreamOptions } from './events.js'
import { HttpTransport, MaestrlyApiError, type TransportOptions } from './transport.js'

export class MaestrlyClient {
  readonly transport: HttpTransport

  constructor(options: TransportOptions) {
    this.transport = new HttpTransport({ protocolVersion: PROTOCOL_VERSION, ...options })
  }

  projectTeam(organizationId:string,projectId:string):Promise<ProjectTeam>{return this.transport.request('GET',`/api/v1/organizations/${organizationId}/projects/${projectId}/team`)}
  changeProjectMember(organizationId:string,projectId:string,input:{expectedVersion:number;userId:string;role:ProjectRole|null},idempotencyKey:string){return this.transport.request('PUT',`/api/v1/organizations/${organizationId}/projects/${projectId}/team/members`,{body:input,idempotencyKey})}
  inviteProjectMember(organizationId:string,projectId:string,input:{expectedVersion:number;email:string;role:ProjectRole;expiresInHours:number},idempotencyKey:string):Promise<{id:string;url:string}>{return this.transport.request('POST',`/api/v1/organizations/${organizationId}/projects/${projectId}/team/invitations`,{body:input,idempotencyKey})}
  changeProjectInvitation(organizationId:string,projectId:string,input:{expectedVersion:number;invitationId:string;action:'revoke'|'renew';expiresInHours:number},idempotencyKey:string):Promise<{id:string;url:string|null}>{return this.transport.request('POST',`/api/v1/organizations/${organizationId}/projects/${projectId}/team/invitations/change`,{body:input,idempotencyKey})}

  personalDevices(organizationId:string,projectId:string):Promise<PersonalDevice[]>{return this.transport.request('GET',`/api/v1/organizations/${organizationId}/projects/${projectId}/personal-devices`)}
  revokePersonalDevice(organizationId:string,deviceId:string,idempotencyKey:string){return this.transport.request('POST',`/api/v1/organizations/${organizationId}/personal-devices/${deviceId}/revoke`,{body:{},idempotencyKey})}
  async metadata(): Promise<InstanceMetadata> {
    const metadata = instanceMetadataSchema.parse(await this.transport.request('GET', '/api/v1/meta'))
    if (!metadata.protocolVersions.some(supportsProtocol)) {
      throw new MaestrlyApiError(426, {
        code: 'PROTOCOL_INCOMPATIBLE',
        message: 'This Maestrly instance does not support the client protocol.',
        requestId: 'client-negotiation',
        details: { supported: metadata.protocolVersions, requested: PROTOCOL_VERSION },
      })
    }
    return metadata
  }

  async createCard(organizationId: string, boardId: string, input: unknown, idempotencyKey: string): Promise<Card> {
    const value = await this.transport.request('POST', `/api/v1/organizations/${organizationId}/boards/${boardId}/cards`, {
      body: input, idempotencyKey,
    })
    return cardSchema.parse(value)
  }

  async updateCard(organizationId: string, cardId: string, patch: CardPatch, idempotencyKey: string): Promise<Card> {
    const value = await this.transport.request('PATCH', `/api/v1/organizations/${organizationId}/cards/${cardId}`, {
      body: patch, idempotencyKey,
    })
    return cardSchema.parse(value)
  }

  async moveCard(organizationId: string, cardId: string, move: MoveCardRequest, idempotencyKey: string): Promise<Card> {
    const value = await this.transport.request<{card:Card}>('POST', `/api/v1/organizations/${organizationId}/cards/${cardId}/move`, {
      body: move, idempotencyKey,
    })
    return cardSchema.parse(value.card)
  }


  boards(organizationId:string,projectId:string,includeArchived=false):Promise<Board[]> {
    return this.transport.request('GET',`/api/v1/organizations/${organizationId}/projects/${projectId}/boards?includeArchived=${includeArchived}`)
  }
  manageColumns(organizationId:string,boardId:string,input:{expectedVersion:number;action:'create'|'rename'|'reorder'|'delete';columnId?:string;name?:string;order?:string[];destinationId?:string;expectedCardIds?:string[]},idempotencyKey:string) {
    return this.transport.request<{version:number;columnId?:string}>('POST',`/api/v1/organizations/${organizationId}/boards/${boardId}/columns/manage`,{body:input,idempotencyKey})
  }
  cardLifecycle(organizationId:string,cardId:string,expectedVersion:number,action:'archive'|'restore'|'delete'|'cancel',idempotencyKey:string) {
    return this.transport.request<{ok:boolean;affected:number}>('POST',`/api/v1/organizations/${organizationId}/cards/${cardId}/lifecycle`,{body:{expectedVersion,action},idempotencyKey})
  }
  repositories(organizationId:string,projectId:string):Promise<RepositoryBinding[]> {
    return this.transport.request('GET',`/api/v1/organizations/${organizationId}/projects/${projectId}/repositories`)
  }


  columnAutomation(organizationId:string,columnId:string):Promise<ColumnAutomationView> {
    return this.transport.request('GET',`/api/v1/organizations/${organizationId}/columns/${columnId}/automation`)
  }
  saveColumnAutomation(organizationId:string,columnId:string,expectedPolicyId:string|null,config:ColumnAutomation,idempotencyKey:string) {
    return this.transport.request<{policyId:string;version:number;config:ColumnAutomation}>('PUT',`/api/v1/organizations/${organizationId}/columns/${columnId}/automation`,{body:{expectedPolicyId,config},idempotencyKey})
  }
  requestColumnAgent(organizationId:string,cardId:string,expectedVersion:number,expectedPolicyId:string|null,idempotencyKey:string,expectedOverrideVersion=0) {
    return this.transport.request<{jobId:string|null;blocked?:boolean;reason?:string}>('POST',`/api/v1/organizations/${organizationId}/cards/${cardId}/automation/run`,{body:{expectedVersion,expectedPolicyId,expectedOverrideVersion},idempotencyKey})
  }
  setCardAutomationOverride(organizationId:string,cardId:string,columnId:string,expectedVersion:number,config:CardAutomationOverride|null,idempotencyKey:string) {
    return this.transport.request('PUT',`/api/v1/organizations/${organizationId}/cards/${cardId}/automation/override`,{body:{columnId,expectedVersion,config},idempotencyKey})
  }
  events(options: EventStreamOptions) {
    return streamProjectEvents(this.transport, options)
  }
}
