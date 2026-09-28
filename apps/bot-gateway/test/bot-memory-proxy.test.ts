import { expect, it } from 'vitest'
import { harness } from './harness.js'

it('proxies validated memory lists, status filters, patches and deletion', async () => {
  const h = await harness()
  const base = `/v1/bots/${h.bot.id}/memories`
  const list = await h.request('GET', base + '?status=all')
  expect(list.status).toBe(200)
  expect((await list.json()).memories).toEqual([expect.objectContaining({ id: 'm1', pinned: false })])
  expect(h.instance.memoryRequests.at(-1)).toEqual({ method: 'GET', status: 'all' })
  for (const status of ['active', 'archived', 'superseded']) {
    expect((await h.request('GET', base + '?status=' + status)).status).toBe(200)
    expect(h.instance.memoryRequests.at(-1)).toEqual({ method: 'GET', status })
  }
  expect((await h.request('GET', base + '?status=invalid')).status).toBe(200)
  expect(h.instance.memoryRequests.at(-1)).toEqual({ method: 'GET', status: 'active' })
  const patch = await h.request('PATCH', base + '/m1', { pinned: true })
  expect(patch.status).toBe(200)
  expect((await patch.json()).pinned).toBe(true)
  expect(h.instance.memoryRequests.at(-1)).toEqual({ method: 'PATCH', id: 'm1', body: { pinned: true } })
  expect((await h.request('PATCH', base + '/m1', {})).status).toBe(400)
  const removed = await h.request('DELETE', base + '/m1')
  expect(removed.status).toBe(204)
  expect(await removed.text()).toBe('')
  expect((await (await h.request('GET', base)).json()).memories).toEqual([])
  expect((await h.request('DELETE', base + '/missing')).status).toBe(404)
})
it('rejects unavailable bots and invalid instance output', async () => {
  const h = await harness()
  const base = `/v1/bots/${h.bot.id}/memories`
  h.instance.memories[0].content = 'x'.repeat(4001)
  const invalid = await h.request('GET', base)
  expect(invalid.status).toBe(503)
  expect((await invalid.json()).code).toBe('INSTANCE_UNAVAILABLE')
  await h.lifecycle.stop(h.bot.id)
  const stopped = await h.request('GET', base)
  expect(stopped.status).toBe(409)
  expect((await stopped.json()).code).toBe('BOT_NOT_RUNNING')
  await h.lifecycle.archive(h.bot.id)
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    expect(
      (
        await h.request(
          method,
          base + (method === 'GET' ? '' : '/m1'),
          method === 'PATCH' ? { pinned: true } : undefined
        )
      ).status
    ).toBe(404)
  }
})
