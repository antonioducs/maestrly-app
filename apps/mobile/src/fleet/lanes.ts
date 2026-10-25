import {
  FLEET_PEER_CONVERSATIONS_FEATURE,
  FLEET_PEER_THREAD_SETTINGS_DEFAULT,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
  fleetLaneTurn,
  type FleetBot,
  type FleetPeerThread,
  type FleetPeerThreadSettings,
  type FleetRoutineRun,
  type FleetRoutineRunSettings,
} from '@maestrly/bot-fleet-protocol'

/*
 * A bot's side conversations, as the desktop shows them: its routine runs (`routine-conversations`) and its
 * conversations with other bots (`peer-conversations`), each one apart from the bot's own conversation. The rules
 * follow the desktop's (apps/desktop/src/renderer/lib/fleet/runs.ts and threads.ts), so both apps read them alike.
 */

const DAY = 86_400_000

/** One of a bot's side conversations: a routine run's or a thread's with another bot. */
export type LaneKind = 'run' | 'thread'
export type LaneRef = { kind: LaneKind; id: string }

/** Where a side conversation's transcript is kept in the state: its bot and its run's or thread's id. */
export const laneKey = (botId: string, laneId: string): string => `${botId}\u0000${laneId}`
export const botOfLaneKey = (key: string): string => key.slice(0, key.indexOf('\u0000'))

/** Whether the server and the bot keep routine runs, and conversations with other bots, in conversations of their own. */
export function lanesSupported(
  features: readonly string[],
  bot: Pick<FleetBot, 'capabilities'>
): { runs: boolean; threads: boolean } {
  const both = (feature: string) => features.includes(feature) && bot.capabilities.includes(feature)
  return { runs: both(FLEET_ROUTINE_CONVERSATIONS_FEATURE), threads: both(FLEET_PEER_CONVERSATIONS_FEATURE) }
}

type TurnsBot = Pick<FleetBot, 'status' | 'runningRun'> & { turns?: FleetBot['turns'] }

/** A turn running in one of the bot's side conversations. */
export type SideTurn = { kind: 'routine' | 'peer'; id: string; title: string; startedAt: string | null }

/**
 * The turns of the bot's side conversations, oldest first: from its `turns` (`parallel-turns`), or from an older
 * gateway, the routine run it works on.
 */
export function sideTurns(bot: TurnsBot): SideTurn[] {
  if (bot.turns)
    return bot.turns.flatMap((turn) =>
      turn.kind === 'primary' || !turn.id
        ? []
        : [{ kind: turn.kind, id: turn.id, title: turn.title, startedAt: turn.startedAt }]
    )
  const run = bot.runningRun
  return run ? [{ kind: 'routine', id: run.id, title: run.title, startedAt: run.startedAt }] : []
}

// --- Routine runs ---

export type RunBot = Pick<FleetBot, 'runningRun'> & { turns?: FleetBot['turns'] }
/** What a run is now, as its history shows it. */
export type RunState = 'running' | 'queued' | 'ok' | 'quiet' | 'failed' | 'cancelled' | 'deleted' | 'unknown'

export function runState(run: FleetRoutineRun, bot: RunBot): RunState {
  if (fleetLaneTurn({ turns: bot.turns ?? null, runningRun: bot.runningRun }, run.id)) return 'running'
  if (run.conversation === 'deleted') return 'deleted'
  if (run.status === 'delivered') return 'queued'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'cancelled') return 'cancelled'
  if (run.status === 'unknown') return 'unknown'
  return run.quiet ? 'quiet' : 'ok'
}

/** Whether a run is working or waiting to: it can be stopped, not changed. */
export const runWorking = (state: RunState): boolean => state === 'running' || state === 'queued'

/** A run's one line: its report's summary, or else the start of its final answer. */
export function runSummary(run: FleetRoutineRun): string | null {
  if (run.report?.summary) return run.report.summary
  return (
    run.finalText
      ?.split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? null
  )
}

/** Days until retention deletes a conversation, from now; null when it never does on its own. */
export function expiresInDays(item: { expiresAt: string | null }, now: number): number | null {
  if (!item.expiresAt) return null
  return Math.max(0, Math.ceil((Date.parse(item.expiresAt) - now) / DAY))
}

