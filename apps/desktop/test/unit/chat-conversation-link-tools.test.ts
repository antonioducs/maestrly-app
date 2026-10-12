import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  service: {
    list: vi.fn(),
    read: vi.fn(),
    wait: vi.fn(),
    send: vi.fn(),
    report: vi.fn(),
  },
  autonomous: false,
}))

vi.mock('../../src/main/conversation-link-service', () => ({
  getConversationLinkService: async () => h.service,
}))
vi.mock('../../src/main/chat/autonomous', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/autonomous')>()
  return { ...actual, autonomousPolicy: (id: string) => (h.autonomous ? { cwd: '/', id } : undefined) }
})

import {
  ALL_TOOL_NAMES,
  buildTools,
  builtinToolNamesForMode,
  isOptInToolName,
  READ_ONLY_TOOL_NAMES,
  selectSubagentToolNames,
} from '../../src/main/chat/tools'
import {
  conversationLinkRuntimeFor,
  enableConversationLinkTools,
  isParentOnlyConversationToolName,
  listConversationsTool,
  readConversationTool,
  reportToSourceTool,
  sendToConversationTool,
  waitConversationTool,
} from '../../src/main/chat/tools/conversation-link'
import type { ToolContext } from '../../src/main/chat/tools/util'
import {
  clearHumanTurnOrigin,
  recordHumanTurnOrigin,
  type HumanTurnOrigin,
} from '../../src/main/chat/conversation-dispatch-authorization'
import {
  clearLinkedTurnOrigin,
  recordLinkedTurnOrigin,
  type LinkedTurnOrigin,
} from '../../src/main/chat/conversation-link-authorization'
import {
  APP_TOOL_POLICY,
  CONVERSATION_DISPATCH_TOOL_NAMES,
  CONVERSATION_LINK_TOOL_NAMES,
  PARENT_ONLY_CONVERSATION_TOOL_NAMES,
} from '../../src/main/chat/tool-policy'
import { interactiveTool } from '../../src/main/chat/autonomous'
import { isMaestroWorkerOperationalToolName } from '../../src/main/chat/maestro-worker-tools'

const humans: HumanTurnOrigin[] = []
const linked: LinkedTurnOrigin[] = []

function humanTurn(conversationId = 'source'): HumanTurnOrigin {
  const origin = { token: {}, conversationId, messageId: 'typed-1', text: 'manda pra ela', signal: new AbortController().signal }
  recordHumanTurnOrigin(origin)
  humans.push(origin)
  return origin
}

function linkedTurn(conversationId = 'child'): LinkedTurnOrigin {
  const origin = {
    token: {},
    conversationId,
    messageId: 'seed-1',
    peerConversationId: 'source',
    hop: 1,
    reportBack: true,
    signal: new AbortController().signal,
  }
  recordLinkedTurnOrigin(origin)
  linked.push(origin)
  return origin
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: 'source',
    projectId: 'ws',
    messageId: 'assistant',
    toolCallId: 'call-1',
    cwd: '/repo',
    signal: new AbortController().signal,
    ask: async () => undefined,
    askQuestion: async () => [],
    ...overrides,
  }
}

afterEach(() => {
  for (const origin of humans.splice(0)) clearHumanTurnOrigin(origin.conversationId, origin.token)
  for (const origin of linked.splice(0)) clearLinkedTurnOrigin(origin.conversationId, origin.token)
  h.autonomous = false
  vi.clearAllMocks()
})

