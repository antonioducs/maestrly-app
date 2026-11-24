import type { FleetBot, FleetEnvironment, FleetInboxItem, MobileLists } from '@maestrly/bot-fleet-protocol'
import type { InboxObservation } from '@maestrly/bot-fleet-protocol/inbox'
import type { ChatsState } from '../chats/state'
import type { FleetState } from '../fleet/state'
import type { StreamState } from '../gateway/event-stream'

/** The narrow slice of `FleetState` that affects inbox items, enrichment, or fallback derivation. */
export interface FleetInboxSlice {
  connection: StreamState
  loaded: boolean
  bots: readonly FleetBot[]
  inbox: readonly FleetInboxItem[]
  environments: readonly FleetEnvironment[]
}

/** The narrow slice of `ChatsState` that affects inbox items or chat fallback derivation. */
export interface ChatsInboxSlice {
  lists: MobileLists | null
}

export function selectFleetInboxSlice(state: FleetState): FleetInboxSlice {
  return {
    connection: state.connection,
    loaded: state.loaded,
    bots: state.bots,
    inbox: state.inbox,
    environments: state.environments,
  }
}

export function sameFleetInboxSlice(a: FleetInboxSlice | null, b: FleetInboxSlice | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.connection === b.connection &&
    a.loaded === b.loaded &&
    a.bots === b.bots &&
    a.inbox === b.inbox &&
    a.environments === b.environments
  )
}

export function selectChatsInboxSlice(state: ChatsState): ChatsInboxSlice {
  return { lists: state.lists }
}

export function sameChatsInboxSlice(a: ChatsInboxSlice | null, b: ChatsInboxSlice | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.lists === b.lists
}

/** Cheap structural comparison for fallback observations without `JSON.stringify`. */
export function sameFallbackObservations(
  a: readonly InboxObservation<string>[] | null | undefined,
  b: readonly InboxObservation<string>[] | null | undefined
): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (
      left.key !== right.key ||
      left.at !== right.at ||
      left.status !== right.status ||
      left.ownRead !== right.ownRead ||
      left.transient !== right.transient ||
      left.known !== right.known ||
      left.active?.kind !== right.active?.kind ||
      left.active?.unread !== right.active?.unread ||
      left.view.title !== right.view.title ||
      left.view.summary !== right.view.summary ||
      left.view.project !== right.view.project ||
      left.view.place.key !== right.view.place.key ||
      left.view.place.label !== right.view.place.label ||
      left.view.bot?.name !== right.view.bot?.name ||
      left.view.bot?.tint !== right.view.bot?.tint ||
      left.view.bot?.lane !== right.view.bot?.lane
    ) {
      return false
    }
  }
  return true
}

export interface SubscribableStore<T> {
  getState(): T
  subscribe(listener: () => void): () => void
}

/**
 * Subscribes to the active fleet and chats stores and invokes `onChange` ONLY when one of the inbox-relevant
 * slices (`connection`, `loaded`, `bots`, `inbox`, `environments`, or `lists`) changes reference — skipping
 * transcript, lane, run, thread, chat-view, runtime, and outbox streaming updates.
 */
export function subscribeInboxStoreSlices(
  fleetStore: SubscribableStore<FleetState> | null | undefined,
  chatsStore: SubscribableStore<ChatsState> | null | undefined,
  onChange: () => void
): () => void {
  let lastFleet = fleetStore ? selectFleetInboxSlice(fleetStore.getState()) : null
  let lastChats = chatsStore ? selectChatsInboxSlice(chatsStore.getState()) : null

  const unsubFleet = fleetStore?.subscribe(() => {
    const next = selectFleetInboxSlice(fleetStore.getState())
    if (sameFleetInboxSlice(lastFleet, next)) return
    lastFleet = next
    onChange()
  })

  const unsubChats = chatsStore?.subscribe(() => {
    const next = selectChatsInboxSlice(chatsStore.getState())
    if (sameChatsInboxSlice(lastChats, next)) return
    lastChats = next
    onChange()
  })

  return () => {
    unsubFleet?.()
    unsubChats?.()
  }
}
