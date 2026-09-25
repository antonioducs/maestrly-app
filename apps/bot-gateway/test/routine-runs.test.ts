import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { harness } from './harness.js'

it('records delivery, accepts only own reports, finishes and supplies previous reports', async () => {
  let now = Date.parse('2026-09-25T10:00:00.000Z')
  const h = await harness(() => now)
  const routine = h.gateway.routines.create(h.bot.id, {
    title: 'Prices',
    prompt: 'Check prices',
    schedule: { kind: 'interval', everyMinutes: 15 },
    enabled: true,
    idempotencyKey: randomUUID(),
  })
  const base = `/v1/bots/${h.bot.id}/routines/${routine.id}`
  expect((await h.request('GET', base + '/runs')).status).toBe(200)
  expect((await h.request('POST', base + '/run')).status).toBe(200)
  const input = h.instance.inputs.at(-1)!
  expect(input.routine).toMatchObject({ runId: expect.any(String), previousRuns: [] })
  const receipt = h.instance.receipts.get(input.idempotencyKey)!
  const status = h.lifecycle.statuses.get(h.bot.id)!
  status.queue.push({ inputId: receipt.inputId, source: 'routine', preview: 'Prices' })
  const runs = (await (await h.request('GET', base + '/runs')).json()).runs
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ id: input.routine!.runId, status: 'delivered', trigger: 'manual' })
  expect(h.store.routineRunById(runs[0].id)?.inputId).toBe(receipt.inputId)
  const report = { summary: 'Checked 3 stores', pending: 'Magalu offline', notes: 'Retry Magalu first' }
  const reportPath = `/internal/v1/routines/${routine.id}/runs/${runs[0].id}/report`
  const response = await h.request('POST', reportPath, report, true)
  expect(response.status).toBe(200)
  expect((await response.json()).report).toEqual(report)
  const foreign = h.lifecycle.create({
    name: 'Other',
    instructions: '',
    ceiling: 'ask',
    talksTo: [],
    idempotencyKey: randomUUID(),
  })
  expect((await h.request('POST', reportPath, report, true, h.botHeaders(foreign.id))).status).toBe(404)
  expect(
    (await h.request('POST', `/internal/v1/routines/${routine.id}/runs/unknown/report`, report, true)).status
  ).toBe(404)
  now += 1000
  h.lifecycle.onTurnFinished!(h.bot.id, { outcome: 'completed', inputId: receipt.inputId, text: 'Done' })
  expect(h.store.routineRunById(runs[0].id)).toMatchObject({
    status: 'completed',
    finalText: 'Done',
    finishedAt: new Date(now).toISOString(),
  })
  status.queue = []
  expect((await h.request('POST', base + '/run')).status).toBe(200)
  expect(h.instance.inputs.at(-1)!.routine!.previousRuns).toEqual([
    { at: new Date(now - 1000).toISOString(), status: 'completed', ...report },
  ])
  expect(
    h.store
      .activity()
      .filter((e) => e.kind === 'routine_ran')
      .at(-1)?.data
  ).toMatchObject({ routineId: routine.id, runId: h.instance.inputs.at(-1)!.routine!.runId, outcome: 'sent' })
  expect(h.gateway.routines.runs(h.bot.id, routine.id)[0].status).toBe('unknown')
})
it('deduplicates scheduled replay and prunes runs with their routine or bot', async () => {
  let now = Date.parse('2026-09-25T10:00:00.000Z')
  const h = await harness(() => now)
  const routine = h.gateway.routines.create(h.bot.id, {
    title: 'Check',
    prompt: 'Check',
    schedule: { kind: 'interval', everyMinutes: 15 },
    enabled: true,
    idempotencyKey: randomUUID(),
  })
  now += 15 * 60_000
  await h.gateway.routines.tick()
  const first = h.instance.inputs.at(-1)!
  h.store.saveRoutine(routine)
  await h.gateway.routines.tick()
  expect(h.instance.inputs.at(-1)!.routine!.runId).toBe(first.routine!.runId)
  expect(h.store.routineRuns(routine.id, 100)).toHaveLength(1)
  for (let i = 0; i < 54; i++) {
    now += 1000
    await h.gateway.routines.run(h.bot.id, routine.id)
  }
  expect(h.store.routineRuns(routine.id, 100)).toHaveLength(50)
  expect(h.store.routineRunById(first.routine!.runId!)).toBeNull()
  h.gateway.routines.delete(h.bot.id, routine.id)
  expect(h.store.routineRuns(routine.id, 100)).toEqual([])
  const another = h.gateway.routines.create(h.bot.id, { ...routine, idempotencyKey: randomUUID() })
  await h.gateway.routines.run(h.bot.id, another.id)
  await h.lifecycle.archive(h.bot.id)
  h.store.deleteBot(h.bot.id)
  expect(h.store.routineRuns(another.id, 100)).toEqual([])
})
it('stores failed and cancelled finishes, truncates final text and ignores duplicate finishes', async () => {
  const h = await harness()
  const routine = h.gateway.routines.create(h.bot.id, {
    title: 'Check',
    prompt: 'Check',
    schedule: { kind: 'interval', everyMinutes: 15 },
    enabled: false,
    idempotencyKey: randomUUID(),
  })
  for (const outcome of ['failed', 'cancelled'] as const) {
    await h.gateway.routines.run(h.bot.id, routine.id)
    const input = h.instance.inputs.at(-1)!
    const inputId = h.instance.receipts.get(input.idempotencyKey)!.inputId
    h.lifecycle.onTurnFinished!(h.bot.id, { outcome, inputId, text: 'x'.repeat(4100) })
    h.lifecycle.onTurnFinished!(h.bot.id, { outcome: 'completed', inputId, text: 'Wrong' })
    expect(h.store.routineRunById(input.routine!.runId!)).toMatchObject({
      status: outcome,
      finalText: 'x'.repeat(4000),
    })
  }
})
