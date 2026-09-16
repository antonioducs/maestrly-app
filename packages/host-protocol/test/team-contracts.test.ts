import { describe, expect, it } from 'vitest'
import {
  COLLABORATION_METHODS,
  CONTROL_FRAME_MAX,
  TEAM_CAPABILITY,
  TEAM_LIMITS,
  TEAM_MUTATIONS,
  collaborationParamSchemas,
  collaborationRequestSchema,
  collaborationResultSchemas,
  guestFrameSchema,
  hostFrameSchema,
  requestSchema,
  teamMethods,
  teamRequestSchema,
  teamResultSchemas,
  teamRunSchema,
  teamTaskSchema,
  teamTurnContextSchema,
} from '../src/index.js'

const envelope = { version: 1, id: 'r' }
describe('team wire contracts', () => {
  it('shares the v1 envelope and gives every team method an exhaustive result schema', () => {
    expect(teamMethods.length).toBeGreaterThan(20)
    for (const method of teamMethods) expect(teamResultSchemas[method], method).toBeDefined()
    expect(requestSchema.safeParse({ ...envelope, method: 'team.list', params: {} }).success).toBe(true)
    expect(requestSchema.safeParse({ version: 2, id: 'r', method: 'team.list', params: {} }).success).toBe(false)
    expect(requestSchema.safeParse({ ...envelope, method: 'team.exec', params: { command: 'ls' } }).success).toBe(false)
    for (const mutation of TEAM_MUTATIONS) expect(teamMethods).toContain(mutation)
  })

  it('refuses infrastructure, secrets and free-form paths inside team parameters', () => {
    for (const [method, params] of [
      // Creating a team never provisions or selects a computer.
      ['team.create', { idempotencyKey: 'k', name: 'T', members: [{ botId: 'a' }, { botId: 'b' }], confirmSharing: true, vmId: 'vm-1' }],
      ['team.create', { idempotencyKey: 'k', name: 'T', members: [{ botId: 'a' }, { botId: 'b' }], confirmSharing: true, cpus: 4 }],
      // Sharing is explicit and confirmed, never implied.
      ['team.create', { idempotencyKey: 'k', name: 'T', members: [{ botId: 'a' }, { botId: 'b' }] }],
      // A team needs at least two members and never more than the product limit.
      ['team.create', { idempotencyKey: 'k', name: 'T', members: [{ botId: 'a' }], confirmSharing: true }],
      [
        'team.create',
        {
          idempotencyKey: 'k',
          name: 'T',
          members: Array.from({ length: TEAM_LIMITS.membersMax + 1 }, (_, index) => ({ botId: `b${index}` })),
          confirmSharing: true,
        },
      ],
      // Mutations of an existing resource carry the revision they believe they change.
      ['team.members.set', { teamId: 't', idempotencyKey: 'k', members: [{ botId: 'a' }, { botId: 'b' }], confirmSharing: true }],
      ['team.archive', { teamId: 't', expectedRevision: 0 }],
      ['team.messages.send', { teamId: 't', clientMessageId: 'c', content: 'hi', hostPath: '/var/state' }],
      ['team.artifacts.transferChunk', { transferId: 't', offset: 0, dataBase64: 'a'.repeat(70_000) }],
    ] as const)
      expect(teamRequestSchema.safeParse({ ...envelope, method, params }).success, `${method}:${JSON.stringify(params)}`).toBe(false)

    expect(
      teamRequestSchema.parse({
        ...envelope,
        method: 'team.messages.send',
        params: { teamId: 't', clientMessageId: 'c', content: 'analise o csv' },
      }).params
    ).toMatchObject({ artifactIds: [] })
  })

  it('derives collaboration origin from the Host, never from the model', () => {
    const frame = {
      type: 'collaboration.request',
      id: 'req-1',
      turnId: 'turn-1',
      generation: 1,
      method: 'team_delegate',
      params: { tasks: [{ localKey: 'a1', assigneeBotId: 'bot-2', goal: 'analisar' }] },
    }
    expect(guestFrameSchema.safeParse(frame).success).toBe(true)
    // A forged source, role or team on the frame is not part of the contract at all.
    for (const forged of [{ sourceBotId: 'bot-9' }, { teamId: 'team-9' }, { role: 'coordinator' }, { botId: 'bot-9' }])
      expect(guestFrameSchema.safeParse({ ...frame, ...forged }).success, JSON.stringify(forged)).toBe(false)
    expect(collaborationRequestSchema.safeParse({ ...frame, method: 'team_force_approve' }).success).toBe(false)
    expect(hostFrameSchema.safeParse({ type: 'collaboration.response', id: 'req-1', result: { ok: true } }).success).toBe(true)
  })

  it('keeps every collaboration method strictly parameterised and answered', () => {
    for (const method of COLLABORATION_METHODS) {
      expect(collaborationParamSchemas[method], method).toBeDefined()
      expect(collaborationResultSchemas[method], method).toBeDefined()
    }
    expect(collaborationParamSchemas.team_delegate.safeParse({ tasks: [] }).success).toBe(false)
    expect(
      collaborationParamSchemas.team_delegate.safeParse({
        tasks: Array.from({ length: TEAM_LIMITS.tasksPerBatchMax + 1 }, (_, index) => ({ localKey: `t${index}`, assigneeBotId: 'b', goal: 'x' })),
      }).success
    ).toBe(false)
    // Delegating never carries a shell, a Host path or an account choice.
    expect(
      collaborationParamSchemas.team_delegate.safeParse({ tasks: [{ localKey: 'a', assigneeBotId: 'b', goal: 'x', command: 'rm -rf /' }] }).success
    ).toBe(false)
    expect(collaborationParamSchemas.team_publish_file.safeParse({ path: 'out/report.md' }).success).toBe(true)
    expect(collaborationParamSchemas.team_publish_file.safeParse({ path: 'out/report.md', accountId: 'a' }).success).toBe(false)
    // A proposal is inert by contract: there is no way to say "active".
    expect(collaborationParamSchemas.team_memory_propose.safeParse({ content: 'x', active: true }).success).toBe(false)
    expect(collaborationResultSchemas.team_memory_propose.parse({ proposalId: 'p', status: 'proposed', guidance: 'ok' }).status).toBe('proposed')
  })

  it('carries team context only as an optional snapshot projection without secrets', () => {
    const context = teamTurnContextSchema.parse({
      teamId: 't',
      teamName: 'Relatórios',
      runId: 'r',
      taskId: 'k',
      round: 1,
      stage: 'working',
      role: 'member',
      members: [{ botId: 'b', name: 'Ana', role: 'analista', coordinator: false, assignable: true }],
      remaining: { rounds: 2, tasks: 10, turns: 20, toolCalls: 200, activeMs: 1_800_000 },
      tools: ['team_publish_file'],
    })
    expect(context.memory).toEqual([])
    expect(context.resources).toEqual([])
    // No credential, Host path or account reference may be smuggled into the context.
    for (const extra of [{ accountId: 'a' }, { credential: 'x' }, { hostPath: '/tmp' }, { apiKey: 'k' }])
      expect(teamTurnContextSchema.safeParse({ ...context, ...extra }).success, JSON.stringify(extra)).toBe(false)
    expect(JSON.stringify(context).length).toBeLessThan(CONTROL_FRAME_MAX)
  })

  it('keeps a run and its tasks serialisable well below the control frame limit', () => {
    const run = teamRunSchema.parse({
      id: 'run-1',
      teamId: 'team-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      coordinatorBotId: 'bot-1',
      roster: Array.from({ length: TEAM_LIMITS.membersMax }, (_, index) => ({
        memberId: `m${index}`,
        botId: `b${index}`,
        name: `Bot ${index}`,
        role: 'papel',
        coordinator: index === 0,
      })),
      memberGrantRevision: 1,
      limits: {},
      budget: {
        rounds: 0,
        tasks: 0,
        turns: 0,
        toolCallsReserved: 0,
        toolCallsSettled: 0,
        activeMsReserved: 0,
        activeMsSettled: 0,
        consolidationHeld: true,
        tokensObserved: false,
      },
      round: 0,
      status: 'planning',
      generation: 1,
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    expect(run.limits.concurrency).toBe(TEAM_LIMITS.concurrency)
    expect(run.budget.tokensObserved).toBe(false)
    // Unknown consumption stays unknown instead of being reported as zero.
    expect(run.budget.inputTokens).toBeUndefined()
    const task = teamTaskSchema.parse({
      id: 'task-1',
      runId: run.id,
      teamId: run.teamId,
      round: 1,
      localKey: 'analise',
      kind: 'work',
      assigneeBotId: 'b1',
      memberId: 'm1',
      goal: 'analisar o csv',
      origin: 'coordinator',
      status: 'planned',
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    expect(task.dependsOn).toEqual([])
    expect(task.useDependencyOutputs).toBe(true)
    expect(teamTaskSchema.safeParse({ ...task, localKey: '../escape' }).success).toBe(false)
    expect(Buffer.byteLength(JSON.stringify({ run, tasks: [task] }))).toBeLessThan(CONTROL_FRAME_MAX)
  })

  it('names the capability that gates the whole feature', () => {
    expect(TEAM_CAPABILITY).toBe('bot.teams.v1')
  })
})
