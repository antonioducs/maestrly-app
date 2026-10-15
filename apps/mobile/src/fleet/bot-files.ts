import type { FleetFileRef } from '@maestrly/bot-fleet-protocol'

export type BotFileKind = 'video' | 'image' | 'other'

const PLAYABLE = new Set(['video/mp4', 'video/x-m4v', 'video/quicktime'])
const VIDEO_EXTENSIONS: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}
const IMAGE = /^image\/(png|jpeg|gif|webp)$/

const extension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * How the phone shows a file a bot shared: a video it can play in the conversation, an image, or a file to save.
 * Bots from before video types were known send videos as `application/octet-stream`, so their extension still
 * counts, as on the desktop. iOS cannot decode WebM.
 */
export function fileKind(file: Pick<FleetFileRef, 'name' | 'mediaType'>, os: string): BotFileKind {
  const declared = file.mediaType.toLowerCase()
  const type = declared === 'application/octet-stream' ? (VIDEO_EXTENSIONS[extension(file.name)] ?? declared) : declared
  if (PLAYABLE.has(type) || (type === 'video/webm' && os === 'android')) return 'video'
  if (IMAGE.test(type)) return 'image'
  return 'other'
}

const NAME_MAX = 120
const safe = (value: string) => value.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '')

/**
 * Where a shared file is kept in the app's cache, relative to it: one folder per server, bot and file, so two files
 * with one name never meet, and a name that cannot leave its folder.
 */
export function cachedFilePath(serverId: string, botId: string, fileId: string, name: string): string {
  const file = safe(name).slice(-NAME_MAX) || 'file'
  return ['bot-files', safe(serverId) || 'server', safe(botId) || 'bot', safe(fileId) || 'id', file].join('/')
}
