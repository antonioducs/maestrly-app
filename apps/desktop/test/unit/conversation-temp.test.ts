import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setConversationTempRootForTests,
  conversationTempDir,
  conversationTempEntryName,
  conversationTempEnv,
  conversationTempRootPath,
  MAX_CONVERSATION_TEMP_PATH,
  removeConversationTempDir,
  sweepConversationTempDirs,
} from '../../src/main/chat/conversation-temp'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const posix = process.platform !== 'win32'

describe('conversation temporary directory names', () => {
  it('names an entry after the first 16 hex digits of a UUID and gives other ids none', () => {
    expect(conversationTempEntryName(ID)).toBe('0f8fad5bd9cb469f')
    expect(conversationTempEntryName(ID.toUpperCase())).toBe('0f8fad5bd9cb469f')
    for (const id of ['conv-a', '', '../0f8fad5b-d9cb-469f-a165-70867728950e', `${ID}/..`]) {
      expect(conversationTempEntryName(id)).toBeNull()
    }
  })

  it('keeps one short root per profile and user, falling back to /tmp when the folder is too deep', () => {
    const base = { tmpdir: '/tmp', uid: 1000, platform: 'linux' as const }
    const root = conversationTempRootPath({ ...base, userData: '/home/bot/.config/maestrly-app' })
    expect(root).toMatch(/^\/tmp\/maestrly-1000-[0-9a-f]{8}$/)
    expect(conversationTempRootPath({ ...base, userData: '/home/bot/.config/maestrly-app' })).toBe(root)
    expect(conversationTempRootPath({ ...base, userData: '/home/bot/.config/maestrly-app-dev' })).not.toBe(root)
    expect(path.posix.join(root, '0f8fad5bd9cb469f').length).toBeLessThanOrEqual(MAX_CONVERSATION_TEMP_PATH)

    // A conversation of another Maestrly already has a short TMPDIR; one more level would be too deep for a socket.
    const nested = conversationTempRootPath({
      ...base,
      tmpdir: '/tmp/maestrly-1000-0a1b2c3d/0f8fad5bd9cb469f',
      userData: '/home/bot/.config/maestrly-app-dev-feature',
    })
    expect(nested).toMatch(/^\/tmp\/maestrly-1000-[0-9a-f]{8}$/)
    expect(
      conversationTempRootPath({ ...base, tmpdir: '/var/folders/x1/abc/T', platform: 'darwin', userData: '/u' })
    ).toMatch(/^\/var\/folders\/x1\/abc\/T\/maestrly-1000-[0-9a-f]{8}$/)
    expect(
      conversationTempRootPath({
        tmpdir: 'C:\\Users\\Someone\\AppData\\Local\\Temp',
        uid: null,
        platform: 'win32',
        userData: 'C:\\Users\\Someone\\AppData\\Roaming\\maestrly-app',
      })
    ).toMatch(/^C:\\Users\\Someone\\AppData\\Local\\Temp\\maestrly-[0-9a-f]{8}$/)
  })
})

describe('conversation temporary directories', () => {
  let dir = ''
  let root = ''

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conversation-temp-'))
    root = path.join(dir, 'maestrly-root')
    __setConversationTempRootForTests(root)
  })

  afterEach(() => {
    __setConversationTempRootForTests(null)
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a private root and one directory per conversation, and gives it as TMPDIR, TMP and TEMP', () => {
    const conversation = conversationTempDir(ID)
    expect(conversation).toBe(path.join(root, '0f8fad5bd9cb469f'))
    expect(statSync(conversation!).isDirectory()).toBe(true)
    if (posix) expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(conversationTempDir(ID)).toBe(conversation)
    expect(conversationTempEnv(ID)).toEqual({ TMPDIR: conversation, TMP: conversation, TEMP: conversation })
    expect(conversationTempEnv('conv-a')).toEqual({})
    expect(conversationTempEnv(undefined)).toEqual({})
  })

  it('has no directory before the profile turns them on', () => {
    __setConversationTempRootForTests(null)
    expect(conversationTempDir(ID)).toBeNull()
    expect(conversationTempEnv(ID)).toEqual({})
  })

  it.skipIf(!posix)('refuses a root that other users can open or that is a link', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mkdirSync(root, { mode: 0o755 })
    chmodSync(root, 0o755)
    expect(conversationTempDir(ID)).toBeNull()
    expect(existsSync(path.join(root, '0f8fad5bd9cb469f'))).toBe(false)

    const target = path.join(dir, 'elsewhere')
    mkdirSync(target, { mode: 0o700 })
    const link = path.join(dir, 'linked-root')
    symlinkSync(target, link)
    __setConversationTempRootForTests(link)
    expect(conversationTempDir(ID)).toBeNull()
    expect(readdirSync(target)).toEqual([])
  })

  it("removes only the deleted conversation's directory", async () => {
    const mine = conversationTempDir(ID)!
    const other = conversationTempDir(OTHER)!
    writeFileSync(path.join(mine, 'test-output.txt'), 'x')
    mkdirSync(path.join(mine, 'nested'))

    await removeConversationTempDir(ID)
    await removeConversationTempDir('not-a-uuid')

    expect(existsSync(mine)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('sweeps at startup only directories named after a conversation that no longer exists', async () => {
    const known = conversationTempDir(ID)!
    const gone = conversationTempDir(OTHER)!
    writeFileSync(path.join(gone, 'left.txt'), 'x')
    const late = path.join(root, 'aaaaaaaaaaaaaaaa')
    mkdirSync(late)
    mkdirSync(path.join(root, 'not-ours'))
    writeFileSync(path.join(root, 'bbbbbbbbbbbbbbbb'), 'a file')
    const outside = path.join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'keep.txt'), 'x')
    if (posix) symlinkSync(outside, path.join(root, 'cccccccccccccccc'))

    const entries = new Set(['0f8fad5bd9cb469f'])
    // A conversation that appears while the sweep runs keeps its directory: the list is read again before each removal.
    const knownEntries = vi.fn(() => {
      entries.add('aaaaaaaaaaaaaaaa')
      return entries
    })
    await sweepConversationTempDirs(knownEntries)

    expect(existsSync(known)).toBe(true)
    expect(existsSync(gone)).toBe(false)
    expect(existsSync(late)).toBe(true)
    expect(existsSync(path.join(root, 'not-ours'))).toBe(true)
    expect(existsSync(path.join(root, 'bbbbbbbbbbbbbbbb'))).toBe(true)
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true)
  })

  it('does not create the root to sweep or remove', async () => {
    await sweepConversationTempDirs(() => new Set())
    await removeConversationTempDir(ID)
    expect(existsSync(root)).toBe(false)
  })
})
