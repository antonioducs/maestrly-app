import { createHash } from 'node:crypto'
import { createWriteStream, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress } from 'node:zlib'
import tar from 'tar-stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type MovePackageManifest, readMovePackage, writeMovePackage } from '../../src/main/conversation-move/package'
import type { MoveRows } from '../../src/main/conversation-move/rows'
import { CONVERSATION_MOVE_PACKAGE_FORMAT, CONVERSATION_MOVE_PACKAGE_VERSION } from '../../src/shared/conversation-move'

const VERSION = '9.9.9'
const OID = 'a'.repeat(40)
const SHA = 'b'.repeat(64)
let root: string

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

const rows: MoveRows = {
  conversation: {
    id: 'conv-1',
    name: 'Feature',
    experience: 'standard',
    createdAt: 1,
    lastActivityAt: 2,
    pinnedAt: null,
    uiPrefs: {},
  },
  tables: {
    chat_messages: [{ id: 'm1', conversation_id: 'conv-1', role: 'user', parts_json: '[]', seq: 1, created_at: 1 }],
    chat_tool_executions: [],
    chat_subagent_sessions: [],
    chat_subagent_transcript: [],
    chat_maestro_runs: [],
    chat_maestro_run_messages: [],
  },
}

const manifestBase = () => ({
  format: CONVERSATION_MOVE_PACKAGE_FORMAT as typeof CONVERSATION_MOVE_PACKAGE_FORMAT,
  version: CONVERSATION_MOVE_PACKAGE_VERSION,
  appVersion: VERSION,
  operationId: 'op-1',
  conversationId: 'conv-1',
  createdAt: 1,
  digest: {
    conversationId: 'conv-1',
    messages: 1,
    lastSeq: 1,
    messagesSha256: SHA,
    files: 2,
    filesSha256: SHA,
    headOid: OID,
    indexTree: OID,
    worktreeTree: OID,
  },
  snapshot: { branch: 'feat', headOid: OID, indexTree: OID, worktreeTree: OID, indexCommit: OID, worktreeCommit: OID },
})

/** Writes a package by hand, the way a damaged or hostile one would arrive. */
async function craft(file: string, entries: Array<{ name: string; body: string }>): Promise<void> {
  const pack = tar.pack()
  const done = pipeline(pack, createZstdCompress(), createWriteStream(file))
  for (const entry of entries) pack.entry({ name: entry.name }, entry.body)
  pack.finalize()
  await done
}

