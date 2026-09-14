import { constants } from 'node:fs'
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HostError } from '../errors.js'

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077))
    throw new HostError('ACCOUNT_STORAGE', 'O armazenamento privado de contas não está disponível')
}
export async function readPrivate(path: string, maxBytes = 96 * 1024): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > maxBytes)
      throw new HostError('ACCOUNT_STORAGE', 'O armazenamento privado de contas não está disponível')
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxBytes) throw new HostError('ACCOUNT_STORAGE', 'A credencial excede o tamanho permitido')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally { await file.close() }
}
export async function writePrivate(path: string, content: string) {
  await privateDirectory(dirname(path))
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(content); await file.sync() } finally { await file.close() }
  try {
    await rename(temporary, path)
    const directory = await open(dirname(path), constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error }
}
