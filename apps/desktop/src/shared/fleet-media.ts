/** Scheme that serves bot videos from the main process's disk cache; the renderer never gets the gateway token. */
export const FLEET_MEDIA_SCHEME = 'maestrly-media'

const videoExtensions: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * The media type to play a shared file as, or null when it is not a video. Bots from before video types were known
 * publish videos as `application/octet-stream`, so their extension still counts.
 */
export function fleetVideoMediaType(file: { name: string; mediaType: string }): string | null {
  const type = file.mediaType.toLowerCase()
  if (/^video\/[a-z0-9!#$&^_.+-]+$/.test(type)) return type
  if (type !== 'application/octet-stream') return null
  return videoExtensions[extension(file.name)] ?? null
}

export function isFleetVideo(file: { name: string; mediaType: string }): boolean {
  return fleetVideoMediaType(file) !== null
}
