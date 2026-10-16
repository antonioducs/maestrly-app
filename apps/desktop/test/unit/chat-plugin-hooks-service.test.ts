import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginHook } from '../../src/main/plugins/runtime'
import type { MessagePart } from '../../src/shared/chat'

/**
 * Session, prompt and Stop hooks run in startSend, the same way for every model: the BYOK runner stands in for all of
 * them here. Mocks follow the skill-invocation service tests.
 */

const h = vi.hoisted(() => ({
  getMainWebContents: vi.fn(),
  getConversation: vi.fn(),
  getConvUiPrefs: vi.fn(),
  patchConvUiPrefs: vi.fn(),
  getAppFlag: vi.fn(),
  getAppSetting: vi.fn(),
  updateConversationStatus: vi.fn(),
  upsertChatMessage: vi.fn(),
  listConversationContextMessages: vi.fn(() => [] as unknown[]),
  runChat: vi.fn(),
  hooks: [] as ActivePluginHook[],
}))

vi.mock('../../src/main/window-ipc', () => ({ getMainWebContents: h.getMainWebContents }))

vi.mock('../../src/main/store', () => ({
  getConversation: h.getConversation,
  getConvUiPrefs: h.getConvUiPrefs,
  getAppFlag: h.getAppFlag,
  getAppSetting: h.getAppSetting,
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(() => undefined), all: vi.fn(() => []), run: vi.fn() })),
  })),
  getLocale: vi.fn(() => 'en'),
  updateConversationStatus: h.updateConversationStatus,
  patchConvUiPrefs: h.patchConvUiPrefs,
  setAppFlag: vi.fn(),
  setAppSetting: vi.fn(),
}))