/** How long a finished run took, in whole seconds. */
export function runDuration(run: FleetRoutineRun): number | null {
  if (!run.finishedAt) return null
  return Math.max(1, Math.round((Date.parse(run.finishedAt) - Date.parse(run.deliveredAt)) / 1000))
}

/** Runs newest first, by when they were delivered, then by id as the gateway pages them. */
export const sortRuns = (runs: FleetRoutineRun[]): FleetRoutineRun[] =>
  [...runs].sort((a, b) =>
    a.deliveredAt === b.deliveredAt ? (a.id < b.id ? 1 : -1) : a.deliveredAt < b.deliveredAt ? 1 : -1
  )

/** The routines of a bot's runs, with how many runs each has, in the order they last ran. */
export function runRoutines(runs: FleetRoutineRun[]): Array<{ id: string; title: string | null; count: number }> {
  const routines = new Map<string, { id: string; title: string | null; count: number }>()
  for (const run of runs) {
    const entry = routines.get(run.routineId) ?? { id: run.routineId, title: run.routineTitle, count: 0 }
    entry.count++
    routines.set(run.routineId, entry)
  }
  return [...routines.values()]
}

export type RunListEntry =
  | { kind: 'run'; run: FleetRoutineRun }
  /** A routine's runs of one day that found nothing new, folded into one line. */
  | { kind: 'quiet'; key: string; routineId: string; title: string | null; runs: FleetRoutineRun[] }
export type RunDay = { key: string; day: number; entries: RunListEntry[] }

