import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubagentSessionSummary } from '../../src/shared/chat'
import type { MaestroResourceV1, MaestroTurnSnapshotV1 } from '../../src/shared/maestro'
import { MAESTRO_CONFIG_VERSION } from '../../src/shared/maestro'
import { MaestroAgentExecutionError, resolveMaestroAgentExecution } from '../../src/main/chat/maestro-agent-execution'
import {
  MAESTRO_DELEGATE_TOOL_SCHEMA,
  assertMaestroResumeSession,
  maestroAgentsFromTurn,
  prepareMaestroDelegation,
  renderMaestroAgentCatalog,
} from '../../src/main/chat/maestro-delegation'
import { MAESTRO_SYSTEM_SPEC } from '../../src/main/chat/maestro-prompt'
import { BUILTIN_AGENTS } from '../../src/main/chat/agents'
import { createExplicitSubagentTurnState } from '../../src/main/chat/subagent-selection-guard'

vi.mock('../../src/main/chat/subagent-provider-runtime', () => ({
  subagentProviderStatus: vi.fn(async (providerId: string) =>
    providerId === 'missing-provider' ? 'missing' : 'available'
  ),
  subagentModelCatalog: vi.fn(async () => ({
    status: 'available',
    models: ['gpt-worker', 'claude-worker', 'fast-worker'],
  })),
}))

vi.mock('../../src/main/chat/subagent-profile-model-meta', () => ({
  getSubagentProfileModelMeta: vi.fn(async (_providerId: string, modelId: string) => ({
    status: 'available',
    meta: { reasoning: false, fastModeCapability: modelId === 'fast-worker' },
  })),
}))

const resource = (patch: Partial<MaestroResourceV1> & Pick<MaestroResourceV1, 'id'>): MaestroResourceV1 => {
  const { id, ...rest } = patch
  return {
    id,
    label: id,
    enabled: true,
    description: `${id} description`,
    capability: 'worker',
    specialties: ['general'],
    candidates: [{ providerId: 'openai', modelId: 'gpt-worker', effort: 'off' }],
    ...rest,
  }
}

function turn(pool: MaestroResourceV1[]): MaestroTurnSnapshotV1 {
  return {
    version: MAESTRO_CONFIG_VERSION,
    strategy: 'balanced',
    pool,
    source: 'conversation',
    diagnostics: [],
    frozenAt: 1,
  }
}

const intent = (agent: string, patch: Record<string, unknown> = {}) => ({
  agent,
  task: 'Implement the slice',
  kind: 'implement' as const,
  domain: 'frontend' as const,
  reviewOf: [],
  independent: true,
  ...patch,
})

const parent = { providerId: 'openai', modelId: 'gpt-worker', effort: 'off' }

