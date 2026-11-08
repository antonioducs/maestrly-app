/**
 * The assistant answers what waits for the person in their conversations and bots: a question with one of its
 * options, or a permission request. Approving always shows the person what it approves and waits for them; denying
 * and answering a question do not, within the turn's action budget. A remote computer's requests are answered there.
 */
import type { FleetInboxItem, FleetInteractionResolution } from '@maestrly/bot-fleet-protocol'
import { parseOverviewRef } from '../../shared/assistant-overview'
import type { ChatPermissionRequest, PendingChatQuestion, PermissionReply } from '../../shared/chat'
import type { BotFleet } from '../fleet/client/bot-actions'
import type { AssistantAction } from './action-budget'
import type { BotToolServer } from './bot-tools'

export type RespondPendingAnswer =
  | { kind: 'question'; option: string }
  | { kind: 'permission'; decision: 'allow' | 'deny' }

export interface RespondPendingInput {
  ref: string
  itemId: string
  answer: RespondPendingAnswer
}

export type RespondPendingResult =
  | { ok: true; status: 'answered' | 'approved' | 'denied'; target: string }
  | { ok: false; code: 'not-found' | 'unavailable' | 'invalid' | 'declined' | 'delivery-failed'; error: string }

export interface RespondPendingDeps {
  /** What a conversation of this computer waits for from the person; null when it does not exist. */
  localPending(conversationId: string): {
    name: string
    permissions: ChatPermissionRequest[]
    questions: PendingChatQuestion[]
  } | null
  replyPermission(requestId: string, reply: PermissionReply): void
  replyQuestion(toolCallId: string, answers: string[][]): void
  botServer(serverId: string): BotToolServer | null | Promise<BotToolServer | null>
  resolveBot(
    fleet: BotFleet,
    botId: string,
    interactionId: string,
    resolution: FleetInteractionResolution
  ): Promise<unknown>
  /** Spends the turn's action budget on the target, asking the person past it. */
  admit(targetRef: string, action: AssistantAction): Promise<boolean>
  /** Always asks the person, without "allow the rest": an approval is confirmed one by one. */
  confirmApproval(action: AssistantAction): Promise<boolean>
}

const fail = (code: Extract<RespondPendingResult, { ok: false }>['code'], error: string): RespondPendingResult => ({
  ok: false,
  code,
  error,
})
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const RESOLVED = 'That pending item is gone: it was already answered or ended. Call maestrly_overview again.'

function parseItem(itemId: string): { kind: 'permission' | 'question' | 'help'; id: string } | null {
  const match = /^(permission|question|help):(.+)$/.exec(itemId.trim())
  return match ? { kind: match[1] as 'permission' | 'question' | 'help', id: match[2] } : null
}

/** The option label the person's answer names among the question's options, ignoring case. */
function matchOption(options: ReadonlyArray<{ label: string }>, option: string): string | null {
  const wanted = option.trim().toLowerCase()
  return options.find((candidate) => candidate.label.trim().toLowerCase() === wanted)?.label ?? null
}

const wrongKind = (item: 'permission' | 'question'): RespondPendingResult =>
  fail(
    'invalid',
    `That item is a ${item === 'permission' ? 'permission request' : 'question'}: answer it with kind "${item}".`
  )

async function respondLocal(
  deps: RespondPendingDeps,
  conversationId: string,
  item: { kind: 'permission' | 'question' | 'help'; id: string },
  answer: RespondPendingAnswer
): Promise<RespondPendingResult> {
  const pending = deps.localPending(conversationId)
  if (!pending) return fail('not-found', 'No conversation has this ref; call maestrly_overview again.')
  if (item.kind === 'question') {
    const question = pending.questions.find((q) => q.toolCallId === item.id)
    if (!question) return fail('not-found', RESOLVED)
    if (answer.kind !== 'question') return wrongKind('question')
    const [only, ...rest] = question.questions
    if (!only || rest.length || only.isSecret)
      return fail('unavailable', 'This question needs the person in the app: tell them to open the conversation.')
    const label = matchOption(only.options, answer.option)
    if (!label)
      return fail(
        'invalid',
        `"${answer.option}" is not an option. The options are: ${only.options.map((o) => o.label).join(', ')}.`
      )
    if (!(await deps.admit(`local:${conversationId}`, { kind: 'answer', targetName: pending.name, preview: label })))
      return fail('declined', 'The person declined. Do not answer it or retry.')
    deps.replyQuestion(item.id, [[label]])
    return { ok: true, status: 'answered', target: pending.name }
  }
  if (item.kind === 'permission') {
    const request = pending.permissions.find((p) => p.id === item.id)
    if (!request) return fail('not-found', RESOLVED)
    if (answer.kind !== 'permission') return wrongKind('permission')
    if (answer.decision === 'deny') {
      deps.replyPermission(request.id, 'reject')
      return { ok: true, status: 'denied', target: pending.name }
    }
    const preview = request.preview ? `${request.title}\n\n${request.preview}` : request.title
    if (!(await deps.confirmApproval({ kind: 'respond', targetName: pending.name, preview })))
      return fail('declined', 'The person did not approve it. Do not approve it or retry.')
    deps.replyPermission(request.id, 'once')
    return { ok: true, status: 'approved', target: pending.name }
  }
  return fail('not-found', RESOLVED)
}

