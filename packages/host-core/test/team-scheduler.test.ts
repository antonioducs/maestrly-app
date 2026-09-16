import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { TEAM_LIMITS } from '@maestrly/host-protocol'
import { ask, collaborate, createTeam, finishTurn, runOf, taskOf, teamBot, teamLab, turnOf, until, type TeamLab } from './team-helpers.js'

const labs: TeamLab[] = []
afterEach(async () => {
  for (const lab of labs.splice(0)) {
    await lab.service.close()
    await rm(lab.dir, { recursive: true, force: true })
  }
})
const skip = process.platform === 'win32'

/** A coordinator and two workers sharing one prepared computer, in separate sessions. */
async function trio(policy?: Record<string, unknown>) {
  const lab = await teamLab()
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  const carla = await teamBot(lab, 'Carla', ana.vmId)
  const team = await createTeam(lab, {
    name: 'Trio',
    members: [
      { botId: ana.id, role: 'coordenadora', coordinator: true },
      { botId: bruno.id, role: 'analista' },
      { botId: carla.id, role: 'redatora' },
    ],
    ...(policy ? { policy } : {}),
  })
  return { lab, ana, bruno, carla, team: team.team }
}
const tasks = (lab: TeamLab, runId: string) => lab.call('team.tasks.list', { runId }).then((page: any) => page.tasks)

it.skipIf(skip)('runs two members in parallel after planning and consolidates once', async () => {
  const { lab, ana, bruno, carla, team } = await trio()
  const receipt = await ask(lab, team.id, 'Analise o CSV e escreva as recomendações')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  await collaborate(lab, ana.id, planning.id, 'team_delegate', {
    tasks: [
      { localKey: 'analise', assigneeBotId: bruno.id, goal: 'some a coluna valor' },
      { localKey: 'texto', assigneeBotId: carla.id, goal: 'escreva as recomendações' },
    ],
  })
  // Workers do not start while the coordinator still holds its slot.
  expect((await tasks(lab, receipt.run.id)).filter((task: any) => task.kind === 'work').every((task: any) => task.status === 'planned')).toBe(true)
  finishTurn(lab, ana.id, planning.id, 'distribuí o trabalho')

  const brunoTurn = await turnOf(lab, receipt.run.id, bruno.id)
  const carlaTurn = await turnOf(lab, receipt.run.id, carla.id)
  // Real overlap: both members hold a running turn at the same instant.
  const running = await until(() => tasks(lab, receipt.run.id), (all: any[]) => all.filter((task) => task.status === 'running').length === 2)
  expect(running.filter((task: any) => task.status === 'running').map((task: any) => task.assigneeBotId).sort()).toEqual([bruno.id, carla.id].sort())
  expect((await runOf(lab, receipt.run.id)).status).toBe('working')

  finishTurn(lab, bruno.id, brunoTurn.id, 'A soma é 1234.')
  finishTurn(lab, carla.id, carlaTurn.id, 'Recomendo revisar os maiores gastos.')
  const review = await turnOf(lab, receipt.run.id, ana.id)
  const snapshot = lab.guest(ana.id).turns.get(review.id)!.snapshot
  // The coordinator is called back with the recorded results, not with chat history.
  expect(snapshot.team.dependencyResults.map((r: any) => r.summary)).toEqual(['A soma é 1234.', 'Recomendo revisar os maiores gastos.'])
  expect(snapshot.recentMessages).toEqual([])
  finishTurn(lab, ana.id, review.id, 'Resumo final: soma 1234 e recomendações revisadas.')

  const run = await until(() => runOf(lab, receipt.run.id), (value: any) => value.status === 'succeeded')
  expect(run.summary).toContain('Resumo final')
  const page = await lab.call('team.messages.list', { teamId: team.id })
  expect(page.messages.filter((message: any) => message.kind === 'answer')).toHaveLength(1)
  expect(run.budget.turns).toBe(4)
})

