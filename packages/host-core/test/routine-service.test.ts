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

describe.skipIf(process.platform === 'win32')('a routine only exists after a person confirms one', () => {
  it('previews real instants in the person\'s zone without creating anything', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    // Monday 14/09/2026, 11:00Z = 08:00 in São Paulo.
    const preview = await lab.call('routine.preview', { spec: weeklySpec(bot.id) })
    expect(preview.occurrences.map((o: any) => o.scheduledForUtc)).toEqual([
      '2026-09-14T12:00:00.000Z',
      '2026-09-21T12:00:00.000Z',
      '2026-09-28T12:00:00.000Z',
    ])
    expect(preview.occurrences[0].scheduledForLocal).toBe('2026-09-14 09:00')
    expect(preview.feasible).toBe(true)
    // Nothing exists yet: no routine, no occurrence, no turn.
    expect(await lab.call('routine.list')).toEqual([])
    expect((await lab.call('bot.inspect', { botId: bot.id })).activeTurnId).toBeUndefined()
  })

  it('refuses to activate without the exact preview that was shown', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const preview = await lab.call('routine.preview', { spec: weeklySpec(bot.id) })
    await expect(
      lab.call('routine.activate', { previewId: preview.previewId, fingerprint: 'f'.repeat(64), idempotencyKey: randomUUID(), confirmSchedule: true })
    ).rejects.toMatchObject({ code: 'ROUTINE_PREVIEW_MISMATCH' })
    await expect(
      lab.call('routine.activate', { previewId: randomUUID(), fingerprint: preview.fingerprint, idempotencyKey: randomUUID(), confirmSchedule: true })
    ).rejects.toMatchObject({ code: 'ROUTINE_PREVIEW_EXPIRED' })
    expect(await lab.call('routine.list')).toEqual([])
  })

  it('refuses a preview that expired while the person was deciding', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const preview = await lab.call('routine.preview', { spec: weeklySpec(bot.id) })
    lab.clock.advance(ROUTINE_LIMITS.previewTtlMs + 1_000)
    await expect(
      lab.call('routine.activate', { previewId: preview.previewId, fingerprint: preview.fingerprint, idempotencyKey: randomUUID(), confirmSchedule: true })
    ).rejects.toMatchObject({ code: 'ROUTINE_PREVIEW_EXPIRED' })
  })

  it('activates once however many times the person double-clicks', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const preview = await lab.call('routine.preview', { spec: weeklySpec(bot.id) })
    const key = randomUUID()
    const first = await lab.call('routine.activate', { previewId: preview.previewId, fingerprint: preview.fingerprint, idempotencyKey: key, confirmSchedule: true })
    const second = await lab.call('routine.activate', { previewId: preview.previewId, fingerprint: preview.fingerprint, idempotencyKey: key, confirmSchedule: true })
    expect(second.routine.id).toBe(first.routine.id)
    expect((await lab.call('routine.list')).length).toBe(1)
    expect(first.routine.nextDueUtc).toBe('2026-09-14T12:00:00.000Z')
    expect(first.routine.status).toBe('active')
  })

  it('refuses a routine whose approved identity changed between review and confirmation', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const preview = await lab.call('routine.preview', { spec: weeklySpec(bot.id) })
    // The person changed the bot's permissions in another window.
    const current = await lab.call('bot.inspect', { botId: bot.id })
    await lab.call('bot.update', { botId: bot.id, expectedRevision: current.revision, permissionMode: 'full-vm', confirmFullVm: true })
    await expect(
      lab.call('routine.activate', { previewId: preview.previewId, fingerprint: preview.fingerprint, idempotencyKey: randomUUID(), confirmSchedule: true })
    ).rejects.toMatchObject({ code: 'ROUTINE_PREVIEW_MISMATCH' })
  })

  it('narrows the ceiling to what the target may already do, and says so', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const preview = await lab.call('routine.preview', {
      spec: weeklySpec(bot.id, { ceiling: { activeMs: 4 * 60 * 60_000, maxTools: 600, permissionMode: 'full-vm' } } as never),
    })
    // The bot itself runs in "ask" mode, so the routine cannot be granted more.
    expect(preview.effectiveCeiling.permissionMode).toBe('ask')
    expect(preview.warnings.map((warning: any) => warning.code)).toContain('PERMISSION_NARROWED')
  })

  it('warns instead of silently scheduling a moment that already passed', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const preview = await lab.call('routine.preview', {
      spec: weeklySpec(bot.id, { schedule: { kind: 'once', atUtc: '2020-01-01T10:00:00.000Z', timeZone: 'America/Sao_Paulo' } } as never),
    })
    expect(preview.feasible).toBe(false)
    expect(preview.warnings.map((warning: any) => warning.code)).toContain('PAST_INSTANT')
    await expect(
      lab.call('routine.activate', { previewId: preview.previewId, fingerprint: preview.fingerprint, idempotencyKey: randomUUID(), confirmSchedule: true })
    ).rejects.toMatchObject({ code: 'ROUTINE_SCHEDULE_INVALID' })
  })

  it('lets the person pick which of two identical readings they meant', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const ambiguous = weeklySpec(bot.id, {
      schedule: { kind: 'once', atUtc: '2026-11-01T05:30:00.000Z', timeZone: 'America/New_York' },
    } as never)
    const shown = await lab.call('routine.preview', { spec: ambiguous })
    expect(shown.warnings.map((warning: any) => warning.code)).toContain('AMBIGUOUS_INSTANT')
    const later = await lab.call('routine.preview', { spec: ambiguous, disambiguation: 'later' })
    expect(later.spec.schedule.atUtc).toBe('2026-11-01T06:30:00.000Z')
    expect(later.fingerprint).not.toBe(shown.fingerprint)
  })
})

