/**
 * The assistant reads and messages conversations of the person's remote computers through the host's own handlers,
 * as this computer's main window does. What it reads there is data; what it sends is marked as coming from the
 * assistant, so the remote transcript keeps a trace.
 */
import { hostRef } from '../../shared/assistant-overview'
import type { ChatHistoryPage } from '../../shared/chat'
import type { Conversation } from '../../shared/conversation'
import {
  CONVERSATION_READ_DEFAULT_MESSAGES,
  type ConversationLinkError,
  type ConversationReadResult,
  type ConversationSendResult,
  type ConversationSummary,
} from '../../shared/conversation-link'
import type { HostId } from '../../shared/host-key'
import { transcriptFromMessages } from '../conversation-link-service'
import type { HostInvoker } from '../remote-host/host-invoker'

/** Messages of a remote conversation read per page; `beforeSeq` moves a whole page back. */
export const REMOTE_READ_PAGE = 60
const REMOTE_TIMEOUT_MS = 10_000

export interface RemoteConversationDeps {
  invoke: HostInvoker['invoke']
  /** The remote hosts this computer knows. */
  hosts(): Array<{ id: HostId; label: string; state: string }>
  /** The line that starts each message the assistant sends, e.g. "— via Maestrly Assistant". */
  viaLine(): string
}

const fail = (code: ConversationLinkError['code'], error: string): ConversationLinkError => ({ ok: false, code, error })
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function host(deps: RemoteConversationDeps, hostId: HostId): { name: string } | ConversationLinkError {
  const known = deps.hosts().find((h) => h.id === hostId)
  if (!known) return fail('not-found', 'No remote computer has this id; call maestrly_overview again.')
  const name = known.label || hostId
  if (known.state !== 'online')
    return fail('unavailable', `The remote computer "${name}" is not connected now; try again when it is back.`)
  return { name }
}

async function find(
  deps: RemoteConversationDeps,
  hostId: HostId,
  conversationId: string
): Promise<{ conversation: Conversation; workspaceName: string | null } | null> {
  const opts = { timeoutMs: REMOTE_TIMEOUT_MS }
  const [workspaces, standalone] = await Promise.all([
    deps.invoke<Array<{ name: string; conversations: Conversation[] }> | null>(hostId, 'workspace:list', [false], opts),
    deps.invoke<Conversation[] | null>(hostId, 'conversation:list-standalone', [false], opts),
  ])
  for (const workspace of workspaces ?? []) {
    const conversation = workspace.conversations.find((c) => c.id === conversationId)
    if (conversation) return { conversation, workspaceName: workspace.name }
  }
  const conversation = (standalone ?? []).find((c) => c.id === conversationId)
  return conversation ? { conversation, workspaceName: null } : null
}

function summarize(
  hostId: HostId,
  hostName: string,
  conversation: Conversation,
  workspaceName: string | null
): ConversationSummary {
  return {
    conversationId: hostRef(hostId, conversation.id),
    name: conversation.name,
    scope: conversation.scope,
    workspaceId: conversation.workspaceId,
    workspaceName: workspaceName ? `${workspaceName} · ${hostName}` : hostName,
    branch: conversation.scope === 'project' ? conversation.branch : null,
    status: conversation.status,
    running: conversation.status === 'working',
    archived: !!conversation.archived,
    relation: null,
    lastActivityAt: conversation.lastActivityAt ?? null,
  }
}

export async function readRemoteConversation(
  deps: RemoteConversationDeps,
  hostId: HostId,
  conversationId: string,
  input: { messages?: number; beforeSeq?: number }
): Promise<ConversationReadResult | ConversationLinkError> {
  const reached = host(deps, hostId)
  if ('ok' in reached) return reached
  try {
    const found = await find(deps, hostId, conversationId)
    if (!found) return fail('not-found', `No conversation of "${reached.name}" has this id; call maestrly_overview.`)
    const page = await deps.invoke<ChatHistoryPage | null>(
      hostId,
      'chat:history:page',
      [
        conversationId,
        { limit: REMOTE_READ_PAGE, ...(input.beforeSeq !== undefined ? { beforeSeq: input.beforeSeq } : {}) },
      ],
      { timeoutMs: REMOTE_TIMEOUT_MS }
    )
    const messages = page?.messages ?? []
    const scan = transcriptFromMessages(
      messages.map((message) => ({ message })),
      {
        messages: input.messages ?? CONVERSATION_READ_DEFAULT_MESSAGES,
        wantsReply: input.beforeSeq === undefined,
        olderExist: page?.hasMore === true,
      }
    )
    return {
      conversation: summarize(hostId, reached.name, found.conversation, found.workspaceName),
      lastReply: scan.lastReply,
      messages: scan.entries,
      hasMore: scan.hasMore || page?.hasMore === true,
      earliestSeq: page?.hasMore ? (page.earliestSeq ?? null) : null,
    }
  } catch (error) {
    return fail('unavailable', `The remote computer "${reached.name}" did not answer: ${errorText(error)}`)
  }
}

export async function sendRemoteConversation(
  deps: RemoteConversationDeps,
  hostId: HostId,
  conversationId: string,
  input: { message: string; reportBack?: boolean },
  admit: (target: ConversationSummary, preview: string) => Promise<boolean>
): Promise<ConversationSendResult> {
  if (input.reportBack)
    return fail(
      'unavailable',
      "reportBack does not reach a remote computer's conversation. Send without it and read the conversation " +
        'later with read_conversation.'
    )
  const reached = host(deps, hostId)
  if ('ok' in reached) return reached
  try {
    const found = await find(deps, hostId, conversationId)
    if (!found) return fail('not-found', `No conversation of "${reached.name}" has this id; call maestrly_overview.`)
    if (found.conversation.archived)
      return fail('archived', `"${found.conversation.name}" is archived; ask the person to restore it first.`)
    const target = summarize(hostId, reached.name, found.conversation, found.workspaceName)
    if (!(await admit(target, input.message.slice(0, 400)).catch(() => false)))
      return fail('declined', 'The person declined sending this message. Do not send it or retry.')
    const result = await deps.invoke<{ ok?: boolean; error?: string } | null>(
      hostId,
      'chat:send',
      [{ conversationId, text: `${deps.viaLine()}\n\n${input.message}`, attachments: [] }],
      { timeoutMs: REMOTE_TIMEOUT_MS }
    )
    if (!result?.ok) return fail('delivery-failed', result?.error ?? 'The remote computer did not take the message.')
    return { ok: true, status: 'delivered', conversationId: target.conversationId, conversationName: target.name }
  } catch (error) {
    return fail('unavailable', `The remote computer "${reached.name}" did not answer: ${errorText(error)}`)
  }
}
