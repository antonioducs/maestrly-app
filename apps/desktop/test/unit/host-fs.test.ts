import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  conversationHostFolder,
  createHostDirectory,
  deleteHostEntry,
  hostFsRoots,
  hostFsUsage,
  listHostDirectory,
  previewHostFile,
  renameHostEntry,
} from '../../src/main/remote-host/host-fs'
import { HOST_FS_ERROR_MESSAGES, hostFsErrorCode } from '../../src/shared/host-fs'

let base: string
let root: string
let outside: string

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'host-fs-')))
  root = path.join(base, 'root')
  outside = path.join(base, 'outside')
  mkdirSync(path.join(root, 'beta'), { recursive: true })
  mkdirSync(path.join(root, 'Alpha'))
  mkdirSync(path.join(root, '.hidden'))
  mkdirSync(path.join(outside, 'secret'), { recursive: true })
  writeFileSync(path.join(root, 'notes.txt'), 'hello')
  writeFileSync(path.join(root, '.env'), 'x')
  symlinkSync(path.join(root, 'beta'), path.join(root, 'inside-link'))
  symlinkSync(outside, path.join(root, 'outside-link'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

const names = (listing: { entries: { name: string }[] }) => listing.entries.map((entry) => entry.name)
const codeOf = async (run: Promise<unknown>) => run.then(() => null).catch((error) => (error as { code?: string }).code)

// A workspaces host runs on Linux or macOS, and the host protocol takes POSIX paths only.
describe.skipIf(process.platform === 'win32')('host folders', () => {
  it('lists directories, sorted by name, without hidden entries or files', async () => {
    const listing = await listHostDirectory(root, {}, [root])
    expect(listing.path).toBe(root)
    expect(listing.parent).toBeNull()
    expect(listing.truncated).toBe(false)
    expect(names(listing)).toEqual(['Alpha', 'beta', 'inside-link'])
    expect(listing.entries.every((entry) => entry.kind === 'directory')).toBe(true)
    expect(listing.entries[0].path).toBe(path.join(root, 'Alpha'))
  })

  it('shows hidden entries and files on request, directories first', async () => {
    const listing = await listHostDirectory(root, { includeHidden: true, includeFiles: true }, [root])
    expect(names(listing)).toEqual(['.hidden', 'Alpha', 'beta', 'inside-link', '.env', 'notes.txt', 'outside-link'])
    const byName = Object.fromEntries(listing.entries.map((entry) => [entry.name, entry]))
    expect(byName['notes.txt']).toMatchObject({ kind: 'file', size: 5 })
    expect(byName['notes.txt'].modifiedAt).toBe(Math.floor(statSync(path.join(root, 'notes.txt')).mtimeMs))
    // A link that leaves the allowed folders is shown but cannot be entered.
    expect(byName['outside-link'].kind).toBe('link')
  })

  it('gives the parent of a folder below a root', async () => {
    const listing = await listHostDirectory(path.join(root, 'beta'), {}, [root])
    expect(listing.parent).toBe(root)
    expect(listing.entries).toEqual([])
  })

  it('refuses paths outside the allowed folders, including through links and dot segments', async () => {
    expect(await codeOf(listHostDirectory(outside, {}, [root]))).toBe('outside-roots')
    expect(await codeOf(listHostDirectory(path.join(root, 'outside-link'), {}, [root]))).toBe('outside-roots')
    expect(await codeOf(listHostDirectory(path.join(root, 'outside-link', 'secret'), {}, [root]))).toBe('outside-roots')
    expect(await codeOf(listHostDirectory(path.join(root, '..', 'outside'), {}, [root]))).toBe('outside-roots')
    expect(await codeOf(listHostDirectory('relative/path', {}, [root]))).toBe('outside-roots')
    // A root that is a prefix of another name is not its parent.
    expect(await codeOf(listHostDirectory(outside, {}, [path.join(base, 'out')]))).toBe('outside-roots')
  })

  it('reports a missing folder and a file given as a folder', async () => {
    expect(await codeOf(listHostDirectory(path.join(root, 'nope'), {}, [root]))).toBe('not-found')
    expect(await codeOf(listHostDirectory(path.join(root, 'notes.txt'), {}, [root]))).toBe('not-a-directory')
  })

  it('says when a folder has more entries than it lists', async () => {
    const listing = await listHostDirectory(root, { includeHidden: true, includeFiles: true }, [root], 3)
    expect(listing.entries).toHaveLength(3)
    expect(listing.truncated).toBe(true)
  })

  it('creates a folder by name inside an allowed folder', async () => {
    const created = await createHostDirectory(root, 'new folder', [root])
    expect(created).toBe(path.join(root, 'new folder'))
    expect(statSync(created).isDirectory()).toBe(true)
    expect(await codeOf(createHostDirectory(root, 'new folder', [root]))).toBe('exists')
    for (const name of ['a/b', '..', '.', '', 'a\\b', 'x'.repeat(256)])
      expect(await codeOf(createHostDirectory(root, name, [root])), name).toBe('invalid-name')
    expect(await codeOf(createHostDirectory(outside, 'x', [root]))).toBe('outside-roots')
  })

  it('offers the home folder, and the workspaces folder when the server mounts one', () => {
    expect(hostFsRoots({})).toEqual([{ path: os.homedir(), label: 'home' }])
    expect(hostFsRoots({ MAESTRLY_WORKSPACES_ROOT: root })).toEqual([
      { path: os.homedir(), label: 'home' },
      { path: root, label: 'workspaces' },
    ])
    for (const value of ['relative', path.join(root, 'nope'), path.join(root, 'notes.txt')])
      expect(hostFsRoots({ MAESTRLY_WORKSPACES_ROOT: value })).toHaveLength(1)
  })
})

describe('host folder refusals across IPC', () => {
  it('can be told apart by the message, which is all that IPC carries of an error', async () => {
    const refused = await listHostDirectory(path.join(outside, 'secret'), {}, [root]).catch((error: Error) => error)
    expect(hostFsErrorCode(refused)).toBe('outside-roots')
    const exists = await createHostDirectory(root, 'beta', [root]).catch((error: Error) => error)
    // As Electron and the bridge hand it to a renderer.
    const wrapped = new Error(`Error invoking remote method 'host:invoke': Error: ${(exists as Error).message}`)
    expect(hostFsErrorCode(wrapped)).toBe('exists')
    expect(hostFsErrorCode(new Error('EACCES: permission denied'))).toBeNull()
    expect(new Set(Object.values(HOST_FS_ERROR_MESSAGES)).size).toBe(Object.keys(HOST_FS_ERROR_MESSAGES).length)
  })
})

// A workspaces host runs on Linux or macOS, and the host protocol takes POSIX paths only.
describe.skipIf(process.platform === 'win32')('host files of the files panel', () => {
  let area: string
  beforeAll(() => {
    area = path.join(base, 'area')
    mkdirSync(area)
  })

  it('previews the start of a text file, and only names a binary one', async () => {
    writeFileSync(path.join(area, 'short.txt'), 'hello file')
    expect(await previewHostFile(path.join(area, 'short.txt'), [area])).toEqual({
      binary: false,
      text: 'hello file',
      truncated: false,
      size: 10,
    })
    // A two-byte character straddles the end of the sample: it is left out, not shown as a replacement mark.
    const long = 'a'.repeat(64 * 1024 - 1) + 'é' + 'b'.repeat(36 * 1024)
    writeFileSync(path.join(area, 'long.txt'), long)
    const preview = await previewHostFile(path.join(area, 'long.txt'), [area])
    expect(preview.truncated).toBe(true)
    expect(preview.text).toBe('a'.repeat(64 * 1024 - 1))
    writeFileSync(path.join(area, 'blob.bin'), Buffer.from([1, 0, 2]))
    expect(await previewHostFile(path.join(area, 'blob.bin'), [area])).toMatchObject({ binary: true, text: null })
    mkdirSync(path.join(area, 'folder'))
    expect(await codeOf(previewHostFile(path.join(area, 'folder'), [area]))).toBe('not-a-file')
  })

  it('renames an entry in its folder', async () => {
    writeFileSync(path.join(area, 'old.txt'), 'x')
    writeFileSync(path.join(area, 'taken.txt'), 'y')
    expect(await renameHostEntry(path.join(area, 'old.txt'), 'new.txt', [area])).toBe(path.join(area, 'new.txt'))
    expect(readFileSync(path.join(area, 'new.txt'), 'utf8')).toBe('x')
    expect(await codeOf(renameHostEntry(path.join(area, 'new.txt'), 'a/b', [area]))).toBe('invalid-name')
    expect(await codeOf(renameHostEntry(path.join(area, 'new.txt'), 'taken.txt', [area]))).toBe('exists')
    expect(await codeOf(renameHostEntry(area, 'renamed', [area]))).toBe('is-root')
    expect(await codeOf(renameHostEntry(path.join(area, 'gone.txt'), 'x.txt', [area]))).toBe('not-found')
  })

  it('deletes files, folders and links, never what a link points to, and never a root', async () => {
    writeFileSync(path.join(area, 'drop.txt'), 'x')
    mkdirSync(path.join(area, 'tree', 'deep'), { recursive: true })
    writeFileSync(path.join(area, 'tree', 'deep', 'f.txt'), 'x')
    mkdirSync(path.join(area, 'target'))
    writeFileSync(path.join(area, 'target', 'kept.txt'), 'kept')
    symlinkSync(path.join(area, 'target'), path.join(area, 'pointer'))
    await deleteHostEntry(path.join(area, 'drop.txt'), [area])
    await deleteHostEntry(path.join(area, 'tree'), [area])
    await deleteHostEntry(path.join(area, 'pointer'), [area])
    expect(existsSync(path.join(area, 'drop.txt'))).toBe(false)
    expect(existsSync(path.join(area, 'tree'))).toBe(false)
    expect(existsSync(path.join(area, 'pointer'))).toBe(false)
    expect(readFileSync(path.join(area, 'target', 'kept.txt'), 'utf8')).toBe('kept')
    expect(await codeOf(deleteHostEntry(area, [area]))).toBe('is-root')
    expect(await codeOf(deleteHostEntry(path.join(outside, 'secret'), [area]))).toBe('outside-roots')
  })

  it('reports the space of the volume a folder is on', async () => {
    const usage = await hostFsUsage(area, [area])
    expect(usage.total).toBeGreaterThan(0)
    expect(usage.free).toBeLessThanOrEqual(usage.total)
  })

  it("opens on a conversation's folder only when it lies inside the allowed folders", async () => {
    expect(await conversationHostFolder(path.join(area, 'target'), [area])).toBe(path.join(area, 'target'))
    expect(await conversationHostFolder(outside, [area])).toBeNull()
    expect(await conversationHostFolder(null, [area])).toBeNull()
  })
})
