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

const REQUEST = 'Abra duas conversas novas, uma para cada card (PROJ-1 e PROJ-2), e comece o desenvolvimento.'
const ANALYSIS = 'Analise os cards PROJ-1 e PROJ-2 e me diga o que falta.'
const FOLLOW_UP = 'Abra uma nova conversa para o PROJ-3 no mesmo checkout.'
const PLAN_REQUEST = 'Planeje o PROJ-4.'
const SEED_MARKER = 'This conversation was started from the Maestrly conversation'

interface ModelRequest {
  lastUser: string
  tools: string[]
  toolResults: Record<string, string>
}

/**
 * Deterministic end-to-end coverage with real chat turns against a scripted OpenAI-compatible model: explicit
 * natural-language dispatch into isolated worktrees with per-task models, replay instead of duplicates, refusal of
 * a non-explicit request even when the model tries, no recursive dispatch from seeded child turns, a later human
 * request in a child, and a plan handed off to a new Standard conversation.
 */
test('starts persistent conversations only on explicit requests and hands plans off to Standard', async () => {
  test.setTimeout(240_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-conversation-dispatch-'))
  const repository = path.join(root, 'repo')
  mkdirSync(repository)
  const git = (args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' }).toString().trim()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(path.join(repository, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'fixture'])

  const requests: ModelRequest[] = []
  let providerId = ''
  let app: ElectronApplication | undefined
  let page!: Page

  const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'dispatch-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'dispatch-primary',
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

  const tasks = () => [
    {
      requestKey: 'PROJ-1',
      title: 'PROJ-1 · Export',
      prompt: 'Add CSV export. Acceptance: a test covers the header row.',
      source: { label: 'PROJ-1 · Export' },
      settings: { providerId, modelId: 'dispatch-primary' },
    },
    {
      requestKey: 'PROJ-2',
      title: 'PROJ-2 · Import',
      prompt: 'Add CSV import. Acceptance: invalid rows are reported.',
      settings: { providerId, modelId: 'dispatch-secondary', fastMode: false },
    },
  ]

  const model: Server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'dispatch-primary' }, { id: 'dispatch-secondary' }] }))
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

    if (lastUser.includes(REQUEST)) {
      if (!did('dispatch-1')) return call(res, 'dispatch-1', 'start_conversations', { tasks: tasks() })
      // A repeated call with the same request keys must replay, never duplicate.
      if (!did('dispatch-2')) return call(res, 'dispatch-2', 'start_conversations', { tasks: tasks() })
      return end(res, 'Started PROJ-1 and PROJ-2.')
    }
    if (lastUser.includes(ANALYSIS)) {
      // A misbehaving model tries to dispatch without being asked; the host must refuse.
      if (!did('rogue-1'))
        return call(res, 'rogue-1', 'start_conversations', {
          tasks: [{ requestKey: 'PROJ-9', title: 'PROJ-9', prompt: 'Unrequested work.' }],
        })
      return end(res, 'Analysis only.')
    }
    if (lastUser.includes(FOLLOW_UP)) {
      if (!did('follow-1'))
        return call(res, 'follow-1', 'start_conversations', {
          tasks: [{ requestKey: 'PROJ-3', title: 'PROJ-3 · Follow-up', prompt: 'Follow up on PROJ-1.' }],
          placement: 'shared',
        })
      return end(res, 'Started PROJ-3.')
    }
    if (lastUser.includes(PLAN_REQUEST)) {
      return call(res, 'plan-1', 'review_plan', { title: 'PROJ-4 plan', plan: '## Steps\n1. Original step' })
    }
    if (lastUser.includes(SEED_MARKER)) return end(res, 'Working on the dispatched task.')
    if (lastUser.includes('<approved_plan>')) return end(res, 'Plan implemented in the new conversation.')
    end(res, 'OK')
  })

  const api = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args }) as Promise<any>
  const workspaceConversations = async (workspaceId: string) =>
    ((await api('listConversations', workspaceId)) as Array<{ id: string; name: string; cwd: string; branch: string }>)
  const idle = (conversationId: string) =>
    expect.poll(async () => (await api('chatRuntime', conversationId)).streaming, { timeout: 60_000 }).toBe(false)

  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `dispatch-${Date.now().toString(36)}`,
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
      name: 'Dispatch fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    providerId = provider.id
    await api('chatSetDefault', { providerId, modelId: 'dispatch-primary' })
    const workspace = await api('addWorkspace', repository)
    const source = await api('createConversation', {
      workspaceId: workspace.id,
      branch: 'feat/source',
      isNewBranch: true,
      mode: 'worktree',
      experience: 'standard',
      name: 'Source',
    })
    await api('chatSetSelection', source.id, { providerId, modelId: 'dispatch-primary' })
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.locator('li.conv-item', { hasText: 'Source' }).first().click()

    // 1. Explicit request typed in the composer: two isolated conversations with different models.
    await page.locator('.chat-input[contenteditable="true"]:visible').fill(REQUEST)
    await page.locator('button[title="Send"]:visible').click()
    await expect(page.getByText('Started PROJ-1 and PROJ-2.')).toBeVisible({ timeout: 60_000 })
    await idle(source.id)

    const dispatched = (await workspaceConversations(workspace.id)).filter((item) => item.name.startsWith('PROJ-'))
    expect(dispatched.map((item) => item.name).sort()).toEqual(['PROJ-1 · Export', 'PROJ-2 · Import'])
    const byName = (name: string) => dispatched.find((item) => item.name === name)!
    for (const item of dispatched) {
      expect(item.branch).toMatch(/^task\/proj-[12]-/)
      expect(item.cwd).not.toBe((await workspaceConversations(workspace.id)).find((c) => c.id === source.id)!.cwd)
      await expect.poll(async () => (await api('conversationDispatchStatus', item.id))?.phase).toBe('started')
      await idle(item.id)
    }
    expect(await api('chatGetSelection', byName('PROJ-1 · Export').id)).toEqual({
      providerId,
      modelId: 'dispatch-primary',
    })
    expect(await api('chatGetSelection', byName('PROJ-2 · Import').id)).toEqual({
      providerId,
      modelId: 'dispatch-secondary',
    })
    const replay = requests.find((request) => 'dispatch-2' in request.toolResults)!
    expect(JSON.parse(replay.toolResults['dispatch-2']).items.every((item: any) => item.replayed === true)).toBe(true)

    // Seeded child turns are host-generated: they never receive the dispatch tools.
    const seeds = requests.filter((request) => request.lastUser.includes(SEED_MARKER))
    expect(seeds.length).toBeGreaterThanOrEqual(2)
    for (const seed of seeds) expect(seed.tools).not.toContain('start_conversations')

    // The result card links to the new conversation, which shows its origin.
    const card = page.getByTestId('conversation-dispatch-card').last()
    await expect(card).toContainText('PROJ-1 · Export')
    await card.getByRole('button', { name: 'Open' }).first().click()
    await expect(page.getByTestId('conversation-dispatch-origin').first()).toBeVisible()
    await expect(page.getByText('Working on the dispatched task.').first()).toBeVisible()

    // 2. Analysis only: even when the model calls the tool, nothing is created.
    expect((await api('chatSend', source.id, ANALYSIS)).ok).toBe(true)
    await expect.poll(() => requests.some((request) => 'rogue-1' in request.toolResults), { timeout: 60_000 }).toBe(true)
    await idle(source.id)
    const refusal = requests.find((request) => 'rogue-1' in request.toolResults)!.toolResults['rogue-1']
    expect(JSON.parse(refusal)).toMatchObject({ ok: false, items: [] })
    expect(refusal).toContain('does not explicitly ask')
    expect((await workspaceConversations(workspace.id)).filter((item) => item.name.startsWith('PROJ-'))).toHaveLength(2)

    // 3. A later explicit request typed in a child may start its own conversation.
    const child = byName('PROJ-1 · Export')
    expect((await api('chatSend', child.id, FOLLOW_UP)).ok).toBe(true)
    await expect
      .poll(async () => (await workspaceConversations(workspace.id)).some((item) => item.name === 'PROJ-3 · Follow-up'), {
        timeout: 60_000,
      })
      .toBe(true)
    await idle(child.id)
    const followUp = (await workspaceConversations(workspace.id)).find((item) => item.name === 'PROJ-3 · Follow-up')!
    expect(followUp.cwd).toBe(child.cwd)
    expect((await api('conversationDispatchStatus', followUp.id)).sourceConversationId).toBe(child.id)
    await idle(followUp.id)

    // 4. Plan handoff through the real Plan panel: edit the plan, choose another model and a new worktree.
    await page.locator('li.conv-item', { hasText: 'Source' }).first().click()
    expect((await api('chatSetMode', source.id, 'plan')).ok).toBe(true)
    expect((await api('chatSend', source.id, PLAN_REQUEST)).ok).toBe(true)
    await expect.poll(async () => (await api('getPendingPlan', source.id))?.plan, { timeout: 60_000 }).toContain(
      'Original step'
    )
    await idle(source.id)
    // Drawer panels are native views outside Playwright's page list; drive the panel document directly.
    const panel = <T>(script: string) =>
      app!.evaluate(
        ({ webContents }, { script, conversationId }) => {
          const view = webContents
            .getAllWebContents()
            .find((item) => item.getURL().includes(`panel=plan&conv=${conversationId}`))
          return view ? view.executeJavaScript(script, true) : null
        },
        { script, conversationId: source.id }
      ) as Promise<T | null>
    const helpers = `
      const byText = (selector, text) =>
        [...document.querySelectorAll(selector)].find((element) => element.textContent.includes(text))
      const dialog = () => document.querySelector('[role="dialog"]')
      const submit = () => [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('Create and implement'))
    `
    const inPanel = <T>(body: string) => panel<T>(`(() => { ${helpers} ${body} })()`)
    await expect.poll(() => inPanel<boolean>(`return document.body.textContent.includes('Original step')`)).toBe(true)
    expect(await inPanel<boolean>(`const edit = byText('button', 'Edit'); edit?.click(); return !!edit`)).toBe(true)
    expect(
      await inPanel<boolean>(`
        const editor = document.querySelector('textarea.font-mono')
        if (!editor) return false
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, '## Steps\\n1. Edited step')
        editor.dispatchEvent(new Event('input', { bubbles: true }))
        return true`)
    ).toBe(true)
    expect(
      await inPanel<boolean>(`const open = byText('button', 'Implement in new conversation'); open?.click(); return !!open`)
    ).toBe(true)
    // Submission unlocks only once the selected model's capabilities are known.
    await expect
      .poll(() => inPanel<boolean>(`return !!submit() && !submit().disabled`), { timeout: 30_000 })
      .toBe(true)
    expect(
      await inPanel<boolean>(`
        const chip = dialog().querySelector('[data-testid="plan-handoff-settings"] button')
        chip?.click()
        return !!chip`)
    ).toBe(true)
    // The dialog's translate is the containing block of fixed descendants: the list must still open at the chip.
    await expect
      .poll(() =>
        inPanel<boolean>(`
          const chip = dialog().querySelector('[data-testid="plan-handoff-settings"] button').getBoundingClientRect()
          const list = dialog().querySelector('[data-testid="plan-handoff-settings"] input')?.closest('div[style]')
          if (!list) return false
          const rect = list.getBoundingClientRect()
          const gap = Math.min(Math.abs(rect.top - chip.bottom), Math.abs(chip.top - rect.bottom))
          return gap <= 8 && rect.left >= 0 && rect.right <= window.innerWidth`)
      )
      .toBe(true)
    await expect
      .poll(() => inPanel<boolean>(`const option = byText('[role="dialog"] button', 'dispatch-secondary'); option?.click(); return !!option`))
      .toBe(true)
    await expect
      .poll(
        () =>
          inPanel<boolean>(
            `return dialog().querySelector('[data-testid="plan-handoff-settings"]').textContent.includes('dispatch-secondary') && !submit().disabled`
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    expect(
      await inPanel<boolean>(`
        const worktree = byText('[role="radio"]', 'New worktree')
        worktree?.click()
        return !!worktree`)
    ).toBe(true)
    await expect.poll(() => inPanel<string | null>(`return byText('[role="radio"]', 'New worktree')?.getAttribute('aria-checked')`)).toBe('true')
    expect(await inPanel<boolean>(`submit().click(); return true`)).toBe(true)

    await expect.poll(() => requests.some((request) => request.lastUser.includes('<approved_plan>')), {
      timeout: 60_000,
    }).toBe(true)
    const implementation = requests.filter((request) => request.lastUser.includes('<approved_plan>'))
    expect(implementation).toHaveLength(1)
    expect(implementation[0].lastUser).toContain('Edited step')
    expect(implementation[0].lastUser).not.toContain('Original step')
    expect(implementation[0].lastUser).toContain('own worktree')
    expect(await api('getPendingPlan', source.id)).toBeNull()
    expect(await api('chatGetMode', source.id)).toBe('plan')
    expect(await api('chatGetSelection', source.id)).toEqual({ providerId, modelId: 'dispatch-primary' })
    const handedOff = (await workspaceConversations(workspace.id)).find((item) => item.name === 'Source · PROJ-4 plan')!
    expect(handedOff.branch).toMatch(/^task\/proj-4-plan-/)
    expect(await api('chatGetSelection', handedOff.id)).toEqual({ providerId, modelId: 'dispatch-secondary' })
    expect(await api('chatGetMode', handedOff.id)).toBe('agent')
    expect((await api('conversationDispatchStatus', handedOff.id))?.phase).toBe('started')
    await idle(handedOff.id)
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
