import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { FLEET_RUNNER_LIMITS } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InstanceHttpError } from '../../src/main/fleet/instance/http'
import { RunnerOutputs } from '../../src/main/fleet/instance/runner-jobs/outputs'
import { cleanTemps, craftArchive, type CraftedEntry, JOB_ID, sha256, tempFolder } from '../helpers/runner-jobs'

afterEach(cleanTemps)

let work: string
let outside: string
let dir: string
let outputs: RunnerOutputs

beforeEach(() => {
  const base = tempFolder()
  work = path.join(base, 'work')
  outside = path.join(base, 'outside')
  dir = path.join(base, 'bot', 'runner-jobs', JOB_ID)
  for (const folder of [work, outside, dir]) mkdirSync(folder, { recursive: true })
  outputs = new RunnerOutputs(JOB_ID, dir)
})

const refused = async (promise: Promise<unknown>): Promise<InstanceHttpError> => {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause
  )
  expect(error).toBeInstanceOf(InstanceHttpError)
  return error as InstanceHttpError
}

/** The archive as bytes, ready to upload. */
async function archive(entries: CraftedEntry[]): Promise<Buffer> {
  const file = path.join(tempFolder(), 'archive.tar.zst')
  await craftArchive(file, entries)
  return readFileSync(file)
}

/** Uploads the archive in chunks and answers what the commit needs. */
async function upload(data: Buffer, chunk = 64 * 1024): Promise<{ bytes: number; sha256: string }> {
  for (let offset = 0; offset < data.length; offset += chunk) {
    const piece = data.subarray(offset, offset + chunk)
    await outputs.chunk(offset, Readable.from([piece]), sha256(piece), piece.length)
  }
  return { bytes: data.length, sha256: sha256(data) }
}

