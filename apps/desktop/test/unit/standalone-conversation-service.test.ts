import { mkdtemp, realpath, rm, stat, symlink, mkdir, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ base: '', insert: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => h.base } }))
vi.mock('../../src/main/store', () => ({ insertConversation: h.insert }))
import {
  createStandaloneConversation,
  removeStandaloneConversationDirectory,
  ensureStandaloneConversationDirectory,
} from '../../src/main/standalone-conversation-service'
import { setMainLocale } from '../../src/main/i18n'
beforeEach(async () => {
  h.base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'standalone-')))
  h.insert.mockReset()
  setMainLocale('en')
})
afterEach(async () => {
  setMainLocale('en')
  await rm(h.base, { recursive: true, force: true })
})
it('uses the active locale for a new chat and gives each chat its own directory', async () => {
  setMainLocale('pt-BR')
  const first = await createStandaloneConversation({})
  const second = await createStandaloneConversation({})
  expect(first.name).toBe('Novo chat')
  expect(second.cwd).not.toBe(first.cwd)
})
it('validates every admission and recreates only a missing managed directory', async () => {
  const c = await createStandaloneConversation({})
  expect(await ensureStandaloneConversationDirectory(c)).toEqual({ cwd: c.cwd, recreated: false })
  await rm(c.cwd, { recursive: true })
  expect(await ensureStandaloneConversationDirectory(c)).toEqual({ cwd: c.cwd, recreated: true })
  await expect(ensureStandaloneConversationDirectory({ ...c, cwd: h.base })).rejects.toThrow()
  await rm(c.cwd, { recursive: true })
  await symlink(h.base, c.cwd)
  await expect(ensureStandaloneConversationDirectory(c)).rejects.toThrow()
})
it('creates a private non-Git directory and explicit Ask defaults', async () => {
  const c = await createStandaloneConversation({ name: '  Notes  ' })
  expect(c).toMatchObject({
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    name: 'Notes',
    experience: 'standard',
    isMulti: 0,
    uiPrefs: { chat: { mode: 'ask', permMode: 'ask' }, autoName: false },
  })
  expect(c.cwd).toBe(path.join(h.base, 'standalone-chats', c.id))
  if (process.platform !== 'win32') expect((await stat(c.cwd)).mode & 0o777).toBe(0o700)
  await expect(access(path.join(c.cwd, '.git'))).rejects.toThrow()
  expect(h.insert).toHaveBeenCalledWith(c)
})
it('uses auto naming only when no name was supplied', async () => {
  expect((await createStandaloneConversation({})).uiPrefs).toMatchObject({ autoName: true })
})
it('rejects extra creation fields before allocating directories', async () => {
  await expect(createStandaloneConversation({ cwd: '/tmp', name: 'bad' })).rejects.toThrow()
  expect(h.insert).not.toHaveBeenCalled()
})
it('rejects symlink roots and symlink conversation directories', async () => {
  const outside = path.join(h.base, 'outside')
  await mkdir(outside)
  await symlink(outside, path.join(h.base, 'standalone-chats'))
  await expect(createStandaloneConversation({})).rejects.toThrow()
  await rm(path.join(h.base, 'standalone-chats'))
  const c = await createStandaloneConversation({})
  await rm(c.cwd, { recursive: true })
  await symlink(outside, c.cwd)
  await expect(removeStandaloneConversationDirectory(c)).rejects.toThrow()
  expect((await stat(outside)).isDirectory()).toBe(true)
})
it('only deletes its managed directory without following child symlinks', async () => {
  const c = await createStandaloneConversation({})
  const outside = path.join(h.base, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'keep'), 'safe')
  await symlink(outside, path.join(c.cwd, 'link'))
  await expect(removeStandaloneConversationDirectory({ ...c, cwd: outside })).rejects.toThrow()
  await removeStandaloneConversationDirectory(c)
  await access(path.join(outside, 'keep'))
  await expect(access(c.cwd)).rejects.toThrow()
})
it('cleans up newly allocated directories after insert failure', async () => {
  h.insert.mockImplementation(() => {
    throw new Error('db failed')
  })
  await expect(createStandaloneConversation({})).rejects.toThrow('db failed')
  const c = h.insert.mock.calls[0][0]
  await expect(access(c.cwd)).rejects.toThrow()
})
