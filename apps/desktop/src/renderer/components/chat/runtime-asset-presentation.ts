import type { RuntimeAssetInfo, RuntimeAssetUpdateState } from '../../../shared/runtime-assets'

export function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`
}

export function assetProgress(asset: RuntimeAssetInfo): number {
  const total = asset.status.totalBytes || asset.downloadBytes
  return total > 0 ? Math.min(100, ((asset.status.bytesDownloaded ?? 0) / total) * 100) : 0
}

const ACTIVE_UPDATE_STATES: ReadonlySet<RuntimeAssetUpdateState> = new Set([
  'checking',
  'downloading',
  'verifying',
  'installing',
  'validating',
  'rolling-back',
])

export function isRuntimeAssetUpdateActive(state: RuntimeAssetUpdateState): boolean {
  return ACTIVE_UPDATE_STATES.has(state)
}

/** Download progress of an independent update; later phases render as a full bar. */
export function updateProgress(asset: RuntimeAssetInfo): number {
  const update = asset.update
  if (!update) return 0
  if (update.state !== 'downloading') return update.state === 'checking' ? 0 : 100
  const total = update.totalBytes ?? 0
  return total > 0 ? Math.min(100, ((update.bytesDownloaded ?? 0) / total) * 100) : 0
}

export function formatCheckedAt(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(date)
}