async function respondBot(
  deps: RespondPendingDeps,
  serverId: string,
  botId: string,
  item: { kind: 'permission' | 'question' | 'help'; id: string },
  answer: RespondPendingAnswer
): Promise<RespondPendingResult> {
  const server = await deps.botServer(serverId)
  if (!server) return fail('not-found', 'No paired bot server has this id; call maestrly_overview again.')
  if (!server.connected)
    return fail('unavailable', `The bot server "${server.name}" is not connected now; ask the person to check it.`)
  const snapshot = server.snapshot()
  const bot = snapshot.bots.find((b) => b.id === botId)
  if (!bot) return fail('not-found', `No bot of "${server.name}" has this id; call maestrly_overview again.`)
  const pending: FleetInboxItem | undefined = snapshot.inbox.find(
    (entry) => entry.botId === botId && entry.interaction.id === item.id && entry.interaction.kind === item.kind
  )
  if (!pending) return fail('not-found', RESOLVED)
  const { interaction } = pending
  const ref = `bot:${serverId}:${botId}`
  let resolution: FleetInteractionResolution
  let status: 'answered' | 'approved' | 'denied'
  if (interaction.kind === 'help')
    return fail('unavailable', `${bot.name} asked for the person's hand: tell them to open the bot in the app.`)
  if (interaction.kind === 'question') {
    if (answer.kind !== 'question') return wrongKind('question')
    const [only, ...rest] = interaction.questions
    if (!only || rest.length)
      return fail('unavailable', 'This question needs the person in the app: tell them to open the bot.')
    const label = matchOption(only.options, answer.option)
    if (!label)
      return fail(
        'invalid',
        `"${answer.option}" is not an option. The options are: ${only.options.map((o) => o.label).join(', ')}.`
      )
    if (!(await deps.admit(ref, { kind: 'answer', targetName: bot.name, preview: label })))
      return fail('declined', 'The person declined. Do not answer it or retry.')
    resolution = { kind: 'question', answers: [[label]] }
    status = 'answered'
  } else {
    if (answer.kind !== 'permission') return wrongKind('permission')
    if (answer.decision === 'deny') {
      resolution = { kind: 'permission', reply: 'reject' }
      status = 'denied'
    } else {
      const preview = interaction.detail ? `${interaction.title}\n\n${interaction.detail}` : interaction.title
      if (!(await deps.confirmApproval({ kind: 'respond', targetName: bot.name, preview })))
        return fail('declined', 'The person did not approve it. Do not approve it or retry.')
      resolution = { kind: 'permission', reply: 'once' }
      status = 'approved'
    }
  }
  try {
    await deps.resolveBot(server.fleet, botId, interaction.id, resolution)
    return { ok: true, status, target: bot.name }
  } catch (error) {
    return fail('delivery-failed', `"${bot.name}" did not take the answer: ${errorText(error)}`)
  }
}

export async function respondPending(
  deps: RespondPendingDeps,
  input: RespondPendingInput
): Promise<RespondPendingResult> {
  const ref = parseOverviewRef(input.ref)
  if (!ref) return fail('not-found', 'Not a ref from maestrly_overview.')
  if (ref.kind === 'host')
    return fail(
      'unavailable',
      "A remote computer's pending items are answered there: tell the person to open the conversation in the app."
    )
  const item = parseItem(input.itemId)
  if (!item) return fail('not-found', 'Not an itemId from maestrly_overview.')
  if (ref.kind === 'local') return respondLocal(deps, ref.conversationId, item, input.answer)
  return respondBot(deps, ref.serverId, ref.botId, item, input.answer)
}
