import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_METHODS,
  type AdminMethod,
  ArtifactHostError,
  type ArtifactHost,
  callAdmin,
  createRemoteAdmin,
  fromWire,
  openArtifactHost,
  toWire,
  UPLOAD_METHODS,
} from '../src/index.js'
import { tempDir, utf8 } from './helpers.js'

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
let host: ArtifactHost
let cleanup: () => void
beforeEach(async () => {
  const temp = tempDir()
  cleanup = temp.cleanup
  host = await openArtifactHost({ dataDir: temp.dir, port: 0, quotaBytes: 1024 * 1024 })
})
afterEach(async () => {
  await host.close()
  cleanup()
})
const input = () => ({
  title: 'Remote',
  owner: { kind: 'local' as const, id: 'local' },
  origin: { workspaceId: null, conversationId: null, conversationTitle: null },
  files: [
    { path: 'index.html', bytes: utf8('<p>Remote</p>') },
    { path: 'data.png', bytes: Buffer.from([0, 127, 128, 255]) },
  ],
})
const options = { allowed: ADMIN_METHODS }

describe('remote admin JSON transport', () => {
  it('roundtrips binary data, optional arguments and void results against a real host', async () => {
    const sent: unknown[][] = []
    const client = createRemoteAdmin(async (method, args) => {
      sent.push(args)
      return json(await callAdmin(host.admin, method, json(args), options))
    })
    const created = await client.create(input())
    expect((await client.readFile(created.id, 1, 'data.png'))?.bytes).toEqual(new Uint8Array([0, 127, 128, 255]))
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    expect(await client.setThumbnail(created.id, 1, image)).toBeUndefined()
    expect((await client.getThumbnail(created.id, undefined))?.bytes).toEqual(new Uint8Array(image))
    expect(sent.at(-1)).toEqual([created.id])
    expect(await client.list(undefined)).toHaveLength(1)
    expect(sent.at(-1)).toEqual([])
    await client.update({ id: created.id, baseVersion: 1, change: { kind: 'replace', files: input().files } })
    await expect(
      client.update({ id: created.id, baseVersion: 1, change: { kind: 'replace', files: input().files } })
    ).rejects.toMatchObject({ code: 'version_conflict', details: { currentVersion: 2 } })
  })

  it('checks both the allowlist and real method list, and caps argument count', async () => {
    for (const [method, args, allowed] of [
      ['snapshot', ['unused.sqlite'], UPLOAD_METHODS],
      ['constructor', [], ['constructor'] as unknown as AdminMethod[]],
      ['status', [1, 2, 3, 4], ADMIN_METHODS],
      ['status', {}, ADMIN_METHODS],
    ] as const) {
      expect(await callAdmin(host.admin, method, args, { allowed })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      })
    }
  })

  it('runs a guard after decoding and preserves schema validation and refusal errors', async () => {
    const result = await callAdmin(host.admin, 'create', toWire([input()]), {
      allowed: UPLOAD_METHODS,
      guard: async (method, args) => {
        expect(method).toBe('create')
        expect((args[0] as ReturnType<typeof input>).files[0]?.bytes).toBeInstanceOf(Uint8Array)
        return [{ ...(args[0] as object), title: 'Rewritten' }]
      },
    })
    expect(result).toMatchObject({ ok: true, value: { title: 'Rewritten' } })
    expect(
      await callAdmin(host.admin, 'create', toWire([input()]), {
        allowed: UPLOAD_METHODS,
        guard: () => [{ ...input(), title: '' }],
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(
      await callAdmin(host.admin, 'status', [], {
        ...options,
        guard: () => {
          throw new ArtifactHostError('host_unavailable', 'Refused')
        },
      })
    ).toMatchObject({ ok: false, error: { code: 'host_unavailable' } })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(
        await callAdmin(host.admin, 'status', [], {
          ...options,
          guard: () => {
            throw new Error('https://private.example/body')
          },
        })
      ).toMatchObject({ ok: false, error: { code: 'internal' } })
      expect(JSON.stringify(log.mock.calls)).not.toContain('private.example')
    } finally {
      log.mockRestore()
    }
  })
})

describe('wire codec', () => {
  it('preserves undefined, nested bytes and prototype keys over JSON', () => {
    const value = JSON.parse('{"__proto__":{"safe":true},"constructor":"data"}')
    const decoded = fromWire(json(toWire(value))) as object
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true)
    expect(decoded).toEqual(value)
    expect(fromWire(json(toWire([undefined, { optional: undefined, bytes: Buffer.from([0, 255]) }])))).toEqual([
      undefined,
      { optional: undefined, bytes: new Uint8Array([0, 255]) },
    ])
    expect(fromWire({ $bytes: 'AA==', extra: true })).toEqual({ $bytes: 'AA==', extra: true })
    expect(fromWire({ $bytes: '' })).toEqual(new Uint8Array())
  })

  it.each(['A', 'AAA', '!!!!', 'AA==\n', 'AA-_', 'AB==', 'AAB=', 'AA===', 1, null])(
    'rejects invalid base64 %j',
    async (value) => {
      expect(() => fromWire({ $bytes: value })).toThrow(ArtifactHostError)
      expect(await callAdmin(host.admin, 'create', [{ $bytes: value }], options)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      })
    }
  )

  it('limits nesting in both directions', async () => {
    let value: unknown = 1
    for (let depth = 0; depth < 16; depth++) value = [value]
    expect(fromWire(toWire(value))).toEqual(value)
    expect(() => toWire([value])).toThrow(ArtifactHostError)
    expect(() => fromWire([value])).toThrow(ArtifactHostError)
    expect(await callAdmin(host.admin, 'create', [value], options)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
  })
})