function craftedManifest(entries: MovePackageManifest['entries'], rowsBody: string): string {
  return JSON.stringify({
    ...manifestBase(),
    rows: { size: Buffer.byteLength(rowsBody), sha256: sha256(rowsBody) },
    entries,
  })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maestrly-move-package-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('conversation move package', () => {
  it('round-trips manifest, rows and files byte for byte', async () => {
    const sources = [
      { kind: 'attachment' as const, relative: 'abc.png', body: Buffer.from([0, 1, 2, 255]) },
      { kind: 'note' as const, relative: 'notes/_pages.json', body: Buffer.from('{"pages":[]}') },
      { kind: 'ignored' as const, relative: '.env.local', body: Buffer.from('SECRET=1\n') },
      { kind: 'bundle' as const, relative: 'branch.bundle', body: Buffer.alloc(200_000, 7) },
    ]
    const files = []
    for (const [index, source] of sources.entries()) {
      const absolute = path.join(root, `source-${index}`)
      await writeFile(absolute, source.body)
      if (source.kind === 'ignored') await chmod(absolute, 0o640)
      files.push({ kind: source.kind, relative: source.relative, absolute })
    }
    const written = await writeMovePackage(path.join(root, 'conv.maestrly-move'), {
      manifest: manifestBase(),
      rows,
      sources: files,
    })
    expect(written.sha256).toBe(sha256(await readFile(written.path)))
    expect((await readdir(root)).filter((name) => name.endsWith('.partial'))).toEqual([])

    const out = path.join(root, 'out')
    const read = await readMovePackage(written.path, out, { appVersion: VERSION })
    expect(read.rows).toEqual(rows)
    expect(read.manifest.entries.map((entry) => entry.path)).toEqual([
      'files/attachment/abc.png',
      'files/note/notes/_pages.json',
      'files/ignored/.env.local',
      'git/branch.bundle',
    ])
    for (const [index, source] of sources.entries()) {
      const file = read.files.find((entry) => entry.relative === source.relative)!
      expect(await readFile(file.absolute)).toEqual(source.body)
      expect(file.absolute.startsWith(out)).toBe(true)
      // Windows has no permission bits to carry.
      if (index === 2 && process.platform !== 'win32') expect((await stat(file.absolute)).mode & 0o777).toBe(0o640)
    }
  })

  it('rejects a file whose bytes differ from the manifest and removes what it extracted', async () => {
    const bad = path.join(root, 'bad.maestrly-move')
    const rowsBody = JSON.stringify(rows)
    const entries = [
      { path: 'files/note/p.md', kind: 'note' as const, relative: 'p.md', size: 3, sha256: sha256('abc'), mode: 0o644 },
    ]
    await craft(bad, [
      { name: 'manifest.json', body: craftedManifest(entries, rowsBody) },
      { name: 'rows.json', body: rowsBody },
      { name: 'files/note/p.md', body: 'abd' },
    ])
    const out = path.join(root, 'out')
    await expect(readMovePackage(bad, out, { appVersion: VERSION })).rejects.toMatchObject({ code: 'package-invalid' })
    await expect(stat(out)).rejects.toThrow()
  })

  it('rejects undeclared entries and path traversal', async () => {
    const rowsBody = JSON.stringify(rows)
    const traversal = path.join(root, 'traversal.maestrly-move')
    const unsafe = [
      {
        path: 'files/note/../../x',
        kind: 'note' as const,
        relative: '../../x',
        size: 1,
        sha256: sha256('x'),
        mode: 0o644,
      },
    ]
    await craft(traversal, [
      { name: 'manifest.json', body: craftedManifest(unsafe, rowsBody) },
      { name: 'rows.json', body: rowsBody },
      { name: 'files/note/../../x', body: 'x' },
    ])
    await expect(readMovePackage(traversal, path.join(root, 'out1'), { appVersion: VERSION })).rejects.toMatchObject({
      code: 'package-invalid',
    })
    await expect(stat(path.join(root, 'x'))).rejects.toThrow()

    const extra = path.join(root, 'extra.maestrly-move')
    await craft(extra, [
      { name: 'manifest.json', body: craftedManifest([], rowsBody) },
      { name: 'rows.json', body: rowsBody },
      { name: 'files/ignored/surprise', body: 'x' },
    ])
    await expect(readMovePackage(extra, path.join(root, 'out2'), { appVersion: VERSION })).rejects.toMatchObject({
      code: 'package-invalid',
    })

    const missing = path.join(root, 'missing.maestrly-move')
    const declared = [
      { path: 'files/note/p.md', kind: 'note' as const, relative: 'p.md', size: 1, sha256: sha256('x'), mode: 0o644 },
    ]
    await craft(missing, [
      { name: 'manifest.json', body: craftedManifest(declared, rowsBody) },
      { name: 'rows.json', body: rowsBody },
    ])
    await expect(readMovePackage(missing, path.join(root, 'out3'), { appVersion: VERSION })).rejects.toMatchObject({
      code: 'package-invalid',
    })

    const late = path.join(root, 'late.maestrly-move')
    await craft(late, [
      { name: 'rows.json', body: rowsBody },
      { name: 'manifest.json', body: craftedManifest([], rowsBody) },
    ])
    await expect(readMovePackage(late, path.join(root, 'out4'), { appVersion: VERSION })).rejects.toMatchObject({
      code: 'package-invalid',
    })
  })

  it('refuses a package from another app version', async () => {
    const pkg = await writeMovePackage(path.join(root, 'conv.maestrly-move'), {
      manifest: manifestBase(),
      rows,
      sources: [],
    })
    await expect(
      readMovePackage(pkg.path, path.join(root, 'out'), { appVersion: '0.0.0-other' })
    ).rejects.toMatchObject({ code: 'version-mismatch' })
  })

  it('refuses unsafe source paths when writing', async () => {
    const absolute = path.join(root, 'x')
    await writeFile(absolute, 'x')
    await expect(
      writeMovePackage(path.join(root, 'conv.maestrly-move'), {
        manifest: manifestBase(),
        rows,
        sources: [{ kind: 'ignored', relative: '.git/config', absolute }],
      })
    ).rejects.toMatchObject({ code: 'package-invalid' })
  })
})
