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

const PLAN_REQUEST = 'Plan the counter fix.'
const FINDING = 'Counter loses concurrent updates'

interface ModelRequest {
  model: string
  system: string
  lastUser: string
  tools: string[]
  toolResults: Record<string, string>
}

/**
 * Code and plan reviews end to end against a scripted OpenAI-compatible model: the person picks another model to
 * review, reviewers run as read-only subagents that submit findings, a verifier confirms them, the code report lands
 * in the conversation and reaches the model with the next message, and the Plan tab turns plan findings into line
 * comments with the remembered reviewer.
 */
test('reviews code and plans on the reviewer model the person chooses', async () => {
  test.setTimeout(240_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-reviews-'))
  const repository = path.join(root, 'repo')
  mkdirSync(repository)
  const git = (args: string[], cwd = repository) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(path.join(repository, 'counter.js'), 'let count = 0\nexport const add = () => count++\n')
  git(['add', '-A'])
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'fixture'])

  const requests: ModelRequest[] = []
  let app: ElectronApplication | undefined
  let page!: Page

  const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'review-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'review-primary',
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
  const finding = {
    severity: 'blocking',
    title: FINDING,
    details: 'Two callers can read the same count and both write it back.',
    evidence: 'counter.js:2 increments without any guard.',
    path: 'counter.js',
    line: 2,
    plan_line: 2,
  }

  const model: Server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'review-primary' }, { id: 'review-secondary' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body) as {
      model: string
      messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
      tools?: Array<{ function: { name: string } }>
    }
    const system = input.messages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .map((message) => text(message.content))
      .join('\n')
    const lastUser = text([...input.messages].reverse().find((message) => message.role === 'user')?.content)
    const toolResults = Object.fromEntries(
      input.messages
        .filter((message) => message.role === 'tool' && message.tool_call_id)
        .map((message) => [message.tool_call_id!, text(message.content)])
    )
    const tools = (input.tools ?? []).map((tool) => tool.function.name)
    requests.push({ model: input.model, system, lastUser, tools, toolResults })
    res.setHeader('content-type', 'text/event-stream')

    if (system.includes('independent senior reviewer')) {
      if (Object.keys(toolResults).length) return end(res, 'Review submitted.')
      if (lastUser.startsWith('You are the verifier')) {
        return call(res, 'verify-1', 'submit_findings', { findings: [{ ...finding, candidate_id: 'C1' }] })
      }
      // One lens of each review finds the problem; the others find nothing.
      const reports = lastUser.startsWith('Lens: correctness') || lastUser.startsWith('Lens: feasibility')
      return call(res, 'lens-1', 'submit_findings', { findings: reports ? [finding] : [] })
    }
    if (lastUser.includes(PLAN_REQUEST)) {
      return call(res, 'plan-1', 'review_plan', { title: 'Counter plan', plan: '## Steps\n1. Increment the counter' })
    }
    end(res, 'OK')
  })

  const api = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args }) as Promise<any>
  const idle = (conversationId: string) =>
    expect.poll(async () => (await api('chatRuntime', conversationId)).streaming, { timeout: 60_000 }).toBe(false)
  const reviewerRequests = () => requests.filter((request) => request.system.includes('independent senior reviewer'))

  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `reviews-${Date.now().toString(36)}`,
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
      name: 'Review fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    const providerId = provider.id as string
    await api('chatSetDefault', { providerId, modelId: 'review-primary' })
    const workspace = await api('addWorkspace', repository)
    const source = await api('createConversation', {
      workspaceId: workspace.id,
      branch: 'feat/counter',
      isNewBranch: true,
      mode: 'worktree',
      experience: 'standard',
      name: 'Counter',
    })
    await api('chatSetSelection', source.id, { providerId, modelId: 'review-primary' })
    const conversation = ((await api('listConversations', workspace.id)) as Array<{ id: string; cwd: string }>).find(
      (item) => item.id === source.id
    )!
    // Uncommitted work for the code review to look at.
    writeFileSync(
      path.join(conversation.cwd, 'counter.js'),
      'let count = 0\nexport const add = () => (count = count + 1)\n'
    )
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.locator('li.conv-item', { hasText: 'Counter' }).first().click()

    // 1. Code review from the header, on a reviewer model other than the conversation's.
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    const dialog = page.getByTestId('review-start-dialog')
    await expect(dialog).toBeVisible()
    const conversationChoice = dialog.getByRole('radio', { name: /This conversation's model/ })
    await expect(conversationChoice).toHaveAttribute('aria-checked', 'true')
    await expect(conversationChoice).toContainText('Review fixture · review-primary')
    await dialog.getByRole('radio', { name: /Another model/ }).click()
    const settings = dialog.getByTestId('review-reviewer-settings')
    await settings.getByRole('button').first().click()
    await dialog.getByRole('button', { name: /review-secondary/ }).click()
    await expect(settings).toContainText('review-secondary')
    const start = dialog.getByRole('button', { name: 'Start review' })
    await expect(start).toBeEnabled({ timeout: 30_000 })
    await start.click()
    await expect(dialog).toBeHidden()

    const card = page.getByTestId('review-report-card')
    await expect(card).toContainText(FINDING, { timeout: 90_000 })
    await expect(card).toContainText('1 finding · 1 blocking')
    await expect(card).toContainText('review-secondary')
    const codeReviewers = reviewerRequests()
    // Three lenses and the verifier, each a submission and a closing turn, all on the chosen model.
    expect(new Set(codeReviewers.map((request) => request.model))).toEqual(new Set(['review-secondary']))
    expect(codeReviewers.filter((request) => request.lastUser.startsWith('Lens: ')).length).toBeGreaterThanOrEqual(3)
    expect(codeReviewers.some((request) => request.lastUser.startsWith('You are the verifier'))).toBe(true)
    for (const request of codeReviewers) {
      expect(request.tools).toEqual(expect.arrayContaining(['submit_findings', 'git_diff', 'read', 'grep', 'glob']))
      expect(request.tools).not.toEqual(expect.arrayContaining(['bash']))
      expect(request.tools).not.toEqual(expect.arrayContaining(['edit']))
    }

    // The report reaches the conversation's model with the person's next message, here the card's action.
    await card.getByRole('button', { name: /Fix selected/ }).click()
    await expect
      .poll(() => requests.some((request) => request.lastUser.includes('Fix the review findings F1')), {
        timeout: 60_000,
      })
      .toBe(true)
    const fix = requests.find((request) => request.lastUser.includes('Fix the review findings F1'))!
    expect(fix.model).toBe('review-primary')
    expect(fix.lastUser).toContain(`## F1 [blocking] ${FINDING}`)
    await idle(source.id)

    // 2. Plan review in the Plan tab, which offers the remembered reviewer first.
    expect((await api('chatSetMode', source.id, 'plan')).ok).toBe(true)
    expect((await api('chatSend', source.id, PLAN_REQUEST)).ok).toBe(true)
    await expect
      .poll(async () => (await api('getPendingPlan', source.id))?.plan, { timeout: 60_000 })
      .toContain('Increment the counter')
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
      const dialog = () => document.querySelector('[data-testid="review-start-dialog"]')
    `
    const inPanel = <T>(body: string) => panel<T>(`(() => { ${helpers} ${body} })()`)
    await expect
      .poll(() => inPanel<boolean>(`return document.body.textContent.includes('Increment the counter')`))
      .toBe(true)
    expect(await inPanel<boolean>(`const open = byText('button', 'Review plan'); open?.click(); return !!open`)).toBe(
      true
    )
    await expect
      .poll(
        () =>
          inPanel<boolean>(`
            const other = byText('[data-testid="review-start-dialog"] [role="radio"]', 'Another model')
            const settings = dialog()?.querySelector('[data-testid="review-reviewer-settings"]')
            return other?.getAttribute('aria-checked') === 'true' && !!settings?.textContent.includes('review-secondary')`),
        { timeout: 30_000 }
      )
      .toBe(true)
    const before = reviewerRequests().length
    await expect
      .poll(
        () =>
          inPanel<boolean>(`
            const start = byText('[data-testid="review-start-dialog"] button', 'Start review')
            if (!start || start.disabled) return false
            start.click()
            return true`),
        { timeout: 30_000 }
      )
      .toBe(true)
    await expect
      .poll(
        () =>
          inPanel<boolean>(`return document.body.textContent.includes('Review: 1 finding added to your comments.')`),
        {
          timeout: 90_000,
        }
      )
      .toBe(true)
    expect(await inPanel<boolean>(`return document.body.textContent.includes(${JSON.stringify(FINDING)})`)).toBe(true)
    const planReviewers = reviewerRequests().slice(before)
    expect(planReviewers.some((request) => request.lastUser.startsWith('Lens: feasibility'))).toBe(true)
    expect(new Set(planReviewers.map((request) => request.model))).toEqual(new Set(['review-secondary']))
    for (const request of planReviewers) expect(request.tools).not.toContain('git_diff')
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