/** Every path under a folder with its kind, links unfollowed. */
function tree(root: string, prefix = ''): string[] {
  return readdirSync(root).flatMap((name) => {
    const relative = prefix ? `${prefix}/${name}` : name
    const info = lstatSync(path.join(root, name))
    if (info.isDirectory()) return [`${relative}/`, ...tree(path.join(root, name), relative)]
    return [info.isSymbolicLink() ? `${relative}@` : relative]
  })
}
const put = (relative: string, content: string, root = work) => {
  const file = path.join(root, ...relative.split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}
const read = (relative: string, root = work) => readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const piece = (text: string) => Readable.from([Buffer.from(text)])

describe('output chunks', () => {
  it('receives an archive in chunks and tells how much it holds', async () => {
    expect(await outputs.status()).toEqual({ received: 0 })
    await outputs.chunk(0, piece('hello '), sha256('hello '), 6)
    expect(await outputs.status()).toEqual({ received: 6 })
    await outputs.chunk(6, piece('world'), sha256('world'), 5)
    expect(await outputs.status()).toEqual({ received: 11 })
    expect(readFileSync(path.join(dir, 'outputs.tar.zst.partial'), 'utf8')).toBe('hello world')
  })

  it('takes a chunk sent again where it was, and resumes at the offset it reports', async () => {
    await outputs.chunk(0, piece('hello '), sha256('hello '), 6)
    await outputs.chunk(6, piece('world'), sha256('world'), 5)
    // The answer to the second was lost: the runner asks, sends the first again, and goes on from what is held.
    await outputs.chunk(0, piece('hello '), sha256('hello '), 6)
    await outputs.chunk(6, piece('world'), sha256('world'), 5)
    expect(await outputs.status()).toEqual({ received: 11 })
    await outputs.chunk(11, piece('!'), sha256('!'), 1)
    expect(readFileSync(path.join(dir, 'outputs.tar.zst.partial'), 'utf8')).toBe('hello world!')
  })

  it('answers a conflict with the size it holds for an offset past it', async () => {
    await outputs.chunk(0, piece('abc'), sha256('abc'), 3)
    const gap = await refused(outputs.chunk(5, piece('xyz'), sha256('xyz'), 3))
    expect(gap.status).toBe(409)
    expect(gap.message).toContain('3 bytes')
    expect(await outputs.status()).toEqual({ received: 3 })
  })

  it('refuses a chunk whose digest or length is wrong, and counts nothing of it', async () => {
    await outputs.chunk(0, piece('abcdef'), sha256('abcdef'), 6)
    const mismatch = await refused(outputs.chunk(6, piece('ghi'), sha256('other'), 3))
    expect(mismatch.status).toBe(400)
    // A bad chunk over held bytes does not change them either.
    await refused(outputs.chunk(0, piece('ZZZ'), sha256('abc'), 3))
    await refused(outputs.chunk(6, piece('gh'), sha256('ghi'), 3))
    await refused(outputs.chunk(6, piece('ghij'), sha256('ghi'), 3))
    await refused(outputs.chunk(6, piece('ghi'), 'NOT-A-DIGEST', 3))
    await refused(outputs.chunk(-1, piece('ghi'), sha256('ghi'), 3))
    await refused(outputs.chunk(6, piece(''), sha256(''), 0))
    expect(await outputs.status()).toEqual({ received: 6 })
    expect(readFileSync(path.join(dir, 'outputs.tar.zst.partial'), 'utf8')).toBe('abcdef')
  })

  it('refuses a chunk that breaks off', async () => {
    const broken = new Readable({
      read() {
        this.push(Buffer.from('ab'))
        this.destroy(new Error('connection reset'))
      },
    })
    await expect(outputs.chunk(0, broken, sha256('abc'), 3)).rejects.toThrow('connection reset')
    expect(await outputs.status()).toEqual({ received: 0 })
  })

  it('refuses what would take the archive past the output limit', async () => {
    const limits = FLEET_RUNNER_LIMITS as { outputBytesMax: number }
    const saved = limits.outputBytesMax
    try {
      limits.outputBytesMax = 8
      await outputs.chunk(0, piece('12345'), sha256('12345'), 5)
      const error = await refused(outputs.chunk(5, piece('6789'), sha256('6789'), 4))
      expect(error.message).toContain('outputs_too_large')
      await outputs.chunk(5, piece('678'), sha256('678'), 3)
      expect(await outputs.status()).toEqual({ received: 8 })
    } finally {
      limits.outputBytesMax = saved
    }
  })

  it('refuses a chunk larger than a chunk may be', async () => {
    const size = FLEET_RUNNER_LIMITS.outputChunkBytes + FLEET_RUNNER_LIMITS.chunkBodySlackBytes + 1
    expect((await refused(outputs.chunk(0, piece(''), sha256(''), size))).status).toBe(400)
  })
})

describe('committing outputs', () => {
  it('extracts the archive into the folder, replaces files and links, and removes nothing else', async () => {
    put('keep.txt', 'untouched')
    put('report.txt', 'old report')
    put('out/old.bin', 'old output')
    put('real.txt', 'target')
    symlinkSync('real.txt', path.join(work, 'latest'))
    const data = await archive([
      { name: 'report.txt', content: 'new report' },
      { name: 'out/', type: 'directory', mode: 0o755 },
      { name: 'out/video.mp4', content: 'frames', mode: 0o755 },
      { name: 'out/sub/a.txt', content: 'deep' },
      { name: 'empty/', type: 'directory' },
      { name: 'latest', type: 'symlink', linkname: 'out/video.mp4' },
      { name: `.maestrly/runner-jobs/${JOB_ID}.log`, content: 'the log' },
    ])
    const { bytes, sha256: digest } = await upload(data, 100)

    const result = await outputs.commit({ bytes, sha256: digest }, work)

    expect(result).toEqual({
      files: [
        { path: '.maestrly/runner-jobs/' + JOB_ID + '.log', size: 7 },
        { path: 'out/sub/a.txt', size: 4 },
        { path: 'out/video.mp4', size: 6 },
        { path: 'report.txt', size: 10 },
      ],
      bytes,
      sha256: digest,
      skipped: 0,
    })
    expect(read('report.txt')).toBe('new report')
    expect(read('keep.txt')).toBe('untouched')
    expect(read('out/old.bin')).toBe('old output')
    expect(read('out/video.mp4')).toBe('frames')
    expect(read('out/sub/a.txt')).toBe('deep')
    expect(read(`.maestrly/runner-jobs/${JOB_ID}.log`)).toBe('the log')
    expect(readlinkSync(path.join(work, 'latest'))).toBe('out/video.mp4')
    expect(read('real.txt')).toBe('target')
    expect(lstatSync(path.join(work, 'empty')).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(statSync(path.join(work, 'out', 'video.mp4')).mode & 0o111).not.toBe(0)
    // Staging and the part are gone; the result is kept for a commit asked for again.
    expect(existsSync(path.join(work, '.maestrly', 'runner-jobs', `${JOB_ID}.staging`))).toBe(false)
    expect(existsSync(path.join(dir, 'outputs.tar.zst.partial'))).toBe(false)
    expect(existsSync(path.join(dir, 'outputs.json'))).toBe(true)
  })

  it('answers the first result to a commit asked for again, and refuses another digest', async () => {
    const data = await archive([{ name: 'a.txt', content: 'first' }])
    const commit = await upload(data)
    const first = await outputs.commit(commit, work)
    writeFileSync(path.join(work, 'a.txt'), 'changed since')
    expect(await outputs.commit(commit, work)).toEqual(first)
    expect(read('a.txt')).toBe('changed since')
    expect((await refused(outputs.commit({ bytes: 3, sha256: sha256('x') }, work))).status).toBe(409)
    // The archive counts as held, so a runner that lost the answer commits again; a chunk sent again changes nothing.
    expect(await outputs.status()).toEqual({ received: data.length })
    await outputs.chunk(0, piece('abc'), sha256('abc'), 3)
    expect(existsSync(path.join(dir, 'outputs.tar.zst.partial'))).toBe(false)
    // Nothing new is taken after it.
    expect((await refused(outputs.chunk(data.length, piece('abc'), sha256('abc'), 3))).status).toBe(409)
  })

  it('waits for an upload that is not whole, and drops one that does not match', async () => {
    const data = await archive([{ name: 'a.txt', content: 'first' }])
    await outputs.chunk(0, Readable.from([data.subarray(0, 10)]), sha256(data.subarray(0, 10)), 10)
    const early = await refused(outputs.commit({ bytes: data.length, sha256: sha256(data) }, work))
    expect(early.status).toBe(409)
    expect(early.message).toContain(`10 of ${data.length}`)
    expect(await outputs.status()).toEqual({ received: 10 })

    await upload(data)
    const wrong = await refused(outputs.commit({ bytes: data.length, sha256: sha256('not it') }, work))
    expect(wrong.status).toBe(400)
    // The upload starts again from nothing.
    expect(await outputs.status()).toEqual({ received: 0 })
    expect(tree(work)).toEqual([])

    await upload(data)
    const larger = await refused(outputs.commit({ bytes: data.length - 1, sha256: sha256(data) }, work))
    expect(larger.status).toBe(400)
    expect(await outputs.status()).toEqual({ received: 0 })
    expect((await refused(outputs.commit({ bytes: 1, sha256: sha256('x') }, work))).status).toBe(409)
  })

  it('answers a conflict for a job folder that is gone', async () => {
    const data = await archive([{ name: 'a.txt', content: 'first' }])
    const commit = await upload(data)
    const error = await refused(outputs.commit(commit, path.join(work, 'gone')))
    expect(error.status).toBe(409)
    // The upload is kept: the folder may come back.
    expect(await outputs.status()).toEqual({ received: data.length })
  })

  it('removes a stale staging folder first and never moves what it held', async () => {
    put(`.maestrly/runner-jobs/${JOB_ID}.staging/stale.txt`, 'stale')
    const data = await archive([{ name: 'a.txt', content: 'fresh' }])
    const result = await outputs.commit(await upload(data), work)
    expect(result.files).toEqual([{ path: 'a.txt', size: 5 }])
    expect(tree(work)).toEqual(['.maestrly/', '.maestrly/runner-jobs/', 'a.txt'])
  })

  it('leaves out an entry meant for the staging folder itself', async () => {
    const data = await archive([
      { name: 'a.txt', content: 'fresh' },
      { name: `.maestrly/runner-jobs/${JOB_ID}.staging/inner.txt`, content: 'inner' },
    ])
    const result = await outputs.commit(await upload(data), work)
    expect(result.files).toEqual([{ path: 'a.txt', size: 5 }])
    // The staging folder and the file in it.
    expect(result.skipped).toBe(2)
    expect(tree(work)).toEqual(['.maestrly/', '.maestrly/runner-jobs/', 'a.txt'])
  })

  it('skips an entry whose destination is a folder, and one behind a file, and counts them', async () => {
    put('report/inside.txt', 'precious')
    put('blocker', 'a file where a folder should be')
    put('plain.txt', 'old')
    const data = await archive([
      { name: 'report', content: 'a file over a folder' },
      { name: 'blocker/', type: 'directory' },
      { name: 'blocker/child.txt', content: 'cannot land' },
      { name: 'plain.txt', content: 'new' },
    ])
    const result = await outputs.commit(await upload(data), work)
    expect(result.files).toEqual([{ path: 'plain.txt', size: 3 }])
    expect(result.skipped).toBe(3)
    expect(read('report/inside.txt')).toBe('precious')
    expect(read('blocker')).toBe('a file where a folder should be')
    expect(read('plain.txt')).toBe('new')
  })

  it('replaces a link with the file the archive holds, and never writes through it', async () => {
    if (process.platform === 'win32') return
    put('target.txt', 'outside original', outside)
    symlinkSync(path.join(outside, 'target.txt'), path.join(work, 'shortcut'))
    const data = await archive([{ name: 'shortcut', content: 'archive content' }])
    await outputs.commit(await upload(data), work)
    expect(lstatSync(path.join(work, 'shortcut')).isSymbolicLink()).toBe(false)
    expect(read('shortcut')).toBe('archive content')
    expect(read('target.txt', outside)).toBe('outside original')
  })

  it('writes through a link that leads to a folder inside the job folder', async () => {
    if (process.platform === 'win32') return
    mkdirSync(path.join(work, 'real'))
    symlinkSync('real', path.join(work, 'alias'))
    const data = await archive([{ name: 'alias/x.txt', content: 'x' }])
    const result = await outputs.commit(await upload(data), work)
    expect(result.files).toEqual([{ path: 'alias/x.txt', size: 1 }])
    expect(result.skipped).toBe(0)
    expect(read('real/x.txt')).toBe('x')
    expect(lstatSync(path.join(work, 'alias')).isSymbolicLink()).toBe(true)
  })

  describe('hostile archives', () => {
    const hostile: Array<[string, CraftedEntry[]]> = [
      ['a path with ..', [{ name: '../evil.txt', content: 'x' }]],
      ['a path that climbs from inside', [{ name: 'a/../../evil.txt', content: 'x' }]],
      ['an absolute path', [{ name: '/tmp/evil.txt', content: 'x' }]],
      ['a link that leaves the folder', [{ name: 'out', type: 'symlink', linkname: '../outside' }]],
      ['an absolute link', [{ name: 'out', type: 'symlink', linkname: '/etc' }]],
      [
        'a link that leaves through another',
        [
          { name: 'hop', type: 'symlink', linkname: 'sub/..' },
          { name: 'out', type: 'symlink', linkname: 'hop/../..' },
        ],
      ],
      ['a hard link', [{ name: 'passwd', type: 'link', linkname: '/etc/passwd' }]],
      ['a device', [{ name: 'dev', type: 'character-device' }]],
      ['a pipe', [{ name: 'pipe', type: 'fifo' }]],
      [
        'a file under a link',
        [
          { name: 'ln', type: 'symlink', linkname: 'sub' },
          { name: 'ln/evil.txt', content: 'x' },
        ],
      ],
      [
        'one path twice',
        [
          { name: 'twice.txt', content: 'one' },
          { name: 'twice.txt', content: 'two' },
        ],
      ],
    ]

    it.each(hostile)('refuses %s and places nothing', async (_name, entries) => {
      put('keep.txt', 'untouched')
      const before = tree(work)
      const data = await archive([{ name: 'good.txt', content: 'good' }, ...entries])
      const commit = await upload(data)
      const error = await refused(outputs.commit(commit, work))
      expect(error.status).toBe(400)
      expect(error.message).toMatch(/refused/)
      expect(tree(work).filter((entry) => !entry.startsWith('.maestrly'))).toEqual(before)
      expect(existsSync(path.join(work, '..', 'evil.txt'))).toBe(false)
      expect(existsSync(path.join(outside, 'evil.txt'))).toBe(false)
      expect(tree(path.join(work, '.maestrly', 'runner-jobs'))).toEqual([])
      // The archive is dropped: the runner starts again from nothing.
      expect(await outputs.status()).toEqual({ received: 0 })
    })

    it('refuses an archive that is not one', async () => {
      const data = Buffer.from('this is not a zstd tar archive at all')
      const error = await refused(outputs.commit(await upload(data), work))
      expect(error.status).toBe(400)
    })

    it('refuses to write through a link that was already in the folder and leads out of it', async () => {
      if (process.platform === 'win32') return
      symlinkSync(outside, path.join(work, 'out'))
      const data = await archive([
        { name: 'safe.txt', content: 'would be placed' },
        { name: 'out/', type: 'directory' },
        { name: 'out/pwn.txt', content: 'escape' },
      ])
      const error = await refused(outputs.commit(await upload(data), work))
      expect(error.status).toBe(400)
      expect(error.message).toContain('outside the job folder')
      expect(readdirSync(outside)).toEqual([])
      // Checked before anything moves.
      expect(existsSync(path.join(work, 'safe.txt'))).toBe(false)
      expect(tree(path.join(work, '.maestrly', 'runner-jobs'))).toEqual([])
    })

    it('refuses a deeper path behind such a link, however far down', async () => {
      if (process.platform === 'win32') return
      symlinkSync(outside, path.join(work, 'out'))
      const data = await archive([{ name: 'out/a/b/c.txt', content: 'escape' }])
      expect((await refused(outputs.commit(await upload(data), work))).status).toBe(400)
      expect(readdirSync(outside)).toEqual([])
    })

    it('does not make its staging folder through a link that leads out of the job folder', async () => {
      if (process.platform === 'win32') return
      symlinkSync(outside, path.join(work, '.maestrly'))
      const data = await archive([{ name: 'a.txt', content: 'x' }])
      const error = await refused(outputs.commit(await upload(data), work))
      expect(error.status).toBe(400)
      expect(readdirSync(outside)).toEqual([])
    })

    it('does not place anything behind a link that leads nowhere', async () => {
      if (process.platform === 'win32') return
      symlinkSync(path.join(outside, 'nothing-here'), path.join(work, 'dangling'))
      const data = await archive([{ name: 'dangling/x.txt', content: 'x' }])
      const result = await outputs.commit(await upload(data), work)
      // The folder the archive implies, and the file in it.
      expect(result.skipped).toBe(2)
      expect(result.files).toEqual([])
      expect(readdirSync(outside)).toEqual([])
    })
  })
})
