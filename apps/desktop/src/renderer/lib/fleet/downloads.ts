import {
  FLEET_ATTENDED_FILES_MAX,
  type FleetDownloadFileKey,
  type FleetDownloadProgress,
} from '../../../shared/fleet-downloads'
import type { FleetServerId } from '../../../shared/fleet-servers'

type Translate = (key: string, options?: Record<string, unknown>) => string

const scale = (bytes: number) =>
  bytes >= 1024 * 1024
    ? ({ unit: 'megabyte', divisor: 1024 * 1024 } as const)
    : bytes >= 1024
      ? ({ unit: 'kilobyte', divisor: 1024 } as const)
      : ({ unit: 'byte', divisor: 1 } as const)

/** `like` picks the unit, so a part reads in the same unit as its whole: "0 MB of 80 MB". */
export function fileSizeLabel(bytes: number, locale: string, like = bytes): string {
  const { unit, divisor } = scale(like)
  return new Intl.NumberFormat(locale, { style: 'unit', unit, maximumFractionDigits: 1 }).format(bytes / divisor)
}

function speedLabel(bytesPerSecond: number, locale: string): string {
  const { unit, divisor } = scale(bytesPerSecond)
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: `${unit}-per-second`,
    maximumFractionDigits: 1,
  }).format(bytesPerSecond / divisor)
}

function durationLabel(seconds: number, locale: string): string {
  const [value, unit]: [number, string] =
    seconds < 60
      ? [Math.max(1, Math.ceil(seconds)), 'second']
      : seconds < 3600
        ? [Math.ceil(seconds / 60), 'minute']
        : [Math.round(seconds / 360) / 10, 'hour']
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(
    value
  )
}

/** "32.4 MB of 80 MB · 4.1 MB/s · ~12 sec left": the speed once measurable, the time left while bytes arrive. */
export function downloadStatusLabel(
  progress: Pick<FleetDownloadProgress, 'receivedBytes' | 'totalBytes' | 'bytesPerSecond'>,
  locale: string,
  t: Translate
): string {
  const { receivedBytes, totalBytes, bytesPerSecond } = progress
  const parts = [
    t('files.progress', {
      received: fileSizeLabel(receivedBytes, locale, totalBytes),
      total: fileSizeLabel(totalBytes, locale),
    }),
  ]
  if (bytesPerSecond === 0) parts.push(t('files.stalled'))
  else if (bytesPerSecond !== null) {
    parts.push(speedLabel(bytesPerSecond, locale))
    const remaining = totalBytes - receivedBytes
    if (remaining > 0) parts.push(t('files.remaining', { time: durationLabel(remaining / bytesPerSecond, locale) }))
  }
  return parts.join(' · ')
}

const attended = new Map<string, FleetDownloadFileKey & { views: number }>()
let reporting: ReturnType<typeof setTimeout> | null = null

function report(): void {
  if (reporting) return
  reporting = setTimeout(() => {
    reporting = null
    const files = [...attended.values()]
      .slice(0, FLEET_ATTENDED_FILES_MAX)
      .map(({ serverId, botId, fileId }) => ({ serverId, botId, fileId }))
    // Without this list main only notifies more often; it never blocks a download.
    void window.api.fleetAttendDownloads(files).catch(() => undefined)
  }, 0)
}

/** Tells main this window shows the file, until the returned function runs; one report per render batch. */
export function attendFleetFile(serverId: FleetServerId, botId: string, fileId: string): () => void {
  const key = serverId + '\n' + botId + '\n' + fileId
  const entry = attended.get(key) ?? { serverId, botId, fileId, views: 0 }
  entry.views++
  attended.set(key, entry)
  report()
  return () => {
    if (--entry.views === 0 && attended.get(key) === entry) attended.delete(key)
    report()
  }
}
