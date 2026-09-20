import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const desktop = fileURLToPath(new URL('../..', import.meta.url))

// Uses the real built application and a local OpenAI-compatible SSE provider. No platform
// service, developer profile, external model, or credentials are needed.
test('standalone chats: first use, streaming, isolation, persistence and lifecycle', async () => {
  test.setTimeout(180_000)
  // Fail immediately with a useful path when the real Electron build has not been produced.
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-standalone-'))
  const profile = path.join(root, 'profile')
  let app: ElectronApplication | undefined
  let page!: Page
  let held: ServerResponse | undefined
  const requests: Array<{ model: string; messages: unknown[] }> = []
  const chunk = (res: ServerResponse, text: string, finish: string | null = null) => {
    res.write(
      `data: ${JSON.stringify({
        id: 'standalone-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'standalone-fixture',
        choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
      })}\n\n`
    )
  }
  const end = (res: ServerResponse, text: string) => {
    chunk(res, text)
    chunk(res, '', 'stop')
    res.end('data: [DONE]\n\n')
  }
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({ data: ['standalone-fixture', 'standalone-secondary'].map((id) => ({ id, object: 'model' })) })
      )
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body)
    requests.push(input)
    res.setHeader('content-type', 'text/event-stream')
    if (requests.length === 1) {
      held = res
      chunk(res, 'Standalone streaming proof: ')
    } else end(res, `Standalone reply ${requests.length}.`)
  })
  const call = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
  const list = () => call('listStandaloneConversations', true)
  const row = (name: string) => page.locator('.conv-item').filter({ hasText: name }).first()
  const send = async (text: string) => {
    await page.locator('.chat-input[contenteditable="true"]:visible').fill(text)
    await page.locator('button[title="Send"]:visible').click()
  }
  const ready = async (label = '') => {
    let failed = false
    try {
      await expect(page.locator('button[title="Stop"]:visible')).toHaveCount(0)
    } catch (error) {
      failed = true
      const trace = await page.evaluate(() => ((window as any).__chatDebug ?? []) as string[])
      const runtimes = await page.evaluate(async () => {
        const api = (window as any).api
        const conversations = await api.listStandaloneConversations(true)
        const entries: Record<string, unknown> = {}
        for (const conversation of conversations) {
          entries[`${conversation.id.slice(0, 4)}:${conversation.name}`] = await api.chatRuntime(conversation.id)
        }
        return entries
      })
      console.log(`READY-FAILURE ${label}`)
      console.log(`RUNTIMES ${JSON.stringify(runtimes)}`)
      console.log(`TRACE\n${trace.join('\n')}`)
      throw error
    }
    if (!failed) {
      const trace = await page.evaluate(() => ((window as any).__chatDebug ?? []) as string[])
      console.log(`READY-OK ${label}\nTRACE\n${trace.join('\n')}`)
    }
  }
  const launch = async () => {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'standalone-e2e',
        AGENTS_USERDATA: profile,
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(await realpath(profile))
  }
  const menu = async (name: string, action: string) => {
    await row(name).click({ button: 'right' })
    await page.getByRole('menuitem', { name: action, exact: true }).click()
  }
  const rename = async (current: string, next: string) => {
    await menu(current, 'Rename')
    const input = page.locator('.conv-item input')
    await input.fill(next)
    await input.press('Enter')
    await expect(row(next)).toBeVisible()
  }
  const gitDirectories = async (dir: string): Promise<string[]> => {
    const found: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') found.push(path.join(dir, entry.name))
      else if (entry.isDirectory()) found.push(...(await gitDirectories(path.join(dir, entry.name))))
    }
    return found
  }
  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    await launch()
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    expect(await call('listWorkspaces', true)).toEqual([])
    expect(await list()).toEqual([])
    const provider = await call('chatAddProvider', {
      name: 'Standalone fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    await call('chatSetDefault', { providerId: provider.id, modelId: 'standalone-fixture' })
    // A failed mkdir must leave no conversation and allow the same UI action to be retried.
    const blockedRoot = path.join(profile, 'standalone-chats')
    await writeFile(blockedRoot, 'not a directory')
    const failure = page.waitForEvent('dialog').then(async (dialog) => {
      const message = dialog.message()
      await dialog.accept()
      return message
    })
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    expect(await failure).toContain('Could not create chat')
    expect(await list()).toEqual([])
    await rm(blockedRoot)
    await page
      .getByRole('button', { name: 'New chat', exact: true })
      .first()
      .evaluate((button: HTMLButtonElement) => {
        button.click()
        button.click()
      })
    await expect.poll(async () => (await list()).length).toBe(1)
    const first = (await list())[0]
    expect(first.workspaceId).toBeNull()
    expect(first.scope).toBe('standalone')
    expect(first).toMatchObject({ branch: null, mode: null, experience: 'standard', isMulti: 0 })
    expect(first.uiPrefs.chat).toMatchObject({ mode: 'ask', permMode: 'ask' })
    await expect(page.locator('.chat-input:visible')).toBeFocused()
    await call('chatSetSelection', first.id, { providerId: provider.id, modelId: 'standalone-fixture' })
    await send('alpha-private-first-turn')
    // Assert content reaches the UI before the provider finishes the response.
    await expect(page.getByText('Standalone streaming proof:', { exact: false })).toBeVisible()
    expect(held).toBeTruthy()
    await expect(page.locator('button[title="Stop"]:visible')).toBeVisible()
    // Creating a chat from Settings must close the panel and preserve the first chat's live stream.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await expect.poll(async () => (await list()).length).toBe(2)
    const second = (await list()).find((conv: any) => conv.id !== first.id)
    await expect(page.locator('.chat-input:visible')).toBeFocused()
    await expect(page.getByText('Standalone streaming proof:', { exact: false })).not.toBeVisible()
    chunk(held!, 'hidden chunk ')
    await row('alpha-private-first-turn').click()
    await expect(page.locator('button[title="Stop"]:visible')).toBeVisible()
    // Tokens emitted while the view was hidden must survive before the stream continues.
    await expect(page.getByText('Standalone streaming proof: hidden chunk', { exact: false })).toBeVisible()
    chunk(held!, 'incremental chunk ')
    await expect(page.getByText('Standalone streaming proof: hidden chunk incremental chunk', { exact: false })).toBeVisible()
    end(held!, 'complete.')
    held = undefined
    await ready("turn1")
    await expect(row('alpha-private-first-turn')).toBeVisible()
    await rename('alpha-private-first-turn', 'Alpha standalone')
    await page.locator('button[title^="Change model"]:visible').click()
    await page.getByPlaceholder('Search models…').fill('standalone-secondary')
    await page.getByRole('button', { name: /standalone-secondary.*Standalone fixture/ }).click()
    await send('alpha-followup')
    await expect(page.getByText('Standalone reply 2.', { exact: true })).toBeVisible()
    await ready("turn2")
    expect(requests[1].model).toBe('standalone-secondary')
    expect(JSON.stringify(requests[1].messages)).toContain('alpha-private-first-turn')
    expect(JSON.stringify(requests[1].messages)).toContain('incremental chunk')

    const note = await call('createNotePage', 'conv', first.id, { title: 'Alpha note' })
    expect(note).toBeTruthy()
    await call('writeNotePage', 'conv', first.id, note.id, '# Alpha private notes\nnotes-proof')
    await row(second.name).click()
    expect(second.workspaceId).toBeNull()
    expect(second.scope).toBe('standalone')
    expect(second.cwd).not.toBe(first.cwd)
    await rename(second.name, 'Beta standalone')
    await call('chatSetSelection', second.id, { providerId: provider.id, modelId: 'standalone-fixture' })
    await expect(page.getByText('Standalone reply 2.', { exact: true })).not.toBeVisible()
    // Paste a text file through the actual composer attachment handler.
    await page.locator('.chat-input[contenteditable="true"]:visible').evaluate((el) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['beta-attachment-proof'], 'beta-evidence.txt', { type: 'text/plain' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    })
    await expect(page.getByText('beta-evidence.txt', { exact: true }).first()).toBeVisible()
    await send('beta-private-turn')
    await expect(page.getByText('Standalone reply 3.', { exact: true })).toBeVisible()
    await ready("turn3")
    const betaRequest = JSON.stringify(requests[2].messages)
    expect(betaRequest).toContain('beta-attachment-proof')
    expect(betaRequest).not.toContain('alpha-private-first-turn')
    expect(betaRequest).not.toContain('notes-proof')
    expect(JSON.stringify(await call('listNotePages', 'conv', second.id))).not.toContain(note.id)
    expect(await call('listWorkspaces', true)).toEqual([])
    expect(await gitDirectories(path.join(profile, 'standalone-chats'))).toEqual([])
    for (const managed of ['worktrees', 'aggregators']) {
      const entries = await readdir(path.join(profile, managed)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      expect(entries).toEqual([])
    }

    await page.getByPlaceholder('Filter conversations…').fill('Alpha standalone')
    await expect(row('Alpha standalone')).toBeVisible()
    await expect(row('Beta standalone')).toHaveCount(0)
    await page.getByPlaceholder('Filter conversations…').fill('')
    await menu('Alpha standalone', 'Pin conversation')
    await expect.poll(async () => (await list()).find((c: any) => c.id === first.id).pinnedAt).not.toBeNull()
    await expect(page.locator('.conv-item').filter({ hasText: 'Alpha standalone' })).toHaveCount(1)
    await menu('Alpha standalone', 'Unpin conversation')
    await call('reorderStandaloneConversations', [second.id, first.id])
    expect((await list()).map((c: any) => c.id)).toEqual([second.id, first.id])
    await menu('Beta standalone', 'Archive')
    await expect(row('Beta standalone')).toHaveCount(0)
    expect((await call('listStandaloneConversations')).map((c: any) => c.id)).toEqual([first.id])
    await page.getByRole('button', { name: /Show archived/ }).click()
    await menu('Beta standalone', 'Unarchive')
    await expect.poll(async () => (await list()).find((c: any) => c.id === second.id).archived).toBe(0)

    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Chats', exact: true })).toHaveAttribute('aria-expanded', 'false')

    await app!.close()
    app = undefined
    await launch()
    await expect(page.getByText('Welcome to Maestrly')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Chats', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    expect((await list()).map((c: any) => c.id)).toEqual([second.id, first.id])
    await row('Alpha standalone').click()
    await expect(page.getByText('Standalone reply 2.', { exact: true })).toBeVisible()
    expect(await call('chatGetSelection', first.id)).toMatchObject({ modelId: 'standalone-secondary' })
    expect(await call('readNotePage', 'conv', first.id, note.id)).toContain('notes-proof')
    await row('Beta standalone').click()
    await expect(page.getByText('Standalone reply 3.', { exact: true })).toBeVisible()
    expect(JSON.stringify(await call('chatHistoryPage', second.id))).toContain('beta-evidence.txt')

    // Only now introduce a repository; its lifecycle must not own either standalone chat.
    const repo = path.join(root, 'project')
    await mkdir(repo)
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ])
    const workspace = await call('addWorkspace', repo)
    expect((await call('listWorkspaces')).map((w: any) => w.id)).toContain(workspace.id)
    await call('removeWorkspace', workspace.id)
    expect(await call('listWorkspaces', true)).toEqual([])
    expect((await list()).map((c: any) => c.id)).toEqual([second.id, first.id])
    expect(await call('readNotePage', 'conv', first.id, note.id)).toContain('notes-proof')
    page.once('dialog', (dialog) => void dialog.accept())
    await menu('Beta standalone', 'Delete permanently')
    await expect.poll(async () => (await list()).map((c: any) => c.id)).toEqual([first.id])
    await expect(access(second.cwd)).rejects.toThrow()
    await access(first.cwd)
    await access(path.join(repo, '.git'))
    await expect(row('Beta standalone')).toHaveCount(0)
    expect((await list()).map((c: any) => c.id)).toEqual([first.id])
    await row('Alpha standalone').click()
    await expect(page.getByText('Standalone reply 2.', { exact: true })).toBeVisible()
    await page.mouse.move(800, 40)
    await page.screenshot({ path: test.info().outputPath('standalone-chats.png'), fullPage: true })
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: test.info().outputPath('failure.png'), fullPage: true }).catch(() => {})
      await test.info().attach('page-text', { body: await page.locator('body').innerText(), contentType: 'text/plain' })
    }
    throw error
  } finally {
    held?.destroy()
    await app?.close()
    model.closeAllConnections()
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone first use is localized in Portuguese', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'maestrly-standalone-pt-'))
  const app = await electron.launch({
    args: [path.join(desktop, 'out/main/index.js')],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_USERDATA: profile,
      AGENTS_LOCALE: 'pt-BR',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: 'standalone-pt',
      ELECTRON_RENDERER_URL: '',
    },
  })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Pular', exact: true }).click()
    await page.getByRole('button', { name: 'Novo chat', exact: true }).first().click()
    await expect(page.locator('.conv-item').filter({ hasText: 'Novo chat' })).toBeVisible()
    expect(await page.evaluate(() => window.api.listWorkspaces())).toEqual([])
    const chats = await page.evaluate(() => window.api.listStandaloneConversations())
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({ name: 'Novo chat', scope: 'standalone', workspaceId: null })
    await page.screenshot({ path: test.info().outputPath('standalone-chats-pt.png'), fullPage: true })
  } finally {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  }
})
