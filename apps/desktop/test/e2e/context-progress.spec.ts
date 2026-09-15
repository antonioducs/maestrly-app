import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ChatCompactionProgress,
  ChatContextSnapshot,
  ChatMessage,
  ChatModelRef,
  ChatStreamEvent,
} from '../../src/shared/chat'
import { removeTempDirEventually } from './helpers/temp-cleanup'

test.use({ actionTimeout: 15_000, trace: 'retain-on-failure' })

const mainEntry = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))

interface Api {
  setOnboardingDone(done: boolean): Promise<void>
  addWorkspace(directory: string): Promise<{ id: string }>
  createConversation(input: {
    workspaceId: string
    branch: string
    isNewBranch: boolean
    mode: 'worktree'
    experience: 'standard'
    name: string
  }): Promise<{ id: string }>
}

declare const window: { api: Api }

interface StubState {
  messages: ChatMessage[]
  historyReads: number
  statsReads: number
}

let app: ElectronApplication | undefined
let root: string

test.beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-context-progress-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
  await removeTempDirEventually(root)
})

async function openChat(model: ChatModelRef) {
  const repository = path.join(root, 'context-fixture')
  mkdirSync(repository)
  const git = (args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' })
  git(['init', '-q', '-b', 'main'])
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '--allow-empty', '-m', 'fixture'])
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: `context-progress-${Date.now()}`,
      AGENTS_USERDATA: path.join(root, 'profile'),
      AGENTS_LOCALE: 'en',
      ELECTRON_RENDERER_URL: '',
    },
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => typeof window.api !== 'undefined')
  await page.evaluate(() => window.api.setOnboardingDone(true))

  await app.evaluate(({ BrowserWindow, ipcMain }, selection) => {
    const state: StubState = { messages: [], historyReads: 0, statsReads: 0 }
    ;(globalThis as typeof globalThis & { __contextProgress: StubState }).__contextProgress = state
    const replace = (channel: string, handler: Parameters<typeof ipcMain.handle>[1]) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    const family = selection.providerId === 'builtin_claude_subscription' ? 'claude' : 'codex'
    replace('chat:config', () => ({
      providers: [
        {
          id: selection.providerId,
          name: `${family} subscription`,
          kind: `${family}-subscription`,
          baseURL: `${family}://subscription`,
          apiKeyPresent: false,
          builtIn: true,
          connected: true,
        },
      ],
      presets: [],
      mcpServers: [],
      appToolsEnabled: false,
      imageGenEnabled: false,
      bashFiltersEnabled: true,
      openAIHarnessEnabled: true,
      storageMode: 'secure',
      defaultSelection: selection,
      defaultReasoning: 'off',
      imageInterpreter: null,
      subscriptionFailover: { supportedKinds: ['codex-subscription', 'claude-subscription'], routes: [] },
    }))
    replace('chat:get-selection', () => selection)
    replace('chat:models', () => [selection.modelId])
    replace('chat:model-meta', () => ({ contextWindow: 200_000, contextLimitEditable: false }))
    replace('chat:history:page', () => {
      state.historyReads++
      return { messages: state.messages, hasMore: false, earliestSeq: state.messages.length ? 1 : null }
    })
    // Deliberately differs from every measured sample: refreshing billing/projection must not replace it.
    replace('chat:history:stats', () => {
      state.statsReads++
      return {
        lastUsage: null,
        lastModel: null,
        perModel: [],
        modelIds: [],
        bytesSaved: 0,
        contextProjection: {
          usedTokens: 4_000,
          modelContextWindow: 200_000,
          quality: 'estimated',
          source: 'portable-transcript',
        },
      }
    })
    // Synthetic events are the only source of turns; an accidental send cannot reach a provider.
    replace('chat:send', () => {
      throw new Error('Unexpected provider turn in context-progress fixture')
    })
    for (const provider of ['codex', 'claude', 'github-copilot', 'grok']) {
      replace(`chat:${provider}-subscription:status`, () => ({ state: 'signed-out', authenticated: false }))
    }
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000)
  }, model)

  const conversation = await page.evaluate(async (directory) => {
    const workspace = await window.api.addWorkspace(directory)
    return window.api.createConversation({
      workspaceId: workspace.id,
      branch: 'context-progress',
      isNewBranch: true,
      mode: 'worktree',
      experience: 'standard',
      name: 'Context progress fixture',
    })
  }, repository)
  await app.evaluate((_electron, conversationId) => {
    // message-start inherits conversationId from the saved user message, as in a real submitted turn.
    ;(globalThis as typeof globalThis & { __contextProgress: StubState }).__contextProgress.messages = [
      {
        id: 'context-user',
        conversationId,
        role: 'user',
        parts: [{ type: 'text', id: 'request', text: 'Exercise synthetic context progress.' }],
        createdAt: Date.now(),
      },
    ]
  }, conversation.id)
  await page.reload()
  await page.locator('li.conv-item:visible').filter({ hasText: 'Context progress fixture' }).click()
  await expect(page.getByRole('button', { name: '~4.0k/200.0k 2.0%', exact: true })).toBeVisible()
  return { page, conversationId: conversation.id }
}

