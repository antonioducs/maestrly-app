import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import tar from 'tar-stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractTarGz, extractZip } from '../../src/main/runtime-assets/archive'
import { createHttpsDownloader } from '../../src/main/runtime-assets/downloader'
import type { RuntimeAssetTarget } from '../../src/main/runtime-assets/registry'

let temporary: string
beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'runtime-archive-'))
})
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true })
})

async function tarFixture(
  entries: Array<{ name: string; body?: string; type?: 'file' | 'symlink' | 'link' | 'character-device' }>
): Promise<string> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  pack.on('data', (chunk) => chunks.push(chunk))
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) =>
      pack.entry(
        {
          name: entry.name,
          type: entry.type ?? 'file',
          linkname: entry.type === 'symlink' || entry.type === 'link' ? '/tmp/target' : undefined,
        },
        entry.body ?? '',
        (error) => (error ? reject(error) : resolve())
      )
    )
  }
  pack.finalize()
  await new Promise<void>((resolve, reject) => pack.once('end', resolve).once('error', reject))
  const file = path.join(temporary, 'fixture.tgz')
  await writeFile(file, gzipSync(Buffer.concat(chunks)))
  return file
}

function storedZip(name: string, body = 'data', unixMode = 0o100644): Buffer {
  const nameBuffer = Buffer.from(name)
  const data = Buffer.from(body)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(0, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuffer.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0x031e, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(0, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBuffer.length, 28)
  central.writeUInt32LE((unixMode << 16) >>> 0, 38)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + nameBuffer.length, 12)
  eocd.writeUInt32LE(local.length + nameBuffer.length + data.length, 16)
  return Buffer.concat([local, nameBuffer, data, central, nameBuffer, eocd])
}

describe('safe streaming archive extraction', () => {
  it('streams a tar.gz subtree and strips its package prefix', async () => {
    const archive = await tarFixture([
      { name: 'package/vendor/triple/bin/tool', body: 'ok' },
      { name: 'other/no', body: 'no' },
    ])
    const output = path.join(temporary, 'out')
    await extractTarGz(archive, output, { stripPrefix: 'package/vendor/triple' })
    expect(await readFile(path.join(output, 'bin/tool'), 'utf8')).toBe('ok')
    expect(existsSync(path.join(output, 'other'))).toBe(false)
  })

  it.each([
    { name: '../escape', type: 'file' as const },
    { name: 'inside/../traversal', type: 'file' as const },
    { name: '/absolute', type: 'file' as const },
    { name: '..\\escape', type: 'file' as const },
    { name: 'C:escape', type: 'file' as const },
    { name: 'nested/file:stream', type: 'file' as const },
    { name: 'nested/.. /escape', type: 'file' as const },
    { name: 'safe/link', type: 'symlink' as const },
    { name: 'safe/hardlink', type: 'link' as const },
    { name: 'safe/device', type: 'character-device' as const },
  ])('rejects unsafe tar entry $name', async (entry) => {
    const archive = await tarFixture([entry])
    await expect(extractTarGz(archive, path.join(temporary, 'bad'))).rejects.toThrow(/unsafe|unsupported/i)
    expect(existsSync(path.join(temporary, 'escape'))).toBe(false)
  })

  it('extracts a stored zip and rejects traversal and symlinks', async () => {
    const good = path.join(temporary, 'good.zip')
    await writeFile(good, storedZip('bin/tool', 'zip-ok'))
    await extractZip(good, path.join(temporary, 'zip-out'))
    expect(await readFile(path.join(temporary, 'zip-out/bin/tool'), 'utf8')).toBe('zip-ok')

    for (const [name, mode] of [
      ['../escape', 0o100644],
      ['link', 0o120777],
    ] as const) {
      const bad = path.join(temporary, `${mode}.zip`)
      await writeFile(bad, storedZip(name, 'x', mode))
      await expect(extractZip(bad, path.join(temporary, `out-${mode}`))).rejects.toThrow(
        /unsafe|unsupported|invalid relative/i
      )
    }
  })
})

describe('HTTPS downloader', () => {
  const target = (digest: string): RuntimeAssetTarget => ({
    id: 'mac-arm64',
    url: 'https://allowed.test/file',
    archive: 'zip',
    downloadBytes: 10,
    unpackedBytes: 10,
    hash: { algorithm: 'sha256', encoding: 'hex', digest },
    criticalPaths: ['tool'],
    maxDownloadBytes: 20,
  })

  it('streams to disk, hashes incrementally, and reports progress', async () => {
    const body = Buffer.from('streamed-body')
    const fetchMock = vi.fn(
      async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
    )
    const progress = vi.fn()
    const downloader = createHttpsDownloader({
      fetch: fetchMock as typeof fetch,
      allowedHosts: new Set(['allowed.test']),
    })
    const result = await downloader(
      target(createHash('sha256').update(body).digest('hex')),
      path.join(temporary, 'download'),
      {
        signal: new AbortController().signal,
        onProgress: progress,
      }
    )
    expect(result).toMatchObject({ bytes: body.length })
    expect(progress).toHaveBeenLastCalledWith(body.length, body.length)
    expect(await readFile(path.join(temporary, 'download'), 'utf8')).toBe('streamed-body')
  })

  it('rejects an oversized Content-Length before creating the destination', async () => {
    const body = Buffer.from('oversized-body')
    const fetchMock = vi.fn(
      async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
    )
    const downloader = createHttpsDownloader({
      fetch: fetchMock as typeof fetch,
      allowedHosts: new Set(['allowed.test']),
    })
    const destination = path.join(temporary, 'oversized-download')

    await expect(
      downloader({ ...target('x'), maxDownloadBytes: body.length - 1 }, destination, {
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/exceeds maximum/i)
    expect(existsSync(destination)).toBe(false)
  })

  it('aborts a chunked response when the stream crosses the cap', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('under'))
        controller.enqueue(Buffer.from('cap-plus'))
        controller.close()
      },
    })
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
    const downloader = createHttpsDownloader({
      fetch: fetchMock as typeof fetch,
      allowedHosts: new Set(['allowed.test']),
    })
    const destination = path.join(temporary, 'chunked-download')

    await expect(
      downloader({ ...target('x'), maxDownloadBytes: 8 }, destination, {
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/exceeds maximum/i)
    expect((await readFile(destination)).length).toBeLessThanOrEqual(8)
  })

  it('rejects HTTP and redirects to non-allowlisted hosts', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/file' } })
    )
    const downloader = createHttpsDownloader({
      fetch: fetchMock as typeof fetch,
      allowedHosts: new Set(['allowed.test']),
    })
    await expect(
      downloader({ ...target('x'), url: 'http://allowed.test/file' }, path.join(temporary, 'a'), {
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/not allowed/i)
    await expect(
      downloader(target('x'), path.join(temporary, 'b'), { signal: new AbortController().signal })
    ).rejects.toThrow(/not allowed/i)
  })
})
