import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import tar from 'tar-stream'

/** Extract only portable regular files/directories into a private, freshly created staging directory. */
export async function extractLocalMlArchive(archive, destination) {
  const root = path.resolve(destination)
  await mkdir(root, { recursive: true })
  const extract = tar.extract()
  extract.on('entry', (header, stream, next) => {
    void (async () => {
      const name = header.name.replace(/\/$/, '')
      // Validate both separator conventions even when the current host is POSIX.
      if (
        /[\\\0:]/.test(name) ||
        path.posix.isAbsolute(name) ||
        name.split('/').some((part) => !part || part === '.' || part === '..' || /[ .]$/.test(part))
      )
        throw new Error(`Unsafe archive entry: ${header.name}`)
      const output = path.resolve(root, name)
      if (!output.startsWith(root + path.sep)) throw new Error(`Unsafe archive entry: ${header.name}`)
      if (header.type === 'directory') {
        await mkdir(output, { recursive: true })
        stream.resume()
      } else if (header.type === 'file') {
        await mkdir(path.dirname(output), { recursive: true })
        // Links are rejected below and duplicate files must not replace earlier contents.
        await pipeline(stream, createWriteStream(output, { flags: 'wx', mode: header.mode & 0o777 }))
      } else {
        throw new Error(`Unsupported archive entry: ${header.name} (${header.type})`)
      }
    })().then(
      () => next(),
      (error) => {
        stream.resume()
        next(error)
      }
    )
  })
  // Propagate input/gzip errors too, and tear down every stream on failure.
  await pipeline(createReadStream(archive), createGunzip(), extract)
}
