import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  __resetToolOutputStoreForTests,
  cleanupToolOutputs,
  saveToolOutput,
} from '../../src/main/chat/tool-output-store'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-output-retention-'))
  vi.spyOn(app, 'getPath').mockReturnValue(root)
  __resetToolOutputStoreForTests({ maxTotalBytes: 100, maxFileBytes: 100, maxAgeMs: 1000 })
})
afterEach(() => {
  vi.restoreAllMocks()
  __resetToolOutputStoreForTests()
  fs.rmSync(root, { recursive: true, force: true })
})

it('does not let asynchronous cleanup delete a replacement saved during cleanup', async () => {
  const saved = saveToolOutput('old', 'same')!
  fs.utimesSync(saved, new Date(0), new Date(0))
  __resetToolOutputStoreForTests({ maxTotalBytes: 100, maxFileBytes: 100, maxAgeMs: 1000 })
  const unlink = fsp.unlink.bind(fsp)
  let replacementAttempted = false
  vi.spyOn(fsp, 'unlink').mockImplementation(async (target) => {
    if (String(target) === saved) {
      replacementAttempted = true
      expect(saveToolOutput('replacement', 'same')).toBe(saved)
    }
    return unlink(target)
  })
  await cleanupToolOutputs()
  // A synchronous deletion cannot interleave with a save; an async one must protect it.
  if (!replacementAttempted) saveToolOutput('replacement', 'same')
  expect(fs.readFileSync(saved, 'utf8')).toBe('replacement')
})

it('refuses to write or sweep through a symlinked storage directory', async () => {
  const external = path.join(root, 'external')
  fs.mkdirSync(external)
  const old = path.join(external, 'tool_old.txt')
  fs.writeFileSync(old, 'keep')
  fs.utimesSync(old, new Date(0), new Date(0))
  fs.symlinkSync(external, path.join(root, 'chat-tool-output'), 'junction')
  expect(saveToolOutput('new', 'new')).toBeNull()
  await cleanupToolOutputs()
  expect(fs.readFileSync(old, 'utf8')).toBe('keep')
})

it('refuses new spills when existing storage cannot be inventoried', () => {
  fs.mkdirSync(path.join(root, 'chat-tool-output'))
  vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  })
  expect(saveToolOutput('new', 'new')).toBeNull()
})

it('does not accumulate partial files when failed writes cannot be removed', () => {
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('rename failed')
  })
  const remove = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
    throw new Error('remove failed')
  })
  expect(saveToolOutput('partial', 'one')).toBeNull()
  expect(saveToolOutput('partial', 'two')).toBeNull()
  rename.mockRestore()
  remove.mockRestore()
  expect(fs.readdirSync(path.join(root, 'chat-tool-output'))).toHaveLength(1)
})
