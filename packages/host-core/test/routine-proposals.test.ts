import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ROUTINE_LIMITS } from '@maestrly/host-protocol'
import { activate, labBot, routineLab, until, weeklySpec, type RoutineLab } from './routine-helpers.js'

const labs: RoutineLab[] = []
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close().catch(() => {})
})
async function open() {
  const lab = await routineLab()
  labs.push(lab)
  await lab.service.ready()
  return lab
}
const schedule = { kind: 'weekly' as const, daysOfWeek: [1], hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' }

/** Issues a routine request exactly as the packaged runtime does, over that bot's own channel. */
function propose(lab: RoutineLab, botId: string, turnId: string, params: Record<string, unknown>, generation = 1) {
  return lab.routines.proposals.create({ botId, turnId, generation, params })
}
async function chatTurn(lab: RoutineLab, botId: string, content = 'toda segunda às nove, prepare o resumo') {
  const receipt = await lab.call('bot.messages.send', { botId, clientMessageId: randomUUID(), content })
  return receipt.turn.id as string
}

describe.skipIf(process.platform === 'win32')('a model may suggest, and only suggest', () => {
  it('creates an inert card that executes nothing', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const turnId = await chatTurn(lab, bot.id)
    const proposal = propose(lab, bot.id, turnId, { name: 'Resumo de segunda', request: 'Prepare o resumo semanal', schedule })
    expect(proposal.status).toBe('pending')
    // No routine, no occurrence, no second turn.
    expect(await lab.call('routine.list')).toEqual([])
    expect(lab.guest(bot.id).turns.size).toBe(1)
    const listed = await lab.call('routine.proposals.list', { target: { kind: 'bot', id: bot.id } })
    expect(listed.map((card: any) => card.id)).toEqual([proposal.id])
  })

  it('becomes a routine only through a preview the person confirms', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const turnId = await chatTurn(lab, bot.id)
    const proposal = propose(lab, bot.id, turnId, { name: 'Resumo de segunda', request: 'Prepare o resumo semanal', schedule })
    const preview = await lab.call('routine.preview', {
      spec: weeklySpec(bot.id, { name: proposal.name, request: proposal.request }),
      proposalId: proposal.id,
    })
    const details = await lab.call('routine.activate', { previewId: preview.previewId, fingerprint: preview.fingerprint, idempotencyKey: randomUUID(), confirmSchedule: true })
    expect(details.routine.status).toBe('active')
    // The card closes with the routine it became, and disappears from the pending list.
    const resolved = lab.routines.proposals.statusFor(bot.id, proposal.id)
    expect(resolved).toMatchObject({ status: 'activated', routineId: details.routine.id })
    expect(await lab.call('routine.proposals.list', { target: { kind: 'bot', id: bot.id } })).toEqual([])
  })

  it('stays consultable after the turn ends, and expires on its own', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const turnId = await chatTurn(lab, bot.id)
    const proposal = propose(lab, bot.id, turnId, { name: 'Resumo', request: 'Prepare o resumo', schedule })
    lab.guest(bot.id).finish(turnId, 'succeeded', 'sugeri uma rotina')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(lab.routines.proposals.statusFor(bot.id, proposal.id).status).toBe('pending')

    lab.clock.advance(ROUTINE_LIMITS.proposalTtlMs + 1_000)
    expect(await lab.call('routine.proposals.list', {})).toEqual([])
    expect(lab.routines.proposals.statusFor(bot.id, proposal.id).status).toBe('expired')
  })

  it('can be dismissed, and dismissing twice is not an error', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const turnId = await chatTurn(lab, bot.id)
    const proposal = propose(lab, bot.id, turnId, { name: 'Resumo', request: 'Prepare o resumo', schedule })
    const dismissed = await lab.call('routine.proposals.dismiss', { proposalId: proposal.id, expectedRevision: proposal.revision })
    expect(dismissed.status).toBe('dismissed')
    expect((await lab.call('routine.proposals.dismiss', { proposalId: proposal.id, expectedRevision: dismissed.revision })).status).toBe('dismissed')
  })
})

