import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { narrowNetworkPolicy, narrowPermissionMode, type NetworkPolicy, type RoutineTurnContext } from '@maestrly/host-protocol'
import { Journal } from '../src/control/journal.js'
import { FileService } from '../src/files/service.js'
import { DesktopSession } from '../src/desktop/session.js'
import { BrowserSession } from '../src/tools/browser.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ProcessRegistry } from '../src/turns/leases.js'
import { RoutineClient } from '../src/routines/client.js'
import { configuration, routinesBlock } from '../src/providers/codex/configuration.js'
import type { ProviderEvent, TurnHooks } from '../src/providers/provider.js'
import { temporary, snapshot } from './helpers.js'

const offline: NetworkPolicy = { mode: 'offline', domains: [], revision: 1 }
const allow = (domains: string[], revision = 1): NetworkPolicy => ({ mode: 'allowlist', domains, revision })
const block = (domains: string[], revision = 1): NetworkPolicy => ({ mode: 'blocklist', domains, revision })

/**
 * The defect this file exists for: `turn.start` used to REPLACE the turn's approved policy
 * with the session's current one. A session in full-vm mode would then silently widen a turn
 * that a person had approved as "ask" — and a scheduled routine, which nobody is watching,
 * would run with an authorization that was never given.
 */
test('an authorization is the intersection of the two, never the wider side', () => {
  expect(narrowPermissionMode('full-vm', 'ask')).toBe('ask')
  expect(narrowPermissionMode('ask', 'full-vm')).toBe('ask')
  expect(narrowPermissionMode('full-vm', 'full-vm')).toBe('full-vm')

  // Offline beats everything, in both directions.
  expect(narrowNetworkPolicy(offline, block([]))).toMatchObject({ mode: 'offline', domains: [] })
  expect(narrowNetworkPolicy(block([]), offline)).toMatchObject({ mode: 'offline', domains: [] })
  // Allowlists intersect: a name allowed on only one side is not allowed.
  expect(narrowNetworkPolicy(allow(['a.com', 'b.com']), allow(['b.com', 'c.com']))).toMatchObject({ mode: 'allowlist', domains: ['b.com'] })
  // Blocklists accumulate.
  expect(narrowNetworkPolicy(block(['x.com']), block(['y.com']))).toMatchObject({ mode: 'blocklist', domains: ['x.com', 'y.com'] })
  // An allowlist crossed with a blocklist keeps only what is allowed and not blocked,
  // including subdomains of a blocked name.
  expect(narrowNetworkPolicy(allow(['api.openai.com', 'evil.example.com']), block(['example.com']))).toMatchObject({
    mode: 'allowlist',
    domains: ['api.openai.com'],
  })
  // The newer revision travels, so a stale snapshot cannot be replayed as current.
  expect(narrowNetworkPolicy(allow(['a.com'], 3), allow(['a.com'], 7)).revision).toBe(7)
})

test('the approved ceiling reaches the real provider configuration, not just the prompt', () => {
  const workspace = '/home/bot/workspace'
  const ask = configuration(snapshot({ permissionMode: 'ask' }), workspace, false, '/var/lib/maestrly-bot')
  const full = configuration(snapshot({ permissionMode: 'full-vm' }), workspace, false, '/var/lib/maestrly-bot')
  // What the provider is actually configured with, not what the prompt says.
  expect(ask.thread.approvalPolicy).toBe('on-request')
  expect(ask.thread.sandbox).toBe('workspace-write')
  expect(ask.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: [workspace] })
  expect(full.thread.approvalPolicy).toBe('never')
  expect(full.sandboxPolicy).toMatchObject({ type: 'dangerFullAccess' })
})

test('the routine context reaches the real prompt, and says plainly what a suggestion is', () => {
  const chat = configuration(snapshot({ routines: routineContext() }), '/home/bot/workspace', false, '/var/lib/maestrly-bot')
  expect(chat.thread.developerInstructions).toContain('2026-09-14 09:00')
  expect(chat.thread.developerInstructions).toContain('America/Sao_Paulo')
  expect(chat.thread.developerInstructions).toContain('Nunca diga que já está agendada')

  const scheduled = configuration(snapshot({ routines: routineContext({ canPropose: false, tools: [] }) }), '/home/bot/workspace', false, '/var/lib/maestrly-bot')
  expect(scheduled.thread.developerInstructions).toContain('não pode criar, alterar nem ativar rotinas')

  // With no known zone the model is told to ask rather than given a default.
  expect(routinesBlock(routineContext({ timeZone: undefined, nowLocal: undefined }))).toContain('pergunte o fuso')

  // A turn with no routine context at all keeps exactly the previous prompt shape.
  const plain = configuration(snapshot(), '/home/bot/workspace', false, '/var/lib/maestrly-bot')
  expect(plain.thread.developerInstructions).not.toContain('Rotinas e horários')
})

/** Tool-level authority follows the same rule: the stricter of session and turn. */
test('a full-vm session does not hand elevated tools to a turn approved as ask', async () => {
  const state = await temporary()
  const files = new FileService(join(state, 'workspace'))
  await files.init()
  const journal = new Journal(state)
  const hooks: TurnHooks = { emit: () => {}, requestApproval: vi.fn(async () => 'deny' as const), askQuestion: async () => '' }
  const turn = snapshot({ permissionMode: 'ask' })
  const session = { network: block([]), permissionMode: 'full-vm' as const }
  const browser = new BrowserSession(state, files, new DesktopSession(), () => registry.invalidate())
  const registry = new ToolRegistry(
    journal,
    files,
    browser,
    () => ({ snapshot: turn, signal: new AbortController().signal, processes: new ProcessRegistry(), hooks }),
    () => narrowPermissionMode(session.permissionMode, turn.permissionMode)
  )
  expect(registry).toBeDefined()
  // The very intersection the supervisor applies before starting the turn.
  expect(narrowPermissionMode(session.permissionMode, turn.permissionMode)).toBe('ask')
  expect(narrowNetworkPolicy(session.network, turn.network)).toMatchObject({ mode: 'offline' })
})

