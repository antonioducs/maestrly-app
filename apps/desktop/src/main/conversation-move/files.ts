import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { attachmentConversationDir } from '../chat/attachment-artifacts'
import { generatedImageConversationDir } from '../chat/generated-images'
import { hashFile } from '../transfer-io'
import { MoveError } from './errors'
import { exactRelative, type MovePackageEntry, type MovePackageSource, type MoveFileKind } from './package'

/**
 * The files a conversation owns outside SQLite: attachments and generated images in the profile, and its notebook in
 * its checkout (relative to `<cwd>/.agents`). Ignored files the person selected travel with them, relative to the cwd.
 */
const AGENTS_DIR = '.agents'
const NOTES = 'notes'
const LEGACY_NOTES = 'notes.md'
/** The kinds a conversation owns; what both ends hash to prove a move. */
export const OWNED_FILE_KINDS: ReadonlySet<MoveFileKind> = new Set(['attachment', 'generated-image', 'note'])

export interface CollectedFiles {
  sources: MovePackageSource[]
  stats: { files: number; fileBytes: number }
}

const isEphemeral = (name: string): boolean => name.startsWith('.') || name.endsWith('.tmp')

async function regularFiles(dir: string, prefix: string, recursive: boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!entries) return []
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    // lstat-based: links and special files never travel.
    if (entry.isFile()) out.push(relative)
    else if (recursive && entry.isDirectory())
      out.push(...(await regularFiles(path.join(dir, entry.name), relative, true)))
  }
  return out
}

async function notebookFiles(cwd: string): Promise<string[]> {
  const agents = path.join(cwd, AGENTS_DIR)
  const out: string[] = []
  const notes = await lstat(path.join(agents, NOTES)).catch(() => null)
  if (notes?.isDirectory()) out.push(...(await regularFiles(path.join(agents, NOTES), NOTES, true)))
  const legacy = await lstat(path.join(agents, LEGACY_NOTES)).catch(() => null)
  if (legacy?.isFile()) out.push(LEGACY_NOTES)
  return out
}

async function ownedSources(conversationId: string, cwd: string): Promise<MovePackageSource[]> {
  const sources: MovePackageSource[] = []
  for (const [kind, dir] of [
    ['attachment', attachmentConversationDir(conversationId)],
    ['generated-image', generatedImageConversationDir(conversationId)],
  ] as const) {
    for (const name of await regularFiles(dir, '', false)) {
      if (!isEphemeral(name)) sources.push({ kind, relative: name, absolute: path.join(dir, name) })
    }
  }
  for (const relative of await notebookFiles(cwd))
    sources.push({ kind: 'note', relative, absolute: path.join(cwd, AGENTS_DIR, relative) })
  return sources
}

async function ignoredSources(cwd: string, selected: string[]): Promise<MovePackageSource[]> {
  const sources: MovePackageSource[] = []
  for (const raw of selected) {
    const relative = exactRelative(raw)
    if (!relative) throw new MoveError('package-invalid', `Unsafe ignored path: ${raw}`)
    const absolute = path.join(cwd, relative)
    const info = await lstat(absolute)
    if (info.isFile()) sources.push({ kind: 'ignored', relative, absolute })
    else if (info.isDirectory()) {
      for (const inner of await regularFiles(absolute, relative, true))
        sources.push({ kind: 'ignored', relative: inner, absolute: path.join(cwd, inner) })
    } else throw new MoveError('package-invalid', `${relative} is not a regular file or folder.`)
  }
  return sources
}

export async function collectConversationFiles(args: {
  conversationId: string
  cwd: string
  selectedIgnoredPaths: string[]
}): Promise<CollectedFiles> {
  const owned = await ownedSources(args.conversationId, args.cwd)
  let fileBytes = 0
  for (const source of owned) fileBytes += (await lstat(source.absolute)).size
  const ignored = await ignoredSources(args.cwd, args.selectedIgnoredPaths)
  return { sources: [...owned, ...ignored], stats: { files: owned.length, fileBytes } }
}

/** The conversation-owned files as they are now, hashed: what verification compares with the export. */
export async function hashConversationFiles(
  conversationId: string,
  cwd: string
): Promise<Array<{ kind: MoveFileKind; relative: string; sha256: string }>> {
  const out: Array<{ kind: MoveFileKind; relative: string; sha256: string }> = []
  for (const source of await ownedSources(conversationId, cwd))
    out.push({ kind: source.kind, relative: source.relative, sha256: await hashFile(source.absolute) })
  return out
}

function restoreTarget(
  conversationId: string,
  cwd: string,
  kind: MoveFileKind,
  relative: string
): { root: string; file: string } {
  switch (kind) {
    case 'attachment':
      return { root: attachmentConversationDir(conversationId), file: relative }
    case 'generated-image':
      return { root: generatedImageConversationDir(conversationId), file: relative }
    case 'note':
      return { root: path.join(cwd, AGENTS_DIR), file: relative }
    case 'ignored':
      return { root: cwd, file: relative }
    case 'bundle':
      throw new MoveError('package-invalid', 'A bundle is not a conversation file.')
  }
}

async function copyExclusive(from: string, root: string, relative: string, mode: number): Promise<void> {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  // A folder inside the destination checkout may be a link; nothing is written through one.
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(path.dirname(target))])
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep))
    throw new MoveError('package-invalid', `${relative} would be written outside its folder.`)
  try {
    // COPYFILE_EXCL: never replaces what the destination already holds, a link included.
    await copyFile(from, target, fsConstants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new MoveError('package-invalid', `${relative} already exists at the destination.`)
    throw error
  }
  await chmod(target, mode & 0o777)
}

export async function restoreConversationFiles(args: {
  conversationId: string
  cwd: string
  files: Array<MovePackageEntry & { absolute: string }>
}): Promise<void> {
  for (const file of args.files) {
    if (file.kind === 'bundle') continue
    const relative = exactRelative(file.relative)
    if (!relative) throw new MoveError('package-invalid', `Unsafe path: ${file.relative}`)
    if (file.kind === 'note' && relative !== LEGACY_NOTES && !relative.startsWith(`${NOTES}/`))
      throw new MoveError('package-invalid', `Unexpected note path: ${relative}`)
    if ((file.kind === 'attachment' || file.kind === 'generated-image') && relative.includes('/'))
      throw new MoveError('package-invalid', `Unexpected ${file.kind} path: ${relative}`)
    const { root, file: inner } = restoreTarget(args.conversationId, args.cwd, file.kind, relative)
    await mkdir(root, { recursive: true })
    await copyExclusive(file.absolute, root, inner, file.mode)
  }
}

/** Removes the profile files an import restored; the checkout's files go with its worktree. */
export async function removeRestoredConversationFiles(conversationId: string): Promise<void> {
  await rm(attachmentConversationDir(conversationId), { recursive: true, force: true })
  await rm(generatedImageConversationDir(conversationId), { recursive: true, force: true })
}
