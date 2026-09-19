import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatConfig, ChatMessage, ChatModelRef, ChatStreamEvent } from '../../src/shared/chat'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const mainEntry = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))
const model = { providerId: 'builtin_cursor_subscription', modelId: 'cursor-discovered-e2e' }
const prompt = 'Inspect the synthetic Cursor repository.'
const reply = 'Cursor is inspecting the fixture.'

declare const window: {
  api: {
    setOnboardingDone(done: boolean): Promise<void>
    chatConfig(): Promise<ChatConfig>
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
}

interface FixtureState {
  connected: boolean
  selections: Record<string, ChatModelRef>
  messages: ChatMessage[]
  sends: Array<{ conversationId: string; text: string; selection: ChatModelRef }>
  stops: string[]
  modelReads: string[]
  historyReads: number
  logins: number
  logouts: number
}

let app: ElectronApplication | undefined
let root: string

test.use({ actionTimeout: 15_000, trace: 'retain-on-failure' })
test.beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-cursor-chat-'))
})
test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
  await removeTempDirEventually(root)
})

// Provider state lives in main so reload exercises the real preload and renderer hydration.
// This deliberately does not claim to test SDK transport or durable provider session storage.
test('Cursor: discover a model, stream tools, cancel and restore the conversation after reload', async () => {
  const repository = path.join(root, 'cursor-fixture')
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
      AGENTS_INSTANCE: `cursor-chat-${Date.now()}`,
      AGENTS_USERDATA: path.join(root, 'profile'),
      AGENTS_LOCALE: 'en',
      ELECTRON_RENDERER_URL: '',
    },
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => typeof window.api !== 'undefined')
  await page.evaluate(() => window.api.setOnboardingDone(true))
  const config = await page.evaluate(() => window.api.chatConfig())
  await app.evaluate(
    ({ BrowserWindow, ipcMain }, { config, model, reply }) => {
      const state: FixtureState = {
        connected: false,
        selections: {},
        messages: [],
        sends: [],
        stops: [],
        modelReads: [],
        historyReads: 0,
        logins: 0,
        logouts: 0,
      }
      ;(globalThis as typeof globalThis & { __cursorChat: FixtureState }).__cursorChat = state
      const replace = (channel: string, handler: Parameters<typeof ipcMain.handle>[1]) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
      const send = (conversationId: string, event: ChatStreamEvent | { kind: 'done' }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.send(`chat:delta:${conversationId}`, event)
      const status = () => ({
        state: state.connected ? 'signed-in' : 'signed-out',
        authenticated: state.connected,
        available: true,
        accountId: null,
        ...(state.connected ? { email: 'cursor@example.test' } : {}),
      })
      replace('chat:config', () => ({
        ...config,
        providers: [
          {
            id: model.providerId,
            name: 'Cursor',
            kind: 'cursor-subscription',
            baseURL: 'cursor://subscription',
            builtIn: true,
            apiKeyPresent: false,
            connected: state.connected,
          },
        ],
        defaultSelection: null,
      }))
      for (const provider of ['codex', 'claude', 'github-copilot', 'grok']) {
        replace(`chat:${provider}-subscription:status`, () => ({ state: 'signed-out', authenticated: false }))
      }
      replace('chat:cursor-subscription:status', status)
      for (const action of ['login', 'logout'] as const) {
        replace(`chat:cursor-subscription:${action}`, () => {
          state.connected = action === 'login'
          if (action === 'login') state.logins++
          else state.logouts++
          const next = status()
          BrowserWindow.getAllWindows()[0]?.webContents.send('chat:cursor-subscription:auth-changed', next)
          return { ok: true, status: next }
        })
      }
      replace('chat:models', (_event, providerId: string) => {
        state.modelReads.push(providerId)
        return state.connected && providerId === model.providerId ? ['cursor-other-e2e', model.modelId] : []
      })
      replace('chat:model-meta', () => ({ contextWindow: 200_000, contextLimitEditable: false }))
      replace('chat:get-selection', (_event, id: string) => state.selections[id] ?? null)
      replace('chat:set-selection', (_event, id: string, selection: ChatModelRef) => {
        if (!state.connected || selection.providerId !== model.providerId || selection.modelId !== model.modelId) {
          throw new Error('Unexpected Cursor model selection')
        }
        state.selections[id] = selection
        return { ok: true }
      })
      replace('chat:history:page', () => {
        state.historyReads++
        return { messages: state.messages, hasMore: false, earliestSeq: state.messages.length ? 1 : null }
      })
      replace('chat:history:stats', () => ({
        lastUsage: null,
        lastModel: null,
        perModel: [],
        modelIds: [],
        bytesSaved: 0,
      }))
      // Intercept every send: even a regression in selection can never invoke a real provider.
      replace('chat:send', (_event, input: { conversationId: string; text: string }) => {
        const selection = state.selections[input.conversationId]
        if (!state.connected || !selection) throw new Error('Cursor send without connected model')
        state.sends.push({ ...input, selection })
        const createdAt = Date.now()
        state.messages = [
          {
            id: 'cursor-user',
            conversationId: input.conversationId,
            role: 'user',
            createdAt,
            parts: [{ type: 'text', id: 'request', text: input.text }],
          },
          {
            id: 'cursor-assistant',
            conversationId: input.conversationId,
            role: 'assistant',
            createdAt,
            model: selection,
            parts: [{ type: 'text', id: 'reply', text: reply }],
          },
        ]
        send(input.conversationId, {
          kind: 'message-start',
          messageId: 'cursor-assistant',
          model: selection,
          createdAt,
          responseStartedAt: createdAt,
        })
        send(input.conversationId, { kind: 'text-start', messageId: 'cursor-assistant', partId: 'reply' })
        send(input.conversationId, { kind: 'text-delta', messageId: 'cursor-assistant', partId: 'reply', delta: reply })
        return { ok: true }
      })
      ipcMain.removeAllListeners('chat:stop')
      ipcMain.on('chat:stop', (_event, conversationId: string) => {
        state.stops.push(conversationId)
        const assistant = state.messages.find((message) => message.role === 'assistant')
        if (assistant) assistant.finishReason = 'aborted'
        send(conversationId, { kind: 'aborted', messageId: 'cursor-assistant', responseDurationMs: 100 })
        send(conversationId, { kind: 'done' })
      })
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000)
    },
    { config, model, reply }
  )
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const card = page.locator('[data-subscription-provider="cursor-subscription"][data-subscription-account="default"]')
  await card.getByRole('button', { name: 'Sign in with Cursor', exact: true }).click()
  await expect(card.getByText('cursor@example.test', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  const conversation = await page.evaluate(async (directory) => {
    const workspace = await window.api.addWorkspace(directory)
    return window.api.createConversation({
      workspaceId: workspace.id,
      branch: 'cursor-chat',
      isNewBranch: true,
      mode: 'worktree',
      experience: 'standard',
      name: 'Cursor chat fixture',
    })
  }, repository)
  await page.reload()
  const conversationRow = page.locator('li.conv-item:visible').filter({ hasText: 'Cursor chat fixture' })
  await conversationRow.click()
  const modelButton = page.locator('button[aria-keyshortcuts$="Shift+M"]')
  await modelButton.click()
  await page.getByPlaceholder('Search models…').fill(model.modelId)
  await page.getByRole('button', { name: `${model.modelId} Cursor`, exact: true }).click()
  await expect(modelButton).toContainText(model.modelId)
  await expect
    .poll(() =>
      app!.evaluate(() => (globalThis as typeof globalThis & { __cursorChat: FixtureState }).__cursorChat.modelReads)
    )
    .toContain(model.providerId)
  const composer = page.locator('[contenteditable="true"][role="textbox"]')
  await composer.fill(prompt)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText(prompt, { exact: true })).toBeVisible()
  await expect(page.getByText(reply, { exact: true })).toBeVisible()
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible()
  await expect
    .poll(() =>
      app!.evaluate(() => (globalThis as typeof globalThis & { __cursorChat: FixtureState }).__cursorChat.sends)
    )
    .toEqual([expect.objectContaining({ conversationId: conversation.id, text: prompt, selection: model })])

  await app.evaluate(({ BrowserWindow }, conversationId) => {
    const tool = {
      type: 'tool' as const,
      id: 'cursor-tool',
      toolCallId: 'cursor-tool',
      toolName: 'cursor_fixture_inspect',
      input: { path: 'README.md' },
      state: { status: 'completed' as const, output: 'Synthetic repository inspected.' },
    }
    ;(globalThis as typeof globalThis & { __cursorChat: FixtureState }).__cursorChat.messages[1].parts.push(tool)
    const events: ChatStreamEvent[] = [
      { kind: 'tool-input-start', messageId: 'cursor-assistant', toolCallId: tool.id, toolName: tool.toolName },
      {
        kind: 'tool-call',
        messageId: 'cursor-assistant',
        toolCallId: tool.id,
        toolName: tool.toolName,
        input: tool.input,
      },
      { kind: 'tool-state', messageId: 'cursor-assistant', toolCallId: tool.id, state: tool.state },
    ]
    for (const event of events)
      BrowserWindow.getAllWindows()[0]?.webContents.send(`chat:delta:${conversationId}`, event)
  }, conversation.id)
  await page.getByRole('button', { name: /cursor_fixture_inspect/ }).click()
  await expect(page.getByText('Synthetic repository inspected.', { exact: true })).toBeVisible()
  await expect(stop).toBeVisible()
  await stop.click()
  await expect
    .poll(() =>
      app!.evaluate(() => (globalThis as typeof globalThis & { __cursorChat: FixtureState }).__cursorChat.stops)
    )
    .toEqual([conversation.id])
  await expect(stop).toHaveCount(0)
  await expect(page.getByText(reply, { exact: true })).toBeVisible()

  const historyReads = await app.evaluate(
    () => (globalThis as typeof globalThis & { __cursorChat: FixtureState }).__cursorChat.historyReads
  )
  await page.reload()
  await conversationRow.click()
  await expect
    .poll(() =>
      app!.evaluate(() => (globalThis as typeof globalThis & { __cursorChat: FixtureState }).__cursorChat.historyReads)
    )
    .toBeGreaterThan(historyReads)
  await expect(modelButton).toContainText(model.modelId)
  await expect(page.getByText(prompt, { exact: true })).toBeVisible()
  await expect(page.getByText(reply, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /cursor_fixture_inspect/ }).click()
  await expect(page.getByText('Synthetic repository inspected.', { exact: true })).toBeVisible()
  await expect(stop).toHaveCount(0)
  await expect(composer).toBeEnabled()
  await expect(composer).toHaveText('')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(card.getByText('cursor@example.test', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible()
  const finalState = await app.evaluate(
    () => (globalThis as typeof globalThis & { __cursorChat: FixtureState }).__cursorChat
  )
  expect(finalState.logins).toBe(1)
  expect(finalState.logouts).toBe(1)
  expect(finalState.connected).toBe(false)
  expect(finalState.sends).toHaveLength(1)
  expect(finalState.messages[1].finishReason).toBe('aborted')
})
