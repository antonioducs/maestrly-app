import { createServer, type Server, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const shotsDir = path.join(desktop, 'test-results', 'maestro-swarm')

const ORCHESTRATOR_PROMPT = 'Run the swarm for tasks a and b.'
const WORKER_A_MARKER = 'SWARM-WORKER-A'
const WORKER_B_MARKER = 'SWARM-WORKER-B'
const REPORT_A_MARKER = 'REPORT-TASK-A'
const REPORT_B_MARKER = 'REPORT-TASK-B'

interface ModelRequest {
  lastUser: string
  tools: string[]
  toolResults: Record<string, string>
}

interface SwarmTask {
  key: string
  title: string
  resourceId: string | null
  conversationId: string | null
  branch: string | null
  phase: string
  mergedCommit: string | null
}

/** The worker's command, in the shell the `bash` tool runs: PowerShell on Windows, POSIX sh elsewhere. */
function workerCommit(file: string, content: string, message: string): string {
  const commit = `git -c user.name=E2E -c user.email=e2e@example.test commit -q -m '${message}'`
  return process.platform === 'win32'
    ? `Set-Content -Path ${file} -Value '${content}'; git add -A; ${commit}`
    : `printf '${content}\\n' > ${file} && git add -A && ${commit}`
}

/**
 * End-to-end coverage for the Maestro swarm lifecycle against a scripted OpenAI-compatible server:
 * - Maestro conversation on its own feature-branch worktree with a two-agent pool (`neon`, `hydro`) inheriting the
 *   orchestrator model.
 * - Orchestrator declares tasks via `swarm_update`, dispatches `a` (`neon`), `b` (`hydro`) and `c` (`settings`),
 *   expecting `c` to fail with the settings refusal, `a` and `b` to start without a confirmation prompt, and tasks to
 *   show `implementing` in-flight.
 * - Workers commit on their own branches via `bash` and report back, waking the orchestrator across two host turns.
 * - Orchestrator marks each task `reviewing` and merges each worker branch with `git merge --no-ff`; end-of-turn
 *   reconciliation marks both tasks `merged`, reflected in IPC, sidebar badges, and the Maestro pill/popover.
 */
test('runs a Maestro swarm end to end through dispatch, worker commits, review, and merge reconciliation', async () => {
  test.setTimeout(240_000)
  await access(path.join(desktop, 'out/main/index.js'))
  mkdirSync(shotsDir, { recursive: true })

  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-maestro-swarm-'))
  const repository = path.join(root, 'repo')
  mkdirSync(repository)
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
  git(repository, ['init', '-q', '-b', 'main'])
  git(repository, ['config', 'user.name', 'E2E'])
  git(repository, ['config', 'user.email', 'e2e@example.test'])
  writeFileSync(path.join(repository, 'README.md'), '# maestro swarm fixture\n')
  git(repository, ['add', '-A'])
  git(repository, ['commit', '-q', '-m', 'fixture'])

  const requests: ModelRequest[] = []
  const branchByKey = new Map<string, string>()
  let providerId = ''
  let app: ElectronApplication | undefined
  let page!: Page
  let releaseWorkers!: () => void
  const workersReleased = new Promise<void>((resolve) => {
    releaseWorkers = resolve
  })

  const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'maestro-swarm-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'swarm-model',
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

  const captureBranches = (toolResults: Record<string, string>) => {
    const raw = toolResults['dispatch-1']
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { items?: Array<{ requestKey?: string; branch?: string }> }
      for (const item of parsed.items ?? []) {
        if (item.requestKey && item.branch) branchByKey.set(item.requestKey, item.branch)
      }
    } catch {
      // Ignore malformed fixture payloads.
    }
  }

  const model: Server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'swarm-model' }] }))
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
    captureBranches(toolResults)
    res.setHeader('content-type', 'text/event-stream')
    const did = (id: string) => id in toolResults

    // Orchestrator turn 1: declare tasks a and b, then dispatch a (neon), b (hydro), and c (settings -> rejected).
    if (lastUser.includes(ORCHESTRATOR_PROMPT)) {
      if (!did('swarm-declare')) {
        return call(res, 'swarm-declare', 'swarm_update', {
          tasks: [
            { key: 'a', title: 'Task A · Neon', agent: 'neon' },
            { key: 'b', title: 'Task B · Hydro', agent: 'hydro' },
          ],
        })
      }
      if (!did('dispatch-1')) {
        return call(res, 'dispatch-1', 'start_conversations', {
          tasks: [
            {
              requestKey: 'a',
              title: 'Task A · Neon',
              prompt: `${WORKER_A_MARKER}: create neon.txt and commit it on your branch.`,
              agent: 'neon',
            },
            {
              requestKey: 'b',
              title: 'Task B · Hydro',
              prompt: `${WORKER_B_MARKER}: create hydro.txt and commit it on your branch.`,
              agent: 'hydro',
            },
            {
              requestKey: 'c',
              title: 'Task C · Rejected',
              prompt: 'This task passes settings and must fail in Maestro.',
              settings: { providerId, modelId: 'swarm-model' },
            },
          ],
        })
      }
      return end(res, 'Dispatched tasks a and b; task c was rejected.')
    }

    // Worker A: pause until mid-flight screenshot is captured, then create + commit neon.txt and report back.
    if (lastUser.includes(WORKER_A_MARKER)) {
      if (!did('worker-a-commit')) {
        await workersReleased
        return call(res, 'worker-a-commit', 'bash', {
          command: workerCommit('neon.txt', 'neon work', 'feat: task a'),
        })
      }
      return end(res, `${REPORT_A_MARKER}: created neon.txt and committed on branch.`)
    }

    // Worker B: pause until mid-flight screenshot is captured, then create + commit hydro.txt and report back.
    if (lastUser.includes(WORKER_B_MARKER)) {
      if (!did('worker-b-commit')) {
        await workersReleased
        return call(res, 'worker-b-commit', 'bash', {
          command: workerCommit('hydro.txt', 'hydro work', 'feat: task b'),
        })
      }
      return end(res, `${REPORT_B_MARKER}: created hydro.txt and committed on branch.`)
    }

    // Orchestrator wake-up turn for Worker A's report.
    if (lastUser.includes(REPORT_A_MARKER)) {
      if (!did('review-a')) {
        return call(res, 'review-a', 'swarm_update', {
          tasks: [{ key: 'a', phase: 'reviewing' }],
        })
      }
      if (!did('merge-a')) {
        const branchA = branchByKey.get('a')
        if (!branchA) throw new Error('Missing branch for task a in start_conversations tool result')
        return call(res, 'merge-a', 'bash', {
          command: `git -c user.name=E2E -c user.email=e2e@example.test merge --no-ff ${branchA} -m 'merge: task a'`,
        })
      }
      return end(res, 'Reviewed and merged task a.')
    }

    // Orchestrator wake-up turn for Worker B's report.
    if (lastUser.includes(REPORT_B_MARKER)) {
      if (!did('review-b')) {
        return call(res, 'review-b', 'swarm_update', {
          tasks: [{ key: 'b', phase: 'reviewing' }],
        })
      }
      if (!did('merge-b')) {
        const branchB = branchByKey.get('b')
        if (!branchB) throw new Error('Missing branch for task b in start_conversations tool result')
        return call(res, 'merge-b', 'bash', {
          command: `git -c user.name=E2E -c user.email=e2e@example.test merge --no-ff ${branchB} -m 'merge: task b'`,
        })
      }
      return end(res, 'Reviewed and merged task b.')
    }

    end(res, 'OK')
  })

  const api = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args }) as Promise<any>
  const idle = (conversationId: string) =>
    expect.poll(async () => (await api('chatRuntime', conversationId)).streaming, { timeout: 60_000 }).toBe(false)
  const swarmTasks = (conversationId: string) => api('chatMaestroSwarmGet', conversationId) as Promise<SwarmTask[]>

  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `maestro-swarm-${Date.now().toString(36)}`,
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForFunction(() => Boolean((window as any).api))
    await api('setOnboardingDone', true)

    const provider = await api('chatAddProvider', {
      name: 'Swarm fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    providerId = provider.id
    await api('chatSetDefault', { providerId, modelId: 'swarm-model' })

    const workspace = await api('addWorkspace', repository)
    const maestro = await api('createConversation', {
      workspaceId: workspace.id,
      branch: 'feat/swarm',
      isNewBranch: true,
      mode: 'worktree',
      experience: 'maestro',
      name: 'Maestro Swarm',
    })
    expect(maestro.experience).toBe('maestro')
    expect(maestro.branch).toBe('feat/swarm')

    await api('chatSetSelection', maestro.id, { providerId, modelId: 'swarm-model' })
    await api('chatSetPermMode', maestro.id, 'full')
    const poolResult = await api('chatMaestroSetConversation', maestro.id, {
      version: 2,
      strategy: 'balanced',
      pool: [
        {
          id: 'neon',
          label: 'Neon',
          enabled: true,
          description: 'Neon implementation agent',
          mode: 'agent',
          specialties: ['frontend'],
          candidates: [],
        },
        {
          id: 'hydro',
          label: 'Hydro',
          enabled: true,
          description: 'Hydro implementation agent',
          mode: 'agent',
          specialties: ['backend'],
          candidates: [],
        },
      ],
    })
    expect(poolResult.ok).toBe(true)

    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.locator('li.conv-item', { hasText: 'Maestro Swarm' }).first().click()

    // Track whether any confirmation question ever appears during the run.
    let confirmationSaw = false
    const watchConfirmation = setInterval(() => {
      void page
        .getByTestId('question-composer')
        .isVisible()
        .then((visible) => {
          if (visible) confirmationSaw = true
        })
        .catch(() => undefined)
    }, 100)

    try {
      // 1. Send orchestrator prompt: declares a & b, dispatches a (neon), b (hydro), and c (settings).
      await page.locator('.chat-input[contenteditable="true"]:visible').fill(ORCHESTRATOR_PROMPT)
      await page.locator('button[title="Send"]:visible').click()
      await expect(page.getByText('Dispatched tasks a and b; task c was rejected.')).toBeVisible({ timeout: 60_000 })
      await idle(maestro.id)

      expect(confirmationSaw).toBe(false)
      await expect(page.getByTestId('question-composer')).toHaveCount(0)

      // Verify start_conversations tool result: c failed with settings message; a and b started.
      const dispatchRequest = requests.find((request) => 'dispatch-1' in request.toolResults)
      expect(dispatchRequest).toBeDefined()
      const dispatchPayload = JSON.parse(dispatchRequest!.toolResults['dispatch-1']) as {
        ok: boolean
        items: Array<{ requestKey: string; status: string; error?: string; branch?: string; conversationId?: string }>
      }
      const itemA = dispatchPayload.items.find((item) => item.requestKey === 'a')
      const itemB = dispatchPayload.items.find((item) => item.requestKey === 'b')
      const itemC = dispatchPayload.items.find((item) => item.requestKey === 'c')
      expect(itemA).toMatchObject({ status: 'started' })
      expect(itemA?.branch).toBeTruthy()
      expect(itemB).toMatchObject({ status: 'started' })
      expect(itemB?.branch).toBeTruthy()
      expect(itemC).toMatchObject({
        status: 'failed',
        error: 'settings are not accepted in Maestro; choose an Agent Pool resource with agent',
      })

      // 2. Mid-flight check while both workers are implementing: verify IPC + sidebar + pill, capture screenshot.
      await expect
        .poll(
          async () => {
            const tasks = await swarmTasks(maestro.id)
            return Object.fromEntries(tasks.map((task) => [task.key, task.phase]))
          },
          { timeout: 30_000 }
        )
        .toEqual({ a: 'implementing', b: 'implementing' })

      const dispatchFolder = page.locator(`[data-testid="sidebar-dispatch-folder"][data-dispatch-root="${maestro.id}"]`)
      await expect(dispatchFolder).toBeVisible({ timeout: 30_000 })
      const workerRowA = dispatchFolder.locator('li.conv-item', { hasText: 'Task A · Neon' })
      const workerRowB = dispatchFolder.locator('li.conv-item', { hasText: 'Task B · Hydro' })
      await expect(workerRowA.getByTestId('swarm-phase-badge')).toHaveText('implementing')
      await expect(workerRowB.getByTestId('swarm-phase-badge')).toHaveText('implementing')

      const pillButton = page.locator('button[aria-expanded]').filter({ hasText: /Swarm/ }).first()
      await expect(pillButton).toContainText(/Swarm\s*0\/2/)
      await pillButton.click()
      await expect(page.getByRole('button', { name: 'Stop swarm' })).toBeVisible()
      await page.screenshot({ path: path.join(shotsDir, 'mid-flight.png') })
      await page.keyboard.press('Escape')

      // 3. Release workers so they commit on their branches and report back, waking the orchestrator.
      releaseWorkers()

      // 4. Wait for both tasks to reach phase 'merged' via IPC 'chat:maestro:swarm:get'.
      await expect
        .poll(
          async () => {
            const tasks = await swarmTasks(maestro.id)
            return Object.fromEntries(tasks.map((task) => [task.key, task.phase]))
          },
          { timeout: 90_000 }
        )
        .toEqual({ a: 'merged', b: 'merged' })

      await idle(maestro.id)
      if (itemA?.conversationId) await idle(itemA.conversationId)
      if (itemB?.conversationId) await idle(itemB.conversationId)

      const finalTasks = await swarmTasks(maestro.id)
      expect(finalTasks).toHaveLength(2)
      for (const key of ['a', 'b']) {
        const task = finalTasks.find((item) => item.key === key)
        expect(task).toMatchObject({ key, phase: 'merged' })
        expect(task?.mergedCommit).toBeTruthy()
      }

      // Verify both orchestrator wake-up turns ran swarm_update (reviewing) and git merge.
      const reviewA = requests.find((request) => 'review-a' in request.toolResults)
      const reviewB = requests.find((request) => 'review-b' in request.toolResults)
      expect(reviewA?.toolResults['review-a']).toContain('reviewing')
      expect(reviewB?.toolResults['review-b']).toContain('reviewing')
      expect(requests.some((request) => 'merge-a' in request.toolResults)).toBe(true)
      expect(requests.some((request) => 'merge-b' in request.toolResults)).toBe(true)

      // Each report wakes exactly one orchestrator turn: review call, merge call, final answer. A result delivered
      // twice would add a fourth request whose history already holds both tool results.
      for (const marker of [REPORT_A_MARKER, REPORT_B_MARKER]) {
        expect(requests.filter((request) => request.lastUser.includes(marker))).toHaveLength(3)
      }

      // Verify both worker commits actually merged into the Maestro feature branch worktree.
      expect(existsSync(path.join(maestro.cwd, 'neon.txt'))).toBe(true)
      expect(readFileSync(path.join(maestro.cwd, 'neon.txt'), 'utf8').trim()).toBe('neon work')
      expect(existsSync(path.join(maestro.cwd, 'hydro.txt'))).toBe(true)
      expect(readFileSync(path.join(maestro.cwd, 'hydro.txt'), 'utf8').trim()).toBe('hydro work')
      expect(confirmationSaw).toBe(false)

      // 5. Verify UI reflects merged badges in the sidebar and Swarm 2/2 in the Maestro pill.
      await expect(workerRowA.getByTestId('swarm-phase-badge')).toHaveAttribute('data-swarm-phase', 'merged')
      await expect(workerRowA.getByTestId('swarm-phase-badge')).toHaveText('merged')
      await expect(workerRowB.getByTestId('swarm-phase-badge')).toHaveAttribute('data-swarm-phase', 'merged')
      await expect(workerRowB.getByTestId('swarm-phase-badge')).toHaveText('merged')
      await expect(pillButton).toContainText(/Swarm\s*2\/2/)

      // 6. Visual proof screenshots: sidebar with merged badges, then open pill popover.
      await page.screenshot({ path: path.join(shotsDir, 'sidebar.png') })
      await pillButton.click()
      await expect(pillButton).toHaveAttribute('aria-expanded', 'true')
      const popover = pillButton.locator('xpath=preceding-sibling::div[1]')
      await expect(popover).toContainText('2/2 merged')
      await expect(popover).toContainText('Task A · Neon')
      await expect(popover).toContainText('neon')
      await expect(popover).toContainText('Task B · Hydro')
      await expect(popover).toContainText('hydro')
      await expect(popover.getByRole('button', { name: 'Stop swarm' })).toHaveCount(0)
      await page.screenshot({ path: path.join(shotsDir, 'pill-popover.png') })
    } finally {
      clearInterval(watchConfirmation)
    }
  } finally {
    releaseWorkers()
    await app?.close().catch(() => undefined)
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
