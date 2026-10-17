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

/** A folder's archive is made, or taken apart, while this holds: its bytes are not moving yet, or any more. */
const preparing = (transfer: HostTransferView): boolean =>
  transfer.kind === 'folder' &&
  (transfer.stage === 'packing' || (transfer.stage === 'extracting' && transfer.state !== 'done'))

/** How far a transfer went, in percent; null while a folder is packed or extracted at a pace nobody knows yet. */
export function transferProgress(transfer: HostTransferView): number | null {
  if (preparing(transfer)) {
    if (transfer.stageProgress !== null) return Math.min(100, transfer.stageProgress * 100)
    return transfer.state === 'running' ? null : 0
  }
  return transfer.size ? Math.min(100, (transfer.doneBytes / transfer.size) * 100) : 100
}

export type TransferStageLabel = 'packingRemote' | 'packingLocal' | 'extractingLocal' | 'extractingRemote'

/** What a running folder transfer does besides moving bytes; null when its state says it all. */
export function transferStageLabel(transfer: HostTransferView): TransferStageLabel | null {
  if (transfer.kind !== 'folder') return null
  const download = transfer.direction === 'download'
  if (transfer.state === 'running' && transfer.stage === 'packing') return download ? 'packingRemote' : 'packingLocal'
  if (transfer.state === 'running' && transfer.stage === 'extracting' && download) return 'extractingLocal'
  // An uploaded folder is extracted on the host while it is committed.
  if (transfer.state === 'verifying' && !download) return 'extractingRemote'
  return null
}

/** "done of total · speed · time left", leaving out what is not known yet. */
export function transferDetail(
  transfer: HostTransferView,
  locale: string,
  t: (key: string, values: Record<string, string>) => string
): string {
  if (preparing(transfer)) return transfer.stageProgress === null ? '' : `${Math.round(transfer.stageProgress * 100)}%`
  const parts = [
    t('files.transfers.progress', { done: formatBytes(transfer.doneBytes), total: formatBytes(transfer.size) }),
  ]
  if (transfer.bytesPerSecond) parts.push(`${formatBytes(transfer.bytesPerSecond)}/s`)
  if (transfer.remainingMs !== null)
    parts.push(t('files.transfers.remaining', { time: formatDuration(transfer.remainingMs, locale) }))
  return parts.join(' · ')
}
