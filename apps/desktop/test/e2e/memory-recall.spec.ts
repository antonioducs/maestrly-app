import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import type { Api } from '../../src/preload'
import { removeTempDirEventually } from './helpers/temp-cleanup'

declare const window: Window & { api: Api }

const desktop = fileURLToPath(new URL('../..', import.meta.url))
interface ModelRequest {
  messages: Array<{ role: string; content: unknown }>
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
}

function lastUser(request: ModelRequest): string {
  return contentText([...request.messages].reverse().find((message) => message.role === 'user')?.content)
}

test('recalls relevant memories, opens their source, and honors automatic recall settings', async () => {
  test.setTimeout(240_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-memory-recall-'))
  const repository = path.join(root, 'repo')
  mkdirSync(repository)
  const git = (args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' })
  git(['init', '-q', '-b', 'main'])
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '--allow-empty', '-m', 'fixture'])

  const requests: ModelRequest[] = []
  let app: ElectronApplication | undefined
  const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'memory-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'memory-primary',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    )
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'memory-primary' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body) as ModelRequest
    requests.push(input)
    res.setHeader('content-type', 'text/event-stream')
    chunk(res, {
      role: 'assistant',
      content: lastUser(input).includes('BLUEBIRD') ? 'E2E-RECALLED BLUEBIRD' : 'E2E-OK',
    })
    chunk(res, {}, 'stop')
    res.end('data: [DONE]\n\n')
  })

  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `memory-${Date.now().toString(36)}`,
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api))
    await page.evaluate(() => window.api.setOnboardingDone(true))
    const provider = await page.evaluate(
      (baseURL) =>
        window.api.chatAddProvider({
          name: 'Memory fixture',
          kind: 'openai',
          key: 'fixture-key',
          baseURL,
        }),
      `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`
    )
    expect(provider.ok).toBe(true)
    expect(provider.id).toBeTruthy()
    const selection = { providerId: provider.id!, modelId: 'memory-primary' }
    await page.evaluate((selection) => window.api.chatSetDefault(selection), selection)
    const workspace = await page.evaluate((directory) => window.api.addWorkspace(directory), repository)
    const conversation = await page.evaluate(
      (workspaceId) =>
        window.api.createConversation({
          workspaceId,
          branch: 'feat/recall',
          isNewBranch: true,
          mode: 'worktree',
          experience: 'standard',
          name: 'Memory recall',
        }),
      workspace.id
    )
    await page.evaluate(({ id, selection }) => window.api.chatSetSelection(id, selection), {
      id: conversation.id,
      selection,
    })
    await page.evaluate(async (workspaceId) => {
      await window.api.createMemory({
        workspaceId,
        title: 'Launch code',
        content: 'The e2e launch code is BLUEBIRD.',
        type: 'reference',
        source: 'user',
      })
      await window.api.createMemory({
        workspaceId,
        title: 'Answer style',
        content: 'Answer in one line.',
        type: 'preference',
        pinned: true,
        source: 'user',
      })
      await window.api.createMemory({
        workspaceId,
        title: 'Deploy window',
        content: 'The e2e deploy window is Tuesday at 14:00 UTC.',
        type: 'reference',
        source: 'user',
      })
    }, workspace.id)
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api))
    const openConversation = () => page.locator('li.conv-item', { hasText: 'Memory recall' }).first().click()
    await openConversation()
    const chips = page.getByRole('button', { name: '🧠 1 memory recalled', exact: true })
    const send = async (text: string) => {
      const before = requests.length
      await page.locator('.chat-input[contenteditable="true"]:visible').fill(text)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect.poll(() => requests.length, { timeout: 60_000 }).toBeGreaterThan(before)
      await expect
        .poll(
          () => page.evaluate((id) => window.api.chatRuntime(id), conversation.id).then((runtime) => runtime.streaming),
          { timeout: 60_000 }
        )
        .toBe(false)
      return requests.at(-1)!
    }

    const first = await send('What is the launch code for the e2e check?')
    const system = first.messages
      .filter((message) => message.role === 'system')
      .map((message) => contentText(message.content))
      .join('\n')
    for (const expected of ['# Memory', '## Pinned memories', 'Answer style', '## Memory catalog']) {
      expect(system).toContain(expected)
    }
    expect(lastUser(first)).toContain('<maestrly-memory kind="recall">')
    expect(lastUser(first)).toContain('BLUEBIRD')
    await expect(page.getByText('E2E-RECALLED BLUEBIRD', { exact: true })).toBeVisible()
    await expect(chips).toHaveCount(1)
    await expect(chips).toBeVisible()
    await expect(
      page.locator('[data-msg-id]', { hasText: 'What is the launch code for the e2e check?' }).getByRole('button', {
        name: '🧠 1 memory recalled',
        exact: true,
      })
    ).toBeVisible()
    await chips.click()
    await page.getByRole('button', { name: 'Local Launch code', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Launch code', exact: true })).toBeVisible()
    await expect(page.getByPlaceholder('Durable content')).toHaveValue('The e2e launch code is BLUEBIRD.')
    const linkedMemoryId = await page.evaluate(async (workspaceId) => {
      const memories = await window.api.listMemories(workspaceId, { limit: 500 })
      return memories.find((memory: { id: string; title: string }) => memory.title === 'Launch code')!.id
    }, workspace.id)
    await page.getByRole('button', { name: 'New memory', exact: true }).click()
    await page.getByPlaceholder('Title', { exact: true }).fill('Review preference')
    await page.getByPlaceholder('Durable content').fill('Keep the selected memory after saving.')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Review preference', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await page.getByPlaceholder('Durable content').fill('Keep the edited memory selected too.')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Review preference', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await page.evaluate(
      ({ conversationId, memoryId }) => {
        window.dispatchEvent(new CustomEvent('maestrly:open-memory', { detail: { conversationId, memoryId } }))
      },
      { conversationId: conversation.id, memoryId: linkedMemoryId }
    )
    await expect(page.getByRole('heading', { name: 'Launch code', exact: true })).toBeVisible()

    await openConversation()

    const unrelated = await send('tell me a joke about cats')
    expect(lastUser(unrelated)).not.toContain('maestrly-memory')
    await expect(chips).toHaveCount(1)

    const setRecall = async (enabled: boolean) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('tab', { name: 'Models & agents', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Memory', exact: true })
      await settings.getByRole('checkbox', { name: 'Recall relevant memories automatically' }).setChecked(enabled)
      await settings.getByRole('button', { name: 'Save memory settings', exact: true }).click()
      await expect(settings.getByRole('status')).toHaveText('Saved')
      await expect
        .poll(() => page.evaluate(() => window.api.chatConfig()).then((config) => config.memory?.autoRecall))
        .toBe(enabled)
      await openConversation()
    }
    await setRecall(false)
    const suppressed = await send('when is the deploy window for the e2e check?')
    expect(lastUser(suppressed)).not.toContain('maestrly-memory')
    await expect(chips).toHaveCount(1)

    await setRecall(true)
    const restored = await send('when is the deploy window for the e2e check?')
    expect(lastUser(restored)).toContain('<maestrly-memory kind="recall">')
    expect(lastUser(restored)).toContain('Tuesday at 14:00 UTC')
    await expect(chips).toHaveCount(2)
    await expect(chips.last()).toBeVisible()
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