describe.skipIf(process.platform === 'win32')('editing, pausing and archiving', () => {
  it('editing goes through a new preview and invalidates the pending firing of the old version', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, weeklySpec(bot.id))
    // Reach the first firing but do not let it start: the bot is busy with a person's task.
    await lab.call('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: 'trabalhe nisto' })
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const pending = await lab.call('routine.inspect', { routineId: routine.id })
    expect(pending.active?.status).toBe('waiting_resource')

    const edited = await activate(lab, weeklySpec(bot.id, { name: 'Resumo novo', request: 'Outro pedido' }), {
      routineId: routine.id,
      expectedRevision: pending.routine.revision,
    })
    expect(edited.routine.id).toBe(routine.id)
    expect(edited.routine.spec.name).toBe('Resumo novo')
    const history = await occurrences(lab, routine.id)
    expect(history[0]).toMatchObject({ status: 'skipped', causeCode: 'ROUTINE_EDITED' })
  })

  it('refuses an edit made against a revision the person no longer has', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, weeklySpec(bot.id))
    await expect(lab.call('routine.preview', { spec: weeklySpec(bot.id), routineId: routine.id, expectedRevision: routine.revision + 5 })).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    })
  })

  it('pausing stops future firings and resuming never catches up on the pause', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, weeklySpec(bot.id, { schedule: { kind: 'daily', hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' } } as never))
    const paused = await lab.call('routine.pause', { routineId: routine.id, expectedRevision: routine.revision, idempotencyKey: randomUUID() })
    expect(paused.routine.status).toBe('paused')
    expect(paused.routine.nextDueUtc).toBeUndefined()

    // Three days pass with the routine paused; none of them may become work.
    lab.clock.set('2026-09-17T12:00:05.000Z')
    await lab.tick()
    expect(await occurrences(lab, routine.id)).toEqual([])

    const resumed = await lab.call('routine.pause', { routineId: routine.id, expectedRevision: paused.routine.revision, idempotencyKey: randomUUID(), resume: true })
    expect(resumed.routine.status).toBe('active')
    // Strictly forward: the next firing is tomorrow, not the three that were missed.
    expect(resumed.routine.nextDueUtc).toBe('2026-09-18T12:00:00.000Z')
  })

  it('archiving preserves the history and refuses while an execution is running', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, weeklySpec(bot.id))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const running = await lab.call('routine.inspect', { routineId: routine.id })
    expect(running.active?.status).toBe('running')
    await expect(lab.call('routine.archive', { routineId: routine.id, expectedRevision: running.routine.revision, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: 'ROUTINE_OCCURRENCE_ACTIVE',
    })
    const turnId = running.active!.execution!.turnId
    lab.guest(bot.id).finish(turnId, 'succeeded', 'resumo pronto')
    await new Promise((resolve) => setTimeout(resolve, 30))
    const settled = await lab.call('routine.inspect', { routineId: routine.id })
    const archived = await lab.call('routine.archive', { routineId: routine.id, expectedRevision: settled.routine.revision, idempotencyKey: randomUUID() })
    expect(archived.routine.status).toBe('archived')
    expect((await occurrences(lab, routine.id))[0].summary).toBe('resumo pronto')
  })

  it('caps how many routines one Host may hold', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const repo = lab.routines.repo
    // Fill the catalogue directly: creating a hundred through the API would prove the same
    // thing a hundred times more slowly.
    const stamp = '2026-09-14T11:00:00.000Z'
    for (let index = 0; index < ROUTINE_LIMITS.routinesPerHostMax; index++)
      repo.saveRoutine({
        id: randomUUID(),
        hostId: lab.service.domains.bots.repo.store.hostId,
        spec: weeklySpec(bot.id, { name: `R${index}` }),
        status: 'active',
        fingerprint: 'a'.repeat(64),
        targetVersion: 'b'.repeat(64),
        targetName: 'Assistente',
        watermarkUtc: stamp,
        createdAt: stamp,
        updatedAt: stamp,
        revision: 0,
      })
    await expect(lab.call('routine.preview', { spec: weeklySpec(bot.id) })).rejects.toMatchObject({ code: 'ROUTINE_LIMIT' })
  })
})