it.skipIf(skip)('serialises members when the team concurrency is one, without interrupting work', async () => {
  const { lab, ana, bruno, carla, team } = await trio({ concurrency: 1 })
  const receipt = await ask(lab, team.id, 'trabalho em série')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  await collaborate(lab, ana.id, planning.id, 'team_delegate', {
    tasks: [
      { localKey: 'a', assigneeBotId: bruno.id, goal: 'primeiro' },
      { localKey: 'b', assigneeBotId: carla.id, goal: 'segundo' },
    ],
  })
  finishTurn(lab, ana.id, planning.id, 'distribuí')
  const first = await turnOf(lab, receipt.run.id, bruno.id)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const during = await tasks(lab, receipt.run.id)
  expect(during.filter((task: any) => task.status === 'running')).toHaveLength(1)
  expect(during.find((task: any) => task.localKey === 'b').status).toBe('planned')
  // The waiting task never interrupts the one in progress.
  expect((await lab.call('bot.turn.get', { turnId: first.id })).status).toBe('running')
  finishTurn(lab, bruno.id, first.id, 'pronto um')
  const second = await turnOf(lab, receipt.run.id, carla.id)
  expect(second.botId).toBe(carla.id)
})

it.skipIf(skip)('rejects an invalid delegation before creating any task', async () => {
  const { lab, ana, bruno, team } = await trio()
  const receipt = await ask(lab, team.id, 'plano inválido')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  const before = await tasks(lab, receipt.run.id)
  for (const [payload, code] of [
    [[{ localKey: 'a', assigneeBotId: bruno.id, goal: 'x', dependsOn: ['b'] }], 'TEAM_DEPENDENCY_INVALID'],
    [
      [
        { localKey: 'a', assigneeBotId: bruno.id, goal: 'x', dependsOn: ['b'] },
        { localKey: 'b', assigneeBotId: bruno.id, goal: 'y', dependsOn: ['a'] },
      ],
      'TEAM_DEPENDENCY_INVALID',
    ],
    [[{ localKey: 'a', assigneeBotId: ana.id, goal: 'para mim' }], 'TEAM_DELEGATION_INVALID'],
    [[{ localKey: 'a', assigneeBotId: randomUUID(), goal: 'desconhecido' }], 'TEAM_MEMBER_INVALID'],
    [[{ localKey: 'a', assigneeBotId: bruno.id, goal: 'x', inputArtifactIds: [randomUUID()] }], 'TEAM_GRANT_REVOKED'],
  ] as const)
    await expect(collaborate(lab, ana.id, planning.id, 'team_delegate', { tasks: payload }), JSON.stringify(payload)).rejects.toMatchObject({ code })
  // Nothing of the rejected batches exists.
  expect(await tasks(lab, receipt.run.id)).toEqual(before)
})

it.skipIf(skip)('blocks a dependent task when its dependency failed and reports partial work', async () => {
  const { lab, ana, bruno, carla, team } = await trio()
  const receipt = await ask(lab, team.id, 'com dependência')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  await collaborate(lab, ana.id, planning.id, 'team_delegate', {
    tasks: [
      { localKey: 'dados', assigneeBotId: bruno.id, goal: 'extraia os dados' },
      { localKey: 'texto', assigneeBotId: carla.id, goal: 'escreva sobre os dados', dependsOn: ['dados'] },
    ],
  })
  finishTurn(lab, ana.id, planning.id, 'distribuí')
  const brunoTurn = await turnOf(lab, receipt.run.id, bruno.id)
  expect((await taskOf(lab, receipt.run.id, 'texto')).status).toBe('planned')
  finishTurn(lab, bruno.id, brunoTurn.id, '', 'failed')
  // The dependent task is skipped explicitly; it never runs with an empty input.
  const skipped = await until(() => taskOf(lab, receipt.run.id, 'texto'), (task: any) => task.status === 'skipped')
  expect(skipped.error?.code).toBe('TEAM_DEPENDENCY_INVALID')
  const review = await turnOf(lab, receipt.run.id, ana.id)
  finishTurn(lab, ana.id, review.id, 'Não consegui os dados; nada foi produzido.')
  const run = await until(() => runOf(lab, receipt.run.id), (value: any) => ['partial', 'failed', 'succeeded'].includes(value.status))
  // A coordinator claiming completion cannot turn a failed batch into success.
  expect(run.status).toBe('partial')
})

