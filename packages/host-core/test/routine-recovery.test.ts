import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { activate, labBot, occurrences, routineLab, until, weeklySpec, type RoutineLab } from './routine-helpers.js'

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
  weeklySpec(botId, { schedule: { kind: 'daily', hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' }, ...extra } as never)

/**
 * Crash points. Each test kills the Host at a specific moment and asks the only question that
 * matters afterwards: did anything happen twice, and does the person still see the truth?
 */
describe.skipIf(process.platform === 'win32')('a Host that stops at the worst moment', () => {
  it('after activation and before the firing: the calendar survives two restarts and fires once', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    await lab.service.close()

    // Same state directory, new process — twice, because the second restart is where a
    // migration or a recovery that is not idempotent usually shows up.
    for (let restart = 0; restart < 2; restart++) {
      const reopened = await routineLab({ clock: lab.clock, dir: lab.dir })
      labs.push(reopened)
      await reopened.service.ready()
      const inspected = await reopened.call('routine.inspect', { routineId: routine.id })
      expect(inspected.routine.status).toBe('active')
      expect(inspected.routine.nextDueUtc).toBe('2026-09-14T12:00:00.000Z')
      expect(inspected.recent).toEqual([])
      await reopened.close()
      labs.pop()
    }

    // Now let the firing happen on a freshly started Host: exactly one occurrence.
    const final = await routineLab({ clock: lab.clock, dir: lab.dir })
    labs.push(final)
    await final.service.ready()
    final.clock.set('2026-09-14T12:00:05.000Z')
    await final.tick()
    await final.tick()
    expect((await occurrences(final, routine.id)).length).toBe(1)
  })

  it('after materialising and before admitting: the same occurrence is admitted, never a second one', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    // A busy bot leaves the occurrence materialised but never dispatched.
    const human = await lab.call('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: 'ocupado' })
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const pending = (await lab.call('routine.inspect', { routineId: routine.id })).active
    expect(pending.status).toBe('waiting_resource')

    // The Host restarts here.
    lab.routines.adapter.recover()
    lab.guest(bot.id).finish(human.turn.id, 'succeeded', 'feito')
    await new Promise((resolve) => setTimeout(resolve, 40))
    lab.clock.advance(30_000)
    await lab.tick()
    await lab.tick()
    const history = await occurrences(lab, routine.id)
    expect(history.length).toBe(1)
    expect(history[0].id).toBe(pending.id)
    expect(lab.routines.repo.executionsOf(pending.id).length).toBe(1)
  })

  it('after admitting and before the answer: the result is reconciled, not re-run', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    const turnId = occurrence.execution.turnId

    // The guest finished while the Host was not listening.
    const guest = lab.guest(bot.id)
    guest.turns.get(turnId)!.status = 'succeeded'
    // Recovery applies the terminal state it finds; it never sends turn.start again.
    const before = guest.requests.filter((request) => request.method === 'turn.start').length
    lab.routines.adapter.recover()
    await lab.tick()
    expect(guest.requests.filter((request) => request.method === 'turn.start').length).toBe(before)
    expect((await occurrences(lab, routine.id)).length).toBe(1)
  })

  it('an uncertain execution keeps its conservative reservation instead of looking free', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    // Still running, outcome unknown: the whole ceiling is held.
    expect(occurrence.usedActiveMs).toBe(30 * 60_000)
    expect(occurrence.usedActions).toBe(80)
    const used = lab.routines.authority.window(routine.id, lab.clock.now())
    expect(used).toMatchObject({ admissions: 1, activeMs: 30 * 60_000, actions: 80 })
  })

  it('does not mark a firing as done when the turn never reached the computer', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    lab.guest(bot.id).drop()
    lab.routines.adapter.recover()
    const still = await lab.call('routine.occurrence.inspect', { occurrenceId: occurrence.id })
    expect(['running', 'needs_attention', 'waiting_user']).toContain(still.status)
    expect(still.summary).toBeUndefined()
    expect(still.finishedAt).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('a person takes the screen during a scheduled run', () => {
  it('puts the occurrence on hold instead of declaring it finished', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    const turnId = occurrence.execution.turnId

    // Exactly what the desktop handoff does when a person takes over.
    lab.service.domains.bots.coordinator.markTakeover(turnId)
    lab.service.domains.bots.coordinator.interruptForHandoff(turnId)
    const held = await until(
      () => lab.call('routine.occurrence.inspect', { occurrenceId: occurrence.id }),
      (value: any) => value.status === 'waiting_user'
    )
    expect(held.causeCode).toBe('HUMAN_TAKEOVER')
    expect(held.finishedAt).toBeUndefined()
  })

  it('ends the occurrence explicitly when the person gives the screen back without continuing', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    const turnId = occurrence.execution.turnId
    lab.service.domains.bots.coordinator.markTakeover(turnId)
    lab.service.domains.bots.coordinator.interruptForHandoff(turnId)
    lab.routines.adapter.handoffReturned({ interruptedTurnId: turnId })
    const ended = await lab.call('routine.occurrence.inspect', { occurrenceId: occurrence.id })
    expect(ended).toMatchObject({ status: 'failed', causeCode: 'HUMAN_TAKEOVER' })
    expect(ended.attention).toContain('devolveu o controle')
    // No replacement firing was invented to make the schedule look kept.
    expect((await occurrences(lab, routine.id)).length).toBe(1)
  })

  it('a continuation stays the same occurrence, on the same budget', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    const turnId = occurrence.execution.turnId
    const ceiling = lab.routines.adapter.budgetCeiling(turnId)
    expect(ceiling).toEqual({ activeMs: 30 * 60_000, maxTools: 80 })

    lab.service.domains.bots.coordinator.markTakeover(turnId)
    lab.service.domains.bots.coordinator.interruptForHandoff(turnId)
    const continuation = lab.service.domains.bots.turns.createContinuation({
      botId: bot.id,
      interruptedTurnId: turnId,
      operationId: 'handoff-1',
      capture: { path: 'captures/x.png', name: 'x.png', size: 10, digest: 'a'.repeat(64) },
      limits: { activeMs: 10 * 60_000, maxTools: 20, maxLogBytes: 1024 },
    })
    // Same scoped thread, same occurrence, and the continuation is bound to the original parcel.
    expect(continuation.conversationId).toBe(occurrence.execution.conversationId)
    expect(lab.routines.repo.executionsOf(occurrence.id).length).toBe(2)
    expect((await occurrences(lab, routine.id)).length).toBe(1)
    expect(lab.routines.adapter.budgetCeiling(continuation.turnId)).toEqual({ activeMs: 30 * 60_000, maxTools: 80 })
  })
})
