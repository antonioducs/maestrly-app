import { createServer, type ServerResponse } from 'node:http'
import { access, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import type { Api } from '../../src/preload'
import { removeTempDirEventually } from './helpers/temp-cleanup'

declare const window: Window & { api: Api }

const desktop = fileURLToPath(new URL('../..', import.meta.url))
interface ModelRequest {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
  tools?: Array<{ function: { name: string } }>
}
function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
}
const lastUser = (request: ModelRequest) =>
  text([...request.messages].reverse().find((message) => message.role === 'user')?.content)
const systemText = (request: ModelRequest) =>
  request.messages
    .filter((message) => message.role === 'system')
    .map((message) => text(message.content))
    .join('\n')
const memoryTools = (request: ModelRequest) =>
  (request.tools ?? [])
    .map((tool) => tool.function.name)
    .filter((name) => name.startsWith('memory_'))
    .sort()
const readTools = ['memory_list', 'memory_read', 'memory_search']

test('personal memory crosses synthetic providers through native model tools with app tools off', async () => {
  test.setTimeout(240_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-personal-recall-'))
  const requests: Array<{ identity: string; input: ModelRequest }> = []
  let app: ElectronApplication | undefined
  let memoryId = ''
  let action: { id: string; name: string; args: Record<string, unknown> } | undefined
  const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'personal-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'personal-fixture',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    )
  const model = createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'personal-fixture' }] }))
      return
    }
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body) as ModelRequest
    requests.push({ identity: req.url.split('/')[1], input })
    res.setHeader('content-type', 'text/event-stream')
    if (action && !input.messages.some((message) => message.role === 'tool' && message.tool_call_id === action?.id)) {
      chunk(res, {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: action.id,
            type: 'function',
            function: { name: action.name, arguments: JSON.stringify(action.args) },
          },
        ],
      })
      chunk(res, {}, 'tool_calls')
    } else {
      chunk(res, { role: 'assistant', content: 'PERSONAL-MEMORY-TURN-COMPLETE' })
      chunk(res, {}, 'stop')
    }
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
        AGENTS_INSTANCE: 'personal-recall-e2e',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        GOOGLE_API_KEY: '',
        GEMINI_API_KEY: '',
        OPENROUTER_API_KEY: '',
        AZURE_OPENAI_API_KEY: '',
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api))
    await page.evaluate(async () => {
      await window.api.setOnboardingDone(true)
      await window.api.chatSetAppTools(false)
      await window.api.chatSetImageGen(false)
      await window.api.setPersonalMemorySettings({
        enabled: true,
        autoRecall: true,
        extraction: { enabled: false, selection: null },
      })
      await window.api.createPersonalMemory({
        title: 'Answer style',
        content: 'Use concise sentences.',
        type: 'preference',
        pinned: true,
      })
    })
    const chats: Array<{ id: string; name: string; identity: string; providerId: string }> = []
    for (const identity of ['alpha', 'beta']) {
      const provider = await page.evaluate(
        (baseURL) =>
          window.api.chatAddProvider({
            name: baseURL.includes('/alpha/') ? 'Synthetic Alpha' : 'Synthetic Beta',
            kind: 'openai',
            key: 'synthetic-fixture-key',
            baseURL,
          }),
        `http://127.0.0.1:${(model.address() as { port: number }).port}/${identity}/v1`
      )
      expect(provider.ok).toBe(true)
      expect(provider.id).toBeTruthy()
      const conversation = await page.evaluate(
        (name) => window.api.createStandaloneConversation({ name }),
        `Personal ${identity}`
      )
      expect(conversation).toMatchObject({ scope: 'standalone', workspaceId: null })
      await page.evaluate(
        async ({ id, providerId }) => {
          await window.api.chatSetSelection(id, { providerId, modelId: 'personal-fixture' })
          await window.api.chatSetPermMode(id, 'full')
        },
        { id: conversation.id, providerId: provider.id! }
      )
      chats.push({ ...conversation, identity, providerId: provider.id! })
    }
    expect(chats[0].providerId).not.toBe(chats[1].providerId)
    expect((await page.evaluate(() => window.api.chatConfig())).appToolsEnabled).toBe(false)
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api))
    const send = async (
      chat: (typeof chats)[number],
      prompt: string,
      mode: 'ask' | 'agent' | 'design',
      tool?: { id: string; name: string; args: Record<string, unknown> }
    ) => {
      action = tool
      expect((await page.evaluate(({ id, mode }) => window.api.chatSetMode(id, mode), { id: chat.id, mode })).ok).toBe(
        true
      )
      await page.getByRole('tab', { name: 'Chats', exact: true }).click()
      await page.locator('li.conv-item', { hasText: chat.name }).first().click()
      const before = requests.length
      await page.locator('.chat-input[contenteditable="true"]:visible').fill(prompt)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect.poll(() => requests.length, { timeout: 60_000 }).toBeGreaterThan(before)
      await expect
        .poll(() => page.evaluate((id) => window.api.chatRuntime(id), chat.id).then((state) => state.streaming), {
          timeout: 60_000,
        })
        .toBe(false)
      const turn = requests.slice(before)
      expect(turn.every((request) => request.identity === chat.identity)).toBe(true)
      for (const request of turn) {
        const names = (request.input.tools ?? []).map((entry) => entry.function.name)
        // Personal memory is independent of terminal/browser/project app tools.
        expect(
          names.filter((name) => /^(terminal_|browser_|workspace_|notes_|debug_|conversation_)/.test(name))
        ).toEqual([])
        if (mode === 'ask' && (await page.evaluate(() => window.api.getPersonalMemorySettings())).enabled)
          expect(memoryTools(request.input)).toEqual(readTools)
      }
      if (tool) {
        expect(turn[0].input.tools?.some((entry) => entry.function.name === tool.name)).toBe(true)
        expect(
          turn.at(-1)!.input.messages.some((message) => message.role === 'tool' && message.tool_call_id === tool.id)
        ).toBe(true)
      }
      return { first: turn[0].input, last: turn.at(-1)!.input }
    }
    const [alpha, beta] = chats
    await send(alpha, 'Remember my launch code: BLUEBIRD.', 'agent', {
      id: 'save-launch',
      name: 'memory_upsert',
      args: { title: 'Launch code', content: 'My launch code is BLUEBIRD.', type: 'reference' },
    })
    const saved = (await page.evaluate(() => window.api.listPersonalMemories())).find(
      (entry) => entry.title === 'Launch code'
    )
    expect(saved).toMatchObject({
      source: 'agent',
      originConversationId: alpha.id,
      content: 'My launch code is BLUEBIRD.',
    })
    memoryId = saved!.id
    const recalled = await send(beta, 'What is my launch code?', 'ask', {
      id: 'read-launch',
      name: 'memory_read',
      args: { id: memoryId },
    })
    for (const expected of [
      '# Memory',
      '## Pinned memories',
      'Answer style',
      'Use concise sentences.',
      '## Memory catalog',
      'Launch code',
    ])
      expect(systemText(recalled.first)).toContain(expected)
    expect(lastUser(recalled.first)).toContain('<maestrly-memory kind="recall">')
    expect(lastUser(recalled.first)).toContain('BLUEBIRD')
    expect(text(recalled.last.messages.find((message) => message.tool_call_id === 'read-launch')?.content)).toContain(
      'BLUEBIRD'
    )

    await send(alpha, 'Correct my saved launch code to GREENFINCH.', 'design', {
      id: 'correct-launch',
      name: 'memory_upsert',
      args: { id: memoryId, title: 'Launch code', content: 'My launch code is GREENFINCH.', type: 'reference' },
    })
    expect((await page.evaluate((id) => window.api.getPersonalMemory(id), memoryId))?.content).toBe(
      'My launch code is GREENFINCH.'
    )
    for (const chat of chats) {
      const updated = await send(chat, 'What is my launch code after the correction?', 'ask')
      expect(lastUser(updated.first)).toContain('<maestrly-memory kind="updates">')
      expect(lastUser(updated.first)).toContain('GREENFINCH')
    }
    await send(alpha, 'Archive my launch code.', 'agent', {
      id: 'archive-launch',
      name: 'memory_archive',
      args: { id: memoryId },
    })
    for (const chat of chats) {
      const archived = await send(chat, 'List my active memories and check the launch code.', 'ask', {
        id: `list-after-archive-${chat.identity}`,
        name: 'memory_list',
        args: { status: 'active' },
      })
      expect(lastUser(archived.first)).toContain('<maestrly-memory kind="updates">')
      expect(lastUser(archived.first)).toContain('No longer valid')
      const recall =
        lastUser(archived.first)
          .match(/<maestrly-memory kind="recall">[\s\S]*?<\/maestrly-memory>/g)
          ?.join('') ?? ''
      expect(recall).not.toContain('GREENFINCH')
      const result = text(
        archived.last.messages.find((message) => message.tool_call_id === `list-after-archive-${chat.identity}`)
          ?.content
      )
      expect(result).toContain('Answer style')
      expect(result).not.toContain(memoryId)
      const searched = await send(chat, 'Search my saved launch code.', 'ask', {
        id: `search-after-archive-${chat.identity}`,
        name: 'memory_search',
        args: { query: 'launch code' },
      })
      const searchResult = text(
        searched.last.messages.find((message) => message.tool_call_id === `search-after-archive-${chat.identity}`)
          ?.content
      )
      expect(searchResult).not.toContain(memoryId)
      expect(searchResult).not.toContain('GREENFINCH')
    }
    await page.evaluate(async () => {
      const settings = await window.api.getPersonalMemorySettings()
      await window.api.setPersonalMemorySettings({ ...settings, enabled: false })
    })
    for (const chat of chats) {
      const disabled = await send(chat, 'What is my answer style and launch code now?', 'ask')
      expect(memoryTools(disabled.first)).toEqual([])
      // Previous user/tool payloads can remain in history; only newly admitted context is checked.
      expect(lastUser(disabled.first)).not.toContain('<maestrly-memory')
      expect(systemText(disabled.first)).not.toContain('# Memory')
      expect(systemText(disabled.first)).not.toContain('Use concise sentences.')
    }
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
