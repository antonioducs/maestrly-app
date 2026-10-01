import { expect, test } from 'vitest'
import { toWire } from '@maestrly/artifact-host'
import { harness } from './harness.js'

const bundle = (extra = {}) => ({
  title: 'Synthetic artifact',
  owner: { kind: 'local', id: 'spoof' },
  origin: { workspaceId: 'spoof', conversationId: 'conversation', conversationTitle: 'Test' },
  files: [{ path: 'index.html', bytes: new TextEncoder().encode('<h1>Test</h1>') }],
  ...extra,
})
const call = (method: string, args: unknown[]) => ({ method, args: toWire(args) })

test('device and bot credentials stay on their API; disabled causes are distinct', async () => {
  const h = await harness()
  expect((await h.request('GET', '/v1/artifacts/host')).status).toBe(200)
  expect((await h.request('POST', '/v1/artifacts/admin', call('list', []), false, h.botHeaders())).status).toBe(401)
  expect(
    (await h.request('POST', '/internal/v1/artifacts/admin', call('list', []), true, h.publicHeaders)).status
  ).toBe(401)
  expect(await (await h.request('POST', '/v1/artifacts/admin', call('list', []))).json()).toMatchObject({
    ok: false,
    error: { code: 'host_unavailable', details: { reason: 'server_off' } },
  })
  await h.artifacts.update({ enabled: true })
  expect(await (await h.request('POST', '/internal/v1/artifacts/admin', call('list', []), true)).json()).toMatchObject({
    ok: false,
    error: { details: { reason: 'bot_off' } },
  })
})

test('bot creation and lists enforce ownership and all id calls enforce scope', async () => {
  const h = await harness()
  await h.artifacts.update({ enabled: true })
  await h.lifecycle.patch(h.bot.id, { publishArtifacts: true })
  const own = await (await h.request('POST', '/internal/v1/artifacts/upload', call('create', [bundle()]), true)).json()
  expect(own.ok).toBe(true)
  expect(own.value).toMatchObject({ ownerKind: 'bot', ownerId: h.bot.id, workspaceId: null })
  const device = await (await h.request('POST', '/v1/artifacts/upload', call('create', [bundle()]))).json()
  expect(device.ok).toBe(true)
  expect(device.value.ownerKind).toBe('device')
  expect(device.value.ownerId).not.toBe('spoof')
  const list = await (
    await h.request(
      'POST',
      '/internal/v1/artifacts/admin',
      call('list', [{ ownerKind: 'device', ownerId: 'spoof' }]),
      true
    )
  ).json()
  expect(list.value.map((item: { id: string }) => item.id)).toEqual([own.value.id])
  for (const method of ['get', 'listFiles', 'readFile', 'listComments', 'addComment', 'setCommentResolved']) {
    const result = await (
      await h.request('POST', '/internal/v1/artifacts/admin', call(method, [device.value.id]), true)
    ).json()
    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } })
  }
  const update = await (
    await h.request(
      'POST',
      '/internal/v1/artifacts/upload',
      call('update', [{ id: device.value.id, baseVersion: 1, change: { kind: 'replace', files: bundle().files } }]),
      true
    )
  ).json()
  expect(update).toMatchObject({ ok: false, error: { code: 'not_found' } })
  for (const method of ['delete', 'mintOwnerTicket', 'snapshot', 'setSharing', 'setThumbnail']) {
    expect(
      await (await h.request('POST', '/internal/v1/artifacts/admin', call(method, [own.value.id]), true)).json()
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  }
  expect(
    await (await h.request('POST', '/v1/artifacts/admin', call('snapshot', ['/tmp/forbidden']))).json()
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
})

