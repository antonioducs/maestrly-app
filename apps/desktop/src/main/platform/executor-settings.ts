import { z } from 'zod'
import { getAppSetting, setAppSetting } from '../store'
export const desktopExecutorSettingsSchema = z
  .object({
    mode: z.enum(['personal', 'team']).default('personal'),
    background: z.boolean().default(false),
    autoStart: z.boolean().default(false),
    connectionId: z.string().optional(),
    providerIds: z.array(z.string().min(1)).default([]),
    allowCommands: z.boolean().default(true),
    allowWeb: z.boolean().default(true),
    allowAppTools: z.boolean().default(true),
    allowMcp: z.boolean().default(false),
    allowPush: z.boolean().default(false),
    skills: z.boolean().default(true),
    interactiveChat: z.boolean().default(false),
  })
  .strict()
export type DesktopExecutorSettings = z.infer<typeof desktopExecutorSettingsSchema>
export function executorSettings(): DesktopExecutorSettings {
  try {
    return desktopExecutorSettingsSchema.parse(JSON.parse(getAppSetting('platform.desktop-executor.v1') ?? '{}'))
  } catch {
    return desktopExecutorSettingsSchema.parse({})
  }
}
export function saveExecutorSettings(input: unknown): DesktopExecutorSettings {
  const value = desktopExecutorSettingsSchema.parse(input)
  setAppSetting('platform.desktop-executor.v1', JSON.stringify(value))
  return value
}
export interface DesktopExecutionRecord {
  runId: string
  cardId: string
  title: string
  conversationId: string
  workspacePath: string
  state: string
  startedAt: number
  summary?: string
}
export function desktopExecutions(): DesktopExecutionRecord[] {
  try {
    return JSON.parse(getAppSetting('platform.execution-history.v1') ?? '[]')
  } catch {
    return []
  }
}
export function recordDesktopExecution(record: DesktopExecutionRecord) {
  setAppSetting(
    'platform.execution-history.v1',
    JSON.stringify([record, ...desktopExecutions().filter((r) => r.runId !== record.runId)].slice(0, 200))
  )
}

export function recoverDesktopExecutions(): void {
  for (const record of desktopExecutions())
    if (record.state === 'running')
      recordDesktopExecution({
        ...record,
        state: 'failed',
        summary: 'Maestrly stopped before this execution finished. Check the card for its server status.',
      })
}
