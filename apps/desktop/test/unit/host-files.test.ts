import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { FLEET_HOST_FILE_ERRORS, FLEET_HOST_FILE_LIMITS } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InstanceHttpError } from '../../src/main/fleet/instance/server'
import { packFolder } from '../../src/main/folder-archive'
import { HostFiles, parseRange } from '../../src/main/remote-host/server/host-files'
import { fileIdentity } from '../../src/main/transfer-io'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEF'

let base: string
let home: string
let srv: string
let previews: string
let uploads: string
let archives: string
let clock: number
let server: http.Server
let port: number
let files: HostFiles

/** The refusal reason of a call, by its fixed message. */
async function reasonOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run
    return null
  } catch (error) {
    const message = (error as Error).message
    return Object.entries(FLEET_HOST_FILE_ERRORS).find(([, text]) => text === message)?.[0] ?? message
  }
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'host-files-')))
  home = path.join(base, 'home')
  srv = path.join(base, 'srv')
  previews = path.join(base, 'previews')
  uploads = path.join(base, 'uploads')
  archives = path.join(base, 'archives')
  for (const dir of [home, srv, previews, path.join(base, 'outside')]) mkdirSync(dir)
  clock = 1_000
  let tokens = 0
  files = new HostFiles({
    roots: () => [home, srv],
    readRoots: () => [previews],
    uploadsDir: uploads,
    archivesDir: archives,
    now: () => clock,
    token: () => TOKEN.slice(0, 30) + String(tokens++).padStart(2, '0'),
  })
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    try {
      if (url.pathname === '/content') await files.content(request, response, url)
      else await files.uploadChunk(request, response, url.searchParams.get('upload') ?? '', url)
    } catch (error) {
      if (response.headersSent) return void response.destroy()
      const known = error instanceof InstanceHttpError ? error : new InstanceHttpError(500, 'INTERNAL', 'failed')
      response.writeHead(known.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: known.code, message: known.message }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  rmSync(base, { recursive: true, force: true })
})

const content = (file: string, headers: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}/content?path=${encodeURIComponent(file)}`, { headers })
const chunk = (uploadId: string, offset: number, bytes: Uint8Array, options: { zstd?: boolean; sha?: string } = {}) =>
  fetch(`http://127.0.0.1:${port}/chunk?upload=${uploadId}&offset=${offset}`, {
    method: 'PUT',
    headers: {
      'x-maestrly-sha256': options.sha ?? sha(bytes),
      'x-maestrly-length': String(bytes.length),
      ...(options.zstd ? { 'x-maestrly-encoding': 'zstd' } : {}),
    },
    body: options.zstd ? zstdCompressSync(bytes) : Buffer.from(bytes),
  })

