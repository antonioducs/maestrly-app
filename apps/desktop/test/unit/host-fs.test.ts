import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHostDirectory, hostFsRoots, listHostDirectory } from '../../src/main/remote-host/host-fs'

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

describe('host folders', () => {
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
