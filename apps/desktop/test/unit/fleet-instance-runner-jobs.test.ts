import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { FLEET_RUNNER_LIMITS, FLEET_RUNNER_TRANSFER_LIMITS } from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { packRunnerBlobs } from '../../src/main/fleet/instance/runner-jobs/blobs'
import { InstanceHttpError } from '../../src/main/fleet/instance/http'
import { tailRunnerLog, writeRunnerLog } from '../../src/main/fleet/instance/runner-jobs/log'
import {
  buildRunnerManifest,
  loadRunnerManifest,
  runnerBlobsOf,
  saveRunnerManifest,
} from '../../src/main/fleet/instance/runner-jobs/manifest'
import { RunnerJobRecords } from '../../src/main/fleet/instance/runner-jobs/records'
import {
  cleanTemps,
  collector,
  jobSpec,
  JOB_ID,
  runnerJob,
  runnerRecord,
  sha256,
  tempFolder,
  untar,
  writeTree,
} from '../helpers/runner-jobs'

afterEach(cleanTemps)

const refused = async (promise: Promise<unknown>): Promise<InstanceHttpError> => {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause
  )
  expect(error).toBeInstanceOf(InstanceHttpError)
  return error as InstanceHttpError
}

describe('runner job records', () => {
  const records = () => new RunnerJobRecords(path.join(tempFolder(), 'runner-jobs'))

  it('stores a record, reads it back and refuses a second one for the same job', async () => {
    const store = records()
    const record = runnerRecord('/work')
    await store.create(record)
    expect(await store.get(JOB_ID)).toEqual(record)
    await expect(store.create(record)).rejects.toThrow(/already has a record/)
    if (process.platform !== 'win32')
      expect(statSync(path.join(store.dir(JOB_ID), 'record.json')).mode & 0o777).toBe(0o600)
  })

  it('validates job ids before it touches a path', async () => {
    const store = records()
    expect(await store.get('../escape')).toBeNull()
    expect(() => store.dir('../escape')).toThrow(TypeError)
    await expect(store.create(runnerRecord('/work', { jobId: '../escape' }))).rejects.toThrow()
    await expect(store.update('job_x', (record) => record)).rejects.toThrow(TypeError)
  })

  it('changes a record, one change after another, and throws for a job it does not hold', async () => {
    const store = records()
    await store.create(runnerRecord('/work', { conversationId: 'c' }))
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.update(JOB_ID, (record) => ({ ...record, conversationId: record.conversationId + 'x' }))
      )
    )
    expect((await store.get(JOB_ID))?.conversationId).toBe(`c${'x'.repeat(20)}`)
    const kept = await store.update(JOB_ID, (record) => record)
    expect(kept.conversationId).toBe(`c${'x'.repeat(20)}`)
    const missing = await refused(store.update('job_BBBBBBBBBBBBBBBB0002', (record) => record))
    expect(missing.status).toBe(404)
  })

  it('lists records newest first and skips what cannot be read', async () => {
    const store = records()
    const ids = ['job_AAAAAAAAAAAAAAAA0001', 'job_AAAAAAAAAAAAAAAA0002', 'job_AAAAAAAAAAAAAAAA0003']
    for (const [index, jobId] of ids.entries())
      await store.create(runnerRecord('/work', { jobId, createdAt: `2026-10-29T10:0${index}:00.000Z` }))
    writeFileSync(path.join(store.dir(ids[1]), 'record.json'), '{not json')
    mkdirSync(path.join(store.dir(ids[0]), '..', 'not-a-job'))
    expect((await store.list()).map((record) => record.jobId)).toEqual([ids[2], ids[0]])
    expect(await new RunnerJobRecords(path.join(tempFolder(), 'missing')).list()).toEqual([])
  })

  it('sweeps ended records past the retention with their files, and nothing else', async () => {
    const store = records()
    const now = Date.parse('2026-11-10T00:00:00.000Z')
    const week = FLEET_RUNNER_LIMITS.endedRetentionMs
    const make = async (jobId: string, createdAt: string, job: ReturnType<typeof runnerJob> | null) => {
      await store.create(runnerRecord('/work', { jobId, createdAt, job }))
      writeFileSync(path.join(store.dir(jobId), 'job.log'), 'log')
    }
    const old = 'job_AAAAAAAAAAAAAAAA0001'
    await make(old, '2026-10-01T00:00:00.000Z', runnerJob(old, 'succeeded', { endedAt: '2026-10-02T00:00:00.000Z' }))
    const recent = 'job_AAAAAAAAAAAAAAAA0002'
    await make(recent, '2026-10-01T00:00:00.000Z', runnerJob(recent, 'failed', { endedAt: '2026-11-08T00:00:00.000Z' }))
    const running = 'job_AAAAAAAAAAAAAAAA0003'
    await make(running, '2026-10-01T00:00:00.000Z', runnerJob(running, 'running'))
    const unsent = 'job_AAAAAAAAAAAAAAAA0004'
    await make(unsent, '2026-10-01T00:00:00.000Z', null)
    const fresh = 'job_AAAAAAAAAAAAAAAA0005'
    await make(fresh, '2026-11-09T00:00:00.000Z', null)
    await store.sweep(now, week)
    expect((await store.list()).map((record) => record.jobId).sort()).toEqual([recent, running, fresh].sort())
    expect(existsSync(store.dir(old))).toBe(false)
  })
})