// A workspaces host runs on Linux or macOS, and the host protocol takes POSIX paths only.
describe.skipIf(process.platform === 'win32')('host files', () => {
  it('reads a range of a file the roots hold, and refuses the rest', async () => {
    const file = path.join(srv, 'a.txt')
    writeFileSync(file, '0123456789')
    const stat = await files.stat({ path: file })
    expect(stat).toMatchObject({ path: file, name: 'a.txt', size: 10, identity: fileIdentity(statSync(file)) })
    symlinkSync(path.join(base, 'outside'), path.join(srv, 'escape'))
    writeFileSync(path.join(base, 'outside', 'secret.txt'), 'x')
    expect(await reasonOf(files.stat({ path: path.join(base, 'outside', 'secret.txt') }))).toBe('outside-roots')
    expect(await reasonOf(files.stat({ path: path.join(srv, 'escape', 'secret.txt') }))).toBe('outside-roots')
    expect(await reasonOf(files.stat({ path: path.join(srv, 'missing.txt') }))).toBe('not-found')
    expect(await reasonOf(files.stat({ path: srv }))).toBe('not-a-file')

    const response = await content(file, { range: 'bytes=2-9', 'x-maestrly-file-identity': stat.identity })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-9/10')
    expect(response.headers.get('x-maestrly-length')).toBe('8')
    expect(response.headers.get('x-maestrly-sha256')).toBe(sha(Buffer.from('23456789')))
    expect(await response.text()).toBe('23456789')

    const beyond = await content(file, { range: 'bytes=50-60', 'x-maestrly-file-identity': stat.identity })
    expect(beyond.status).toBe(416)
    expect(beyond.headers.get('content-range')).toBe('bytes */10')

    const changed = await content(file, { range: 'bytes=0-1', 'x-maestrly-file-identity': '10:1:1' })
    expect(changed.status).toBe(409)
    expect((await changed.json()).message).toBe(FLEET_HOST_FILE_ERRORS.changed)
  })

  it('compresses a range only when its content compresses', async () => {
    const csv = Buffer.from('id,name,value\n'.repeat(80_000).slice(0, 1024 * 1024))
    const random = randomBytes(1024 * 1024)
    writeFileSync(path.join(srv, 'a.csv'), csv)
    writeFileSync(path.join(srv, 'r.bin'), random)
    const ask = async (name: string) => {
      const file = path.join(srv, name)
      const { identity } = await files.stat({ path: file })
      return content(file, {
        range: `bytes=0-${1024 * 1024 - 1}`,
        'x-maestrly-file-identity': identity,
        'x-maestrly-accept-encoding': 'zstd',
      })
    }
    const compressed = await ask('a.csv')
    expect(compressed.headers.get('x-maestrly-encoding')).toBe('zstd')
    expect(zstdDecompressSync(Buffer.from(await compressed.arrayBuffer())).equals(csv)).toBe(true)
    expect(compressed.headers.get('x-maestrly-sha256')).toBe(sha(csv))
    const plain = await ask('r.bin')
    expect(plain.headers.get('x-maestrly-encoding')).toBeNull()
    expect(plain.headers.get('content-length')).toBe(String(1024 * 1024))
    expect(Buffer.from(await plain.arrayBuffer()).equals(random)).toBe(true)
  })

  it('reads from the read-only roots, and never writes there', async () => {
    const file = path.join(previews, 'doc.pdf')
    writeFileSync(file, '%PDF-1.7')
    const { identity } = await files.stat({ path: file })
    expect(await (await content(file, { range: 'bytes=0-3', 'x-maestrly-file-identity': identity })).text()).toBe(
      '%PDF'
    )
    expect(await reasonOf(files.beginUpload({ directory: previews, name: 'x.bin', size: 1, overwrite: false }))).toBe(
      'outside-roots'
    )
  })

  it('assembles an upload from chunks in any order, and checks it whole', async () => {
    const bytes = randomBytes(3 * 1024 * 1024)
    const mib = 1024 * 1024
    const session = await files.beginUpload({ directory: srv, name: 'big.bin', size: bytes.length, overwrite: false })
    expect(session).toMatchObject({ path: path.join(srv, 'big.bin'), size: bytes.length })
    expect((await chunk(session.uploadId, 2 * mib, bytes.subarray(2 * mib))).status).toBe(204)
    const zeros = Buffer.alloc(mib)
    expect((await chunk(session.uploadId, 0, bytes.subarray(0, mib))).status).toBe(204)
    // A chunk whose bytes do not match its checksum is refused, and the session goes on.
    const bad = await chunk(session.uploadId, mib, zeros, { sha: sha(bytes.subarray(mib, 2 * mib)) })
    expect(bad.status).toBe(400)
    expect((await bad.json()).message).toBe(FLEET_HOST_FILE_ERRORS['chunk-mismatch'])
    expect((await chunk(session.uploadId, mib, bytes.subarray(mib, 2 * mib), { zstd: true })).status).toBe(204)
    expect(await files.commitUpload(session.uploadId, { sha256: sha(bytes) })).toEqual({
      path: path.join(srv, 'big.bin'),
      size: bytes.length,
      sha256: sha(bytes),
    })
    expect(readFileSync(path.join(srv, 'big.bin')).equals(bytes)).toBe(true)
    expect(readdirSync(srv).filter((name) => name.endsWith('.part'))).toEqual([])
    expect(readdirSync(uploads)).toEqual([])
  })

  it('takes the chunks of one upload in parallel without losing its session', async () => {
    // Each chunk records the session again when it lands: one landing never hides the session from another.
    // Several senders at once, each sending its next chunk as soon as one lands, as the transfer engine does.
    const size = 256
    const count = 240
    const senders = 8
    const bytes = randomBytes(size * count)
    const session = await files.beginUpload({
      directory: srv,
      name: 'parallel.bin',
      size: bytes.length,
      overwrite: false,
    })
    const refused: string[] = []
    let next = 0
    await Promise.all(
      Array.from({ length: senders }, async () => {
        for (let index = next++; index < count; index = next++) {
          const answer = await chunk(session.uploadId, index * size, bytes.subarray(index * size, (index + 1) * size))
          if (answer.status !== 204) refused.push(`${index}: ${answer.status} ${await answer.text()}`)
        }
      })
    )
    expect(refused).toEqual([])
    await files.commitUpload(session.uploadId, { sha256: sha(bytes) })
    expect(readFileSync(path.join(srv, 'parallel.bin')).equals(bytes)).toBe(true)
    expect(readdirSync(uploads)).toEqual([])
  })

  it('drops an upload whose whole file does not match', async () => {
    const session = await files.beginUpload({ directory: srv, name: 'x.bin', size: 4, overwrite: false })
    await chunk(session.uploadId, 0, Buffer.from('abcd'))
    expect(await reasonOf(files.commitUpload(session.uploadId, { sha256: sha(Buffer.from('abce')) }))).toBe(
      'digest-mismatch'
    )
    expect(readdirSync(srv)).toEqual([])
    expect(readdirSync(uploads)).toEqual([])
  })

  it('refuses a taken name unless the person chooses to replace it', async () => {
    writeFileSync(path.join(srv, 'taken.txt'), 'old')
    expect(await reasonOf(files.beginUpload({ directory: srv, name: 'taken.txt', size: 3, overwrite: false }))).toBe(
      'exists'
    )
    const session = await files.beginUpload({ directory: srv, name: 'late.txt', size: 3, overwrite: false })
    await chunk(session.uploadId, 0, Buffer.from('new'))
    writeFileSync(path.join(srv, 'late.txt'), 'meanwhile')
    expect(await reasonOf(files.commitUpload(session.uploadId, { sha256: sha(Buffer.from('new')) }))).toBe('exists')
    expect(readFileSync(path.join(srv, 'late.txt'), 'utf8')).toBe('meanwhile')
    await files.commitUpload(session.uploadId, { sha256: sha(Buffer.from('new')), overwrite: true })
    expect(readFileSync(path.join(srv, 'late.txt'), 'utf8')).toBe('new')
    expect(readdirSync(srv).sort()).toEqual(['late.txt', 'taken.txt'])
  })

  it('aborts uploads, and sweeps the ones nobody touched', async () => {
    const one = await files.beginUpload({ directory: srv, name: 'one.bin', size: 2, overwrite: false })
    await files.abortUpload(one.uploadId)
    expect(readdirSync(srv)).toEqual([])
    await files.abortUpload('unknown-upload-id-0000000000')
    const two = await files.beginUpload({ directory: home, name: 'two.bin', size: 2, overwrite: false })
    expect(await files.sweep()).toBe(0)
    clock += FLEET_HOST_FILE_LIMITS.uploadTtlMs + 1
    expect(await files.sweep()).toBe(1)
    expect(readdirSync(home)).toEqual([])
    expect(await reasonOf(files.commitUpload(two.uploadId, { sha256: sha(Buffer.alloc(2)) }))).toBe('unknown-upload')
  })

  it('hashes a whole file of the version it names', async () => {
    const file = path.join(home, 'h.txt')
    writeFileSync(file, 'hello')
    const { identity } = await files.stat({ path: file })
    expect(await files.digest({ path: file, identity })).toEqual({ sha256: sha(Buffer.from('hello')) })
    expect(await reasonOf(files.digest({ path: file, identity: '5:0:0' }))).toBe('changed')
    expect(existsSync(file)).toBe(true)
  })

  /** Asks for the archive's status until packing is over. */
  async function ready(archiveId: string) {
    for (;;) {
      const status = await files.archiveStatus(archiveId)
      if (status.state === 'ready') return status
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  it('packs a folder of the roots into an archive read like any file, until it is released', async () => {
    mkdirSync(path.join(srv, 'site', 'css'), { recursive: true })
    writeFileSync(path.join(srv, 'site', 'index.html'), '<p>hi</p>')
    writeFileSync(path.join(srv, 'site', 'css', 'a.css'), 'p{}')
    const { archiveId } = await files.beginArchive({ path: path.join(srv, 'site') })
    const archive = await ready(archiveId)
    expect(archive).toMatchObject({ state: 'ready', archiveId, name: 'site', entries: 3 })
    expect(path.dirname(archive.path)).toBe(archives)
    // The download routes read it as they read a file of the roots.
    const stat = await files.stat({ path: archive.path })
    expect(stat).toMatchObject({ size: archive.size, identity: archive.identity })
    const whole = await content(archive.path, { 'x-maestrly-file-identity': archive.identity })
    expect(whole.status).toBe(200)
    expect(await files.digest({ path: archive.path, identity: archive.identity })).toEqual({
      sha256: sha(Buffer.from(await whole.arrayBuffer())),
    })
    await files.releaseArchive(archiveId)
    expect(readdirSync(archives)).toEqual([])
    expect(await reasonOf(files.archiveStatus(archiveId))).toBe('archive-expired')
    expect(await reasonOf(files.stat({ path: archive.path }))).toBe('archive-expired')
    const gone = await content(archive.path, { 'x-maestrly-file-identity': archive.identity })
    expect((await gone.json()).message).toBe(FLEET_HOST_FILE_ERRORS['archive-expired'])
    // Releasing what is gone, or was never there, is no error.
    await files.releaseArchive(archiveId)
    await files.releaseArchive('not an id')
  })

  it('packs only folders of the roots', async () => {
    writeFileSync(path.join(srv, 'a.txt'), 'a')
    expect(await reasonOf(files.beginArchive({ path: path.join(srv, 'a.txt') }))).toBe('not-a-directory')
    expect(await reasonOf(files.beginArchive({ path: path.join(base, 'outside') }))).toBe('outside-roots')
    expect(await reasonOf(files.beginArchive({ path: previews }))).toBe('outside-roots')
    expect(await reasonOf(files.beginArchive({ path: path.join(srv, 'missing') }))).toBe('not-found')
    expect(await reasonOf(files.archiveStatus('unknown-archive-id-0000000000'))).toBe('archive-expired')
  })

  it('never packs its own archives, even from a folder that holds them', async () => {
    const own = new HostFiles({
      roots: () => [home],
      readRoots: () => [],
      uploadsDir: path.join(home, '.maestrly', 'uploads'),
      archivesDir: path.join(home, '.maestrly', 'archives'),
    })
    writeFileSync(path.join(home, 'notes.txt'), 'n')
    const { archiveId } = await own.beginArchive({ path: home })
    for (;;) {
      const status = await own.archiveStatus(archiveId)
      if (status.state === 'ready') {
        // `.maestrly` and `notes.txt`: the archives and uploads folders are left out.
        expect(status.entries).toBe(2)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })

  it('sweeps archives nobody read within a day, and what a stopped host left behind', async () => {
    mkdirSync(path.join(srv, 'docs'))
    writeFileSync(path.join(srv, 'docs', 'a.md'), '# a')
    const read = await ready((await files.beginArchive({ path: path.join(srv, 'docs') })).archiveId)
    const idle = await ready((await files.beginArchive({ path: path.join(srv, 'docs') })).archiveId)
    // Left by a host that stopped while packing, and an archive without its record.
    writeFileSync(
      path.join(archives, 'stale-archive-id-000000000.json'),
      JSON.stringify({ archiveId: 'stale-archive-id-000000000', path: '', source: srv, touchedAt: clock })
    )
    writeFileSync(path.join(archives, 'orphan-archive-id-00000000.tar.zst'), 'x')
    expect(await files.sweep()).toBe(2)
    clock += FLEET_HOST_FILE_LIMITS.archiveTtlMs - 1
    // Reading a range of an archive keeps it.
    await content(read.path, { range: 'bytes=0-0', 'x-maestrly-file-identity': read.identity })
    clock += 2
    expect(await files.sweep()).toBe(1)
    expect(readdirSync(archives).sort()).toEqual([`${read.archiveId}.json`, `${read.archiveId}.tar.zst`])
    expect(await reasonOf(files.archiveStatus(idle.archiveId))).toBe('archive-expired')
  })

  it('extracts an uploaded folder into a free name, never over another folder', async () => {
    const source = path.join(base, 'outside', 'site')
    mkdirSync(path.join(source, 'img'), { recursive: true })
    writeFileSync(path.join(source, 'index.html'), '<p>new</p>')
    writeFileSync(path.join(source, 'img', 'a.svg'), '<svg/>')
    const archive = path.join(base, 'site.tar.zst')
    await packFolder(source, archive)
    const bytes = readFileSync(archive)
    mkdirSync(path.join(srv, 'site'))
    writeFileSync(path.join(srv, 'site', 'old.html'), 'old')
    // A taken name is no reason to refuse a folder, which never overwrites.
    const session = await files.beginUpload({
      directory: srv,
      name: 'site',
      size: bytes.length,
      overwrite: false,
      kind: 'folder',
    })
    expect((await chunk(session.uploadId, 0, bytes)).status).toBe(204)
    expect(await files.commitUpload(session.uploadId, { sha256: sha(bytes) })).toEqual({
      path: path.join(srv, 'site (2)'),
      size: bytes.length,
      sha256: sha(bytes),
    })
    expect(readdirSync(path.join(srv, 'site'))).toEqual(['old.html'])
    expect(readFileSync(path.join(srv, 'site (2)', 'img', 'a.svg'), 'utf8')).toBe('<svg/>')
    expect(readdirSync(srv).sort()).toEqual(['site', 'site (2)'])
    expect(readdirSync(uploads)).toEqual([])
    // Asked again by a computer that lost the answer: the same folder, not a third one.
    expect((await files.commitUpload(session.uploadId, { sha256: sha(bytes) })).path).toBe(path.join(srv, 'site (2)'))
    expect(readdirSync(srv).sort()).toEqual(['site', 'site (2)'])
  })

  it('ends an uploaded folder whose archive cannot be extracted safely', async () => {
    const bytes = zstdCompressSync(Buffer.alloc(1024, 1))
    const session = await files.beginUpload({
      directory: srv,
      name: 'junk',
      size: bytes.length,
      overwrite: false,
      kind: 'folder',
    })
    await chunk(session.uploadId, 0, bytes)
    expect(await reasonOf(files.commitUpload(session.uploadId, { sha256: sha(bytes) }))).toBe('unsafe-archive')
    expect(readdirSync(srv)).toEqual([])
    expect(readdirSync(uploads)).toEqual([])
  })

  it('serves one range at a time, never more than a range of a large file', () => {
    expect(parseRange(undefined, 10)).toBeNull()
    expect(parseRange(undefined, FLEET_HOST_FILE_LIMITS.downloadRangeBytes + 1)).toBe('invalid')
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 })
    expect(parseRange('bytes=0-1,4-5', 10)).toBe('invalid')
    expect(parseRange('bytes=9-2', 10)).toBe('invalid')
  })
})
