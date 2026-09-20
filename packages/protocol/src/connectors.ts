import { z } from 'zod'
import { opaqueIdSchema, utcDateTimeSchema } from './identity.js'

/**
 * External agent connections (for example a Grok Bot) authenticate with OAuth and act through the MCP
 * endpoint. A connection never widens its own authorization: the owner selects projects and actions in
 * Maestrly, and every tool call rechecks the persisted grant.
 */
export const CONNECTOR_MCP_PATH = '/mcp' as const
export const CONNECTOR_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource/mcp' as const

export const connectorActionSchema = z.enum([
  /** Read tasks, stages, attempts, events, findings and artifact metadata. */
  'tasks:read',
  /** Create tasks, send follow-ups and change stage configuration. */
  'tasks:write',
  /** Start, pause, resume and cancel work. */
  'execution:control',
  /** Download artifact content and request project checks. */
  'evidence:read',
  /** Read-only inspection of files, diff, search and pull requests. */
  'inspect:read',
  /** Authorized browser interaction on a configured preview. */
  'inspect:interact',
  /** Request commit, push, pull request and merge deliveries. */
  'delivery:manage',
  /** Answer questions raised by an execution within the granted scope. */
  'interactions:answer',
])

export const CONNECTOR_ACTIONS = connectorActionSchema.options
/** Actions that never mutate project state; used to pick the required OAuth scope. */
export const CONNECTOR_READ_ACTIONS: ReadonlyArray<ConnectorAction> = [
  'tasks:read',
  'evidence:read',
  'inspect:read',
]

export const connectorGrantSchema = z
  .object({
    projectId: opaqueIdSchema,
    actions: z.array(connectorActionSchema).min(1).max(CONNECTOR_ACTIONS.length),
  })
  .strict()

export const connectorOriginSchema = z
  .object({ address: z.string().max(191).nullable(), userAgent: z.string().max(500).nullable() })
  .strict()

/**
 * Identity of an authenticated connector request. The server derives every field from the verified
 * token and the persisted connection; client-supplied bot names are metadata only.
 */
export const connectorPrincipalSchema = z
  .object({
    organizationId: opaqueIdSchema,
    connectionId: opaqueIdSchema,
    clientId: opaqueIdSchema,
    userId: opaqueIdSchema,
    scopes: z.array(z.string().min(1).max(191)).max(50),
    grants: z.array(connectorGrantSchema).max(200),
    cancelOnRevoke: z.boolean(),
    origin: connectorOriginSchema,
    /** Self-asserted client label, never used for authorization. */
    clientLabel: z.string().max(160).nullable(),
  })
  .strict()

export const connectorConnectionSchema = z
  .object({
    id: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    ownerUserId: opaqueIdSchema,
    clientId: opaqueIdSchema,
    name: z.string().min(1).max(160),
    grants: z.array(connectorGrantSchema).max(200),
    cancelOnRevoke: z.boolean(),
    version: z.number().int().positive(),
    revokedAt: utcDateTimeSchema.nullable(),
    lastUsedAt: utcDateTimeSchema.nullable(),
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
  })
  .strict()

export const connectorConnectionCreateSchema = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    name: z.string().trim().min(1).max(160),
    grants: z.array(connectorGrantSchema).min(1).max(200),
    cancelOnRevoke: z.boolean().default(true),
  })
  .strict()

export const connectorConnectionPatchSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(160).optional(),
    grants: z.array(connectorGrantSchema).max(200).optional(),
    cancelOnRevoke: z.boolean().optional(),
    revoked: z.boolean().optional(),
  })
  .strict()

/** Endpoint the server calls to wake a Grok routine. Secrets are stored encrypted and never returned. */
export const connectorNotificationEndpointSchema = z
  .object({
    id: opaqueIdSchema,
    connectionId: opaqueIdSchema,
    url: z.string().url(),
    enabled: z.boolean(),
    /** Digest fingerprint so the UI can confirm which secret is stored without revealing it. */
    secretFingerprint: z.string().min(1).max(64),
    lastStatus: z.string().max(191).nullable(),
    lastDeliveredAt: utcDateTimeSchema.nullable(),
    failureCount: z.number().int().nonnegative(),
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
  })
  .strict()

export const connectorNotificationEndpointInputSchema = z
  .object({
    url: z.string().url().max(2000),
    secret: z.string().min(16).max(500),
    enabled: z.boolean().default(true),
  })
  .strict()

export const connectorNotificationPayloadSchema = z
  .object({
    version: z.literal(1),
    eventId: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    taskId: opaqueIdSchema,
    sequence: z.number().int().positive(),
    type: z.string().min(1).max(120),
    state: z.string().min(1).max(60),
    summary: z.string().max(2000),
    url: z.string().url(),
    createdAt: utcDateTimeSchema,
  })
  .strict()

export type ConnectorAction = z.infer<typeof connectorActionSchema>
export type ConnectorGrant = z.infer<typeof connectorGrantSchema>
export type ConnectorPrincipal = z.infer<typeof connectorPrincipalSchema>
export type ConnectorConnection = z.infer<typeof connectorConnectionSchema>
export type ConnectorConnectionCreate = z.infer<typeof connectorConnectionCreateSchema>
export type ConnectorConnectionPatch = z.infer<typeof connectorConnectionPatchSchema>
export type ConnectorNotificationEndpoint = z.infer<typeof connectorNotificationEndpointSchema>
export type ConnectorNotificationEndpointInput = z.infer<typeof connectorNotificationEndpointInputSchema>
export type ConnectorNotificationPayload = z.infer<typeof connectorNotificationPayloadSchema>

export function connectorActionIsRead(action: ConnectorAction): boolean {
  return CONNECTOR_READ_ACTIONS.includes(action)
}

/** Resource identifier the MCP endpoint accepts as the token audience. */
export function connectorMcpResource(canonicalUrl: string): string {
  return canonicalUrl.replace(/\/$/, '') + CONNECTOR_MCP_PATH
}