describe('runner manifest', () => {
  const build = async (
    root: string,
    extra: Parameters<typeof jobSpec>[1] = {},
    indexFile = path.join(tempFolder(), 'digests.json')
  ) => buildRunnerManifest({ jobId: JOB_ID, folder: root, spec: jobSpec(root, extra), indexFile })
  const paths = (manifest: { entries: Array<{ path: string }> }) => manifest.entries.map((entry) => entry.path)

  it('describes files with their mode and SHA-256, parents before children', async () => {
    const root = tempFolder()
    writeTree(root, { 'src/deep/a.txt': 'alpha', 'src/b.txt': 'beta', 'empty/.keep': '' })
    chmodSync(path.join(root, 'src', 'b.txt'), 0o755)
    const { manifest } = await build(root)
    expect(manifest.jobId).toBe(JOB_ID)
    expect(manifest.bytes).toBe(9)
    expect(manifest.skipped).toBe(0)
    expect(paths(manifest)).toEqual(['empty', 'empty/.keep', 'src', 'src/b.txt', 'src/deep', 'src/deep/a.txt'])
    const file = (name: string) => manifest.entries.find((entry) => entry.path === name)
    expect(file('src/deep/a.txt')).toMatchObject({ kind: 'file', size: 5, sha256: sha256('alpha') })
    expect(file('empty/.keep')).toMatchObject({ kind: 'file', size: 0, sha256: sha256('') })
    if (process.platform !== 'win32') expect(file('src/b.txt')).toMatchObject({ mode: 0o755 })
    expect(file('src')).toMatchObject({ kind: 'directory' })
  })

  it('leaves out the default excludes at any depth', async () => {
    const root = tempFolder()
    writeTree(root, {
      'keep.txt': 'k',
      '.git/config': 'g',
      'node_modules/x/index.js': 'n',
      'sub/node_modules/y.js': 'n',
      '.venv/bin/python': 'p',
      'pkg/__pycache__/m.pyc': 'c',
      'pkg/m.py': 'm',
    })
    const { manifest } = await build(root)
    expect(paths(manifest)).toEqual(['keep.txt', 'pkg', 'pkg/m.py', 'sub'])
    expect(manifest.skipped).toBe(0)
  })

  it('takes the job exclude in place of the defaults: directories, anchored paths and globs', async () => {
    const root = tempFolder()
    writeTree(root, {
      'node_modules/x.js': 'now sent',
      'a.log': 'l',
      'deep/b.log': 'l',
      'deep/b.logs': 'kept',
      'build/o': 'x',
      'src/build/p': 'x',
      'dist/out/z': 'x',
      'dist/other/z': 'kept',
      'src/dist/out/w': 'kept',
      'data/q': 'x',
      'data/deep/q': 'x',
      'database/k': 'kept',
      'tmp-1': 'x',
      'tmp-12': 'kept',
      'logs/2026/x.txt': 'x',
      'logs/y.txt': 'kept',
      'cache.tmp': 'x',
      'x/y/z.tmp': 'x',
      'x/y/z.tmpl': 'kept',
      'docs/a/b/c.md': 'x',
      'docs/c.md': 'x',
      'docs/c.mdx': 'kept',
    })
    const { manifest } = await build(root, {
      exclude: ['*.log', 'build/', 'dist/out/', 'data/**', 'tmp-?', 'logs/*/', '**/*.tmp', 'docs/**/*.md'],
    })
    const files = paths(manifest).filter((p) => manifest.entries.find((e) => e.path === p)?.kind === 'file')
    expect(files).toEqual([
      'database/k',
      'deep/b.logs',
      'dist/other/z',
      'docs/c.mdx',
      'logs/y.txt',
      'node_modules/x.js',
      'src/dist/out/w',
      'tmp-12',
      'x/y/z.tmpl',
    ])
  })

  it('skips the paths of named caches and the folder state of runner jobs', async () => {
    const root = tempFolder()
    writeTree(root, {
      'models/big.bin': 'weights',
      'web/node_modules/a.js': 'n',
      'web/src/a.ts': 'a',
      '.maestrly/runner-jobs/job_x.log': 'log',
      '.maestrly/runner-jobs/job_x.staging/file': 'staged',
      '.maestrly/notes.md': 'kept',
    })
    const { manifest } = await build(root, {
      exclude: [],
      caches: [
        { name: 'models', path: './models/' },
        { name: 'modules', path: 'web/node_modules' },
      ],
    })
    expect(paths(manifest)).toEqual(['.maestrly', '.maestrly/notes.md', 'web', 'web/src', 'web/src/a.ts'])
  })

  it('keeps links that stay inside the folder and counts what cannot travel', async () => {
    if (process.platform === 'win32') return
    const root = tempFolder()
    const outside = tempFolder()
    writeTree(root, { 'src/a.txt': 'a' })
    writeFileSync(path.join(outside, 'secret'), 's')
    symlinkSync('src/a.txt', path.join(root, 'inside'))
    symlinkSync('a.txt', path.join(root, 'src', 'sibling'))
    symlinkSync('../src', path.join(root, 'src', 'self'))
    symlinkSync(outside, path.join(root, 'out-dir'))
    symlinkSync('../../outside-the-folder', path.join(root, 'src', 'up'))
    symlinkSync('/etc/passwd', path.join(root, 'absolute'))
    symlinkSync('out-dir/secret', path.join(root, 'through-a-link'))
    execFileSync('mkfifo', [path.join(root, 'pipe')])
    const { manifest } = await build(root)
    const links = manifest.entries.filter((entry) => entry.kind === 'symlink')
    expect(links).toEqual([
      { kind: 'symlink', path: 'inside', target: 'src/a.txt' },
      { kind: 'symlink', path: 'src/self', target: '../src' },
      { kind: 'symlink', path: 'src/sibling', target: 'a.txt' },
    ])
    // out-dir, src/up, absolute, through-a-link and the pipe.
    expect(manifest.skipped).toBe(5)
    expect(JSON.stringify(manifest)).not.toContain('secret')
  })

  it('does not hash a file again when its size, modification time and inode are the same', async () => {
    const root = tempFolder()
    const indexFile = path.join(tempFolder(), 'digests.json')
    writeTree(root, { 'a.txt': 'first', 'b.txt': 'other' })
    const first = (await build(root, {}, indexFile)).manifest
    const digestOf = (manifest: typeof first, name: string) =>
      (manifest.entries.find((entry) => entry.path === name) as { sha256: string }).sha256
    expect(digestOf(first, 'a.txt')).toBe(sha256('first'))

    // The index says a.txt hashes to something else; the file is as it was, so that is what the manifest says.
    const index = JSON.parse(readFileSync(indexFile, 'utf8')) as {
      files: Array<[string, number, number, number, string]>
    }
    const stale = sha256('stale')
    index.files = index.files.map((row) => (row[0] === 'a.txt' ? [row[0], row[1], row[2], row[3], stale] : row))
    writeFileSync(indexFile, JSON.stringify(index))
    const reused = (await build(root, {}, indexFile)).manifest
    expect(digestOf(reused, 'a.txt')).toBe(stale)
    expect(digestOf(reused, 'b.txt')).toBe(sha256('other'))

    // The file changed (same size, later time): hashed again.
    const info = statSync(path.join(root, 'a.txt'))
    writeFileSync(path.join(root, 'a.txt'), 'extra')
    utimesSync(path.join(root, 'a.txt'), info.atime, new Date(info.mtimeMs + 5_000))
    const changed = (await build(root, {}, indexFile)).manifest
    expect(digestOf(changed, 'a.txt')).toBe(sha256('extra'))
    expect(digestOf(changed, 'b.txt')).toBe(sha256('other'))
    // The index keeps only what the last walk saw.
    writeFileSync(path.join(root, 'c.txt'), 'c')
    await build(root, {}, indexFile)
    const saved = JSON.parse(readFileSync(indexFile, 'utf8')) as { files: unknown[][] }
    expect(saved.files.map((row) => row[0])).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('hashes everything when the index cannot be read', async () => {
    const root = tempFolder()
    const indexFile = path.join(tempFolder(), 'digests.json')
    writeTree(root, { 'a.txt': 'first' })
    writeFileSync(indexFile, 'garbage')
    const { manifest } = await build(root, {}, indexFile)
    expect(manifest.entries).toEqual([
      { kind: 'file', path: 'a.txt', mode: expect.any(Number), size: 5, sha256: sha256('first') },
    ])
  })

  it('refuses a folder past the input limits with a clear error', async () => {
    const root = tempFolder()
    writeTree(root, { 'a.txt': 'aaaa', 'b.txt': 'bbbb', 'c.txt': 'cccc' })
    const limits = FLEET_RUNNER_LIMITS as { inputFilesMax: number; inputBytesMax: number }
    const saved = { ...limits }
    try {
      limits.inputFilesMax = 2
      expect((await refused(build(root))).message).toMatch(/more than 2 files/)
      limits.inputFilesMax = saved.inputFilesMax
      limits.inputBytesMax = 11
      expect((await refused(build(root))).message).toMatch(/more than 11 bytes/)
    } finally {
      Object.assign(limits, saved)
    }
  })

  it('answers a conflict for a folder that is gone, and stops when asked to', async () => {
    const root = tempFolder()
    expect((await refused(build(path.join(root, 'gone')))).status).toBe(409)
    writeTree(root, { 'a.txt': 'a' })
    const controller = new AbortController()
    controller.abort()
    await expect(
      buildRunnerManifest({
        jobId: JOB_ID,
        folder: root,
        spec: jobSpec(root),
        indexFile: path.join(root, '..', 'i.json'),
        signal: controller.signal,
      })
    ).rejects.toThrow()
  })

  it('keeps the manifest of a job and reads it back with its blobs', async () => {
    const root = tempFolder()
    writeTree(root, { 'a.txt': 'same', 'b.txt': 'same', 'c.txt': 'other' })
    const { manifest } = await build(root)
    const file = path.join(tempFolder(), 'job', 'manifest.json')
    await saveRunnerManifest(file, manifest)
    const loaded = await loadRunnerManifest(file)
    expect(loaded?.manifest).toEqual(manifest)
    expect(loaded?.blobs.get(sha256('same'))).toEqual({ path: 'a.txt', size: 4 })
    expect(runnerBlobsOf(manifest).size).toBe(2)
    expect(await loadRunnerManifest(path.join(root, 'nothing.json'))).toBeNull()
    writeFileSync(file, '{"nonsense":true}')
    expect(await loadRunnerManifest(file)).toBeNull()
  })
})

describe('runner blobs', () => {
  async function prepared(files: Record<string, string>) {
    const root = tempFolder()
    writeTree(root, files)
    const { manifest, blobs } = await buildRunnerManifest({
      jobId: JOB_ID,
      folder: root,
      spec: jobSpec(root),
      indexFile: path.join(tempFolder(), 'i.json'),
    })
    return { root, manifest, blobs }
  }

  it('streams a zstd tar of regular files named by digest, in the order asked', async () => {
    const { root, blobs } = await prepared({
      'a.txt': 'alpha',
      'dir/b.txt': 'beta',
      'dir/empty': '',
      'dup.txt': 'alpha',
    })
    const out = collector()
    const digests = [sha256('beta'), sha256(''), sha256('alpha'), sha256('beta')]
    await packRunnerBlobs({ folder: root, blobs, digests, output: out.sink })
    await out.done
    const entries = await untar(out.bytes())
    // A digest asked for twice is sent once.
    expect(entries.map((entry) => entry.name)).toEqual([sha256('beta'), sha256(''), sha256('alpha')])
    expect(entries.map((entry) => entry.type)).toEqual(['file', 'file', 'file'])
    for (const entry of entries) expect(sha256(entry.content)).toBe(entry.name)
  })

  it('round-trips large content exactly', async () => {
    const root = tempFolder()
    const content = randomBytes(3 * 1024 * 1024 + 17)
    writeFileSync(path.join(root, 'big.bin'), content)
    const { blobs } = await buildRunnerManifest({
      jobId: JOB_ID,
      folder: root,
      spec: jobSpec(root),
      indexFile: path.join(tempFolder(), 'i.json'),
    })
    const out = collector()
    await packRunnerBlobs({ folder: root, blobs, digests: [sha256(content)], output: out.sink })
    await out.done
    const [entry] = await untar(out.bytes())
    expect(entry.content.equals(content)).toBe(true)
  })

  it('refuses an unknown digest before writing anything', async () => {
    const { root, blobs } = await prepared({ 'a.txt': 'alpha' })
    const out = collector()
    const error = await refused(
      packRunnerBlobs({ folder: root, blobs, digests: [sha256('alpha'), sha256('unknown')], output: out.sink })
    )
    expect(error.status).toBe(400)
    expect(error.message).toContain(sha256('unknown'))
    expect(out.sink.writableLength).toBe(0)
    expect(out.bytes().length).toBe(0)
  })

  it('refuses too many digests and too many bytes before writing anything', async () => {
    const { root, blobs } = await prepared({ 'a.txt': 'alpha' })
    const out = collector()
    const tooMany = Array.from({ length: FLEET_RUNNER_TRANSFER_LIMITS.blobBatchDigestsMax + 1 }, () => sha256('alpha'))
    expect((await refused(packRunnerBlobs({ folder: root, blobs, digests: tooMany, output: out.sink }))).status).toBe(
      400
    )

    const half = FLEET_RUNNER_TRANSFER_LIMITS.blobBatchBytesMax / 2 + 1
    const large = new Map([
      ['a'.repeat(64), { path: 'a.txt', size: half }],
      ['b'.repeat(64), { path: 'b.txt', size: half }],
    ])
    const error = await refused(
      packRunnerBlobs({ folder: root, blobs: large, digests: ['a'.repeat(64), 'b'.repeat(64)], output: out.sink })
    )
    expect(error.status).toBe(400)
    expect(error.message).toMatch(/bytes of blobs/)
    // A lone blob may be larger than a batch; this one is refused for another reason, its file being small.
    const lone = await refused(
      packRunnerBlobs({
        folder: root,
        blobs: new Map([['a'.repeat(64), { path: 'a.txt', size: half * 2 }]]),
        digests: ['a'.repeat(64)],
        output: out.sink,
      })
    )
    expect(lone.status).toBe(409)
    expect(out.bytes().length).toBe(0)
  })

  it('refuses a file that is not as the manifest described it, before writing anything', async () => {
    const { root, blobs } = await prepared({ 'a.txt': 'alpha', 'b.txt': 'beta' })
    writeFileSync(path.join(root, 'b.txt'), 'be')
    const out = collector()
    const error = await refused(
      packRunnerBlobs({ folder: root, blobs, digests: [sha256('alpha'), sha256('beta')], output: out.sink })
    )
    expect(error.status).toBe(409)
    expect(error.message).toContain('b.txt')
    expect(out.bytes().length).toBe(0)
    rmFile(path.join(root, 'b.txt'))
    expect(
      (await refused(packRunnerBlobs({ folder: root, blobs, digests: [sha256('beta')], output: out.sink }))).status
    ).toBe(409)
  })

  it('does not follow a link that took the place of a file', async () => {
    if (process.platform === 'win32') return
    const { root, blobs } = await prepared({ 'a.txt': 'alpha' })
    const outside = path.join(tempFolder(), 'secret')
    writeFileSync(outside, 'alpha')
    rmFile(path.join(root, 'a.txt'))
    symlinkSync(outside, path.join(root, 'a.txt'))
    const out = collector()
    expect(
      (await refused(packRunnerBlobs({ folder: root, blobs, digests: [sha256('alpha')], output: out.sink }))).status
    ).toBe(409)
  })

  it('ends the stream with an error when a file shrinks while it is sent', async () => {
    const root = tempFolder()
    const content = randomBytes(24 * 1024 * 1024)
    const file = path.join(root, 'big.bin')
    writeFileSync(file, content)
    const { blobs } = await buildRunnerManifest({
      jobId: JOB_ID,
      folder: root,
      spec: jobSpec(root),
      indexFile: path.join(tempFolder(), 'i.json'),
    })
    let received = 0
    let first = true
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        // The first bytes are in and the rest wait: the file shrinks meanwhile.
        if (first) {
          first = false
          truncateSync(file, 3)
          setTimeout(callback, 20)
        } else callback()
      },
    })
    const error = await refused(packRunnerBlobs({ folder: root, blobs, digests: [sha256(content)], output: slow }))
    expect(error.status).toBe(409)
    expect(received).toBeLessThan(content.length)
  })

  it('stops, and does not wait forever, when the output goes away', async () => {
    const { root, blobs } = await prepared({ 'a.txt': 'alpha', 'b.txt': 'beta' })
    const broken = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('socket closed'))
      },
    })
    await expect(
      packRunnerBlobs({ folder: root, blobs, digests: [sha256('alpha'), sha256('beta')], output: broken })
    ).rejects.toThrow('socket closed')
    const controller = new AbortController()
    controller.abort()
    await expect(
      packRunnerBlobs({
        folder: root,
        blobs,
        digests: [sha256('alpha')],
        output: collector().sink,
        signal: controller.signal,
      })
    ).rejects.toThrow()
  })
})

