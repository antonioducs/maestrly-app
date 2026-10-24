import {
  FLEET_PEER_THREAD_SETTINGS_DEFAULT,
  type FleetBot,
  type FleetPeerThread,
  type FleetPeerThreadSettings,
} from '@maestrly/bot-fleet-protocol'
import { sideTurns } from './turns'

const DAY = 86_400_000

/**
 * What a thread between bots is now: its conversation deleted, a turn of one of the bots working in it, paused until
 * the owner writes or lets it go on, or open.
 */
export type ThreadState = 'deleted' | 'working' | 'paused' | 'open'
export function threadState(thread: FleetPeerThread, bot?: ThreadBot): ThreadState {
  if (thread.conversation === 'deleted') return 'deleted'
  if (thread.status === 'paused') return 'paused'
  if (threadWorking(thread, bot) || thread.peerWorking) return 'working'
  return 'open'
}

type ThreadBot = Pick<FleetBot, 'status' | 'runningRun'> & { turns?: FleetBot['turns'] }
/** Whether this bot has a turn in the thread: as the thread says, or as the bot's turns say, whichever is newer. */
export function threadWorking(thread: FleetPeerThread, bot?: ThreadBot): boolean {
  return thread.working || (!!bot && sideTurns(bot).some((turn) => turn.kind === 'peer' && turn.id === thread.id))
}

/** The settings a bot keeps its threads with: its own, or the defaults. */
export const threadSettingsOf = (bot: Pick<FleetBot, 'peerSettings'>): FleetPeerThreadSettings =>
  bot.peerSettings ?? FLEET_PEER_THREAD_SETTINGS_DEFAULT

/** Whole days until retention deletes the thread's conversation; null when it never does. */
export function threadExpiresInDays(thread: FleetPeerThread, now: number): number | null {
  if (!thread.expiresAt) return null
  return Math.max(0, Math.ceil((Date.parse(thread.expiresAt) - now) / DAY))
}

/** The threads waiting for the owner: paused, with a conversation to write in. */
export const threadsNeedingYou = (threads: readonly FleetPeerThread[]): FleetPeerThread[] =>
  threads.filter((thread) => threadState(thread) === 'paused')

/** The list of threads: those that need the owner first, then the others, the most recently active first. */
export function threadGroups(
  threads: readonly FleetPeerThread[],
  bot?: ThreadBot
): Array<{ key: 'needs' | 'active' | 'earlier'; threads: FleetPeerThread[] }> {
  const needs = threads.filter((thread) => threadState(thread, bot) === 'paused')
  const active = threads.filter((thread) => threadState(thread, bot) === 'working')
  const earlier = threads.filter((thread) => !needs.includes(thread) && !active.includes(thread))
  return [
    { key: 'needs' as const, threads: needs },
    { key: 'active' as const, threads: active },
    { key: 'earlier' as const, threads: earlier },
  ].filter((group) => group.threads.length > 0)
}

const SEEN_MAX = 500

/** Where a bot's seen threads are kept on this computer: per server and bot. */
export const threadSeenKey = (server: string | null, botId: string): string =>
  `fleet.threadsSeen:${server ?? ''}:${botId}`

/**
 * What the owner has seen of each thread, as the time of its last activity then, kept on this computer. The first
 * time a bot's threads are read, all of them count as seen: only what happens afterwards is new.
 */
export function readSeenThreads(key: string, threads: readonly FleetPeerThread[]): Map<string, string> {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw) return new Map(Object.entries(JSON.parse(raw) as Record<string, string>))
  } catch {}
  const seen = new Map(threads.map((thread) => [thread.id, thread.lastActivityAt]))
  writeSeenThreads(key, seen)
  return seen
}
export function writeSeenThreads(key: string, seen: ReadonlyMap<string, string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(Object.fromEntries([...seen].slice(-SEEN_MAX))))
  } catch {}
}

/**
 * What the owner has seen of a bot's threads: `gateway` when the gateway keeps it for all their devices
 * (`owner-seen`, each thread's `seenActivityAt`), or else each thread's last activity as this computer kept it.
 */
export type SeenThreads = ReadonlyMap<string, string> | 'gateway'

/** Threads with activity the owner has not seen, and the paused ones, which wait for them. */
export function unseenThreads(threads: readonly FleetPeerThread[], seen: SeenThreads) {
  return threads.filter(
    (thread) =>
      thread.conversation === 'own' &&
      (threadState(thread) === 'paused' ||
        (seen === 'gateway' ? thread.seenActivityAt : seen.get(thread.id)) !== thread.lastActivityAt)
  )
}