it.skipIf(skip)('treats a repeated collaboration request as the same action', async () => {
  const { lab, ana, bruno, team } = await trio()
  const receipt = await ask(lab, team.id, 'idempotência')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  const requestId = randomUUID()
  const params = { tasks: [{ localKey: 'a', assigneeBotId: bruno.id, goal: 'trabalhe' }] }
  const first = await lab.guest(ana.id).collaborate(planning.id, 'team_delegate', params, 1, requestId)
  const again = await lab.guest(ana.id).collaborate(planning.id, 'team_delegate', params, 1, requestId)
  expect(again.receiptId).toBe(first.receiptId)
  expect((await tasks(lab, receipt.run.id)).filter((task: any) => task.kind === 'work')).toHaveLength(1)
  // Same key with different content is a different action, not a retry.
  await expect(
    lab.guest(ana.id).collaborate(planning.id, 'team_delegate', { tasks: [{ localKey: 'b', assigneeBotId: bruno.id, goal: 'outra' }] }, 1, requestId)
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  // A second batch in the same round is refused; the receipt is consulted instead.
  await expect(collaborate(lab, ana.id, planning.id, 'team_delegate', { tasks: [{ localKey: 'c', assigneeBotId: bruno.id, goal: 'terceira' }] })).rejects.toMatchObject({
    code: 'TEAM_STAGE_INVALID',
  })
})

it.skipIf(skip)('keeps one budget for the whole work instead of one per member', async () => {
  const { lab, ana, bruno, carla, team } = await trio()
  const receipt = await ask(lab, team.id, 'orçamento')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  const planningLimits = lab.guest(ana.id).turns.get(planning.id)!.snapshot.limits
  await collaborate(lab, ana.id, planning.id, 'team_delegate', {
    tasks: [
      { localKey: 'a', assigneeBotId: bruno.id, goal: 'um' },
      { localKey: 'b', assigneeBotId: carla.id, goal: 'dois' },
    ],
  })
  finishTurn(lab, ana.id, planning.id, 'ok')
  const brunoTurn = await turnOf(lab, receipt.run.id, bruno.id)
  const carlaTurn = await turnOf(lab, receipt.run.id, carla.id)
  const run = await runOf(lab, receipt.run.id)
  const reserved = [planningLimits, lab.guest(bruno.id).turns.get(brunoTurn.id)!.snapshot.limits, lab.guest(carla.id).turns.get(carlaTurn.id)!.snapshot.limits]
  // Three members share one allowance, and part of it is held back for the closing turn.
  expect(reserved.reduce((sum, limits) => sum + limits.maxTools, 0)).toBeLessThanOrEqual(run.limits.maxToolCalls - TEAM_LIMITS.consolidationToolCalls)
  expect(run.budget.toolCallsReserved).toBeLessThanOrEqual(run.limits.maxToolCalls)
  expect(run.budget.consolidationHeld).toBe(true)
  // Consumption the provider did not report stays unknown instead of being counted as zero.
  expect(run.budget.tokensObserved).toBe(false)
  expect(run.budget.inputTokens).toBeUndefined()
})

it.skipIf(skip)('stops only this run when the person stops the team', async () => {
  const { lab, ana, bruno, carla, team } = await trio()
  const other = await createTeam(lab, { name: 'Outra', members: [{ botId: bruno.id, coordinator: true }, { botId: carla.id }] })
  const receipt = await ask(lab, team.id, 'trabalho a parar')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  await collaborate(lab, ana.id, planning.id, 'team_delegate', { tasks: [{ localKey: 'a', assigneeBotId: bruno.id, goal: 'trabalhe' }] })
  finishTurn(lab, ana.id, planning.id, 'distribuí')
  const brunoTurn = await turnOf(lab, receipt.run.id, bruno.id)
  const vmsBefore = await lab.call('vm.list', {})

  const current = await runOf(lab, receipt.run.id)
  await lab.call('team.run.cancel', { runId: receipt.run.id, expectedRevision: current.revision, idempotencyKey: 'stop-1' })
  const stopped = await until(() => runOf(lab, receipt.run.id), (value: any) => value.status === 'cancelled')
  expect(stopped.status).toBe('cancelled')
  expect((await lab.call('bot.turn.get', { turnId: brunoTurn.id })).status).toBe('cancelled')
  // The computers stay on and the other team is untouched.
  expect(await lab.call('vm.list', {})).toEqual(vmsBefore)
  expect((await lab.call('team.inspect', { teamId: other.team.id })).team.status).toBe('active')
  const carlaBot = await lab.call('bot.inspect', { botId: carla.id })
  expect(carlaBot.status).toBe('ready')
})
