import { createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import tar from 'tar-stream'
import yauzl from 'yauzl'
import type { ArchiveFormat } from './registry'

export interface ExtractOptions {
  readonly stripPrefix?: string
  readonly signal?: AbortSignal
}

function safeOutput(root: string, rawName: string, stripPrefix?: string): string | null {
  if (
    rawName.includes('\\') ||
    rawName.includes('\0') ||
    rawName.includes(':') ||
    path.posix.isAbsolute(rawName) ||
    /^[A-Za-z]:/.test(rawName)
  ) {
    throw new Error(`Unsafe archive path: ${rawName}`)
  }
  const normalized = rawName.replace(/\/$/, '')
  if (
    !normalized ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..' || /[ .]$/.test(part))
  ) {
    throw new Error(`Unsafe archive path: ${rawName}`)
  }
  let relative = normalized
  if (stripPrefix) {
    const prefix = stripPrefix.replace(/\/$/, '')
    if (relative === prefix) return null
    if (!relative.startsWith(`${prefix}/`)) return null
    relative = relative.slice(prefix.length + 1)
  }
  if (!relative || relative.split('/').some((part) => part === '..' || part === '.' || !part)) {
    throw new Error(`Unsafe archive path: ${rawName}`)
  }
  const destination = path.resolve(root)
  const output = path.resolve(destination, relative)
  // Enforce containment on the final path as well as validating archive entry components.
  if (!output.startsWith(destination + path.sep)) throw new Error(`Unsafe archive path: ${rawName}`)
  return output
}

async function exclusiveFileStream(file: string, mode?: number) {
  await mkdir(path.dirname(file), { recursive: true })
  const handle = await open(file, 'wx', mode)
  return handle.createWriteStream()
}

export async function extractTarGz(archive: string, destination: string, options: ExtractOptions = {}): Promise<void> {
  await mkdir(destination, { recursive: true })
  const extract = tar.extract()
  let files = 0
  let entryError: Error | null = null
  extract.on('entry', (header, stream, next) => {
    void (async () => {
      try {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('Cancelled')
        const output = safeOutput(destination, header.name, options.stripPrefix)
        if (!output) {
          stream.resume()
          await new Promise<void>((resolve, reject) => stream.once('end', resolve).once('error', reject))
          return
        }
        if (header.type === 'directory') {
          await mkdir(output, { recursive: true })
          stream.resume()
          return
        }
        if (header.type !== 'file') throw new Error(`Unsupported tar entry type ${header.type}: ${header.name}`)
        const out = await exclusiveFileStream(output, header.mode ? header.mode & 0o777 : undefined)
        await pipeline(stream, out, { signal: options.signal })
        files++
      } catch (error) {
        entryError = error instanceof Error ? error : new Error(String(error))
        stream.resume()
      } finally {
        next(entryError ?? undefined)
      }
    })()
  })
  await pipeline(createReadStream(archive), createGunzip(), extract, { signal: options.signal })
  if (entryError) throw entryError
  if (files === 0) throw new Error('Archive contained no regular files')
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('Could not open zip'))
      else resolve(zip)
    })
  })
}

function zipEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`Could not read ${entry.fileName}`))
      else resolve(stream)
    })
  )
}

export async function extractZip(archive: string, destination: string, options: ExtractOptions = {}): Promise<void> {
  await mkdir(destination, { recursive: true })
  const zip = await openZip(archive)
  let files = 0
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => {
        zip.close()
        reject(error)
      }
      zip.once('error', fail)
      zip.once('end', resolve)
      zip.on('entry', (entry) => {
        void (async () => {
          try {
            if (options.signal?.aborted) throw options.signal.reason ?? new Error('Cancelled')
            const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
            const kind = unixMode & 0o170000
            if (kind && kind !== 0o100000 && kind !== 0o040000) {
              throw new Error(`Unsupported zip entry type: ${entry.fileName}`)
            }
            const directory = entry.fileName.endsWith('/') || kind === 0o040000
            const output = safeOutput(destination, entry.fileName, options.stripPrefix)
            if (!output) {
              zip.readEntry()
              return
            }
            if (directory) {
              await mkdir(output, { recursive: true })
            } else {
              const input = await zipEntryStream(zip, entry)
              const out = await exclusiveFileStream(output, unixMode ? unixMode & 0o777 : undefined)
              await pipeline(input, out, { signal: options.signal })
              files++
            }
            zip.readEntry()
          } catch (error) {
            fail(error)
          }
        })()
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
  if (files === 0) throw new Error('Archive contained no regular files')
}

export async function extractArchive(
  archive: string,
  destination: string,
  format: ArchiveFormat,
  options: ExtractOptions = {}
): Promise<void> {
  return format === 'tar.gz' ? extractTarGz(archive, destination, options) : extractZip(archive, destination, options)
}
