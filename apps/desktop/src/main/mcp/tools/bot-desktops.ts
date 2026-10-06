import {
  FLEET_DESKTOP_BRIDGE_LIMITS,
  fleetDesktopIdSchema,
  type FleetDesktopCallResult,
  type FleetDesktopLink,
  type FleetDesktopOp,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { gatewayRequest, keyForToolCall, type GatewayConfig } from '../../fleet/instance/gateway-client'
import type { McpToolContext } from './context'
import { err, ok } from './context'

/**
 * The tools a fleet bot uses to work in the workspaces of the computers that gave it access.
 *
 * Every call names one computer and goes to that computer alone, through the gateway; the computer runs it under the grants, approval
 * ceiling and idempotency it keeps for this bot. Nothing here approves a
 * permission or a plan, picks another computer when one is offline, or moves a conversation between computers: a conversation,
 * its worktree and its ids exist only on the computer that created them.
 */
export const BOT_DESKTOP_TOOL_NAMES = [
  'desktop_list_desktops',
  'desktop_list_workspaces',
  'desktop_list_selections',
  'desktop_list_chats',
  'desktop_read_chat',
  'desktop_read_chat_history',
  'desktop_wait_events',
  'desktop_create_chat',
  'desktop_send_message',
  'desktop_configure_chat',
  'desktop_cancel_turn',
  'desktop_answer_question',
] as const

const DESKTOPS_HINT =
  'Ids a computer hands out (workspaceId, selectionId, conversationId, questionId) only work with that same desktopId.'
const NONE_LINKED =
  'No computer gives you access yet. Your owner turns it on in Maestrly on each computer they want you to use: your settings, ' +
  '"Workspaces on this computer".'
const desktopId = fleetDesktopIdSchema.describe('Computer id from desktop_list_desktops. ' + DESKTOPS_HINT)
const optionalDesktopId = fleetDesktopIdSchema
  .optional()
  .describe('One computer from desktop_list_desktops; omit to ask every computer that is online.')
const key = z.string().min(1).max(191)
const conversationId = z
  .uuid()
  .describe('Conversation id from desktop_create_chat or desktop_list_chats, on this computer.')
const idempotencyKey = key
  .optional()
  .describe(
    'Omit on a first try. To retry a call that timed out or failed on the way, pass the idempotencyKey it reported: ' +
      'the computer runs the change only once.'
  )
const selection = z
  .object({
    selectionId: key.describe('From desktop_list_selections or desktop_list_workspaces of the same computer.'),
    reasoning: key.nullable().optional(),
    fastMode: z.boolean().optional(),
    mode: z.enum(['agent', 'ask', 'plan']).optional(),
    permissionMode: z
      .enum(['ask', 'auto', 'full'])
      .optional()
      .describe('At most the ceiling the owner set on that computer; omit to use that ceiling.'),
  })
  .strict()
const answers = z
  .array(z.array(z.string().max(8000)).max(20))
  .min(1)
  .max(10)
  .describe('One array of answers per question asked, in the order they were asked.')

type Gateway = () => GatewayConfig
/** The gateway answers a call within its own timeout; the request gets a little more before it gives up. */
const callSignal = () => AbortSignal.timeout(FLEET_DESKTOP_BRIDGE_LIMITS.callTimeoutMs + 5_000)

async function listDesktops(gateway: Gateway): Promise<FleetDesktopLink[]> {
  return (await gatewayRequest(gateway(), 'desktops')).desktops
}
async function call(
  gateway: Gateway,
  desktopId: string,
  op: FleetDesktopOp,
  input: Record<string, unknown>
): Promise<FleetDesktopCallResult> {
  return gatewayRequest(gateway(), 'desktopCall', { desktopId, op, input }, {}, callSignal())
}
const failureText = (result: Extract<FleetDesktopCallResult, { ok: false }>) =>
  result.error.code + ': ' + result.error.message
/** A computer's answer as fields of the output; the computer it came from is named by the output itself. */
function fieldsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { result: value }
  const { desktop: _desktop, ...fields } = value as Record<string, unknown>
  return fields
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Registers the desktop tools of a bot conversation. `gateway` resolves the bot's own gateway access at each call, so
 * a bot whose token arrives later, or changes, keeps working.
 */
export function registerBotDesktopTools(ctx: McpToolContext, gateway: Gateway): void {
  const names = new Map<string, string>()
  const remember = (desktops: FleetDesktopLink[]) => {
    for (const desktop of desktops) names.set(desktop.desktopId, desktop.name)
    return desktops
  }
  const nameOf = async (id: string) => {
    if (!names.has(id)) remember(await listDesktops(gateway).catch(() => []))
    return names.get(id) ?? null
  }
  /** One call for one computer; the output names the computer, so the bot keeps the whole reference. */
  const one = async (id: string, op: FleetDesktopOp, input: Record<string, unknown>, write = false) => {
    // A change that may or may not have happened is retried with the same key; the computer runs it once.
    const retry = write && typeof input.idempotencyKey === 'string' ? ` (idempotencyKey: ${input.idempotencyKey})` : ''
    try {
      const result = await call(gateway, id, op, input)
      if (!result.ok) return err(failureText(result) + retry)
      return ok(JSON.stringify({ desktopId: id, desktopName: await nameOf(id), ...fieldsOf(result.value) }))
    } catch (error) {
      return err(messageOf(error) + retry)
    }
  }
  /** The same call on every computer that is online, in parallel: one slow or failing computer never hides the others. */
  const every = async (op: FleetDesktopOp) => {
    try {
      const desktops = remember(await listDesktops(gateway))
      if (!desktops.length) return ok(JSON.stringify({ desktops: [], note: NONE_LINKED }))
      const results = await Promise.all(
        desktops.map(async (desktop) => {
          const base = { desktopId: desktop.desktopId, name: desktop.name, online: desktop.online }
          if (!desktop.online) return { ...base, error: 'desktop_offline' }
          try {
            const result = await call(gateway, desktop.desktopId, op, {})
            return result.ok ? { ...base, ...fieldsOf(result.value) } : { ...base, error: failureText(result) }
          } catch (error) {
            return { ...base, error: messageOf(error) }
          }
        })
      )
      return ok(JSON.stringify({ desktops: results }))
    } catch (error) {
      return err(messageOf(error))
    }
  }
  const write = (input: Record<string, unknown>, extra: unknown) => ({
    ...input,
    idempotencyKey: typeof input.idempotencyKey === 'string' ? input.idempotencyKey : keyForToolCall(extra),
  })
  const without = <T extends Record<string, unknown>>(input: T) => {
    const { desktopId: _desktopId, ...rest } = input
    return rest
  }

  ctx.server.registerTool(
    'desktop_list_desktops',
    {
      description:
        "The owner's computers that gave you access to their workspaces, with each one's desktopId, name, whether it is " +
        'online now and when it was last seen. Each computer decides on its own what you may use there. ' +
        DESKTOPS_HINT,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const desktops = remember(await listDesktops(gateway))
        return ok(JSON.stringify(desktops.length ? { desktops } : { desktops, note: NONE_LINKED }))
      } catch (error) {
        return err(messageOf(error))
      }
    }
  )
  ctx.server.registerTool(
    'desktop_list_workspaces',
    {
      description:
        'The workspaces (repositories) a computer authorized for you, the actions allowed on each, their branches and the ' +
        'account/model selections that computer offers. Without desktopId, every computer that is online answers, grouped by ' +
        'computer; offline ones are marked. Never invent a workspaceId or selectionId.',
      inputSchema: { desktopId: optionalDesktopId },
      annotations: { readOnlyHint: true },
    },
    async ({ desktopId }) => (desktopId ? one(desktopId, 'listWorkspaces', {}) : every('listWorkspaces'))
  )
  ctx.server.registerTool(
    'desktop_list_selections',
    {
      description:
        'The account and model selections one computer offers, with their efforts and modes. Accounts and models belong ' +
        'to each computer.',
      inputSchema: { desktopId },
      annotations: { readOnlyHint: true },
    },
    async ({ desktopId }) => one(desktopId, 'listSelections', {})
  )
  ctx.server.registerTool(
    'desktop_list_chats',
    {
      description:
        'The development conversations you created on a computer, and whether each is active or paused by your owner. ' +
        "Your owner's own conversations are never listed. Without desktopId, every computer that is online answers.",
      inputSchema: { desktopId: optionalDesktopId },
      annotations: { readOnlyHint: true },
    },
    async ({ desktopId }) => (desktopId ? one(desktopId, 'listChats', {}) : every('listChats'))
  )
  ctx.server.registerTool(
    'desktop_read_chat',
    {
      description:
        'Open questions, the command still running, the event cursor to wait from, and the first 500 messages your ' +
        'own commands produced in a conversation. It does not carry what your owner wrote in it; ' +
        'desktop_read_chat_history does.',
      inputSchema: { desktopId, conversationId },
      annotations: { readOnlyHint: true },
    },
    async (input) => one(input.desktopId, 'readChat', without(input))
  )
  ctx.server.registerTool(
    'desktop_read_chat_history',
    {
      description:
        'A conversation as your owner sees it, oldest first: what you sent, what they wrote themselves, and the ' +
        'answers to both. Read it when your owner says they wrote there. Pass back the cursor it returns.',
      inputSchema: {
        desktopId,
        conversationId,
        cursor: z.string().max(4096).optional().describe('Cursor from the previous page; omit for the oldest.'),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => one(input.desktopId, 'readChatHistory', without(input))
  )
  ctx.server.registerTool(
    'desktop_wait_events',
    {
      description:
        'Wait until a conversation produces events after the cursor, for at most 20 seconds, then answer. Call it ' +
        'again with the cursor it returns instead of polling. Cursors belong to each computer and conversation.',
      inputSchema: {
        desktopId,
        conversationId,
        cursor: z.number().int().nonnegative().describe('Last sequence you already saw; 0 at first.'),
        timeoutSeconds: z.number().int().min(0).max(20).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => one(input.desktopId, 'waitEvents', without(input))
  )
  ctx.server.registerTool(
    'desktop_create_chat',
    {
      description:
        'Start a development conversation in one authorized workspace of one computer, in a fresh worktree created from ' +
        'baseBranch, then follow it with desktop_wait_events. If your owner did not say which computer and the project is ' +
        'on more than one, ask them first. Permission prompts and plan approvals stay with your owner on that computer.',
      inputSchema: {
        desktopId,
        workspaceId: key.describe('From desktop_list_workspaces of the same computer.'),
        name: z.string().trim().min(1).max(160).describe('Short title for the conversation.'),
        baseBranch: z.string().trim().min(1).max(240).describe('A branch listed for that workspace.'),
        selection,
        message: z.string().trim().min(1).max(200_000).optional().describe('First instruction to send.'),
        idempotencyKey,
      },
      annotations: { readOnlyHint: false },
    },
    async (input, extra) => one(input.desktopId, 'createChat', write(without(input), extra), true)
  )
  ctx.server.registerTool(
    'desktop_send_message',
    {
      description:
        'Queue the next instruction for a conversation you created on that computer. Instructions of one conversation ' +
        'run in order.',
      inputSchema: {
        desktopId,
        conversationId,
        text: z.string().trim().min(1).max(200_000),
        idempotencyKey,
      },
      annotations: { readOnlyHint: false },
    },
    async (input, extra) => one(input.desktopId, 'sendMessage', write(without(input), extra), true)
  )
  ctx.server.registerTool(
    'desktop_configure_chat',
    {
      description:
        'Change the selection, effort, mode or title of a conversation you created. Applies to its next turn.',
      inputSchema: {
        desktopId,
        conversationId,
        selection: selection.partial().optional(),
        name: z.string().trim().min(1).max(160).optional(),
        idempotencyKey,
      },
      annotations: { readOnlyHint: false },
    },
    async (input, extra) => one(input.desktopId, 'configureChat', write(without(input), extra), true)
  )
  ctx.server.registerTool(
    'desktop_cancel_turn',
    {
      description: 'Stop what a conversation you created is doing now. Work already produced is kept.',
      inputSchema: { desktopId, conversationId, idempotencyKey },
      annotations: { readOnlyHint: false },
    },
    async (input, extra) => one(input.desktopId, 'cancelTurn', write(without(input), extra), true)
  )
  ctx.server.registerTool(
    'desktop_answer_question',
    {
      description:
        'Answer an ordinary question a conversation asked, listed by desktop_read_chat. Permission prompts and plan ' +
        'approvals are not questions and are never answered here.',
      inputSchema: {
        desktopId,
        conversationId,
        questionId: z.uuid().describe('Question id from desktop_read_chat.'),
        answers,
        idempotencyKey,
      },
      annotations: { readOnlyHint: false },
    },
    async (input, extra) => one(input.desktopId, 'answerQuestion', write(without(input), extra), true)
  )
}
