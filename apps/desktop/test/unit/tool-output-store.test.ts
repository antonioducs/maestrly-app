import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetToolOutputStoreForTests,
  __toolOutputStoreBytesForTests,
  cleanupToolOutputs,
  saveToolOutput,
  type ToolOutputLimits,
} from '../../src/main/chat/tool-output-store'

/**
 * The store owns `userData/chat-tool-output`. Every case runs against a synthetic user-data
 * directory with a mocked `app.getPath`, real files, and `utimes` for age, so eviction is
 * exercised against the same filesystem behaviour production sees.
 */
describe('chat tool output store', () => {
  let root = ''
  let userData = ''
  let dir = ''

  function configure(limits?: Partial<ToolOutputLimits>): void {
    __resetToolOutputStoreForTests(limits)
  }

  /** Pre-existing file, as left by an earlier version that never pruned anything. */
  function legacyFile(name: string, size: number, ageMs = 0): string {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, 'x'.repeat(size))
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(file, when, when)
    return file
  }

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-output-store-')))
    userData = path.join(root, 'user-data')
    fs.mkdirSync(userData)
    dir = path.join(userData, 'chat-tool-output')
    vi.spyOn(app, 'getPath').mockReturnValue(userData)
    configure()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetToolOutputStoreForTests()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('stores output under a readable name for safe tool call ids and hashes unsafe ones', () => {
    const stored = saveToolOutput('full output', 'spill-test')

    expect(stored).toBe(path.join(dir, 'tool_spill-test.txt'))
    expect(fs.readFileSync(stored as string, 'utf8')).toBe('full output')

    const hashed = saveToolOutput('other', '../../escape id')
    expect(path.dirname(hashed as string)).toBe(dir)
    expect(path.basename(hashed as string)).toMatch(/^tool_sha256-[a-f0-9]{32}\.txt$/)
    expect(fs.existsSync(path.join(root, 'escape id'))).toBe(false)
    expect(saveToolOutput('other', '../../escape id')).toBe(hashed)
  })

  it('refuses output larger than the per-file cap instead of storing part of it', () => {
    configure({ maxFileBytes: 64 })

    expect(saveToolOutput('x'.repeat(65), 'huge')).toBeNull()

    expect(fs.existsSync(dir)).toBe(false)
    expect(__toolOutputStoreBytesForTests()).toBe(0)
  })

  it('evicts the oldest spills when the total byte cap is reached', () => {
    configure({ maxTotalBytes: 300, maxFileBytes: 200 })

    for (const id of ['one', 'two', 'three']) saveToolOutput('x'.repeat(100), id)
    expect(__toolOutputStoreBytesForTests()).toBe(300)

    expect(saveToolOutput('x'.repeat(100), 'four')).toBe(path.join(dir, 'tool_four.txt'))

    expect(fs.readdirSync(dir).sort()).toEqual(['tool_four.txt', 'tool_three.txt', 'tool_two.txt'])
    expect(__toolOutputStoreBytesForTests()).toBe(300)
  })

  it('caps the file count so many tiny spills cannot fill the profile', () => {
    configure({ maxFiles: 2 })

    for (const id of ['a', 'b', 'c']) saveToolOutput('tiny', id)

    expect(fs.readdirSync(dir).sort()).toEqual(['tool_b.txt', 'tool_c.txt'])
    expect(__toolOutputStoreBytesForTests()).toBe(8)
  })

  it('reuses one file per tool call id without double counting its bytes', () => {
    saveToolOutput('x'.repeat(100), 'repeat')
    saveToolOutput('x'.repeat(40), 'repeat')

    expect(fs.readdirSync(dir)).toEqual(['tool_repeat.txt'])
    expect(__toolOutputStoreBytesForTests()).toBe(40)
  })

  it('prunes expired and excess files left by earlier versions on the first cleanup', async () => {
    configure({ maxTotalBytes: 250 })
    const expired = legacyFile('tool_expired.txt', 10, 8 * 24 * 60 * 60 * 1000)
    const older = legacyFile('tool_older.txt', 100, 3 * 60 * 1000)
    const old = legacyFile('tool_old.txt', 100, 2 * 60 * 1000)
    const recent = legacyFile('tool_recent.txt', 100, 60 * 1000)

    await cleanupToolOutputs()

    expect(fs.existsSync(expired)).toBe(false)
    expect(fs.existsSync(older)).toBe(false)
    expect(fs.existsSync(old)).toBe(true)
    expect(fs.existsSync(recent)).toBe(true)
    expect(__toolOutputStoreBytesForTests()).toBe(200)
  })

  it('prunes spills that aged out after this process wrote them', async () => {
    const aged = saveToolOutput('aged output', 'aged') as string
    const fresh = saveToolOutput('fresh output', 'fresh') as string
    const when = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    fs.utimesSync(aged, when, when)
    await new Promise((resolve) => setTimeout(resolve, 5))

    await cleanupToolOutputs()

    expect(fs.existsSync(aged)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
    expect(__toolOutputStoreBytesForTests()).toBe(Buffer.byteLength('fresh output'))
  })

  it('never deletes entries it did not create', async () => {
    configure({ maxTotalBytes: 0 })
    const expired = legacyFile('tool_expired.txt', 10, 8 * 24 * 60 * 60 * 1000)
    const unknown = legacyFile('notes.txt', 10, 8 * 24 * 60 * 60 * 1000)
    const staleTemp = legacyFile('.tool_stale.txt.0123456789abcdef.tmp', 5, 2 * 60 * 60 * 1000)
    const freshTemp = legacyFile('.tool_fresh.txt.fedcba9876543210.tmp', 5)
    const outside = path.join(root, 'outside.txt')
    fs.writeFileSync(outside, 'keep me')
    fs.symlinkSync(outside, path.join(dir, 'tool_linked.txt'))
    fs.mkdirSync(path.join(dir, 'tool_directory.txt'))

    await cleanupToolOutputs()

    expect(fs.existsSync(expired)).toBe(false)
    expect(fs.existsSync(staleTemp)).toBe(false)
    expect(fs.existsSync(unknown)).toBe(true)
    expect(fs.existsSync(freshTemp)).toBe(true)
    expect(fs.lstatSync(path.join(dir, 'tool_linked.txt')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(dir, 'tool_directory.txt'))).toBe(true)
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep me')
  })

  it('replaces a symlink planted at a managed name instead of writing through it', () => {
    const outside = path.join(root, 'outside.txt')
    fs.writeFileSync(outside, 'original')
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(outside, path.join(dir, 'tool_planted.txt'))

    const stored = saveToolOutput('spilled output', 'planted') as string

    expect(fs.readFileSync(outside, 'utf8')).toBe('original')
    expect(fs.lstatSync(stored).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(stored, 'utf8')).toBe('spilled output')
  })

  it('returns null and leaves no partial artifact when the write fails', () => {
    saveToolOutput('first', 'kept')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed')
    })

    expect(saveToolOutput('second', 'broken')).toBeNull()

    rename.mockRestore()
    expect(fs.readdirSync(dir)).toEqual(['tool_kept.txt'])
    expect(__toolOutputStoreBytesForTests()).toBe(5)
    expect(saveToolOutput('third', 'broken')).toBe(path.join(dir, 'tool_broken.txt'))
  })

  it('keeps bytes reserved when a deletion fails, so the cap is never exceeded', () => {
    configure({ maxTotalBytes: 200, maxFileBytes: 200 })
    saveToolOutput('x'.repeat(100), 'a')
    saveToolOutput('x'.repeat(100), 'b')
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })

    expect(saveToolOutput('x'.repeat(100), 'c')).toBeNull()

    unlink.mockRestore()
    expect(fs.readdirSync(dir).sort()).toEqual(['tool_a.txt', 'tool_b.txt'])
    expect(__toolOutputStoreBytesForTests()).toBe(200)
  })

  it('restarts accounting when a local-data reset removes the directory', async () => {
    saveToolOutput('x'.repeat(100), 'before')
    fs.rmSync(dir, { recursive: true, force: true })

    const stored = saveToolOutput('x'.repeat(40), 'after') as string

    expect(fs.readdirSync(dir)).toEqual(['tool_after.txt'])
    expect(__toolOutputStoreBytesForTests()).toBe(40)

    fs.rmSync(dir, { recursive: true, force: true })
    await cleanupToolOutputs()

    expect(__toolOutputStoreBytesForTests()).toBe(0)
    expect(fs.existsSync(dir)).toBe(false)
    expect(saveToolOutput('again', 'after')).toBe(stored)
  })

  it('keeps a spill written while cleanup is scanning', async () => {
    const expired = legacyFile('tool_expired.txt', 100, 8 * 24 * 60 * 60 * 1000)
    const realReaddir = fsp.readdir
    const readdir = vi.spyOn(fsp, 'readdir').mockImplementation((async (target: string) => {
      readdir.mockRestore()
      const names = await realReaddir(target)
      // A tool result spills between the listing and the deletions.
      saveToolOutput('written during the scan', 'fresh')
      return names
    }) as unknown as typeof fsp.readdir)

    await cleanupToolOutputs()

    expect(fs.existsSync(expired)).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'tool_fresh.txt'), 'utf8')).toBe('written during the scan')
    expect(__toolOutputStoreBytesForTests()).toBe(Buffer.byteLength('written during the scan'))
  })
})
