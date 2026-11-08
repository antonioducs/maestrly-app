import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ collect: vi.fn() }))

vi.mock('../../src/main/assistant/assistant-context', () => ({ collectAssistantOverview: h.collect }))

import { createOverviewService } from '../../src/main/assistant/overview-service'
import { interactiveTool } from '../../src/main/chat/autonomous'
import {
  clearHumanTurnOrigin,
  type HumanTurnOrigin,
  recordHumanTurnOrigin,
} from '../../src/main/chat/conversation-dispatch-authorization'
import {
  clearLinkedTurnOrigin,
  type LinkedTurnOrigin,
  recordLinkedTurnOrigin,
} from '../../src/main/chat/conversation-link-authorization'
import { setAssistantRoleResolver } from '../../src/main/chat/harness/assistant-role'
import {
  ASSISTANT_TOOL_NAMES,
  isHostToolReadOnly,
  PARENT_ONLY_CONVERSATION_TOOL_NAMES,
} from '../../src/main/chat/tool-policy'
import {
  ALL_TOOL_NAMES,
  builtinToolNamesForMode,
  isOptInToolName,
  selectSubagentToolNames,
} from '../../src/main/chat/tools'
import {
  ASSISTANT_TOOLS_UNAVAILABLE,
  assistantRuntimeFor,
  enableAssistantTools,
  maestrlyOverviewTool,
} from '../../src/main/chat/tools/assistant'
import { enableConversationLinkTools } from '../../src/main/chat/tools/conversation-link'
import type { ToolContext } from '../../src/main/chat/tools/util'
import { compactOverview, localRef, relativeAge, summarizeOverview } from '../../src/shared/assistant-overview'

const NOW = 1_800_000_000_000
const humans: HumanTurnOrigin[] = []
const linked: LinkedTurnOrigin[] = []

function humanTurn(conversationId: string): HumanTurnOrigin {
  const origin = {
    token: {},
    conversationId,
    messageId: 'typed-1',
    text: 'o que precisa de mim?',
    signal: new AbortController().signal,
  }
  recordHumanTurnOrigin(origin)
  humans.push(origin)
  return origin
}

function linkedTurn(conversationId: string): LinkedTurnOrigin {
  const origin = {
    token: {},
    conversationId,
    messageId: 'seed-1',
    peerConversationId: 'other',
    hop: 1,
    reportBack: false,
    signal: new AbortController().signal,
  }
  recordLinkedTurnOrigin(origin)
  linked.push(origin)
  return origin
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: 'assistant',
    projectId: '',
    messageId: 'reply',
    toolCallId: 'call-1',
    cwd: '/',
    signal: new AbortController().signal,
    ask: async () => undefined,
    askQuestion: async () => [],
    ...overrides,
  }
}

beforeEach(() => setAssistantRoleResolver((id) => id === 'assistant'))
afterEach(() => {
  for (const origin of humans.splice(0)) clearHumanTurnOrigin(origin.conversationId, origin.token)
  for (const origin of linked.splice(0)) clearLinkedTurnOrigin(origin.conversationId, origin.token)
  setAssistantRoleResolver(null)
  vi.clearAllMocks()
})

describe('assistant tool surface', () => {
  it('is an opt-in, parent-only, read-only built-in that unattended turns never get', () => {
    expect(ASSISTANT_TOOL_NAMES).toEqual(['maestrly_overview'])
    for (const name of ASSISTANT_TOOL_NAMES) {
      expect(ALL_TOOL_NAMES).toContain(name)
      expect(isOptInToolName(name)).toBe(true)
      expect(builtinToolNamesForMode('agent').has(name)).toBe(false)
      expect(PARENT_ONLY_CONVERSATION_TOOL_NAMES).toContain(name)
      expect(interactiveTool(name)).toBe(true)
      expect(interactiveTool(`mcp__maestrly__${name}`)).toBe(true)
    }
    expect(isHostToolReadOnly('maestrly_overview', maestrlyOverviewTool.metadata)).toBe(true)
    const child = selectSubagentToolNames({
      definition: { name: 'general-purpose', source: 'built-in' },
      readOnly: false,
      providedHostTools: new Set(['maestrly_overview', 'read']),
    })
    expect(child.has('maestrly_overview')).toBe(false)
  })

  it('is offered only in the assistant conversation and leaves other catalogs as they are', () => {
    humanTurn('chat')
    humanTurn('assistant')
    const chat = new Set<string>()
    enableConversationLinkTools(chat, 'chat', 'agent')
    const before = [...chat].sort()
    expect(enableAssistantTools(chat, 'chat', 'agent')).toBeUndefined()
    expect([...chat].sort()).toEqual(before)

    const assistant = new Set<string>()
    enableConversationLinkTools(assistant, 'assistant', 'agent')
    expect(enableAssistantTools(assistant, 'assistant', 'agent')).toBeDefined()
    expect([...assistant].sort()).toEqual([...before, 'maestrly_overview'].sort())
  })

  it('keeps the names but gives no runtime to a turn the person did not type, nor in Plan', () => {
    linkedTurn('assistant')
    const names = new Set<string>()
    expect(enableAssistantTools(names, 'assistant', 'agent')).toBeUndefined()
    expect(names.has('maestrly_overview')).toBe(true)
    expect(assistantRuntimeFor('assistant', 'agent')).toBeUndefined()

    humanTurn('assistant')
    const plan = new Set<string>()
    expect(enableAssistantTools(plan, 'assistant', 'plan')).toBeUndefined()
    expect(plan.size).toBe(0)
  })
})

