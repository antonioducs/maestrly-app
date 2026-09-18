import { randomUUID } from 'node:crypto'
import { EXTENSIONS_CAPABILITY, TRANSCRIPT_CAPABILITY, ROUTINE_CAPABILITY, TEAM_CAPABILITY, type RoutineOccurrence, type RoutinePreview, type RoutineSpec } from '@maestrly/host-protocol'
import { HostService } from '../src/index.js'
import type { Clock } from '../src/routines/calendar.js'
import { FakeConnector, FakeProvider, directory, readyBot, runtime, sha, until, type FakeGuest } from './bot-helpers.js'
import type { BotTemplate } from '../src/bots/recommendations.js'
import { writeFile } from 'node:fs/promises'

/**
 * A routine lab: the real Host, the real turn engine, a fake guest and a clock the test owns.
 * Time is injected rather than slept through — a scheduler suite that waits for wall-clock
 * minutes teaches nothing and fails on a loaded machine.
 */
export class TestClock implements Clock {
  constructor(private current = Date.parse('2026-09-14T11:00:00.000Z')) {}
  now() {
    return this.current
  }
  set(iso: string) {
    this.current = Date.parse(iso)
  }
  advance(ms: number) {
    this.current += ms
  }
}

export const routineTemplate: BotTemplate = {
  id: 'bot-ready',
  imageId: 'image',
  runtimeId: 'qemu',
  arch: 'arm64',
  runtimeIncluded: true,
  runtimeBundle: { path: '/missing/bundle.tar', sha256: 'd'.repeat(64), version: '0.2.0' },
  // Same modest shape the team lab uses: enough for graphical sessions, small enough that the
  // suite does not require tens of free GiB on whatever machine runs it.
  minimum: { cpus: 4, memoryMiB: 2560, diskGiB: 4 },
  recommended: { cpus: 4, memoryMiB: 2560, diskGiB: 4 },
  capabilities: ['account.delegation.v1', 'provider.codex', TEAM_CAPABILITY, ROUTINE_CAPABILITY, EXTENSIONS_CAPABILITY, TRANSCRIPT_CAPABILITY],
}

export async function routineLab(options: { clock?: TestClock; dir?: string; asr?: import('../src/voice/worker-client.js').AsrOptions } = {}) {
  const clock = options.clock ?? new TestClock()
  // Reusing a directory is how a restart is simulated: same catalogue, new process.
  const dir = options.dir ?? (await directory())
  const asset = `${dir}/image`
  await writeFile(asset, 'image')
  const connector = new FakeConnector()
  connector.managed = true
  const provider = new FakeProvider()
  const service = new HostService({
    stateDirectory: dir,
    runtimes: [runtime],
    provider,
    images: [{ id: 'image', name: 'Bot image', arch: 'arm64', asset: { path: asset, sha256: sha(Buffer.from('image')) }, format: 'raw', virtualSizeGiB: 2, guestAgent: true }],
    capacity: { cpus: 8, memoryMiB: 8192, diskGiB: 9 },
    connector,
    templates: [routineTemplate],
    // A very long tick: every suite drives time explicitly instead of racing a timer.
    routines: { clock, tickMs: 3_600_000 },
    ...(options.asr ? { asr: options.asr } : {}),
  })
  const call = async (method: string, params: unknown = {}) => {
    const response = await service.dispatch({ version: 1, id: randomUUID(), method, params })
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code })
    return response.result as any
  }
  const placement = new Map<string, { vmId: string; sessionId: string }>()
  const lab = {
    service,
    connector,
    provider,
    dir,
    call,
    clock,
    placement,
    get routines() {
      return service.domains.routines
    },
    get voice() {
      return service.domains.voice
    },
    guest(botId: string): FakeGuest {
      const at = placement.get(botId)
      if (!at) throw new Error(`bot ${botId} is not registered in this lab`)
      const guest = connector.guest(at.vmId, at.sessionId)
      guest.capabilities = ['account.delegation.v1', 'provider.codex', 'tools.files', TEAM_CAPABILITY, ROUTINE_CAPABILITY, EXTENSIONS_CAPABILITY, TRANSCRIPT_CAPABILITY]
      return guest
    },
    /** Runs one scheduler pass at the clock's current instant. */
    async tick() {
      await service.domains.routines.scheduler.tick(clock.now())
    },
    async close() {
      await service.close()
    },
  }
  return lab
}
export type RoutineLab = Awaited<ReturnType<typeof routineLab>>

export async function labBot(lab: RoutineLab, name = 'Assistente') {
  const bot = await readyBot({ service: lab.service, connector: lab.connector, call: lab.call } as never, name)
  const session = await lab.call('bot.session.inspect', { botId: bot.id })
  lab.placement.set(bot.id, { vmId: bot.vmId, sessionId: session.id })
  lab.guest(bot.id)
  return bot
}

export const weeklySpec = (botId: string, overrides: Partial<RoutineSpec> = {}): RoutineSpec =>
  ({
    name: 'Resumo de segunda',
    request: 'Prepare o resumo semanal',
    target: { kind: 'bot', id: botId },
    schedule: { kind: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' },
    ...overrides,
  }) as RoutineSpec

/** Preview then activate, exactly as the application does; there is no shortcut. */
export async function activate(lab: RoutineLab, spec: RoutineSpec, extra: Record<string, unknown> = {}) {
  const preview: RoutinePreview = await lab.call('routine.preview', { spec, ...extra })
  const details = await lab.call('routine.activate', {
    previewId: preview.previewId,
    fingerprint: preview.fingerprint,
    idempotencyKey: randomUUID(),
    confirmSchedule: true,
  })
  return { preview, routine: details.routine, details }
}

export async function occurrences(lab: RoutineLab, routineId: string): Promise<RoutineOccurrence[]> {
  return (await lab.call('routine.occurrences.list', { routineId, limit: 50 })).occurrences
}
export const activeOccurrence = async (lab: RoutineLab, routineId: string) => (await lab.call('routine.inspect', { routineId })).active

/** Answers a scheduled turn the way the guest runtime does. */
export function finishTurn(lab: RoutineLab, botId: string, turnId: string, content = 'pronto', status: 'succeeded' | 'failed' = 'succeeded') {
  const guest = lab.guest(botId)
  if (status === 'succeeded') guest.finish(turnId, 'succeeded', content)
  else {
    guest.turns.get(turnId)!.status = 'failed'
    guest.emit({ turnId, generation: 1, kind: 'turn.status', summary: 'failed', detail: { status: 'failed', error: { code: 'TOOL_FAILED', message: 'não deu' } } })
  }
}
export { until }
