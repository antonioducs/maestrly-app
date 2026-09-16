import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { TEAM_LIMITS } from '@maestrly/host-protocol'
import { ask, collaborate, createTeam, finishTurn, runOf, taskOf, teamBot, teamLab, turnOf, until, waitRunning, type TeamLab } from './team-helpers.js'

const labs: TeamLab[] = []
afterEach(async () => {
  for (const lab of labs.splice(0)) {
    await lab.service.close()
    await rm(lab.dir, { recursive: true, force: true })
  }
})
const skip = process.platform === 'win32'

async function trio() {
  const lab = await teamLab()
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  const carla = await teamBot(lab, 'Carla', ana.vmId)
  return { lab, ana, bruno, carla }
}

it.skipIf(skip)('creating a team only links existing bots and never touches infrastructure', async () => {
  const { lab, ana, bruno } = await trio()
  const vmsBefore = await lab.call('vm.list', {})
  const botsBefore = await lab.call('bot.list', {})
  const provisions = lab.provider.calls.filter((call) => call === 'provision').length

  const created = await createTeam(lab, { name: 'Equipe', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })
  expect(created.team.hostId).toBe((await lab.call('host.inspect', {})).id)
  expect(created.members.map((member: any) => member.botId)).toEqual([ana.id, bruno.id])
  // No computer created, started or changed; no bot created or duplicated.
  expect(await lab.call('vm.list', {})).toEqual(vmsBefore)
  expect(await lab.call('bot.list', {})).toEqual(botsBefore)
  expect(lab.provider.calls.filter((call) => call === 'provision')).toHaveLength(provisions)
  // The three bots share one computer, started once during setup and never again.
  expect(lab.provider.calls.filter((call) => ['start', 'restart', 'shutdown', 'remove'].includes(call))).toEqual(['start'])
  // Repeating the same request returns the same team instead of creating another.
  const again = await createTeam(lab, { name: 'Equipe', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })
  expect(again.team.id).toBe(created.team.id)
  expect((await lab.call('team.list', {}))).toHaveLength(1)
})

it.skipIf(skip)('refuses an invalid roster, a foreign bot and two coordinators', async () => {
  const { lab, ana, bruno, carla } = await trio()
  const base = { idempotencyKey: randomUUID(), name: 'X', confirmSharing: true as const }
  for (const [members, code] of [
    [[{ botId: ana.id }, { botId: ana.id }], 'TEAM_MEMBER_INVALID'],
    [[{ botId: ana.id }, { botId: randomUUID() }], 'NOT_FOUND'],
    [
      [
        { botId: ana.id, coordinator: true },
        { botId: bruno.id, coordinator: true },
      ],
      'TEAM_COORDINATOR_REQUIRED',
    ],
  ] as const)
    await expect(lab.call('team.create', { ...base, idempotencyKey: randomUUID(), members })).rejects.toMatchObject({ code })
  // An archived bot cannot join a team.
  await lab.call('bot.archive', { botId: carla.id, expectedRevision: (await lab.call('bot.inspect', { botId: carla.id })).revision, idempotencyKey: randomUUID() })
  await expect(
    lab.call('team.create', { ...base, idempotencyKey: randomUUID(), members: [{ botId: ana.id }, { botId: carla.id }] })
  ).rejects.toMatchObject({ code: 'TEAM_MEMBER_INVALID' })
  expect(TEAM_LIMITS.membersMax).toBe(8)
})

it.skipIf(skip)('a bot may belong to several teams and each keeps its own history', async () => {
  const { lab, ana, bruno, carla } = await trio()
  const first = await createTeam(lab, { name: 'Alfa', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })
  const second = await createTeam(lab, { name: 'Beta', members: [{ botId: bruno.id, coordinator: true }, { botId: carla.id }] })
  expect(first.conversation.id).not.toBe(second.conversation.id)
  await ask(lab, first.team.id, 'pedido da alfa')
  expect((await lab.call('team.messages.list', { teamId: second.team.id })).messages).toEqual([])
  expect((await lab.call('team.messages.list', { teamId: first.team.id })).messages[0].content).toBe('pedido da alfa')
})

