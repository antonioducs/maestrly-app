import type { FleetInboxItem } from '@maestrly/bot-fleet-protocol'
import type { ConversationStatus } from './conversation'

/** What an item of the notification center asks of the owner, or tells them. */
export type InboxKind = 'question' | 'approval' | 'plan' | 'help' | 'error' | 'finished' | 'activity'

/** What a conversation needs from the owner now, or what it told them unread; null when nothing. */
export function conversationKind(status: ConversationStatus, planned: boolean, marked: boolean): InboxKind | null {
  if (planned) return 'plan'
  if (status === 'asking') return 'question'
  if (status === 'waiting') return 'approval'
  if (marked) return status === 'error' ? 'error' : 'finished'
  return null
}

/** What a bot's request waits for: a permission is an approval; help is a request for the owner's hand. */
export function botRequestKind(item: FleetInboxItem): InboxKind {
  const { kind } = item.interaction
  return kind === 'permission' ? 'approval' : kind === 'question' ? 'question' : 'help'
}

export function botRequestSummary(item: FleetInboxItem): string | null {
  const { interaction } = item
  if (interaction.kind === 'permission') return interaction.title
  if (interaction.kind === 'question') return interaction.questions[0]?.question ?? null
  return interaction.reason
}
