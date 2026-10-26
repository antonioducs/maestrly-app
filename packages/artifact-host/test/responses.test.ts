import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ArtifactAdmin, createArtifactAdmin } from '../src/admin.js'
import { ArtifactHostError } from '../src/errors.js'
import { MAX_RESPONSE_BYTES, RESPONSES_PAGE_SIZE } from '../src/limits.js'
import { createResponseService, type ResponseAuthor, type ResponseService } from '../src/responses.js'
import { ADMIN_METHODS } from '../src/rpc.js'
import { createActivityRecorder } from '../src/sharing-admin.js'
import { isResponseData } from '../src/shell/contract.js'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BlobStore } from '../src/store/blobs.js'
import { openDatabase } from '../src/store/db.js'
import { ResponseStore } from '../src/store/response-store.js'
import { SharingStore } from '../src/store/sharing-store.js'
import { tempDir, testClock, utf8 } from './helpers.js'

let cleanup: () => void
let store: ArtifactStore
let blobs: BlobStore
let admin: ArtifactAdmin
let clock: ReturnType<typeof testClock>
let onChange: ReturnType<typeof vi.fn>
let onActivity: ReturnType<typeof vi.fn>
let id: string
let other: string

const maria: ResponseAuthor = { kind: 'invited', name: 'Maria', respondent: 'P1' }
const owner: ResponseAuthor = { kind: 'owner', name: 'Antonio', respondent: 'owner' }

function errorOf(action: () => unknown): ArtifactHostError {
  try {
    action()
  } catch (error) {
    if (error instanceof ArtifactHostError) return error
    throw error
  }
  throw new Error('expected an error')
}

const makeService = (maxResponses?: number): ResponseService => {
  const sharing = new SharingStore(store.db)
  return createResponseService({
    store,
    responses: new ResponseStore(store.db),
    clock: clock.now,
    maxResponses,
    onChange,
    record: createActivityRecorder({ sharing, clock: clock.now, onChange, onActivity }),
  })
}

const create = async (title: string) =>
  (
    await admin.create({
      title,
      owner: { kind: 'local', id: 'local' },
      origin: { workspaceId: null, conversationId: null, conversationTitle: null },
      files: [{ path: 'index.html', bytes: utf8(`<form>${title}</form>`) }],
    })
  ).id

beforeEach(async () => {
  const temp = tempDir()
  cleanup = temp.cleanup
  store = new ArtifactStore(openDatabase(path.join(temp.dir, 'artifacts.sqlite')))
  blobs = new BlobStore(path.join(temp.dir, 'blobs'))
  clock = testClock()
  onChange = vi.fn()
  onActivity = vi.fn()
  admin = createArtifactAdmin({ store, blobs, clock: clock.now, quotaBytes: 1024 * 1024, onChange })
  id = await create('Form')
  other = await create('Other')
  onChange.mockClear()
})
afterEach(() => {
  store.close()
  cleanup()
})

describe('isResponseData', () => {
  const nested = (levels: number) => {
    let value: Record<string, unknown> = {}
    for (let level = 1; level < levels; level++) value = { d: value }
    return value
  }

  it('accepts a JSON object of plain values', () => {
    expect(isResponseData({ answer: 'yes', score: 4, tags: ['a'], nested: { ok: true, none: null } })).toBe(true)
    expect(isResponseData({})).toBe(true)
  })

  it('refuses anything that is not a JSON object', () => {
    for (const value of [
      [],
      null,
      'x',
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { d: new Date() },
      { u: undefined },
      { f: () => 1 },
    ])
      expect(isResponseData(value)).toBe(false)
  })

  it('limits the depth', () => {
    expect(isResponseData(nested(16))).toBe(true)
    expect(isResponseData(nested(17))).toBe(false)
  })

  it('limits the size in UTF-8 bytes, and the number of values', () => {
    expect(isResponseData({ t: 'x'.repeat(MAX_RESPONSE_BYTES - 100) })).toBe(true)
    expect(isResponseData({ t: 'x'.repeat(MAX_RESPONSE_BYTES) })).toBe(false)
    expect(isResponseData({ t: 'é'.repeat(MAX_RESPONSE_BYTES / 2) })).toBe(false)
    expect(isResponseData({ a: new Array(MAX_RESPONSE_BYTES + 1).fill(0) })).toBe(false)
  })
})

