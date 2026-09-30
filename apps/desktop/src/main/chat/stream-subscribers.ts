import type { WebContents } from 'electron'
import { recordIpcSend } from '../performance/metrics'
import { isRemoteUiTarget } from '../remote-ui-targets'
import { emitChatHost } from './host-events'

/**
 * Live chat stream subscriptions. The runtime stays in MAIN without requiring a mounted ChatView;
 * only currently subscribed (WebContents, conversationId) pairs receive IPC. Counts are per pair,
 * since one renderer may have multiple consumers of a conversation (including stream and permissions).
 */
const chatSubscribersByConversation = new Map<string, Map<WebContents, number>>()
const chatSubscriptionsByWebContents = new Map<WebContents, Map<string, number>>()
const chatSubscriptionCleanup = new Map<WebContents, () => void>()

function clearChatSubscriptions(wc: WebContents): void {
  const subscriptions = chatSubscriptionsByWebContents.get(wc)
  if (!subscriptions) return

  for (const conversationId of subscriptions.keys()) {
    const subscribers = chatSubscribersByConversation.get(conversationId)
    subscribers?.delete(wc)
    if (subscribers?.size === 0) chatSubscribersByConversation.delete(conversationId)
  }
  chatSubscriptionsByWebContents.delete(wc)
  chatSubscriptionCleanup.get(wc)?.()
  chatSubscriptionCleanup.delete(wc)
}

export function clearAllChatSubscriptions(): void {
  for (const wc of [...chatSubscriptionsByWebContents.keys()]) clearChatSubscriptions(wc)
}

/** Registers a stream consumer; each call requires a matching unsubscribe. */
export function subscribeChatStream(wc: WebContents, conversationId: string): void {
  if (!conversationId || wc.isDestroyed()) return

  let subscriptions = chatSubscriptionsByWebContents.get(wc)
  if (!subscriptions) {
    subscriptions = new Map()
    chatSubscriptionsByWebContents.set(wc, subscriptions)
    if (typeof wc.once === 'function') {
      const onDestroyed = () => clearChatSubscriptions(wc)
      wc.once('destroyed', onDestroyed)
      chatSubscriptionCleanup.set(wc, () => wc.removeListener?.('destroyed', onDestroyed))
    }
  }

  subscriptions.set(conversationId, (subscriptions.get(conversationId) ?? 0) + 1)
  let subscribers = chatSubscribersByConversation.get(conversationId)
  if (!subscribers) {
    subscribers = new Map()
    chatSubscribersByConversation.set(conversationId, subscribers)
  }
  subscribers.set(wc, (subscribers.get(wc) ?? 0) + 1)
}

/** Removes only one subscription for this renderer and conversation. */
export function unsubscribeChatStream(wc: WebContents, conversationId: string): void {
  const subscriptions = chatSubscriptionsByWebContents.get(wc)
  const count = subscriptions?.get(conversationId)
  if (!subscriptions || !count) return

  if (count === 1) subscriptions.delete(conversationId)
  else subscriptions.set(conversationId, count - 1)

  const subscribers = chatSubscribersByConversation.get(conversationId)
  if (subscribers) {
    if (subscribers.get(wc) === 1) subscribers.delete(wc)
    else subscribers.set(wc, (subscribers.get(wc) ?? 1) - 1)
    if (subscribers.size === 0) chatSubscribersByConversation.delete(conversationId)
  }

  if (subscriptions.size === 0) {
    chatSubscriptionsByWebContents.delete(wc)
    chatSubscriptionCleanup.get(wc)?.()
    chatSubscriptionCleanup.delete(wc)
  }
}

/** The renderers subscribed to a conversation now. */
export function chatSubscribersOf(conversationId: string): WebContents[] {
  return [...(chatSubscribersByConversation.get(conversationId)?.keys() ?? [])]
}

function hasChatSubscriber(wc: WebContents, conversationId: string): boolean {
  return (chatSubscribersByConversation.get(conversationId)?.get(wc) ?? 0) > 0
}

/** The conversation of a stream that only subscribed renderers receive. */
function chatConversationIdFromChannel(channel: string): string | null {
  if (channel.startsWith('chat:delta:')) return channel.slice('chat:delta:'.length)
  if (channel.startsWith('chat:permission:')) return channel.slice('chat:permission:'.length)
  return null
}

/** The conversation of the other per-conversation channels of a turn, which its renderer receives unsubscribed. */
function chatConversationIdOfUngatedChannel(channel: string): string | null {
  for (const prefix of ['chat:maestro-live:', 'chat:subscription-failover:'])
    if (channel.startsWith(prefix)) return channel.slice(prefix.length)
  return null
}

function deliverChatEvent(wc: WebContents, channel: string, payload: unknown, gated: boolean): void {
  if (wc.isDestroyed()) {
    if (gated) clearChatSubscriptions(wc)
    return
  }
  try {
    wc.send(channel, payload)
    recordIpcSend()
  } catch {
    // WebContents may be destroyed between the check and send.
    clearChatSubscriptions(wc)
  }
}

/**
 * Sends render-only events to current consumers and counts only actual sends. `wc` is the renderer the turn belongs
 * to: it receives a gated stream only while subscribed, as before. Renderers of other computers subscribed to the
 * conversation receive its events whoever started the turn: on a host, turns are started by another computer, or by
 * the host itself for plans, reviews and dispatches, whose own window subscribes to nothing.
 */
export function sendChatEvent(wc: WebContents, channel: string, payload: unknown): void {
  const gatedConversationId = chatConversationIdFromChannel(channel)
  if (gatedConversationId) emitChatHost(gatedConversationId, channel, payload)
  const gated = gatedConversationId !== null
  const recipients = new Set<WebContents>()
  if (!gated || hasChatSubscriber(wc, gatedConversationId)) recipients.add(wc)
  const conversationId = gatedConversationId ?? chatConversationIdOfUngatedChannel(channel)
  if (conversationId) {
    for (const subscriber of chatSubscribersOf(conversationId))
      if (isRemoteUiTarget(subscriber)) recipients.add(subscriber)
  }
  for (const recipient of recipients) deliverChatEvent(recipient, channel, payload, gated)
}
