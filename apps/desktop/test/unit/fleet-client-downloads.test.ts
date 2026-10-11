import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FleetApiClient } from '../../src/main/fleet/client/api'
import { saveFleetFile, sanitizeFleetFilename } from '../../src/main/fleet/client/downloads'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'fleet-download-'))
  directories.push(path)
  return path
}
const ref = { id: 'file', name: 'report.pdf', mediaType: 'application/pdf', byteSize: 3 }
function api(data: Uint8Array, byteSize = data.length) {
  return { openFile: async () => ({ ref: { ...ref, byteSize }, response: new Response(new Uint8Array(data)) }) }
}
it('preserves exact bytes and existing files, including empty downloads', async () => {
  const path = await directory()
  await writeFile(join(path, 'report.pdf'), 'original')
  const saved = await saveFleetFile(api(new Uint8Array([0, 255, 4])), 'bot', 'file', { downloadsPath: () => path })
  expect(saved).toBe(join(path, 'report (1).pdf'))
  expect(await readFile(saved)).toEqual(Buffer.from([0, 255, 4]))
  expect(await readFile(join(path, 'report.pdf'), 'utf8')).toBe('original')
  const empty = await saveFleetFile(api(new Uint8Array()), 'bot', 'file', { downloadsPath: () => path })
  expect((await readFile(empty)).length).toBe(0)
  expect((await readdir(path)).some((name) => name.endsWith('.partial'))).toBe(false)
})
it.each([1, 5])('removes partial files on byte mismatch (%s)', async (size) => {
  const path = await directory()
  await expect(
    saveFleetFile(api(new Uint8Array([1, 2, 3]), size), 'bot', 'file', { downloadsPath: () => path })
  ).rejects.toThrow()
  expect(await readdir(path)).toEqual([])
})
it('cancels a stalled transfer and cleans up on disconnect', async () => {
  const path = await directory()
  const controller = new AbortController()
  const cancel = vi.fn()
  const source = { openFile: async () => ({ ref, response: new Response(new ReadableStream({ cancel })) }) }
  const saving = saveFleetFile(source, 'bot', 'file', { downloadsPath: () => path, signal: controller.signal })
  await vi.waitFor(async () => expect(await readdir(path)).toHaveLength(1))
  controller.abort()
  await expect(saving).rejects.toThrow()
  expect(cancel).toHaveBeenCalled()
  expect(await readdir(path)).toEqual([])
})
it('sanitizes platform reserved names and traversal', () => {
  for (const name of ['../file.txt', '..\\file.txt', 'CON.txt', 'NUL', '...', 'a\u0000b']) {
    const safe = sanitizeFleetFilename(name)
    expect(safe).not.toMatch(/[\\/\x00]/)
    expect(safe).not.toMatch(/^(CON|NUL)(\.|$)/)
    expect(safe).not.toBe('..')
  }
  for (const name of ['a'.repeat(196) + '.pdf', '報'.repeat(80) + '.xlsx']) {
    const safe = sanitizeFleetFilename(name)
    expect(safe).toMatch(name.endsWith('.pdf') ? /\.pdf$/ : /\.xlsx$/)
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(180)
  }
})
it('validates metadata and streamed lengths and sends auth with redirects disabled', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(ref))
    .mockResolvedValueOnce(
      new Response(new Uint8Array([0, 255, 4]), { headers: { 'content-type': ref.mediaType, 'content-length': '3' } })
    )
  vi.stubGlobal('fetch', fetcher)
  const opened = await new FleetApiClient('http://localhost', 'credential').openFile('bot', 'file')
  expect(new Uint8Array(await opened.response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 4]))
  for (const [, options] of fetcher.mock.calls) expect(options.redirect).toBe('error')
  expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer credential')
})
it.each([0, 2, 4])('rejects incomplete or oversized streams (%s)', async (size) => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(ref))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(size), { headers: { 'content-type': ref.mediaType, 'content-length': '3' } })
      )
  )
  const opened = await new FleetApiClient('http://localhost').openFile('bot', 'file')
  await expect(opened.response.arrayBuffer()).rejects.toThrow()
})
it.each([null, '4'])('rejects missing or inconsistent content lengths (%s)', async (length) => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(ref))
      .mockResolvedValueOnce(
        new Response('abc', {
          headers: { 'content-type': ref.mediaType, ...(length === null ? {} : { 'content-length': length }) },
        })
      )
  )
  await expect(new FleetApiClient('http://localhost').openFile('bot', 'file')).rejects.toThrow('Invalid file response')
})
it('reports revoked authentication', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(ref))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
  )
  await expect(new FleetApiClient('http://localhost').openFile('bot', 'file')).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
})