describe('responses', () => {
  it('keeps one response per person: sending again replaces the data and keeps when it was first sent', () => {
    const service = makeService()
    const first = service.save(id, maria, { version: 1, data: { a: 1 } })
    expect(first.created).toBe(true)
    expect(first.response).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      version: 1,
      author: { kind: 'invited', name: 'Maria', verified: true },
      data: { a: 1 },
      createdAt: clock.now(),
      updatedAt: clock.now(),
    })
    const sentAt = clock.now()
    clock.advance(1000)
    const second = service.save(id, maria, { version: 1, data: { a: 2 } })
    expect(second.created).toBe(false)
    expect(service.list(id)).toEqual({
      responses: [{ ...first.response, data: { a: 2 }, createdAt: sentAt, updatedAt: sentAt + 1000 }],
      nextCursor: null,
    })
  })

  it('tells the owner about a person’s first response only', () => {
    const service = makeService()
    service.save(id, maria, { version: 1, data: { a: 1 } })
    service.save(id, maria, { version: 1, data: { a: 2 } })
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(onActivity).toHaveBeenCalledWith(id, 'response_submitted')
    const events = new SharingStore(store.db).listEvents({ artifactId: id })
    expect(events.map((event) => [event.kind, event.data])).toEqual([['response_submitted', { name: 'Maria' }]])
    // An edit still changes what the owner's lists show.
    expect(onChange).toHaveBeenCalledWith(id)
  })

  it('records the owner’s own response without an event', () => {
    const service = makeService()
    expect(service.save(id, owner, { version: 1, data: { test: true } }).response.author).toEqual({
      kind: 'owner',
      name: 'Antonio',
      verified: true,
    })
    expect(onActivity).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith(id)
  })

  it('marks a guest’s name as unverified', () => {
    const service = makeService()
    const { response } = service.save(
      id,
      { kind: 'guest', name: 'Paula', respondent: 'G1' },
      {
        version: 1,
        data: {},
      }
    )
    expect(response.author).toEqual({ kind: 'guest', name: 'Paula', verified: false })
  })

  it('finds a person’s own response, and nobody else’s', () => {
    const service = makeService()
    service.save(id, maria, { version: 1, data: { a: 1 } })
    expect(service.mine(id, 'P1')?.data).toEqual({ a: 1 })
    expect(service.mine(id, 'P2')).toBeNull()
    expect(service.mine(other, 'P1')).toBeNull()
  })

  it('refuses unknown versions and anything that is not a response', () => {
    const service = makeService()
    expect(errorOf(() => service.save(id, maria, { version: 9, data: {} })).code).toBe('not_found')
    expect(errorOf(() => service.save('A'.repeat(22), maria, { version: 1, data: {} })).code).toBe('not_found')
    expect(errorOf(() => service.save(id, maria, { version: 1, data: [] })).code).toBe('invalid_input')
    expect(errorOf(() => service.save(id, maria, { version: 0, data: {} })).code).toBe('invalid_input')
    expect(
      errorOf(() => service.save(id, maria, { version: 1, data: {}, extra: 1 } as { version: number; data: unknown }))
        .code
    ).toBe('invalid_input')
    expect(service.list(id).responses).toEqual([])
  })

  it('stops taking new people at the limit, while those in can still change theirs', () => {
    const service = makeService(1)
    service.save(id, maria, { version: 1, data: { a: 1 } })
    expect(
      errorOf(() => service.save(id, { ...maria, respondent: 'P2', name: 'Ana' }, { version: 1, data: {} })).code
    ).toBe('limit_reached')
    expect(service.save(id, maria, { version: 1, data: { a: 2 } }).created).toBe(false)
  })

  it('lists a page at a time, in the order they were first sent', () => {
    const service = makeService()
    for (let n = 0; n < 55; n++)
      service.save(id, { kind: 'invited', name: `P${n}`, respondent: `P${n}` }, { version: 1, data: { n } })
    const first = service.list(id)
    expect(first.responses).toHaveLength(RESPONSES_PAGE_SIZE)
    expect(first.responses[0]?.data).toEqual({ n: 0 })
    expect(first.nextCursor).not.toBeNull()
    const second = service.list(id, { cursor: first.nextCursor! })
    expect(second.responses.map((response) => response.data)).toEqual([
      { n: 50 },
      { n: 51 },
      { n: 52 },
      { n: 53 },
      { n: 54 },
    ])
    expect(second.nextCursor).toBeNull()
    expect(service.list(id, { limit: 2 }).responses).toHaveLength(2)
    expect(errorOf(() => service.list(id, { limit: RESPONSES_PAGE_SIZE + 1 })).code).toBe('invalid_input')
    expect(errorOf(() => service.list(id, { cursor: 'x' })).code).toBe('invalid_input')
  })

  it('removes a response of its own artifact only, and lets the person send a new one', () => {
    const service = makeService()
    const { response } = service.save(id, maria, { version: 1, data: { a: 1 } })
    expect(errorOf(() => service.remove(other, response.id)).code).toBe('not_found')
    expect(errorOf(() => service.remove(id, 'A'.repeat(22))).code).toBe('not_found')
    service.remove(id, response.id)
    expect(service.list(id).responses).toEqual([])
    expect(service.save(id, maria, { version: 1, data: { a: 3 } }).created).toBe(true)
  })

  it('goes with its artifact', async () => {
    const service = makeService()
    service.save(id, maria, { version: 1, data: { a: 1 } })
    await admin.delete(id)
    expect(new ResponseStore(store.db).count(id)).toBe(0)
  })
})

describe('admin responses', () => {
  it('lists and deletes the responses of an artifact for the owner', async () => {
    const service = makeService()
    const sent = service.save(id, maria, { version: 1, data: { a: 1 } }).response
    service.save(other, maria, { version: 1, data: { b: 1 } })
    expect(await admin.listResponses(id)).toEqual({ responses: [sent], nextCursor: null })
    expect(await admin.listResponses(id, { limit: 1 })).toEqual({ responses: [sent], nextCursor: null })
    const elsewhere = (await admin.listResponses(other)).responses[0]!
    await expect(admin.deleteResponse(id, elsewhere.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(admin.listResponses('A'.repeat(22))).rejects.toMatchObject({ code: 'not_found' })
    onChange.mockClear()
    await admin.deleteResponse(id, sent.id)
    expect(onChange).toHaveBeenCalledWith(id)
    expect((await admin.listResponses(id)).responses).toEqual([])
    expect((await admin.listResponses(other)).responses).toHaveLength(1)
  })

  it('reaches the response methods across processes', () => {
    expect(ADMIN_METHODS).toEqual(expect.arrayContaining(['listResponses', 'deleteResponse']))
  })
})
