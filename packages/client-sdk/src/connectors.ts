import {
  connectorConnectionSchema,
  connectorNotificationEndpointSchema,
  type ConnectorAction,
  type ConnectorConnection,
  type ConnectorConnectionCreate,
  type ConnectorConnectionPatch,
  type ConnectorNotificationEndpoint,
  type ConnectorNotificationEndpointInput,
} from '@maestrly/protocol'
import type { HttpTransport } from './transport.js'

export interface ConnectorOverview {
  /** MCP endpoint an external agent connects to. */
  mcpUrl: string
  protectedResourceMetadataUrl: string
  authorizationServer: string
  actions: readonly ConnectorAction[]
  dynamicRegistration: boolean
  connections: ConnectorConnection[]
}

/** Typed client for external agent connections and the routine callback they listen on. */
export class ConnectorsApi {
  constructor(private readonly transport: HttpTransport) {}

  private root(organizationId: string) {
    return `/api/v1/organizations/${organizationId}/connectors`
  }

  async overview(organizationId: string): Promise<ConnectorOverview> {
    const value = await this.transport.request<ConnectorOverview>('GET', this.root(organizationId))
    return { ...value, connections: value.connections.map((item) => connectorConnectionSchema.parse(item)) }
  }

  async connect(
    organizationId: string,
    input: ConnectorConnectionCreate,
    idempotencyKey: string
  ): Promise<ConnectorConnection> {
    return connectorConnectionSchema.parse(
      await this.transport.request('POST', this.root(organizationId), { body: input, idempotencyKey })
    )
  }

  async patch(
    organizationId: string,
    connectionId: string,
    input: ConnectorConnectionPatch,
    idempotencyKey: string
  ): Promise<ConnectorConnection> {
    return connectorConnectionSchema.parse(
      await this.transport.request('PATCH', `${this.root(organizationId)}/${connectionId}`, {
        body: input,
        idempotencyKey,
      })
    )
  }

  async notificationEndpoint(
    organizationId: string,
    connectionId: string
  ): Promise<ConnectorNotificationEndpoint | null> {
    const value = await this.transport.request<{ endpoint: ConnectorNotificationEndpoint | null }>(
      'GET',
      `${this.root(organizationId)}/${connectionId}/notification-endpoint`
    )
    return value.endpoint ? connectorNotificationEndpointSchema.parse(value.endpoint) : null
  }

  /** The secret is write-only: the response carries its fingerprint so the interface can confirm it. */
  async setNotificationEndpoint(
    organizationId: string,
    connectionId: string,
    input: ConnectorNotificationEndpointInput
  ): Promise<ConnectorNotificationEndpoint> {
    return connectorNotificationEndpointSchema.parse(
      await this.transport.request('PUT', `${this.root(organizationId)}/${connectionId}/notification-endpoint`, {
        body: input,
      })
    )
  }

  async removeNotificationEndpoint(organizationId: string, connectionId: string): Promise<void> {
    await this.transport.request('DELETE', `${this.root(organizationId)}/${connectionId}/notification-endpoint`)
  }
}
