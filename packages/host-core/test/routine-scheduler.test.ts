import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ROUTINE_LIMITS } from '@maestrly/host-protocol'
import { activate, labBot, occurrences, routineLab, weeklySpec, type RoutineLab } from './routine-helpers.js'

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

describe.skipIf(process.platform === 'win32')('materialising what the calendar owes', () => {
  it('turns one nominal instant into exactly one occurrence, whatever the tick does', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.clock.set('2026-09-14T12:00:02.000Z')
    // Three ticks at the same instant, as a busy Host would really do.
    await lab.tick()
    await lab.tick()
    await lab.tick()
    const history = await occurrences(lab, routine.id)
    expect(history.length).toBe(1)
    expect(history[0].scheduledForUtc).toBe('2026-09-14T12:00:00.000Z')
    expect((await lab.call('routine.inspect', { routineId: routine.id })).routine.nextDueUtc).toBe('2026-09-15T12:00:00.000Z')
  })

  it('does nothing at all before the moment arrives', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.clock.set('2026-09-14T11:59:30.000Z')
    await lab.tick()
    expect(await occurrences(lab, routine.id)).toEqual([])
    expect((await lab.call('bot.inspect', { botId: bot.id })).activeTurnId).toBeUndefined()
  })

  it('skips everything it missed by default, without a backlog of work', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    // The Host was off for a thousand days.
    lab.clock.set('2029-06-10T15:00:00.000Z')
    await lab.tick()
    const history = await occurrences(lab, routine.id)
    // Not one occurrence became work, and nothing is pending.
    expect(history.filter((occurrence) => occurrence.status !== 'skipped')).toEqual([])
    expect((await lab.call('routine.inspect', { routineId: routine.id })).active).toBeNull()
    const events = (await lab.call('routine.events.list', { routineId: routine.id, limit: 50 })).events
    expect(events.some((event: any) => event.causeCode === 'MISSED_WINDOW')).toBe(true)
  })

  it('recovers at most the last missed firing when the person asked for that', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id, { misfirePolicy: 'latest' }))
    lab.clock.set('2026-09-20T13:00:00.000Z')
    await lab.tick()
    const history = await occurrences(lab, routine.id)
    const executable = history.filter((occurrence) => occurrence.status !== 'skipped')
    expect(executable.length).toBe(1)
    // The most recent one, not the oldest, and not all six.
    expect(executable[0].scheduledForUtc).toBe('2026-09-20T12:00:00.000Z')
  })

  it('never fires twice for the same instant when the clock goes backwards', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const first = await occurrences(lab, routine.id)
    expect(first.length).toBe(1)
    // Machine clock corrected backwards by an hour, then forward again.
    lab.clock.set('2026-09-14T11:00:05.000Z')
    await lab.tick()
    lab.clock.set('2026-09-14T12:30:00.000Z')
    await lab.tick()
    expect((await occurrences(lab, routine.id)).length).toBe(1)
  })

  it('registers a skipped firing instead of overlapping its own previous execution', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const running = await lab.call('routine.inspect', { routineId: routine.id })
    expect(running.active?.status).toBe('running')
    // The next day arrives while yesterday's execution is still going.
    lab.clock.set('2026-09-15T12:00:05.000Z')
    await lab.tick()
    const events = (await lab.call('routine.events.list', { routineId: routine.id, limit: 50 })).events
    expect(events.some((event: any) => event.causeCode === 'OVERLAP')).toBe(true)
    // Still exactly one occurrence holding the slot.
    expect((await occurrences(lab, routine.id)).filter((occurrence) => occurrence.status === 'running').length).toBe(1)
  })
})

