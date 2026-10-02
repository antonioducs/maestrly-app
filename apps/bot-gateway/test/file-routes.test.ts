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
  expect((await (await h.request('GET', '/v1/meta')).json()).features).toContain('files')
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
