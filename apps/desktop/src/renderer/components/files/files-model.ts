import type { HostFsRoot } from '../../../shared/host-fs'
import type { HostTransferView } from '../../../shared/host-transfers'
import { formatBytes } from '../chat/runtime-asset-presentation'

/** A host's transfers, newest first. */
export function transfersOfHost(all: readonly HostTransferView[], hostId: string): HostTransferView[] {
  return all
    .filter((transfer) => transfer.hostId === hostId)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

const folderOf = (remotePath: string): string => remotePath.slice(0, remotePath.lastIndexOf('/')) || '/'

/** Whether an upload finished into `folder` between two snapshots of the queue. */
export function uploadsLandedIn(
  before: readonly HostTransferView[],
  after: readonly HostTransferView[],
  folder: string
): boolean {
  const states = new Map(before.map((transfer) => [transfer.id, transfer.state]))
  return after.some(
    (transfer) =>
      transfer.direction === 'upload' &&
      transfer.state === 'done' &&
      states.get(transfer.id) !== 'done' &&
      folderOf(transfer.remotePath) === folder
  )
}

/** Where a host's files open by default: a server's workspaces folder, else the first folder it allows. */
export function defaultRoot(roots: readonly HostFsRoot[]): string | null {
  return roots.find((root) => root.label === 'workspaces')?.path ?? roots[0]?.path ?? null
}

const unit = (locale: string, name: 'second' | 'minute' | 'hour', value: number) =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value)

/** A duration in short units: seconds under a minute, minutes under an hour, then hours and minutes. */
export function formatDuration(ms: number, locale: string): string {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return unit(locale, 'second', seconds)
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return unit(locale, 'minute', minutes)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${unit(locale, 'hour', hours)} ${unit(locale, 'minute', rest)}` : unit(locale, 'hour', hours)
}

/** "done of total · speed · time left", leaving out what is not known yet. */
export function transferDetail(
  transfer: HostTransferView,
  locale: string,
  t: (key: string, values: Record<string, string>) => string
): string {
  const parts = [
    t('files.transfers.progress', { done: formatBytes(transfer.doneBytes), total: formatBytes(transfer.size) }),
  ]
  if (transfer.bytesPerSecond) parts.push(`${formatBytes(transfer.bytesPerSecond)}/s`)
  if (transfer.remainingMs !== null)
    parts.push(t('files.transfers.remaining', { time: formatDuration(transfer.remainingMs, locale) }))
  return parts.join(' · ')
}