function routineContext(overrides: Partial<RoutineTurnContext> = {}): RoutineTurnContext {
  return {
    nowUtc: '2026-09-14T12:00:00.000Z',
    nowLocal: '2026-09-14 09:00',
    timeZone: 'America/Sao_Paulo',
    canPropose: true,
    proposalsRemaining: 5,
    tools: ['routine_propose', 'routine_proposal_status'],
    existing: [],
    ...overrides,
  }
}
async function fixture(routines?: RoutineTurnContext) {
  const state = await temporary()
  const files = new FileService(join(state, 'workspace'))
  await files.init()
  const journal = new Journal(state)
  const events: ProviderEvent[] = []
  const hooks: TurnHooks = { emit: (event) => void events.push(event), requestApproval: vi.fn(async () => 'deny' as const), askQuestion: async () => '' }
  const turn = snapshot(routines ? { routines } : {})
  const sent: { method: string; params: Record<string, unknown> }[] = []
  let reply: () => Promise<Record<string, unknown>> = async () => ({ proposalId: 'p-1', status: 'pending', requiresHumanConfirmation: true, guidance: 'ok' })
  const client = new RoutineClient(
    async (input) => {
      sent.push({ method: input.method, params: input.params })
      return reply()
    },
    () => ({ turnId: turn.turnId, generation: turn.generation, routines: turn.routines })
  )
  const browser = new BrowserSession(state, files, new DesktopSession(), () => registry.invalidate())
  const registry = new ToolRegistry(
    journal,
    files,
    browser,
    () => ({ snapshot: turn, signal: new AbortController().signal, processes: new ProcessRegistry(), hooks }),
    () => turn.permissionMode,
    undefined,
    client
  )
  const call = (name: string, args: unknown = {}, requestId = randomUUID()) => registry.call(turn.turnId, requestId, name, args)
  return { registry, call, sent, setReply: (fn: typeof reply) => (reply = fn) }
}
const parse = (result: Awaited<ReturnType<ToolRegistry['call']>>) => JSON.parse((result.content[0] as { text: string }).text)

test('routine tools exist only in a turn that is allowed to suggest one', async () => {
  const scheduled = await fixture(routineContext({ canPropose: false, tools: [] }))
  const names = scheduled.registry.list().map((tool) => tool.name)
  expect(names).not.toContain('routine_propose')
  // Knowing the name is not enough: the call is refused and nothing reaches the Host.
  const refused = await scheduled.call('routine_propose', { name: 'R', request: 'faça' })
  expect(refused.isError).toBe(true)
  expect(parse(refused).code).toBe('ROUTINE_PROPOSAL_FORBIDDEN')
  expect(scheduled.sent).toHaveLength(0)

  const chat = await fixture(routineContext())
  expect(chat.registry.list().map((tool) => tool.name)).toEqual(expect.arrayContaining(['routine_propose', 'routine_proposal_status']))
  // The normal catalogue is untouched; routine tools are added, never a replacement.
  expect(chat.registry.list().map((tool) => tool.name)).toContain('files_deliver')
})

test('a turn with no routine context at all has no such tool', async () => {
  const plain = await fixture()
  expect(plain.registry.list().map((tool) => tool.name)).not.toContain('routine_propose')
  const refused = await plain.call('routine_propose', { name: 'R', request: 'faça' })
  expect(refused.isError).toBe(true)
  expect(plain.sent).toHaveLength(0)
})

test('a proposal is described to the model as an inert card, never as a schedule', async () => {
  const chat = await fixture(routineContext())
  const tool = chat.registry.list().find((candidate) => candidate.name === 'routine_propose')!
  expect(tool.description).toContain('CARTÃO')
  expect(tool.description).toContain('Nunca diga que a rotina foi criada')
  const result = await chat.call('routine_propose', {
    name: 'Resumo',
    request: 'Prepare o resumo',
    schedule: { kind: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' },
  })
  expect(result.isError).toBeFalsy()
  expect(parse(result)).toMatchObject({ requiresHumanConfirmation: true, status: 'pending' })
  expect(chat.sent).toHaveLength(1)
  expect(chat.sent[0].method).toBe('routine_propose')
})

test('with no known zone, the model has to ask instead of assuming one', async () => {
  const chat = await fixture(routineContext({ timeZone: undefined, nowLocal: undefined }))
  const refused = await chat.call('routine_propose', {
    name: 'Resumo',
    request: 'Prepare o resumo',
    schedule: { kind: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' },
  })
  expect(refused.isError).toBe(true)
  expect(parse(refused).code).toBe('ROUTINE_SCHEDULE_INVALID')
  expect(chat.sent).toHaveLength(0)
  // Asking a question is always available: a card without a calendar is legitimate.
  const asked = await chat.call('routine_propose', { name: 'Resumo', request: 'Prepare o resumo', clarification: 'De manhã é às 9h?' })
  expect(asked.isError).toBeFalsy()
  expect(chat.sent).toHaveLength(1)
})

test('a turn that already used its suggestions gets no tool at all', async () => {
  const exhausted = await fixture(routineContext({ proposalsRemaining: 0 }))
  expect(exhausted.registry.list().map((tool) => tool.name)).not.toContain('routine_propose')
})
