import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  FLEET_OWNER_SEEN_FEATURE,
  FLEET_PARALLEL_TURNS_FEATURE,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  FLEET_ROUTINE_RUN_LIMITS,
  fleetBotSchema,
  FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
  fleetRoutineRunPageSchema,
  fleetRoutineRunSchema,
  type FleetGatewayEvent,
} from '@maestrly/bot-fleet-protocol'
import type { StoredRoutineRun } from '../src/store.js'
import { harness } from './harness.js'

const DAY = 86_400_000

/** A gateway whose bot runs in an environment; with `capable`, its Maestrly runs routines in their own conversations. */
async function setup(capable = true) {
  let now = Date.parse('2026-09-25T10:00:00.000Z')
  const h = await harness(() => now, { environments: true })
  const status = h.lifecycle.statuses.get(h.bot.id)!
  if (capable) status.capabilities = [...status.capabilities, FLEET_ROUTINE_CONVERSATIONS_FEATURE]
  const routine = h.gateway.routines.create(h.bot.id, {
    title: 'Prices',
    prompt: 'Check prices',
    schedule: { kind: 'interval', everyMinutes: 15 },
    enabled: true,
    idempotencyKey: randomUUID(),
  })
  const base = `/v1/bots/${h.bot.id}`
  /** Runs the routine now, as the owner's Run now does, and returns its run. */
  const run = async () => {
    expect((await h.request('POST', `${base}/routines/${routine.id}/run`)).status).toBe(200)
    const input = h.instance.inputs.at(-1)!
    return {
      input,
      run: h.store.routineRunById(input.routine!.runId!)!,
      inputId: h.instance.receipts.get(input.idempotencyKey)!.inputId,
    }
  }
  return {
    h,
    status,
    routine,
    base,
    run,
    clock: {
      get: () => now,
      advance: (ms: number) => {
        now += ms
      },
    },
  }
}

const runEvents = (events: FleetGatewayEvent[], runId: string) =>
  events.filter(
    (event): event is Extract<FleetGatewayEvent, { type: 'routine_run.updated' }> =>
      event.type === 'routine_run.updated' && event.run.id === runId
  )

/** A run of the bot written straight to its history, as if it had run at `at`. */
function stored(
  botId: string,
  routineId: string,
  at: number,
  overrides: Partial<StoredRoutineRun> = {}
): StoredRoutineRun {
  return {
    id: randomUUID(),
    routineId,
    botId,
    inputId: randomUUID(),
    trigger: 'schedule',
    status: 'completed',
    deliveredAt: new Date(at).toISOString(),
    finishedAt: new Date(at + 60_000).toISOString(),
    report: null,
    finalText: null,
    routineTitle: 'Prices',
    conversation: 'own',
    quiet: false,
    pinned: false,
    lastActivityAt: new Date(at + 60_000).toISOString(),
    expiresAt: null,
    conversationDeletedAt: null,
    media: null,
    kept: null,
    adjustments: 0,
    seenAt: null,
    ...overrides,
  }
}

