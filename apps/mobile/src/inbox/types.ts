import type { InboxEntry, InboxItem, InboxPlace } from '@maestrly/bot-fleet-protocol/inbox'
import { pushLink, type PushTarget } from '../notifications/push'

export interface MobileInboxItem extends InboxItem<string> {
  serverId: string
  serverName: string
  environmentId: string | null
  environmentName: string | null
  /** The server is unreachable: shown dimmed. */
  stale: boolean
}

export interface MobileInboxServer {
  id: string
  name: string
  reachable: boolean
  supportsAttention: boolean
  environments: number
}

export interface InboxUndo {
  key: string
  entry: InboxEntry<string> | undefined
}

export interface MobileInbox {
  items: MobileInboxItem[]
  counts: { waiting: number; unread: number; total: number }
  servers: MobileInboxServer[]
  open(item: MobileInboxItem): Promise<void>
  markRead(keys: string[]): void
  markAllRead(): void
  dismiss(key: string): InboxUndo
  restore(undo: InboxUndo): void
}

/** Prefixes a server's attention key with its server id so keys never collide across paired servers. */
export const inboxItemKey = (serverId: string, entryKey: string): string => `${serverId}|${entryKey}`

/** Splits a prefixed mobile inbox key back into server id and raw gateway attention key. */
export function parseInboxItemKey(key: string): { serverId: string; entryKey: string } | null {
  const separator = key.indexOf('|')
  if (separator <= 0 || separator === key.length - 1) return null
  return { serverId: key.slice(0, separator), entryKey: key.slice(separator + 1) }
}

/**
 * Builds the place chip for an item: the server alone when it hosts at most one environment, or `<server> · <env>`
 * when the server has more than one environment and the item belongs to one.
 */
export function mobileInboxPlace(
  serverId: string,
  serverName: string,
  environmentId: string | null,
  environmentName: string | null,
  environmentCount: number
): InboxPlace {
  if (environmentCount > 1 && environmentId) {
    return { key: `${serverId}/${environmentId}`, label: `${serverName} · ${environmentName ?? environmentId}` }
  }
  return { key: serverId, label: serverName }
}

/** Converts a mobile inbox item into the same route link a tapped push notification opens. */
export function inboxItemLink(item: Pick<MobileInboxItem, 'serverId' | 'environmentId' | 'target'>): string | null {
  const { target } = item
  let pushTarget: PushTarget
  if (target.kind === 'conversation') {
    pushTarget = {
      serverId: item.serverId,
      kind: 'chat',
      id: target.conversationId,
      ...(item.environmentId ? { environmentId: item.environmentId } : {}),
    }
  } else if (target.kind === 'bot') {
    pushTarget = {
      serverId: item.serverId,
      kind: 'bot',
      id: target.botId,
      ...(target.runId ? { runId: target.runId } : {}),
      ...(target.threadId ? { threadId: target.threadId } : {}),
    }
  } else if (target.conversationId) {
    pushTarget = {
      serverId: item.serverId,
      kind: 'chat',
      id: target.conversationId,
      ...(item.environmentId ? { environmentId: item.environmentId } : {}),
    }
  } else {
    return null
  }
  return pushLink(pushTarget)
}

export interface OpenInboxItemDeps {
  activeServerId: string | null
  activeEnvironmentId: string | null
  activateServer(serverId: string): Promise<void>
  setEnvironment(environmentId: string): void
  pushRoute(href: string): void
  markRead(keys: string[]): void
}

/**
 * Opens an inbox item: marks it read in the ledger (and fires `/v1/attention/seen` via `markRead`), switches the
 * active server or workspaces environment when needed, and navigates to the same route a tapped push opens.
 */
export async function openInboxItem(item: MobileInboxItem, deps: OpenInboxItemDeps): Promise<void> {
  deps.markRead([item.key])
  if (deps.activeServerId !== item.serverId) {
    await deps.activateServer(item.serverId)
  } else if (
    item.target.kind === 'conversation' &&
    item.environmentId &&
    deps.activeEnvironmentId !== item.environmentId
  ) {
    deps.setEnvironment(item.environmentId)
  }
  const link = inboxItemLink(item)
  if (link) deps.pushRoute(link)
}
