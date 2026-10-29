import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import path from 'node:path'
import { FLEET_RUNNER_LIMITS } from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { RunnerJobError } from '../../src/main/runner/errors'
import { collectRunnerOutputs, packRunnerOutputs, runnerGlobToRegExp } from '../../src/main/runner/outputs'
import { cleanTempDirs, environmentOfFolder, readZstdTar, sha256Hex, tempDir, writeFiles } from '../helpers/runner-core'

afterEach(cleanTempDirs)
const posix = process.platform === 'win32' ? it.skip : it

describe('runner output globs', () => {
  const matches = (glob: string, ...paths: string[]) => paths.map((p) => runnerGlobToRegExp(glob).test(p))

  it('keeps * inside one segment and lets ** cross segments', () => {
    expect(matches('*.mp4', 'a.mp4', 'dir/a.mp4', 'a.mp4x')).toEqual([true, false, false])
    expect(matches('out/*', 'out/a', 'out/a/b', 'out')).toEqual([true, false, false])
    expect(matches('out/**', 'out/a', 'out/a/b/c', 'out', 'outside/a')).toEqual([true, true, false, false])
    expect(matches('**/*.png', 'a.png', 'x/y/a.png', 'x/a.jpg')).toEqual([true, true, false])
    expect(matches('a/**/z', 'a/z', 'a/b/z', 'a/b/c/z', 'a/zz')).toEqual([true, true, true, false])
    expect(matches('**', 'a', 'a/b', '.hidden/x')).toEqual([true, true, true])
  })
  it('supports ?, classes and alternatives, and matches dot files', () => {
    expect(matches('file?.txt', 'file1.txt', 'file12.txt', 'file/.txt')).toEqual([true, false, false])
    expect(matches('f[0-2].log', 'f1.log', 'f5.log')).toEqual([true, false])
    expect(matches('f[!0-2].log', 'f1.log', 'f5.log')).toEqual([false, true])
    expect(matches('*.{png,jpg}', 'a.png', 'b.jpg', 'c.gif')).toEqual([true, true, false])
    expect(matches('{a,b/{c,d}}/x', 'a/x', 'b/c/x', 'b/d/x', 'b/e/x')).toEqual([true, true, true, false])
    expect(matches('out/*', 'out/.env')).toEqual([true])
  })
  it('treats regular expression characters literally and ignores ./ and a trailing /', () => {
    expect(matches('a+b(1).txt', 'a+b(1).txt', 'aab(1).txt')).toEqual([true, false])
    expect(matches('./dist/', 'dist')).toEqual([true])
    expect(matches('{literal', '{literal')).toEqual([true])
  })
})

describe('collecting the outputs of a job', () => {
  async function jobWith(inputs: Record<string, string>) {
    const input = tempDir()
    writeFiles(input, inputs)
    const { manifest } = await environmentOfFolder(input)
    const work = tempDir()
    writeFiles(work, inputs)
    return { manifest, work }
  }

  it('takes the files the globs name and drops the ones whose content is an input', async () => {
    const { manifest, work } = await jobWith({
      'in.txt': 'input',
      'out/same.txt': 'same as the input',
      'out/edited.txt': 'before',
      'out/same-size.txt': 'aaaa',
    })
    writeFiles(work, {
      'out/edited.txt': 'after!',
      'out/same-size.txt': 'bbbb',
      'out/new.txt': 'new',
      'out/deep/er.txt': 'deeper',
      'other.txt': 'not asked for',
    })
    const entries = await collectRunnerOutputs(work, ['out/**'], manifest)
    expect(entries.map((entry) => entry.path)).toEqual([
      'out/deep/er.txt',
      'out/edited.txt',
      'out/new.txt',
      'out/same-size.txt',
    ])
    expect(entries.find((entry) => entry.path === 'out/new.txt')).toMatchObject({ kind: 'file', size: 3 })
  })

  it('takes everything under a folder a glob names, dot files included', async () => {
    const { manifest, work } = await jobWith({})
    writeFiles(work, { 'dist/a.js': 'a', 'dist/sub/.hidden': 'h', 'src/b.js': 'b' })
    expect((await collectRunnerOutputs(work, ['dist'], manifest)).map((entry) => entry.path)).toEqual([
      'dist/a.js',
      'dist/sub/.hidden',
    ])
    expect((await collectRunnerOutputs(work, ['**/*.js', 'nothing/**'], manifest)).map((entry) => entry.path)).toEqual([
      'dist/a.js',
      'src/b.js',
    ])
  })

  it("never takes the runner's temporary folder, unless the inputs brought one", async () => {
    const { manifest, work } = await jobWith({})
    writeFiles(work, { '.tmp/scratch': 's', 'real.txt': 'r' })
    expect((await collectRunnerOutputs(work, ['**'], manifest)).map((entry) => entry.path)).toEqual(['real.txt'])
    const own = await jobWith({ '.tmp/kept': 'k' })
    writeFiles(own.work, { '.tmp/kept': 'changed' })
    expect((await collectRunnerOutputs(own.work, ['**'], own.manifest)).map((entry) => entry.path)).toEqual([
      '.tmp/kept',
    ])
  })

  posix('takes links that stay inside the folder and refuses the ones that leave it', async () => {
    const { manifest, work } = await jobWith({ 'in.txt': 'input' })
    mkdirSync(path.join(work, 'out'))
    writeFiles(work, { 'out/result.txt': 'result' })
    symlinkSync('result.txt', path.join(work, 'out/inside'))
    symlinkSync('../in.txt', path.join(work, 'out/to-input'))
    symlinkSync('../../outside.txt', path.join(work, 'out/escapes'))
    symlinkSync('/etc/passwd', path.join(work, 'out/absolute'))
    symlinkSync('/somewhere/runner/caches/scope/npm', path.join(work, 'out/cache'))
    const entries = await collectRunnerOutputs(work, ['out/**'], manifest)
    expect(entries.map((entry) => entry.path)).toEqual(['out/inside', 'out/result.txt', 'out/to-input'])
    expect(entries.find((entry) => entry.path === 'out/inside')).toEqual({
      kind: 'symlink',
      path: 'out/inside',
      target: 'result.txt',
    })
  })

  posix('does not walk into a linked cache, and drops a link that is the same as the input', async () => {
    const { manifest, work } = await jobWith({})
    const cache = tempDir()
    writeFiles(cache, { 'pkg/index.js': 'big' })
    symlinkSync(cache, path.join(work, 'node_modules'))
    writeFiles(work, { 'result.txt': 'r' })
    expect((await collectRunnerOutputs(work, ['**'], manifest)).map((entry) => entry.path)).toEqual(['result.txt'])

    const input = tempDir()
    writeFiles(input, { 'real.txt': 'r' })
    symlinkSync('real.txt', path.join(input, 'alias'))
    const env = await environmentOfFolder(input)
    const job = tempDir()
    writeFiles(job, { 'real.txt': 'r' })
    symlinkSync('real.txt', path.join(job, 'alias'))
    expect(await collectRunnerOutputs(job, ['**'], env.manifest)).toEqual([])
  })
})

