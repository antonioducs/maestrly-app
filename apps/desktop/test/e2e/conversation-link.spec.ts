import { createServer, type Server, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))

const REVIEW = 'Abre outro agent pra revisar o README e me traz o resultado.'
const FOLLOW = 'Pede pra ela corrigir o item 2.'
const NOTIFY = 'Avisa a conversa Other que o README mudou.'
const SEED = 'LINK-SEED: review the README.'

interface ModelRequest {
  lastUser: string
  tools: string[]
  toolResults: Record<string, string>
}

/**
 * Conversations talking to each other through real chat turns against a scripted OpenAI-compatible model: a
 * confirmed request opens a review conversation whose final answer comes back to the source, a follow-up and the
 * child's report travel between the linked conversations until the hop limit stops them, and the first message to an
 * unrelated conversation waits for the person's confirmation. Turns started by another conversation are offered the
 * tools that start conversations or create projects, and those tools refuse.
 */
test('lets conversations message each other, bring results back and stop at the hop limit', async () => {
  test.setTimeout(240_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-conversation-link-'))
  const repository = path.join(root, 'repo')
  mkdirSync(repository)
  const git = (args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' }).toString().trim()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(path.join(repository, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'fixture'])

  const requests: ModelRequest[] = []
  let childId = ''
  let otherId = ''
  let app: ElectronApplication | undefined
  let page!: Page

  const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'link-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'link-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    )
  const end = (res: ServerResponse, text: string) => {
    chunk(res, { role: 'assistant', content: text })
    chunk(res, {}, 'stop')
    res.end('data: [DONE]\n\n')
  }
  const call = (res: ServerResponse, id: string, name: string, args: unknown) => {
    chunk(res, {
      role: 'assistant',
      tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    })
    chunk(res, {}, 'tool_calls')
    res.end('data: [DONE]\n\n')
  }
  const text = (content: unknown): string =>
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
        : ''

  const model: Server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'link-model' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body) as {
      messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
      tools?: Array<{ function: { name: string } }>
    }
    const lastUser = text([...input.messages].reverse().find((message) => message.role === 'user')?.content)
    const toolResults = Object.fromEntries(
      input.messages
        .filter((message) => message.role === 'tool' && message.tool_call_id)
        .map((message) => [message.tool_call_id!, text(message.content)])
    )
    const tools = (input.tools ?? []).map((tool) => tool.function.name)
    requests.push({ lastUser, tools, toolResults })
    res.setHeader('content-type', 'text/event-stream')
    const did = (id: string) => id in toolResults

    // Source: a loosely worded request for another agent, with the result brought back.
    if (lastUser.includes(REVIEW)) {
      if (!did('review-1'))
        return call(res, 'review-1', 'start_conversations', {
          tasks: [{ requestKey: 'REV-1', title: 'REV-1 · Review', prompt: SEED }],
          placement: 'shared',
          reportBack: true,
        })
      return end(res, 'Started REV-1.')
    }
    // Child: its first turn ends with the review, which goes back to the source. Started by another conversation, its
    // attempt to start one more is refused.
    if (lastUser.includes(SEED)) {
      if (!did('seed-rogue'))
        return call(res, 'seed-rogue', 'start_conversations', {
          tasks: [{ requestKey: 'REV-9', title: 'REV-9', prompt: 'Recursive review.' }],
        })
      return end(res, 'Review: README OK.')
    }
    // Source: the result arrives as a new turn.
    if (lastUser.includes('Result of conversation') && lastUser.includes('Review: README OK.'))
      return end(res, 'Consolidated: README OK.')
    // Source: a follow-up to the linked child, which needs no confirmation.
    if (lastUser.includes(FOLLOW)) {
      if (!did('follow-1'))
        return call(res, 'follow-1', 'send_to_conversation', { conversationId: childId, message: 'FIX ITEM 2' })
      return end(res, 'Asked REV-1 to fix item 2.')
    }
    // Child: reports back to the conversation that sent the message.
    if (lastUser.includes('FIX ITEM 2')) {
      if (!did('report-1')) return call(res, 'report-1', 'report_to_source', { message: 'Fixed item 2.' })
      return end(res, 'Item 2 fixed.')
    }
    // Source, two agent turns after the person: one more round trip would exceed the hop limit.
    if (lastUser.includes('Fixed item 2.')) {
      if (!did('again-1'))
        return call(res, 'again-1', 'send_to_conversation', { conversationId: childId, message: 'AGAIN', reportBack: true })
      return end(res, 'Stopping here; the person can continue.')
    }
    // Source: a conversation with no link needs the person's confirmation.
    if (lastUser.includes(NOTIFY)) {
      if (!did('list-1')) return call(res, 'list-1', 'list_conversations', { query: 'Other' })
      if (!did('notify-1'))
        return call(res, 'notify-1', 'send_to_conversation', { conversationId: otherId, message: 'README changed.' })
      return end(res, 'Told Other.')
    }
    if (lastUser.includes('README changed.')) {
      // Started by another conversation's message: creating a project is refused.
      if (!did('peer-rogue'))
        return call(res, 'peer-rogue', 'create_workspace', { requestKey: 'rogue', name: 'rogue', source: { kind: 'new' } })
      return end(res, 'Noted the README change.')
    }
    end(res, 'OK')
  })

  const api = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args }) as Promise<any>
  const idle = (conversationId: string) =>
    expect.poll(async () => (await api('chatRuntime', conversationId)).streaming, { timeout: 60_000 }).toBe(false)
  const conversations = async (workspaceId: string) =>
    (await api('listConversations', workspaceId)) as Array<{ id: string; name: string }>
  const open = (name: string) => page.locator('li.conv-item', { hasText: name }).first().click()
  const typeAndSend = async (message: string) => {
    await page.locator('.chat-input[contenteditable="true"]:visible').fill(message)
    await page.locator('button[title="Send"]:visible').click()
  }
  /** Answer a confirmation the app shows in the chat. */
  const answer = async (header: string, option: RegExp) => {
    const question = page.getByTestId('question-composer')
    await expect(question).toContainText(header, { timeout: 60_000 })
    await question.getByRole('button', { name: option }).click()
    await question.getByRole('button', { name: 'Next', exact: true }).click()
    await question.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(question).toBeHidden()
  }
  const linkedTurnsOffered = (marker: string) =>
    requests.filter((request) => request.lastUser.includes(marker)).map((request) => request.tools)

  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `link-${Date.now().toString(36)}`,
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await api('setOnboardingDone', true)
    const provider = await api('chatAddProvider', {
      name: 'Link fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    await api('chatSetDefault', { providerId: provider.id, modelId: 'link-model' })
    const workspace = await api('addWorkspace', repository)
    const create = async (name: string, branch: string) => {
      const conversation = await api('createConversation', {
        workspaceId: workspace.id,
        branch,
        isNewBranch: true,
        mode: 'worktree',
        experience: 'standard',
        name,
      })
      await api('chatSetSelection', conversation.id, { providerId: provider.id, modelId: 'link-model' })
      return conversation as { id: string }
    }
    const source = await create('Source', 'feat/source')
    otherId = (await create('Other', 'feat/other')).id
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await open('Source')

    // 1. Another agent reviews, and its final answer comes back to the source as a new turn.
    await typeAndSend(REVIEW)
    await answer('New conversations', /^1\..*Start$/)
    await expect(page.getByText('Started REV-1.')).toBeVisible({ timeout: 60_000 })
    await expect.poll(async () => (await conversations(workspace.id)).some((item) => item.name === 'REV-1 · Review')).toBe(true)
    childId = (await conversations(workspace.id)).find((item) => item.name === 'REV-1 · Review')!.id
    await expect(page.getByText('Consolidated: README OK.')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('conversation-message-origin').filter({ hasText: 'Result from REV-1 · Review' })).toBeVisible()
    await idle(source.id)
    await idle(childId)
    const seeds = linkedTurnsOffered(SEED)
    expect(seeds.length).toBeGreaterThanOrEqual(1)
    for (const tools of seeds) expect(tools).toContain('report_to_source')

    // 2. A follow-up to the child and its report travel without confirmation, until the hop limit stops them.
    await typeAndSend(FOLLOW)
    await expect.poll(() => requests.some((request) => 'again-1' in request.toolResults), { timeout: 60_000 }).toBe(true)
    await idle(source.id)
    await idle(childId)
    expect(JSON.parse(requests.find((request) => 'follow-1' in request.toolResults)!.toolResults['follow-1'])).toMatchObject({
      ok: true,
      conversationId: childId,
    })
    const refused = JSON.parse(requests.find((request) => 'again-1' in request.toolResults)!.toolResults['again-1'])
    expect(refused).toMatchObject({ ok: false, code: 'hop-limit' })
    expect(requests.some((request) => request.lastUser.includes('AGAIN'))).toBe(false)
    await expect(page.getByTestId('conversation-message-origin').filter({ hasText: 'Report from REV-1 · Review' })).toBeVisible()

    // 3. The first message to a conversation with no link waits for the person.
    await typeAndSend(NOTIFY)
    await answer('Message another conversation', /^1\..*Send$/)
    await expect(page.getByText('Told Other.')).toBeVisible({ timeout: 60_000 })
    await idle(source.id)
    await idle(otherId)
    const listed = JSON.parse(requests.find((request) => 'list-1' in request.toolResults)!.toolResults['list-1'])
    expect(listed.conversations).toEqual([expect.objectContaining({ conversationId: otherId, name: 'Other', relation: null })])
    await open('Other')
    await expect(page.getByTestId('conversation-message-origin').filter({ hasText: 'Message from Source' })).toBeVisible()
    await expect(page.getByText('Noted the README change.')).toBeVisible()

    // Turns started by another conversation are offered the same tools as typed turns, so a native session survives
    // the switch, but they never start conversations or create projects: what they try is refused.
    for (const marker of [SEED, 'FIX ITEM 2', 'README changed.', 'Result of conversation', 'Fixed item 2.']) {
      const offered = linkedTurnsOffered(marker)
      expect(offered.length, marker).toBeGreaterThan(0)
      for (const tools of offered) expect(tools).toEqual(expect.arrayContaining(['start_conversations', 'create_workspace']))
    }
    const result = (id: string) => requests.find((request) => id in request.toolResults)!.toolResults[id]
    expect(JSON.parse(result('seed-rogue'))).toMatchObject({ ok: false, items: [] })
    expect(result('seed-rogue')).toContain('only works in the main agent turn')
    expect(JSON.parse(result('peer-rogue'))).toMatchObject({ ok: false, code: 'unavailable' })
    expect((await conversations(workspace.id)).map((item) => item.name).sort()).toEqual([
      'Other',
      'REV-1 · Review',
      'Source',
    ])
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
