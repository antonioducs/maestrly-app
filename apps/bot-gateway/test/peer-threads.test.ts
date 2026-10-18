import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  FLEET_PEER_CONVERSATIONS_FEATURE,
  fleetPeerThreadListSchema,
  fleetPeerThreadSchema,
  type FleetInstanceInput,
} from '@maestrly/bot-fleet-protocol'
import { harness } from './harness.js'

const DAY = 86_400_000

/** Two bots that talk to each other, in an environment whose Maestrly holds threads in conversations of their own. */
async function setup() {
  let now = Date.parse('2026-10-18T10:00:00.000Z')
  const h = await harness(() => now, { environments: true })
  h.instance.provisioning.capabilities.push(FLEET_PEER_CONVERSATIONS_FEATURE)
  const nina = h.lifecycle.create({
    name: 'Nina',
    instructions: '',
    ceiling: 'ask',
    talksTo: [h.bot.id],
    idempotencyKey: randomUUID(),
  })
  for (let i = 0; i < 200 && !h.lifecycle.statuses.get(nina.id)?.ready; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  await h.lifecycle.patch(h.bot.id, { talksTo: [nina.id] })
  for (const id of [h.bot.id, nina.id]) {
    const status = h.lifecycle.statuses.get(id)!
    if (!status.capabilities.includes(FLEET_PEER_CONVERSATIONS_FEATURE))
      status.capabilities = [...status.capabilities, FLEET_PEER_CONVERSATIONS_FEATURE]
  }
  const atlas = h.bot.id
  const send = (from: string, to: string, text: string, extra: Record<string, unknown> = {}) =>
    h.gateway.peers.send(from, { to, text, idempotencyKey: randomUUID(), ...extra })
  /** The inputs the bots' Maestrly received that belong to a thread. */
  const threadInputs = () => h.instance.inputs.filter((input: FleetInstanceInput) => input.thread)
  return {
    h,
    atlas,
    nina: nina.id,
    send,
    threadInputs,
    threads: h.gateway.peerThreads,
    clock: {
      get: () => now,
      advance: (ms: number) => {
        now += ms
      },
    },
  }
}

describe('threads between bots', () => {
  it('opens a thread with a side for each bot and delivers the message to it, once per send', async () => {
    const { h, atlas, nina, threadInputs } = await setup()
    const idempotencyKey = randomUUID()
    const sent = await h.gateway.peers.send(atlas, {
      to: nina,
      text: 'Did release 4.2 pass its regression?',
      idempotencyKey,
      topic: 'Release 4.2',
      origin: 'primary',
    })
    expect(sent).toMatchObject({ delivered: true, thread: expect.any(String) })
    expect(threadInputs().at(-1)).toMatchObject({
      source: 'peer',
      peer: { botId: atlas },
      thread: { id: sent.thread, title: 'Release 4.2' },
    })
    expect(h.store.peerThreadSide(sent.thread!, atlas)).toMatchObject({ origin: 'primary', conversation: 'own' })
    expect(h.store.peerThreadSide(sent.thread!, nina)).toMatchObject({ origin: 'peer', conversation: 'own' })
    // The same send again gets the same answer: no second message, no second thread.
    const delivered = threadInputs().length
    const again = await h.gateway.peers.send(atlas, {
      to: nina,
      text: 'Did release 4.2 pass its regression?',
      idempotencyKey,
      topic: 'Release 4.2',
      origin: 'primary',
    })
    expect(again).toEqual(sent)
    expect(threadInputs()).toHaveLength(delivered)
    const list = fleetPeerThreadListSchema.parse(
      await (await h.request('GET', `/v1/bots/${atlas}/peer-threads`)).json()
    )
    expect(list.threads).toHaveLength(1)
    expect(list.threads[0]).toMatchObject({
      id: sent.thread,
      peer: { botId: nina, name: 'Nina' },
      title: 'Release 4.2',
      origin: 'primary',
      hops: 1,
      messages: 1,
      status: 'open',
    })
  })

  it('keeps a thread between its two bots', async () => {
    const { h, atlas, nina, send } = await setup()
    const { thread } = await send(atlas, nina, 'Hi Nina')
    const gamma = h.lifecycle.create({
      name: 'Gamma',
      instructions: '',
      ceiling: 'ask',
      talksTo: [nina],
      idempotencyKey: randomUUID(),
    })
    await expect(send(gamma.id, nina, 'Me too', { thread })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(send(atlas, nina, 'Unknown', { thread: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // The other bot answers in it.
    expect(await send(nina, atlas, 'Hello Atlas', { thread })).toMatchObject({ thread, delivered: true })
  })

  it('pauses a thread at the bots limit until the owner writes in it, and remembers who was refused', async () => {
    const { h, atlas, nina, send, threadInputs } = await setup()
    for (const id of [atlas, nina])
      expect(
        (await h.request('PUT', `/v1/bots/${id}/peer-thread-settings`, { retentionDays: 30, hopLimit: 4 })).status
      ).toBe(200)
    const { thread } = await send(atlas, nina, 'One')
    await send(nina, atlas, 'Two', { thread })
    await send(atlas, nina, 'Three', { thread })
    // The fourth message is delivered and pauses the thread.
    const fourth = await send(nina, atlas, 'Four', { thread })
    expect(fourth.delivered).toBe(true)
    expect(h.store.peerThread(thread!)).toMatchObject({ status: 'paused', hops: 4 })
    expect(
      h.store
        .activity()
        .filter((entry) => entry.kind === 'needs_you')
        .map((entry) => entry.botId)
        .sort()
    ).toEqual([atlas, nina].sort())
    await expect(send(atlas, nina, 'Five', { thread })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'This conversation with Nina is paused until your owner answers.',
    })
    expect(h.store.peerThread(thread!)?.blockedBot).toBe(atlas)
    // The owner writes in Atlas's side: the bots' messages in a row start again.
    const message = { text: 'Decide on JSON and move on', attachments: [], idempotencyKey: randomUUID() }
    const response = await h.request('POST', `/v1/bots/${atlas}/peer-threads/${thread}/messages`, message)
    expect(response.status).toBe(201)
    expect(h.store.peerThread(thread!)).toMatchObject({ status: 'open', hops: 0, blockedBot: null })
    expect(threadInputs().at(-1)).toMatchObject({ source: 'owner', text: message.text, thread: { id: thread } })
  })

  it('lets a paused thread go on, continuing the bot whose message was refused', async () => {
    const { h, atlas, nina, send, threadInputs } = await setup()
    for (const id of [atlas, nina])
      await h.request('PUT', `/v1/bots/${id}/peer-thread-settings`, { retentionDays: 30, hopLimit: 4 })
    const { thread } = await send(atlas, nina, 'One')
    for (const [from, to] of [
      [nina, atlas],
      [atlas, nina],
      [nina, atlas],
    ])
      await send(from, to, 'Again', { thread })
    await expect(send(atlas, nina, 'Refused', { thread })).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    const resumed = fleetPeerThreadSchema.parse(
      await (await h.request('PATCH', `/v1/bots/${nina}/peer-threads/${thread}`, { resume: true })).json()
    )
    expect(resumed).toMatchObject({ status: 'open', hops: 0 })
    // The continuation goes to Atlas, whose message the pause refused.
    expect(threadInputs().at(-1)).toMatchObject({ source: 'continuation', thread: { id: thread } })
    expect(h.instance.botRequests.filter((request) => request.path === '/inputs').at(-1)?.botId).toBe(atlas)
  })

  it("brings an answer back only from the side opened from the owner's conversation", async () => {
    const { h, atlas, nina, send, threads } = await setup()
    const { thread } = await send(atlas, nina, 'Ask', { origin: 'primary' })
    const report = { text: 'Nina says 4.2 passed: 412 of 415 tests.' }
    const own = await h.request('POST', `/internal/v1/peers/threads/${thread}/report`, report, true)
    expect(own.status).toBe(200)
    expect(threads.get(atlas, thread!)).toMatchObject({ report: report.text, reportAt: expect.any(String) })
    const other = await h.request(
      'POST',
      `/internal/v1/peers/threads/${thread}/report`,
      report,
      true,
      h.botHeaders(nina)
    )
    expect(other.status).toBe(403)
  })

  it('deletes the conversation of an expired side, keeps a pinned one, and the thread once both sides are gone', async () => {
    const { h, atlas, nina, send, threads, clock } = await setup()
    const { thread } = await send(atlas, nina, 'Hi')
    const pinned = await h.request('PATCH', `/v1/bots/${nina}/peer-threads/${thread}`, { pinned: true })
    expect(pinned.status).toBe(200)
    clock.advance(31 * DAY)
    await threads.sweep()
    expect(h.store.peerThreadSide(thread!, atlas)).toMatchObject({ conversation: 'deleted' })
    expect(h.store.peerThreadSide(thread!, nina)).toMatchObject({ conversation: 'own', pinned: true })
    expect(h.instance.runConversations.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1)
    // The owner deletes the other side: the thread goes, and both bots hear it.
    const deleted = await h.request('DELETE', `/v1/bots/${nina}/peer-threads/${thread}/conversation`)
    expect(deleted.status).toBe(200)
    expect(h.store.peerThread(thread!)).toBeNull()
    expect(
      h.events
        .filter((event) => event.type === 'peer_thread.removed')
        .map((event) => event.botId)
        .sort()
    ).toEqual([atlas, nina].sort())
  })

  it("routes a thread's transcript, resets and turns as the thread's", async () => {
    const { h, atlas, nina, send } = await setup()
    const { thread } = await send(atlas, nina, 'Hi')
    const at = new Date().toISOString()
    h.lifecycle.onTurnFinished!(atlas, { outcome: 'completed', inputId: randomUUID(), text: 'Done', runId: thread })
    const status = h.lifecycle.statuses.get(atlas)!
    status.turns = [{ state: 'running', startedAt: at, inputId: 'in-1', runId: thread!, tool: null }]
    const bot = await (await h.request('GET', `/v1/bots/${atlas}`)).json()
    expect(bot.turns).toEqual([{ kind: 'peer', id: thread, title: 'Hi', startedAt: at, tool: null, cancelling: false }])
    expect(h.gateway.peerThreads.get(atlas, thread!)).toMatchObject({ working: true })
    expect(h.gateway.peerThreads.get(nina, thread!)).toMatchObject({ peerWorking: true })
    // Retention never deletes a conversation that works.
    expect((await h.request('DELETE', `/v1/bots/${atlas}/peer-threads/${thread}/conversation`)).status).toBe(409)
  })

  it('advertises conversations between bots and keeps settings within their choices', async () => {
    const { h, atlas } = await setup()
    const meta = await (await h.request('GET', '/v1/meta')).json()
    expect(meta.moreFeatures).toContain(FLEET_PEER_CONVERSATIONS_FEATURE)
    expect(
      (await h.request('PUT', `/v1/bots/${atlas}/peer-thread-settings`, { retentionDays: 45, hopLimit: 8 })).status
    ).toBe(400)
    const bot = await (await h.request('GET', `/v1/bots/${atlas}`)).json()
    expect(bot.peerSettings).toEqual({ retentionDays: 30, hopLimit: 8 })
  })
})