function rmFile(file: string): void {
  execFileSync('rm', ['-f', file])
}

describe('runner job log', () => {
  const body = (text: string) => Readable.from([Buffer.from(text)])

  it('writes batches at their offsets: a batch sent again lands where it did', async () => {
    const file = path.join(tempFolder(), 'job', 'job.log')
    mkdirSync(path.dirname(file))
    await writeRunnerLog(file, 0, body('first\n'), 1024)
    await writeRunnerLog(file, 6, body('second\n'), 1024)
    await writeRunnerLog(file, 6, body('second\n'), 1024)
    await writeRunnerLog(file, 0, body('first\n'), 1024)
    expect(readFileSync(file, 'utf8')).toBe('first\nsecond\n')
    await writeRunnerLog(file, 13, body('third\n'), 1024)
    await writeRunnerLog(file, 13, body(''), 1024)
    expect(readFileSync(file, 'utf8')).toBe('first\nsecond\nthird\n')
  })

  it('answers a conflict with the current size for an offset past the end', async () => {
    const file = path.join(tempFolder(), 'job.log')
    const gap = await refused(writeRunnerLog(file, 4, body('late'), 1024))
    expect(gap.status).toBe(409)
    expect(gap.message).toContain('0 bytes')
    expect(existsSync(file)).toBe(false)
    await writeRunnerLog(file, 0, body('abcd'), 1024)
    const second = await refused(writeRunnerLog(file, 9, body('late'), 1024))
    expect(second.status).toBe(409)
    expect(second.message).toContain('4 bytes')
    expect(readFileSync(file, 'utf8')).toBe('abcd')
  })

  it('refuses a batch that is too large or that breaks off, and leaves the log as it was', async () => {
    const file = path.join(tempFolder(), 'job.log')
    await writeRunnerLog(file, 0, body('abcd'), 8)
    expect((await refused(writeRunnerLog(file, 4, body('123456789'), 8))).status).toBe(400)
    const broken = new Readable({
      read() {
        this.push(Buffer.from('zz'))
        this.destroy(new Error('connection reset'))
      },
    })
    await expect(writeRunnerLog(file, 4, broken, 8)).rejects.toThrow('connection reset')
    expect((await refused(writeRunnerLog(file, -1, body('x'), 8))).status).toBe(400)
    expect(readFileSync(file, 'utf8')).toBe('abcd')
  })

  it('serializes batches that arrive together', async () => {
    const file = path.join(tempFolder(), 'job.log')
    await Promise.all(Array.from({ length: 10 }, () => writeRunnerLog(file, 0, body('0123456789'), 64)))
    expect(readFileSync(file, 'utf8')).toBe('0123456789')
  })

  it('reads the tail: the last lines, and no more than the last bytes', async () => {
    const file = path.join(tempFolder(), 'job.log')
    expect(await tailRunnerLog(file)).toBe('')
    writeFileSync(file, Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n') + '\n')
    const tail = await tailRunnerLog(file)
    expect(tail.split('\n')).toHaveLength(FLEET_RUNNER_TRANSFER_LIMITS.logTailLines)
    expect(tail.endsWith('line 499')).toBe(true)
    expect(tail.startsWith('line 300')).toBe(true)
    expect(await tailRunnerLog(file, 3)).toBe('line 497\nline 498\nline 499')
    // Bytes cut a line in the middle: that line is not shown half.
    const short = await tailRunnerLog(file, 200, 30)
    expect(short.split('\n').every((line) => /^line \d+$/.test(line))).toBe(true)
    expect(short.endsWith('line 499')).toBe(true)
    expect(Buffer.byteLength(short)).toBeLessThanOrEqual(30)
    writeFileSync(file, 'a\nb\nc')
    expect(await tailRunnerLog(file, 10)).toBe('a\nb\nc')
    expect(await tailRunnerLog(file, 0)).toBe('')
  })

  it('does not show half a character at the start of the tail', async () => {
    const file = path.join(tempFolder(), 'job.log')
    writeFileSync(file, '€'.repeat(40))
    const tail = await tailRunnerLog(file, 10, 10)
    expect(tail).not.toContain('\uFFFD')
    expect(/^€*$/.test(tail)).toBe(true)
  })
})
