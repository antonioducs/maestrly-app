import { ArtifactHostError } from './errors.js'
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_VERSION,
  MAX_PATH_CHARS,
  MAX_PATH_SEGMENTS,
  MAX_VERSION_BYTES,
} from './limits.js'

const TEXT = 'charset=utf-8'

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: `text/html; ${TEXT}`,
  htm: `text/html; ${TEXT}`,
  css: `text/css; ${TEXT}`,
  js: `text/javascript; ${TEXT}`,
  mjs: `text/javascript; ${TEXT}`,
  json: `application/json; ${TEXT}`,
  svg: 'image/svg+xml',
  txt: `text/plain; ${TEXT}`,
  md: `text/markdown; ${TEXT}`,
  csv: `text/csv; ${TEXT}`,
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
}

const TEXT_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'md', 'csv'])
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

const extension = (p: string): string => {
  const dot = p.lastIndexOf('.')
  return dot > p.lastIndexOf('/') ? p.slice(dot + 1).toLowerCase() : ''
}

export const contentTypeFor = (p: string): string | null => CONTENT_TYPES[extension(p)] ?? null
export const isTextPath = (p: string): boolean => TEXT_EXTENSIONS.has(extension(p))
export const isHtmlPath = (p: string): boolean => ['html', 'htm'].includes(extension(p))

/** Returns the canonical bundle path or throws; bundle paths are always relative POSIX paths. */
export function normalizeBundlePath(input: string): string {
  const fail = (reason: string) =>
    new ArtifactHostError('invalid_path', `Invalid file path "${input}": ${reason}`, { path: String(input) })
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_PATH_CHARS) throw fail('length')
  const segments = input.split('/')
  if (segments.length > MAX_PATH_SEGMENTS) throw fail('too deep')
  if (!segments.every((s) => SEGMENT.test(s))) throw fail('use letters, digits, ".", "_" and "-" only')
  if (segments[0] === '_maestrly') throw fail('reserved prefix')
  if (!contentTypeFor(input))
    throw new ArtifactHostError('unsupported_type', `Unsupported file type: ${input}`, { path: input })
  return input
}

/** Checks a version's files; only their paths and sizes matter, so stored files can be checked without reading them. */
export function validateBundle(files: readonly { path: string; bytes: { byteLength: number } }[], entry: string): void {
  if (files.length > MAX_FILES_PER_VERSION)
    throw new ArtifactHostError('too_many_files', `At most ${MAX_FILES_PER_VERSION} files per version`)
  const seen = new Set<string>()
  let total = 0
  for (const file of files) {
    const key = file.path.toLowerCase()
    if (seen.has(key))
      throw new ArtifactHostError('duplicate_path', `Duplicate path: ${file.path}`, { path: file.path })
    seen.add(key)
    if (file.bytes.byteLength > MAX_FILE_BYTES)
      throw new ArtifactHostError('file_too_large', `${file.path} exceeds 10 MiB`, { path: file.path })
    total += file.bytes.byteLength
  }
  if (total > MAX_VERSION_BYTES) throw new ArtifactHostError('bundle_too_large', 'A version cannot exceed 50 MiB')
  if (!files.some((f) => f.path === entry))
    throw new ArtifactHostError('missing_entry', `The entry file ${entry} is not in the bundle`, { path: entry })
  if (!isHtmlPath(entry)) throw new ArtifactHostError('entry_not_html', 'The entry file must be HTML', { path: entry })
}