describe('maestrly_overview', () => {
  it('answers unavailable without the runtime', async () => {
    expect(await maestrlyOverviewTool.execute({}, context())).toEqual({ error: ASSISTANT_TOOLS_UNAVAILABLE })
    expect(h.collect).not.toHaveBeenCalled()
  })

  it('collects without the assistant conversation itself and passes the query on', async () => {
    humanTurn('assistant')
    h.collect.mockResolvedValue(summarizeOverview({ conversations: [], bots: [], workspaces: [], hosts: [], now: NOW }))
    const runtime = assistantRuntimeFor('assistant', 'agent')!
    const result = await maestrlyOverviewTool.execute({ query: 'api' }, context({ assistant: runtime }))
    expect(h.collect).toHaveBeenCalledWith('assistant', { query: 'api' })
    expect(result).toEqual({})
  })

  it('refuses once the turn that asked has ended', async () => {
    const origin = humanTurn('assistant')
    const runtime = assistantRuntimeFor('assistant', 'agent')!
    clearHumanTurnOrigin('assistant', origin.token)
    expect(await runtime.overview({})).toEqual({ error: 'The turn that made this request is no longer active.' })
  })

  it('filters by conversation, workspace, computer or bot name, ignoring accents and case', async () => {
    const conversation = (id: string, name: string) =>
      ({ id, name, scope: 'project', branch: 'main', status: 'idle', archived: 0, lastActivityAt: NOW - 1000 }) as never
    const service = createOverviewService({
      localWorkspaces: () => [
        { id: 'w1', name: 'Integração', conversations: [conversation('a', 'Fix login')] },
        { id: 'w2', name: 'web', conversations: [conversation('b', 'Revisão do PR')] },
      ],
      localStandalone: () => [],
      isRunning: () => false,
      pending: () => ({ permissions: [], questions: [] }),
      hasPendingPlan: () => false,
      hosts: () => [],
      invokeHost: async () => {
        throw new Error('none')
      },
      fleetClients: () => [],
      now: () => NOW,
    })
    const byWorkspace = await service.collect(null, { query: 'INTEGRACAO' })
    expect(byWorkspace.recent.map((c) => c.ref)).toEqual([localRef('a')])
    expect(byWorkspace.workspaces.map((w) => w.name)).toEqual(['Integração'])
    const byName = await service.collect(null, { query: 'revisao' })
    expect(byName.recent.map((c) => c.ref)).toEqual([localRef('b')])
    expect((await service.collect(null, { query: '  ' })).recent).toHaveLength(2)
  })

  it('returns compact JSON with relative times and no empty fields', () => {
    const overview = summarizeOverview({
      conversations: [
        {
          ref: localRef('c1'),
          name: 'Fix login',
          place: { kind: 'local' },
          workspaceName: null,
          branch: null,
          status: 'asking',
          running: false,
          pending: [{ itemId: 'question:t1', need: 'question', summary: 'Which branch?' }],
          botCreated: false,
          lastActivityAt: NOW - 5 * 60_000,
        },
      ],
      bots: [
        {
          ref: 'bot:vps:b1',
          name: 'Reviewer',
          role: null,
          place: { kind: 'bot-server', serverId: 'vps', serverName: 'vps.example' },
          status: 'idle',
          activity: null,
          pending: [],
          runningRoutine: null,
        },
      ],
      workspaces: [],
      hosts: [{ place: { kind: 'host', hostId: 'srv/ws', hostName: 'Server' }, state: 'offline' }],
      now: NOW,
    })
    const compact = compactOverview(overview, NOW)
    expect(JSON.stringify(compact)).not.toContain('null')
    expect(compact).toEqual({
      needsYou: [
        {
          ref: 'local:c1',
          name: 'Fix login',
          place: 'this computer',
          status: 'asking',
          pending: [{ need: 'question', itemId: 'question:t1', summary: 'Which branch?' }],
          lastActivity: '5 min ago',
        },
      ],
      bots: [{ ref: 'bot:vps:b1', name: 'Reviewer', place: 'vps.example', status: 'idle' }],
      hosts: [{ place: 'Server', kind: 'host', state: 'offline' }],
    })
  })

  it('says how long ago in a few words', () => {
    expect(relativeAge(NOW - 10_000, NOW)).toBe('just now')
    expect(relativeAge(NOW - 59 * 60_000, NOW)).toBe('59 min ago')
    expect(relativeAge(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago')
    expect(relativeAge(NOW - 50 * 3_600_000, NOW)).toBe('2 d ago')
  })
})