describe('conversation link tool surface', () => {
  it('is an opt-in, parent-only built-in outside the app-tools catalog', () => {
    expect(PARENT_ONLY_CONVERSATION_TOOL_NAMES).toEqual([...CONVERSATION_DISPATCH_TOOL_NAMES, ...CONVERSATION_LINK_TOOL_NAMES])
    for (const name of CONVERSATION_LINK_TOOL_NAMES) {
      expect(ALL_TOOL_NAMES).toContain(name)
      expect(isOptInToolName(name)).toBe(true)
      expect(Object.keys(APP_TOOL_POLICY)).not.toContain(name)
      expect(READ_ONLY_TOOL_NAMES).not.toContain(name)
      expect(builtinToolNamesForMode('agent').has(name)).toBe(false)
      expect(isParentOnlyConversationToolName(name)).toBe(true)
    }
  })

  it('never reaches subagents, Maestro workers or unattended turns', () => {
    const provided = new Set([...CONVERSATION_LINK_TOOL_NAMES, 'read', 'bash'])
    const worker = selectSubagentToolNames({
      definition: { name: 'general-purpose', source: 'built-in' },
      readOnly: false,
      providedHostTools: provided,
    })
    const explicit = selectSubagentToolNames({
      definition: { name: 'custom', tools: [...CONVERSATION_LINK_TOOL_NAMES, 'read'] },
      readOnly: false,
      providedHostTools: provided,
    })
    for (const name of CONVERSATION_LINK_TOOL_NAMES) {
      expect(worker.has(name)).toBe(false)
      expect(explicit.has(name)).toBe(false)
      expect(isMaestroWorkerOperationalToolName(name)).toBe(false)
      expect(interactiveTool(name)).toBe(true)
      expect(interactiveTool(`mcp__maestrly__${name}`)).toBe(true)
    }
    expect(interactiveTool('list_conversation_models')).toBe(true)
    expect(interactiveTool('read')).toBe(false)
  })

  it('is offered to turns the person typed and turns another conversation started, in Agent, Design and Ask', () => {
    expect(conversationLinkRuntimeFor('source', 'agent')).toBeUndefined()
    humanTurn()
    for (const mode of ['agent', 'design', 'ask'] as const) expect(conversationLinkRuntimeFor('source', mode)).toBeDefined()
    for (const mode of ['plan', 'maestro'] as const) expect(conversationLinkRuntimeFor('source', mode)).toBeUndefined()

    linkedTurn()
    const enabled = builtinToolNamesForMode('agent')
    expect(enableConversationLinkTools(enabled, 'child', 'agent')).toBeDefined()
    for (const name of CONVERSATION_LINK_TOOL_NAMES) expect(enabled.has(name)).toBe(true)
    // A linked turn never gets the tools that start conversations or create projects.
    for (const name of CONVERSATION_DISPATCH_TOOL_NAMES) expect(enabled.has(name)).toBe(false)

    const restricted = builtinToolNamesForMode('plan')
    expect(enableConversationLinkTools(restricted, 'child', 'plan')).toBeUndefined()
    expect(CONVERSATION_LINK_TOOL_NAMES.some((name) => restricted.has(name))).toBe(false)
  })

  it('is not offered to unattended executor turns', () => {
    humanTurn()
    h.autonomous = true
    expect(conversationLinkRuntimeFor('source', 'agent')).toBeUndefined()
  })
})

