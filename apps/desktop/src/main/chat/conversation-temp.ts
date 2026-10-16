import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Each conversation gets its own temporary directory, given to its shells, terminals and runtimes as TMPDIR/TMP/TEMP,
 * and removed when the conversation is deleted. What a conversation's tools and tests write to the system's temporary
 * folder then goes with it.
 *
 * The directory sits in a root the profile owns: `<tmp>/maestrly-<uid>-<hash of the profile path>`, made 0700 and
 * refused unless it is a real directory of this user that nobody else can open (as tmux does with its socket folder).
 * Entries are named after the conversation id, so only Maestrly's own names inside its own root are ever removed.
 *
 * The path stays short on purpose: Chromium puts its singleton socket about 34 characters below TMPDIR, and a Unix
 * socket path holds 104 bytes on macOS and 108 on Linux. An Electron app started from a conversation with a longer
 * TMPDIR aborts ("Socket path too long").
 */

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENTRY_NAME = /^[0-9a-f]{16}$/
export const MAX_CONVERSATION_TEMP_PATH = 64

export const CONVERSATION_TEMP_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const
export type ConversationTempEnv = Partial<Record<(typeof CONVERSATION_TEMP_ENV_KEYS)[number], string>>

/** The entry of a conversation: the first 16 hex digits of its id. Null for ids that are not UUIDs. */
export function conversationTempEntryName(conversationId: string): string | null {
  if (!CONVERSATION_ID.test(conversationId)) return null
  return conversationId.replace(/-/g, '').slice(0, 16).toLowerCase()
}

export interface ConversationTempRootInput {
  /** The profile directory, already resolved through symlinks. */
  userData: string
  tmpdir: string
  uid: number | null
  platform: NodeJS.Platform
}

/** The profile's root, under the system's temporary folder, or `/tmp` when that one is too deep for a socket. */
export function conversationTempRootPath(input: ConversationTempRootInput): string {
  const hash = createHash('sha256').update(input.userData).digest('hex').slice(0, 8)
  const name = input.platform === 'win32' || input.uid === null ? `maestrly-${hash}` : `maestrly-${input.uid}-${hash}`
  const join = input.platform === 'win32' ? path.win32.join : path.posix.join
  const preferred = join(input.tmpdir, name)
  if (input.platform === 'win32' || join(preferred, '0'.repeat(16)).length <= MAX_CONVERSATION_TEMP_PATH)
    return preferred
  return path.posix.join('/tmp', name)
}

let root: string | null = null
let warned = false

function warn(message: string, detail?: unknown): void {
  if (warned) return
  warned = true
  console.warn(
    JSON.stringify({
      component: 'conversation-temp',
      level: 'warn',
      message,
      ...(detail instanceof Error ? { error: detail.message } : {}),
    })
  )
}

/** Turns the per-conversation directories on for this profile. Until then conversations keep the process TMPDIR. */
export function initConversationTemp(userData: string): void {
  let resolved = userData
  try {
    resolved = realpathSync(userData)
  } catch {
    // A profile that does not exist yet keeps the given path.
  }
  root = conversationTempRootPath({
    userData: resolved,
    tmpdir: os.tmpdir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    platform: process.platform,
  })
  warned = false
}

/** Test seam: a root to use as is, or null to turn the feature off. */
export function __setConversationTempRootForTests(next: string | null): void {
  root = next
  warned = false
}

/** A real directory of this user that nobody else can open; elsewhere than POSIX only a real directory. */
function trustedDirectory(stats: Stats): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) return false
  if (process.platform === 'win32') return true
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) return false
  return (stats.mode & 0o077) === 0
}

function ensureRoot(): string | null {
  if (!root) return null
  try {
    mkdirSync(root, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      warn('Could not create the temporary root of conversations; they keep the system temporary folder', error)
      return null
    }
  }
  try {
    if (trustedDirectory(lstatSync(root))) return root
  } catch (error) {
    warn('Could not inspect the temporary root of conversations', error)
    return null
  }
  warn('The temporary root of conversations is not a private directory of this user; it is not used')
  return null
}

/** The conversation's directory, created when missing; null when it has none (see initConversationTemp). */
export function conversationTempDir(conversationId: string): string | null {
  const name = conversationTempEntryName(conversationId)
  if (!name) return null
  const base = ensureRoot()
  if (!base) return null
  const dir = path.join(base, name)
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      warn('Could not create the temporary directory of a conversation', error)
      return null
    }
  }
  try {
    const stats = lstatSync(dir)
    return stats.isDirectory() && !stats.isSymbolicLink() ? dir : null
  } catch {
    return null
  }
}

/** TMPDIR, TMP and TEMP of the conversation, computed by this process; empty when it has no directory. */
export function conversationTempEnv(conversationId: string | undefined): ConversationTempEnv {
  const dir = conversationId === undefined ? null : conversationTempDir(conversationId)
  return dir ? { TMPDIR: dir, TMP: dir, TEMP: dir } : {}
}

/** The root when it exists and can be trusted; never creates it. */
async function existingRoot(): Promise<string | null> {
  if (!root) return null
  const stats = await lstat(root).catch(() => null)
  return stats && trustedDirectory(stats) ? root : null
}

async function removeEntry(base: string, name: string): Promise<void> {
  await rm(path.join(base, name), {
    recursive: true,
    force: true,
    // A program that just ended can still hold a file open on Windows for a moment.
    maxRetries: process.platform === 'win32' ? 5 : 0,
  })
}

/** Removes the conversation's directory. Failures are logged; the deletion of the conversation goes on. */
export async function removeConversationTempDir(conversationId: string): Promise<void> {
  const name = conversationTempEntryName(conversationId)
  if (!name) return
  const base = await existingRoot()
  if (!base) return
  await removeEntry(base, name).catch((error: unknown) =>
    console.warn(
      JSON.stringify({
        component: 'conversation-temp',
        level: 'warn',
        message: 'Could not remove the temporary directory of a deleted conversation',
        error: error instanceof Error ? error.message : String(error),
      })
    )
  )
}

/**
 * At startup, removes the directories of conversations that no longer exist (deleted while the app could not finish,
 * or moved to another computer). `knownEntries` is read again before each removal. Unknown names, files and links
 * stay.
 */
export async function sweepConversationTempDirs(knownEntries: () => ReadonlySet<string>): Promise<void> {
  const base = await existingRoot()
  if (!base) return
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!ENTRY_NAME.test(entry.name) || !entry.isDirectory()) continue
    if (knownEntries().has(entry.name)) continue
    await removeEntry(base, entry.name).catch(() => undefined)
  }
}
