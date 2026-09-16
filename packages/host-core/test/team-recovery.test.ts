import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { HostService } from '../src/index.js'
import { ask, collaborate, createTeam, finishTurn, runOf, taskOf, teamBot, teamLab, turnOf, until, waitRunning, type TeamLab } from './team-helpers.js'

const labs: TeamLab[] = []
const extra: HostService[] = []
afterEach(async () => {
  for (const service of extra.splice(0)) await service.close().catch(() => {})
  for (const lab of labs.splice(0)) {
    await lab.service.close()
    await rm(lab.dir, { recursive: true, force: true })
  }
})
const skip = process.platform === 'win32'

/** A team mid-flight: coordinator planned, one worker is running. */
async function midFlight() {
  const lab = await teamLab()
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  const team = (await createTeam(lab, { name: 'Recuperacao', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })).team
  const receipt = await ask(lab, team.id, 'trabalho longo')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  await collaborate(lab, ana.id, planning.id, 'team_delegate', { tasks: [{ localKey: 'a', assigneeBotId: bruno.id, goal: 'trabalhe' }] })
  finishTurn(lab, ana.id, planning.id, 'distribuí')
  const worker = await turnOf(lab, receipt.run.id, bruno.id)
  await waitRunning(lab, worker.id)
  return { lab, ana, bruno, team, run: receipt.run, worker }
}
/** Reopens the same state directory with a new service, as a Host restart does. */
async function restart(lab: TeamLab) {
  await lab.service.close()
  const service = new HostService(lab.serviceOptions as never)
  extra.push(service)
  const call = async (method: string, params: unknown = {}) => {
    const response = await service.dispatch({ version: 1, id: randomUUID(), method, params })
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code })
    return response.result as any
  }
  await service.ready()
  return call
}

it.skipIf(skip)('rebuilds team work after a Host restart without duplicating anything', async () => {
  const { lab, run, worker, team } = await midFlight()
  const tasksBefore = (await lab.call('team.tasks.list', { runId: run.id })).tasks
  const messagesBefore = (await lab.call('team.messages.list', { teamId: team.id })).messages

  const call = await restart(lab)
  const recovered = await call('team.run.get', { runId: run.id })
  expect(recovered.id).toBe(run.id)
  // No extra task, no extra run, no extra message was invented during recovery.
  expect((await call('team.tasks.list', { runId: run.id })).tasks.map((task: any) => task.id)).toEqual(tasksBefore.map((task: any) => task.id))
  expect((await call('team.messages.list', { teamId: team.id })).messages.map((message: any) => message.id)).toEqual(messagesBefore.map((message: any) => message.id))
  expect(await call('team.list', {})).toHaveLength(1)
  // The uncertain turn is reconciled conservatively, never re-sent as new work.
  const turn = await call('bot.turn.get', { turnId: worker.id })
  expect(['needs_attention', 'running', 'succeeded', 'interrupted']).toContain(turn.status)
  expect((await call('team.tasks.list', { runId: run.id })).tasks.filter((task: any) => task.kind === 'work')).toHaveLength(1)
})

it.skipIf(skip)('settles a turn that finished while the Host was down, exactly once', async () => {
  const { lab, bruno, run, worker } = await midFlight()
  // The guest completes the work while the Host is not listening.
  const guest = lab.guest(bruno.id)
  await lab.service.close()
  guest.turns.get(worker.id)!.status = 'succeeded'

  const service = new HostService(lab.serviceOptions as never)
  extra.push(service)
  const call = async (method: string, params: unknown = {}) => {
    const response = await service.dispatch({ version: 1, id: randomUUID(), method, params })
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code })
    return response.result as any
  }
  await service.ready()
  const settled = await until(
    () => call('team.tasks.list', { runId: run.id }),
    (page: any) => ['succeeded', 'failed', 'needs_attention', 'cancelled'].includes(page.tasks.find((task: any) => task.localKey === 'a').status),
    8_000
  )
  const task = settled.tasks.find((entry: any) => entry.localKey === 'a')
  // One logical task, one settlement: no second attempt was created to replace it.
  expect(settled.tasks.filter((entry: any) => entry.kind === 'work')).toHaveLength(1)
  expect(task.attempts).toBe(1)
  // Every counted turn has exactly one physical turn behind it: recovery settled the
  // finished work and moved on to consolidation without inventing an execution.
  const page = await call('team.tasks.list', { runId: run.id })
  const budget = (await call('team.run.get', { runId: run.id })).budget
  expect(page.turns).toHaveLength(budget.turns)
  expect(new Set(page.turns.map((turn: any) => turn.id)).size).toBe(budget.turns)
})

it.skipIf(skip)('keeps the budget bounded when a member fails or reconnects', async () => {
  const { lab, bruno, run, worker } = await midFlight()
  const before = await runOf(lab, run.id)
  // The channel drops and comes back; the run must not pay for it twice.
  lab.guest(bruno.id).drop()
  await lab.call('bot.files.list', { botId: bruno.id }).catch(() => {})
  const after = await runOf(lab, run.id)
  expect(after.budget.turns).toBe(before.budget.turns)
  expect(after.budget.toolCallsReserved).toBe(before.budget.toolCallsReserved)
  expect(after.budget.turns).toBeLessThanOrEqual(after.limits.maxTurns)
  void worker
})

it.skipIf(skip)('never lets a repeated human request open a second run', async () => {
  const lab = await teamLab()
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  const team = (await createTeam(lab, { name: 'Idempotente', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })).team
  const key = randomUUID()
  const first = await lab.call('team.messages.send', { teamId: team.id, clientMessageId: key, content: 'faça o relatório', artifactIds: [] })
  const again = await lab.call('team.messages.send', { teamId: team.id, clientMessageId: key, content: 'faça o relatório', artifactIds: [] })
  expect(again.run.id).toBe(first.run.id)
  expect(again.message.id).toBe(first.message.id)
  // A lost reply is resolved by looking the receipt up, never by sending again.
  const lookup = await lab.call('team.messages.lookup', { teamId: team.id, clientMessageId: key })
  expect(lookup.run.id).toBe(first.run.id)
  expect(await lab.call('team.messages.lookup', { teamId: team.id, clientMessageId: randomUUID() })).toBeNull()
  // The same key with different content is a different request and is refused.
  await expect(lab.call('team.messages.send', { teamId: team.id, clientMessageId: key, content: 'outra coisa', artifactIds: [] })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  })
  // A second request while the team is working is refused instead of queued silently.
  await expect(lab.call('team.messages.send', { teamId: team.id, clientMessageId: randomUUID(), content: 'mais um', artifactIds: [] })).rejects.toMatchObject({
    code: 'TEAM_RUN_ACTIVE',
  })
  expect((await lab.call('team.messages.list', { teamId: team.id })).messages).toHaveLength(1)
  void taskOf
})
