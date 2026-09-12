import { z } from 'zod'

export const AUTOMATION_RUNTIME_VERSION = 1 as const
export const columnRoleSchema = z.enum(['backlog', 'normal', 'done'])
export const maestroStrategySchema = z.enum(['balanced', 'best-quality', 'fast', 'economy'])
export const automationDefaults = {
  maxPerCardPerColumn: 3,
  breakerWindowMs: 600_000,
  maxDurationSeconds: 3_600,
  maxLogBytes: 10_485_760,
} as const
export const automationLimitsSchema = z
  .object({
    maxPerCardPerColumn: z.number().int().min(1).max(100).nullable().optional(),
    breakerWindowMs: z.number().int().min(1_000).max(86_400_000).nullable().optional(),
    maxDurationSeconds: z.number().int().min(1).max(86_400).nullable().optional(),
    maxLogBytes: z.number().int().min(1).max(10_485_760).nullable().optional(),
  })
  .strict()
export const columnAutomationSchema = z
  .object({
    enabled: z.boolean().default(false),
    autoRun: z.boolean().default(false),
    provider: z.enum(['codex', 'claude-agent', 'maestrly']).default('codex'),
    model: z.string().max(160).default(''),
    effort: z.string().max(80).nullable().default(null),
    fastMode: z.boolean().default(false),
    promptTemplate: z.string().max(100_000).default(''),
    mode: z.enum(['standard', 'maestro']).default('standard'),
    maestroStrategy: maestroStrategySchema.default('balanced'),
    subagentsEnabled: z.boolean().default(false),
    preCommands: z.array(z.string().trim().min(1).max(4000)).max(20).default([]),
    runnerSelector: z.enum(['pool', 'runner']).default('pool'),
    targetRunnerId: z.string().uuid().nullable().default(null),
    repositoryBindingId: z.string().uuid().nullable().default(null),
    repositoryBranch: z.string().max(250).nullable().default(null),
    taskType: z.enum(['code', 'analysis']).default('code'),
    approvalRequired: z.boolean().default(true),
    maxDurationSeconds: z.number().int().min(1).max(86400).nullable().default(null),
    maxLogBytes: z.number().int().min(1).max(10485760).nullable().default(null),
  })
  .strict()
export const cardAutomationOverrideSchema = z
  .object({
    provider: z.enum(['codex', 'claude-agent', 'maestrly']).optional(),
    model: z.string().min(1).max(160).optional(),
    effort: z.string().max(80).nullable().optional(),
    fastMode: z.boolean().optional(),
  })
  .strict()
export const executorModelSchema = z.object({
  provider: z.enum(['codex', 'claude-agent', 'maestrly']),
  model: z.string().min(1).max(160),
  label: z.string().min(1).max(200),
  efforts: z.array(z.string().min(1).max(80)).max(20).default([]),
  fastMode: z.boolean().default(false),
  fastServiceTier: z.string().max(80).optional(),
})
export const runnerAutomationCapabilitiesSchema = z.object({
  version: z.literal(AUTOMATION_RUNTIME_VERSION),
  models: z.array(executorModelSchema).max(500),
  maestro: z.boolean(),
  subagents: z.boolean(),
  preCommands: z.boolean(),
  issues: z.array(z.string().max(500)).max(20).default([]),
})
export type ColumnAutomation = z.infer<typeof columnAutomationSchema>
export type CardAutomationOverride = z.infer<typeof cardAutomationOverrideSchema>
export type AutomationLimits = z.infer<typeof automationLimitsSchema>
export type ExecutorModel = z.infer<typeof executorModelSchema>
export type RunnerAutomationCapabilities = z.infer<typeof runnerAutomationCapabilitiesSchema>

export function resolveAutomationLimits(overrides: AutomationLimits = {}) {
  return {
    maxPerCardPerColumn: overrides.maxPerCardPerColumn ?? automationDefaults.maxPerCardPerColumn,
    breakerWindowMs: overrides.breakerWindowMs ?? automationDefaults.breakerWindowMs,
    maxDurationSeconds: overrides.maxDurationSeconds ?? automationDefaults.maxDurationSeconds,
    maxLogBytes: overrides.maxLogBytes ?? automationDefaults.maxLogBytes,
  }
}
export function renderAutomationPrompt(
  template: string,
  card: { id: string; title: string; description: string },
  column: string
) {
  const vars: Record<string, string> = {
    task_number: card.id.slice(0, 8),
    task_title: card.title,
    task_body: card.description,
    column_name: column,
  }
  const source = template.trim() ? template : 'Task #{task_number}: {task_title}\nColumn: {column_name}\n\n{task_body}'
  let length = source.length
  for (const match of source.matchAll(/\{(task_number|task_title|task_body|column_name)\}/g))
    length += vars[match[1]!]!.length - match[0].length
  if (length > 200000) throw new Error('Rendered prompt is too long.')
  // Single pass: user content containing a template variable must not be expanded again.
  return source.replace(/\{(task_number|task_title|task_body|column_name)\}/g, (_match, key: string) => vars[key]!)
}
export function effectiveAutomation(
  config: ColumnAutomation,
  override: CardAutomationOverride | null
): ColumnAutomation {
  const effective = {
    ...config,
    ...override,
    model: override?.model ?? (override?.provider && override.provider !== config.provider ? '' : config.model),
    effort: override?.effort === undefined ? config.effort : override.effort,
  }
  // The desktop operator authorizes unattended work when enabling this executor.
  return effective.provider === 'maestrly' ? { ...effective, approvalRequired: false } : effective
}
export function modelSupports(config: ColumnAutomation, model: ExecutorModel) {
  return (
    config.provider === model.provider &&
    config.model === model.model &&
    (!config.effort || config.effort === 'off' || model.efforts.includes(config.effort)) &&
    (!config.fastMode || model.fastMode)
  )
}

export function maestroStrategyGuidance(strategy: z.infer<typeof maestroStrategySchema>): string {
  return strategy === 'best-quality'
    ? 'Prefer the strongest suitable agents and execution candidates. Non-trivial changes require independent review; important findings require a delegated fix followed by another review.'
    : strategy === 'fast'
      ? 'Favor fast suitable agents, aggressive safe decomposition, and parallel independent delegations. Keep critical review; do not trade away required validation.'
      : strategy === 'economy'
        ? 'Prefer economical suitable agents and candidates. Escalate only for specialty, failure, uncertainty, or an important finding, and make escalation visible.'
        : 'Balance quality, speed, and economy. Favor lighter agents for exploration/tests and specialty/quality for complex implementation; review adaptively.'
}

export interface AutomationColumnView {
  id: string
  name: string
  boardId: string
  projectId: string
  role: z.infer<typeof columnRoleSchema>
}
export interface ColumnAutomationView {
  column: AutomationColumnView
  projectName: string
  boardName: string
  boardVersion: number
  rolesConfigured: boolean
  policyId: string | null
  version: number
  config: ColumnAutomation
  limits: ReturnType<typeof resolveAutomationLimits>
}
