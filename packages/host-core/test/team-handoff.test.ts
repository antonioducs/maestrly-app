import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ask, collaborate, createTeam, finishTurn, runOf, taskOf, teamBot, teamLab, turnOf, until, waitRunning, type TeamLab } from './team-helpers.js'
import { DesktopConnector } from './desktop-helpers.js'

const labs: TeamLab[] = []
afterEach(async () => {
  for (const lab of labs.splice(0)) {
    await lab.service.close()
    await rm(lab.dir, { recursive: true, force: true })
  }
})
const skip = process.platform === 'win32'

/** A team on a lab whose guest supervisor implements the real desktop control protocol. */
async function desktopTeam() {
  const lab = await teamLab({ connector: new DesktopConnector() })
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  const carla = await teamBot(lab, 'Carla', ana.vmId)
  const team = await createTeam(lab, {
    name: 'Tela',
    members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }, { botId: carla.id }],
  })
  return { lab, ana, bruno, carla, team: team.team }
}
/** Opens the member's screen, acquires the handoff and claims input control. */
async function takeControl(lab: TeamLab, botId: string) {
  const opened = await lab.connected('bot.desktop.open', { botId, clientInstanceId: 'window-1' })
  const operation = await lab.connected('bot.desktop.acquire', { viewId: opened.viewId, expectedRevision: opened.state.revision, idempotencyKey: randomUUID() })
  const done = await until(() => lab.connected('bot.desktop.operation.get', { operationId: operation.id }), (op: any) => op.status !== 'running')
  const claim = await lab.connected('bot.desktop.claimControl', { viewId: opened.viewId, operationId: done.id })
  return { opened, operation: done, claim }
}
async function giveBack(lab: TeamLab, control: Awaited<ReturnType<typeof takeControl>>, botId: string, continueTask: boolean) {
  const operation = await lab.connected('bot.desktop.return', {
    botId,
    viewId: control.opened.viewId,
    controlCapability: control.claim.controlCapability,
    expectedRevision: (await lab.connected('bot.desktop.inspect', { botId })).revision,
    idempotencyKey: randomUUID(),
    continueTask,
  })
  return until(() => lab.connected('bot.desktop.operation.get', { operationId: operation.id }), (op: any) => op.status !== 'running')
}

/** Coordinator plans, delegates to both workers, and both are running. */
async function workingTeam() {
  const fixture = await desktopTeam()
  const { lab, ana, bruno, carla, team } = fixture
  const receipt = await ask(lab, team.id, 'Analise e escreva')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  await collaborate(lab, ana.id, planning.id, 'team_delegate', {
    tasks: [
      { localKey: 'analise', assigneeBotId: bruno.id, goal: 'analise os números' },
      { localKey: 'texto', assigneeBotId: carla.id, goal: 'escreva o texto' },
    ],
  })
  finishTurn(lab, ana.id, planning.id, 'distribuí')
  const brunoTurn = await turnOf(lab, receipt.run.id, bruno.id)
  const carlaTurn = await turnOf(lab, receipt.run.id, carla.id)
  // Both members are genuinely working before a test acts on them.
  await waitRunning(lab, brunoTurn.id)
  await waitRunning(lab, carlaTurn.id)
  return { ...fixture, run: receipt.run, brunoTurn, carlaTurn }
}

it.skipIf(skip)('pauses only the member under human control and continues its own task afterwards', async () => {
  const { lab, bruno, carla, run, brunoTurn, carlaTurn } = await workingTeam()
  const control = await takeControl(lab, bruno.id)

  const paused = await until(() => taskOf(lab, run.id, 'analise'), (task: any) => task.status === 'paused_human')
  expect(paused.status).toBe('paused_human')
  // Carla is independent: her task and her turn are untouched.
  expect((await taskOf(lab, run.id, 'texto')).status).toBe('running')
  expect((await lab.call('bot.turn.get', { turnId: carlaTurn.id })).status).toBe('running')
  expect((await lab.connected('bot.desktop.inspect', { botId: carla.id })).mode).toBe('bot')

  const returned = await giveBack(lab, control, bruno.id, true)
  expect(returned.status).toBe('succeeded')
  expect(returned.continuationTurnId).toBeTruthy()
  // The continuation keeps the same logical task and belongs to the scoped team thread.
  await waitRunning(lab, returned.continuationTurnId)
  const continuation = await lab.call('bot.turn.get', { turnId: returned.continuationTurnId })
  expect(continuation.conversationId).toBe(brunoTurn.conversationId)
  expect(continuation.conversationId).not.toBe((await lab.call('bot.inspect', { botId: bruno.id })).conversationId)
  const resumed = await until(() => taskOf(lab, run.id, 'analise'), (task: any) => task.status === 'running')
  expect(resumed.attempts).toBe(1)
  // A fresh capture is attached and the previous observations are explicitly invalidated.
  const message = (await lab.call('bot.messages.list', { botId: bruno.id, limit: 200 })).messages
  void message
  const snapshot = lab.guest(bruno.id).turns.get(continuation.id)!.snapshot
  expect(snapshot.attachments).toHaveLength(1)
  expect(snapshot.message).toContain('captura atual da tela')
  expect(snapshot.team.taskId).toBe(resumed.id)
})

