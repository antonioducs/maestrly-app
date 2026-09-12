import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import type { RuntimeAssetTarget } from './registry'

export interface DownloadResult {
  readonly bytes: number
  readonly digest: string
  readonly finalUrl: string
}
export interface DownloadOptions {
  readonly signal: AbortSignal
  readonly onProgress?: (bytes: number, total?: number) => void
}
export type RuntimeDownloader = (
  target: RuntimeAssetTarget,
  destination: string,
  options: DownloadOptions
) => Promise<DownloadResult>

const DEFAULT_HOSTS = new Set(['registry.npmjs.org', 'persistent.oaistatic.com'])

export function createHttpsDownloader(
  dependencies: {
    readonly fetch?: typeof fetch
    readonly allowedHosts?: ReadonlySet<string>
    readonly maxRedirects?: number
  } = {}
): RuntimeDownloader {
  const fetchImpl = dependencies.fetch ?? fetch
  const hosts = dependencies.allowedHosts ?? DEFAULT_HOSTS
  const maxRedirects = dependencies.maxRedirects ?? 5
  return async (target, destination, options) => {
    let url = target.url
    let response: Response | null = null
    for (let redirect = 0; redirect <= maxRedirects; redirect++) {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname))
        throw new Error(`Download URL is not allowed: ${url}`)
      response = await fetchImpl(url, { signal: options.signal, redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      if (!location) throw new Error(`Redirect without Location: ${url}`)
      url = new URL(location, url).href
      response = null
    }
    if (!response) throw new Error(`Too many redirects downloading ${target.url}`)
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`)
    const maxBytes = target.maxDownloadBytes
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new Error(`Invalid maximum download size for ${target.id}: ${maxBytes}`)
    const contentLengthHeader = response.headers.get('content-length')
    const totalHeader = contentLengthHeader === null ? undefined : Number(contentLengthHeader)
    if (totalHeader !== undefined && totalHeader > maxBytes)
      throw new Error(`Download exceeds maximum allowed size of ${maxBytes} bytes`)
    const total =
      totalHeader !== undefined && Number.isSafeInteger(totalHeader) && totalHeader >= 0 ? totalHeader : undefined
    const hash = createHash(target.hash.algorithm)
    let bytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (bytes + chunk.length > maxBytes) {
          callback(new Error(`Download exceeds maximum allowed size of ${maxBytes} bytes`))
          return
        }
        hash.update(chunk)
        bytes += chunk.length
        options.onProgress?.(bytes, total)
        callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(destination, { flags: 'wx' }), {
      signal: options.signal,
    })
    const digest = hash.digest(target.hash.encoding)
    return { bytes, digest, finalUrl: url }
  }
}

/** Resolve only registry-owned bundle names; local archives use the same hash/size checks as HTTPS. */
export function createBundledRuntimeDownloader(directory: string): RuntimeDownloader {
  const https = createHttpsDownloader()
  return async (target, destination, options) => {
    if (!target.url.startsWith('bundled:')) return https(target, destination, options)
    const name = target.url.slice('bundled:'.length)
    if (!/^local-ml-runtime-[a-zA-Z0-9.-]+\.tar\.gz$/.test(name)) {
      throw new Error('Invalid bundled runtime archive name')
    }
    const hash = createHash(target.hash.algorithm)
    let bytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > target.maxDownloadBytes) {
          callback(new Error('Bundled runtime exceeds its declared size'))
          return
        }
        hash.update(chunk)
        options.onProgress?.(bytes, target.downloadBytes)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(
        createReadStream(path.join(directory, name)),
        meter,
        createWriteStream(destination, { flags: 'wx' }),
        { signal: options.signal }
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          'Local ML archive is missing. Run node scripts/build-local-ml-runtime.mjs before building the app.'
        )
      }
      throw error
    }
    return { bytes, digest: hash.digest(target.hash.encoding), finalUrl: target.url }
  }
}
