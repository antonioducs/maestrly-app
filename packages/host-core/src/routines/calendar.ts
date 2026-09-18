import type { RoutineCauseCode, RoutineWarning, ScheduleSpec } from '@maestrly/host-protocol'

/**
 * Pure calendar arithmetic for routines. Nothing here reads the clock, touches the database
 * or starts work: it turns a specification into real instants so a person can be shown what
 * will actually happen before anything is activated.
 *
 * Zone handling is deliberately explicit rather than `Date + 24h`. Every local wall time is
 * resolved against the platform IANA database through `Intl.DateTimeFormat` and then
 * verified by reading the instant back: a reading that does not round-trip is a daylight
 * saving gap and is skipped, and a reading produced by two instants is an overlap where only
 * the first is used. That round-trip is the whole point — an offset guessed once is wrong
 * exactly on the two days a year a person would notice.
 *
 * NOTE ON THE PLAN: the approved plan asked for `@js-temporal/polyfill`. Dependency
 * installation is broken in this repository independently of this work (`npm ci` fails at
 * HEAD because several workspace packages are pinned to versions the registry does not
 * have), so adding a package would have left a tree that no fresh clone could build. The
 * arithmetic below uses the same IANA data the polyfill reads and is covered by the
 * disambiguation tests the plan required.
 */
export interface Clock {
  now(): number
}
export const systemClock: Clock = { now: () => Date.now() }

export interface CalendarOccurrence {
  /** Nominal moment of the firing. */
  scheduledForUtc: string
  /** What the person reads on their own calendar, in the routine's zone. */
  scheduledForLocal: string
}
export interface DueSummary {
  /** The single occurrence worth recovering, when the misfire policy allows one. */
  latest?: CalendarOccurrence
  /** Firings that were missed and deliberately not recovered. */
  skipped: number
  firstSkippedUtc?: string
  lastSkippedUtc?: string
  cause: RoutineCauseCode
  /** True when the lookback window itself was clamped; older firings are simply gone. */
  truncated: boolean
}

/** Upper bound on how far back a due computation will look, so a year offline is not enumerated minute by minute. */
export const MAX_LOOKBACK_MS = 400 * 24 * 60 * 60_000
/** Upper bound on forward scanning, so an impossible calendar terminates instead of spinning. */
const MAX_SCAN_DAYS = 800
const MAX_SCAN_MONTHS = 48
const MINUTE = 60_000

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timeZone: string) {
  let value = formatters.get(timeZone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, value)
  }
  return value
}
export interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}
/** Wall-clock reading of an instant in a zone, from the platform's own IANA database. */
export function localPartsOf(timeZone: string, instant: number): LocalParts & { second: number } {
  const parts = formatter(timeZone).formatToParts(new Date(instant))
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0')
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), second: read('second') }
}
const pad = (value: number, size = 2) => String(value).padStart(size, '0')
/** Stable, zone-explicit reading shown to the person: never a raw UTC string. */
export function localReading(timeZone: string, instant: number): string {
  const parts = localPartsOf(timeZone, instant)
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}
const asUtc = (parts: LocalParts) => Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
function offsetAt(timeZone: string, instant: number) {
  const parts = localPartsOf(timeZone, instant)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000
}
const sameMinute = (timeZone: string, instant: number, wanted: LocalParts) => {
  const parts = localPartsOf(timeZone, instant)
  return parts.year === wanted.year && parts.month === wanted.month && parts.day === wanted.day && parts.hour === wanted.hour && parts.minute === wanted.minute
}

export type LocalResolution =
  | { kind: 'exact'; instant: number }
  /** The wall time does not exist: the clock jumped over it this year. */
  | { kind: 'gap' }
  /** The wall time happened twice; `instants` is ordered, earliest first. */
  | { kind: 'ambiguous'; instants: [number, number] }

/**
 * Resolves one wall-clock reading in a zone by guessing an offset and reading the result
 * back. Two guesses are enough for every real zone, and the read-back is what distinguishes
 * "exists once", "does not exist" and "exists twice".
 */
export function resolveLocal(timeZone: string, wanted: LocalParts): LocalResolution {
  const target = asUtc(wanted)
  const candidates: number[] = []
  // Probe the offset on both sides of the reading: a transition sits between them, so one of
  // these guesses lands on each side of it. Only guesses that read back are kept.
  for (const probe of [target, target - 12 * 3_600_000, target + 12 * 3_600_000, target - 30 * 3_600_000, target + 30 * 3_600_000]) {
    const instant = target - offsetAt(timeZone, probe)
    if (sameMinute(timeZone, instant, wanted) && !candidates.includes(instant)) candidates.push(instant)
  }
  if (!candidates.length) return { kind: 'gap' }
  if (candidates.length === 1) return { kind: 'exact', instant: candidates[0] }
  const ordered = [...candidates].sort((a, b) => a - b)
  return { kind: 'ambiguous', instants: [ordered[0], ordered[ordered.length - 1]] }
}
/** True when this instant's local reading is produced by a second instant as well. */
export function isAmbiguousInstant(timeZone: string, instant: number) {
  const parts = localPartsOf(timeZone, instant)
  const resolution = resolveLocal(timeZone, parts)
  return resolution.kind === 'ambiguous'
}

