import path from 'node:path'
import { FLEET_MESSAGE_TEXT_MAX, FLEET_RUNNER_TRANSFER_LIMITS, type FleetRunnerJob } from '@maestrly/bot-fleet-protocol'
import { realFs } from '../../../real-fs'
import type { RunnerJobRecord, RunnerJobRecords } from './records'
import { RUNNER_FOLDER_STATE, RUNNER_JOB_FILES } from './shared'
import { tailRunnerLog } from './log'

const fs = realFs.promises

/** Output files a result names; the rest are counted. */
const FILES_LISTED_MAX = 50
/** The share of the message the list of output files may take, so a long list never crowds out the log. */
const FILES_CHARS_MAX = 3_000
/** Marks a log tail whose first lines did not fit. */
const LOG_CUT = '(earlier lines omitted)'

/**
 * The file that holds the most of a job's log: the environment's copy, which came in batches while the job ran, or the
 * runner's own, which came with the outputs into the job folder once the job ended and is whole when ours is not.
 */
export async function runnerLogFile(records: RunnerJobRecords, record: RunnerJobRecord): Promise<string> {
  const ours = path.join(records.dir(record.jobId), RUNNER_JOB_FILES.log)
  const theirs = path.join(record.folder, RUNNER_FOLDER_STATE, `${record.jobId}.log`)
  const [ourInfo, theirInfo] = await Promise.all([fs.lstat(ours).catch(() => null), fs.lstat(theirs).catch(() => null)])
  return theirInfo?.isFile() && theirInfo.size >= (ourInfo?.size ?? 0) ? theirs : ours
}

/** The tail of a job's log as the continuation carries it: 200 lines, 16 KiB. */
export async function runnerLogTail(records: RunnerJobRecords, record: RunnerJobRecord): Promise<string> {
  return await tailRunnerLog(await runnerLogFile(records, record)).catch(() => '')
}

/** `3m 12s`, `1h 05m`, `42s`. */
export function runnerDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

const size = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : bytes < 1024 ** 3
        ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
        : `${(bytes / 1024 ** 3).toFixed(1)} GiB`

function headline(job: FleetRunnerJob): string {
  switch (job.state) {
    case 'succeeded':
      return `Runner job ${job.jobId} succeeded.`
    case 'failed':
      return `Runner job ${job.jobId} failed.`
    case 'cancelled':
      return `Runner job ${job.jobId} was cancelled.`
    case 'expired':
      return `Runner job ${job.jobId} expired: no runner took it in time.`
    case 'lost':
      return `Runner job ${job.jobId} was lost: its runner went away and did not come back.`
    default:
      return `Runner job ${job.jobId} is ${job.state}.`
  }
}

function took(job: FleetRunnerJob): string | null {
  const end = Date.parse(job.endedAt ?? '')
  const start = Date.parse(job.startedAt ?? '')
  if (Number.isFinite(start) && Number.isFinite(end)) return `Ran for ${runnerDuration(end - start)}.`
  const created = Date.parse(job.createdAt)
  if (Number.isFinite(created) && Number.isFinite(end))
    return `Never started; queued for ${runnerDuration(end - created)}.`
  return null
}

/** The output files of a record, as many as fit, then how many were left out. */
function filesSection(files: Array<{ path: string; size: number }>): string {
  const lines: string[] = []
  let chars = 0
  for (const file of files.slice(0, FILES_LISTED_MAX)) {
    const line = `- ${file.path} (${size(file.size)})`
    if (chars + line.length + 1 > FILES_CHARS_MAX) break
    lines.push(line)
    chars += line.length + 1
  }
  const more = files.length - lines.length
  if (more > 0) lines.push(`and ${more} more`)
  return lines.join('\n')
}

/** The last `max` characters of a log, from the start of a line when one fits, never splitting a surrogate pair. */
function lastChars(log: string, max: number): { text: string; cut: boolean } {
  if (log.length <= max) return { text: log, cut: false }
  let start = log.length - Math.max(0, max)
  const code = log.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  const newline = log.indexOf('\n', start)
  // A line cut in the middle is dropped when the rest still holds something.
  if (newline !== -1 && newline + 1 < log.length && log[start - 1] !== '\n') start = newline + 1
  return { text: log.slice(start), cut: true }
}

/** A fence longer than any run of backticks in the log, so the log can never close it. */
function fenceFor(log: string): string {
  let longest = 0
  for (const run of log.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * What the conversation that submitted a job reads once the job ended: its state, error, exit code, duration, runner,
 * folder, the output files that came back and the end of its log. It never exceeds `FLEET_MESSAGE_TEXT_MAX`: the
 * header and the list of files are bounded first, and the log tail takes what is left, cut from its start.
 *
 * `from` names the conversation that submitted the job when the result goes to another one because that one is gone.
 */
export function runnerContinuationText(input: {
  record: Pick<RunnerJobRecord, 'folder' | 'outputs'>
  job: FleetRunnerJob
  log: string
  from?: string
}): string {
  const { record, job } = input
  const head = [
    headline(job),
    ...(input.from ? [`It was submitted from ${input.from}, which no longer exists, so the result comes here.`] : []),
    ...(job.runnerName ? [`Runner: ${job.runnerName}.`] : []),
    ...(job.exitCode !== null ? [`Exit code: ${job.exitCode}.`] : []),
    ...(job.error ? [`Error ${job.error.code}: ${job.error.message}`] : []),
    ...(took(job) ? [took(job)!] : []),
    `Folder: ${record.folder}`,
  ]
  const files = record.outputs?.files ?? []
  const sections = [head.join('\n')]
  if (files.length) sections.push(`Output files that came back into the folder:\n${filesSection(files)}`)
  else if (job.state === 'succeeded' || job.state === 'failed')
    sections.push('No output files came back into the folder.')
  const before = sections.join('\n\n')
  const log = input.log.replace(/\s+$/, '')
  if (!log) return before
  // Room for the text before it, the log's own heading, and a fence on each side, with a margin for the fence's length.
  const fence = fenceFor(log)
  const frame = `\n\nEnd of the log (the last lines the job wrote):\n${fence}\n\n${fence}`.length + LOG_CUT.length + 1
  const room = FLEET_MESSAGE_TEXT_MAX - before.length - frame
  if (room < 200) return before
  const { text, cut } = lastChars(log, Math.min(room, FLEET_RUNNER_TRANSFER_LIMITS.logTailBytes))
  const tail = `${cut ? `${LOG_CUT}\n` : ''}${text}`
  return `${before}\n\nEnd of the log (the last lines the job wrote):\n${fence}\n${tail}\n${fence}`
}
