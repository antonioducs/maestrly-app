/**
 * Host tool for Maestro orchestrator conversations to declare and update tasks in the swarm board.
 * Host-owned phases (implementing, delivered, merged, failed) are managed automatically by the host.
 */
import { z } from 'zod'
import { CONVERSATION_DISPATCH_MAX_REQUEST_KEY } from '../../../shared/conversation-dispatch'
import {
  renderMaestroSwarmState,
  type MaestroSwarmTask,
  type MaestroSwarmTaskUpdate,
} from '../../../shared/maestro-swarm'
import { getConversation } from '../../store'
import { declareSwarmTasks } from '../maestro-swarm'
import { defineTool } from './util'

const taskKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(CONVERSATION_DISPATCH_MAX_REQUEST_KEY)
  .regex(/^[\w.:/#@-]+$/, 'Use letters, digits and . : / # @ - _ only.')

const identifierSchema = z.string().trim().min(1).max(300)

const swarmTaskUpdateSchema = z
  .object({
    key: taskKeySchema.describe('Stable task key (matches requestKey used in start_conversations).'),
    title: z.string().trim().min(1).max(200).optional().describe('Short task title (required when creating a task).'),
    agent: identifierSchema.optional().describe('Enabled Agent Pool resource id assigned to this task.'),
    dependsOn: z.array(taskKeySchema).optional().describe('Keys of tasks this task depends on.'),
    phase: z
      .enum(['queued', 'reviewing', 'changes', 'blocked'])
      .optional()
      .describe(
        'Orchestrator-owned phase: queued, reviewing, changes (requires reason), or blocked. ' +
          'Host-owned phases (implementing, delivered, merged, failed) are managed by the host.'
      ),
    reason: z
      .enum(['review', 'conflict'])
      .optional()
      .describe('Required when phase is "changes": "review" for review feedback, "conflict" for merge conflict.'),
    note: z.string().max(500).optional().describe('Short status note (empty string clears it).'),
  })
  .strict()

const parameters = z
  .object({
    tasks: z.array(swarmTaskUpdateSchema).min(1).describe('One or more swarm task declarations or updates.'),
  })
  .strict()

export type SwarmUpdateResult = { ok: true; tasks: MaestroSwarmTask[] } | { ok: false; error: string }

export const swarmUpdateTool = defineTool<typeof parameters, SwarmUpdateResult>({
  name: 'swarm_update',
  description:
    'Declare or update tasks in this Maestro swarm board. Set orchestrator-owned phases: queued, reviewing, changes ' +
    '(requires reason: "review" or "conflict"), or blocked, plus title, agent, dependsOn, and note. Host-owned phases ' +
    '(implementing, delivered, merged, failed) are updated automatically by the host and cannot be set with this tool.',
  parameters,
  execute: async (args, ctx) => {
    const conversation = getConversation(ctx.conversationId)
    if (conversation?.experience !== 'maestro') {
      return { ok: false, error: 'swarm_update is only available in Maestro conversations' }
    }
    return declareSwarmTasks(ctx.conversationId, args.tasks as MaestroSwarmTaskUpdate[])
  },
  toModelText: (_args, result) => {
    if (!result.ok) return result.error
    return renderMaestroSwarmState(result.tasks)
  },
})