describe.skipIf(process.platform === 'win32')('running one now', () => {
  it('returns the same receipt for a repeated click and never moves the calendar', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, weeklySpec(bot.id))
    const key = randomUUID()
    const first = await lab.call('routine.runNow', { routineId: routine.id, expectedRevision: routine.revision, idempotencyKey: key })
    const second = await lab.call('routine.runNow', { routineId: routine.id, expectedRevision: routine.revision, idempotencyKey: key })
    expect(second.id).toBe(first.id)
    expect(first.origin).toBe('manual')
    expect((await lab.call('routine.inspect', { routineId: routine.id })).routine.nextDueUtc).toBe('2026-09-14T12:00:00.000Z')
  })

  it('refuses when the routine already used its whole allowance for the day', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, weeklySpec(bot.id))
    const repo = lab.routines.repo
    const stamp = new Date(lab.clock.now()).toISOString()
    for (let index = 0; index < ROUTINE_LIMITS.admissionsPer24h; index++)
      repo.saveOccurrence({
        id: randomUUID(),
        routineId: routine.id,
        target: { kind: 'bot', id: bot.id },
        origin: 'manual',
        scheduledForUtc: new Date(lab.clock.now() - index * 60_000).toISOString(),
        scheduledForLocal: '2026-09-14 08:00',
        timeZone: 'America/Sao_Paulo',
        deadlineAt: stamp,
        status: 'succeeded',
        usedActiveMs: 1_000,
        usedActions: 1,
        createdAt: stamp,
        updatedAt: stamp,
        revision: 0,
      })
    await expect(lab.call('routine.runNow', { routineId: routine.id, expectedRevision: routine.revision, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: 'ROUTINE_BUDGET_EXHAUSTED',
    })
  })
})