describe.skipIf(process.platform === 'win32')('waiting is not failing', () => {
  it('queues behind a bot the person is already using and never interrupts it', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    const human = await lab.call('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: 'faça isto primeiro' })
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const waiting = await lab.call('routine.inspect', { routineId: routine.id })
    expect(waiting.active).toMatchObject({ status: 'waiting_resource', causeCode: 'TARGET_BUSY' })
    // The person's own task was not touched.
    expect((await lab.call('bot.turn.get', { turnId: human.turn.id })).status).not.toBe('cancelled')

    lab.guest(bot.id).finish(human.turn.id, 'succeeded', 'feito')
    await new Promise((resolve) => setTimeout(resolve, 40))
    lab.clock.advance(60_000)
    await lab.tick()
    expect((await lab.call('routine.inspect', { routineId: routine.id })).active?.status).toBe('running')
  })

  it('gives up waiting at its own deadline, without ever having started work', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id, { queueDeadlineMs: 300_000 }))
    await lab.call('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: 'ocupado' })
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    lab.clock.advance(400_000)
    await lab.tick()
    const history = await occurrences(lab, routine.id)
    expect(history[0]).toMatchObject({ status: 'skipped', causeCode: 'QUEUE_DEADLINE' })
    // A firing that never reached a bot consumed nothing.
    expect(history[0].usedActiveMs).toBe(0)
    expect(history[0].usedActions).toBe(0)
  })

  it('waits for a computer that is switched off instead of turning it on', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.provider.states.set(bot.vmId, 'stopped')
    const vm = await lab.call('vm.inspect', { vmId: bot.vmId })
    expect(vm.state).toBe('stopped')
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    expect((await lab.call('routine.inspect', { routineId: routine.id })).active).toMatchObject({ status: 'waiting_resource', causeCode: 'COMPUTER_OFF' })
    // The Host did not start the VM to satisfy a schedule.
    expect(lab.provider.calls.filter((call) => call === 'start').length).toBe(1)
  })

  it('pauses the routine and asks for a review when the approved target changed', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    const current = await lab.call('bot.inspect', { botId: bot.id })
    await lab.call('bot.update', { botId: bot.id, expectedRevision: current.revision, permissionMode: 'full-vm', confirmFullVm: true })
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const inspected = await lab.call('routine.inspect', { routineId: routine.id })
    expect(inspected.routine.status).toBe('paused')
    expect((await occurrences(lab, routine.id))[0]).toMatchObject({ status: 'skipped', causeCode: 'TARGET_CHANGED' })
    // The widened permission was never used by the scheduled firing.
    expect((await lab.call('bot.inspect', { botId: bot.id })).activeTurnId).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('history retention', () => {
  it('keeps the person\'s history and drops only what is older than the window', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    const repo = lab.routines.repo
    const old = new Date(lab.clock.now() - (ROUTINE_LIMITS.historyDays + 5) * 24 * 60 * 60_000).toISOString()
    const recent = new Date(lab.clock.now() - 2 * 60 * 60_000).toISOString()
    for (const [id, at] of [
      ['old', old],
      ['recent', recent],
    ] as const)
      repo.saveOccurrence({
        id: `occ-${id}`,
        routineId: routine.id,
        target: { kind: 'bot', id: bot.id },
        origin: 'schedule',
        scheduledForUtc: at,
        scheduledForLocal: '2026-01-01 09:00',
        timeZone: 'America/Sao_Paulo',
        deadlineAt: at,
        status: 'succeeded',
        usedActiveMs: 0,
        usedActions: 0,
        createdAt: at,
        updatedAt: at,
        revision: 0,
      })
    repo.transaction(() => repo.pruneHistory(new Date(lab.clock.now() - ROUTINE_LIMITS.historyDays * 24 * 60 * 60_000).toISOString()))
    const ids = (await occurrences(lab, routine.id)).map((occurrence) => occurrence.id)
    expect(ids).toContain('occ-recent')
    expect(ids).not.toContain('occ-old')
    // Compaction never rewinds the cursor, so an old instant cannot look due again.
    const after = await lab.call('routine.inspect', { routineId: routine.id })
    expect(Date.parse(after.routine.watermarkUtc)).toBeGreaterThanOrEqual(Date.parse(routine.watermarkUtc))
  })
})