test('bot malformed arguments are rejected before dereference and replies require parents', async () => {
  const h = await harness()
  await h.artifacts.update({ enabled: true })
  await h.lifecycle.patch(h.bot.id, { publishArtifacts: true })
  for (const method of ['create', 'update']) {
    for (const input of [null, [], 'invalid']) {
      expect(
        await (await h.request('POST', '/internal/v1/artifacts/upload', call(method, [input]), true)).json()
      ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    }
  }
  const made = await (await h.request('POST', '/internal/v1/artifacts/upload', call('create', [bundle()]), true)).json()
  expect(
    await (
      await h.request(
        'POST',
        '/internal/v1/artifacts/admin',
        call('addComment', [made.value.id, { body: 'Unsolicited root' }]),
        true
      )
    ).json()
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(
    await (
      await h.request(
        'POST',
        '/internal/v1/artifacts/admin',
        call('setCommentResolved', [made.value.id, 'comment', false]),
        true
      )
    ).json()
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
})

test('uploads accept larger bodies while admin stays at 1 MiB, and preserve artifact errors', async () => {
  const h = await harness()
  await h.artifacts.update({ enabled: true })
  const args = [bundle({ files: [{ path: 'index.html', bytes: new Uint8Array(1024 * 1024 + 1).fill(65) }] })]
  const upload = await h.request('POST', '/v1/artifacts/upload', call('create', args))
  expect(upload.status).toBe(200)
  const made = await upload.json()
  expect(made.ok).toBe(true)
  expect((await h.request('POST', '/v1/artifacts/admin', call('create', args))).status).toBe(400)
  const conflict = await (
    await h.request(
      'POST',
      '/v1/artifacts/upload',
      call('update', [{ id: made.value.id, baseVersion: 2, change: { kind: 'replace', files: bundle().files } }])
    )
  ).json()
  expect(conflict).toMatchObject({ ok: false, error: { code: 'version_conflict', details: { currentVersion: 1 } } })
  expect(h.events).toContainEqual(expect.objectContaining({ type: 'artifact.changed', artifactId: made.value.id }))
})

test('profile enablement tracks both settings, new bots inherit the host default, archived bots fail', async () => {
  const h = await harness(Date.now, { environments: true })
  expect(h.store.getBot(h.bot.id)?.publishArtifacts).toBe(false)
  await h.lifecycle.patch(h.bot.id, { publishArtifacts: true })
  await h.artifacts.update({ enabled: true })
  expect(h.instance.installs.at(-1)?.profile.gateway.artifactsEnabled).toBe(true)
  await h.artifacts.update({ enabled: false })
  expect(h.instance.installs.at(-1)?.profile.gateway.artifactsEnabled).toBe(false)
  await h.artifacts.update({ enabled: true })
  const made = h.lifecycle.create({
    name: 'Second',
    instructions: '',
    ceiling: 'ask',
    talksTo: [],
    idempotencyKey: 'artifacts-second',
  })
  expect(made.publishArtifacts).toBe(true)
  h.store.archiveBot(h.bot.id)
  expect((await h.request('POST', '/internal/v1/artifacts/admin', call('list', []), true)).status).toBe(404)
})

test('bot replies are agent attributed and flags are checked again after disabling', async () => {
  const h = await harness()
  await h.artifacts.update({ enabled: true })
  await h.lifecycle.patch(h.bot.id, { publishArtifacts: true })
  const made = await (await h.request('POST', '/internal/v1/artifacts/upload', call('create', [bundle()]), true)).json()
  const root = await h.artifacts
    .admin()!
    .addComment(made.value.id, { author: 'owner', body: 'Owner question', version: 1 })
  const reply = await (
    await h.request(
      'POST',
      '/internal/v1/artifacts/admin',
      call('addComment', [made.value.id, { parentId: root.id, author: 'owner', body: 'Answer' }]),
      true
    )
  ).json()
  expect(reply.ok).toBe(true)
  expect(reply.value.author.kind).toBe('agent')
  await h.lifecycle.patch(h.bot.id, { publishArtifacts: false })
  expect(
    await (await h.request('POST', '/internal/v1/artifacts/admin', call('get', [made.value.id]), true)).json()
  ).toMatchObject({ ok: false, error: { details: { reason: 'bot_off' } } })
})

test('host failures are not reported as disabled and invalid envelopes remain fleet errors', async () => {
  const h = await harness()
  await h.artifacts.update({ enabled: true })
  h.artifacts.admin()!.status = async () => {
    throw new Error('Synthetic host failure')
  }
  expect(await (await h.request('POST', '/v1/artifacts/admin', call('list', []))).json()).toMatchObject({
    ok: false,
    error: { details: { reason: 'internal' } },
  })
  expect(await (await h.request('GET', '/v1/artifacts/host')).json()).toMatchObject({ status: { state: 'error' } })
  expect((await h.request('POST', '/v1/artifacts/admin', { method: 'list', args: null })).status).toBe(400)
})

test('both upload endpoints reject declared bodies above 72 MiB before consuming them', async () => {
  const { request } = await import('node:http')
  const h = await harness()
  for (const internal of [false, true]) {
    const result = await new Promise<number>((resolve) => {
      const req = request(
        (internal ? h.internalOrigin + '/internal' : h.origin) + '/v1/artifacts/upload',
        {
          method: 'POST',
          headers: { ...(internal ? h.botHeaders() : h.publicHeaders), 'Content-Length': String(72 * 1024 * 1024 + 1) },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode!)
          req.destroy()
        }
      )
      req.flushHeaders()
    })
    expect(result).toBe(400)
  }
})
