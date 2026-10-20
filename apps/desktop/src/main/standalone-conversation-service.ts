import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { StandaloneConversation } from '../shared/conversation'
import { createStandaloneConversationSchema } from '../shared/standalone-conversation'
import { standaloneConversationRelPath } from './app-paths'
import { getConversation, insertConversation } from './store'
import { getMainLocale } from './i18n'
import { realFs } from './real-fs'
import { initialStandaloneChatMode } from './chat/new-chat-defaults'

async function assertDirectory(directory: string): Promise<void> {
  const info = await fs.lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(directory)) !== directory) {
    throw new Error('Unsafe standalone chat directory.')
  }
}

async function managedRoot(create: boolean): Promise<string> {
  // Canonicalize Electron's trusted base (macOS /var can itself be an OS symlink).
  const base = await fs.realpath(app.getPath('userData'))
  const root = path.join(base, 'standalone-chats')
  if (create) {
    await fs.mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  await assertDirectory(root)
  return root
}

export async function createStandaloneConversation(payload: unknown): Promise<StandaloneConversation> {
  const args = createStandaloneConversationSchema.parse(payload)
  const root = await managedRoot(true)
  const id = randomUUID()
  const cwd = standaloneConversationRelPath(path.dirname(root), id)
  await fs.mkdir(cwd, { mode: 0o700 })
  const now = Date.now()
  const conversation: StandaloneConversation = {
    id,
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    cwd,
    name: args.name ?? (getMainLocale() === 'pt-BR' ? 'Novo chat' : 'New chat'),
    status: 'idle',
    createdAt: now,
    lastActivityAt: now,
    archived: 0,
    pinnedAt: null,
    // Permissions always start at Ask; only the behavior mode follows the person's last choice.
    uiPrefs: { autoName: args.name === undefined, chat: { mode: initialStandaloneChatMode(), permMode: 'ask' } },
  }
  try {
    await assertDirectory(cwd)
    insertConversation(conversation)
  } catch (error) {
    await removeStandaloneConversationDirectory(conversation)
    throw error
  }
  return conversation
}

/**
 * A standalone conversation that works in another one's managed folder, as a bot's routine run works in its bot's: the
 * folder stays the owner's, so deleting this conversation leaves it. The owner works in its own folder.
 */
export async function createStandaloneConversationInFolderOf(
  ownerId: string,
  name: string
): Promise<StandaloneConversation> {
  const owner = getConversation(ownerId)
  if (owner?.scope !== 'standalone') throw new Error('The folder owner is not a standalone chat.')
  await managedRoot(true)
  const cwd = await ownFolder(owner)
  await assertDirectory(cwd)
  const now = Date.now()
  const conversation: StandaloneConversation = {
    id: randomUUID(),
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    cwd,
    name: createStandaloneConversationSchema.parse({ name: name.trim().slice(0, 200) }).name!,
    status: 'idle',
    createdAt: now,
    lastActivityAt: now,
    archived: 0,
    pinnedAt: null,
    uiPrefs: { autoName: false, chat: { mode: initialStandaloneChatMode(), permMode: 'ask' } },
    folderOwnerId: owner.id,
  }
  insertConversation(conversation)
  return conversation
}

/** The managed folder of a conversation that owns one: named by its id, and never another's. */
async function ownFolder(conversation: StandaloneConversation): Promise<string> {
  const base = await fs.realpath(app.getPath('userData'))
  const expected = standaloneConversationRelPath(base, conversation.id)
  if (conversation.folderOwnerId || conversation.cwd !== expected) throw new Error('Unsafe standalone chat directory.')
  return expected
}

/** The managed folder a conversation works in: its own, or its folder owner's while that owner is a standalone chat. */
async function workingFolder(conversation: StandaloneConversation): Promise<string> {
  if (!conversation.folderOwnerId) return ownFolder(conversation)
  const owner = getConversation(conversation.folderOwnerId)
  if (owner?.scope !== 'standalone') throw new Error('Unsafe standalone chat directory.')
  const expected = await ownFolder(owner)
  if (conversation.cwd !== expected) throw new Error('Unsafe standalone chat directory.')
  return expected
}

/** Admission may recover missing artifacts, but never substitutes another execution directory. */
export async function ensureStandaloneConversationDirectory(
  conversation: StandaloneConversation
): Promise<{ cwd: string; recreated: boolean }> {
  const expected = await workingFolder(conversation)
  await managedRoot(true)
  let recreated = false
  try {
    await assertDirectory(expected)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await fs
      .mkdir(expected, { mode: 0o700 })
      .then(() => {
        recreated = true
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    await assertDirectory(expected)
  }
  return { cwd: expected, recreated }
}

/** Never trust a database cwd as a deletion target. A failed validation preserves the row. */
export async function validateStandaloneConversationDirectory(conversation: StandaloneConversation): Promise<string> {
  const expected = await workingFolder(conversation)
  await managedRoot(false)
  await assertDirectory(expected)
  return expected
}

/** Removes a conversation's own managed folder; one that works in another's folder has none and leaves it. */
export async function removeStandaloneConversationDirectory(conversation: StandaloneConversation): Promise<void> {
  if (conversation.folderOwnerId) return
  const expected = await ownFolder(conversation)
  try {
    await validateStandaloneConversationDirectory(conversation)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // A recursive `node:fs` removal in Electron fails on a real `*.asar` file, which it takes for an archive's folder.
  await realFs.promises.rm(expected, { recursive: true, force: true })
}