it.skipIf(skip)('gives the continuation only the budget left, never a fresh allowance', async () => {
  const { lab, bruno, run, brunoTurn } = await workingTeam()
  const reserved = lab.guest(bruno.id).turns.get(brunoTurn.id)!.snapshot.limits
  const before = await runOf(lab, run.id)
  const control = await takeControl(lab, bruno.id)
  const returned = await giveBack(lab, control, bruno.id, true)
  await waitRunning(lab, returned.continuationTurnId)
  const continuation = lab.guest(bruno.id).turns.get(returned.continuationTurnId)!.snapshot
  // At most what the interrupted attempt had left, and no new parcel was taken.
  expect(continuation.limits.maxTools).toBeLessThanOrEqual(reserved.maxTools)
  expect(continuation.limits.activeMs).toBeLessThanOrEqual(reserved.activeMs)
  const after = await runOf(lab, run.id)
  expect(after.budget.toolCallsReserved).toBeLessThanOrEqual(before.budget.toolCallsReserved)
})

it.skipIf(skip)('ends the task explicitly when the person returns without continuing', async () => {
  const { lab, bruno, carla, run, carlaTurn } = await workingTeam()
  const control = await takeControl(lab, bruno.id)
  const returned = await giveBack(lab, control, bruno.id, false)
  expect(returned.continuationTurnId).toBeUndefined()

  const ended = await until(() => taskOf(lab, run.id, 'analise'), (task: any) => ['failed', 'cancelled'].includes(task.status))
  expect(ended.error?.code).toBe('HUMAN_TAKEOVER')
  // The team does not wait forever for a task the person closed.
  finishTurn(lab, carla.id, carlaTurn.id, 'texto pronto')
  const review = await turnOf(lab, run.id, (await lab.call('team.run.get', { runId: run.id })).coordinatorBotId)
  finishTurn(lab, (await runOf(lab, run.id)).coordinatorBotId, review.id, 'Só o texto ficou pronto.')
  const finished = await until(() => runOf(lab, run.id), (value: any) => ['partial', 'succeeded', 'failed'].includes(value.status))
  expect(finished.status).toBe('partial')
})

it.skipIf(skip)('stopping the team does not take the desktop away from a paused member', async () => {
  const { lab, bruno, carla, run, carlaTurn } = await workingTeam()
  await takeControl(lab, bruno.id)
  await until(() => taskOf(lab, run.id, 'analise'), (task: any) => task.status === 'paused_human')
  const before = lab.connector as DesktopConnector

  const current = await runOf(lab, run.id)
  await lab.call('team.run.cancel', { runId: run.id, expectedRevision: current.revision, idempotencyKey: 'stop' })
  const stopped = await until(() => runOf(lab, run.id), (value: any) => value.status === 'cancelled')
  expect(stopped.status).toBe('cancelled')
  // The person keeps the screen; nothing pauses or releases it to cancel a stopped task.
  expect((await lab.connected('bot.desktop.inspect', { botId: bruno.id })).mode).toBe('human')
  expect(before.count('desktop.release')).toBe(0)
  // Carla's turn was cancelled because she was actually working.
  expect((await lab.call('bot.turn.get', { turnId: carlaTurn.id })).status).toBe('cancelled')
  expect((await lab.call('bot.inspect', { botId: carla.id })).status).toBe('ready')
})

it.skipIf(skip)('refuses to resume work whose run was already stopped', async () => {
  const { lab, bruno, run } = await workingTeam()
  const control = await takeControl(lab, bruno.id)
  await until(() => taskOf(lab, run.id, 'analise'), (task: any) => task.status === 'paused_human')
  const current = await runOf(lab, run.id)
  await lab.call('team.run.cancel', { runId: run.id, expectedRevision: current.revision, idempotencyKey: 'stop' })
  await until(() => runOf(lab, run.id), (value: any) => value.status === 'cancelled')

  // Returning releases the screen for normal use but never revives finished work.
  const returned = await giveBack(lab, control, bruno.id, true)
  expect(returned.status).toBe('succeeded')
  expect((await lab.connected('bot.desktop.inspect', { botId: bruno.id })).mode).toBe('bot')
  expect((await runOf(lab, run.id)).status).toBe('cancelled')
  expect((await taskOf(lab, run.id, 'analise')).status).toBe('cancelled')
})

it.skipIf(skip)('shows a member approval in the team and never lets the coordinator answer it', async () => {
  const { lab, ana, bruno, run, brunoTurn } = await workingTeam()
  const guest = lab.guest(bruno.id)
  guest.emit({
    turnId: brunoTurn.id,
    generation: 1,
    kind: 'approval.requested',
    summary: 'Posso abrir o site do banco?',
    detail: { actionId: randomUUID(), title: 'Abrir o site do banco', reason: 'preciso dos dados', consequence: 'acessa a internet' },
  })
  const waiting = await until(() => taskOf(lab, run.id, 'analise'), (task: any) => task.status === 'waiting_approval')
  expect(waiting.status).toBe('waiting_approval')
  const events = await lab.call('team.events.list', { teamId: (await runOf(lab, run.id)).teamId })
  const request = events.events.find((event: any) => event.kind === 'approval.requested')
  // The team shows which member is asking, with its own name.
  expect(request.summary).toContain('Bruno')
  expect(request.botId).toBe(bruno.id)

  // The work says it is blocked on the person, instead of reporting that the members are working.
  expect((await runOf(lab, run.id)).status).toBe('waiting_user')

  const interaction = (await lab.call('bot.interactions.list', { botId: bruno.id }))[0]
  // The decision belongs to the person, on the member that asked; the coordinator has none.
  expect(await lab.call('bot.interactions.list', { botId: ana.id })).toEqual([])
  const resolved = await lab.call('bot.interactions.resolve', { interactionId: interaction.id, expectedGeneration: interaction.generation, decision: 'approve' })
  expect(resolved.status).toBe('approved')
  await until(() => taskOf(lab, run.id, 'analise'), (task: any) => task.status === 'running')
  // Once answered, the work goes back to reporting what it is actually doing.
  expect((await runOf(lab, run.id)).status).toBe('working')
})
