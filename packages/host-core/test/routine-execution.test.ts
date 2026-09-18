import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CompositeContinuationScope, OwnershipConflict, composeBudgetCeilings } from '../src/bots/scoped-execution.js'
import { BackgroundAdmission } from '../src/teams/background-admission.js'
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
const daily = (botId: string, extra: Record<string, unknown> = {}) =>
  weeklySpec(botId, {
    schedule: { kind: 'daily', hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' },
    ...extra,
  } as never)
const fire = async (lab: RoutineLab, at = '2026-09-14T12:00:05.000Z') => {
  lab.clock.set(at)
  await lab.tick()
}

describe.skipIf(process.platform === 'win32')('admitting scheduled work into the engine that already exists', () => {
  it("uses one scoped thread, the person's conversation untouched, and no private context", async () => {
    const lab = await open()
    const bot = await labBot(lab)
    await lab.call('bot.memory.upsert', { botId: bot.id, content: 'Minha senha do banco fica no cofre' })
    await lab.call('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: 'assunto particular' })
    const human = await lab.call('bot.inspect', { botId: bot.id })
    lab.guest(bot.id).finish(human.activeTurnId, 'succeeded', 'ok')
    await new Promise((resolve) => setTimeout(resolve, 40))

    const { routine } = await activate(lab, daily(bot.id))
    await fire(lab)
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    expect(occurrence.execution.kind).toBe('bot')
    expect(occurrence.execution.conversationId).toBe(`routine:${occurrence.id}`)

    const snapshot = lab.guest(bot.id).turns.get(occurrence.execution.turnId)!.snapshot
    // A scheduled run carries the request and the bot's own instructions, never the private
    // chat history and never the private memory.
    expect(snapshot.message).toContain('Prepare o resumo semanal')
    expect(snapshot.memory).toEqual([])
    expect(snapshot.recentMessages).toEqual([])
    expect(JSON.stringify(snapshot)).not.toContain('assunto particular')
    expect(JSON.stringify(snapshot)).not.toContain('senha do banco')
    // The person's own conversation is still the one they see.
    expect((await lab.call('bot.inspect', { botId: bot.id })).conversationId).not.toBe(
      occurrence.execution.conversationId
    )
  })

  it('sends a guest that never announced routines the exact shape it knows, and no retry storm', async () => {
    // Seen on the Mac mini: a Host newer than its guest attached the routine section to every
    // turn; the guest's strict schema refused it and the Host re-sent the same turn for minutes.
    const lab = await open()
    const bot = await labBot(lab)
    const guest = lab.guest(bot.id)
    guest.capabilities = guest.capabilities.filter((capability) => capability !== 'bot.routines.v1')
    await lab.call('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: 'olá' })
    const human = await lab.call('bot.inspect', { botId: bot.id })
    await until(() => guest.turns.has(human.activeTurnId), (reached) => reached)
    expect(guest.turns.get(human.activeTurnId)!.snapshot).not.toHaveProperty('routines')
    guest.finish(human.activeTurnId, 'succeeded', 'ok')
    await new Promise((resolve) => setTimeout(resolve, 40))

    // A scheduled firing still runs on that older guest: executing needs no routine tools.
    const { routine } = await activate(lab, daily(bot.id))
    await fire(lab)
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    expect(guest.turns.get(occurrence.execution.turnId)!.snapshot).not.toHaveProperty('routines')
    expect(guest.requests.filter((request) => request.method === 'turn.start' && request.params.turnId === occurrence.execution.turnId)).toHaveLength(1)

    // And a guest that rejects the shape outright ends the turn with a reason, not a loop.
    guest.finish(occurrence.execution.turnId, 'succeeded', 'feito')
    await new Promise((resolve) => setTimeout(resolve, 40))
    guest.handler = async (method) => {
      if (method !== 'turn.start') return undefined
      const { HostError } = await import('../src/errors.js')
      throw new HostError('INVALID_REQUEST', 'Invalid request method or parameters')
    }
    const sent = await lab.call('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: 'de novo' })
    const rejected = await until(
      () => lab.call('bot.turn.get', { turnId: sent.turn.id }),
      (turn) => ['failed', 'cancelled', 'interrupted', 'succeeded'].includes(turn.status)
    )
    expect(rejected.status).toBe('failed')
    expect(rejected.error?.code).toBe('RUNTIME_UPDATE_REQUIRED')
    expect((await lab.call('bot.inspect', { botId: bot.id })).activeTurnId).toBeUndefined()
    const attempts = guest.requests.filter((request) => request.method === 'turn.start' && request.params.message === 'de novo')
    expect(attempts).toHaveLength(1)
  })

  it('tells the bot plainly that nobody is watching and what the limits are', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    await fire(lab)
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    const snapshot = lab.guest(bot.id).turns.get(occurrence.execution.turnId)!.snapshot
    expect(snapshot.message).toContain('execução programada')
    expect(snapshot.message).toContain('2026-09-14 09:00')
    expect(snapshot.instructions).toContain('não pode criar, alterar, ativar nem apagar rotinas')
    expect(snapshot.limits.activeMs).toBe(30 * 60_000)
    expect(snapshot.limits.maxTools).toBe(80)
  })

  it('never admits a second turn for the same firing, however often the tick runs', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    await fire(lab)
    const first = (await lab.call('routine.inspect', { routineId: routine.id })).active
    await lab.tick()
    await lab.tick()
    const guest = lab.guest(bot.id)
    expect([...guest.turns.keys()]).toEqual([first.execution.turnId])
    expect(lab.routines.repo.executionsOf(first.id).length).toBe(1)
  })

  it('carries the result of the scheduled run back onto the occurrence', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    await fire(lab)
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    lab.guest(bot.id).finish(occurrence.execution.turnId, 'succeeded', 'Resumo da semana: tudo certo.')
    const settled = await until(
      () => lab.call('routine.occurrence.inspect', { occurrenceId: occurrence.id }),
      (value: any) => value.status === 'succeeded'
    )
    expect(settled.summary).toBe('Resumo da semana: tudo certo.')
    expect(settled.finishedAt).toBeTruthy()
    // Known consumption replaces the conservative reservation.
    expect(settled.usedActiveMs).toBeLessThan(30 * 60_000)
  })

  it('reports a failed run as failed, with the reason the engine gave', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    await fire(lab)
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    const guest = lab.guest(bot.id)
    guest.turns.get(occurrence.execution.turnId)!.status = 'failed'
    guest.emit({
      turnId: occurrence.execution.turnId,
      generation: 1,
      kind: 'turn.status',
      summary: 'failed',
      detail: { status: 'failed', error: { code: 'TOOL_FAILED', message: 'não deu' } },
    })
    const settled = await until(
      () => lab.call('routine.occurrence.inspect', { occurrenceId: occurrence.id }),
      (value: any) => value.status === 'failed'
    )
    expect(settled.error).toMatchObject({ code: 'TOOL_FAILED' })
  })

  it('mirrors a wait for the person without pretending the bot is working', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    await fire(lab)
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    lab.guest(bot.id).emit({
      turnId: occurrence.execution.turnId,
      generation: 1,
      kind: 'approval.requested',
      summary: 'Posso apagar a pasta?',
      detail: { actionId: 'a-1', title: 'Apagar pasta', kind: 'approval', parameters: {}, reason: '', consequence: '' },
    })
    const waiting = await until(
      () => lab.call('routine.occurrence.inspect', { occurrenceId: occurrence.id }),
      (value: any) => value.status === 'waiting_user'
    )
    expect(waiting.status).toBe('waiting_user')
    // Still holding its slot, still not finished: nobody is told the work is done.
    expect(waiting.finishedAt).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('stopping without collateral damage', () => {
  it('cancels a firing that never reached a bot locally, consuming nothing', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    await lab.call('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: 'ocupado' })
    await fire(lab)
    const pending = (await lab.call('routine.inspect', { routineId: routine.id })).active
    expect(pending.status).toBe('waiting_resource')
    const cancelled = await lab.call('routine.occurrence.cancel', {
      occurrenceId: pending.id,
      expectedRevision: pending.revision,
      idempotencyKey: randomUUID(),
    })
    expect(cancelled).toMatchObject({ status: 'cancelled', causeCode: 'STOPPED_BY_USER', usedActiveMs: 0 })
    expect(lab.guest(bot.id).turns.size).toBe(1) // only the person's own task
  })

  it('stops a running firing through the existing cancellation path and leaves the bot alive', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    await fire(lab)
    const running = (await lab.call('routine.inspect', { routineId: routine.id })).active
    await lab.call('routine.occurrence.cancel', {
      occurrenceId: running.id,
      expectedRevision: running.revision,
      idempotencyKey: randomUUID(),
    })
    const settled = await until(
      () => lab.call('routine.occurrence.inspect', { occurrenceId: running.id }),
      (value: any) => ['cancelled', 'failed'].includes(value.status)
    )
    expect(settled.status).toBe('cancelled')
    // The bot is free again and its computer was never touched.
    expect((await lab.call('bot.inspect', { botId: bot.id })).status).toBe('ready')
    expect(lab.provider.calls).not.toContain('shutdown')
  })

  it('refuses to stop an execution the person has not seen the current state of', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    await fire(lab)
    const running = (await lab.call('routine.inspect', { routineId: routine.id })).active
    await expect(
      lab.call('routine.occurrence.cancel', {
        occurrenceId: running.id,
        expectedRevision: running.revision + 7,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  })
})

describe.skipIf(process.platform === 'win32')('one owner per turn, one pool of background slots', () => {
  it('fails closed if two domains ever claim the same turn', () => {
    const scope = new CompositeContinuationScope()
    scope.register('teams', { resolve: () => ({ conversationId: 'team-thread' }), record: () => {} })
    scope.register('routines', { resolve: () => ({ conversationId: 'routine-thread' }), record: () => {} })
    expect(() => scope.resolve('turn-1')).toThrow(OwnershipConflict)
    const ceiling = composeBudgetCeilings([
      { domain: 'teams', ceiling: () => ({ activeMs: 1, maxTools: 1 }) },
      { domain: 'routines', ceiling: () => ({ activeMs: 2, maxTools: 2 }) },
    ])
    expect(() => ceiling('turn-1')).toThrow(OwnershipConflict)
  })

  it('resolves to the single owner and to nobody when no domain claims the turn', () => {
    const scope = new CompositeContinuationScope()
    scope.register('teams', {
      resolve: (id) => (id === 'team-turn' ? { conversationId: 'team-thread' } : undefined),
      record: () => {},
    })
    scope.register('routines', {
      resolve: (id) => (id === 'routine-turn' ? { conversationId: 'routine-thread' } : undefined),
      record: () => {},
    })
    expect(scope.resolve('team-turn')).toEqual({ conversationId: 'team-thread' })
    expect(scope.resolve('routine-turn')).toEqual({ conversationId: 'routine-thread' })
    expect(scope.resolve('private-chat-turn')).toBeUndefined()
  })

  it('shares background slots between team tasks and routines instead of doubling them', () => {
    let teamTasks = 0
    let routineOccurrences = 0
    const admission = new BackgroundAdmission(() => ({ teamTasks, routineOccurrences }), 2)
    expect(admission.available()).toBe(true)
    teamTasks = 2
    expect(admission.available()).toBe(false)
    teamTasks = 1
    routineOccurrences = 1
    // A routine does NOT get its own extra pair of slots on top of team work.
    expect(admission.available()).toBe(false)
    expect(admission.remaining()).toBe(0)
    routineOccurrences = 0
    expect(admission.remaining()).toBe(1)
  })

  it('queues a firing when the Host already has its background slots busy', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    const admission = lab.service.domains.bots.background
    const original = admission.available.bind(admission)
    ;(admission as unknown as { available: () => boolean }).available = () => false
    try {
      await fire(lab)
      expect((await lab.call('routine.inspect', { routineId: routine.id })).active).toMatchObject({
        status: 'waiting_resource',
        causeCode: 'TARGET_BUSY',
      })
      expect(lab.guest(bot.id).turns.size).toBe(0)
    } finally {
      ;(admission as unknown as { available: () => boolean }).available = original
    }
    lab.clock.advance(30_000)
    await lab.tick()
    expect((await lab.call('routine.inspect', { routineId: routine.id })).active?.status).toBe('running')
  })

  it('keeps two routines on the same bot strictly sequential', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const first = await activate(lab, daily(bot.id, { name: 'Primeira' }))
    const second = await activate(
      lab,
      daily(bot.id, { name: 'Segunda', schedule: { kind: 'daily', hour: 9, minute: 1, timeZone: 'America/Sao_Paulo' } })
    )
    // Each firing is picked up inside its own tolerance window, a minute apart.
    lab.clock.set('2026-09-14T12:00:30.000Z')
    await lab.tick()
    lab.clock.set('2026-09-14T12:01:30.000Z')
    await lab.tick()
    const states = [
      (await lab.call('routine.inspect', { routineId: first.routine.id })).active,
      (await lab.call('routine.inspect', { routineId: second.routine.id })).active,
    ]
    // Exactly one is working; the other is queued, not failed.
    expect(states.filter((occurrence: any) => occurrence?.status === 'running').length).toBe(1)
    expect(states.filter((occurrence: any) => occurrence?.status === 'waiting_resource').length).toBe(1)
    expect(lab.guest(bot.id).turns.size).toBe(1)
  })
})

describe.skipIf(process.platform === 'win32')('scheduled work on a team', () => {
  it('opens one run authored by the system, with the routine named beside it', async () => {
    const lab = await open()
    const coordinator = await labBot(lab, 'Coordenadora')
    const member = await labBot(lab, 'Analista')
    const team = await lab.call('team.create', {
      idempotencyKey: randomUUID(),
      name: 'Relatórios',
      objective: '',
      confirmSharing: true,
      members: [
        { botId: coordinator.id, role: 'coordena', coordinator: true },
        { botId: member.id, role: 'analisa', coordinator: false },
      ],
    })
    const { routine } = await activate(lab, {
      name: 'Relatório semanal',
      request: 'Prepare o relatório semanal',
      target: { kind: 'team', id: team.team.id },
      schedule: { kind: 'daily', hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' },
    } as never)
    await fire(lab)
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    expect(occurrence.execution.kind).toBe('team')
    const page = await lab.call('team.messages.list', { teamId: team.team.id, limit: 10 })
    const request = page.messages.find((message: any) => message.runId === occurrence.execution.runId)
    // It is recorded as what it is; nobody is told a person typed this.
    expect(request.author).toEqual({ kind: 'system' })
    expect(request.provenance).toMatchObject({
      kind: 'routine',
      routineId: routine.id,
      name: 'Relatório semanal',
      scheduledForLocal: '2026-09-14 09:00',
    })
    expect(request.content).toBe('Prepare o relatório semanal')
  })

  it('waits instead of starting a second run while the team is busy', async () => {
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
    await lab.call('team.messages.send', {
      teamId: team.team.id,
      clientMessageId: randomUUID(),
      content: 'pedido da pessoa',
    })
    const { routine } = await activate(lab, {
      name: 'Relatório semanal',
      request: 'Prepare o relatório semanal',
      target: { kind: 'team', id: team.team.id },
      schedule: { kind: 'daily', hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' },
    } as never)
    await fire(lab)
    expect((await lab.call('routine.inspect', { routineId: routine.id })).active).toMatchObject({
      status: 'waiting_resource',
      causeCode: 'TARGET_BUSY',
    })
    // The person's own run was not disturbed.
    const page = await lab.call('team.messages.list', { teamId: team.team.id, limit: 10 })
    expect(page.messages.filter((message: any) => message.author.kind === 'human').length).toBe(1)
    expect(page.messages.filter((message: any) => message.author.kind === 'system').length).toBe(0)
  })
})
