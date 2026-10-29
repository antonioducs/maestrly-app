import type { FleetRunnerCapabilities } from '@maestrly/bot-fleet-protocol'
import { GIB, type RunnerDockerView, RUNNER_SLOTS_MAX, RUNNER_SLOTS_MIN } from '../../shared/runner'

/** How long a job has been going: `m:ss`, and `h:mm:ss` from the first hour. */
export function jobDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const rest = String(seconds % 60).padStart(2, '0')
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${rest}`
  return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${rest}`
}

/** A size in bytes shown and edited in whole gigabytes, at least one; null stays null. */
export const bytesToGb = (bytes: number | null): number | undefined =>
  bytes === null ? undefined : Math.max(1, Math.round(bytes / GIB))
export const gbToBytes = (gigabytes: number): number => Math.round(gigabytes) * GIB

/** The simultaneous jobs a person can choose: 1 to the most a runner takes. */
export const RUNNER_SLOT_CHOICES: readonly number[] = Array.from(
  { length: RUNNER_SLOTS_MAX - RUNNER_SLOTS_MIN + 1 },
  (_, index) => RUNNER_SLOTS_MIN + index
)

/**
 * The installer's own words for Docker's state (`fleet:botServer.local.*`), so that one sentence says the same
 * wherever Docker is asked about.
 */
export function dockerNoticeKey(docker: RunnerDockerView): string {
  if (docker.state !== 'ready') return `botServer.local.${docker.state}`
  return docker.engine ? 'botServer.local.readyEngine' : 'botServer.local.ready'
}

/** The operating systems as people name them. */
export const RUNNER_OS_NAMES: Record<FleetRunnerCapabilities['os'], string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
}
