import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { TeamTurnContext } from '@maestrly/host-protocol'
import { Journal } from '../src/control/journal.js'
import { FileService } from '../src/files/service.js'
import { DesktopSession } from '../src/desktop/session.js'
import { BrowserSession } from '../src/tools/browser.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ProcessRegistry } from '../src/turns/leases.js'
import { CollaborationClient } from '../src/teams/client.js'
import type { ProviderEvent, TurnHooks } from '../src/providers/provider.js'
import { temporary, snapshot } from './helpers.js'

function teamContext(overrides: Partial<TeamTurnContext> = {}): TeamTurnContext {
  return {
    teamId: 'team-1',
    teamName: 'Relatórios',
    runId: 'run-1',
    taskId: 'task-1',
    round: 0,
    stage: 'planning',
    role: 'coordinator',
    objective: 'Produzir um relatório',
    members: [
      { botId: 'bot', name: 'Ana', role: 'coordenadora', coordinator: true, assignable: false },
      { botId: 'bot-2', name: 'Bruno', role: 'analista', coordinator: false, assignable: true },
    ],
    memory: [],
    resources: [],
    dependencyResults: [],
    remaining: { rounds: 3, tasks: 12, turns: 24, toolCalls: 300, activeMs: 3_600_000 },
    tools: ['team_delegate', 'team_status', 'team_members', 'team_publish_file', 'team_memory_propose', 'team_operation'],
    ...overrides,
  }
}
async function fixture(team?: TeamTurnContext) {
  const state = await temporary()
  const files = new FileService(join(state, 'workspace'))
  await files.init()
  const journal = new Journal(state)
  const events: ProviderEvent[] = []
  const hooks: TurnHooks = { emit: (event) => void events.push(event), requestApproval: vi.fn(async () => 'deny' as const), askQuestion: async () => '' }
  const turn = snapshot(team ? { team } : {})
  const sent: { turnId: string; generation: number; method: string; params: Record<string, unknown> }[] = []
  let reply: (input: { method: string }) => Promise<Record<string, unknown>> = async () => ({ ok: true })
  const collaboration = new CollaborationClient(
    async (input) => {
      sent.push(input)
      return reply(input)
    },
    () => ({ turnId: turn.turnId, generation: turn.generation, team: turn.team })
  )
  const browser = new BrowserSession(state, files, new DesktopSession(), () => registry.invalidate())
  const registry = new ToolRegistry(
    journal,
    files,
    browser,
    () => ({ snapshot: turn, signal: new AbortController().signal, processes: new ProcessRegistry(), hooks }),
    () => turn.permissionMode,
    collaboration
  )
  const call = (name: string, args: unknown = {}, requestId = randomUUID()) => registry.call(turn.turnId, requestId, name, args)
  return { state, files, journal, events, turn, registry, call, sent, collaboration, setReply: (fn: typeof reply) => (reply = fn) }
}
const parse = (result: Awaited<ReturnType<ToolRegistry['call']>>) => JSON.parse((result.content[0] as { text: string }).text)

test('offers collaboration tools only for a turn that belongs to a team', async () => {
  const plain = await fixture()
  const names = plain.registry.list().map((tool) => tool.name)
  // Outside a team the names simply do not exist in the catalogue.
  for (const tool of ['team_delegate', 'team_status', 'team_publish_file', 'team_members', 'team_memory_propose'])
    expect(names, tool).not.toContain(tool)
  expect(names).toContain('browser_navigate')
  // Knowing the name is not enough: the call is refused too.
  const refused = await plain.call('team_delegate', { tasks: [{ localKey: 'a', assigneeBotId: 'bot-2', goal: 'x' }] })
  expect(refused.isError).toBe(true)
  expect(parse(refused).code).toBe('TEAM_UNAVAILABLE')
  expect(plain.sent).toHaveLength(0)

  const team = await fixture(teamContext())
  expect(team.registry.list().map((tool) => tool.name)).toEqual(expect.arrayContaining(['team_delegate', 'team_status', 'team_publish_file']))
  // The catalogue keeps its normal tools; collaboration is added, never a replacement.
  expect(team.registry.list().map((tool) => tool.name)).toContain('files_deliver')
})

