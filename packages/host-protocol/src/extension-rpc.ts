import { z } from 'zod'
import { id, revision } from './common.js'
import { EXTENSION_LIMITS, SKILL_MAX_FILES, envKeySchema, extensionsStateSchema, mcpServerNameSchema, mcpServerSchema, skillFileSchema, skillNameSchema } from './extensions.js'

const envelope = { version: z.literal(1), id }
const request = <M extends string, S extends z.ZodType>(method: M, params: S) => z.strictObject({ ...envelope, method: z.literal(method), params })

/** The server as an application submits it: configuration plus the secret values, write-only. */
export const mcpServerInputSchema = z
  .strictObject({
    id: id.optional(),
    name: mcpServerNameSchema,
    transport: z.enum(['stdio', 'http']),
    command: z.string().min(1).max(512).optional(),
    args: z.array(z.string().max(512)).max(EXTENSION_LIMITS.argsMax).default([]),
    url: z.string().url().max(2048).optional(),
    headers: z.record(z.string().max(64), z.string().max(1024)).optional(),
    /** Values to store; a key absent here keeps the value already stored, an empty string removes it. */
    env: z.record(envKeySchema, z.string().max(EXTENSION_LIMITS.envValueMax)).default({}),
    /** Accepted so a state read back can be submitted as is; the stored keys are what the Host derives. */
    envKeys: z.array(envKeySchema).max(32).optional(),
    enabled: z.boolean().default(true),
  })
  .refine((s) => (s.transport === 'stdio' ? !!s.command && !s.url : !!s.url && !s.command), 'a stdio server names a command, an http server names a url')

export const extensionRequests = [
  request('extension.inspect', z.strictObject({ botId: id })),
  request('extension.mcp.upsert', z.strictObject({ botId: id, server: mcpServerInputSchema, expectedRevision: revision })),
  request('extension.mcp.remove', z.strictObject({ botId: id, serverId: id, expectedRevision: revision })),
  request(
    'extension.skill.install',
    z.strictObject({ botId: id, name: skillNameSchema, files: z.array(skillFileSchema).min(1).max(SKILL_MAX_FILES), expectedRevision: revision })
  ),
  request('extension.skill.remove', z.strictObject({ botId: id, name: skillNameSchema, expectedRevision: revision })),
  request('extension.skill.setEnabled', z.strictObject({ botId: id, name: skillNameSchema, enabled: z.boolean(), expectedRevision: revision })),
] as const
export const extensionRequestSchema = z.discriminatedUnion('method', [...extensionRequests])
export type ExtensionRequest = z.infer<typeof extensionRequestSchema>
export type ExtensionMethod = ExtensionRequest['method']
export const extensionMethods = extensionRequests.map((schema) => schema.shape.method.value) as readonly ExtensionMethod[]
export const extensionResultSchemas = {
  'extension.inspect': extensionsStateSchema,
  'extension.mcp.upsert': extensionsStateSchema,
  'extension.mcp.remove': extensionsStateSchema,
  'extension.skill.install': extensionsStateSchema,
  'extension.skill.remove': extensionsStateSchema,
  'extension.skill.setEnabled': extensionsStateSchema,
} satisfies Record<ExtensionMethod, z.ZodType>
export type ExtensionResult<M extends ExtensionMethod> = z.infer<(typeof extensionResultSchemas)[M]>
export const EXTENSION_MUTATIONS: readonly ExtensionMethod[] = extensionMethods.filter((method) => method !== 'extension.inspect')
export { mcpServerSchema }
