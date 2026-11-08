/**
 * The assistant reads the person's bots and sends them messages, through the same calls the window makes. A bot's
 * transcript is data, never instructions; what the assistant sends is marked as coming from it.
 */
import type { FleetBot, FleetInboxItem, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { compactOverviewBot, parseOverviewRef, relativeAge } from '../../shared/assistant-overview'
import {
  CONVERSATION_READ_DEFAULT_MESSAGES,
  CONVERSATION_READ_MAX_TEXT,
  type ConversationLinkError,
  type ConversationSendResult,
  type ConversationTranscriptEntry,
} from '../../shared/conversation-link'
import {
  type BotFleet,
  listBotRuns,
  readBotRunTranscript,
  readBotTranscript,
  sendBotMessage,
} from '../fleet/client/bot-actions'
import { toOverviewBot } from './overview-service'

const TRANSCRIPT_PAGE = 50
const RECENT_RUNS = 5

export interface BotToolServer {
  fleet: BotFleet
  name: string
  connected: boolean
  snapshot(): { bots: FleetBot[]; inbox: FleetInboxItem[] }
}

export interface BotToolDeps {
  server(serverId: string): BotToolServer | null | Promise<BotToolServer | null>
  viaLine(): string
  now(): number
}

export interface BotReadResult {
  bot: Record<string, unknown>
  messages: ConversationTranscriptEntry[]
  hasMore: boolean
  runs?: Array<{ runId: string; routineName: string | null; status: string; started: string }>
}

const fail = (code: ConversationLinkError['code'], error: string): ConversationLinkError => ({ ok: false, code, error })
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const cut = (text: string) =>
  text.length > CONVERSATION_READ_MAX_TEXT
    ? { text: text.slice(0, CONVERSATION_READ_MAX_TEXT), truncated: true as const }
    : { text }

async function resolve(
  deps: BotToolDeps,
  ref: string
): Promise<
  { server: BotToolServer; serverId: string; bot: FleetBot; inbox: FleetInboxItem[] } | ConversationLinkError
> {
  const parsed = parseOverviewRef(ref)
  if (parsed?.kind !== 'bot')
    return fail('not-found', 'That is not a bot ref; use the ref maestrly_overview gives a bot.')
  const server = await deps.server(parsed.serverId)
  if (!server) return fail('not-found', 'No paired bot server has this id; call maestrly_overview again.')
  if (!server.connected)
    return fail(
      'unavailable',
      `The bot server "${server.name}" is not connected now; ask the person to check it in Settings → Bot servers.`
    )
  const snapshot = server.snapshot()
  const bot = snapshot.bots.find((b) => b.id === parsed.botId && b.lifecycle !== 'archived')
  if (!bot) return fail('not-found', `No bot of "${server.name}" has this id; call maestrly_overview again.`)
  return { server, serverId: parsed.serverId, bot, inbox: snapshot.inbox }
}

/** The text of a bot's transcript, oldest first: the owner's and others' messages, its answers and what it told bots. */
export function botTranscriptEntries(items: readonly FleetTranscriptItem[]): ConversationTranscriptEntry[] {
  const entries: ConversationTranscriptEntry[] = []
  for (const item of items) {
    if (item.kind === 'user' && item.text.trim()) {
      const from =
        item.source === 'peer' && item.peer
          ? item.peer.name
          : item.source === 'routine' && item.routine
            ? `routine "${item.routine.title}"`
            : null
      entries.push({ role: 'user', ...(from ? { from } : {}), ...cut(item.text.trim()) })
    } else if (item.kind === 'assistant' && item.text.trim()) {
      entries.push({ role: 'assistant', ...cut(item.text.trim()) })
    } else if (item.kind === 'peer_out' && item.text.trim()) {
      entries.push({ role: 'assistant', ...cut(`To ${item.to.name}: ${item.text.trim()}`) })
    }
  }
  return entries
}

export async function readBot(
  deps: BotToolDeps,
  input: { ref: string; runId?: string; messages?: number }
): Promise<BotReadResult | ConversationLinkError> {
  const target = await resolve(deps, input.ref)
  if ('ok' in target) return target
  const { server, serverId, bot, inbox } = target
  try {
    const page = input.runId
      ? await readBotRunTranscript(server.fleet, bot.id, input.runId, { limit: TRANSCRIPT_PAGE })
      : await readBotTranscript(server.fleet, bot.id, { limit: TRANSCRIPT_PAGE })
    const all = botTranscriptEntries(page.items)
    const wanted = input.messages ?? CONVERSATION_READ_DEFAULT_MESSAGES
    const result: BotReadResult = {
      bot: compactOverviewBot(toOverviewBot(serverId, server.name, bot, inbox)),
      messages: all.slice(-wanted),
      hasMore: all.length > wanted || page.before !== null,
    }
    if (!input.runId) {
      const runs = await Promise.resolve()
        .then(() => listBotRuns(server.fleet, bot.id))
        .catch(() => null)
      if (runs)
        result.runs = runs.runs.slice(0, RECENT_RUNS).map((run) => ({
          runId: run.id,
          routineName: run.routineTitle,
          status: run.status,
          started: relativeAge(Date.parse(run.deliveredAt), deps.now()),
        }))
    }
    return result
  } catch (error) {
    return fail('unavailable', `The bot server "${server.name}" did not answer: ${errorText(error)}`)
  }
}

export async function sendBot(
  deps: BotToolDeps,
  input: { ref: string; message: string },
  admit: (target: { ref: string; name: string }, preview: string) => Promise<boolean>
): Promise<ConversationSendResult> {
  const target = await resolve(deps, input.ref)
  if ('ok' in target) return target
  const { server, bot } = target
  const ref = input.ref.trim()
  if (!(await admit({ ref, name: bot.name }, input.message.slice(0, 400)).catch(() => false)))
    return fail('declined', 'The person declined sending this message. Do not send it or retry.')
  try {
    const receipt = await sendBotMessage(server.fleet, bot.id, `${deps.viaLine()}\n\n${input.message}`)
    return {
      ok: true,
      status: receipt.queued ? 'queued' : 'delivered',
      conversationId: ref,
      conversationName: bot.name,
      messageId: receipt.inputId,
    }
  } catch (error) {
    return fail('delivery-failed', `"${bot.name}" did not take the message: ${errorText(error)}`)
  }
}
