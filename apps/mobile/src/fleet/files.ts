import {
  FLEET_FILES_MANAGE_FEATURE,
  fleetFileQuotaBytes,
  type FleetBot,
  type FleetFilesUsage,
  type FleetPublishedFile,
} from '@maestrly/bot-fleet-protocol'

const KIB = 1024
const MIB = KIB * 1024
const GIB = MIB * 1024
export const FILES_FULL_FREE_BYTES = 10 * MIB
export const FILES_NEAR_RATIO = 0.85
export const FILES_NEAR_LEFT = 20
/** Rows the Files sheet shows before "Show more". */
export const FILES_PAGE = 20
export const FILE_QUOTA_OPTIONS_GB = [1, 2, 5, 10, 20] as const

/** The server and the bot both list, delete and size the files the bot shared (`files-manage`). */
export function filesManageSupported(features: readonly string[], bot: FleetBot): boolean {
  return features.includes(FLEET_FILES_MANAGE_FEATURE) && bot.capabilities.includes(FLEET_FILES_MANAGE_FEATURE)
}

export type FilesLevel = 'ok' | 'near' | 'full'
export function filesSpaceLevel(usage: FleetFilesUsage): FilesLevel {
  if (usage.quotaBytes - usage.usedBytes < FILES_FULL_FREE_BYTES) return 'full'
  return usage.usedBytes / usage.quotaBytes >= FILES_NEAR_RATIO ? 'near' : 'ok'
}
export function filesCountLevel(usage: FleetFilesUsage): FilesLevel {
  const left = usage.countMax - usage.count
  return left <= 0 ? 'full' : left <= FILES_NEAR_LEFT ? 'near' : 'ok'
}
export function filesLevel(usage: FleetFilesUsage | null | undefined): FilesLevel {
  if (!usage) return 'ok'
  const levels = [filesSpaceLevel(usage), filesCountLevel(usage)]
  return levels.includes('full') ? 'full' : levels.includes('near') ? 'near' : 'ok'
}
/** How full the bot is: whichever of its space and its count of files is closer to the limit. */
export function filesShare(usage: FleetFilesUsage): number {
  const space = usage.quotaBytes ? usage.usedBytes / usage.quotaBytes : 1
  const count = usage.countMax ? usage.count / usage.countMax : 1
  return Math.min(1, Math.max(space, count))
}
/** The newer of the list's reading of the space (fresh after a deletion) and the bot's status (after a share). */
export function freshestUsage(a?: FleetFilesUsage | null, b?: FleetFilesUsage | null): FleetFilesUsage | null {
  if (!a || !b) return a ?? b ?? null
  const time = (usage: FleetFilesUsage) => (usage.updatedAt ? Date.parse(usage.updatedAt) : Number.NEGATIVE_INFINITY)
  return time(b) > time(a) ? b : a
}

export type FileCategory = 'video' | 'image' | 'document' | 'archive'
export const FILE_CATEGORIES: readonly FileCategory[] = ['video', 'image', 'document', 'archive']
export function fileCategory(file: { name: string; mediaType: string }): FileCategory {
  if (file.mediaType.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(file.name)) return 'video'
  if (file.mediaType.startsWith('image/')) return 'image'
  if (/^application\/(zip|gzip)$/.test(file.mediaType) || /\.(zip|gz|tgz|tar|7z)$/i.test(file.name)) return 'archive'
  return 'document'
}

export type FilesScope = 'conversation' | 'bot'
export const FILE_SORTS = ['recent', 'size', 'oldest', 'name'] as const
export type FileSort = (typeof FILE_SORTS)[number]
export interface FilesFilter {
  scope: FilesScope
  query: string
  category: FileCategory | 'all'
  sort: FileSort
}
export function scopedFiles(files: readonly FleetPublishedFile[], scope: FilesScope): FleetPublishedFile[] {
  return scope === 'conversation' ? files.filter((file) => file.origin.kind === 'primary') : [...files]
}
const originTitle = (file: FleetPublishedFile) =>
  file.origin.kind === 'routine' || file.origin.kind === 'thread' ? file.origin.title : ''
export function visibleFiles(
  files: readonly FleetPublishedFile[],
  filter: FilesFilter,
  locale: string
): FleetPublishedFile[] {
  const query = filter.query.trim().toLowerCase()
  const time = (file: FleetPublishedFile) => Date.parse(file.sharedAt)
  const compare: Record<FileSort, (a: FleetPublishedFile, b: FleetPublishedFile) => number> = {
    recent: (a, b) => time(b) - time(a),
    oldest: (a, b) => time(a) - time(b),
    size: (a, b) => b.byteSize - a.byteSize || time(b) - time(a),
    name: (a, b) => a.name.localeCompare(b.name, locale) || time(b) - time(a),
  }
  return scopedFiles(files, filter.scope)
    .filter((file) => filter.category === 'all' || fileCategory(file) === filter.category)
    .filter((file) => !query || `${file.name}\n${originTitle(file)}`.toLowerCase().includes(query))
    .sort(compare[filter.sort])
}

/** Hermes lacks parts of Intl: a failed format falls back to plain decimals. */
function decimals(value: number, digits: number, locale: string, exact = false): string {
  try {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: digits,
      minimumFractionDigits: exact ? digits : 0,
    }).format(value)
  } catch {
    return exact ? value.toFixed(digits) : String(Number(value.toFixed(digits)))
  }
}
/** A size in the bot's space: MB below 1000 MB, then GB with two decimals, so a nearly full 1 GB reads "0.99 GB". */
export function formatSpace(bytes: number, locale: string): string {
  if (bytes < KIB) return `${Math.max(0, Math.round(bytes))} B`
  if (bytes < MIB) return `${Math.max(1, Math.round(bytes / KIB))} KB`
  const mb = bytes / MIB
  if (mb < 10) return `${decimals(mb, 1, locale, true)} MB`
  if (mb < 1000) return `${Math.round(mb)} MB`
  return `${decimals(bytes / GIB, 2, locale)} GB`
}

export type QuotaChoice = 'current' | 'ok' | 'tooSmall' | 'tooLarge'
/** Whether the owner can give the bot `gb` of space: not less than its files take, nor more than the disk has free. */
export function quotaChoice(gb: number, usage: FleetFilesUsage, diskFreeBytes: number | null): QuotaChoice {
  const bytes = fleetFileQuotaBytes(gb)
  if (bytes === usage.quotaBytes) return 'current'
  if (bytes < usage.usedBytes) return 'tooSmall'
  if (diskFreeBytes !== null && bytes - usage.usedBytes > diskFreeBytes) return 'tooLarge'
  return 'ok'
}