test('a worker never receives the delegation tool, even in a team turn', async () => {
  const worker = await fixture(teamContext({ role: 'member', stage: 'working', tools: ['team_members', 'team_publish_file', 'team_memory_propose', 'team_operation'] }))
  const names = worker.registry.list().map((tool) => tool.name)
  expect(names).not.toContain('team_delegate')
  expect(names).not.toContain('team_status')
  expect(names).toContain('team_publish_file')
  const refused = await worker.call('team_delegate', { tasks: [{ localKey: 'a', assigneeBotId: 'bot-2', goal: 'x' }] })
  expect(refused.isError).toBe(true)
  expect(parse(refused).code).toBe('TEAM_STAGE_INVALID')
  // Nothing reached the Host: the runtime refused it locally as well.
  expect(worker.sent).toHaveLength(0)
})

test('sends the turn identity and never a bot, team or role chosen by the model', async () => {
  const team = await fixture(teamContext())
  team.setReply(async () => ({ receiptId: 'r1', round: 1, accepted: [], finishTurn: true, guidance: 'encerre o turno' }))
  const result = await team.call('team_delegate', {
    tasks: [{ localKey: 'analise', assigneeBotId: 'bot-2', goal: 'analise os números' }],
    // A forged origin is dropped by the strict parameter schema before the wire.
    sourceBotId: 'bot-9',
    teamId: 'team-9',
  })
  expect(result.isError).toBe(true)
  expect(team.sent).toHaveLength(0)

  const clean = await team.call('team_delegate', { tasks: [{ localKey: 'analise', assigneeBotId: 'bot-2', goal: 'analise os números' }] })
  expect(parse(clean).finishTurn).toBe(true)
  expect(team.sent).toHaveLength(1)
  expect(team.sent[0]).toMatchObject({ turnId: team.turn.turnId, generation: team.turn.generation, method: 'team_delegate' })
  expect(Object.keys(team.sent[0].params)).toEqual(['tasks'])
  expect(JSON.stringify(team.sent[0])).not.toContain('bot-9')
  expect(JSON.stringify(team.sent[0])).not.toContain('team-9')
})

test('keeps the intent journal and never repeats a request whose reply was lost', async () => {
  const team = await fixture(teamContext())
  let calls = 0
  team.setReply(async () => {
    calls++
    return { receiptId: 'r1', round: 1, accepted: [], finishTurn: true, guidance: '' }
  })
  const requestId = randomUUID()
  const params = { tasks: [{ localKey: 'a', assigneeBotId: 'bot-2', goal: 'x' }] }
  const first = await team.call('team_delegate', params, requestId)
  const again = await team.call('team_delegate', params, requestId)
  expect(parse(again)).toEqual(parse(first))
  expect(calls).toBe(1)
  expect(team.journal.hasToolRequest(team.turn.turnId, requestId)).toBe(true)
})

test('reports an accepted-but-unanswered publication instead of publishing twice', async () => {
  const team = await fixture(teamContext())
  team.setReply(async () => {
    throw Object.assign(new Error('timeout'), { code: 'TEAM_TIMEOUT' })
  })
  const result = await team.call('team_publish_file', { path: 'saida/relatorio.md' })
  expect(result.isError).toBe(true)
  const failure = parse(result)
  expect(failure.code).toBe('TEAM_TIMEOUT')
  // The guidance tells the model to consult, not to repeat the action.
  expect(failure.message).toContain('team_status')
  expect(team.sent).toHaveLength(1)
})

test('surfaces the Host refusal verbatim without falling back to a shell', async () => {
  const team = await fixture(teamContext())
  team.setReply(async () => {
    throw Object.assign(new Error('A composição da equipe mudou'), { code: 'TEAM_GRANT_REVOKED' })
  })
  const result = await team.call('team_publish_file', { path: 'saida/x.md' })
  expect(parse(result)).toMatchObject({ code: 'TEAM_GRANT_REVOKED' })
  // No shell or system escape hatch was attempted on refusal.
  expect(team.events.filter((event) => event.detail?.name === 'system_exec')).toHaveLength(0)
})

test('rejects parameters that a strict contract does not allow', async () => {
  const team = await fixture(teamContext())
  for (const [name, args] of [
    ['team_delegate', { tasks: [] }],
    ['team_delegate', { tasks: [{ localKey: '../x', assigneeBotId: 'bot-2', goal: 'x' }] }],
    ['team_publish_file', { path: '', name: 'x' }],
    ['team_memory_propose', { content: '' }],
    ['team_operation', {}],
  ] as const) {
    const result = await team.call(name, args)
    expect(result.isError, `${name}: ${JSON.stringify(args)}`).toBe(true)
  }
  expect(team.sent).toHaveLength(0)
})
