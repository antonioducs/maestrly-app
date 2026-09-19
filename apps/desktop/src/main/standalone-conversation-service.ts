import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { StandaloneConversation } from '../shared/conversation'
import { createStandaloneConversationSchema } from '../shared/standalone-conversation'
import { standaloneConversationRelPath } from './app-paths'
import { insertConversation } from './store'
import { getMainLocale } from './i18n'

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
    uiPrefs: { autoName: args.name === undefined, chat: { mode: 'ask', permMode: 'ask' } },
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

/** Admission may recover missing artifacts, but never substitutes another execution directory. */
export async function ensureStandaloneConversationDirectory(
  conversation: StandaloneConversation
): Promise<{ cwd: string; recreated: boolean }> {
  const base = await fs.realpath(app.getPath('userData'))
  const expected = standaloneConversationRelPath(base, conversation.id)
  if (conversation.cwd !== expected) throw new Error('Unsafe standalone chat directory.')
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
  const base = await fs.realpath(app.getPath('userData'))
  const expected = standaloneConversationRelPath(base, conversation.id)
  if (conversation.cwd !== expected) throw new Error('Unsafe standalone chat directory.')
  await managedRoot(false)
  await assertDirectory(expected)
  return expected
}

export async function removeStandaloneConversationDirectory(conversation: StandaloneConversation): Promise<void> {
  const base = await fs.realpath(app.getPath('userData'))
  const expected = standaloneConversationRelPath(base, conversation.id)
  if (conversation.cwd !== expected) throw new Error('Unsafe standalone chat directory.')
  try {
    await validateStandaloneConversationDirectory(conversation)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await fs.rm(expected, { recursive: true, force: true })
}
