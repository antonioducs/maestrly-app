import {
  FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
  fleetLaneTurn,
  type FleetBot,
  type FleetRoutineRun,
  type FleetRoutineRunSettings,
} from '@maestrly/bot-fleet-protocol'

const DAY = 86_400_000

/** What run states read of a bot: the turns it runs now (or, from an older gateway, the run it works on). */
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
  const first = run.finalText
    ?.split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  return first ?? null
}

/** The routine a run belongs to, by the name it had: runs outlive their routines. */
export const runTitle = (run: FleetRoutineRun, fallback: string): string => run.routineTitle || fallback

/** Days until retention deletes a run's conversation, from now; null when it never does on its own. */
export function runExpiresInDays(run: FleetRoutineRun, now: number): number | null {
  if (!run.expiresAt) return null
  return Math.max(0, Math.ceil((Date.parse(run.expiresAt) - now) / DAY))
}

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

const dayStart = (time: number): number => {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * A bot's runs by local day, newest first. Within a day, two or more runs of one routine that finished with nothing
 * new fold into one line where the first of them would be; any other run stays on its own.
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

/** How a day reads in the history: today, yesterday, or its date. */
export function runDayLabel(
  day: number,
  now: number,
  locale: string,
  words: { today: string; yesterday: string }
): string {
  const today = dayStart(now)
  if (day === today) return words.today
  // The day before today starts a millisecond before it, whatever a daylight saving change made its length.
  if (day === dayStart(today - 1)) return words.yesterday
  const text = new Date(day).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'short' })
  return text.charAt(0).toUpperCase() + text.slice(1)
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

/** The runs whose ending tells the owner something, as the bot's settings say: what its alerts follow. */
export const runAlerts = (run: FleetRoutineRun, settings: FleetRoutineRunSettings): boolean =>
  runMarkers([run], settings).length === 1

const SEEN_MAX = 500

/** Where a bot's seen runs are kept on this computer: per server and bot. */
export const runSeenKey = (server: string | null, botId: string): string => `fleet.runsSeen:${server ?? ''}:${botId}`

/**
 * The runs the owner has seen, kept on this computer. The first time a bot's runs are read, every run there already
 * counts as seen: only runs that end afterwards are new.
 */
export function readSeenRuns(key: string, runs: FleetRoutineRun[]): Set<string> {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {}
  const seen = new Set(runs.map((run) => run.id))
  writeSeenRuns(key, seen)
  return seen
}
export function writeSeenRuns(key: string, seen: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...seen].slice(-SEEN_MAX)))
  } catch {}
}

/**
 * What the owner has opened of a bot's runs: `gateway` when the gateway keeps it for all their devices (`owner-seen`,
 * each run's `seenAt`), or else the runs this computer kept.
 */
export type SeenRuns = ReadonlySet<string> | 'gateway'

/** Finished runs with something new the owner has not opened yet. */
export function unseenRuns(runs: FleetRoutineRun[], seen: SeenRuns, bot: RunBot) {
  return runs.filter((run) => {
    const state = runState(run, bot)
    const opened = seen === 'gateway' ? run.seenAt !== null : seen.has(run.id)
    return !opened && (state === 'ok' || state === 'failed')
  })
}

/** How long a finished run took, rounded to seconds. */
export function runDuration(run: FleetRoutineRun): number | null {
  if (!run.finishedAt) return null
  return Math.max(1, Math.round((Date.parse(run.finishedAt) - Date.parse(run.deliveredAt)) / 1000))
}
