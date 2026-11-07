import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  dismissInboxItem,
  type InboxEntry,
  type InboxItem,
  type InboxLedger,
  type InboxObservation,
  inboxCounts,
  inboxItems,
  markInboxRead,
  parseInboxLedger,
  reconcileInbox,
  restoreInboxEntry,
} from './inbox-model'

/** This computer's memory of the center: what it listed, and what the owner read or dismissed. */
const LEDGER_KEY = 'inbox.ledger'
/** Ages and read items' expiry move on without any event. */
const TICK_MS = 60_000

function readLedger(): InboxLedger {
  try {
    return parseInboxLedger(localStorage.getItem(LEDGER_KEY))
  } catch {
    return {}
  }
}

/** The time now, again every `interval`. */
function useNow(interval: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(timer)
  }, [interval])
  return now
}

/**
 * When this window saw each status change. Statuses reach it only as they change, so each one it gets is new; the
 * listed times of conversations change only when their hosts list them again.
 */
export function useLiveStatusTimes(statuses: Readonly<Record<string, string>>): Readonly<Record<string, number>> {
  const seen = useRef<{ statuses: Readonly<Record<string, string>>; times: Record<string, number> }>({
    statuses: {},
    times: {},
  })
  return useMemo(() => {
    const previous = seen.current
    let times = previous.times
    const now = Date.now()
    for (const [id, status] of Object.entries(statuses)) {
      if (previous.statuses[id] === status) continue
      if (times === previous.times) times = { ...times }
      times[id] = now
    }
    seen.current = { statuses, times }
    return times
  }, [statuses])
}

export interface InboxState {
  items: InboxItem[]
  counts: { waiting: number; unread: number }
  /** Reads items in the center's own ledger; what the sources mark is cleared by whoever calls this. */
  markRead: (keys: readonly string[]) => void
  /** Hides an item until something newer happens to it; returns what undoing needs. */
  dismiss: (key: string) => InboxEntry | undefined
  restore: (key: string, entry: InboxEntry | undefined) => void
}

/** The notifications center: what the sources tell now, through what this computer remembers of it. */
export function useInbox(observations: readonly InboxObservation[]): InboxState {
  const [ledger, setLedger] = useState<InboxLedger>(readLedger)
  const now = useNow(TICK_MS)
  // Reconciled while rendering, so a new event shows at once; the effect below keeps it.
  const reconciled = useMemo(() => reconcileInbox(ledger, observations, Date.now()), [ledger, observations, now])
  useEffect(() => {
    if (reconciled !== ledger) setLedger(reconciled)
  }, [reconciled, ledger])
  useEffect(() => {
    try {
      localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger))
    } catch {
      /* Storage full or unavailable: the center still works for this session. */
    }
  }, [ledger])
  const items = useMemo(() => inboxItems(reconciled, observations, now), [reconciled, observations, now])
  const counts = useMemo(() => inboxCounts(items), [items])

  const ledgerRef = useRef(reconciled)
  ledgerRef.current = reconciled
  const observationsRef = useRef(observations)
  observationsRef.current = observations
  // An item may have shown before the effect kept its entry: the ledger acted on is reconciled first.
  const markRead = useCallback((keys: readonly string[]) => {
    setLedger((stored) => markInboxRead(reconcileInbox(stored, observationsRef.current, Date.now()), keys, Date.now()))
  }, [])
  const dismiss = useCallback((key: string) => {
    const previous = ledgerRef.current[key]
    setLedger((stored) =>
      dismissInboxItem(reconcileInbox(stored, observationsRef.current, Date.now()), key, Date.now())
    )
    return previous
  }, [])
  const restore = useCallback((key: string, entry: InboxEntry | undefined) => {
    setLedger((current) => restoreInboxEntry(current, key, entry))
  }, [])
  return { items, counts, markRead, dismiss, restore }
}
