import { afterEach, expect, it, vi } from 'vitest'
import { harness } from './harness.js'
import { InstanceClient } from '../src/instance.js'
import { createHash } from 'node:crypto'

afterEach(() => vi.restoreAllMocks())
it('replays image receipts created before attachment kinds were introduced', async () => {
  const h = await harness()
  const input = {
    text: '',
    idempotencyKey: '00000000-0000-4000-8000-000000000003',
    attachments: [{ name: 'pixel.png', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' }],
  }
  const prior = { inputId: 'saved-input', itemId: 'input:saved-input', queued: true }
  h.store.saveIdempotency(
    'botMessageSend:' + h.bot.id,
    input.idempotencyKey,
    createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    prior,
    201
  )
  const post = vi.spyOn(InstanceClient.prototype, 'postInput')
  const response = await h.request('POST', `/v1/bots/${h.bot.id}/messages`, {
    ...input,
    attachments: input.attachments.map((attachment) => ({ ...attachment, kind: 'image' })),
  })
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual(prior)
  expect(post).not.toHaveBeenCalled()
})
it('advertises files and proxies private bytes, including empty files', async () => {
  const h = await harness()
  const meta = await (await h.request('GET', '/v1/meta')).json()
  expect(meta.features).toContain('files')
  expect(meta.moreFeatures).toContain('files-manage')
  for (const bytes of [new Uint8Array([0, 255, 1]), new Uint8Array()]) {
    const ref = { id: 'file', name: 'report.pdf', mediaType: 'application/pdf', byteSize: bytes.length }
    vi.spyOn(InstanceClient.prototype, 'fileMeta').mockResolvedValue(ref)
    vi.spyOn(InstanceClient.prototype, 'file').mockImplementation(
      async () =>
        new Response(bytes, { headers: { 'content-type': ref.mediaType, 'content-length': String(bytes.length) } })
    )
    const response = await h.request('GET', `/v1/bots/${h.bot.id}/files/file/content`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-disposition')).toContain('attachment;')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  }
  expect(
    (
      await h.request('GET', `/v1/bots/${h.bot.id}/files/file/content`, undefined, false, {
        'X-Maestrly-Fleet-Protocol': '1',
      })
    ).status
  ).toBe(401)
})
it('rejects documents before forwarding to an older instance but accepts legacy images', async () => {
  const h = await harness()
  const post = vi.spyOn(InstanceClient.prototype, 'postInput')
  const body = {
    text: '',
    idempotencyKey: '00000000-0000-4000-8000-000000000001',
    attachments: [{ kind: 'text', name: 'note.txt', mediaType: 'text/plain', dataBase64: 'aGk=' }],
  }
  const response = await h.request('POST', `/v1/bots/${h.bot.id}/messages`, body)
  expect(response.status).toBe(426)
  expect((await response.json()).code).toBe('PROTOCOL_INCOMPATIBLE')
  expect(post).not.toHaveBeenCalled()
  const legacy = await h.request('POST', `/v1/bots/${h.bot.id}/messages`, {
    text: '',
    idempotencyKey: '00000000-0000-4000-8000-000000000002',
    attachments: [{ name: 'pixel.png', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' }],
  })
  expect(legacy.status).toBe(201)
  expect(post).toHaveBeenCalledOnce()
})
it('refuses file management on a bot that predates it', async () => {
  const h = await harness()
  const response = await h.request('GET', `/v1/bots/${h.bot.id}/files`)
  expect(response.status).toBe(426)
  expect((await response.json()).code).toBe('PROTOCOL_INCOMPATIBLE')
})
it('forwards file management to a bot that has it', async () => {
  const h = await harness()
  h.lifecycle.statuses.set(h.bot.id, {
    ...h.lifecycle.statuses.get(h.bot.id)!,
    capabilities: ['files', 'files-manage'],
  })
  const usage = {
    usedBytes: 10,
    count: 1,
    quotaBytes: 1024 ** 3,
    countMax: 200,
    deleteWithConversations: true,
    updatedAt: null,
  }
  const list = { files: [], removed: [], usage, diskFreeBytes: 1024 ** 3 }
  const deleted = { deleted: ['f-1'], freedBytes: 10, usage }
  vi.spyOn(InstanceClient.prototype, 'filesList').mockResolvedValue(list)
  const del = vi.spyOn(InstanceClient.prototype, 'filesDelete').mockResolvedValue(deleted)
  const set = vi.spyOn(InstanceClient.prototype, 'fileSettings').mockResolvedValue(usage)
  const listed = await h.request('GET', `/v1/bots/${h.bot.id}/files`)
  expect(listed.status).toBe(200)
  expect(listed.headers.get('cache-control')).toBe('private, no-store')
  expect(await listed.json()).toEqual(list)
  const removed = await h.request('POST', `/v1/bots/${h.bot.id}/files/delete`, { ids: ['f-1'] })
  expect(removed.status).toBe(200)
  expect(await removed.json()).toEqual(deleted)
  expect(del).toHaveBeenCalledWith({ ids: ['f-1'] })
  expect((await h.request('POST', `/v1/bots/${h.bot.id}/files/delete`, { ids: [] })).status).toBe(400)
  const updated = await h.request('PUT', `/v1/bots/${h.bot.id}/file-settings`, {
    quotaGb: 2,
    deleteWithConversations: false,
  })
  expect(updated.status).toBe(200)
  expect(await updated.json()).toEqual(usage)
  expect(set).toHaveBeenCalledWith({ quotaGb: 2, deleteWithConversations: false })
})

