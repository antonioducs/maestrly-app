import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { TEAM_HOST_CAPABILITY, teamMethods, teamResultSchemas } from '@maestrly/host-protocol'
import { ask, createTeam, finishTurn, runOf, teamBot, teamLab, turnOf, until, type TeamLab } from './team-helpers.js'

const labs: TeamLab[] = []
afterEach(async () => {
  for (const lab of labs.splice(0)) {
    await lab.service.close()
    await rm(lab.dir, { recursive: true, force: true })
  }
})
const skip = process.platform === 'win32'

async function duo() {
  const lab = await teamLab()
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  const team = (await createTeam(lab, { name: 'API', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })).team
  return { lab, ana, bruno, team }
}

it.skipIf(skip)('answers every team method with its declared result shape', async () => {
  const { lab, ana, bruno, team } = await duo()
  const receipt = await ask(lab, team.id, 'um pedido')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  const memory = await lab.call('team.memory.upsert', { teamId: team.id, content: 'uma anotação' })
  lab.guest(ana.id).files.set('saida.txt', Buffer.from('conteúdo'))
  const shared = await lab.call('team.artifacts.share', { teamId: team.id, idempotencyKey: 'share', botId: ana.id, path: 'saida.txt' })
  const artifactId = shared.detail.artifactId as string

  const calls: [string, unknown][] = [
    ['team.list', {}],
    ['team.inspect', { teamId: team.id }],
    ['team.messages.list', { teamId: team.id }],
    ['team.messages.lookup', { teamId: team.id, clientMessageId: randomUUID() }],
    ['team.run.get', { runId: receipt.run.id }],
    ['team.tasks.list', { runId: receipt.run.id }],
    ['team.events.list', { teamId: team.id }],
    ['team.memory.list', { teamId: team.id }],
    ['team.memory.proposals', { teamId: team.id }],
    ['team.artifacts.list', { teamId: team.id }],
    ['team.operation.get', { operationId: shared.id }],
    ['team.operation.lookup', { idempotencyKey: 'share' }],
    ['team.operation.lookup', { idempotencyKey: randomUUID() }],
  ]
  for (const [method, params] of calls) {
    const result = await lab.call(method, params)
    expect(teamResultSchemas[method as keyof typeof teamResultSchemas].safeParse(result).success, `${method}: ${JSON.stringify(result).slice(0, 200)}`).toBe(true)
  }
  // Every declared method is reachable and every mutation carries its receipt.
  expect(teamMethods.length).toBe(Object.keys(teamResultSchemas).length)
  expect((await lab.call('host.inspect', {})).capabilities).toContain(TEAM_HOST_CAPABILITY)

  const decided = await lab.call('team.memory.remove', { teamId: team.id, memoryId: memory.id, expectedRevision: memory.revision })
  expect(teamResultSchemas['team.memory.remove'].safeParse(decided).success).toBe(true)
  const revoked = await lab.call('team.artifacts.revoke', { teamId: team.id, artifactId, idempotencyKey: 'revoke' })
  expect(teamResultSchemas['team.artifacts.revoke'].safeParse(revoked).success).toBe(true)
  finishTurn(lab, ana.id, planning.id, 'pronto')
  await until(() => runOf(lab, receipt.run.id), (run: any) => run.status === 'succeeded')
  void bruno
})

it.skipIf(skip)('rejects an unknown team, a stale revision and a reused key with other parameters', async () => {
  const { lab, ana, bruno, team } = await duo()
  await expect(lab.call('team.inspect', { teamId: randomUUID() })).rejects.toMatchObject({ code: 'TEAM_NOT_FOUND' })
  await expect(lab.call('team.update', { teamId: team.id, expectedRevision: team.revision + 5, name: 'Outro' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  // The fingerprint covers the whole request, not only its text.
  const key = randomUUID()
  await lab.call('team.create', {
    idempotencyKey: key,
    name: 'Nova',
    confirmSharing: true,
    members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }],
  })
  await expect(
    lab.call('team.create', { idempotencyKey: key, name: 'Nova', confirmSharing: true, members: [{ botId: bruno.id, coordinator: true }, { botId: ana.id }] })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  // full-vm for a whole team needs an explicit confirmation.
  await expect(
    lab.call('team.update', { teamId: team.id, expectedRevision: team.revision, policy: { permissionMode: 'full-vm' } })
  ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
})

it.skipIf(skip)('pages messages, tasks and events with an exclusive cursor', async () => {
  const { lab, ana, team } = await duo()
  for (let index = 0; index < 4; index++) {
    const receipt = await ask(lab, team.id, `pedido ${index}`)
    const planning = await turnOf(lab, receipt.run.id, ana.id)
    finishTurn(lab, ana.id, planning.id, `resposta ${index}`)
    await until(() => runOf(lab, receipt.run.id), (run: any) => run.status === 'succeeded')
  }
  const page = await lab.call('team.messages.list', { teamId: team.id, limit: 3 })
  expect(page.messages).toHaveLength(3)
  expect(page.hasMore).toBe(true)
  const older = await lab.call('team.messages.list', { teamId: team.id, limit: 3, before: page.messages[0].sequence })
  expect(older.messages.every((message: any) => message.sequence < page.messages[0].sequence)).toBe(true)
  // Runs referenced by the page come with it, so the UI never guesses.
  expect(page.runs.length).toBeGreaterThan(0)

  const events = await lab.call('team.events.list', { teamId: team.id, limit: 5 })
  expect(events.events).toHaveLength(5)
  const next = await lab.call('team.events.list', { teamId: team.id, after: events.cursor, limit: 5 })
  expect(next.events.every((event: any) => event.seq > events.cursor)).toBe(true)
})

it.skipIf(skip)('never exposes credentials, Host paths or provider payloads in team results', async () => {
  const { lab, ana, team } = await duo()
  lab.guest(ana.id).files.set('dados.csv', Buffer.from('a,b\n1,2\n'))
  await lab.call('team.artifacts.share', { teamId: team.id, idempotencyKey: 'share', botId: ana.id, path: 'dados.csv' })
  const receipt = await ask(lab, team.id, 'trabalhe')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  finishTurn(lab, ana.id, planning.id, 'pronto')
  await until(() => runOf(lab, receipt.run.id), (run: any) => run.status === 'succeeded')

  const payload = JSON.stringify([
    await lab.call('team.inspect', { teamId: team.id }),
    await lab.call('team.messages.list', { teamId: team.id }),
    await lab.call('team.tasks.list', { runId: receipt.run.id }),
    await lab.call('team.events.list', { teamId: team.id }),
    await lab.call('team.artifacts.list', { teamId: team.id }),
  ])
  expect(payload).not.toContain(lab.dir)
  expect(payload).not.toContain('.sock')
  for (const secret of ['apiKey', 'OPENAI', 'credential', 'dataBase64', 'controlCapability', 'mediaTicket'])
    expect(payload, secret).not.toContain(secret)
})

it.skipIf(skip)('keeps the collaboration lane separate from the public administrative API', async () => {
  const { lab, ana, team } = await duo()
  const receipt = await ask(lab, team.id, 'trabalhe')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  // A model cannot reach an administrative method through the collaboration channel.
  for (const method of ['team.archive', 'vm.shutdown', 'bot.archive', 'team.members.set'])
    await expect(lab.guest(ana.id).collaborate(planning.id, method)).rejects.toBeTruthy()
  expect((await lab.call('team.list', {}))[0].status).toBe('active')
  expect((await lab.call('bot.inspect', { botId: ana.id })).status).toBe('ready')
})