describe.skipIf(process.platform === 'win32')('who is allowed to suggest', () => {
  it('refuses a scheduled occurrence, so a routine cannot breed routines', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, weeklySpec(bot.id, { schedule: { kind: 'daily', hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' } } as never))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    expect(() => propose(lab, bot.id, occurrence.execution.turnId, { name: 'Outra', request: 'faça mais', schedule })).toThrow(/programada não pode criar/)
    // And the scheduled turn was never offered the tool in the first place.
    const context = lab.routines.proposals.context(bot.id, occurrence.execution.turnId, occurrence.execution.conversationId)
    expect(context.canPropose).toBe(false)
    expect(context.tools).toEqual([])
  })

  it('refuses a bot acting for a turn that is not its own', async () => {
    const lab = await open()
    const first = await labBot(lab, 'Primeira')
    const second = await labBot(lab, 'Segunda')
    const turnId = await chatTurn(lab, first.id)
    expect(() => propose(lab, second.id, turnId, { name: 'R', request: 'faça', schedule })).toThrow(/não pertence a este bot/)
  })

  it('refuses a frame from a superseded attempt', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const turnId = await chatTurn(lab, bot.id)
    expect(() => propose(lab, bot.id, turnId, { name: 'R', request: 'faça', schedule }, 7)).toThrow(/foi substituída/)
  })

  it('refuses a turn that already ended', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const turnId = await chatTurn(lab, bot.id)
    lab.guest(bot.id).finish(turnId, 'succeeded', 'pronto')
    await until(() => lab.call('bot.turn.get', { turnId }), (turn: any) => turn.status === 'succeeded')
    expect(() => propose(lab, bot.id, turnId, { name: 'R', request: 'faça', schedule })).toThrow(/já terminou/)
  })

  it('caps how many cards one turn and one target may hold', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const turnId = await chatTurn(lab, bot.id)
    for (let index = 0; index < ROUTINE_LIMITS.proposalsPerTurnMax; index++)
      propose(lab, bot.id, turnId, { name: `R${index}`, request: 'faça', schedule })
    expect(() => propose(lab, bot.id, turnId, { name: 'demais', request: 'faça', schedule })).toThrow(/sugeriu rotinas demais/)
  })

  it('refuses a schedule that already passed instead of moving it silently', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const turnId = await chatTurn(lab, bot.id)
    expect(() =>
      propose(lab, bot.id, turnId, { name: 'R', request: 'faça', schedule: { kind: 'once', atUtc: '2020-01-01T00:00:00.000Z', timeZone: 'America/Sao_Paulo' } })
    ).toThrow(/já passou/)
  })

  it('asks the person to confirm the zone when the Host never knew it', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const turnId = await chatTurn(lab, bot.id)
    const first = propose(lab, bot.id, turnId, { name: 'R', request: 'faça', schedule })
    expect(first.clarification).toContain('fuso horário')
    // Once the person activated a routine with a zone, the Host knows it and stops asking.
    const preview = await lab.call('routine.preview', { spec: weeklySpec(bot.id) })
    await lab.call('routine.activate', { previewId: preview.previewId, fingerprint: preview.fingerprint, idempotencyKey: randomUUID(), confirmSchedule: true })
    const second = propose(lab, bot.id, turnId, { name: 'R2', request: 'faça', schedule })
    expect(second.clarification).toBeUndefined()
    expect(lab.routines.proposals.context(bot.id, turnId, bot.conversationId).timeZone).toBe('America/Sao_Paulo')
  })
})

describe.skipIf(process.platform === 'win32')('team suggestions', () => {
  async function teamLab() {
    const lab = await open()
    const coordinator = await labBot(lab, 'Coordenadora')
    const member = await labBot(lab, 'Analista')
    const team = await lab.call('team.create', {
      idempotencyKey: randomUUID(),
      name: 'Relatórios',
      objective: '',
      confirmSharing: true,
      members: [
        { botId: coordinator.id, role: '', coordinator: true },
        { botId: member.id, role: '', coordinator: false },
      ],
    })
    return { lab, coordinator, member, team: team.team }
  }

  it('lets the coordinator of work a person started suggest a routine for that team', async () => {
    const { lab, coordinator, team } = await teamLab()
    const sent = await lab.call('team.messages.send', { teamId: team.id, clientMessageId: randomUUID(), content: 'prepare o relatório' })
    const turn = await until(
      async () => (await lab.call('team.tasks.list', { runId: sent.run.id })).turns.find((candidate: any) => candidate.botId === coordinator.id),
      (value) => !!value,
      8_000
    )
    const proposal = propose(lab, coordinator.id, turn.id, { name: 'Relatório semanal', request: 'Prepare o relatório', schedule })
    expect(proposal.target).toEqual({ kind: 'team', id: team.id })
  })

  it('refuses a delegated worker, however much it knows the tool name', async () => {
    const { lab, coordinator, member, team } = await teamLab()
    const sent = await lab.call('team.messages.send', { teamId: team.id, clientMessageId: randomUUID(), content: 'prepare o relatório' })
    const planning = await until(
      async () => (await lab.call('team.tasks.list', { runId: sent.run.id })).turns.find((candidate: any) => candidate.botId === coordinator.id),
      (value) => !!value,
      8_000
    )
    await until(() => lab.call('bot.turn.get', { turnId: planning.id }), (turn: any) => turn.status === 'running', 8_000)
    lab.guest(coordinator.id).collaborate(planning.id, 'team_delegate', {
      tasks: [{ localKey: 'a', assigneeBotId: member.id, goal: 'Levantar os números', acceptanceCriteria: '', dependsOn: [], inputArtifactIds: [], useDependencyOutputs: true }],
    })
    lab.guest(coordinator.id).finish(planning.id, 'succeeded', 'deleguei')
    const workerTurn = await until(
      async () => (await lab.call('team.tasks.list', { runId: sent.run.id })).turns.find((candidate: any) => candidate.botId === member.id),
      (value) => !!value,
      8_000
    )
    expect(() => propose(lab, member.id, workerTurn.id, { name: 'R', request: 'faça', schedule })).toThrow(/Só uma conversa sua|coordena/)
    const context = lab.routines.proposals.context(member.id, workerTurn.id, workerTurn.conversationId)
    expect(context.canPropose).toBe(false)
  })
})
