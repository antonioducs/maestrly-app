import { z } from 'zod'
import { id, revision } from './common.js'
import { isoDate } from './bots.js'

/**
 * Stored prompt templates ("slash commands"). A prompt belongs either to the Host (every bot
 * sees it) or to one bot. Expansion of `$ARGUMENTS` happens in the application: the Host only
 * keeps the text, so any guest — old or new — receives a plain message.
 */
export const PROMPT_LIMITS = Object.freeze({ nameMax: 64, descriptionMax: 200, templateMax: 16 * 1024, perScopeMax: 200 })
export const promptNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
export const promptScopeSchema = z.enum(['host', 'bot'])
export const botPromptSchema = z.strictObject({
  id,
  scope: promptScopeSchema,
  botId: id.optional(),
  name: promptNameSchema,
  description: z.string().max(PROMPT_LIMITS.descriptionMax).default(''),
  template: z.string().min(1).max(PROMPT_LIMITS.templateMax),
  revision,
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type BotPrompt = z.infer<typeof botPromptSchema>

const envelope = { version: z.literal(1), id }
const request = <M extends string, S extends z.ZodType>(method: M, params: S) => z.strictObject({ ...envelope, method: z.literal(method), params })

export const promptRequests = [
  request('prompt.list', z.strictObject({ scope: promptScopeSchema.optional(), botId: id.optional() })),
  request(
    'prompt.upsert',
    z.strictObject({
      id: id.optional(),
      scope: promptScopeSchema,
      botId: id.optional(),
      name: promptNameSchema,
      description: z.string().max(PROMPT_LIMITS.descriptionMax).default(''),
      template: z.string().min(1).max(PROMPT_LIMITS.templateMax),
      expectedRevision: revision.optional(),
    })
  ),
  request('prompt.delete', z.strictObject({ id, expectedRevision: revision })),
] as const
export const promptRequestSchema = z.discriminatedUnion('method', [...promptRequests])
export type PromptRequest = z.infer<typeof promptRequestSchema>
export type PromptMethod = PromptRequest['method']
export const promptMethods = promptRequests.map((schema) => schema.shape.method.value) as readonly PromptMethod[]
export const promptResultSchemas = {
  'prompt.list': z.strictObject({ prompts: z.array(botPromptSchema).max(PROMPT_LIMITS.perScopeMax * 2) }),
  'prompt.upsert': botPromptSchema,
  'prompt.delete': z.strictObject({ deleted: z.literal(true) }),
} satisfies Record<PromptMethod, z.ZodType>
export type PromptResult<M extends PromptMethod> = z.infer<(typeof promptResultSchemas)[M]>
export const PROMPT_MUTATIONS: readonly PromptMethod[] = ['prompt.upsert', 'prompt.delete']

/** Replaces `$ARGUMENTS` with what the person typed after the command; nothing else is interpreted. */
export function expandPrompt(template: string, args: string): string {
  return template.replaceAll('$ARGUMENTS', args.trim())
}
