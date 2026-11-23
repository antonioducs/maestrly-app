import { conversationKind as sharedConversationKind, type InboxKind } from '@maestrly/bot-fleet-protocol/inbox'
import type { ConversationStatus } from './conversation'

export type { InboxKind }
export { botRequestKind, botRequestSummary } from '@maestrly/bot-fleet-protocol/inbox'

/** What a conversation needs from the owner now, or what it told them unread; null when nothing. */
export const conversationKind: (status: ConversationStatus, planned: boolean, marked: boolean) => InboxKind | null =
  sharedConversationKind
