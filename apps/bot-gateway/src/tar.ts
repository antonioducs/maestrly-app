import type { HelperFile } from './docker.js'

const BLOCK = 512
const SEGMENT = /^[A-Za-z0-9._-]+$/

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}
function header(name: string, type: '0' | '5', mode: number, size: number, mtime: Date): Buffer {
  const block = Buffer.alloc(BLOCK)
  if (Buffer.byteLength(name) > 100) throw new Error('Archive entry name too long')
  block.write(name, 0, 100, 'utf8')
  block.write(octal(mode & 0o7777, 8), 100, 8, 'ascii')
  block.write(octal(1000, 8), 108, 8, 'ascii')
  block.write(octal(1000, 8), 116, 8, 'ascii')
  block.write(octal(size, 12), 124, 12, 'ascii')
  block.write(octal(Math.max(0, Math.floor(mtime.getTime() / 1000)), 12), 136, 12, 'ascii')
  block.fill(' ', 148, 156)
  block.write(type, 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write('bot', 265, 32, 'ascii')
  block.write('bot', 297, 32, 'ascii')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return block
}
function segments(path: string): string[] {
  const parts = path.split('/')
  if (!parts.length || parts.some((part) => !SEGMENT.test(part) || part === '.' || part === '..'))
    throw new Error('Invalid archive entry path')
  return parts
}

/**
 * A ustar archive of `files` for Docker to extract at `/` of a container: each file, with a directory entry (0700)
 * before it for every parent not listed yet, all owned by uid and gid 1000 so the container's user can read them.
 */
export function tarFiles(files: HelperFile[], mtime = new Date(0)): Buffer {
  const blocks: Buffer[] = []
  const directories = new Set<string>()
  for (const file of files) {
    const parts = segments(file.path)
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join('/') + '/'
      if (directories.has(directory)) continue
      directories.add(directory)
      blocks.push(header(directory, '5', 0o700, 0, mtime))
    }
    const content = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content
    blocks.push(header(file.path, '0', file.mode, content.length, mtime), content)
    const padding = (BLOCK - (content.length % BLOCK)) % BLOCK
    if (padding) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(blocks)
}