it.skipIf(skip)('changing the roster needs confirmation while work is running and applies only to the next run', async () => {
  const { lab, ana, bruno, carla } = await trio()
  const team = (await createTeam(lab, { name: 'Roster', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })).team
  const receipt = await ask(lab, team.id, 'trabalho em andamento')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  await waitRunning(lab, planning.id)

  const change = {
    teamId: team.id,
    expectedRevision: team.revision,
    idempotencyKey: randomUUID(),
    confirmSharing: true as const,
    members: [{ botId: ana.id, coordinator: true }, { botId: carla.id }],
  }
  // The affected work is named instead of being silently interrupted.
  await expect(lab.call('team.members.set', change)).rejects.toMatchObject({ code: 'TEAM_WORK_IN_PROGRESS' })
  // The running work still has its original roster.
  expect((await runOf(lab, receipt.run.id)).roster.map((entry: any) => entry.botId).sort()).toEqual([ana.id, bruno.id].sort())

  finishTurn(lab, ana.id, planning.id, 'terminei sozinha')
  await until(() => runOf(lab, receipt.run.id), (run: any) => run.status === 'succeeded')
  const updated = await lab.call('team.members.set', { ...change, idempotencyKey: randomUUID(), expectedRevision: (await lab.call('team.inspect', { teamId: team.id })).team.revision })
  expect(updated.members.map((member: any) => member.botId).sort()).toEqual([ana.id, carla.id].sort())
  // The new membership carries a new grant revision; old authorizations do not survive it.
  expect(updated.members.every((member: any) => member.grantRevision === 2)).toBe(true)
  // History of the previous work is preserved.
  expect((await runOf(lab, receipt.run.id)).roster.map((entry: any) => entry.botId).sort()).toEqual([ana.id, bruno.id].sort())
})

it.skipIf(skip)('blocks a queued team turn whose authorization was revoked before dispatch', async () => {
  const { lab, ana, bruno, carla } = await trio()
  const team = (await createTeam(lab, {
    name: 'Revogado',
    members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }, { botId: carla.id }],
  })).team
  const receipt = await ask(lab, team.id, 'delegue algo')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  await collaborate(lab, ana.id, planning.id, 'team_delegate', { tasks: [{ localKey: 'a', assigneeBotId: bruno.id, goal: 'trabalhe' }] })
  finishTurn(lab, ana.id, planning.id, 'distribuí')
  const worker = await turnOf(lab, receipt.run.id, bruno.id)
  await waitRunning(lab, worker.id)

  // The person removes Bruno and explicitly accepts stopping the work in progress.
  const removed = await lab.call('team.members.set', {
    teamId: team.id,
    expectedRevision: (await lab.call('team.inspect', { teamId: team.id })).team.revision,
    idempotencyKey: randomUUID(),
    confirmSharing: true,
    confirmStopActiveWork: true,
    members: [{ botId: ana.id, coordinator: true }, { botId: carla.id }],
  })
  expect(removed.members.map((member: any) => member.botId).sort()).toEqual([ana.id, carla.id].sort())
  const run = await until(() => runOf(lab, receipt.run.id), (value: any) => ['cancelled', 'partial', 'failed'].includes(value.status))
  expect(run.status).toBe('cancelled')
  expect((await lab.call('bot.turn.get', { turnId: worker.id })).status).toBe('cancelled')
  // Bruno itself is untouched: still ready, still on its computer, history intact.
  const bot = await lab.call('bot.inspect', { botId: bruno.id })
  expect(bot.status).toBe('ready')
  expect(bot.vmId).toBe(ana.vmId)
})