describe('packing the outputs of a job', () => {
  it('writes a zstd tar of the files at their relative paths, with the extras, and describes it', async () => {
    const work = tempDir()
    writeFiles(work, { 'out/a.txt': 'alpha', 'out/deep/b.bin': 'bravo', 'out/empty.txt': '' })
    if (process.platform !== 'win32') {
      chmodSync(path.join(work, 'out/a.txt'), 0o755)
      symlinkSync('a.txt', path.join(work, 'out/link'))
    }
    const entries = await collectRunnerOutputs(work, ['out/**'], { jobId: 'job_x', entries: [], bytes: 0, skipped: 0 })
    const log = path.join(tempDir(), 'job.log')
    writeFileSync(log, 'log line\n')
    const outFile = path.join(tempDir(), 'outputs.tar.zst')
    const packed = await packRunnerOutputs(work, entries, outFile, {
      extras: [{ name: '.maestrly/runner-jobs/job_x.log', file: log }],
    })

    const archive = readFileSync(outFile)
    expect(packed.bytes).toBe(archive.length)
    expect(packed.sha256).toBe(sha256Hex(archive))
    expect(packed.files.map((file) => file.path)).toEqual(entries.map((entry) => entry.path))
    expect(packed.files.find((file) => file.path === 'out/deep/b.bin')?.size).toBe(5)

    const read = await readZstdTar(archive)
    const byName = new Map(read.map((entry) => [entry.name, entry]))
    expect(byName.get('out/a.txt')?.content.toString()).toBe('alpha')
    expect(byName.get('out/deep/b.bin')?.content.toString()).toBe('bravo')
    expect(byName.get('out/empty.txt')?.content.length).toBe(0)
    expect(byName.get('.maestrly/runner-jobs/job_x.log')?.content.toString()).toBe('log line\n')
    if (process.platform !== 'win32') {
      expect((byName.get('out/a.txt')?.mode ?? 0) & 0o777).toBe(0o755)
      expect(byName.get('out/link')).toMatchObject({ type: 'symlink', linkname: 'a.txt' })
    }
    // Only what was asked: no folder entries, nothing else.
    expect(read.every((entry) => entry.type === 'file' || entry.type === 'symlink')).toBe(true)
  })

  it('leaves out a file that went away between listing and packing', async () => {
    const work = tempDir()
    writeFiles(work, { 'out/stays.txt': 'stays', 'out/goes.txt': 'goes' })
    const entries = await collectRunnerOutputs(work, ['out/**'], { jobId: 'job_x', entries: [], bytes: 0, skipped: 0 })
    rmSync(path.join(work, 'out/goes.txt'))
    const outFile = path.join(tempDir(), 'outputs.tar.zst')
    const packed = await packRunnerOutputs(work, entries, outFile)
    expect(packed.files.map((file) => file.path)).toEqual(['out/stays.txt'])
    expect((await readZstdTar(readFileSync(outFile))).map((entry) => entry.name)).toEqual(['out/stays.txt'])
  })

  // NTFS gives a 50 GiB file its space instead of leaving it sparse.
  it.skipIf(process.platform === 'win32')(
    'refuses more output bytes than the limit, with the code outputs_too_large, and writes nothing',
    async () => {
      const work = tempDir()
      mkdirSync(path.join(work, 'out'))
      // A sparse file: it claims the bytes without taking them.
      const big = path.join(work, 'out/huge.bin')
      closeSync(openSync(big, 'w'))
      truncateSync(big, FLEET_RUNNER_LIMITS.outputBytesMax + 1)
      if (statSync(big).size <= FLEET_RUNNER_LIMITS.outputBytesMax) return
      const entries = await collectRunnerOutputs(work, ['out/**'], {
        jobId: 'job_x',
        entries: [],
        bytes: 0,
        skipped: 0,
      })
      const outFile = path.join(tempDir(), 'outputs.tar.zst')
      const error = await packRunnerOutputs(work, entries, outFile).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(RunnerJobError)
      expect((error as RunnerJobError).code).toBe('outputs_too_large')
      expect(() => statSync(outFile)).toThrow()
    }
  )
})
