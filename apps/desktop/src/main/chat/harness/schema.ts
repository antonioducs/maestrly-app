import { z } from 'zod'
import { HARNESS_CAPABILITY_NAMES } from '../../../shared/harness'
import {
  HARNESS_ENDPOINT_KINDS,
  HARNESS_ENVIRONMENT_PLACEMENTS,
  HARNESS_HOOK_STRATEGIES,
  HARNESS_MODES,
  HARNESS_PROGRESS_MODES,
  HARNESS_PROMPT_LAYOUTS,
  HARNESS_SCHEMA_VERSION,
  type HarnessDefinition,
} from './types'

/** Provider kinds are a finite host selection, never a predicate language. */
const PROVIDER_KINDS = [
  '*',
  'anthropic',
  'openai',
  'openai-responses',
  'codex-subscription',
  'github-copilot-subscription',
  'claude-subscription',
  'grok-subscription',
] as const

const identity = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9._@-]*$/, 'identity must be lowercase and use only [a-z0-9._@-]')

/**
 * Markdown references stay inside the profile folder: no traversal, absolute path, URL or
 * Windows drive prefix. Inheritance uses the resolved default profile, never `../default`.
 */
const textRef = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, 'text references must be a plain .md file in the profile folder')

const capabilityClaims = z
  .object(Object.fromEntries(HARNESS_CAPABILITY_NAMES.map((name) => [name, z.boolean().optional()])))
  .strict()

const ultraRefs = z
  .object({
    base: textRef,
    byMode: z.object(Object.fromEntries(HARNESS_MODES.map((mode) => [mode, textRef]))).strict(),
  })
  .strict()

const promptOverrides = z
  .object({
    layout: z.enum(HARNESS_PROMPT_LAYOUTS).optional(),
    base: textRef.nullable().optional(),
    styleAndWork: textRef.nullable().optional(),
    behaviorHeader: z.boolean().optional(),
    subagent: textRef.nullable().optional(),
    compaction: textRef.nullable().optional(),
    ultra: ultraRefs.nullable().optional(),
    developerPrefix: z
      .object({ base: textRef, asyncTools: textRef.optional() })
      .strict()
      .nullable()
      .optional(),
    environment: z
      .object({
        placement: z.enum(HARNESS_ENVIRONMENT_PLACEMENTS).optional(),
        transient: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const reasoningOverrides = z
  .object({
    manifestEfforts: z.array(z.string().trim().min(1)).readonly().nullable().optional(),
    nonSerializableEfforts: z.array(z.string().trim().min(1)).readonly().optional(),
    nativeUltra: z.boolean().optional(),
  })
  .strict()

const runtimeOverrides = z
  .object({
    promptCacheTtl: z.literal('30m').nullable().optional(),
    personality: z.literal('pragmatic').nullable().optional(),
    nativeCompactionFirst: z.boolean().optional(),
    experimentalContext: z.boolean().optional(),
    codexPromptVersion: identity.optional(),
  })
  .strict()

const identityOverrides = z
  .object({
    harnessProfileId: identity.optional(),
    behaviorProfileId: identity.nullable().optional(),
    compatibilityGroup: identity.optional(),
    promptIdentity: identity.optional(),
  })
  .strict()

const hookOverride = z
  .object({
    id: z.enum(HARNESS_HOOK_STRATEGIES),
    text: textRef,
    maxReminders: z.number().int().positive().max(1000).optional(),
  })
  .strict()

const overrides = z
  .object({
    identity: identityOverrides.optional(),
    prompts: promptOverrides.optional(),
    reasoning: reasoningOverrides.optional(),
    capabilities: capabilityClaims.optional(),
    runtime: runtimeOverrides.optional(),
    progress: z.enum(HARNESS_PROGRESS_MODES).optional(),
    hooks: z.array(hookOverride).readonly().optional(),
  })
  .strict()

const binding = z
  .object({
    providerKind: z.enum(PROVIDER_KINDS),
    endpoint: z.enum(HARNESS_ENDPOINT_KINDS).optional(),
    overrides,
  })
  .strict()

const source = z
  .object({
    repository: z.string().trim().min(1),
    commit: z.string().trim().min(1),
    /** Upstream model the template belongs to; provenance only, never a matching rule. */
    model: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1),
    sourceUrl: z.string().trim().min(1).optional(),
    license: z.string().trim().min(1),
    upstreamSha256: z.string().trim().regex(/^[0-9a-f]{64}$/).optional(),
    adaptedSha256: z.string().trim().regex(/^[0-9a-f]{64}$/).optional(),
    adaptations: z.array(z.string().trim().min(1)).readonly().optional(),
  })
  .strict()

export const harnessDefinitionSchema = z
  .object({
    schemaVersion: z.literal(HARNESS_SCHEMA_VERSION),
    id: identity,
    profileVersion: z.number().int().positive(),
    match: z
      .object({
        aliases: z.array(z.string().trim().min(1)).readonly().optional(),
        caseInsensitive: z.boolean().optional(),
      })
      .strict()
      .optional(),
    featureFlag: z
      .object({ key: z.string().trim().min(1), default: z.boolean() })
      .strict()
      .optional(),
    bindings: z.array(binding).min(1).readonly(),
    source: source.optional(),
  })
  .strict()

export type HarnessDefinitionInput = z.input<typeof harnessDefinitionSchema>

export class HarnessConfigError extends Error {
  constructor(
    readonly profileId: string,
    readonly file: string,
    message: string
  ) {
    super(`[harness:${profileId}] ${file}: ${message}`)
    this.name = 'HarnessConfigError'
  }
}

/** Reserved keys never reach the merge: configuration is plain data, not a prototype carrier. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function assertPlainData(profileId: string, file: string, value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPlainData(profileId, file, entry, `${path}[${index}]`))
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new HarnessConfigError(profileId, file, `${path} must be a plain object`)
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new HarnessConfigError(profileId, file, `${path}.${key} is a reserved key`)
    }
    assertPlainData(profileId, file, (value as Record<string, unknown>)[key], `${path}.${key}`)
  }
}

export function parseHarnessDefinition(profileId: string, file: string, raw: string): HarnessDefinition {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new HarnessConfigError(profileId, file, `invalid JSON (${(error as Error).message})`)
  }
  assertPlainData(profileId, file, parsed)
  const result = harnessDefinitionSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]!
    const field = issue.path.length ? issue.path.join('.') : '$'
    throw new HarnessConfigError(profileId, file, `${field}: ${issue.message}`)
  }
  return result.data as HarnessDefinition
}
