import {
  dismissInboxItem as sharedDismissInboxItem,
  filterInbox as sharedFilterInbox,
  inboxItems as sharedInboxItems,
  markInboxRead as sharedMarkInboxRead,
  parseInboxLedger as sharedParseInboxLedger,
  reconcileInbox as sharedReconcileInbox,
  restoreInboxEntry as sharedRestoreInboxEntry,
  withStickyGroup as sharedWithStickyGroup,
  type InboxEntry as SharedInboxEntry,
  type InboxFilter,
  type InboxGroup,
  type InboxItem as SharedInboxItem,
  type InboxLedger as SharedInboxLedger,
  type InboxObservation as SharedInboxObservation,
  type InboxTarget as SharedInboxTarget,
  type InboxView as SharedInboxView,
} from '@maestrly/bot-fleet-protocol/inbox'
import type { ConversationStatus } from '../../../shared/conversation'
import type { FleetServerId } from '../../../shared/fleet-servers'

export type {
  InboxFilter,
  InboxGroup,
  InboxKind,
  InboxLane,
  InboxPlace,
  InboxSource,
} from '@maestrly/bot-fleet-protocol/inbox'

export {
  INBOX_READ_TTL_MS,
  inboxCounts,
  inboxPlaces,
  inboxSourceCounts,
  isWaitingKind,
} from '@maestrly/bot-fleet-protocol/inbox'

export type InboxTarget = SharedInboxTarget<FleetServerId>
export type InboxView = SharedInboxView<FleetServerId>
export type InboxObservation = SharedInboxObservation<FleetServerId, ConversationStatus>
export type InboxEntry = SharedInboxEntry<FleetServerId>
export type InboxLedger = SharedInboxLedger<FleetServerId>
export type InboxItem = SharedInboxItem<FleetServerId, ConversationStatus>

export const reconcileInbox: (
  ledger: InboxLedger,
  observations: readonly InboxObservation[],
  now: number
) => InboxLedger = sharedReconcileInbox

export const inboxItems: (ledger: InboxLedger, observations: readonly InboxObservation[], now: number) => InboxItem[] =
  sharedInboxItems

export const markInboxRead: (ledger: InboxLedger, keys: readonly string[], now: number) => InboxLedger =
  sharedMarkInboxRead

export const dismissInboxItem: (ledger: InboxLedger, key: string, now: number) => InboxLedger = sharedDismissInboxItem

export const restoreInboxEntry: (ledger: InboxLedger, key: string, entry: InboxEntry | undefined) => InboxLedger =
  sharedRestoreInboxEntry

export const withStickyGroup: (items: InboxItem[], sticky: { key: string; group: InboxGroup } | null) => InboxItem[] =
  sharedWithStickyGroup

export const filterInbox: (items: readonly InboxItem[], filter: InboxFilter) => InboxItem[] = sharedFilterInbox

export const parseInboxLedger: (raw: string | null) => InboxLedger = sharedParseInboxLedger