/** ISO weekday, Monday = 1, derived from the local date rather than the UTC one. */
function isoWeekday(parts: LocalParts) {
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  return day === 0 ? 7 : day
}
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()
function addDays(parts: LocalParts, days: number): LocalParts {
  const moved = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate(), hour: parts.hour, minute: parts.minute }
}

export interface EnumeratedOccurrence extends CalendarOccurrence {
  instant: number
}
export interface Enumeration {
  occurrences: EnumeratedOccurrence[]
  warnings: RoutineWarning[]
  /** True when the scan hit its bound before producing `count` results. */
  exhausted: boolean
}

/**
 * The next `count` firings strictly after `afterUtc`. A daylight saving gap is skipped and
 * reported; an overlap yields only the first of the two instants, so a routine never runs
 * twice because a clock went back.
 */
export function enumerate(spec: ScheduleSpec, afterUtc: number, count: number): Enumeration {
  const warnings: RoutineWarning[] = []
  const occurrences: EnumeratedOccurrence[] = []
  const zone = spec.timeZone
  const push = (instant: number) => {
    if (instant <= afterUtc) return
    occurrences.push({ instant, scheduledForUtc: new Date(instant).toISOString(), scheduledForLocal: localReading(zone, instant) })
  }
  const warn = (code: RoutineWarning['code'], message: string) => {
    if (!warnings.some((warning) => warning.code === code)) warnings.push({ code, message })
  }

  if (spec.kind === 'once') {
    const instant = Date.parse(spec.atUtc)
    if (!Number.isFinite(instant)) return { occurrences: [], warnings: [{ code: 'NONEXISTENT_INSTANT', message: 'O horário informado não é válido.' }], exhausted: false }
    if (isAmbiguousInstant(zone, instant))
      warn('AMBIGUOUS_INSTANT', 'Neste dia o relógio volta e este horário acontece duas vezes; confirme qual você quer.')
    push(instant)
    return { occurrences, warnings, exhausted: false }
  }
  if (spec.kind === 'interval') {
    const anchor = Date.parse(spec.anchorUtc)
    if (!Number.isFinite(anchor)) return { occurrences: [], warnings: [{ code: 'NONEXISTENT_INSTANT', message: 'A âncora do intervalo não é válida.' }], exhausted: false }
    const step = spec.everyMinutes * MINUTE
    // Arithmetic on the anchor, never on the previous completion: an occurrence that took
    // ten minutes must not push every following firing ten minutes later.
    let index = Math.floor((afterUtc - anchor) / step) + 1
    if (index < 0) index = 0
    for (let produced = 0; produced < count; produced++) push(anchor + (index + produced) * step)
    return { occurrences, warnings, exhausted: false }
  }

  const start = localPartsOf(zone, afterUtc)
  if (spec.kind === 'monthly') {
    let year = start.year
    let month = start.month
    for (let scanned = 0; scanned < MAX_SCAN_MONTHS && occurrences.length < count; scanned++) {
      if (spec.dayOfMonth > daysInMonth(year, month)) {
        warn('MONTH_WITHOUT_DAY', `Meses sem o dia ${spec.dayOfMonth} são pulados.`)
      } else {
        const resolution = resolveLocal(zone, { year, month, day: spec.dayOfMonth, hour: spec.hour, minute: spec.minute })
        if (resolution.kind === 'gap') warn('DST_GAP_SKIPPED', 'Neste dia o relógio adianta e este horário não existe; a execução é pulada.')
        else if (resolution.kind === 'ambiguous') {
          warn('DST_OVERLAP_FIRST', 'Neste dia o relógio volta e este horário acontece duas vezes; só a primeira vez executa.')
          push(resolution.instants[0])
        } else push(resolution.instant)
      }
      month += 1
      if (month > 12) {
        month = 1
        year += 1
      }
    }
    return { occurrences, warnings, exhausted: occurrences.length < count }
  }

  let day: LocalParts = { year: start.year, month: start.month, day: start.day, hour: spec.hour, minute: spec.minute }
  for (let scanned = 0; scanned < MAX_SCAN_DAYS && occurrences.length < count; scanned++, day = addDays(day, 1)) {
    if (spec.kind === 'weekly' && !spec.daysOfWeek.includes(isoWeekday(day))) continue
    const resolution = resolveLocal(zone, day)
    if (resolution.kind === 'gap') {
      warn('DST_GAP_SKIPPED', 'Neste dia o relógio adianta e este horário não existe; a execução é pulada.')
      continue
    }
    if (resolution.kind === 'ambiguous') {
      warn('DST_OVERLAP_FIRST', 'Neste dia o relógio volta e este horário acontece duas vezes; só a primeira vez executa.')
      push(resolution.instants[0])
      continue
    }
    push(resolution.instant)
  }
  return { occurrences, warnings, exhausted: occurrences.length < count }
}