it.skipIf(skip)('archiving a team preserves its data and archives no bot or computer', async () => {
  const { lab, ana, bruno } = await trio()
  const team = (await createTeam(lab, { name: 'Arquivar', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })).team
  const receipt = await ask(lab, team.id, 'um pedido')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  // Archiving is refused while work is in progress.
  await expect(lab.call('team.archive', { teamId: team.id, expectedRevision: team.revision, idempotencyKey: randomUUID() })).rejects.toMatchObject({
    code: 'TEAM_WORK_IN_PROGRESS',
  })
  finishTurn(lab, ana.id, planning.id, 'pronto')
  await until(() => runOf(lab, receipt.run.id), (run: any) => run.status === 'succeeded')

  const vmsBefore = await lab.call('vm.list', {})
  const operation = await lab.call('team.archive', { teamId: team.id, expectedRevision: (await lab.call('team.inspect', { teamId: team.id })).team.revision, idempotencyKey: 'arch' })
  expect(operation.status).toBe('succeeded')
  expect(operation.detail).toMatchObject({ botsArchived: 0, computersChanged: 0 })
  expect(await lab.call('team.list', {})).toEqual([])
  expect((await lab.call('team.list', { includeArchived: true }))[0].status).toBe('archived')
  // Conversation and history survive; bots and computers are untouched.
  expect((await lab.call('team.messages.list', { teamId: team.id })).messages.length).toBeGreaterThan(0)
  expect((await lab.call('bot.inspect', { botId: ana.id })).status).toBe('ready')
  expect(await lab.call('vm.list', {})).toEqual(vmsBefore)
  // An archived team no longer accepts work.
  await expect(ask(lab, team.id, 'mais um pedido')).rejects.toMatchObject({ code: 'TEAM_ARCHIVED' })
})

it.skipIf(skip)('team memory is owned by the person and a bot proposal stays inert', async () => {
  const { lab, ana, bruno } = await trio()
  const team = (await createTeam(lab, { name: 'Memoria', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })).team
  const memory = await lab.call('team.memory.upsert', { teamId: team.id, content: 'Sempre citar a fonte dos números.' })
  expect(memory).toMatchObject({ origin: 'user', status: 'active', version: 1 })

  const receipt = await ask(lab, team.id, 'trabalhe')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  expect(lab.guest(ana.id).turns.get(planning.id)!.snapshot.team.memory).toMatchObject([{ content: 'Sempre citar a fonte dos números.' }])

  const proposal = await collaborate(lab, ana.id, planning.id, 'team_memory_propose', { content: 'A pessoa prefere tabelas.' })
  expect(proposal.status).toBe('proposed')
  // A proposal is not team memory until the person approves it.
  expect((await lab.call('team.memory.list', { teamId: team.id })).map((item: any) => item.content)).toEqual(['Sempre citar a fonte dos números.'])
  expect((await lab.call('team.memory.proposals', { teamId: team.id }))[0].content).toBe('A pessoa prefere tabelas.')
  const pending = (await lab.call('team.memory.proposals', { teamId: team.id }))[0]
  const approved = await lab.call('team.memory.decide', { teamId: team.id, memoryId: pending.id, expectedRevision: pending.revision, decision: 'approve' })
  expect(approved.status).toBe('active')
  expect(await lab.call('team.memory.list', { teamId: team.id })).toHaveLength(2)

  // Removing stops future injections; it does not rewrite what already reached a thread.
  const removed = await lab.call('team.memory.remove', { teamId: team.id, memoryId: memory.id, expectedRevision: memory.revision })
  expect(removed.status).toBe('removed')
  finishTurn(lab, ana.id, planning.id, 'ok')
  await until(() => runOf(lab, receipt.run.id), (run: any) => run.status === 'succeeded')
  const next = await ask(lab, team.id, 'outro pedido')
  const second = await turnOf(lab, next.run.id, ana.id)
  const injected = lab.guest(ana.id).turns.get(second.id)!.snapshot.team.memory
  expect(injected.map((item: any) => item.content)).toEqual(['A pessoa prefere tabelas.'])
  expect(lab.guest(ana.id).turns.get(planning.id)!.snapshot.team.memory).toHaveLength(1)
})
