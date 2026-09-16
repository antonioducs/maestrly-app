import { randomUUID } from 'node:crypto'
import { TEAM_CAPABILITY } from '@maestrly/host-protocol'
import { FakeConnector, readyBot, setup, until, type FakeGuest } from './bot-helpers.js'
import type { BotTemplate } from '../src/bots/recommendations.js'

/**
 * A team lab on top of the existing bot lab. Resources are deliberately small: these
 * suites exercise Host coordination, not the controller's disk, so they run anywhere.
 */
export const teamTemplate: BotTemplate = {
  id: 'bot-ready',
  imageId: 'image',
  runtimeId: 'qemu',
  arch: 'arm64',
  runtimeIncluded: true,
  runtimeBundle: { path: '/missing/bundle.tar', sha256: 'd'.repeat(64), version: '0.2.0' },
  // Enough for three independent graphical sessions on one computer, and small enough that
  // the suite does not need tens of free GiB on the controller.
  minimum: { cpus: 4, memoryMiB: 2560, diskGiB: 4 },
  recommended: { cpus: 4, memoryMiB: 2560, diskGiB: 4 },
  capabilities: ['account.delegation.v1', 'provider.codex', TEAM_CAPABILITY],
}
const CAPABILITIES = ['account.delegation.v1', 'provider.codex', 'tools.files', TEAM_CAPABILITY]

export async function teamLab(options: { connector?: FakeConnector } = {}) {
  const connector = options.connector ?? new FakeConnector()
  connector.managed = true
  const ctx = await setup({ connector, templates: [teamTemplate], imageVirtualSizeGiB: 2, capacity: { cpus: 8, memoryMiB: 8192, diskGiB: 9 } })
  const placement = new Map<string, { vmId: string; sessionId: string }>()
  const lab = {
    ...ctx,
    connector,
    placement,
    /** The guest of one bot's own graphical session, never another member's. */
    guest(botId: string): FakeGuest {
      const at = placement.get(botId)
      if (!at) throw new Error(`bot ${botId} is not registered in this lab`)
      const guest = connector.guest(at.vmId, at.sessionId)
      guest.capabilities = CAPABILITIES
      return guest
    },
    /** Dispatches with a connection identity, as the application's main process does. */
    async connected(method: string, params: unknown = {}, connectionId = 'app-1') {
      const response = await ctx.service.dispatch({ version: 1, id: randomUUID(), method, params }, { connectionId })
      if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code })
      return response.result as any
    },
  }
  return lab
}
export type TeamLab = Awaited<ReturnType<typeof teamLab>>

/** A ready bot whose guest announces the team capability, as a prepared environment does. */
export async function teamBot(lab: TeamLab, name: string, vmId?: string) {
  const bot = vmId ? await sharedBot(lab, name, vmId) : await readyBot(lab, name)
  const session = await lab.call('bot.session.inspect', { botId: bot.id })
  lab.placement.set(bot.id, { vmId: bot.vmId, sessionId: session.id })
  lab.guest(bot.id)
  return bot
}
async function sharedBot(lab: TeamLab, name: string, vmId: string) {
  const preview = await lab.call('bot.setup.preview', { destination: { kind: 'shared-vm', vmId } })
  const op = await lab.call('bot.setup.start', {
    idempotencyKey: `setup-${name}`,
    previewId: preview.previewId,
    inventoryRevision: preview.inventoryRevision,
    name,
    confirmations: { destination: true, permissions: true },
  })
  const waiting = await until(() => lab.call('bot.setup.inspect', { operationId: op.id }), (o: any) => ['waiting_user', 'failed'].includes(o.status))
  if (waiting.status !== 'waiting_user') throw new Error(`setup failed: ${JSON.stringify(waiting.error)}`)
  const bot = await lab.call('bot.inspect', { botId: op.botId })
  const session = await lab.call('bot.session.inspect', { botId: bot.id })
  lab.connector.guest(bot.vmId, session.id).auth = { state: 'connected', provider: 'codex', method: 'device', account: { email: 'a@b.c', plan: 'plus' } }
  await lab.call('bot.auth.status', { botId: bot.id })
  return until(() => lab.call('bot.inspect', { botId: bot.id }), (b: any) => b.status === 'ready')
}

export async function createTeam(
  lab: TeamLab,
  input: { name: string; members: { botId: string; role?: string; coordinator?: boolean }[]; policy?: Record<string, unknown> }
) {
  return lab.call('team.create', {
    idempotencyKey: `team-${input.name}`,
    name: input.name,
    objective: 'Produzir um relatório curto',
    confirmSharing: true,
    members: input.members.map((member) => ({ botId: member.botId, role: member.role ?? '', coordinator: member.coordinator ?? false })),
    ...(input.policy ? { policy: input.policy } : {}),
  })
}

export const ask = (lab: TeamLab, teamId: string, content: string, artifactIds: string[] = []) =>
  lab.call('team.messages.send', { teamId, clientMessageId: randomUUID(), content, artifactIds })

/** The turn a bot is currently working on inside a run, once the Host dispatched it. */
export async function turnOf(lab: TeamLab, runId: string, botId: string) {
  return until(
    async () => {
      const page = await lab.call('team.tasks.list', { runId })
      return page.turns.find((turn: any) => turn.botId === botId && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(turn.status))
    },
    (turn) => !!turn,
    8_000
  )
}
export async function taskOf(lab: TeamLab, runId: string, localKey: string) {
  return until(
    async () => (await lab.call('team.tasks.list', { runId })).tasks.find((task: any) => task.localKey === localKey),
    (task) => !!task,
    8_000
  )
}
export const runOf = (lab: TeamLab, runId: string) => lab.call('team.run.get', { runId })
/** Waits until the guest actually received the turn, so a test does not race the dispatch. */
export const waitRunning = (lab: TeamLab, turnId: string) =>
  until(() => lab.call('bot.turn.get', { turnId }), (turn: any) => turn.status === 'running', 8_000)

/** Answers a turn as the guest runtime would: one assistant message, then a terminal status. */
export function finishTurn(lab: TeamLab, botId: string, turnId: string, content: string, status: 'succeeded' | 'failed' = 'succeeded') {
  const guest = lab.guest(botId)
  if (status === 'succeeded') guest.finish(turnId, 'succeeded', content)
  else {
    guest.turns.get(turnId)!.status = 'failed'
    guest.emit({ turnId, generation: 1, kind: 'turn.status', summary: 'failed', detail: { status: 'failed', error: { code: 'TOOL_FAILED', message: 'não deu' } } })
  }
}

/** Issues a collaboration request exactly as the runtime does, over that bot's own channel. */
export const collaborate = (lab: TeamLab, botId: string, turnId: string, method: string, params: Record<string, unknown> = {}) =>
  lab.guest(botId).collaborate(turnId, method, params)

export const clientId = () => randomUUID()
export { until }
