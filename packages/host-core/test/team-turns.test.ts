import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ask, collaborate, createTeam, finishTurn, runOf, taskOf, teamBot, teamLab, turnOf, until, type TeamLab } from './team-helpers.js'

const labs: TeamLab[] = []
afterEach(async () => {
  for (const lab of labs.splice(0)) {
    await lab.service.close()
    await rm(lab.dir, { recursive: true, force: true })
  }
})
const skip = process.platform === 'win32'

it.skipIf(skip)('runs a team turn in its own thread without leaking the private conversation or memory', async () => {
  const lab = await teamLab()
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  // Private history and private memory that must never reach a team turn.
  await lab.call('bot.memory.upsert', { botId: ana.id, content: 'Segredo pessoal da Ana.' })
  const personal = await lab.call('bot.messages.send', { botId: ana.id, clientMessageId: randomUUID(), content: 'assunto particular' })
  await until(() => lab.call('bot.turn.get', { turnId: personal.turn.id }), (t: any) => t.status === 'running')
  lab.guest(ana.id).finish(personal.turn.id, 'succeeded', 'respondido em particular')
  await until(() => lab.call('bot.turn.get', { turnId: personal.turn.id }), (t: any) => t.status === 'succeeded')

  const team = await createTeam(lab, { name: 'Relatorios', members: [{ botId: ana.id, role: 'coordenadora', coordinator: true }, { botId: bruno.id, role: 'analista' }] })
  expect(team.team.coordinatorBotId).toBe(ana.id)
  const receipt = await ask(lab, team.team.id, 'Faça um resumo dos dados')
  const planning = await turnOf(lab, receipt.run.id, ana.id)

  const snapshot = lab.guest(ana.id).turns.get(planning.id)!.snapshot
  expect(snapshot.team).toBeTruthy()
  expect(snapshot.team.role).toBe('coordinator')
  expect(snapshot.team.stage).toBe('planning')
  expect(snapshot.team.tools).toContain('team_delegate')
  // The scoped thread is not the bot's own conversation and carries none of its context.
  expect(planning.conversationId).not.toBe((await lab.call('bot.inspect', { botId: ana.id })).conversationId)
  expect(snapshot.memory).toEqual([])
  expect(snapshot.recentMessages).toEqual([])
  expect(JSON.stringify(snapshot)).not.toContain('Segredo pessoal')
  expect(JSON.stringify(snapshot)).not.toContain('assunto particular')
  // A scoped thread never replaces the conversation the person sees.
  expect((await lab.call('bot.inspect', { botId: ana.id })).conversationId).toBe((await lab.call('bot.messages.list', { botId: ana.id })).conversation.id)
  expect((await lab.call('bot.messages.list', { botId: ana.id })).messages.map((m: any) => m.content)).toEqual([
    'assunto particular',
    'respondido em particular',
  ])
})

it.skipIf(skip)('keeps one execution per bot across the private chat and every team', async () => {
  const lab = await teamLab()
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  const first = await createTeam(lab, { name: 'Alfa', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })
  const second = await createTeam(lab, { name: 'Beta', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })

  const a = await ask(lab, first.team.id, 'primeiro pedido')
  const planning = await turnOf(lab, a.run.id, ana.id)
  const b = await ask(lab, second.team.id, 'segundo pedido')
  // The second team is accepted and waits: it never interrupts the running turn.
  expect((await runOf(lab, b.run.id)).status).toBe('planning')
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect((await taskOf(lab, b.run.id, 'coord-0')).status).toBe('planned')
  // The person cannot slip a private task into the same bot either.
  await expect(lab.call('bot.messages.send', { botId: ana.id, clientMessageId: randomUUID(), content: 'agora não' })).rejects.toMatchObject({ code: 'BOT_BUSY' })

  finishTurn(lab, ana.id, planning.id, 'Respondo direto: o resumo é este.')
  await until(() => runOf(lab, a.run.id), (run: any) => run.status === 'succeeded')
  // Only now does the queued team get the bot.
  const queued = await turnOf(lab, b.run.id, ana.id)
  expect(queued.conversationId).not.toBe(planning.conversationId)
})

it.skipIf(skip)('answers directly when the coordinator does not delegate', async () => {
  const lab = await teamLab()
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  const team = await createTeam(lab, { name: 'Direto', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })
  const receipt = await ask(lab, team.team.id, 'Qual é a capital do Brasil?')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  finishTurn(lab, ana.id, planning.id, 'Brasília.')
  const run = await until(() => runOf(lab, receipt.run.id), (value: any) => value.status === 'succeeded')
  expect(run.summary).toBe('Brasília.')
  const page = await lab.call('team.messages.list', { teamId: team.team.id })
  expect(page.messages.at(-1)).toMatchObject({ content: 'Brasília.', author: { kind: 'bot', botId: ana.id } })
  // The answer is attributed to the bot, never presented as if a person wrote it.
  expect(page.messages[0].author).toEqual({ kind: 'human' })
  expect((await lab.call('team.inspect', { teamId: team.team.id })).activeRun).toBeNull()
})

it.skipIf(skip)('applies the intersection of team and bot permissions and never widens them', async () => {
  const lab = await teamLab()
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  const team = await createTeam(lab, {
    name: 'Permissoes',
    members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }],
    policy: { permissionMode: 'full-vm' },
  })
  // The team asked for full-vm, but Ana herself is on ask: the turn stays on ask.
  const receipt = await ask(lab, team.team.id, 'trabalhe')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  expect(lab.guest(ana.id).turns.get(planning.id)!.snapshot.permissionMode).toBe('ask')
  expect((await lab.call('bot.inspect', { botId: ana.id })).permissionMode).toBe('ask')
})

it.skipIf(skip)('refuses collaboration from a foreign turn, a stale generation and a worker', async () => {
  const lab = await teamLab()
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  const team = await createTeam(lab, { name: 'Origem', members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }] })
  const receipt = await ask(lab, team.team.id, 'analise os dados')
  const planning = await turnOf(lab, receipt.run.id, ana.id)

  // Bruno's session cannot act on Ana's turn even knowing its identifier.
  await expect(collaborate(lab, bruno.id, planning.id, 'team_members')).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
  // A stale generation is refused.
  await expect(lab.guest(ana.id).collaborate(planning.id, 'team_members', {}, 9)).rejects.toMatchObject({ code: 'TEAM_STAGE_INVALID' })
  // The roster carries names and roles only.
  const members = await collaborate(lab, ana.id, planning.id, 'team_members')
  expect(members.members.map((m: any) => m.botId).sort()).toEqual([ana.id, bruno.id].sort())
  expect(JSON.stringify(members)).not.toContain('vm')
  expect(JSON.stringify(members)).not.toMatch(/accountId|apiKey|\/tmp|sock/)

  const batch = await collaborate(lab, ana.id, planning.id, 'team_delegate', {
    tasks: [{ localKey: 'analise', assigneeBotId: bruno.id, goal: 'analise os números' }],
  })
  expect(batch.finishTurn).toBe(true)
  finishTurn(lab, ana.id, planning.id, 'distribuí a tarefa')
  const worker = await turnOf(lab, receipt.run.id, bruno.id)
  // A worker cannot delegate, even though it knows the method name.
  await expect(collaborate(lab, bruno.id, worker.id, 'team_delegate', { tasks: [{ localKey: 'x', assigneeBotId: ana.id, goal: 'volte' }] })).rejects.toMatchObject({
    code: 'TEAM_STAGE_INVALID',
  })
})