vi.mock('../../src/main/chat/catalog', () => ({
  PROVIDER_PRESETS: [],
  CODEX_SUBSCRIPTION_PROVIDER_ID: 'builtin_codex_subscription',
  getProvider: vi.fn(() => ({ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' })),
  getProviderKind: vi.fn(() => 'openai'),
  isClaudeSubscriptionProvider: vi.fn(() => false),
  isCursorSubscriptionProvider: vi.fn(() => false),
  isAntigravitySubscriptionProvider: vi.fn(() => false),
  isGrokSubscriptionProvider: vi.fn(() => false),
  isCodexSubscriptionProvider: vi.fn(() => false),
  isGitHubCopilotSubscriptionProvider: vi.fn(() => false),
  isSubscriptionProvider: vi.fn(() => false),
  isChatGptWebProvider: vi.fn(() => false),
  subscriptionAccountId: vi.fn(() => null),
  subscriptionProviderIdFor: vi.fn(() => 'builtin'),
  getSubscriptionAccount: vi.fn(() => undefined),
  addSubscriptionAccount: vi.fn(),
  renameSubscriptionAccount: vi.fn(),
  removeSubscriptionAccount: vi.fn(),
  listAvailableChatProviders: vi.fn(() => [{ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' }]),
  listProviders: vi.fn(() => [{ id: 'provider-1', name: 'Provider', baseURL: 'https://example.test/v1' }]),
}))

vi.mock('../../src/main/chat/credentials', () => ({
  apiKeyStorageMode: vi.fn(() => 'secure'),
  hasApiKey: vi.fn(() => true),
}))

vi.mock('../../src/main/chat/chat-store', () => ({
  getChatMessage: vi.fn(() => null),
  listUndeliveredReviewReports: vi.fn(() => []),
  chatHistoryStats: vi.fn(() => ({ lastUsage: null })),
  listChatMessages: vi.fn(() => []),
  listConversationContextMessages: h.listConversationContextMessages,
  upsertChatMessage: h.upsertChatMessage,
}))

vi.mock('../../src/main/chat/runner', () => ({
  normalizeAiUsage: vi.fn(() => ({ input: 0, output: 0, totalInput: 0, cacheRead: 0, cacheCreate: 0 })),
  runChat: h.runChat,
}))

vi.mock('../../src/main/chat/models', () => ({
  fetchModels: vi.fn(() => Promise.resolve(['model-1'])),
  fetchModelWindow: vi.fn(() => Promise.resolve(undefined)),
  invalidateModels: vi.fn(),
}))

vi.mock('../../src/main/chat/context-limits', () => ({
  getContextLimit: vi.fn(() => undefined),
  setContextLimit: vi.fn(),
  resolveContextWindow: vi.fn(() => undefined),
}))

vi.mock('../../src/main/chat/model-meta', () => ({
  catalogProviderForBaseURL: vi.fn(() => null),
  composeEffectiveMeta: vi.fn(() => null),
  getModelMeta: vi.fn(() => Promise.resolve(null)),
  getProviderModelMeta: vi.fn(() => Promise.resolve(null)),
  filterChatModels: vi.fn((models: string[]) => models),
}))

vi.mock('../../src/main/chat/provider', () => ({
  ChatConfigError: class ChatConfigError extends Error {},
  invalidateProvider: vi.fn(),
  resolveChatHarnessMetadata: vi.fn(() => ({ harnessProfile: 'legacy', capabilities: {} })),
  resolveLanguageModel: vi.fn(),
}))

vi.mock('../../src/main/chat/mcp', () => ({
  listMcpServers: vi.fn(() => []),
  listRuntimeMcpServers: vi.fn(() => []),
}))

vi.mock('../../src/main/plugins/runtime', async (original) => ({
  ...(await original<typeof import('../../src/main/plugins/runtime')>()),
  listPluginHooks: () => h.hooks,
}))

import { registerChatIpc } from '../../src/main/chat/service'
import { clearAllChatSubscriptions, subscribeChatStream } from '../../src/main/chat/stream-subscribers'
import { __resetCwdActivityForTests } from '../../src/main/cwd-activity-coordinator'

const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() }
let cwd = ''
let n = 0

/** A synthetic hook script: reads its JSON input from stdin and runs `body` with it as `input`. */
function hook(event: ActivePluginHook['spec']['event'], body: string): ActivePluginHook {
  const file = path.join(cwd, `hook-${++n}.mjs`)
  writeFileSync(
    file,
    `let raw = ''\nprocess.stdin.on('data', (c) => (raw += c))\nprocess.stdin.on('end', () => { const input = JSON.parse(raw); ${body} })\n`
  )
  const command = `node ${JSON.stringify(file)}`
  return {
    pluginKey: 'guard@market',
    pluginName: 'Guard',
    spec: { event, matcher: null, command, timeoutSec: 10, source: 'hooks/hooks.json' },
    command,
    env: {},
  }
}

const streamed = () => wc.send.mock.calls.map(([, payload]) => payload as { kind?: string })
const doneCount = () => streamed().filter((event) => event.kind === 'done').length

/** Sends a prompt and, once admitted, waits for its turn (and any continuation) to end. */
async function send(text: string): Promise<{ ok: boolean; error?: string }> {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  registerChatIpc({ mhandle: (channel, fn) => void handlers.set(channel, fn), mon: vi.fn(), emitStatus: vi.fn() })
  const before = doneCount()
  const result = (await handlers.get('chat:send')?.({ sender: wc }, { conversationId: 'conv-hooks', text })) as {
    ok: boolean
    error?: string
  }
  if (result.ok) await vi.waitFor(() => expect(doneCount()).toBe(before + 1), { timeout: 10_000 })
  return result
}

const userMessages = () =>
  h.upsertChatMessage.mock.calls
    .map(([message]) => message as { role: string; internal?: boolean; parts: MessagePart[] })
    .filter((message) => message.role === 'user')

const hookParts = (parts: MessagePart[]) =>
  parts.filter(
    (part): part is Extract<MessagePart, { type: 'file' }> =>
      part.type === 'file' && part.name === 'maestrly-hook-context'
  )

describe('plugin session, prompt and Stop hooks in a Maestrly turn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetCwdActivityForTests()
    cwd = mkdtempSync(path.join(os.tmpdir(), 'hooks-service-'))
    h.hooks = []
    h.getMainWebContents.mockReturnValue(wc)
    h.getConversation.mockReturnValue({ id: 'conv-hooks', cli: 'chat', cwd, workspaceId: 'workspace-1' })
    h.getConvUiPrefs.mockReturnValue({ chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent' } })
    h.getAppFlag.mockImplementation((_key: string, fallback: boolean) => fallback)
    h.getAppSetting.mockReturnValue(null)
    h.listConversationContextMessages.mockReturnValue([])
    h.runChat.mockResolvedValue({ planSubmitted: false })
    subscribeChatStream(wc as never, 'conv-hooks')
  })
  afterEach(() => {
    clearAllChatSubscriptions()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('adds session and prompt context as hidden parts and records the session once the message is stored', async () => {
    h.hooks = [
      hook('SessionStart', `process.stdout.write('SESSION ' + input.source)`),
      hook('UserPromptSubmit', `process.stdout.write('PROMPT ' + input.prompt)`),
    ]

    expect(await send('fix the build')).toEqual({ ok: true })

    const [message] = userMessages()
    expect(message.parts[0]).toMatchObject({ type: 'text', text: 'fix the build' })
    expect(hookParts(message.parts).map((part) => ({ hidden: part.hidden, data: part.data }))).toEqual([
      { hidden: true, data: '<maestrly-hook event="SessionStart">\nSESSION startup\n</maestrly-hook>' },
      { hidden: true, data: '<maestrly-hook event="UserPromptSubmit">\nPROMPT fix the build\n</maestrly-hook>' },
    ])
    expect(h.patchConvUiPrefs).toHaveBeenCalledWith('conv-hooks', { hookSession: { boundary: '' } })
  })

  it('does not start the session again until a clear or a compaction', async () => {
    h.hooks = [hook('SessionStart', `process.stdout.write('SESSION ' + input.source)`)]
    const compacted = [
      { role: 'assistant', parts: [{ type: 'compaction', id: 'marker-2', text: 'summary', strategy: 'summary' }] },
    ]

    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent' },
      hookSession: { boundary: '' },
    })
    await send('again')
    expect(hookParts(userMessages()[0].parts)).toEqual([])

    h.upsertChatMessage.mockClear()
    h.listConversationContextMessages.mockReturnValue(compacted)
    await send('after compacting')
    expect(hookParts(userMessages()[0].parts)[0].data).toContain('SESSION compact')
    expect(h.patchConvUiPrefs).toHaveBeenCalledWith('conv-hooks', { hookSession: { boundary: 'marker-2' } })

    h.upsertChatMessage.mockClear()
    h.listConversationContextMessages.mockReturnValue([])
    h.getConvUiPrefs.mockReturnValue({
      chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'agent' },
      hookSession: { cleared: true },
    })
    await send('after clearing')
    expect(hookParts(userMessages()[0].parts)[0].data).toContain('SESSION clear')
  })

  it('refuses a prompt a hook blocks: nothing is stored and no model runs', async () => {
    h.hooks = [
      hook('SessionStart', `process.stdout.write('SESSION')`),
      hook(
        'UserPromptSubmit',
        `process.stdout.write(JSON.stringify({ decision: 'block', reason: 'no secrets here' }))`
      ),
    ]

    expect(await send('my password is hunter2')).toEqual({ ok: false, error: 'blocked-by-hook: no secrets here' })
    expect(userMessages()).toEqual([])
    expect(h.runChat).not.toHaveBeenCalled()
    // The session did not start: its context never reached a stored message.
    expect(h.patchConvUiPrefs).not.toHaveBeenCalledWith(
      'conv-hooks',
      expect.objectContaining({ hookSession: expect.anything() })
    )
  })

  it('keeps the agent going when a Stop hook asks for more, as a hidden prompt', async () => {
    h.hooks = [
      hook(
        'Stop',
        `process.stdout.write(input.stop_hook_active ? '' : JSON.stringify({ decision: 'block', reason: 'run the tests' }))`
      ),
    ]

    expect(await send('implement it')).toEqual({ ok: true })

    // One turn and its continuation end with a single 'done'.
    expect(h.runChat).toHaveBeenCalledTimes(2)
    expect(doneCount()).toBe(1)
    const [, continuation] = userMessages()
    expect(continuation.internal).toBe(true)
    expect(continuation.parts[0]).toMatchObject({
      type: 'text',
      text: 'Stop hook feedback from the Guard plugin:\nrun the tests',
    })
    expect(streamed()).toContainEqual({
      kind: 'hook-notice',
      plugin: 'Guard',
      event: 'Stop',
      text: 'run the tests',
      level: 'info',
    })
  })

  it('stops after eight Stop hook continuations in a row and says so', async () => {
    h.hooks = [hook('Stop', `process.stdout.write(JSON.stringify({ decision: 'block', reason: 'once more' }))`)]

    expect(await send('loop')).toEqual({ ok: true })

    expect(h.runChat).toHaveBeenCalledTimes(9)
    expect(userMessages().filter((message) => message.internal)).toHaveLength(8)
    const notices = streamed().filter((event) => event.kind === 'hook-notice') as Array<{ level: string; text: string }>
    expect(notices.map((notice) => notice.level)).toEqual([...Array(8).fill('info'), 'error'])
    expect(notices.at(-1)?.text).toContain('8 times in a row')
  })

  it('runs no hooks outside Agent and Design', async () => {
    h.hooks = [
      hook('UserPromptSubmit', `process.stdout.write('PROMPT')`),
      hook('Stop', `process.stdout.write(JSON.stringify({ decision: 'block', reason: 'again' }))`),
    ]
    h.getConvUiPrefs.mockReturnValue({ chat: { providerId: 'provider-1', modelId: 'model-1', mode: 'ask' } })

    expect(await send('what is this?')).toEqual({ ok: true })
    expect(hookParts(userMessages()[0].parts)).toEqual([])
    expect(h.runChat).toHaveBeenCalledTimes(1)
  })
})
