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
const REVISION_MARKER = '## Comments on specific passages'

interface ModelRequest {
  model: string
  system: string
  lastUser: string
  tools: string[]
  toolResults: Record<string, string>
}

/**
 * Code and plan reviews end to end against a scripted OpenAI-compatible model: the review room opens at its scope,
 * the person picks another model to review, read-only reviewers read the checkout and submit candidates, the verifier
 * rules on them, the conversation stays held while the person decides and hands off, the report reaches the model
 * with the hand-off message, and the receipt checks the fixes. A plan review does the same from the Plan tab, sends
 * its comments as a revision request and checks the revision.
 */
test('reviews code and plans in the review room, hands them off and checks the fixes', async () => {
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
    const did = (id: string) => id in toolResults

    if (system.includes('independent senior reviewer')) {
      if (tools.includes('record_checks')) {
        if (did('check-1')) return end(res, 'Checked.')
        return call(res, 'check-1', 'record_checks', {
          results: [{ finding_id: 'F1', state: 'resolved', note: 'The increment is atomic now.' }],
        })
      }
      if (tools.includes('record_verdicts')) {
        if (did('verify-1')) return end(res, 'Ruled.')
        return call(res, 'verify-1', 'record_verdicts', { verdicts: [{ candidate_id: 'C1', verdict: 'confirmed' }] })
      }
      // One lens of each review reads the file and finds the problem; the others find nothing.
      const reports = lastUser.startsWith('Lens: correctness') || lastUser.startsWith('Lens: feasibility')
      if (reports && !did('read-1')) return call(res, 'read-1', 'read', { path: 'counter.js' })
      if (!did('submit-1')) return call(res, 'submit-1', 'submit_findings', { findings: reports ? [finding] : [] })
      return end(res, 'Review submitted.')
    }
    if (lastUser.includes(PLAN_REQUEST)) {
      return call(res, 'plan-1', 'review_plan', { title: 'Counter plan', plan: '## Steps\n1. Increment the counter' })
    }
    if (lastUser.includes(REVISION_MARKER) && lastUser.includes(FINDING)) {
      return call(res, 'plan-2', 'review_plan', {
        title: 'Counter plan',
        plan: '## Steps\n1. Increment the counter atomically, under a lock',
      })
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

    // 1. The header opens the review room at its scope: what changed and who reviews. Nothing runs yet.
    await page.getByTestId('review-header-button').click()
    const room = page.getByTestId('review-room')
    await expect(room).toHaveAttribute('data-stage', 'scope')
    await expect(room).toContainText('counter.js')
    await expect(room).toContainText('+1')
    const conversationChoice = room.getByRole('radio', { name: /This conversation's model/ })
    await expect(conversationChoice).toHaveAttribute('aria-checked', 'true')
    await expect(conversationChoice).toContainText('Review fixture · review-primary')
    expect(reviewerRequests()).toHaveLength(0)
    await room.getByRole('radio', { name: /Another model/ }).click()
    const settings = room.getByTestId('review-reviewer-settings')
    await settings.getByRole('button').first().click()
    await page.getByRole('button', { name: /review-secondary/ }).click()
    await expect(settings).toContainText('review-secondary')
    const start = room.getByTestId('review-start')
    await expect(start).toBeEnabled({ timeout: 30_000 })
    await start.click()

    // 2. Reviewers run and the verifier rules; then the room waits for decisions while holding the conversation.
    await expect(room).toHaveAttribute('data-stage', 'decide', { timeout: 90_000 })
    await expect(room).toContainText(FINDING)
    await expect(room).toContainText('export const add = () => (count = count + 1)')
    await expect(room).toContainText('Confirmed by the verifier.')
    await expect(page.getByTestId('review-header-button')).toBeVisible()
    expect(await api('chatSend', source.id, 'hello?')).toEqual({ ok: false, error: 'review-active' })
    const status = await api('chatReviewStatus', source.id)
    expect(status).toMatchObject({ status: 'ready', model: { modelId: 'review-secondary' } })
    expect(status.activity.correctness).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'read', path: 'counter.js', status: 'done' })])
    )
    expect(status.verdicts).toEqual([{ candidateId: 'C1', verdict: 'confirmed', severity: 'blocking' }])
    const codeReviewers = reviewerRequests()
    expect(new Set(codeReviewers.map((request) => request.model))).toEqual(new Set(['review-secondary']))
    for (const request of codeReviewers) {
      expect(request.tools).toEqual(expect.arrayContaining(['read', 'grep', 'glob', 'git_diff']))
      expect(request.tools).not.toEqual(expect.arrayContaining(['bash']))
      expect(request.tools).not.toEqual(expect.arrayContaining(['edit']))
    }

    // 3. Decide from the keyboard, then hand off: the message is built from the decisions.
    await page.keyboard.press('f')
    await expect(room).toContainText('1 of 1 decided')
    await room.getByTestId('review-to-handoff').click()
    await expect(room).toHaveAttribute('data-stage', 'handoff')
    await expect(room.getByTestId('review-handoff-message')).toHaveValue(
      /^Fix these review findings and verify the fixes:\n- F1 Counter loses concurrent updates \(counter\.js:2\)$/
    )
    await room.getByTestId('review-send').click()
    await expect(room).toBeHidden()

    // 4. The report reaches the conversation's model with the hand-off message, and the receipt follows it.
    await expect
      .poll(() => requests.some((request) => request.lastUser.includes('Fix these review findings')), {
        timeout: 60_000,
      })
      .toBe(true)
    const fix = requests.find((request) => request.lastUser.includes('Fix these review findings'))!
    expect(fix.model).toBe('review-primary')
    expect(fix.lastUser).toContain(`## F1 [blocking] ${FINDING}`)
    expect(fix.lastUser).toContain('Decision: fix')
    await idle(source.id)
    const receipt = page.getByTestId('review-receipt').last()
    await expect(receipt).toContainText('Sent')
    await expect(receipt).toContainText('review-secondary')
    // The next message does not carry the report again.
    expect((await api('chatSend', source.id, 'thanks')).ok).toBe(true)
    await idle(source.id)
    expect(requests.find((request) => request.lastUser.includes('thanks'))?.lastUser).not.toContain('Decision: fix')

    // 5. Check the fixes: one verifier pass over what was sent.
    const before = reviewerRequests().length
    await receipt.getByRole('button', { name: 'Check the fixes' }).click()
    await expect(receipt).toContainText('Holds up', { timeout: 60_000 })
    await expect(receipt).toContainText('The fix holds up. This review is closed.')
    const checker = reviewerRequests().slice(before)
    expect(checker[0].lastUser).toContain('checking fixes')
    expect(new Set(checker.map((request) => request.model))).toEqual(new Set(['review-secondary']))

    // 6. Plan review from the Plan tab, a renderer of its own: the room opens in the conversation.
    expect((await api('chatSetMode', source.id, 'plan')).ok).toBe(true)
    expect((await api('chatSend', source.id, PLAN_REQUEST)).ok).toBe(true)
    await expect
      .poll(async () => (await api('getPendingPlan', source.id))?.plan, { timeout: 60_000 })
      .toContain('Increment the counter')
    await idle(source.id)
    // Drawer panels are native views outside Playwright's page list; drive the panel document directly.
    const inPanel = <T>(body: string) =>
      app!.evaluate(
        ({ webContents }, { script, conversationId }) => {
          const view = webContents
            .getAllWebContents()
            .find((item) => item.getURL().includes(`panel=plan&conv=${conversationId}`))
          return view ? view.executeJavaScript(script, true) : null
        },
        { script: `(() => { ${body} })()`, conversationId: source.id }
      ) as Promise<T | null>
    await expect
      .poll(() =>
        inPanel<boolean>(`
          const button = document.querySelector('[data-testid="plan-review-button"]')
          if (!button || button.disabled) return false
          button.click()
          return true`)
      )
      .toBe(true)
    await expect(room).toHaveAttribute('data-stage', 'scope')
    await expect(room).toContainText('Plan review')
    await expect(room).toContainText('Increment the counter')
    // The reviewer chosen last time is offered first.
    await expect(room.getByRole('radio', { name: /Another model/ })).toHaveAttribute('aria-checked', 'true')
    await expect(room.getByTestId('review-reviewer-settings')).toContainText('review-secondary')
    await expect(start).toBeEnabled({ timeout: 30_000 })
    await start.click()
    await expect(room).toHaveAttribute('data-stage', 'decide', { timeout: 90_000 })
    // The Plan tab cannot decide the plan while the review holds it.
    await expect
      .poll(() => inPanel<boolean>(`return !!document.querySelector('[data-testid="plan-review-lock"]')`))
      .toBe(true)
    expect(await api('decidePlan', source.id, { action: 'approve' })).toEqual({ ok: false, error: 'review-active' })

    await page.keyboard.press('c')
    await room.getByTestId('review-to-handoff').click()
    await expect(room.locator('[data-comment="F1"]')).toHaveValue(new RegExp(FINDING))
    await room.getByTestId('review-revise').click()
    await expect(room).toBeHidden()

    // 7. The comments become a revision request; the agent revises, and the receipt checks the revision.
    await expect.poll(async () => (await api('getPendingPlan', source.id))?.version, { timeout: 60_000 }).toBe(2)
    await idle(source.id)
    const revision = requests.find((request) => request.lastUser.includes(REVISION_MARKER))!
    expect(revision.lastUser).toContain(FINDING)
    const planReceipt = page.getByTestId('review-receipt').last()
    await expect(planReceipt).toContainText('Revision requested')
    await planReceipt.getByRole('button', { name: 'Check the revision' }).click()
    await expect(planReceipt).toContainText('The comment is addressed.', { timeout: 60_000 })
    expect(reviewerRequests().at(-1)?.lastUser).toContain('checking a plan revision')
    await expect
      .poll(() =>
        inPanel<string>(`return document.querySelector('[data-testid="plan-review-status"]')?.textContent ?? ''`)
      )
      .toContain('the comment is addressed in this revision')
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
