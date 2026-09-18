import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ROUTINE_LIMITS, routineCeilingSchema } from '@maestrly/host-protocol'
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
  weeklySpec(botId, { schedule: { kind: 'daily', hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' }, ...extra } as never)
const ceiling = (values: Partial<{ activeMs: number; maxTools: number; permissionMode: 'ask' | 'full-vm' }>) => routineCeilingSchema.parse(values)

describe.skipIf(process.platform === 'win32')('an approval fixes a ceiling and never raises one', () => {
  it('intersects both sides: ask wins, and every number goes down', async () => {
    const lab = await open()
    const authority = lab.routines.authority
    expect(authority.effectiveCeiling(ceiling({ permissionMode: 'full-vm' }), ceiling({ permissionMode: 'ask' })).permissionMode).toBe('ask')
    expect(authority.effectiveCeiling(ceiling({ permissionMode: 'ask' }), ceiling({ permissionMode: 'full-vm' })).permissionMode).toBe('ask')
    expect(authority.effectiveCeiling(ceiling({ permissionMode: 'full-vm' }), ceiling({ permissionMode: 'full-vm' })).permissionMode).toBe('full-vm')
    const narrowed = authority.effectiveCeiling(ceiling({ activeMs: 60 * 60_000, maxTools: 500 }), ceiling({ activeMs: 10 * 60_000, maxTools: 20 }))
    expect(narrowed).toMatchObject({ activeMs: 10 * 60_000, maxTools: 20 })
  })

  it('carries the effective ceiling into the snapshot the guest actually receives', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id, { ceiling: { activeMs: 10 * 60_000, maxTools: 15, permissionMode: 'full-vm' } }))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    const snapshot = lab.guest(bot.id).turns.get(occurrence.execution.turnId)!.snapshot
    // The bot itself is in "ask": the routine cannot be granted more, in the real wire payload.
    expect(snapshot.permissionMode).toBe('ask')
    expect(snapshot.limits).toMatchObject({ activeMs: 10 * 60_000, maxTools: 15 })
  })
})

describe.skipIf(process.platform === 'win32')('identity a person consented to', () => {
  it('changes with the account, the model, the permission mode and the network mode', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const authority = lab.routines.authority
    const target = { kind: 'bot' as const, id: bot.id }
    const before = authority.describe(target).version

    const current = await lab.call('bot.inspect', { botId: bot.id })
    await lab.call('bot.update', { botId: bot.id, expectedRevision: current.revision, permissionMode: 'full-vm', confirmFullVm: true })
    const afterPermission = authority.describe(target).version
    expect(afterPermission).not.toBe(before)

    const policy = await lab.call('bot.network.inspect', { botId: bot.id })
    await lab.call('bot.network.update', { botId: bot.id, expectedRevision: policy.policy.revision, idempotencyKey: randomUUID(), mode: 'allowlist', domains: ['api.openai.com'] })
    expect(authority.describe(target).version).not.toBe(afterPermission)
  })

  it('does not change for a rename, a new message or an active task', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const authority = lab.routines.authority
    const target = { kind: 'bot' as const, id: bot.id }
    const before = authority.describe(target).version

    const current = await lab.call('bot.inspect', { botId: bot.id })
    await lab.call('bot.update', { botId: bot.id, expectedRevision: current.revision, name: 'Outro nome', purpose: 'Outro objetivo' })
    expect(authority.describe(target).version).toBe(before)

    // A bot in the middle of a task is the same bot; a routine must not need re-approval.
    await lab.call('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: 'trabalhe' })
    expect(authority.describe(target).version).toBe(before)
  })

  it('narrowing the allowed destinations takes effect immediately, without a new review', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const authority = lab.routines.authority
    const target = { kind: 'bot' as const, id: bot.id }
    const policy = await lab.call('bot.network.inspect', { botId: bot.id })
    await lab.call('bot.network.update', { botId: bot.id, expectedRevision: policy.policy.revision, idempotencyKey: randomUUID(), mode: 'allowlist', domains: ['a.example.com', 'b.example.com'] })
    const wide = authority.describe(target).version
    const narrowed = await lab.call('bot.network.inspect', { botId: bot.id })
    await lab.call('bot.network.update', { botId: bot.id, expectedRevision: narrowed.policy.revision, idempotencyKey: randomUUID(), mode: 'allowlist', domains: ['a.example.com'] })
    // Removing a destination is a reduction: it applies at once and does not pause the routine.
    expect(authority.describe(target).version).toBe(wide)
  })

  it('changes when a team roster or coordinator changes', async () => {
    const lab = await open()
    const first = await labBot(lab, 'Coordenadora')
    const second = await labBot(lab, 'Analista')
    const team = await lab.call('team.create', {
      idempotencyKey: randomUUID(),
      name: 'Relatórios',
      objective: '',
      confirmSharing: true,
      members: [
        { botId: first.id, role: '', coordinator: true },
        { botId: second.id, role: '', coordinator: false },
      ],
    })
    const authority = lab.routines.authority
    const target = { kind: 'team' as const, id: team.team.id }
    const before = authority.describe(target).version
    // Who coordinates the work is part of what the person approved.
    await lab.call('team.update', { teamId: team.team.id, expectedRevision: team.team.revision, coordinatorBotId: second.id })
    const afterCoordinator = authority.describe(target).version
    expect(afterCoordinator).not.toBe(before)

    // So is the roster itself: re-consenting bumps the grant revision of every member.
    const current = await lab.call('team.inspect', { teamId: team.team.id })
    await lab.call('team.members.set', {
      teamId: team.team.id,
      expectedRevision: current.team.revision,
      idempotencyKey: randomUUID(),
      confirmSharing: true,
      members: [
        { botId: first.id, role: 'novo papel', coordinator: true },
        { botId: second.id, role: '', coordinator: false },
      ],
    })
    expect(authority.describe(target).version).not.toBe(afterCoordinator)
  })
})