async function emit(conversationId: string, ...events: Array<ChatStreamEvent | { kind: 'done' }>) {
  await app!.evaluate(({ BrowserWindow }, serialized) => {
    const input = JSON.parse(serialized) as {
      conversationId: string
      events: Array<ChatStreamEvent | { kind: 'done' }>
    }
    const main = BrowserWindow.getAllWindows()[0]
    for (const event of input.events) main.webContents.send(`chat:delta:${input.conversationId}`, event)
  }, JSON.stringify({ conversationId, events }))
}

async function readStub() {
  return app!.evaluate(() => {
    const { historyReads, statsReads } = (globalThis as typeof globalThis & { __contextProgress: StubState })
      .__contextProgress
    return { historyReads, statsReads }
  })
}

for (const [label, model] of [
  ['Astra', { providerId: 'builtin_codex_subscription', modelId: 'gpt-6' }],
  ['Claude', { providerId: 'builtin_claude_subscription', modelId: 'claude-opus-4-6' }],
] as const) {
  test(`${label}: live context, compaction stages and retained failure measurement after reload`, async () => {
    const { page, conversationId } = await openChat(model)
    const messageId = 'context-assistant'
    const createdAt = Date.now()
    let sequence = 0
    let timestamp = createdAt
    const sample = (usedTokens: number): ChatContextSnapshot => ({
      model,
      usedTokens,
      modelContextWindow: 200_000,
      quality: 'measured',
      observedAt: ++timestamp,
      sequence: ++sequence,
    })
    const progress = (patch: Partial<ChatCompactionProgress>): ChatCompactionProgress => ({
      id: 'compact-success',
      status: 'running',
      phase: 'chunk',
      completed: 0,
      total: 3,
      beforeTokens: 100_000,
      ...patch,
      updatedAt: ++timestamp,
    })
    const meter = page.locator('button[title^="Last measured context:"]')
    const status = page.getByRole('status').filter({ hasText: /Compacting|Context compact/ })
    const stop = page.getByRole('button', { name: 'Stop', exact: true })
    await emit(
      conversationId,
      { kind: 'message-start', messageId, model, createdAt, responseStartedAt: createdAt },
      { kind: 'text-start', messageId, partId: 'reply' },
      { kind: 'text-delta', messageId, partId: 'reply', delta: 'Synthetic context progress response.' }
    )
    await expect(page.getByText('Synthetic context progress response.', { exact: true })).toBeVisible()
    await expect(stop).toBeVisible()
    const beforeSamples = (await readStub()).statsReads

    for (const [usedTokens, expected] of [
      [20_000, '20.0k/200.0k 10.0%'],
      [60_000, '60.0k/200.0k 30.0%'],
      [100_000, '100.0k/200.0k 50.0%'],
    ] as const) {
      await emit(conversationId, { kind: 'context-usage', messageId, snapshot: sample(usedTokens) })
      await expect(meter).toHaveText(expected)
      await expect(stop).toBeVisible()
      expect((await readStub()).statsReads).toBe(beforeSamples)
    }

    await emit(conversationId, { kind: 'compaction-progress', messageId, progress: progress({}) })
    await expect(status).toHaveText('Compacting — step 1/3')
    await emit(conversationId, { kind: 'compaction-progress', messageId, progress: progress({ completed: 1 }) })
    await expect(status).toHaveText('Compacting — step 2/3')
    await emit(conversationId, {
      kind: 'compaction-progress',
      messageId,
      progress: progress({ completed: 1, status: 'retrying', attempt: 2 }),
    })
    await expect(status).toHaveText('Compacting — step 2/3 · Retrying this stage (attempt 2)')
    await expect(meter).toHaveText('100.0k/200.0k 50.0%')
    await emit(conversationId, {
      kind: 'compaction-progress',
      messageId,
      progress: progress({ phase: 'consolidate', completed: 3 }),
    })
    await expect(status).toHaveText('Compacting — consolidating summaries')
    await emit(conversationId, {
      kind: 'compaction-progress',
      messageId,
      progress: progress({
        status: 'completed',
        phase: 'consolidate',
        completed: 3,
        afterTokens: 24_000,
        afterQuality: 'estimated',
      }),
    })
    await expect(status).toHaveText('Context compacted')
    await expect(page.getByText('100.0k → ~24.0k tokens', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '~24.0k/200.0k 12.0%', exact: true })).toBeVisible()

    await emit(conversationId, { kind: 'context-usage', messageId, snapshot: sample(22_000) })
    await expect(meter).toHaveText('22.0k/200.0k 11.0%')
    await expect(stop).toBeVisible()
    expect((await readStub()).statsReads).toBe(beforeSamples)

    const retainedSnapshot = sample(70_000)
    await emit(conversationId, { kind: 'context-usage', messageId, snapshot: retainedSnapshot })
    await expect(meter).toHaveText('70.0k/200.0k 35.0%')
    await emit(conversationId, {
      kind: 'compaction-progress',
      messageId,
      progress: progress({ id: 'compact-failure', phase: 'native', beforeTokens: 70_000 }),
    })
    await expect(status).toHaveText('Compacting')
    const failedProgress = progress({
      id: 'compact-failure',
      phase: 'native',
      beforeTokens: 70_000,
      status: 'failed',
      error: 'stage timed out',
    })
    await emit(conversationId, { kind: 'compaction-progress', messageId, progress: failedProgress })
    await expect(status).toHaveText('Context compaction failed: stage timed out')
    await expect(meter).toHaveText('70.0k/200.0k 35.0%')
    await expect(stop).toBeVisible()

    await emit(conversationId, {
      kind: 'error',
      messageId,
      message: 'Provider turn interrupted after compaction failure',
    })
    await expect(stop).toHaveCount(0)
    await expect(status).toHaveText('Context compaction failed: stage timed out')
    await expect(meter).toHaveText('70.0k/200.0k 35.0%')
    const beforeDone = (await readStub()).statsReads
    await emit(conversationId, { kind: 'done' })
    await expect.poll(async () => (await readStub()).statsReads).toBeGreaterThan(beforeDone)
    await expect(meter).toHaveText('70.0k/200.0k 35.0%')
    await expect(status).toHaveText('Context compaction failed: stage timed out')

    // Hydrate a saved transcript through the real preload and ChatView after destroying renderer state.
    // Main-process metadata persistence is covered separately by store/runner tests.
    const saved: ChatMessage = {
      id: messageId,
      conversationId,
      role: 'assistant',
      model,
      createdAt,
      parts: [{ type: 'text', id: 'reply', text: 'Synthetic context progress response.' }],
      contextSnapshot: retainedSnapshot,
      compactionProgress: failedProgress,
      finishReason: 'error',
      error: 'Provider turn interrupted after compaction failure',
    }
    await app!.evaluate(
      (_electron, serialized) => {
        ;(globalThis as typeof globalThis & { __contextProgress: StubState }).__contextProgress.messages =
          JSON.parse(serialized)
      },
      JSON.stringify([saved])
    )
    const beforeReload = (await readStub()).historyReads
    await page.reload()
    await page.locator('li.conv-item:visible').filter({ hasText: 'Context progress fixture' }).click()
    await expect.poll(async () => (await readStub()).historyReads).toBeGreaterThan(beforeReload)
    await expect(meter).toHaveText('70.0k/200.0k 35.0%')
    await expect(meter).toHaveAttribute('title', /Last measured context: 70\.0k tokens/)
    await expect(status).toHaveText('Context compaction failed: stage timed out')
    await expect(stop).toHaveCount(0)
  })
}
