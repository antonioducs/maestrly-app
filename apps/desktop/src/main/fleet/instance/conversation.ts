import { z } from 'zod'
import type { FleetConversationOp } from '@maestrly/bot-fleet-protocol'
import type { ChatConfig } from '../../../shared/chat'

const noArgs = z.tuple([])
const enabled = z.tuple([z.boolean()])
const patch = z
  .object({
    app: z.boolean().optional(),
    mcpDisabled: z.array(z.string().min(1).max(256)).max(100).optional(),
    imageGen: z.boolean().optional(),
  })
  .strict()
const selection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('group'), groupId: z.string().min(1).max(128) }).strict(),
])
const schemas: Record<FleetConversationOp, z.ZodType<unknown[]>> = {
  chatConfig: noArgs,
  chatGetConvTools: noArgs,
  chatSetConvTools: z.tuple([patch]),
  chatSubagentProfilesGetConversation: noArgs,
  chatSubagentProfilesSetConversationEnabled: enabled,
  chatSubagentsSetConversationEnabled: enabled,
  chatSkillsState: noArgs,
  chatSkillSetOverride: z.tuple([z.string().min(1).max(128), z.enum(['on', 'off', 'inherit'])]),
  chatSkillResetOverrides: noArgs,
  chatSkillSetSelection: z.tuple([selection]),
  chatCommands: noArgs,
}
export function validateFleetConversationArgs(op: FleetConversationOp, args: unknown[]): unknown[] {
  return schemas[op].parse(args)
}

export function projectFleetChatConfig(
  config: Pick<ChatConfig, 'mcpServers' | 'appToolsEnabled' | 'imageGenEnabled'>
): Pick<ChatConfig, 'mcpServers' | 'appToolsEnabled' | 'imageGenEnabled'> {
  return {
    mcpServers: config.mcpServers.map(({ id, name, transport, enabled }) => ({ id, name, transport, enabled })),
    appToolsEnabled: config.appToolsEnabled,
    imageGenEnabled: config.imageGenEnabled,
  }
}
