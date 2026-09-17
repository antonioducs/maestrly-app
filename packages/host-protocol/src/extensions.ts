import { z } from 'zod'
import { id, revision } from './common.js'

/**
 * Per-bot extensions: MCP servers and skills. The Host stores the configuration; the values of
 * environment variables are secrets that live in private files and only ever travel to the
 * guest, inside `extensions.apply`, right before a turn. They never appear in any RPC result.
 */
export const SKILL_MAX_BYTES = 512 * 1024
export const SKILL_MAX_FILES = 64
export const EXTENSION_LIMITS = Object.freeze({ mcpServersMax: 16, skillsMax: 32, envValueMax: 4096, argsMax: 32, headersMax: 32 })

export const mcpServerNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
export const skillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
export const envKeySchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)

/** A skill file path: relative, inside the skill, never a link out of it. */
export const skillFilePathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..') && !path.split('/').includes('') && !path.includes('\0'), 'skill file paths are relative and stay inside the skill')

const mcpServerBase = z.strictObject({
  id,
  name: mcpServerNameSchema,
  transport: z.enum(['stdio', 'http']),
  command: z.string().min(1).max(512).optional(),
  args: z.array(z.string().max(512)).max(EXTENSION_LIMITS.argsMax).default([]),
  url: z.string().url().max(2048).optional(),
  headers: z.record(z.string().max(64), z.string().max(1024)).optional(),
  /** Names only: the values are secrets and never come back. */
  envKeys: z.array(envKeySchema).max(32).default([]),
  enabled: z.boolean().default(true),
})
const shaped = (s: { transport: 'stdio' | 'http'; command?: string; url?: string }) =>
  s.transport === 'stdio' ? !!s.command && !s.url : !!s.url && !s.command
export const mcpServerSchema = mcpServerBase.refine(shaped, 'a stdio server names a command, an http server names a url')
export type McpServer = z.infer<typeof mcpServerSchema>

export const skillSummarySchema = z.strictObject({
  name: skillNameSchema,
  description: z.string().max(400),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  enabled: z.boolean(),
  revision,
})
export type SkillSummary = z.infer<typeof skillSummarySchema>

/** What an application sees: configuration and inventory, never a secret. */
export const extensionsStateSchema = z.strictObject({
  botId: id,
  revision,
  mcpServers: z.array(mcpServerSchema).max(EXTENSION_LIMITS.mcpServersMax),
  skills: z.array(skillSummarySchema).max(EXTENSION_LIMITS.skillsMax),
})
export type ExtensionsState = z.infer<typeof extensionsStateSchema>

export const skillFileSchema = z.strictObject({ path: skillFilePathSchema, dataBase64: z.string().max(Math.ceil((SKILL_MAX_BYTES * 4) / 3) + 4) })

/** Sent to the guest before turn.start. Carries the secrets; is never persisted by the Host. */
export const extensionsApplySchema = z.strictObject({
  revision,
  mcpServers: z
    .array(mcpServerBase.extend({ env: z.record(envKeySchema, z.string().max(EXTENSION_LIMITS.envValueMax)).default({}) }).refine(shaped))
    .max(EXTENSION_LIMITS.mcpServersMax),
  skills: z
    .array(z.strictObject({ name: skillNameSchema, files: z.array(skillFileSchema).min(1).max(SKILL_MAX_FILES) }))
    .max(EXTENSION_LIMITS.skillsMax),
})
export type ExtensionsApply = z.infer<typeof extensionsApplySchema>
export const extensionsAppliedSchema = z.strictObject({ applied: revision })
