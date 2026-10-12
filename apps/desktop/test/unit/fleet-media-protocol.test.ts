import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FleetMediaUrls,
  parseByteRange,
  parseFleetMediaUrl,
  serveFleetMedia,
} from '../../src/main/fleet/client/media-protocol'
import type { FleetMediaEntry } from '../../src/main/fleet/client/media-cache'
import { fleetVideoMediaType, isFleetVideo } from '../../src/shared/fleet-media'

let folder: string
let entry: FleetMediaEntry
const bytes = Buffer.from(Array.from({ length: 100 }, (_, index) => index))
const capability = 'a'.repeat(32)
const url = `maestrly-media://fleet/bot/f-clip/${capability}`

beforeAll(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'fleet-media-protocol-'))
  const file = path.join(folder, 'clip.media')
  await writeFile(file, bytes)
  entry = {
    path: file,
    mediaType: 'video/mp4',
    ref: { id: 'f-clip', name: 'clip.mp4', mediaType: 'video/mp4', byteSize: 100 },
  }
})
afterAll(async () => {
  await rm(folder, { recursive: true, force: true })
})

async function serve(init: RequestInit = {}, target = url, resolved: FleetMediaEntry | null = entry) {
  const resolve = vi.fn(async () => resolved)
  const response = await serveFleetMedia(new Request(target, init), resolve)
  return { response, resolve, body: Buffer.from(await response.arrayBuffer()) }
}

describe('fleet video detection', () => {
  it.each([
    [{ name: 'a.mp4', mediaType: 'video/mp4' }, 'video/mp4'],
    [{ name: 'a.bin', mediaType: 'video/webm' }, 'video/webm'],
    [{ name: 'A.MOV', mediaType: 'application/octet-stream' }, 'video/quicktime'],
    [{ name: 'a.m4v', mediaType: 'application/octet-stream' }, 'video/mp4'],
    [{ name: 'a.webm', mediaType: 'application/octet-stream' }, 'video/webm'],
    [{ name: 'a.mp4', mediaType: 'application/pdf' }, null],
    [{ name: 'a.pdf', mediaType: 'application/octet-stream' }, null],
    [{ name: 'mp4', mediaType: 'application/octet-stream' }, null],
    [{ name: 'a.gif', mediaType: 'image/gif' }, null],
  ])('%o plays as %s', (file, expected) => {
    expect(fleetVideoMediaType(file)).toBe(expected)
    expect(isFleetVideo(file)).toBe(expected !== null)
  })
})

describe('fleet media URLs', () => {
  it('binds a capability to the pairing, the bot and the file', () => {
    const urls = new FleetMediaUrls()
    const parsed = parseFleetMediaUrl(urls.url('device', 'bot', 'f-clip'))
    expect(parsed).toMatchObject({ botId: 'bot', fileId: 'f-clip' })
    expect(urls.verify('device', parsed!)).toBe(true)
    expect(urls.verify('other-device', parsed!)).toBe(false)
    expect(urls.verify('device', { ...parsed!, botId: 'other' })).toBe(false)
    expect(urls.verify('device', { ...parsed!, fileId: 'f-other' })).toBe(false)
    expect(urls.verify('device', { ...parsed!, capability: '0'.repeat(32) })).toBe(false)
    // Another run of the app cannot reuse a URL.
    expect(new FleetMediaUrls().verify('device', parsed!)).toBe(false)
  })

  it.each([
    'maestrly-media://fleet/bot/f-clip',
    'maestrly-media://fleet/bot/f-clip/short',
    `maestrly-media://other/bot/f-clip/${capability}`,
    `maestrly-media://fleet/Bad_Bot/f-clip/${capability}`,
    `maestrly-media://fleet/bot/..%2Fsecret/${capability}`,
    `maestrly-media://fleet/bot/f-clip/${capability}/extra`,
    `maestrly-media://fleet/bot/f-clip/${capability}?x=1`,
    `https://fleet/bot/f-clip/${capability}`,
    'not a url',
  ])('rejects %s', (value) => {
    expect(parseFleetMediaUrl(value)).toBeNull()
  })
})

describe('byte ranges', () => {
  it.each([
    [null, null],
    ['bytes=0-', { start: 0, end: 99 }],
    ['bytes=10-19', { start: 10, end: 19 }],
    ['bytes=90-500', { start: 90, end: 99 }],
    ['bytes=-10', { start: 90, end: 99 }],
    ['bytes=-500', { start: 0, end: 99 }],
    ['bytes=100-', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'],
    ['bytes=20-10', null],
    ['bytes=0-1,5-6', null],
    ['items=0-1', null],
    ['bytes=-', null],
    ['bytes=99999999999999999999-', null],
  ])('%s', (header, expected) => {
    expect(parseByteRange(header, 100)).toEqual(expected)
  })
  it('cannot satisfy any range of an empty file', () => {
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=-1', 0)).toBe('unsatisfiable')
  })
})

describe('serving cached videos', () => {
  it('sends the whole file with its type and range support', async () => {
    const { response, body, resolve } = await serve()
    expect(response.status).toBe(200)
    expect(body).toEqual(bytes)
    expect(resolve).toHaveBeenCalledWith({ botId: 'bot', fileId: 'f-clip', capability })
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'video/mp4',
      'content-length': '100',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
  })

  it('sends a requested range as partial content', async () => {
    const { response, body } = await serve({ headers: { Range: 'bytes=10-19' } })
    expect(response.status).toBe(206)
    expect(body).toEqual(bytes.subarray(10, 20))
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(response.headers.get('content-length')).toBe('10')
    const tail = await serve({ headers: { Range: 'bytes=-5' } })
    expect(tail.response.status).toBe(206)
    expect(tail.body).toEqual(bytes.subarray(95))
  })

  it('answers an unsatisfiable range with 416', async () => {
    const { response, body } = await serve({ headers: { Range: 'bytes=100-' } })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */100')
    expect(body.length).toBe(0)
  })

  it('answers HEAD without a body', async () => {
    const { response, body } = await serve({ method: 'HEAD', headers: { Range: 'bytes=0-9' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-length')).toBe('10')
    expect(body.length).toBe(0)
  })

  it('refuses other methods, malformed URLs and unknown capabilities without reading files', async () => {
    expect((await serve({ method: 'POST' })).response.status).toBe(405)
    const malformed = await serve({}, 'maestrly-media://fleet/bot/../secret')
    expect(malformed.response.status).toBe(404)
    expect(malformed.resolve).not.toHaveBeenCalled()
    expect((await serve({}, url, null)).response.status).toBe(404)
  })

  it('answers 404 when the cached copy is gone or has another size, and 502 when fetching it fails', async () => {
    expect((await serve({}, url, { ...entry, path: path.join(folder, 'missing') })).response.status).toBe(404)
    expect((await serve({}, url, { ...entry, ref: { ...entry.ref, byteSize: 99 } })).response.status).toBe(404)
    const failing = await serveFleetMedia(new Request(url), async () => {
      throw new Error('offline')
    })
    expect(failing.status).toBe(502)
  })
})