/** Public shape used by previews and by the scheduler when it looks for the next slot. */
export function nextOccurrences(spec: ScheduleSpec, afterUtc: number, count: number): CalendarOccurrence[] {
  return enumerate(spec, afterUtc, count).occurrences.map(({ instant: _instant, ...rest }) => rest)
}
export function previewWarnings(spec: ScheduleSpec, afterUtc: number): RoutineWarning[] {
  return enumerate(spec, afterUtc, 3).warnings
}

/**
 * What the Host missed between `fromUtc` (exclusive) and `nowUtc` (inclusive). It returns at
 * most one recoverable occurrence — the last eligible one — and summarises the rest as a
 * range with a cause, instead of materialising a year of backlog as real work.
 */
export function latestDue(spec: ScheduleSpec, fromUtc: number, nowUtc: number, windowMs: number): DueSummary {
  const floor = Math.max(fromUtc, nowUtc - MAX_LOOKBACK_MS)
  const truncated = floor > fromUtc
  const due: EnumeratedOccurrence[] = []
  if (spec.kind === 'interval') {
    const anchor = Date.parse(spec.anchorUtc)
    const step = spec.everyMinutes * MINUTE
    const first = Math.max(0, Math.floor((floor - anchor) / step) + 1)
    const last = Math.floor((nowUtc - anchor) / step)
    // Only the boundaries are needed: counting is arithmetic, not enumeration.
    const total = Math.max(0, last - first + 1)
    if (total > 0) {
      const firstInstant = anchor + first * step
      const lastInstant = anchor + last * step
      const eligible = nowUtc - lastInstant <= windowMs
      return {
        ...(eligible ? { latest: { scheduledForUtc: new Date(lastInstant).toISOString(), scheduledForLocal: localReading(spec.timeZone, lastInstant) } } : {}),
        skipped: eligible ? total - 1 : total,
        firstSkippedUtc: total > (eligible ? 1 : 0) ? new Date(firstInstant).toISOString() : undefined,
        lastSkippedUtc: total > (eligible ? 1 : 0) ? new Date(eligible ? lastInstant - step : lastInstant).toISOString() : undefined,
        cause: 'MISSED_WINDOW',
        truncated,
      }
    }
    return { skipped: 0, cause: 'ON_TIME', truncated }
  }
  let cursor = floor
  for (let guard = 0; guard < MAX_SCAN_DAYS + MAX_SCAN_MONTHS; guard++) {
    const [next] = enumerate(spec, cursor, 1).occurrences
    if (!next || next.instant > nowUtc) break
    due.push(next)
    cursor = next.instant
  }
  if (!due.length) return { skipped: 0, cause: 'ON_TIME', truncated }
  const last = due[due.length - 1]
  const eligible = nowUtc - last.instant <= windowMs
  const skippedList = eligible ? due.slice(0, -1) : due
  return {
    ...(eligible ? { latest: { scheduledForUtc: last.scheduledForUtc, scheduledForLocal: last.scheduledForLocal } } : {}),
    skipped: skippedList.length,
    firstSkippedUtc: skippedList[0]?.scheduledForUtc,
    lastSkippedUtc: skippedList[skippedList.length - 1]?.scheduledForUtc,
    cause: 'MISSED_WINDOW',
    truncated,
  }
}

const WEEKDAYS = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo']
/** One short sentence a person can check, always naming the zone explicitly. */
export function describeSchedule(spec: ScheduleSpec): string {
  const at = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`
  switch (spec.kind) {
    case 'once':
      return `uma vez, em ${localReading(spec.timeZone, Date.parse(spec.atUtc))} (${spec.timeZone})`
    case 'daily':
      return `todos os dias às ${at(spec.hour, spec.minute)} (${spec.timeZone})`
    case 'weekly':
      return `toda ${[...spec.daysOfWeek].sort((a, b) => a - b).map((day) => WEEKDAYS[day - 1]).join(', ')} às ${at(spec.hour, spec.minute)} (${spec.timeZone})`
    case 'monthly':
      return `todo dia ${spec.dayOfMonth} às ${at(spec.hour, spec.minute)} (${spec.timeZone})`
    case 'interval':
      return spec.everyMinutes % 60 === 0
        ? `a cada ${spec.everyMinutes / 60} hora(s) (${spec.timeZone})`
        : `a cada ${spec.everyMinutes} minutos (${spec.timeZone})`
  }
}
