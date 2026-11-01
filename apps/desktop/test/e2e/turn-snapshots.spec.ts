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

/** The agent's command: rewrites one file and deletes another, in the shell the `bash` tool runs. */
const COMMAND =
  process.platform === 'win32'
    ? "Set-Content -Path edit.txt -Value 'after'; Remove-Item gone.txt"
    : "printf 'after\\n' > edit.txt && rm gone.txt"

/**
 * Undoing a turn's file changes end to end against a scripted model: the turn writes a file and runs a command that
 * changes and deletes others. Its answer shows what changed; undoing puts every file back, in a folder without Git and
 * in a Git worktree whose repository stays untouched. A file changed after the turn is a conflict, left alone until
 * the person selects it. Redoing writes the turn's changes again.
 */
test('undoes and redoes the file changes of a turn, keeping later changes unless chosen', async () => {
  test.setTimeout(240_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-turn-snapshots-'))
  const repository = path.join(root, 'repo')
  mkdirSync(repository)
  const git = (args: string[], cwd = repository) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(path.join(repository, 'edit.txt'), 'before\n')
  writeFileSync(path.join(repository, 'gone.txt'), 'gone\n')
  writeFileSync(path.join(repository, '.gitignore'), 'ignored.log\n')
  git(['add', '-A'])
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'fixture'])

  let app: ElectronApplication | undefined
  let page!: Page

  const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'turn-snapshots-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'undo-fixture',
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
      res.end(JSON.stringify({ data: [{ id: 'undo-fixture' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body) as { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> }
    const lastUser = text([...input.messages].reverse().find((message) => message.role === 'user')?.content)
    const done = new Set(input.messages.filter((message) => message.role === 'tool').map((m) => m.tool_call_id))
    res.setHeader('content-type', 'text/event-stream')
    const turn = /CHANGE-FILES-(\w+)/.exec(lastUser)?.[1]
    if (!turn) return end(res, 'OK')
    if (!done.has(`write-${turn}`))
      return call(res, `write-${turn}`, 'write', { path: 'created.txt', content: 'created by the turn\n' })
    if (!done.has(`bash-${turn}`)) return call(res, `bash-${turn}`, 'bash', { command: COMMAND })
    end(res, `Changed the files (${turn}).`)
  })

  const api = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args }) as Promise<any>
  const idle = (conversationId: string) =>
    expect.poll(async () => (await api('chatRuntime', conversationId)).streaming, { timeout: 60_000 }).toBe(false)
  const read = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n')
  const expectStart = (dir: string) => {
    expect(read(dir, 'edit.txt')).toBe('before\n')
    expect(read(dir, 'gone.txt')).toBe('gone\n')
    expect(existsSync(path.join(dir, 'created.txt'))).toBe(false)
  }
  const expectChanged = (dir: string) => {
    expect(read(dir, 'edit.txt')).toBe('after\n')
    expect(existsSync(path.join(dir, 'gone.txt'))).toBe(false)
    expect(read(dir, 'created.txt')).toBe('created by the turn\n')
  }
  const runTurn = async (conversationId: string, marker: string) => {
    expect((await api('chatSend', conversationId, `CHANGE-FILES-${marker}`)).ok).toBe(true)
    await expect(page.getByText(`Changed the files (${marker}).`)).toBeVisible({ timeout: 60_000 })
    await idle(conversationId)
  }
  const dialog = () => page.getByTestId('undo-turn-dialog')
  const fileRow = (file: string) => dialog().locator(`[data-testid="undo-turn-file"][data-path="${file}"]`)

  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `turn-snapshots-${Date.now().toString(36)}`,
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
      name: 'Undo fixture',
      kind: 'openai',
      key: 'synthetic-fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    await api('chatSetDefault', { providerId: provider.id, modelId: 'undo-fixture' })
    const prepare = async (conversationId: string) => {
      await api('chatSetSelection', conversationId, { providerId: provider.id, modelId: 'undo-fixture' })
      await api('chatSetPermMode', conversationId, 'full')
      expect((await api('chatSetMode', conversationId, 'agent')).ok).toBe(true)
    }

    // 1. A Git worktree: the turn's changes, a later edit by the person, and a repository that stays untouched.
    const workspace = await api('addWorkspace', repository)
    const created = await api('createConversation', {
      workspaceId: workspace.id,
      branch: 'feat/undo',
      isNewBranch: true,
      mode: 'worktree',
      experience: 'standard',
      name: 'Undo project',
    })
    await prepare(created.id)
    const project = ((await api('listConversations', workspace.id)) as Array<{ id: string; cwd: string }>).find(
      (item) => item.id === created.id
    )!
    writeFileSync(path.join(project.cwd, 'ignored.log'), 'ignored\n')
    const repositoryState = () => ({
      status: git(['status', '--porcelain', '--untracked-files=all'], project.cwd),
      refs: git(['for-each-ref', '--format=%(refname) %(objectname)']),
      exclude: readFileSync(path.join(repository, '.git', 'info', 'exclude'), 'utf8'),
    })
    const before = repositoryState()

    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.locator('li.conv-item', { hasText: 'Undo project' }).first().click()
    await runTurn(created.id, 'PROJECT')
    expectChanged(project.cwd)
    const chip = page.getByTestId('turn-changes-chip')
    await expect(chip).toContainText('3 files', { timeout: 30_000 })
    await chip.click()
    const panel = page.getByTestId('turn-changes-panel')
    for (const file of ['created.txt', 'edit.txt', 'gone.txt']) await expect(panel).toContainText(file)
    // The ignored file is not part of the turn.
    await expect(panel).not.toContainText('ignored.log')
    await panel
      .getByRole('button', { name: /edit\.txt/ })
      .first()
      .click()
    await expect(panel).toContainText('after')

    // The person edits a file after the turn: undoing leaves it alone unless they select it.
    writeFileSync(path.join(project.cwd, 'edit.txt'), 'edited by the person\n')
    await page.getByTestId('turn-changes-undo').click()
    await expect(fileRow('edit.txt')).toContainText('Changed after this turn', { timeout: 30_000 })
    await expect(fileRow('edit.txt').getByRole('checkbox')).toHaveAttribute('aria-checked', 'false')
    await expect(fileRow('created.txt')).toContainText('Delete')
    await expect(fileRow('gone.txt')).toContainText('Recreate')
    await expect(page.getByTestId('undo-turn-confirm')).toHaveText('Undo 2 files')
    await page.getByTestId('undo-turn-confirm').click()
    await expect(dialog()).toBeHidden()
    expect(read(project.cwd, 'edit.txt')).toBe('edited by the person\n')
    expect(read(project.cwd, 'gone.txt')).toBe('gone\n')
    expect(existsSync(path.join(project.cwd, 'created.txt'))).toBe(false)
    await expect(chip).toContainText('2 undone')

    // Selecting the conflict overwrites the person's edit, and says so first.
    await page.getByTestId('turn-changes-undo').click()
    await expect(fileRow('edit.txt')).toBeVisible({ timeout: 30_000 })
    await fileRow('edit.txt').getByRole('checkbox').click()
    await expect(page.getByTestId('undo-turn-confirm')).toHaveText('Undo 1 file (overwrites 1 change)')
    // The preview shows what confirming does to the file as it is now.
    await fileRow('edit.txt').getByRole('button', { name: 'Show diff' }).click()
    await expect(fileRow('edit.txt')).toContainText('edited by the person')
    await page.getByTestId('undo-turn-confirm').click()
    await expect(dialog()).toBeHidden()
    expectStart(project.cwd)
    await expect(chip).toContainText('Changes undone')
    // The snapshots live in the profile: the repository, its refs and its excludes are as they were.
    expect(repositoryState()).toEqual(before)

    // Redoing puts back what the undos replaced: the turn's files and the person's edit.
    await page.getByTestId('turn-changes-redo').click()
    await expect(page.getByTestId('undo-turn-confirm')).toHaveText('Redo 3 files', { timeout: 30_000 })
    await page.getByTestId('undo-turn-confirm').click()
    await expect(dialog()).toBeHidden()
    expect(read(project.cwd, 'edit.txt')).toBe('edited by the person\n')
    expect(existsSync(path.join(project.cwd, 'gone.txt'))).toBe(false)
    expect(read(project.cwd, 'created.txt')).toBe('created by the turn\n')
    await expect(chip).toContainText('3 files')

    // 2. A standalone chat, whose folder is not a Git repository: the same undo.
    const chat = await api('createStandaloneConversation', { name: 'Undo chat' })
    await prepare(chat.id)
    mkdirSync(chat.cwd, { recursive: true })
    writeFileSync(path.join(chat.cwd, 'edit.txt'), 'before\n')
    writeFileSync(path.join(chat.cwd, 'gone.txt'), 'gone\n')
    expect(existsSync(path.join(chat.cwd, '.git'))).toBe(false)
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('tab', { name: 'Chats', exact: true }).click()
    await page.locator('li.conv-item', { hasText: 'Undo chat' }).first().click()
    await runTurn(chat.id, 'CHAT')
    expectChanged(chat.cwd)
    await expect(chip).toContainText('3 files', { timeout: 30_000 })
    await chip.click()
    await page.getByTestId('turn-changes-undo').click()
    await expect(page.getByTestId('undo-turn-confirm')).toHaveText('Undo 3 files', { timeout: 30_000 })
    await page.getByTestId('undo-turn-confirm').click()
    await expect(dialog()).toBeHidden()
    expectStart(chat.cwd)
    expect(existsSync(path.join(chat.cwd, '.git'))).toBe(false)
    await expect(chip).toContainText('Changes undone')
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