describe('routine runs in conversations of their own', () => {
  it("gives a run a conversation of its own when the bot's Maestrly can, and else keeps it in the bot's", async () => {
    const legacy = await setup(false)
    const before = await legacy.run()
    expect(before.input.run).toBeUndefined()
    expect(before.run).toMatchObject({ conversation: 'primary', routineTitle: 'Prices', lastActivityAt: null })

    const { h, run } = await setup()
    const { input, run: record } = await run()
    expect(input.run).toEqual({ id: input.routine!.runId })
    expect(record).toMatchObject({ conversation: 'own', routineTitle: 'Prices', lastActivityAt: record.deliveredAt })
    expect(runEvents(h.events, record.id).at(-1)?.run).toMatchObject({ status: 'unknown', conversation: 'own' })
    // The gateway tells every bot it installs that it runs routines this way; the bot's Maestrly decides it can.
    expect(h.instance.installs.at(-1)?.profile.gateway.routineConversations).toBe(true)
    const bot = await (await h.request('GET', `/v1/bots/${h.bot.id}`)).json()
    expect(bot.runSettings).toEqual(FLEET_ROUTINE_RUN_SETTINGS_DEFAULT)
  })

  it("lists a bot's runs a page at a time, newest first, and keeps them after their routine is deleted", async () => {
    const { h, base, run, clock, routine } = await setup()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      ids.push((await run()).run.id)
      clock.advance(60_000)
    }
    const first = fleetRoutineRunPageSchema.parse(await (await h.request('GET', `${base}/routine-runs?limit=2`)).json())
    expect(first.runs.map((item) => item.id)).toEqual([ids[2], ids[1]])
    expect(first.before).toBe(ids[1])
    const second = fleetRoutineRunPageSchema.parse(
      await (await h.request('GET', `${base}/routine-runs?limit=2&before=${first.before}`)).json()
    )
    expect(second).toEqual({ runs: [expect.objectContaining({ id: ids[0] })], before: null })
    expect((await h.request('GET', `${base}/routine-runs?before=unknown`)).status).toBe(404)
    expect((await h.request('DELETE', `${base}/routines/${routine.id}`)).status).toBe(204)
    const after = fleetRoutineRunPageSchema.parse(await (await h.request('GET', `${base}/routine-runs`)).json())
    expect(after.runs.map((item) => item.id)).toEqual([...ids].reverse())
    expect(after.runs[0].routineTitle).toBe('Prices')
    // The bot reads its own runs too, and no other bot's.
    const internal = await h.request('GET', '/internal/v1/routine-runs?limit=1', undefined, true)
    expect(fleetRoutineRunPageSchema.parse(await internal.json()).runs.map((item) => item.id)).toEqual([ids[2]])
    expect((await h.request('GET', `/internal/v1/routine-runs/${ids[0]}`, undefined, true)).status).toBe(200)
    const other = h.lifecycle.create({
      name: 'Other',
      instructions: '',
      ceiling: 'ask',
      talksTo: [],
      idempotencyKey: randomUUID(),
    })
    expect(
      (await h.request('GET', `/internal/v1/routine-runs/${ids[0]}`, undefined, true, h.botHeaders(other.id))).status
    ).toBe(404)
  })

  it("reads a run's conversation and sends the owner's changes there, once per message", async () => {
    const { h, base, run } = await setup()
    const { run: record } = await run()
    h.instance.runConversations.page = {
      items: [{ kind: 'assistant', id: 'm:0', at: '2026-09-25T10:00:05.000Z', text: 'Done', streaming: false }],
      before: null,
    }
    const page = await (
      await h.request('GET', `${base}/routine-runs/${record.id}/transcript?limit=50&reasoning=1`)
    ).json()
    expect(page.items).toEqual([expect.objectContaining({ text: 'Done' })])
    expect(h.instance.runConversations.requests.at(-1)).toMatchObject({
      method: 'GET',
      runId: record.id,
      path: `/v1/runs/${record.id}/transcript?limit=50&reasoning=1`,
    })
    const message = { text: 'Make the chart bigger', attachments: [], idempotencyKey: randomUUID() }
    const sent = await h.request('POST', `${base}/routine-runs/${record.id}/messages`, message)
    expect(sent.status).toBe(201)
    const receipt = await sent.json()
    expect(h.instance.inputs.at(-1)).toMatchObject({ source: 'owner', text: message.text, run: { id: record.id } })
    // A retry gets the same receipt; the run counts the change once.
    const retried = await h.request('POST', `${base}/routine-runs/${record.id}/messages`, message)
    expect(await retried.json()).toEqual(receipt)
    expect(h.store.routineRunById(record.id)).toMatchObject({ adjustments: 1 })
    expect(
      (await h.request('POST', `${base}/routine-runs/unknown/messages`, { ...message, idempotencyKey: randomUUID() }))
        .status
    ).toBe(404)

    const legacy = h.store.routineRunById(record.id)!
    h.store.insertRoutineRun({ ...legacy, id: 'legacy-run', inputId: randomUUID(), conversation: 'primary' })
    expect((await h.request('GET', `${base}/routine-runs/legacy-run/transcript`)).status).toBe(409)
  })

  it("records each turn of a run's conversation, and alerts only about what the bot's settings ask for", async () => {
    const { h, base, run, clock } = await setup()
    const { run: record, inputId } = await run()
    clock.advance(30_000)
    const report = { summary: 'Nothing changed', pending: null, notes: null, quiet: true }
    const path = `/internal/v1/routines/${record.routineId}/runs/${record.id}/report`
    expect((await h.request('POST', path, report, true)).status).toBe(200)
    const data = h.lifecycle.onTurnFinished!(h.bot.id, {
      outcome: 'completed',
      inputId,
      text: 'Nothing new',
      runId: record.id,
      media: { images: 1, videos: 0, files: 2 },
    })
    expect(data).toEqual({ runId: record.id, quiet: true, alert: false })
    expect(h.store.routineRunById(record.id)).toMatchObject({
      status: 'completed',
      quiet: true,
      finalText: 'Nothing new',
      media: { images: 1, videos: 0, files: 2 },
      lastActivityAt: new Date(clock.get()).toISOString(),
    })
    // The owner's change in its conversation: the run is as its latest turn left it.
    clock.advance(60_000)
    expect(
      h.lifecycle.onTurnFinished!(h.bot.id, { outcome: 'failed', inputId: randomUUID(), text: null, runId: record.id })
    ).toEqual({ runId: record.id })
    expect(h.store.routineRunById(record.id)).toMatchObject({ status: 'failed', finalText: 'Nothing new' })
    // With every run announced, a quiet one alerts too.
    expect(
      (await h.request('PUT', `${base}/routine-run-settings`, { ...FLEET_ROUTINE_RUN_SETTINGS_DEFAULT, notify: 'all' }))
        .status
    ).toBe(200)
    const { run: next, inputId: nextInput } = await run()
    await h.request('POST', `/internal/v1/routines/${next.routineId}/runs/${next.id}/report`, report, true)
    expect(h.lifecycle.onTurnFinished!(h.bot.id, { outcome: 'completed', inputId: nextInput, text: 'Ok' })).toEqual({
      runId: next.id,
      quiet: true,
      alert: true,
    })
  })

  it('keeps once when the owner opened a run, tells every device, and counts their changes there as seen', async () => {
    const { h, base, run, clock } = await setup()
    const meta = await (await h.request('GET', '/v1/meta')).json()
    expect(meta.moreFeatures).toContain(FLEET_OWNER_SEEN_FEATURE)
    const { run: record, inputId } = await run()
    expect(record.seenAt).toBeNull()
    const listed = fleetRoutineRunPageSchema.parse(await (await h.request('GET', `${base}/routine-runs`)).json())
    expect(listed.runs[0]).toMatchObject({ id: record.id, seenAt: null })
    const before = runEvents(h.events, record.id).length
    clock.advance(60_000)
    const seenAt = new Date(clock.get()).toISOString()
    const seen = await h.request('PATCH', `${base}/routine-runs/${record.id}`, { seen: true })
    expect(seen.status).toBe(200)
    expect(fleetRoutineRunSchema.parse(await seen.json()).seenAt).toBe(seenAt)
    expect(
      runEvents(h.events, record.id)
        .slice(before)
        .map((event) => event.run.seenAt)
    ).toEqual([seenAt])
    // Seeing it again changes nothing, and neither its end nor a copy read before it was seen takes it back.
    clock.advance(60_000)
    const again = await h.request('PATCH', `${base}/routine-runs/${record.id}`, { seen: true })
    expect((await again.json()).seenAt).toBe(seenAt)
    expect(runEvents(h.events, record.id)).toHaveLength(before + 1)
    h.lifecycle.onTurnFinished!(h.bot.id, { outcome: 'completed', inputId, text: 'Done' })
    expect(runEvents(h.events, record.id).at(-1)?.run).toMatchObject({ status: 'completed', seenAt })
    h.store.updateRoutineRun({ ...record, finalText: 'Stale' })
    expect(h.store.routineRunById(record.id)).toMatchObject({ finalText: 'Stale', seenAt })
    const kept = await h.request('PATCH', `${base}/routine-runs/${record.id}`, { pinned: true, seen: true })
    expect(await kept.json()).toMatchObject({ pinned: true, seenAt })
    expect((await h.request('PATCH', `${base}/routine-runs/${record.id}`, {})).status).toBe(400)
    expect((await h.request('PATCH', `${base}/routine-runs/unknown`, { seen: true })).status).toBe(404)
    // The owner who writes in a run's conversation, from any device, saw it.
    const { run: other } = await run()
    const message = { text: 'Use the other chart', attachments: [], idempotencyKey: randomUUID() }
    expect((await h.request('POST', `${base}/routine-runs/${other.id}/messages`, message)).status).toBe(201)
    expect(h.store.routineRunById(other.id)?.seenAt).toBe(new Date(clock.get()).toISOString())
    expect(runEvents(h.events, other.id).at(-1)?.run.seenAt).toBe(new Date(clock.get()).toISOString())
  })

  it("tells devices every conversation working at once, the bot's own and its runs'", async () => {
    const { h, run, status } = await setup()
    const { run: record, inputId } = await run()
    const at = new Date().toISOString()
    status.capabilities = [...status.capabilities, FLEET_PARALLEL_TURNS_FEATURE]
    status.turn = { state: 'running', startedAt: at, inputId: 'own-input', runId: null }
    status.turns = [
      { state: 'running', startedAt: at, inputId: 'own-input', runId: null, tool: null },
      {
        state: 'cancelling',
        startedAt: at,
        inputId,
        runId: record.id,
        tool: { tool: 'browser_navigate', target: null },
      },
      // A conversation the gateway never recorded is left out.
      { state: 'running', startedAt: at, inputId: 'unknown-input', runId: 'unknown-run', tool: null },
    ]
    const bot = fleetBotSchema.parse(await (await h.request('GET', `/v1/bots/${h.bot.id}`)).json())
    expect(bot.status).toBe('working')
    expect(bot.turns).toEqual([
      { kind: 'primary', id: null, title: '', startedAt: at, tool: null, cancelling: false },
      { kind: 'routine', id: record.id, title: 'Prices', startedAt: at, tool: 'browser_navigate', cancelling: true },
    ])
    expect(bot.runningRun).toMatchObject({ id: record.id, title: 'Prices', startedAt: at })
    const features = await (await h.request('GET', '/v1/meta')).json()
    expect(features.moreFeatures).toContain(FLEET_PARALLEL_TURNS_FEATURE)
  })

  it("never runs a routine again, nor deletes its run's conversation, while its turn runs beside others", async () => {
    const { h, base, routine, run, status, clock } = await setup()
    const { run: record, inputId } = await run()
    const at = new Date().toISOString()
    // The bot's own conversation is the one an older reader sees; the run works too.
    status.turn = { state: 'running', startedAt: at, inputId: 'own-input', runId: null }
    status.turns = [
      { state: 'running', startedAt: at, inputId: 'own-input', runId: null, tool: null },
      { state: 'running', startedAt: at, inputId, runId: record.id, tool: null },
    ]
    const sent = h.instance.inputs.length
    clock.advance(15 * 60_000)
    await h.gateway.routines.tick()
    expect(h.instance.inputs).toHaveLength(sent)
    expect(h.store.routineById(routine.id)?.lastOutcome).toBe('skipped_busy')
    expect((await h.request('DELETE', `${base}/routine-runs/${record.id}/conversation`)).status).toBe(409)
    const view = fleetRoutineRunSchema.parse(await (await h.request('GET', `${base}/routine-runs/${record.id}`)).json())
    expect(view.status).toBe('delivered')
  })

  it("stops one conversation's turn, or every turn for a device that names none", async () => {
    const { h, base } = await setup()
    expect((await h.request('POST', `${base}/cancel?conversation=run-1`)).status).toBe(204)
    expect((await h.request('POST', `${base}/cancel?conversation=primary`)).status).toBe(204)
    expect((await h.request('POST', `${base}/cancel`)).status).toBe(204)
    expect((await h.request('POST', `${base}/cancel?conversation=../x`)).status).toBe(400)
    expect(
      h.instance.botRequests.filter((request) => request.path.startsWith('/turn/cancel')).map((request) => request.path)
    ).toEqual(['/turn/cancel?conversation=run-1', '/turn/cancel?conversation=primary', '/turn/cancel'])
  })

  it("deletes a run's conversation and keeps its report and what the bot kept of it", async () => {
    const { h, base, run, status } = await setup()
    const { run: record, inputId } = await run()
    status.turn = { ...status.turn, state: 'running', startedAt: new Date().toISOString(), inputId, runId: record.id }
    expect((await h.request('DELETE', `${base}/routine-runs/${record.id}/conversation`)).status).toBe(409)
    expect((await (await h.request('GET', `/v1/bots/${h.bot.id}`)).json()).runningRun).toMatchObject({
      id: record.id,
      title: 'Prices',
    })
    status.turn = { ...status.turn, state: 'idle', inputId: null, runId: null }
    h.lifecycle.onTurnFinished!(h.bot.id, { outcome: 'completed', inputId, text: 'Done', runId: record.id })
    const deleted = fleetRoutineRunSchema.parse(
      await (await h.request('DELETE', `${base}/routine-runs/${record.id}/conversation`)).json()
    )
    expect(deleted).toMatchObject({
      conversation: 'deleted',
      conversationDeletedAt: expect.any(String),
      kept: h.instance.runConversations.kept,
      finalText: 'Done',
    })
    expect(h.instance.runConversations.requests.filter((item) => item.method === 'DELETE')).toHaveLength(1)
    // Deleted already: nothing more is asked of the bot.
    expect((await h.request('DELETE', `${base}/routine-runs/${record.id}/conversation`)).status).toBe(200)
    expect(h.instance.runConversations.requests.filter((item) => item.method === 'DELETE')).toHaveLength(1)
    expect((await h.request('GET', `${base}/routine-runs/${record.id}/transcript`)).status).toBe(404)
    // A conversation the bot no longer has is deleted all the same.
    const { run: gone } = await run()
    h.instance.runConversations.missing.add(gone.id)
    const missing = await h.request('DELETE', `${base}/routine-runs/${gone.id}/conversation`)
    expect(await missing.json()).toMatchObject({ conversation: 'deleted', kept: null })
  })

  it('keeps pinned runs, deletes expired and quiet ones, and keeps the newest runs of each routine', async () => {
    const { h, routine, base, clock } = await setup()
    const at = clock.get()
    const expired = stored(h.bot.id, routine.id, at - 40 * DAY)
    const pinned = stored(h.bot.id, routine.id, at - 41 * DAY, { pinned: true })
    const quiet = stored(h.bot.id, routine.id, at - 8 * DAY, { quiet: true })
    const recent = stored(h.bot.id, routine.id, at - 2 * DAY)
    for (const run of [expired, pinned, quiet, recent]) h.store.insertRoutineRun(run)
    const listed = fleetRoutineRunPageSchema.parse(await (await h.request('GET', `${base}/routine-runs`)).json()).runs
    expect(listed.find((item) => item.id === recent.id)?.expiresAt).toBe(
      new Date(Date.parse(recent.lastActivityAt!) + 30 * DAY).toISOString()
    )
    expect(listed.find((item) => item.id === pinned.id)?.expiresAt).toBeNull()
    expect((await h.request('PATCH', `${base}/routine-runs/${recent.id}`, { pinned: true })).status).toBe(200)
    await h.gateway.routines.sweep()
    const deletedIds = h.instance.runConversations.requests
      .filter((item) => item.method === 'DELETE')
      .map((item) => item.runId)
    expect(deletedIds.sort()).toEqual([expired.id, quiet.id].sort())
    expect(h.store.routineRunById(pinned.id)?.conversation).toBe('own')
    expect(h.store.routineRunById(recent.id)).toMatchObject({ conversation: 'own', pinned: true })
    expect(h.store.routineRunById(expired.id)?.conversation).toBe('deleted')

    // Beyond the newest runs a routine keeps, the oldest go entirely; kept ones stay.
    const first = clock.get() - DAY
    const many = Array.from({ length: FLEET_ROUTINE_RUN_LIMITS.keepPerRoutine + 2 }, (_, index) =>
      stored(h.bot.id, routine.id, first + index * 60_000)
    )
    for (const run of many) h.store.insertRoutineRun(run)
    await h.gateway.routines.sweep()
    const remaining = new Set(h.store.botRoutineRuns(h.bot.id, { limit: 1000 }).map((run) => run.id))
    expect(many.slice(0, 2).map((run) => remaining.has(run.id))).toEqual([false, false])
    const removed = h.events.flatMap((event) => (event.type === 'routine_run.removed' ? [event.runId] : []))
    expect(removed).toEqual(expect.arrayContaining([many[0].id, many[1].id]))
    for (const run of many.slice(2)) expect(remaining.has(run.id)).toBe(true)
    expect(remaining.has(pinned.id)).toBe(true)
    expect(remaining.has(expired.id)).toBe(false)
  })

  it("refers to a run in the owner's message to the bot, only for a bot that can read it", async () => {
    const { h, base, run } = await setup()
    const { run: record } = await run()
    const message = {
      text: 'Use this chart',
      attachments: [],
      idempotencyKey: randomUUID(),
      citation: { runId: record.id },
    }
    expect((await h.request('POST', `${base}/messages`, message)).status).toBe(201)
    expect(h.instance.inputs.at(-1)).toMatchObject({
      source: 'owner',
      citation: { runId: record.id, routineTitle: 'Prices', at: record.deliveredAt },
    })
    const legacy = await setup(false)
    const old = { ...message, idempotencyKey: randomUUID() }
    expect((await legacy.h.request('POST', `${legacy.base}/messages`, old)).status).toBe(426)
  })

  it("turns a run's transcript items and resets into run events", async () => {
    const { h, run } = await setup()
    const { run: record } = await run()
    const environmentId = h.bot.environmentId!
    const dispatch = (event: unknown) =>
      (h.lifecycle as unknown as { dispatch(id: string, event: unknown): void }).dispatch(environmentId, event)
    const item = { kind: 'assistant', id: 'm:0', at: '2026-09-25T10:00:05.000Z', text: 'Done', streaming: false }
    dispatch({ seq: 10, at: item.at, botId: h.bot.id, type: 'transcript.upsert', item, runId: record.id })
    dispatch({ seq: 11, at: item.at, botId: h.bot.id, type: 'reset', runId: record.id })
    expect(h.events.slice(-2)).toEqual([
      expect.objectContaining({ type: 'routine_run.transcript.upsert', botId: h.bot.id, runId: record.id, item }),
      expect.objectContaining({ type: 'routine_run.transcript.reset', botId: h.bot.id, runId: record.id }),
    ])
  })
})
