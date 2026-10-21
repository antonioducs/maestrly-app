import type { FleetFilesUsage, FleetPublishedFile } from '@maestrly/bot-fleet-protocol'
import { isFleetVideo } from '../../../shared/fleet-media'

type Translate = (key: string, options?: Record<string, unknown>) => string

const MIB = 1024 ** 2
export const FILES_FULL_FREE_BYTES = 10 * MIB
export const FILES_NEAR_RATIO = 0.85
export const FILES_NEAR_LEFT = 20

export const FLEET_FILE_KINDS = ['video', 'image', 'document', 'archive'] as const
export type FleetFileKind = (typeof FLEET_FILE_KINDS)[number]

export function fleetFileKind(file: { name: string; mediaType: string }): FleetFileKind {
  if (isFleetVideo(file)) return 'video'
  if (file.mediaType.startsWith('image/')) return 'image'
  if (
    file.mediaType === 'application/zip' ||
    file.mediaType === 'application/gzip' ||
    /\.(zip|gz|tgz|tar|7z)$/i.test(file.name)
  )
    return 'archive'
  return 'document'
}

export type FilesLevel = 'ok' | 'near' | 'full'

export function filesSpaceLevel(usage: FleetFilesUsage): FilesLevel {
  return usage.quotaBytes - usage.usedBytes < FILES_FULL_FREE_BYTES
    ? 'full'
    : usage.usedBytes / usage.quotaBytes >= FILES_NEAR_RATIO
      ? 'near'
      : 'ok'
}

export function filesCountLevel(usage: FleetFilesUsage): FilesLevel {
  const left = usage.countMax - usage.count
  return left <= 0 ? 'full' : left <= FILES_NEAR_LEFT ? 'near' : 'ok'
}

export function filesLevel(usage: FleetFilesUsage | null): FilesLevel {
  if (!usage) return 'ok'
  const levels = [filesSpaceLevel(usage), filesCountLevel(usage)]
  return levels.includes('full') ? 'full' : levels.includes('near') ? 'near' : 'ok'
}

/** The header meter: whichever of the space and the count is closer to its limit. */
export function filesMeter(usage: FleetFilesUsage): { ratio: number; text: string } {
  const space = usage.quotaBytes ? usage.usedBytes / usage.quotaBytes : 1
  const count = usage.countMax ? usage.count / usage.countMax : 1
  return count > space
    ? { ratio: Math.min(1, count), text: `${usage.count}/${usage.countMax}` }
    : { ratio: Math.min(1, space), text: `${Math.floor(space * 100)}%` }
}

export type FilesConversation =
  | { kind: 'primary' }
  | { kind: 'routine'; runId: string }
  | { kind: 'thread'; threadId: string }

export function sharedIn(file: FleetPublishedFile, conversation: FilesConversation): boolean {
  const origin = file.origin
  if (conversation.kind === 'primary') return origin.kind === 'primary'
  if (conversation.kind === 'routine') return origin.kind === 'routine' && origin.runId === conversation.runId
  return origin.kind === 'thread' && origin.threadId === conversation.threadId
}

export const FILE_SORTS = ['recent', 'size', 'oldest', 'name'] as const
export type FileSort = (typeof FILE_SORTS)[number]

export interface FilesFilter {
  conversation: FilesConversation | null
  query: string
  kind: FleetFileKind | 'all'
  sort: FileSort
}

export function scopedFiles(files: FleetPublishedFile[], conversation: FilesConversation | null): FleetPublishedFile[] {
  return conversation ? files.filter((file) => sharedIn(file, conversation)) : files
}

const originTitle = (file: FleetPublishedFile) =>
  file.origin.kind === 'routine' || file.origin.kind === 'thread' ? file.origin.title : ''

export function visibleFiles(files: FleetPublishedFile[], filter: FilesFilter, locale = 'en'): FleetPublishedFile[] {
  const query = filter.query.trim().toLocaleLowerCase(locale)
  const time = (file: FleetPublishedFile) => Date.parse(file.sharedAt)
  const compare: Record<FileSort, (a: FleetPublishedFile, b: FleetPublishedFile) => number> = {
    recent: (a, b) => time(b) - time(a),
    oldest: (a, b) => time(a) - time(b),
    size: (a, b) => b.byteSize - a.byteSize || time(b) - time(a),
    name: (a, b) => a.name.localeCompare(b.name, locale) || time(b) - time(a),
  }
  return scopedFiles(files, filter.conversation)
    .filter((file) => filter.kind === 'all' || fleetFileKind(file) === filter.kind)
    .filter((file) => !query || `${file.name}\n${originTitle(file)}`.toLocaleLowerCase(locale).includes(query))
    .sort(compare[filter.sort])
}

export const FILES_PAGE_SIZE = 10

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / FILES_PAGE_SIZE))
}

export function clampPage(page: number, total: number): number {
  return Math.min(Math.max(1, page), pageCount(total))
}

export function pageOf<T>(list: readonly T[], page: number): T[] {
  const start = (page - 1) * FILES_PAGE_SIZE
  return list.slice(start, start + FILES_PAGE_SIZE)
}

export function pageNumbers(page: number, pages: number): Array<number | 'gap'> {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1)
  const keep = new Set([1, pages, page - 1, page, page + 1])
  if (page <= 3) for (const n of [2, 3, 4]) keep.add(n)
  if (page >= pages - 2) for (const n of [pages - 3, pages - 2, pages - 1]) keep.add(n)
  const sorted = [...keep].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b)
  return sorted.flatMap((n, index) => (index && n - sorted[index - 1]! > 1 ? (['gap', n] as const) : [n]))
}

export function usageSegments(
  files: FleetPublishedFile[],
  quotaBytes: number
): Array<{ id: string; name: string; kind: FleetFileKind; percent: number; byteSize: number }> {
  return [...files]
    .map((file) => ({
      id: file.id,
      name: file.name,
      kind: fleetFileKind(file),
      percent: quotaBytes > 0 ? (file.byteSize / quotaBytes) * 100 : 0,
      byteSize: file.byteSize,
    }))
    .sort((a, b) => FLEET_FILE_KINDS.indexOf(a.kind) - FLEET_FILE_KINDS.indexOf(b.kind) || b.byteSize - a.byteSize)
}

export function sharedAtLabel(iso: string, now: number, locale: string, t: Translate): string {
  const at = new Date(iso)
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000)
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at)
  if (days <= 0) return t('files.drawer.today', { time })
  if (days === 1) return t('files.drawer.yesterday', { time })
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(at)
}
