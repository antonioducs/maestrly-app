import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  ALL_TOOL_NAMES,
  builtinToolNamesForMode,
  isOptInToolName,
  READ_ONLY_TOOL_NAMES,
  selectSubagentToolNames,
} from '../../src/main/chat/tools'
import { swarmUpdateTool } from '../../src/main/chat/tools/maestro-swarm'
import { listSwarm } from '../../src/main/chat/maestro-swarm'
import { MAESTRO_SWARM_TOOL_NAMES, PARENT_ONLY_CONVERSATION_TOOL_NAMES } from '../../src/main/chat/tool-policy'
import type { ToolContext } from '../../src/main/chat/tools/util'

function context(conversationId: string): ToolContext {
  return {
    conversationId,
    projectId: 'ws',
    messageId: 'assistant',
    toolCallId: 'call-1',
    cwd: '/repo',
    signal: new AbortController().signal,
    ask: async () => undefined,
    askQuestion: async () => [],
  }
}

beforeEach(() => freshDb())
afterEach(() => closeDb())

describe('swarm_update tool', () => {
  it('is registered as an opt-in parent-only tool and never reaches subagents or Maestro workers', () => {
    expect(MAESTRO_SWARM_TOOL_NAMES).toEqual(['swarm_update'])
    expect(ALL_TOOL_NAMES).toContain('swarm_update')
    expect(isOptInToolName('swarm_update')).toBe(true)
    expect(READ_ONLY_TOOL_NAMES).not.toContain('swarm_update')
    expect(PARENT_ONLY_CONVERSATION_TOOL_NAMES).toContain('swarm_update')
    expect(builtinToolNamesForMode('maestro').has('swarm_update')).toBe(false)
    expect(builtinToolNamesForMode('agent').has('swarm_update')).toBe(false)

    const provided = new Set(['swarm_update', 'read', 'bash'])
    const worker = selectSubagentToolNames({
      definition: { name: 'general-purpose', source: 'built-in' },
      readOnly: false,
      providedHostTools: provided,
    })
    const explicit = selectSubagentToolNames({
      definition: { name: 'custom', tools: ['swarm_update', 'read'] },
      readOnly: false,
      providedHostTools: provided,
    })
    expect(worker.has('swarm_update')).toBe(false)
    expect(explicit.has('swarm_update')).toBe(false)
  })

  it('rejects calls outside Maestro conversations', async () => {
    const ws = makeWorkspace()
    const standard = makeConversation(ws.id, { experience: 'standard' })
    const args = { tasks: [{ key: 't1', title: 'Add API' }] }

    const res = await swarmUpdateTool.execute(args, context(standard.id))
    expect(res).toEqual({ ok: false, error: 'swarm_update is only available in Maestro conversations' })
    expect(swarmUpdateTool.toModelText(args, res)).toBe('swarm_update is only available in Maestro conversations')

    const missing = await swarmUpdateTool.execute(args, context('does-not-exist'))
    expect(missing).toEqual({ ok: false, error: 'swarm_update is only available in Maestro conversations' })
  })

  it('declares and updates tasks inside a Maestro conversation and renders the swarm table', async () => {
    const ws = makeWorkspace()
    const maestro = makeConversation(ws.id, { experience: 'maestro' })
    const args = {
      tasks: [
        { key: 'api', title: 'Build API', agent: 'builder', phase: 'queued' as const },
        { key: 'ui', title: 'Build UI', agent: 'designer', dependsOn: ['api'], note: 'waiting on api' },
      ],
    }

    const res = await swarmUpdateTool.execute(args, context(maestro.id))
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.error)
    expect(res.tasks).toHaveLength(2)
    expect(listSwarm(maestro.id).map((t) => [t.key, t.resourceId, t.phase])).toEqual([
      ['api', 'builder', 'queued'],
      ['ui', 'designer', 'queued'],
    ])

    const rendered = swarmUpdateTool.toModelText(args, res)
    expect(rendered).toContain('# Maestro swarm state')
    expect(rendered).toContain('| api | Build API | builder |')
    expect(rendered).toContain('| ui | Build UI | designer |')

    // Moving to changes requires reason
    const invalidChange = await swarmUpdateTool.execute(
      { tasks: [{ key: 'api', phase: 'changes' as const }] },
      context(maestro.id)
    )
    expect(invalidChange.ok).toBe(false)
    expect(swarmUpdateTool.toModelText({ tasks: [{ key: 'api', phase: 'changes' as const }] }, invalidChange)).toMatch(
      /reason/i
    )

    const validChange = await swarmUpdateTool.execute(
      { tasks: [{ key: 'api', phase: 'changes' as const, reason: 'review' as const, note: 'add tests' }] },
      context(maestro.id)
    )
    expect(validChange.ok).toBe(true)
    if (validChange.ok) {
      expect(swarmUpdateTool.toModelText({ tasks: [{ key: 'api' }] }, validChange)).toContain('changes (review)')
    }
  })

  it('validates schema constraints (min 1 task, key regex, lengths, enums)', () => {
    expect(swarmUpdateTool.parameters.safeParse({ tasks: [] }).success).toBe(false)
    expect(swarmUpdateTool.parameters.safeParse({ tasks: [{ key: 'bad key!' }] }).success).toBe(false)
    expect(swarmUpdateTool.parameters.safeParse({ tasks: [{ key: 'k', title: 'a'.repeat(201) }] }).success).toBe(false)
    expect(swarmUpdateTool.parameters.safeParse({ tasks: [{ key: 'k', note: 'a'.repeat(501) }] }).success).toBe(false)
    expect(swarmUpdateTool.parameters.safeParse({ tasks: [{ key: 'k', phase: 'implementing' }] }).success).toBe(false)
    expect(swarmUpdateTool.parameters.safeParse({ tasks: [{ key: 'k', reason: 'other' }] }).success).toBe(false)
    expect(
      swarmUpdateTool.parameters.safeParse({
        tasks: [
          {
            key: 'PROJ-1:sub/1',
            title: 'Valid',
            agent: 'builder',
            dependsOn: ['PROJ-0'],
            phase: 'reviewing',
            note: 'checking diff',
          },
        ],
      }).success
    ).toBe(true)
  })
})
