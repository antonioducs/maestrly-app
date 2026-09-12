import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { ExecutionContext } from '@maestrly/runner-core'
import { autonomousPolicy } from '../../src/main/chat/autonomous'
import { desktopExecutorSettingsSchema } from '../../src/main/platform/executor-settings'

const h = vi.hoisted(() => ({
  messages: [] as any[],
  records: [] as any[],
  insert: vi.fn(),
  prime: vi.fn(),
  finish: undefined as undefined | ((result: any) => void),
  cancel: vi.fn(),
  start: vi.fn(
    async (_input: any): Promise<any> => ({
      done: new Promise((resolve) => {
        h.finish = resolve
      }),
      cancel: () => {
        h.cancel()
        h.finish?.({ status: 'cancelled' })
      },
    })
  ),
  models: vi.fn(async () => [
    {
      providerId: 'codex-subscription:personal-slot',
      modelId: 'gpt-fixture',
      reasoningEfforts: ['high'],
      fastMode: true,
      providerLabel: 'Codex · Work account',
    },
    { providerId: 'other-private-account', modelId: 'other', reasoningEfforts: [], fastMode: false },
  ]),
}))
vi.mock('../../src/main/store', () => ({
  insertConversation: h.insert,
  getAppSetting: () => null,
  setAppSetting: vi.fn(),
}))
vi.mock('../../src/main/window-ipc', () => ({ broadcast: vi.fn() }))
vi.mock('../../src/main/chat/service', () => ({
  listChatRunnerCapabilities: h.models,
  startExecutorChatTurn: h.start,
  primeChatTurnSelection: h.prime,
}))
vi.mock('../../src/main/chat/chat-store', () => ({ listChatMessages: () => h.messages }))
vi.mock('../../src/main/chat/mcp', () => ({ listMcpServers: () => [{ id: 'private-mcp' }] }))
vi.mock('../../src/main/chat/maestro-config', () => ({
  getGlobalMaestroConfig: () => ({ config: { version: 1, strategy: 'balanced', pool: [] } }),
}))
vi.mock('../../src/main/platform/executor-settings', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  recordDesktopExecution: (record: any) => h.records.push(record),
}))
import { DesktopChatExecutor, DesktopModelCatalog } from '../../src/main/platform/desktop-executor'
const settings = desktopExecutorSettingsSchema.parse({ providerIds: ['codex-subscription:personal-slot'] })
const bindings = [
  {
    workspaceId: 'workspace',
    connectionId: 'connection',
    organizationId: 'org',
    projectId: 'project',
    boardId: 'board',
  },
]
async function setup() {
  const catalog = new DesktopModelCatalog(settings, async () => false)
  const capabilities = await catalog.read()
  const emit = vi.fn(async (_event: any) => {})
  const context = {
    envelope: {
      organizationId: 'org',
      projectId: 'project',
      runId: 'run',
      cardId: 'card',
      snapshot: {
        provider: 'maestrly',
        model: capabilities.models[0]!.model,
        title: 'Card task',
        description: 'Implement it',
        effort: 'high',
        fastMode: true,
      },
    },
    environment: { workspacePath: '/execution/workspace' },
    emit,
  } as unknown as ExecutionContext
  return { catalog, emit, context, executor: new DesktopChatExecutor(catalog, settings, bindings) }
}
beforeEach(() => {
  h.messages = []
  h.records = []
  h.insert.mockClear()
  h.prime.mockClear()
  h.start.mockClear()
  h.cancel.mockClear()
})
describe('desktop chat executor', () => {
  it('publishes only selected account models and runs a persistent native conversation', async () => {
    const { catalog, executor, context, emit } = await setup()
    const caps = await catalog.read()
    expect(caps.models).toHaveLength(1)
    expect(caps.models[0]).toMatchObject({ provider: 'maestrly', label: 'Codex · gpt-fixture' })
    expect(JSON.stringify(caps)).not.toMatch(/personal-slot|private-account/)
    await expect(catalog.chatModels()).resolves.toEqual([
      {
        id: caps.models[0]!.model,
        label: 'gpt-fixture',
        providerLabel: 'Codex · Work account',
        efforts: ['high'],
        fastMode: true,
      },
    ])
    const handle = await executor.start(context)
    const conversation = h.insert.mock.calls[0]![0]
    expect(conversation).toMatchObject({
      workspaceId: 'workspace',
      cwd: '/execution/workspace',
      experience: 'standard',
      uiPrefs: { chat: { tools: { app: true, mcpDisabled: ['private-mcp'] }, skillSelection: { kind: 'all' } } },
    })
    expect(h.prime).toHaveBeenCalledWith(conversation.id, {
      providerId: 'codex-subscription:personal-slot',
      modelId: 'gpt-fixture',
      reasoning: 'high',
      fastMode: true,
    })
    expect(autonomousPolicy(conversation.id)).toBeDefined()
    h.messages = [
      { id: 'u', role: 'user', createdAt: 1, parts: [{ type: 'text', text: 'Task' }] },
      {
        id: 'a',
        role: 'assistant',
        createdAt: 2,
        parts: [
          { type: 'text', text: 'Verified. sk-1234567890123456789012345' },
          { type: 'tool', toolName: 'read', state: { status: 'completed', output: 'private tool output' } },
        ],
      },
      { id: 'private', internal: true, parts: [] },
    ]
    autonomousPolicy(conversation.id)!.report = { state: 'succeeded', summary: 'Verified the task.' }
    h.finish!({ status: 'success', summaryText: 'Verified the task.' })
    const result = await handle.done
    expect(result.state).toBe('succeeded')
    expect(emit.mock.calls.filter((c) => c[0].type === 'maestrly.message')).toHaveLength(2)
    const transcript = Buffer.from(result.artifacts![0]!.bytes).toString()
    expect(transcript).toContain('[redacted]')
    expect(transcript).not.toMatch(/private tool|sk-123/)
    expect(h.records.at(-1)).toMatchObject({ state: 'succeeded', conversationId: conversation.id })
    expect(autonomousPolicy(conversation.id)).toBeUndefined()
  })
  it('cancels the actual chat turn and releases its unattended policy', async () => {
    const { executor, context } = await setup()
    const handle = await executor.start(context)
    const id = h.insert.mock.calls[0]![0].id
    await handle.cancel('operator pause')
    expect(h.cancel).toHaveBeenCalledOnce()
    expect((await handle.done).state).toBe('cancelled')
    expect(autonomousPolicy(id)).toBeUndefined()
  })
  it('does not report an empty model turn as a successful task', async () => {
    const { executor, context } = await setup()
    const handle = await executor.start(context)
    h.finish!({ status: 'success', summaryText: '' })
    expect(await handle.done).toMatchObject({
      state: 'failed',
      failure: 'The agent finished without an execution report.',
    })
  })
  it('records an explicit blocker as failure without an information request', async () => {
    const { executor, context } = await setup()
    const handle = await executor.start(context)
    autonomousPolicy(h.insert.mock.calls[0]![0].id)!.report = {
      state: 'failed',
      summary: 'A required deployment credential is missing.',
    }
    h.finish!({ status: 'success', summaryText: 'A required deployment credential is missing.' })
    expect(await handle.done).toMatchObject({
      state: 'failed',
      failure: 'A required deployment credential is missing.',
    })
  })
  it('refuses an unbound project before admitting a chat', async () => {
    const { executor, context } = await setup()
    context.envelope.projectId = 'another-project'
    await expect(executor.start(context)).rejects.toThrow(/not bound/)
    expect(h.start).not.toHaveBeenCalled()
  })
})