describe('conversation link tool execution', () => {
  it('refuses without the main-turn runtime', async () => {
    const tools = buildTools({ enabled: new Set(CONVERSATION_LINK_TOOL_NAMES), makeCtx: () => context() })
    const execute = tools.send_to_conversation.execute as (input: unknown, options: unknown) => Promise<string>
    const output = await execute({ conversationId: 'other', message: 'Hi.' }, { toolCallId: 'call-1', messages: [] })
    expect(JSON.parse(output)).toMatchObject({ ok: false, code: 'unavailable' })
    expect(output).toContain('main agent turn')
    expect(await listConversationsTool.execute({}, context())).toEqual({ error: expect.stringContaining('not available') })
    for (const tool of [readConversationTool, waitConversationTool])
      expect(await tool.execute({ conversationId: 'x' }, context())).toMatchObject({ code: 'unavailable' })
    expect(await reportToSourceTool.execute({ message: 'x' }, context())).toMatchObject({ code: 'unavailable' })
    expect(h.service.send).not.toHaveBeenCalled()
  })

  it('binds every call to the admitted turn and its provenance', async () => {
    const origin = humanTurn()
    const runtime = conversationLinkRuntimeFor('source', 'agent')!
    h.service.list.mockReturnValue([{ conversationId: 'other', name: 'Other' }])
    expect(await listConversationsTool.execute({ query: 'oth' }, context({ conversationLink: runtime }))).toEqual({
      conversations: [{ conversationId: 'other', name: 'Other' }],
    })
    const caller = h.service.list.mock.calls[0][0]
    expect(caller).toMatchObject({
      conversationId: 'source',
      originKey: 'message:typed-1',
      kind: 'human',
      hop: 0,
      peerConversationId: null,
      reportBack: false,
    })
    expect(h.service.list.mock.calls[0][1]).toEqual({ query: 'oth' })
    expect(() => caller.assertCurrent()).not.toThrow()

    // A newer turn in the same conversation expires everything captured for this one.
    humanTurn()
    expect(() => caller.assertCurrent()).toThrow(/no longer active/)
    expect(await sendToConversationTool.execute({ conversationId: 'other', message: 'Hi.' }, context({ conversationLink: runtime }))).toMatchObject({
      ok: false,
      code: 'turn-ended',
      error: expect.stringContaining('no longer active'),
    })
    expect(h.service.send).not.toHaveBeenCalled()
    expect(origin).toBeDefined()
  })

  it('carries the sender and hop of a linked turn', async () => {
    linkedTurn()
    const runtime = conversationLinkRuntimeFor('child', 'agent')!
    h.service.report.mockResolvedValue({ ok: true, status: 'deferred', conversationId: 'source', conversationName: 'Source' })
    expect(await reportToSourceTool.execute({ message: 'Done.' }, context({ conversationId: 'child', conversationLink: runtime }))).toMatchObject({
      status: 'deferred',
    })
    expect(h.service.report.mock.calls[0][0]).toMatchObject({
      conversationId: 'child',
      originKey: 'message:seed-1',
      kind: 'linked',
      hop: 1,
      peerConversationId: 'source',
      reportBack: true,
    })
  })

  it('asks the person in the chat to confirm a message to a conversation that is not linked', async () => {
    humanTurn()
    const runtime = conversationLinkRuntimeFor('source', 'agent')!
    let confirmed: boolean[] = []
    h.service.send.mockImplementation(async (_caller, _input, confirm) => {
      confirmed = [await confirm({ conversationId: 'other', name: 'Other', workspaceName: 'Repo' }, 'README changed.')]
      return { ok: true, status: 'delivered', conversationId: 'other', conversationName: 'Other' }
    })
    const askQuestion = vi.fn(async (_questions: unknown) => [['Send']])
    const input = { conversationId: 'other', message: 'README changed.' }
    expect(await sendToConversationTool.execute(input, context({ conversationLink: runtime, askQuestion }))).toMatchObject({
      status: 'delivered',
    })
    expect(confirmed).toEqual([true])
    expect(askQuestion.mock.calls[0][0]).toEqual([
      {
        header: 'Message another conversation',
        question: 'Send this message to “Other” (Repo)?\n\nREADME changed.',
        options: [{ label: 'Send' }, { label: "Don't send" }],
      },
    ])
    for (const answer of [[["Don't send"]], [], [['other']]]) {
      await sendToConversationTool.execute(input, context({ conversationLink: runtime, askQuestion: async () => answer }))
      expect(confirmed).toEqual([false])
    }
    await sendToConversationTool.execute(
      input,
      context({
        conversationLink: runtime,
        askQuestion: async () => {
          throw new Error('dismissed')
        },
      })
    )
    expect(confirmed).toEqual([false])
  })

  it('passes the turn signal to waits and validates input at the schema boundary', async () => {
    humanTurn()
    const runtime = conversationLinkRuntimeFor('source', 'agent')!
    const controller = new AbortController()
    h.service.wait.mockResolvedValue({ ok: true, status: 'idle', result: {} })
    await waitConversationTool.execute({ conversationId: 'child', timeoutSeconds: 30 }, context({ conversationLink: runtime, signal: controller.signal }))
    expect(h.service.wait.mock.calls[0][2]).toBe(controller.signal)
    expect(waitConversationTool.parameters.safeParse({ conversationId: 'c', timeoutSeconds: 901 }).success).toBe(false)
    expect(sendToConversationTool.parameters.safeParse({ conversationId: 'c', message: '' }).success).toBe(false)
    expect(sendToConversationTool.parameters.safeParse({ conversationId: 'c', message: 'x', explicit: true }).success).toBe(false)
    expect(readConversationTool.parameters.safeParse({ conversationId: 'c', messages: 21 }).success).toBe(false)
    expect(sendToConversationTool.toModelText({ conversationId: 'c', message: 'x' }, { ok: false, code: 'self', error: 'e' })).toBe(
      JSON.stringify({ ok: false, code: 'self', error: 'e' }, null, 2)
    )
  })
})

describe('conversation link wiring across runtimes', () => {
  const read = (file: string) => readFileSync(new URL(`../../src/main/chat/${file}`, import.meta.url), 'utf8')

  it.each([
    'runner.ts',
    'claude-agent-sdk/runner.ts',
    'codex-subscription/runner.ts',
    'github-copilot/runner.ts',
    'cursor-subscription/runner.ts',
    'antigravity-subscription/runner.ts',
  ])('%s offers the tools only in its main, non-reviewer context', (file) => {
    const source = read(file)
    expect(source).toContain('enableConversationLinkTools(')
    expect(source).toMatch(/const conversationLink = args\.reviewerRuntime\s*\?\s*undefined/)
    expect(source).toContain('...(conversationLink ? { conversationLink } : {})')
  })

  it.each([
    'claude-agent-sdk/subagent-runner.ts',
    'claude-agent-sdk/task-runtime.ts',
    'github-copilot/subagent-runner.ts',
    'cursor-subscription/subagent-runner.ts',
    'antigravity-subscription/subagent-runner.ts',
    'maestro-worker-tools.ts',
  ])('%s never forwards them to children', (file) => {
    expect(read(file)).toContain('...PARENT_ONLY_CONVERSATION_TOOL_NAMES')
  })
})