describe('Maestro parent-selected execution', () => {
  beforeEach(() => vi.clearAllMocks())

  it('executes the exact enabled agent selected by the parent without scoring or substitution', async () => {
    const snapshot = turn([
      resource({ id: 'frontend', specialties: ['frontend'] }),
      resource({ id: 'generalist', specialties: ['general'] }),
    ])
    const routed = await resolveMaestroAgentExecution({
      intent: intent('generalist'),
      turn: snapshot,
      parent,
      parentFastMode: false,
      delegationId: 'fixed',
      now: 10,
    })

    expect(routed.resource.id).toBe('generalist')
    expect(routed.snapshot).toMatchObject({
      delegationId: 'fixed',
      selection: 'parent-selected',
      resource: { id: 'generalist' },
      profile: { effective: { modelId: 'gpt-worker', candidateIndex: 0 } },
      routedAt: 10,
    })
  })

  it('uses built-in physical agents for project snapshots even when a local catalog overrides the same name', () => {
    const explorer = BUILTIN_AGENTS.find((agent) => agent.name === 'explore')!
    const projectTurn = {
      ...turn([resource({ id: 'explorer', capability: 'read-only', agentName: 'explore' })]),
      source: 'project' as const,
    }
    const mapped = maestroAgentsFromTurn(projectTurn, [
      { ...explorer, prompt: 'LOCAL OVERRIDE MUST NOT RUN', source: 'user-local' },
    ])
    expect(mapped[0]?.prompt).toContain(explorer.prompt)
    expect(mapped[0]?.prompt).not.toContain('LOCAL OVERRIDE MUST NOT RUN')
  })

  it('fails visibly for a missing or disabled choice and never falls back to another agent', async () => {
    const snapshot = turn([resource({ id: 'disabled', enabled: false }), resource({ id: 'available' })])
    await expect(
      resolveMaestroAgentExecution({
        intent: intent('disabled'),
        turn: snapshot,
        parent,
        parentFastMode: false,
      })
    ).rejects.toMatchObject({ code: 'agent-unavailable' })
    await expect(
      resolveMaestroAgentExecution({
        intent: intent('missing'),
        turn: snapshot,
        parent,
        parentFastMode: false,
      })
    ).rejects.toBeInstanceOf(MaestroAgentExecutionError)
  })

  it('enforces an explicit #agent choice and reserves distinct parallel explicit selections', async () => {
    const snapshot = turn([resource({ id: 'frontend' }), resource({ id: 'backend' })])
    await expect(
      resolveMaestroAgentExecution({
        intent: intent('backend'),
        turn: snapshot,
        parent,
        parentFastMode: false,
        explicitAgent: 'frontend',
      })
    ).rejects.toMatchObject({ code: 'explicit-agent-mismatch' })

    const turnState = createExplicitSubagentTurnState(
      ['frontend', 'backend'],
      snapshot.pool.map((item) => item.id)
    )
    const common = { turn: snapshot, parent, parentFastMode: false, turnState }
    const [first, second] = await Promise.all([
      prepareMaestroDelegation({ ...common, input: intent('frontend'), delegationId: 'parallel-1' }),
      prepareMaestroDelegation({ ...common, input: intent('backend'), delegationId: 'parallel-2' }),
    ])
    expect([first.agentName, second.agentName]).toEqual(['frontend', 'backend'])
    expect(turnState.dispatched).toEqual(new Set(['frontend', 'backend']))
  })

  it('uses ordered technical fallbacks only inside the parent-selected agent', async () => {
    const snapshot = turn([
      resource({
        id: 'selected',
        candidates: [
          { providerId: 'missing-provider', modelId: 'gpt-worker', effort: 'off' },
          { providerId: 'anthropic', modelId: 'claude-worker', effort: 'off' },
        ],
      }),
      resource({ id: 'other' }),
    ])
    const routed = await resolveMaestroAgentExecution({
      intent: intent('selected'),
      turn: snapshot,
      parent,
      parentFastMode: false,
    })
    expect(routed.resource.id).toBe('selected')
    expect(routed.profile.effective).toMatchObject({ providerId: 'anthropic', candidateIndex: 1 })
    expect(routed.profile.attempts.map((attempt) => attempt.outcome)).toEqual(['rejected', 'selected'])
  })

  it('inherits the parent profile only when the selected agent has no configured candidates', async () => {
    const routed = await resolveMaestroAgentExecution({
      intent: intent('inherited'),
      turn: turn([resource({ id: 'inherited', candidates: [] })]),
      parent: { providerId: 'openai', modelId: 'fast-worker', effort: 'off' },
      parentFastMode: true,
    })
    expect(routed.profile.effective).toMatchObject({ modelId: 'fast-worker', fastMode: true })
  })

  it('returns an agent-specific error when every candidate of the choice is unavailable', async () => {
    await expect(
      resolveMaestroAgentExecution({
        intent: intent('broken'),
        turn: turn([
          resource({
            id: 'broken',
            candidates: [{ providerId: 'missing-provider', modelId: 'gpt-worker', effort: 'off' }],
          }),
          resource({ id: 'other' }),
        ]),
        parent,
        parentFastMode: false,
      })
    ).rejects.toMatchObject({ code: 'agent-profile-unavailable' })
  })

  it('requires agent in delegate and exposes the complete non-secret config to the parent', () => {
    expect(MAESTRO_DELEGATE_TOOL_SCHEMA.required).toEqual(['agent', 'task', 'kind', 'domain'])
    const catalog = renderMaestroAgentCatalog(
      turn([
        resource({
          id: 'frontend',
          label: 'Frontend specialist',
          capability: 'worker',
          specialties: ['frontend', 'design'],
          instructions: 'Prefer accessible UI.',
          candidates: [{ providerId: 'openai', modelId: 'fast-worker', effort: 'high', fastMode: true }],
        }),
        resource({ id: 'hidden', enabled: false }),
      ])
    )
    expect(catalog).toContain('frontend (Frontend specialist)')
    expect(catalog).toContain('capability: worker')
    expect(catalog).toContain('specialties: frontend, design')
    expect(catalog).toContain('instructions: Prefer accessible UI.')
    expect(catalog).toContain('provider=openai, model=fast-worker, effort=high, Fast=on')
    expect(catalog).not.toContain('hidden')
  })

  describe('resume_session_id', () => {
    const owner = { conversationId: 'conv-1', parentMessageId: 'parent-1' }
    const session = (patch: Partial<SubagentSessionSummary> = {}): SubagentSessionSummary => ({
      id: 'subagent-prev',
      conversationId: owner.conversationId,
      parentMessageId: owner.parentMessageId,
      toolCallId: 'delegate-prev',
      origin: 'delegate',
      agentName: 'frontend',
      task: 'Build it.',
      status: 'completed',
      startedAt: 1,
      lastActivityAt: 2,
      revision: 3,
      toolNames: [],
      files: [],
      commands: [],
      tests: [],
      ...patch,
    })
    const lookup = (value: SubagentSessionSummary | null) => () => value

    it('is exposed in the delegate schema and the orchestration contract', () => {
      expect(MAESTRO_DELEGATE_TOOL_SCHEMA.properties.resume_session_id.type).toBe('string')
      expect(MAESTRO_DELEGATE_TOOL_SCHEMA.required).not.toContain('resume_session_id')
      expect(MAESTRO_SYSTEM_SPEC).toContain('resume_session_id')
    })

    it('rejects an unknown session', () => {
      expect(() =>
        assertMaestroResumeSession({
          intent: intent('frontend', { resumeSessionId: 'subagent-prev' }),
          owner,
          lookupSession: lookup(null),
        })
      ).toThrow(expect.objectContaining({ code: 'resume-session-not-found' }))
    })

    it('rejects a session from another parent turn', () => {
      expect(() =>
        assertMaestroResumeSession({
          intent: intent('frontend', { resumeSessionId: 'subagent-prev' }),
          owner,
          lookupSession: lookup(session({ parentMessageId: 'parent-other' })),
        })
      ).toThrow(expect.objectContaining({ code: 'resume-session-foreign' }))
    })

    it('rejects a session that is still running', () => {
      expect(() =>
        assertMaestroResumeSession({
          intent: intent('frontend', { resumeSessionId: 'subagent-prev' }),
          owner,
          lookupSession: lookup(session({ status: 'running' })),
        })
      ).toThrow(expect.objectContaining({ code: 'resume-session-active' }))
    })

    it('rejects a session run by a different agent', () => {
      expect(() =>
        assertMaestroResumeSession({
          intent: intent('backend', { resumeSessionId: 'subagent-prev' }),
          owner,
          lookupSession: lookup(session()),
        })
      ).toThrow(expect.objectContaining({ code: 'resume-agent-mismatch' }))
    })

    it('accepts a terminal session of the same agent and records the lineage in the snapshot', async () => {
      const snapshot = turn([resource({ id: 'frontend' })])
      const prepared = await prepareMaestroDelegation({
        input: intent('frontend', { resume_session_id: 'subagent-prev' }),
        turn: snapshot,
        parent,
        parentFastMode: false,
        turnState: createExplicitSubagentTurnState([], ['frontend']),
        delegationId: 'resume-1',
        owner,
        lookupSession: lookup(session({ status: 'failed' })),
      })
      expect(prepared.intent.resumeSessionId).toBe('subagent-prev')
      expect(prepared.execution.snapshot.resumedFrom).toBe('subagent-prev')
    })
  })
})