export const dayStart = (time: number): number => {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * A bot's runs by local day, newest first. Within a day, two or more runs of one routine that finished with nothing
 * new fold into one line where the first of them would be; any other run stays on its own. A phone has little room
 * for an interval routine's dozens of runs a day.
 */
export function runDays(runs: FleetRoutineRun[], bot: RunBot): RunDay[] {
  const days: RunDay[] = []
  for (const run of runs) {
    const day = dayStart(Date.parse(run.deliveredAt))
    let current = days.at(-1)
    if (current?.day !== day) days.push((current = { key: String(day), day, entries: [] }))
    current.entries.push({ kind: 'run', run })
  }
  for (const day of days) {
    const quiet = new Map<string, FleetRoutineRun[]>()
    for (const entry of day.entries)
      if (entry.kind === 'run' && runState(entry.run, bot) === 'quiet')
        quiet.set(entry.run.routineId, [...(quiet.get(entry.run.routineId) ?? []), entry.run])
    const folded = new Set<string>()
    day.entries = day.entries.flatMap((entry): RunListEntry[] => {
      if (entry.kind !== 'run') return [entry]
      const group = quiet.get(entry.run.routineId)
      if (!group || group.length < 2 || !group.includes(entry.run)) return [entry]
      if (folded.has(entry.run.routineId)) return []
      folded.add(entry.run.routineId)
      return [
        {
          kind: 'quiet',
          key: `${day.key}:${entry.run.routineId}`,
          routineId: entry.run.routineId,
          title: entry.run.routineTitle,
          runs: group,
        },
      ]
    })
  }
  return days
}

/** Whether a day is today, yesterday or another one, as the history heads it. */
export function dayKind(day: number, now: number): 'today' | 'yesterday' | 'other' {
  const today = dayStart(now)
  if (day === today) return 'today'
  // The day before today starts a millisecond before it, whatever a daylight saving change made its length.
  return day === dayStart(today - 1) ? 'yesterday' : 'other'
}

/** The settings a bot keeps its runs with: its own, or the defaults from a gateway that predates them. */
export const runSettingsOf = (bot: Pick<FleetBot, 'runSettings'>): FleetRoutineRunSettings =>
  bot.runSettings ?? FLEET_ROUTINE_RUN_SETTINGS_DEFAULT

/**
 * The finished runs the bot's conversation tells the owner about, as its settings say: those with something new and
 * every failure, all of them, or none. Runs from before conversations of their own are in the conversation already.
 */
export function runMarkers(runs: FleetRoutineRun[], settings: FleetRoutineRunSettings): FleetRoutineRun[] {
  if (settings.notify === 'none') return []
  return runs.filter(
    (run) =>
      run.conversation !== 'primary' &&
      run.finishedAt !== null &&
      (run.status === 'completed' || run.status === 'failed') &&
      (settings.notify === 'all' || run.status === 'failed' || !run.quiet)
  )
}

/**
 * What the owner has opened of a bot's runs: `gateway` when the gateway keeps it for all their devices (`owner-seen`,
 * each run's `seenAt`), or else the runs the phone kept.
 */
export type SeenRuns = ReadonlySet<string> | 'gateway'

/** Finished runs with something new the owner has not opened yet. */
export function unseenRuns(runs: FleetRoutineRun[], seen: SeenRuns, bot: RunBot): FleetRoutineRun[] {
  return runs.filter((run) => {
    const state = runState(run, bot)
    const opened = seen === 'gateway' ? run.seenAt !== null : seen.has(run.id)
    return !opened && (state === 'ok' || state === 'failed')
  })
}

// --- Conversations with other bots ---

/**
 * What a thread is now: its conversation deleted, paused until the owner writes or lets it go on, a turn of one of
 * the bots working in it, or open.
 */
export type ThreadState = 'deleted' | 'working' | 'paused' | 'open'

/** Whether this bot has a turn in the thread: as the thread says, or as the bot's turns say, whichever is newer. */
export function threadWorking(thread: FleetPeerThread, bot?: TurnsBot): boolean {
  return thread.working || (!!bot && sideTurns(bot).some((turn) => turn.kind === 'peer' && turn.id === thread.id))
}

export function threadState(thread: FleetPeerThread, bot?: TurnsBot): ThreadState {
  if (thread.conversation === 'deleted') return 'deleted'
  if (thread.status === 'paused') return 'paused'
  if (threadWorking(thread, bot) || thread.peerWorking) return 'working'
  return 'open'
}

/** The settings a bot keeps its threads with: its own, or the defaults. */
export const threadSettingsOf = (bot: Pick<FleetBot, 'peerSettings'>): FleetPeerThreadSettings =>
  bot.peerSettings ?? FLEET_PEER_THREAD_SETTINGS_DEFAULT

/** Threads the most recently active first, then by id. */
export const sortThreads = (threads: FleetPeerThread[]): FleetPeerThread[] =>
  [...threads].sort((a, b) =>
    a.lastActivityAt === b.lastActivityAt ? (a.id < b.id ? 1 : -1) : a.lastActivityAt < b.lastActivityAt ? 1 : -1
  )

export type ThreadGroupKey = 'needs' | 'active' | 'earlier'

/** The list of threads: those that wait for the owner first, then those at work, then the others. */
export function threadGroups(
  threads: readonly FleetPeerThread[],
  bot?: TurnsBot
): Array<{ key: ThreadGroupKey; threads: FleetPeerThread[] }> {
  const needs = threads.filter((thread) => threadState(thread, bot) === 'paused')
  const active = threads.filter((thread) => threadState(thread, bot) === 'working')
  const earlier = threads.filter((thread) => !needs.includes(thread) && !active.includes(thread))
  return [
    { key: 'needs' as const, threads: needs },
    { key: 'active' as const, threads: active },
    { key: 'earlier' as const, threads: earlier },
  ].filter((group) => group.threads.length > 0)
}

/**
 * What the owner has seen of a bot's threads: `gateway` when the gateway keeps it for all their devices
 * (`owner-seen`, each thread's `seenActivityAt`), or else each thread's last activity as the phone kept it.
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

/** The bots a bot has threads with, with how many threads each, in the order of the list. */
export function threadPeers(threads: readonly FleetPeerThread[]): Array<{ id: string; name: string; count: number }> {
  const peers = new Map<string, { id: string; name: string; count: number }>()
  for (const thread of threads) {
    const entry = peers.get(thread.peer.botId) ?? { id: thread.peer.botId, name: thread.peer.name, count: 0 }
    entry.count++
    peers.set(thread.peer.botId, entry)
  }
  return [...peers.values()]
}