describe.skipIf(process.platform === 'win32')('the aggregate allowance of a routine', () => {
  it('counts a running firing at its full reservation and a finished one at what it used', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const authority = lab.routines.authority
    expect(authority.window(routine.id, lab.clock.now())).toMatchObject({ admissions: 1, activeMs: 30 * 60_000, actions: 80 })
    const occurrence = (await lab.call('routine.inspect', { routineId: routine.id })).active
    lab.guest(bot.id).finish(occurrence.execution.turnId, 'succeeded', 'pronto')
    await until(() => lab.call('routine.occurrence.inspect', { occurrenceId: occurrence.id }), (value: any) => value.status === 'succeeded')
    expect(authority.window(routine.id, lab.clock.now()).activeMs).toBeLessThan(30 * 60_000)
  })

  it('forgets consumption older than twenty-four hours', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id))
    const repo = lab.routines.repo
    const old = new Date(lab.clock.now() - 26 * 60 * 60_000).toISOString()
    repo.saveOccurrence({
      id: randomUUID(),
      routineId: routine.id,
      target: { kind: 'bot', id: bot.id },
      origin: 'schedule',
      scheduledForUtc: old,
      scheduledForLocal: '2026-09-13 09:00',
      timeZone: 'America/Sao_Paulo',
      deadlineAt: old,
      status: 'succeeded',
      usedActiveMs: ROUTINE_LIMITS.activeMsPer24h,
      usedActions: ROUTINE_LIMITS.actionsPer24h,
      createdAt: old,
      updatedAt: old,
      revision: 0,
    })
    expect(lab.routines.authority.window(routine.id, lab.clock.now())).toMatchObject({ admissions: 0, activeMs: 0, actions: 0 })
  })

  it('never counts a firing that was skipped before reaching a bot', async () => {
    const lab = await open()
    const bot = await labBot(lab)
    const { routine } = await activate(lab, daily(bot.id, { queueDeadlineMs: 60_000 }))
    await lab.call('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: 'ocupado' })
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    lab.clock.advance(120_000)
    await lab.tick()
    expect(lab.routines.authority.window(routine.id, lab.clock.now())).toMatchObject({ admissions: 0, activeMs: 0, actions: 0 })
  })
})

describe.skipIf(process.platform === 'win32')('shared files a routine was approved to use', () => {
  it('blocks the next firing when a chosen file was revoked', async () => {
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
    // Share a file the person picked for the routine.
    const content = Buffer.from('dados base')
    const begin = await lab.call('team.artifacts.transferBegin', { teamId: team.team.id, direction: 'upload', name: 'base.csv', size: content.length })
    await lab.call('team.artifacts.transferChunk', { transferId: begin.transferId, offset: 0, dataBase64: content.toString('base64') })
    const finished = await lab.call('team.artifacts.transferFinish', { transferId: begin.transferId })
    const artifactId = finished.artifact.id

    const { routine } = await activate(lab, {
      name: 'Relatório com base',
      request: 'Atualize o relatório com a base',
      target: { kind: 'team', id: team.team.id },
      schedule: { kind: 'daily', hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' },
      resourceIds: [artifactId],
    } as never)
    expect(lab.routines.authority.resourceState(lab.routines.repo.routine(routine.id)).ready).toBe(true)

    await lab.call('team.artifacts.revoke', { teamId: team.team.id, artifactId, idempotencyKey: randomUUID() })
    lab.clock.set('2026-09-14T12:00:05.000Z')
    await lab.tick()
    const history = (await lab.call('routine.occurrences.list', { routineId: routine.id, limit: 10 })).occurrences
    expect(history[0]).toMatchObject({ status: 'skipped', causeCode: 'ACCESS_REVOKED' })
  })
})
